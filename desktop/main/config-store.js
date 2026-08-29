// ═══════════════════════════════════════════════════════════════
// config-store.js — 自建分域 JSON 配置存储（B 整改 2026-08-28）
//
// 取代 electron-store（零第三方依赖，纯 node:fs 实现，可脱离 electron 单测）。
// 存储：basePath（D6 决策：应用根/config，不可写回退 userData/config）下分域文件：
//   app.json          windowState / window.* / inference.* / workbench.*
//                     / themeMode / ext.* / media.*（兜底域）
//   server.json       server.*（服务端地址，getServerUrl 实时读）
//   ai.json           llm.*（默认模型 / 联网搜索）
//   integration.json  feishu.* / jimeng.*（外部平台凭据）
//   download.json     downloadDir（媒体下载目录）
//
// 接口与 electron-store 兼容（注入点零改动）：
//   get(key, default) / set(key, value) / set(object) / has / delete
//   .store             合并视图（a2-ipc config:get 无 key 返回整份）
//
// 写入：原子写 <file>.tmp → fs.renameSync 覆盖 → 回读校验，不一致抛错
//       （a2-ipc config:set 的回读验证逻辑保持衔接）。
// 迁移：构造时若旧 app-config.json（electron-store 单文件）存在 →
//       splitLegacyConfig 纯函数按路由拆分 → 分域合并写入（新值优先）→
//       旧文件改名 app-config.json.bak（不删除）。
//       D6：legacyBasePath（旧 userData/config 分域目录）存在且与新路径不同 →
//       migrateLegacyBasePath 逐域合并迁移（新值优先、旧域文件改名 .bak）。
// ═══════════════════════════════════════════════════════════════

'use strict'
const fs = require('node:fs')
const path = require('node:path')

/** 分域文件名（key 路由 → basePath/<域>.json） */
const DOMAIN_FILES = {
  app: 'app.json',
  server: 'server.json',
  ai: 'ai.json',
  integration: 'integration.json',
  download: 'download.json',
}

/** 无前缀的整键精确路由 */
const EXACT_KEY_ROUTES = {
  windowState: 'app',
  themeMode: 'app',
  downloadDir: 'download',
}

/** 前缀路由（按声明顺序匹配，先长者优先不必要——各前缀互不为前缀） */
const PREFIX_ROUTES = [
  ['window.', 'app'],
  ['inference.', 'app'],
  ['workbench.', 'app'],
  ['ext.', 'app'],
  ['media.', 'app'],
  ['local.', 'app'],
  ['video.', 'app'],
  ['server.', 'server'],
  ['llm.', 'ai'],
  ['feishu.', 'integration'],
  ['jimeng.', 'integration'],
  ['digitalhuman.', 'integration'],
]

/** 未识别 key 的兜底域（业务偏好默认域） */
const FALLBACK_DOMAIN = 'app'

/**
 * key → 域名（纯函数）
 * @param {string} key 扁平配置键，如 'server.url' / 'windowState'
 * @returns {keyof typeof DOMAIN_FILES}
 */
function routeKeyToDomain(key) {
  if (EXACT_KEY_ROUTES[key]) return EXACT_KEY_ROUTES[key]
  for (const [prefix, domain] of PREFIX_ROUTES) {
    if (typeof key === 'string' && key.startsWith(prefix)) return domain
  }
  return FALLBACK_DOMAIN
}

/**
 * 迁移纯函数：旧 electron-store 扁平 dict + 路由表 → 分域 dict
 * （输入不被修改；路由表可注入便于单测，默认内置路由）
 * @param {Record<string, unknown>} legacyDict 旧 app-config.json 解析结果
 * @param {{exact?: object, prefixes?: [string, string][], fallback?: string}} [routes]
 * @returns {Record<string, Record<string, unknown>>} 分域 dict（各域齐备）
 */
