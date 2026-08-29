// ═══════════════════════════════════════════════════════════════
// env-ipc.js — 环境与维护的真实主进程操作
//   · env:serverPing    真探测本地服务端（HTTP GET /health，含延迟）
//   · env:restartService 重连校验（清会话缓存 + 重新探测）
//   · env:clearCache    清 Electron 会话缓存
//   · env:detectEnv     条目⑪ 环境检测（口径重定义）：服务端连通 ping +
//                       本地资源（main/env-detect.js：ffmpeg/磁盘/os/cpu/ram）
//   · env:logList       客户端日志文件列表（对齐原客户端日志查看页，2026-08-28）
//   · env:openLog       打开单个日志文件（shell.openPath，系统默认编辑器）
//   · env:getMachineInfo 本机机器码原始系统信息（关于卡展示，2026-08-28）
// 说明：本地服务端为外部 HTTP 进程（127.0.0.1:8000），客户端不持有其进程句柄，
//       因此「重启」= 清会话缓存后重新探测连通性，非强杀外部进程。
//       （原 env:detectCdp 随系统设置扩展卡移除一并清理，P3）
// ═══════════════════════════════════════════════════════════════
const { session, app } = require('electron')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { detectLocalResources } = require('./env-detect')
const logger = require('./logger')

// 探测统一走 getServerUrl()（electron-store 'server.url' 单一地址源），
// 地址可能是 https（设置页保存），按协议选模块，避免 https 地址被误判离线
function pingServer(url) {
  return new Promise((resolve) => {
    let target
    try { target = new URL(url) } catch (_) { return resolve({ online: false, url }) }
    const lib = target.protocol === 'https:' ? https : http
    const started = Date.now()
    const req = lib.get(target, { timeout: 3000 }, (res) => {
      res.resume()
      resolve({ online: true, url, status: res.statusCode, latencyMs: Date.now() - started })
    })
    req.on('timeout', () => { req.destroy(); resolve({ online: false, url }) })
    req.on('error', () => resolve({ online: false, url }))
  })
}

function createEnvIpc(ipcMain, { getServerUrl, studioRoot }) {
  // 日志初始化（环境与维护卡「日志」区块数据源；写 %APPDATA%/logs/client-YYYYMMDD.log）
  // 首条启动日志同时记录启动时生效的服务端地址（getServerUrl 读取链路排查锚点）
  try {
    logger.initLogger(app.getPath('userData'))
    logger.logInfo('app', `startup: server url effective = ${getServerUrl()}`)
  } catch (_) { /* 日志失败静默 */ }
  ipcMain.handle('env:serverPing', async () => {
    try { return await pingServer(getServerUrl()) }
    catch (_) { return { online: false } }
  })

  // 条目⑪ 环境检测（口径重定义）：服务端连通 + 本地资源（ffmpeg/磁盘/os/cpu/ram）。
  // 能力健康由渲染层并行调 server.healthCapabilities（/health/capabilities），不在此重复。
  ipcMain.handle('env:detectEnv', async () => {
    let server = { online: false }
    try { server = await pingServer(getServerUrl()) } catch (_) { /* 保持 offline */ }
    let local = null
    try {
      local = await detectLocalResources({
        resourcesPath: process.resourcesPath || '',
        studioRoot: studioRoot || '',
        statPath: app.getPath('userData'),
      })
    } catch (_) { local = null } // 检测异常 → 渲染层 unknown 行（不误报失败）
    return { server, local }
  })

  ipcMain.handle('env:clearCache', async () => {
    try {
      if (session?.defaultSession?.clearCache) await session.defaultSession.clearCache()
      return { ok: true }
    } catch (e) { return { ok: false, error: String(e) } }
  })

  ipcMain.handle('env:restartService', async () => {
    try { if (session?.defaultSession?.clearCache) await session.defaultSession.clearCache() } catch (_) {}
    try { return await pingServer(getServerUrl()) }
    catch (_) { return { online: false } }
  })

  // ── 日志区块（对齐原客户端日志查看页）：列表 + 打开单个文件 ──
  ipcMain.handle('env:logList', () => {
    try { return { ok: true, dir: logger.getLogsDir(), files: logger.listLogFiles() } }
    catch (e) { return { ok: false, files: [], error: String(e?.message || e) } }
  })

  ipcMain.handle('env:openLog', (_e, name) => logger.openLogFile(name))

  // ── 关于卡·本机机器码：只采集原始系统信息，SHA256 摘要在渲染层纯函数完成 ──
  // machine-id 取 Windows MachineGuid（reg query，稳定且随系统安装生成），
  // 失败回退首个非内部网卡 MAC，再回退 hostname+platform。
  ipcMain.handle('env:getMachineInfo', async () => {
    const info = { hostname: os.hostname(), platform: os.platform(), machineGuid: '', mac: '', source: '' }
    // 首个非内部网卡 MAC（跨平台兜底）
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) {
          if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') { info.mac = ni.mac; break }
        }
        if (info.mac) break
      }
    } catch (_) {}
    if (process.platform === 'win32') {
      info.machineGuid = await new Promise((resolve) => {
        try {
          execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
            { timeout: 3000 }, (err, stdout) => {
              if (err) return resolve('')
              const m = String(stdout).match(/MachineGuid\s+REG_SZ\s+(\S+)/i)
              resolve(m ? m[1] : '')
            })
        } catch (_) { resolve('') }
      })
    }
    info.source = info.machineGuid ? 'machine-guid' : (info.mac ? 'mac' : 'hostname')
    try { logger.logInfo('machine', `machine info collected: source=${info.source}`) } catch (_) {}
    return info
  })
}

module.exports = { createEnvIpc }