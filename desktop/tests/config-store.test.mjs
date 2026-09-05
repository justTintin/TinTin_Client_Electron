// ═══════════════════════════════════════════════════════════════
// config-store 单测 — 分域 JSON 配置存储（B 整改，IRON-04/10 先红后绿）
// 运行：node --test tests/config-store.test.mjs
// 纯 node 环境：注入临时 basePath，不依赖 electron
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const {
  createConfigStore,
  splitLegacyConfig,
  routeKeyToDomain,
  resolveConfigBasePath,
  migrateLegacyBasePath,
  DOMAIN_FILES,
} = require('../main/config-store.js')

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-test-'))
}

// ── 域路由 ──

test('routeKeyToDomain：各域 key 路由到正确域', () => {
  // app：窗口状态 / window.* / inference.* / workbench.* / themeMode / ext.* / media.*
  assert.equal(routeKeyToDomain('windowState'), 'app')
  assert.equal(routeKeyToDomain('windowState.isMaximized'), 'app')
  assert.equal(routeKeyToDomain('window.useSystemFrame'), 'app')
  assert.equal(routeKeyToDomain('inference.mode'), 'app')
  assert.equal(routeKeyToDomain('inference.fallbackHistory'), 'app')
  assert.equal(routeKeyToDomain('workbench.sessions'), 'app')
  assert.equal(routeKeyToDomain('themeMode'), 'app')
  assert.equal(routeKeyToDomain('ext.shopKeyword'), 'app')
  assert.equal(routeKeyToDomain('media.sniffedHistory'), 'app')
  // server
  assert.equal(routeKeyToDomain('server.url'), 'server')
  // ai
  assert.equal(routeKeyToDomain('llm.defaultModel'), 'ai')
  assert.equal(routeKeyToDomain('llm.webSearch'), 'ai')
  // integration
  assert.equal(routeKeyToDomain('feishu.appSecret'), 'integration')
  assert.equal(routeKeyToDomain('jimeng.sessionid'), 'integration')
  assert.equal(routeKeyToDomain('digitalhuman.workflowId'), 'integration')
  // S9 本地配置（显式 app 域；2026-09-04 删 LUT，video.lutMap 路由用例同步移除）
  assert.equal(routeKeyToDomain('local.cacheDir'), 'app')
  // download
  assert.equal(routeKeyToDomain('downloadDir'), 'download')
  // 兜底：未识别 key 归 app
  assert.equal(routeKeyToDomain('unknown.key'), 'app')
})

// ── 迁移纯函数 ──

test('splitLegacyConfig：旧 dict 按路由表拆分为分域 dict（纯函数）', () => {
  const legacy = {
    'server.url': 'http://127.0.0.1:8000',
    'llm.defaultModel': 'deepseek-v3',
    'feishu.appId': 'cli_x',
    'downloadDir': 'D:\\dl',
    'windowState.isMaximized': true,
    'themeMode': 'dark',
  }
  const out = splitLegacyConfig(legacy)
  assert.equal(out.server['server.url'], 'http://127.0.0.1:8000')
  assert.equal(out.ai['llm.defaultModel'], 'deepseek-v3')
  assert.equal(out.integration['feishu.appId'], 'cli_x')
  assert.equal(out.download.downloadDir, 'D:\\dl')
  assert.equal(out.app['windowState.isMaximized'], true)
  assert.equal(out.app.themeMode, 'dark')
  // 分域结构齐备
  assert.deepEqual(Object.keys(out).sort(), Object.keys(DOMAIN_FILES).sort())
})

test('splitLegacyConfig：空 / null 输入返回空分域结构', () => {
  const out = splitLegacyConfig({})
  for (const d of Object.keys(DOMAIN_FILES)) assert.deepEqual(out[d], {})
  assert.deepEqual(splitLegacyConfig(null), splitLegacyConfig({}))
})

// ── 分域落盘 ──

test('分域落盘：set 写入正确域文件，其他域不受影响', () => {
  const dir = makeTmpDir()
  const store = createConfigStore({ basePath: dir })
  store.set('server.url', 'http://10.0.0.2:8000')
  store.set('llm.defaultModel', 'gpt-x')
  const serverCfg = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'))
  const aiCfg = JSON.parse(fs.readFileSync(path.join(dir, 'ai.json'), 'utf8'))
  assert.equal(serverCfg['server.url'], 'http://10.0.0.2:8000')
  assert.equal(aiCfg['llm.defaultModel'], 'gpt-x')
  assert.equal(store.get('server.url'), 'http://10.0.0.2:8000')
  assert.equal(store.get('llm.defaultModel'), 'gpt-x')
  assert.ok(!fs.existsSync(path.join(dir, 'app.json')), 'app 域无写入则不产生文件')
})