function splitLegacyConfig(legacyDict, routes) {
  const exact = (routes && routes.exact) || EXACT_KEY_ROUTES
  const prefixes = (routes && routes.prefixes) || PREFIX_ROUTES
  const fallback = (routes && routes.fallback) || FALLBACK_DOMAIN
  const out = {}
  for (const domain of Object.keys(DOMAIN_FILES)) out[domain] = {}
  if (!legacyDict || typeof legacyDict !== 'object' || Array.isArray(legacyDict)) return out
  for (const [key, value] of Object.entries(legacyDict)) {
    let domain = exact[key]
    if (!domain) {
      for (const [prefix, d] of prefixes) {
        if (key.startsWith(prefix)) { domain = d; break }
      }
    }
    if (!domain) domain = fallback
    out[domain][key] = value
  }
  return out
}

/**
 * 原子写域文件：写 .tmp → renameSync 覆盖 → 回读校验（不一致抛错）
 * @param {string} basePath 存储目录
 * @param {string} domain 域名
 * @param {Record<string, unknown>} dict 该域扁平 dict
 */
function writeDomainFileAtomic(basePath, domain, dict) {
  const file = path.join(basePath, DOMAIN_FILES[domain])
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(dict, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  const back = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (JSON.stringify(back) !== JSON.stringify(dict)) {
    throw new Error('CONFIG_WRITE_VERIFY_FAILED: ' + DOMAIN_FILES[domain])
  }
}

/**
 * 真实可写探测：mkdir（含父级）→ 写临时 .wtest-<pid> → 删除。
 * 任一步失败（Program Files 等只读区 / ACL 限制）→ 返回 false。
 * @param {string} dir 待探测目录（不存在则尝试创建）
 * @returns {boolean}
 */
function probeWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.wtest-' + process.pid)
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
    return true
  } catch (_) {
    return false
  }
}

/**
 * D6：解析配置根目录（纯函数，可脱离 electron 单测）。
 * 决策：应用根/config 可写 → 用应用根（随应用走、可见可改可备份）；
 *       不可写（打包装到 Program Files 等只读区）→ 回退 %APPDATA%/userData/config。
 * @param {string} appRoot 应用根目录（打包=exe 所在目录；dev=process.cwd()）
 * @param {string} userDataDir %APPDATA% 下的 userData（app.getPath('userData')）
 * @param {(dir: string) => boolean} [probeWritable] 可写探测函数（默认真实 fs 探测；测试注入模拟）
 * @returns {{basePath: string, writable: boolean, fallback: boolean}}
 */
function resolveConfigBasePath(appRoot, userDataDir, probeWritable) {
  const canWrite = (typeof probeWritable === 'function') ? probeWritable : probeWritableDir
  const appConfigDir = path.join(appRoot, 'config')
  if (canWrite(appConfigDir)) {
    return { basePath: appConfigDir, writable: true, fallback: false }
  }
  return { basePath: path.join(userDataDir, 'config'), writable: false, fallback: true }
}

/**
 * D6：旧分域目录 → 新分域目录一次性合并迁移（新值优先，幂等）。
 * 场景：basePath 由 userData/config 变为应用根/config 时，旧目录已有分域数据 →
 *   逐域文件合并（新值优先，不覆盖已分域数据）→ 旧域文件改名 .bak（不删除）。
 * @param {string} newBasePath 当前分域存储目录（应用根/config）
 * @param {string} [oldBasePath] 旧分域存储目录（userData/config）
 * @returns {{migrated: boolean, files?: number, reason?: string}}
 */
