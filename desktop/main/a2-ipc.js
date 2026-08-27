// ═══════════════════════════════════════════════════════════════
// a2-ipc.js — A2 双模式 IPC 注册（扩展 C14 白名单 10 条 + 配置 2 条）
//
// 规格 §1.3.4 C14：所有 A2 IPC 通道必须在此文件显式注册，
//                  渲染层只能通过 window.tintin 白名单对象调用（Q2 红线）。
//
// 12 条通道：
//   config:get              — 读取 electron-store 的单键或整份持久化配置
//   config:set              — 写 electron-store 单键或批量写（主题模式/窗口状态等）
//   model:listPkgs          — 列出可下载模型包清单 + 安装状态
//   model:download          — 按 pkgId 下载（断点续传 + SHA256，挂全局下载总线）
//   model:cancel            — 取消正在下载的 pkg
//   model:uninstall         — 卸载 pkg（释放磁盘）
//   inference:getCapability — 获取本地推理能力可用性（模式 + 缓存）
//   inference:setMode       — 用户切换：server-only / hybrid-auto / force-local
//   ocr:imageToText         — OCR（A2 Router 自动路由本地/HTTP）
//   knowledge:listDocuments — 知识库文档列表（better-sqlite3）
//   knowledge:deleteDocument — 删除文档
//   knowledge:vectorSearch  — 向量搜索（A2 Router 本地 sqlite-vss / HTTP fallback）
// ═══════════════════════════════════════════════════════════════

const { ipcMain } = require('electron')
const { API_ENDPOINTS } = require('./server-proxy')