// ── get 默认值 ──

test('get 默认值：无值返回 default 参数；defaults 注入读不到时返回默认值并落盘', () => {
  const dir = makeTmpDir()
  const store = createConfigStore({
    basePath: dir,
    defaults: { 'inference.mode': 'server-only' },
  })
  assert.equal(store.get('nothing.here', 'fallback'), 'fallback')
  assert.equal(store.get('inference.mode'), 'server-only')
  // defaults get 后落盘
  const appCfg = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'))
  assert.equal(appCfg['inference.mode'], 'server-only')
})

// ── set 后 get 回读 ──

test('set 后 get 回读：对象 / 数组 / 基础类型，且新实例可跨读', () => {
  const dir = makeTmpDir()
  const store = createConfigStore({ basePath: dir })
  store.set('workbench.sessions', [{ id: 'a', mode: 'llm' }])
  store.set('media.settings', { autoSave: true, maxHistory: 200 })
  store.set('windowState.isMaximized', true)
  store.set('downloadDir', 'D:\\x')
  assert.deepEqual(store.get('workbench.sessions'), [{ id: 'a', mode: 'llm' }])
  assert.deepEqual(store.get('media.settings'), { autoSave: true, maxHistory: 200 })
  assert.equal(store.get('windowState.isMaximized'), true)
  assert.equal(store.get('downloadDir'), 'D:\\x')
  // 跨实例回读：新实例读到同一份落盘数据
  const store2 = createConfigStore({ basePath: dir })
  assert.deepEqual(store2.get('workbench.sessions'), [{ id: 'a', mode: 'llm' }])
})

// ── 对象批量 set ──

test('对象批量 set：跨域一次写入', () => {
  const dir = makeTmpDir()
  const store = createConfigStore({ basePath: dir })
  store.set({
    'server.url': 'http://h:1',
    'feishu.appId': 'cli_x',
    'themeMode': 'dark',
  })
  assert.equal(store.get('server.url'), 'http://h:1')
  assert.equal(store.get('feishu.appId'), 'cli_x')
  assert.equal(store.get('themeMode'), 'dark')
  assert.ok(fs.existsSync(path.join(dir, 'server.json')))
  assert.ok(fs.existsSync(path.join(dir, 'integration.json')))
  assert.ok(fs.existsSync(path.join(dir, 'app.json')))
})

// ── 原子写 ──

test('原子写：set 后文件为合法 JSON 且无 .tmp 残留', () => {
  const dir = makeTmpDir()
  const store = createConfigStore({ basePath: dir })
  store.set('llm.webSearch', true)
  const raw = fs.readFileSync(path.join(dir, 'ai.json'), 'utf8')
  assert.deepEqual(JSON.parse(raw), { 'llm.webSearch': true })
  assert.ok(!fs.existsSync(path.join(dir, 'ai.json.tmp')))
})

// ── has / delete（config-migrate.purgeDeprecatedExtKeys 依赖） ──

test('has / delete：存在判断与删除', () => {
  const dir = makeTmpDir()
  const store = createConfigStore({ basePath: dir })
  assert.equal(store.has('ext.shopKeyword'), false)
  store.set('ext.shopKeyword', '桔柚')
  assert.equal(store.has('ext.shopKeyword'), true)
  store.delete('ext.shopKeyword')
  assert.equal(store.has('ext.shopKeyword'), false)
  assert.equal(store.get('ext.shopKeyword', ''), '')
  // delete 不存在键：不抛错、不产生文件（独立目录验证）
  const emptyDir = makeTmpDir()
  const emptyStore = createConfigStore({ basePath: emptyDir })
  emptyStore.delete('ext.nothing')
  assert.ok(!fs.existsSync(path.join(emptyDir, 'app.json')))
})

// ── .store 合并视图（electron-store 兼容，a2-ipc config:get 无 key 用） ──

test('.store 合并视图：defaults + 各域文件合并为扁平 dict', () => {
  const dir = makeTmpDir()
  const store = createConfigStore({
    basePath: dir,
    defaults: { 'inference.mode': 'server-only' },
  })
  store.set('server.url', 'http://s:9')
  const all = store.store
  assert.equal(all['server.url'], 'http://s:9')
  assert.equal(all['inference.mode'], 'server-only')
})

// ── 启动迁移 ──