function migrateLegacyBasePath(newBasePath, oldBasePath) {
  if (!newBasePath || !oldBasePath) return { migrated: false, reason: 'MISSING_PATHS' }
  if (path.resolve(newBasePath) === path.resolve(oldBasePath)) return { migrated: false, reason: 'SAME_PATH' }
  if (!fs.existsSync(oldBasePath)) return { migrated: false, reason: 'NO_LEGACY_DIR' }
  let migratedFiles = 0
  for (const [domain, file] of Object.entries(DOMAIN_FILES)) {
    const oldFile = path.join(oldBasePath, file)
    if (!fs.existsSync(oldFile)) continue
    let oldDict = {}
    try {
      oldDict = JSON.parse(fs.readFileSync(oldFile, 'utf8'))
    } catch (_) { continue /* 旧域文件损坏：跳过不动 */ }
    if (!oldDict || typeof oldDict !== 'object' || Array.isArray(oldDict)) continue
    let existing = {}
    try {
      existing = JSON.parse(fs.readFileSync(path.join(newBasePath, file), 'utf8')) || {}
    } catch (_) { /* 新域文件不存在/损坏 → 视为空 */ }
    // 新值优先（幂等：重复迁移不覆盖已分域数据）
    writeDomainFileAtomic(newBasePath, domain, { ...oldDict, ...existing })
    fs.renameSync(oldFile, oldFile + '.bak')
    migratedFiles++
  }
  return migratedFiles ? { migrated: true, files: migratedFiles } : { migrated: false, reason: 'NO_LEGACY_FILES' }
}

/**
 * 启动迁移：旧 app-config.json → 分域文件（新值优先，幂等）→ 改名 .bak
 * 迁移是构造期动作：main.js 传 legacyPath，本函数在 ConfigStore 构造内调用。
 * @param {string} basePath 分域存储目录
 * @param {string} legacyPath 旧 electron-store 单文件（app-config.json）
 */
function migrateLegacyFile(basePath, legacyPath) {
  if (!legacyPath || !fs.existsSync(legacyPath)) return { migrated: false, reason: 'NO_LEGACY_FILE' }
  let legacyDict
  try {
    legacyDict = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
  } catch (e) {
    // 解析失败：旧文件保留不动，不阻塞启动（下次启动可人工排查）
    return { migrated: false, reason: 'LEGACY_PARSE_FAILED: ' + e.message }
  }
  if (!legacyDict || typeof legacyDict !== 'object' || Array.isArray(legacyDict)) {
    return { migrated: false, reason: 'LEGACY_NOT_OBJECT' }
  }
  const domains = splitLegacyConfig(legacyDict)
  let migratedKeys = 0
  for (const [domain, kv] of Object.entries(domains)) {
    const keys = Object.keys(kv)
    if (!keys.length) continue
    const file = path.join(basePath, DOMAIN_FILES[domain])
    let existing = {}
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {}
    } catch (_) { /* 域文件不存在/损坏 → 视为空 */ }
    // 新值优先（幂等：重复迁移不覆盖已分域数据）
    const merged = { ...kv, ...existing }
    writeDomainFileAtomic(basePath, domain, merged)
    migratedKeys += keys.length
  }
  fs.renameSync(legacyPath, legacyPath + '.bak')
  return { migrated: true, keys: migratedKeys }
}

/**
 * 分域配置存储（electron-store 兼容接口）
 */
class ConfigStore {
  /**
   * @param {{basePath: string, defaults?: Record<string, unknown>, legacyPath?: string|null, legacyBasePath?: string|null}} opts
   *   basePath 必传（main.js 传 D6 resolveConfigBasePath 决策结果：应用根/config 或
   *   userData/config 回退；测试传临时目录）；defaults 同 electron-store 语义：
   *   读不到时返回默认值并落盘；legacyBasePath = 旧分域目录（userData/config），
   *   存在且与新路径不同 → 一次性合并迁移到新路径（新值优先、旧域文件 .bak）。
   */
  constructor(opts) {
    if (!opts || typeof opts.basePath !== 'string' || !opts.basePath) {
      throw new Error('ConfigStore: basePath is required')
    }
    this.basePath = opts.basePath
    this.defaults = (opts.defaults && typeof opts.defaults === 'object') ? { ...opts.defaults } : {}
    fs.mkdirSync(this.basePath, { recursive: true })
    // 迁移先行：旧单文件值需在缓存加载前进入分域文件
    try { migrateLegacyFile(this.basePath, opts.legacyPath) } catch (_) { /* 迁移失败不阻塞启动 */ }
    // D6：旧分域目录（userData/config）→ 新分域目录（应用根/config）合并迁移
    try { migrateLegacyBasePath(this.basePath, opts.legacyBasePath) } catch (_) { /* 迁移失败不阻塞启动 */ }
    // 加载各域缓存（文件不存在/损坏 → 空对象）
    this._cache = new Map()
    for (const domain of Object.keys(DOMAIN_FILES)) this._cache.set(domain, this._readDomain(domain))
  }

