// ═══════════════════════════════════════════════════════════════
// env-ipc.js — 环境与维护 / 扩展插件 的真实主进程操作
//   · env:serverPing    真探测本地服务端（HTTP GET /health，含延迟）
//   · env:restartService 重连校验（清会话缓存 + 重新探测）
//   · env:clearCache    清 Electron 会话缓存
//   · env:detectCdp     探测本地调试 Chrome（CDP /json/version）
// 说明：本地服务端为外部 HTTP 进程（127.0.0.1:8000），客户端不持有其进程句柄，
//       因此「重启」= 清会话缓存后重新探测连通性，非强杀外部进程。
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

function detectCdp(port) {
  const p = Number(port) || 9222
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: p, path: '/json/version', timeout: 2000 },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try { resolve({ connected: true, port: p, info: JSON.parse(data) }) }
          catch (_) { resolve({ connected: true, port: p }) }
        })
      },
    )
    req.on('timeout', () => { req.destroy(); resolve({ connected: false, port: p }) })
    req.on('error', () => resolve({ connected: false, port: p }))
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

  ipcMain.handle('env:detectCdp', async (_e, port) => {
    return detectCdp(port)
  })
}

module.exports = { createEnvIpc }