function createA2Ipc(ipcMain, ctx) {
  /**
   * ctx = {
   *   store,             // electron-store 实例
   *   modelManager,      // createModelManager()
   *   inferenceRouter,   // new InferenceRouter()
   *   vectorStore,       // createVectorStore()
   *   // HTTP 执行器：复用 server-proxy.js 的 httpRequest（从外部注入）
   *   httpRequest: (method, path, opts) => Promise<{data, status, headers}>
   * }
   */
  const { store, modelManager, inferenceRouter, vectorStore, httpRequest } = ctx

  // 幂等注册：main.js 会"占位注册(null 依赖) → 二次重注册(真实依赖)"两次调用本函数，
  // 必须先移除旧 handler 再注册，否则 ipcMain.handle 对同名 channel 抛异常导致初始化中断
  const _handle = (channel, fn) => {
    try { ipcMain.removeHandler(channel) } catch (_) { /* 尚未注册过 */ }
    ipcMain.handle(channel, fn)
  }

  // ======== 0. config:* 2 条（渲染层通用配置持久化） ========
  _handle('config:get', (_e, key, defaultValue) => {
    try {
      if (typeof key === 'undefined') return { success: true, data: store?.store ?? null }
      return { success: true, data: store ? store.get(key, defaultValue) : defaultValue }
    } catch (e) { return { success: false, error: e.message, data: defaultValue } }
  })

  _handle('config:set', (_e, keyOrObject, value) => {
    try {
      if (!store) return { success: false, error: 'STORE_NOT_INITIALIZED' }
      if (keyOrObject !== null && typeof keyOrObject === 'object' && !Array.isArray(keyOrObject)) {
        for (const [k, v] of Object.entries(keyOrObject)) store.set(k, v)
      } else if (typeof keyOrObject === 'string') {
        store.set(keyOrObject, value)
      } else {
        throw new Error('config:set expects key:string or object record')
      }
      return { success: true }
    } catch (e) { return { success: false, error: e.message } }
  })

  // ======== 1. model:* 4 条 ========
  _handle('model:listPkgs', () => {
    try {
      return { success: true, data: modelManager.listPkgs() }
    } catch (e) { return { success: false, error: e.message } }
  })

  _handle('model:download', async (_e, pkgId) => {
    try {
      return await modelManager.downloadPkg(pkgId)
    } catch (e) { return { success: false, error: e.message } }
  })

  _handle('model:cancel', (_e, pkgId) => {
    try {
      return modelManager.cancelPkg(pkgId)
    } catch (e) { return { success: false, error: e.message } }
  })

  _handle('model:uninstall', (_e, pkgId) => {
    try {
      return modelManager.uninstallPkg(pkgId)
    } catch (e) { return { success: false, error: e.message } }
  })

  // ======== 2. inference:* 2 条 ========
  _handle('inference:getCapability', (_e, force) => {
    try {
      const cap = inferenceRouter.getCapability(!!force)
      return { success: true, data: cap }
    } catch (e) { return { success: false, error: e.message } }
  })

  _handle('inference:setMode', (_e, mode) => {
    try {
      const valid = ['server-only', 'hybrid-auto', 'force-local']
      if (!valid.includes(mode)) throw new Error(`Invalid mode: ${mode}. Must be one of ${valid.join('/')}`)
      store.set('inference.mode', mode)
      store.set('inference.lastModeChangeAt', Date.now())
      // 刷新 capability 缓存
      inferenceRouter.getCapability(true)
      return { success: true, data: { mode } }
    } catch (e) { return { success: false, error: e.message } }
  })

  // ======== 3. ocr:* 1 条（通过 inferenceRouter 双模式路由）========
  _handle('ocr:imageToText', async (event, payload, onProgressChannel) => {
    try {
      const p = payload || {}
      if (!p.image) throw new Error('ocr:imageToText missing image')

      const imageInput = typeof p.image === 'string'
        ? p.image                      // 本地绝对路径，交给 ocr-local 读文件
        : (p.image?.path ? p.image.path : p.image)   // upload 场景：可能是 multipart 传入的 file 元数据

      // —— inferenceRouter 路由决策 ——
      const result = await inferenceRouter.route('ocr',
        // 本地执行器入参
        { imageInput, lang: p.lang },
        // HTTP 分支参数：复用 server-proxy.js 的 multipartUpload
        {
          httpEndpoint: API_ENDPOINTS.material.ocr,
          httpMethod: 'POST_MULTIPART',
          // multipart 专用：额外参数
          _multipart: {
            fields: { image: p.image, ...(p.lang ? { lang: p.lang } : {}) },
            onProgress: onProgressChannel ? (percent) => event.sender.send(onProgressChannel, percent) : undefined
          }
        }
      )

      if (!result.success) {
        return { error: result.error || 'OCR_FAILED', detail: result.detail, branch: result.branch }
      }
      // HTTP 分支：data 为服务端响应；本地分支：data 为 { lines, durationMs }
      return { ...result.data, branch: result.branch, durationMs: result.durationMs }
    } catch (e) {
      return { error: e.message || String(e) }
    }
  })

  // ======== 4. knowledge:* 3 条（vectorStore 本地 / HTTP fallback）========
  _handle('knowledge:listDocuments', async (_e, params) => {
    try {
      const local = vectorStore.listDocuments(params || {})
      if (local.success) return { success: true, data: local.data, branch: 'local', durationMs: local.durationMs }
      // 本地 DB 异常 → fallback HTTP
      const res = await httpRequest('GET',
        `${API_ENDPOINTS.tasks.unifiedList}?type=knowledge&limit=${params?.limit || 50}&offset=${params?.offset || 0}`)
      return { success: true, data: res.data, branch: 'http', fallbackReason: 'LOCAL_DB_ERROR:' + local.msg }
    } catch (e) { return { success: false, error: e.message } }
  })

  _handle('knowledge:deleteDocument', async (_e, id) => {
    try {
      const local = vectorStore.deleteDocument(id)
      if (local.success) return { success: true, data: local.data, branch: 'local', durationMs: local.durationMs }
      const res = await httpRequest('DELETE', `/knowledge/documents/${id}`)
      return { success: true, data: res.data, branch: 'http', fallbackReason: 'LOCAL_DB_ERROR:' + local.msg }
    } catch (e) { return { success: false, error: e.message } }
  })

  _handle('knowledge:vectorSearch', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!p.query) throw new Error('knowledge:vectorSearch missing query')

      const vsResult = await inferenceRouter.route('vectorSearch',
        // 本地入参：本地 embedding + sqlite-vss（此处只接收已算好的 queryVector）
        { queryVector: p.queryVector, topK: p.topK || 8 },
        // HTTP 分支：/vector/search
        { httpEndpoint: '/vector/search', httpMethod: 'POST' }
      )
      if (!vsResult.success) return { success: false, error: vsResult.error, detail: vsResult.detail }
      return { success: true, data: vsResult.data, branch: vsResult.branch, durationMs: vsResult.durationMs }
    } catch (e) { return { success: false, error: e.message } }
  })
}

module.exports = { createA2Ipc }
