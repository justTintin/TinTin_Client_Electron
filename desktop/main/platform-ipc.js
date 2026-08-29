// ═══════════════════════════════════════════════════════════════
// platform-ipc.js — S8 平台接入 + S9 系统运行 IPC（主进程）
//
// S8 平台接入（对照原客户端 main_window_pages.py L990-1245 数字人 Tab；
//   服务端接口全部核对自 openapi-latest.json，禁止臆造）：
//   · platform:getConfig          GET /comfyui/config + GET /runninghub/config
//                                 + 本地数字人 workflowId（integration 域）
//   · platform:saveComfyui        PUT /comfyui/config {host, port}
//                                 （ComfyUIConfig：host 默认 127.0.0.1 / port 默认 8188）
//   · platform:saveRunninghub     PUT /runninghub/config {api_key, base_url,
//                                 use_personal_queue, ...}（api_key 服务端持有，
//                                 空输入跳过=保留已存值，明文不出展示层）
//   · platform:saveDigitalHuman   workflowId → config 'digitalhuman.workflowId'
//                                 （数字人无独立配置接口，/digital-human/batch
//                                  默认 workflow_id 2085292185062297602）
//   · platform:testComfyui        GET /comfyui/status（在线状态）
//   · platform:testRunninghub     GET /runninghub/status（连接状态+配置）
//
// S9 系统运行（对照原 L1931-2040 自启动 / L1973-2039 缓存目录）：
//   · system:getAutoStart         app.getLoginItemSettings().openAtLogin
//   · system:setAutoStart         app.setLoginItemSettings({openAtLogin, path})
//     （托盘 tray.js L54-63 已有同款能力，设置页补齐 UI 入口，双向一致）
// ═══════════════════════════════════════════════════════════════

'use strict'
const { app } = require('electron')

/** 平台配置接口路径（openapi-latest.json 核对：ComfyUI/RunningHub tags） */
const PLATFORM_ENDPOINTS = {
  comfyui:   { config: '/comfyui/config',   status: '/comfyui/status' },
  runninghub: { config: '/runninghub/config', status: '/runninghub/status' },
}

/**
 * 平台状态响应判定（GET /comfyui/status、/runninghub/status；纯函数可单测）
 * httpRequest 2xx → {data}；离线/异常 → reject 或 null
 */
function parsePlatformStatusResult(r, platform) {
  if (r === null || r === undefined) return { ok: false, message: `${platform} 服务端离线或不可达` }
  if (typeof r === 'object' && 'error' in r) {
    return { ok: false, message: `${platform} 查询失败：${String(r.error)}` }
  }
  return { ok: true, message: `${platform} 端点可达` }
}

/** 配置读取（GET /comfyui/config 等；httpRequest 异常 → null 由调用方兜底） */
async function safeGet(httpRequest, path) {
  try {
    const res = await httpRequest('GET', path, { timeout: 8000 })
    return res && res.data !== undefined ? res.data : {}
  } catch (_) { return null }
}

/** 配置保存（PUT；返回 {ok, message}） */
async function safePut(httpRequest, path, body) {
  try {
    await httpRequest('PUT', path, { body, timeout: 8000 })
    return { ok: true, message: '已保存' }
  } catch (e) {
    return { ok: false, message: `保存失败：${String((e && e.message) || e)}` }
  }
}

/**
 * 注册 S8/S9 IPC
 * @param {object} ipcMain electron ipcMain
 * @param {object} deps
 *   httpRequest: (method, path, opts) => Promise<{data}>（注入 server-proxy 的 httpRequest）
 *   getCfg: (key) => unknown    读 config-store
 *   setCfg: (key, val) => void  写 config-store
 */
function createPlatformIpc(ipcMain, { httpRequest, getCfg, setCfg }) {
  // ── S8 平台配置读取（ComfyUI + RunningHub 状态 + 本地数字人 workflowId）──
  ipcMain.handle('platform:getConfig', async () => {
    const [comfyui, runninghub] = await Promise.all([
      safeGet(httpRequest, PLATFORM_ENDPOINTS.comfyui.config),
      safeGet(httpRequest, PLATFORM_ENDPOINTS.runninghub.config),
    ])
    let workflowId = ''
    try { workflowId = String(getCfg('digitalhuman.workflowId') || '') } catch (_) { /* 静默 */ }
    return { comfyui, runninghub, digitalhuman: { workflowId } }
  })

  // ── S8 保存 ComfyUI 地址（PUT /comfyui/config）──
  ipcMain.handle('platform:saveComfyui', async (_e, payload) => {
    const p = payload || {}
    const body = {}
    if (String(p.host || '').trim()) body.host = String(p.host).trim()
    const port = Number(p.port)
    if (Number.isInteger(port) && port > 0) body.port = port
    return safePut(httpRequest, PLATFORM_ENDPOINTS.comfyui.config, body)
  })

  // ── S8 保存 RunningHub 连接（PUT /runninghub/config；空 api_key 跳过保留）──
  ipcMain.handle('platform:saveRunninghub', async (_e, payload) => {
    const p = payload || {}
    const body = {}
    const key = String(p.api_key || '').trim()
    if (key) body.api_key = key
    const baseUrl = String(p.base_url || '').trim()
    if (baseUrl) body.base_url = baseUrl
    body.use_personal_queue = !!p.use_personal_queue
    return safePut(httpRequest, PLATFORM_ENDPOINTS.runninghub.config, body)
  })

  // ── S8 保存数字人 workflowId（无服务端接口 → 本地 integration 域）──
  ipcMain.handle('platform:saveDigitalHuman', async (_e, payload) => {
    try {
      const v = String((payload && payload.workflowId) || '').trim()
      setCfg('digitalhuman.workflowId', v)
      return { ok: true, message: '已保存（本地）' }
    } catch (e) {
      return { ok: false, message: `保存失败：${String((e && e.message) || e)}` }
    }
  })

  // ── S8 测试连接：ComfyUI / RunningHub（GET status）──
  ipcMain.handle('platform:testComfyui', async () => {
    const r = await safeGet(httpRequest, PLATFORM_ENDPOINTS.comfyui.status)
    return parsePlatformStatusResult(r, 'ComfyUI')
  })
  ipcMain.handle('platform:testRunninghub', async () => {
    const r = await safeGet(httpRequest, PLATFORM_ENDPOINTS.runninghub.status)
    return parsePlatformStatusResult(r, 'RunningHub')
  })

  // ── S9 自启动开关（app.setLoginItemSettings；与托盘 tray.js 同通道一致）──
  ipcMain.handle('system:getAutoStart', () => {
    try { return { enabled: !!app.getLoginItemSettings().openAtLogin } }
    catch (e) { return { enabled: false, error: String((e && e.message) || e) } }
  })
  ipcMain.handle('system:setAutoStart', (_e, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled, path: app.getPath('exe') })
      return { enabled: !!app.getLoginItemSettings().openAtLogin }
    } catch (e) {
      return { enabled: !!app.getLoginItemSettings().openAtLogin, error: String((e && e.message) || e) }
    }
  })
}

module.exports = { createPlatformIpc, parsePlatformStatusResult, PLATFORM_ENDPOINTS }