test('迁移：旧 app-config.json 按路由拆分写入分域文件并改名 .bak', () => {
  const dir = makeTmpDir()
  const legacyPath = path.join(dir, 'app-config.json')
  fs.writeFileSync(legacyPath, JSON.stringify({
    'server.url': 'http://old:8000',
    'llm.defaultModel': 'old-model',
    'feishu.appId': 'cli_old',
    'downloadDir': 'C:\\old',
    'windowState': { x: 1, y: 2 },
    'themeMode': 'light',
    'ext.bridgePort': '8123',
  }), 'utf8')
  const store = createConfigStore({ basePath: dir, legacyPath })
  // 分域读取
  assert.equal(store.get('server.url'), 'http://old:8000')
  assert.equal(store.get('llm.defaultModel'), 'old-model')
  assert.equal(store.get('feishu.appId'), 'cli_old')
  assert.equal(store.get('downloadDir'), 'C:\\old')
  assert.deepEqual(store.get('windowState'), { x: 1, y: 2 })
  assert.equal(store.get('themeMode'), 'light')
  assert.equal(store.get('ext.bridgePort'), '8123')
  // 旧文件改名 .bak（不删除）
  assert.ok(!fs.existsSync(legacyPath), '旧文件应已改名')
  assert.ok(fs.existsSync(legacyPath + '.bak'), '.bak 备份应存在')
  // 幂等：已分域的新值优先，旧文件再次出现不覆盖
  store.set('server.url', 'http://new:8000')
  fs.writeFileSync(legacyPath, JSON.stringify({ 'server.url': 'http://old:8000' }), 'utf8')
  const store2 = createConfigStore({ basePath: dir, legacyPath })
  assert.equal(store2.get('server.url'), 'http://new:8000')
})

test('迁移：无旧文件 / 非法 JSON 不抛错不阻塞启动', () => {
  const dir = makeTmpDir()
  const store = createConfigStore({ basePath: dir, legacyPath: path.join(dir, 'not-exist.json') })
  assert.equal(store.get('server.url', ''), '')
  // 非法 JSON：解析失败旧文件保留不动
  const badDir = makeTmpDir()
  const badPath = path.join(badDir, 'app-config.json')
  fs.writeFileSync(badPath, '{not-json', 'utf8')
  const store2 = createConfigStore({ basePath: badDir, legacyPath: badPath })
  assert.equal(store2.get('server.url', ''), '')
  assert.ok(fs.existsSync(badPath), '解析失败时旧文件保留')
})

// ═══════════════════════════════════════════════════════════════
// D6 配置固定 userData/config：路径决策 + 旧目录迁移 + 幂等（2026-08-30 修正）
// ═══════════════════════════════════════════════════════════════

test('D6 resolveConfigBasePath：配置固定 userData/config（跨版本/打包保留）', () => {
  const appRoot = makeTmpDir()
  const userData = makeTmpDir()
  const r = resolveConfigBasePath(appRoot, userData)
  assert.equal(r.basePath, path.join(userData, 'config'))
  assert.equal(r.writable, true)
  assert.equal(r.fallback, false)
  // 不再写应用根：换打包目录（dist-时间戳）不丢配置
  assert.ok(!r.basePath.startsWith(appRoot + path.sep), '配置不应落在应用根目录')
  assert.ok(!fs.existsSync(path.join(appRoot, 'config')), '应用根不应创建 config 目录')
})

test('D6 resolveConfigBasePath：不可写模拟注入仍返回 userData/config', () => {
  const appRoot = makeTmpDir()
  const userData = makeTmpDir()
  const r = resolveConfigBasePath(appRoot, userData, () => false)
  assert.equal(r.basePath, path.join(userData, 'config'))
  assert.equal(r.writable, true)
  assert.equal(r.fallback, false)
})

test('D6 resolveConfigBasePath：可写模拟注入仍返回 userData/config（无应用根副作用）', () => {
  const appRoot = makeTmpDir()
  const userData = makeTmpDir()
  const r = resolveConfigBasePath(appRoot, userData, () => true)
  assert.equal(r.basePath, path.join(userData, 'config'))
  assert.equal(r.writable, true)
  assert.ok(!fs.existsSync(path.join(appRoot, 'config')), '注入探测不产生应用根目录副作用')
})

