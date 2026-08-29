// ═══════════════════════════════════════════════════════════════
// feishu-ipc.js — 飞书连接测试 IPC（条目⑩ S6）
// 对照原客户端 gui/main_window_aiconfig.py L584-600 _test_feishu：
//   POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
//   {app_id, app_secret}，成功 = HTTP 200 且响应含 tenant_access_token。
// 归属主进程：外网直连（非统一服务端地址域），渲染层 fetch 有 CORS 限制，
//   且凭据补全（useStored 时从 electron-store 读 feishu.appSecret）只能在
//   主进程做——明文不出现在展示层（条目⑩验收）。
// 凭据来源优先级：payload.appSecret（用户刚输入）→ electron-store
//   'feishu.appSecret'（已保存）。两者皆空 → 拦截（对照原 L589-591）。
// ═══════════════════════════════════════════════════════════════
const https = require('node:https')

const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'

/** JSON POST（外网域名直连；10s 超时对齐原 http_post timeout=10） */
function httpsPostJson(url, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let target
    try { target = new URL(url) } catch (e) { return reject(new Error('非法 URL')) }
    const data = Buffer.from(JSON.stringify(body || {}), 'utf-8')
    const req = https.request(target, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
      },
    }, (res) => {
      let raw = ''
      res.on('data', (d) => { raw += d })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(raw) } catch (_) { /* 非 JSON 响应保持 null */ }
        resolve({ status: res.statusCode || 0, json })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    req.on('error', (e) => reject(e))
    req.write(data)
    req.end()
  })
}

/**
 * 连接测试核心（可注入 post 便于单测；响应判定对齐原 L595-598）
 * @param {(url: string, body: object) => Promise<{status: number, json?: object}>} post
 * @param {string} appId 渲染层输入的 App ID（trim 后）
 * @param {string} appSecret 渲染层输入的 Secret（可为空 → useStored）
 * @param {() => string} [getStoredSecret] 主进程读 electron-store 'feishu.appSecret'
 */
async function testFeishuConnection(post, appId, appSecret, getStoredSecret) {
  let secret = String(appSecret || '').trim()
  if (!secret && typeof getStoredSecret === 'function') {
    secret = String(getStoredSecret() || '').trim()
  }
  const id = String(appId || '').trim()
  if (!id || !secret) return { ok: false, message: '失败： 请填入 App ID 和 Secret' }
  try {
    const r = await post(FEISHU_TOKEN_URL, { app_id: id, app_secret: secret })
    if (r && r.status === 200 && r.json && r.json.tenant_access_token) {
      return { ok: true, message: '完成： 连接成功' }
    }
    const status = r ? r.status : 0
    const msg = r && r.json && typeof r.json.msg === 'string' ? `：${r.json.msg}` : ''
    return { ok: false, message: `失败： HTTP ${status}${msg}` }
  } catch (e) {
    return { ok: false, message: `失败： ${String((e && e.message) || e)}` }
  }
}

function createFeishuIpc(ipcMain, { getCfg }) {
  ipcMain.handle('feishu:testConn', async (_e, payload) => {
    try {
      return await testFeishuConnection(
        httpsPostJson,
        String(payload?.appId || ''),
        String(payload?.appSecret || ''),
        () => {
          try { return String(getCfg('feishu.appSecret') || '') } catch (_) { return '' }
        },
      )
    } catch (e) {
      return { ok: false, message: `失败： ${String((e && e.message) || e)}` }
    }
  })
}

module.exports = { createFeishuIpc, testFeishuConnection, FEISHU_TOKEN_URL }