  /** 读域文件为扁平 dict（不存在/损坏 → {}） */
  _readDomain(domain) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(this.basePath, DOMAIN_FILES[domain]), 'utf8'))
      return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {}
    } catch (_) {
      return {}
    }
  }

  /** 写域文件（缓存同步 + 原子写 + 回读校验） */
  _writeDomain(domain, dict) {
    writeDomainFileAtomic(this.basePath, domain, dict)
    this._cache.set(domain, dict)
  }

  /**
   * 读配置：key 省略 → 整份合并视图（a2-ipc config:get 无 key 口径）
   * 命中 defaults 且未落盘 → 返回默认值并落盘（electron-store defaults 语义）
   */
  get(key, defaultValue) {
    if (typeof key === 'undefined' || key === null) return this.store
    const dict = this._cache.get(routeKeyToDomain(key)) || {}
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key]
    if (Object.prototype.hasOwnProperty.call(this.defaults, key)) {
      const dv = this.defaults[key]
      try { this.set(key, dv) } catch (_) { /* 落盘失败仍返回默认值 */ }
      return dv
    }
    return defaultValue
  }

  /**
   * 写配置：set(key, value) 或 set(object 批量，跨域自动路由)。
   * value === undefined 等价 delete（JSON 无法表达 undefined，避免回读校验误报）。
   */
  set(keyOrObject, value) {
    if (keyOrObject !== null && typeof keyOrObject === 'object') {
      for (const [k, v] of Object.entries(keyOrObject)) this._setOne(k, v)
      return this
    }
    this._setOne(keyOrObject, value)
    return this
  }

  _setOne(key, value) {
    if (typeof key !== 'string' || !key) throw new Error('config-store.set: key must be non-empty string')
    if (value === undefined) { this.delete(key); return }
    const domain = routeKeyToDomain(key)
    const dict = this._cache.get(domain) || {}
    dict[key] = value
    this._writeDomain(domain, dict)
  }

  /** 存在判断（含 defaults，对齐 electron-store .store 合并语义） */
  has(key) {
    if (Object.prototype.hasOwnProperty.call(this.defaults, key)) return true
    const dict = this._cache.get(routeKeyToDomain(key)) || {}
    return Object.prototype.hasOwnProperty.call(dict, key)
  }

  /** 删除：无此键时无副作用（不产生文件） */
  delete(key) {
    const domain = routeKeyToDomain(key)
    const dict = this._cache.get(domain) || {}
    if (!Object.prototype.hasOwnProperty.call(dict, key)) return
    delete dict[key]
    this._writeDomain(domain, dict)
  }

  /** 合并视图：defaults + 全部域文件 → 扁平 dict（每次生成快照） */
  get store() {
    const merged = { ...this.defaults }
    for (const dict of this._cache.values()) Object.assign(merged, dict)
    return merged
  }
}

/**
 * 工厂：main.js 用（注入点零改动——与原 electron-store 实例同接口）
 * @param {{basePath: string, defaults?: Record<string, unknown>, legacyPath?: string|null}} opts
 */
function createConfigStore(opts) {
  return new ConfigStore(opts)
}

module.exports = {
  ConfigStore,
  createConfigStore,
  routeKeyToDomain,
  splitLegacyConfig,
  migrateLegacyFile,
  migrateLegacyBasePath,
  resolveConfigBasePath,
  probeWritableDir,
  writeDomainFileAtomic,
  DOMAIN_FILES,
  EXACT_KEY_ROUTES,
  PREFIX_ROUTES,
}