test('D6 migrateLegacyBasePath：旧 userData/config → 新路径逐域合并迁移，旧域文件改名 .bak', () => {
  const oldDir = makeTmpDir()
  const newDir = makeTmpDir()
  // 旧分域目录：server.json + ai.json 有数据
  fs.writeFileSync(path.join(oldDir, 'server.json'), JSON.stringify({ 'server.url': 'http://old:8000' }), 'utf8')
  fs.writeFileSync(path.join(oldDir, 'ai.json'), JSON.stringify({ 'llm.defaultModel': 'old-model' }), 'utf8')
  const r = migrateLegacyBasePath(newDir, oldDir)
  assert.equal(r.migrated, true)
  assert.equal(r.files, 2)
  // 新路径拿到合并后的分域数据
  assert.equal(JSON.parse(fs.readFileSync(path.join(newDir, 'server.json'), 'utf8'))['server.url'], 'http://old:8000')
  assert.equal(JSON.parse(fs.readFileSync(path.join(newDir, 'ai.json'), 'utf8'))['llm.defaultModel'], 'old-model')
  // 旧域文件改名 .bak（不删除）
  assert.ok(!fs.existsSync(path.join(oldDir, 'server.json')), '旧域文件应已改名')
  assert.ok(fs.existsSync(path.join(oldDir, 'server.json.bak')))
  assert.ok(fs.existsSync(path.join(oldDir, 'ai.json.bak')))
})

test('D6 migrateLegacyBasePath：幂等——新路径已有新值优先，重复迁移不覆盖', () => {
  const oldDir = makeTmpDir()
  const newDir = makeTmpDir()
  fs.writeFileSync(path.join(oldDir, 'server.json'), JSON.stringify({ 'server.url': 'http://old:8000' }), 'utf8')
  fs.writeFileSync(path.join(newDir, 'server.json'), JSON.stringify({ 'server.url': 'http://new:8000' }), 'utf8')
  // 第一次迁移：新值优先
  const r1 = migrateLegacyBasePath(newDir, oldDir)
  assert.equal(r1.migrated, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(newDir, 'server.json'), 'utf8'))['server.url'], 'http://new:8000')
  assert.ok(fs.existsSync(path.join(oldDir, 'server.json.bak')))
  // 第二次迁移：旧文件已是 .bak（原路径不存在）→ 无文件可迁
  const r2 = migrateLegacyBasePath(newDir, oldDir)
  assert.equal(r2.migrated, false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(newDir, 'server.json'), 'utf8'))['server.url'], 'http://new:8000')
})

test('D6 migrateLegacyBasePath：同路径 / 无旧目录 / 空旧目录 → 跳过不迁移', () => {
  const dir = makeTmpDir()
  // 同路径（回退场景：basePath 就是 userData/config）→ 不迁移
  const same = migrateLegacyBasePath(dir, dir)
  assert.equal(same.migrated, false)
  assert.equal(same.reason, 'SAME_PATH')
  // 旧目录不存在
  const none = migrateLegacyBasePath(dir, path.join(dir, 'not-exist'))
  assert.equal(none.migrated, false)
  assert.equal(none.reason, 'NO_LEGACY_DIR')
  // 旧目录存在但无分域文件
  const emptyOld = makeTmpDir()
  const empty = migrateLegacyBasePath(dir, emptyOld)
  assert.equal(empty.migrated, false)
  assert.equal(empty.reason, 'NO_LEGACY_FILES')
})

test('D6 ConfigStore 集成：legacyBasePath 构造时迁移生效（新路径可读旧数据）', () => {
  const oldDir = makeTmpDir()
  const newDir = makeTmpDir()
  fs.writeFileSync(path.join(oldDir, 'server.json'), JSON.stringify({ 'server.url': 'http://migrated:8000' }), 'utf8')
  fs.writeFileSync(path.join(oldDir, 'app.json'), JSON.stringify({ 'themeMode': 'dark' }), 'utf8')
  const store = createConfigStore({ basePath: newDir, legacyBasePath: oldDir })
  assert.equal(store.get('server.url'), 'http://migrated:8000')
  assert.equal(store.get('themeMode'), 'dark')
  // 旧目录各域文件均已改名 .bak
  assert.ok(fs.existsSync(path.join(oldDir, 'server.json.bak')))
  assert.ok(fs.existsSync(path.join(oldDir, 'app.json.bak')))
  // 回退场景：basePath 与 legacyBasePath 相同 → 不迁移不干扰（幂等、原文件保留）
  const sameDir = makeTmpDir()
  fs.writeFileSync(path.join(sameDir, 'server.json'), JSON.stringify({ 'server.url': 'http://keep:8000' }), 'utf8')
  const store2 = createConfigStore({ basePath: sameDir, legacyBasePath: sameDir })
  assert.equal(store2.get('server.url'), 'http://keep:8000')
  assert.ok(fs.existsSync(path.join(sameDir, 'server.json')), '同路径时不迁移、原文件保留')
})
