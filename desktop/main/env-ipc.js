// ═══════════════════════════════════════════════════════════════
// env-ipc.js — 环境与维护的真实主进程操作
//   · env:serverPing    真探测本地服务端（HTTP GET /health，含延迟）
//   · env:restartService 重连校验（清会话缓存 + 重新探测）
//   · env:clearCache    清 Electron 会话缓存
// 说明：本地服务端为外部 HTTP 进程（127.0.0.1:8000），客户端不持有其进程句柄，
//       因此「重启」= 清会话缓存后重新探测连通性，非强杀外部进程。
//       （原 env:detectCdp 随系统设置扩展卡移除一并清理，P3）
// ═══════════════════════════════════════════════════════════════
const { session } = require('electron')
const http = require('node:http')

function pingServer(url) {
  return new Promise((resolve) => {
    let target
    try { target = new URL(url) } catch (_) { return resolve({ online: false, url }) }
    const started = Date.now()
    const req = http.get(target, { timeout: 3000 }, (res) => {
      res.resume()
      resolve({ online: true, url, status: res.statusCode, latencyMs: Date.now() - started })
    })
    req.on('timeout', () => { req.destroy(); resolve({ online: false, url }) })
    req.on('error', () => resolve({ online: false, url }))
  })
}

function createEnvIpc(ipcMain, { getServerUrl }) {
  ipcMain.handle('env:serverPing', async () => {
    try { return await pingServer(getServerUrl()) }
    catch (_) { return { online: false } }
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
}

module.exports = { createEnvIpc }