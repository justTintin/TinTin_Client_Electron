// ═══════════════════════════════════════════════════════════════
// auto-listing/engine.js — B12 自动上架：状态机编排（主进程）
//
// 对位：原 studio/utils/auto_listing/engine.py（状态机逐段对照）：
//   run→_check_login→_check_shop→_open_create_page→_stage1→_stage2
//   →_save_draft（强校验轮询）→可选 _try_publish→final 截图。
// 载体替换：外挂 Chrome CDP → 内置 BrowserView（persist:tintin-fxg 分区，
//   PLATFORM_DEFS.fxg）+ executeJavaScript + wc.debugger（CDP
//   DOM.setFileInputFiles 上传文件）+ wc.capturePage（截图）。
// 每步写 runs/<runId>/state.json（当前阶段/URL/runId，断点续跑）；
//   日志经注入的 log 回调写 logs/<runId>.log；进度回调 `[stage] msg`；
//   stop 支持（shouldStop → 抛「任务已停止」）。
// 执行通道通过依赖注入（getView），不直接 require('electron')，可单测。
// ═══════════════════════════════════════════════════════════════
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { inspectPackage, locateWorkingDir } = require('./validate')
const { preparePackage, stagingDir } = require('./package')
const { DOUYIN_STORES, loadConfig } = require('./config')
const { runsRootDir, readState, writeState, resumePlan } = require('./state')
const { clickTextScript } = require('./scripts/click-text')
const { markMainUploadScript } = require('./scripts/main-upload')
const { markTitleScript } = require('./scripts/title')
const { markLabelInputScript } = require('./scripts/label-input')
const { markDetailUploadScript, detailInputMultipleScript } = require('./scripts/detail-upload')
const { specInputCountScript, setSpecNameScript, clickSelectSpecTypeScript, setLastInputValueScript } = require('./scripts/spec')
const { markSkuUploadScript } = require('./scripts/sku-upload')
const { markPriceRowScript, clearPriceMarksScript } = require('./scripts/price-table')
const { saveDraftPollScript } = require('./scripts/save-draft')
const { loginCheckScript, shopCheckScript, createPageCheckScript } = require('./scripts/detect')
const { clearMarkScript, uploadingCheckScript, pressEnterScript, pressTabScript, setInputValueScript, normalizeText } = require('./scripts/common')

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CREATE_URLS = [
  'https://fxg.jinritemai.com/ffa/g/create',
  'https://fxg.jinritemai.com/ffa/mshop/homepage/index#/home/product/create',
]

class ListingError extends Error {
  constructor(msg) { super(msg); this.name = 'ListingError' }
}

/** 简易字符串 hash（label 评分 marker 随机后缀，对位原 abs(hash(...))） */
function _hash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

class AutoListingEngine {
  /**
   * @param {{getView: ()=>BrowserView, userDataDir: string, store?: object,
   *   onProgress?: (msg:string)=>void, shouldStop?: ()=>boolean,
   *   log?: (lvl:string, msg:string)=>void}} opts
   */
  constructor(opts) {
    this.getView = (opts && opts.getView) || (() => null)
    this.userDataDir = (opts && opts.userDataDir) || ''
    this.store = (opts && opts.store) || null
    this.onProgress = (opts && opts.onProgress) || (() => {})
    this.shouldStop = (opts && opts.shouldStop) || (() => false)
    this.log = (opts && opts.log) || (() => {})
    this.cfg = loadConfig(this.store, this.userDataDir)
    this._runId = ''
  }

  // ── 基础设施 ──

  _emit(stage, message) {
    if (this.shouldStop()) throw new ListingError('任务已停止')
    this.onProgress(`[${stage}] ${message}`)
    this.log('INFO', `[${stage}] ${message}`)
  }

  _wc() {
    const view = this.getView()
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      throw new ListingError('抖店 BrowserView 未就绪，请先打开抖店工作台')
    }
    return view.webContents
  }

  async _eval(wc, script) {
    return await wc.executeJavaScript(script, false)
  }

  /** CDP DOM.setFileInputFiles 上传（Electron 内唯一可行文件注入通道） */
  async _setFileInput(wc, selector, files) {
    try { await wc.debugger.attach('1.3') } catch (_) { /* 已附加则继续 */ }
    await wc.debugger.sendCommand('DOM.enable').catch(() => {})
    const doc = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true }).catch(() => null)
    if (!doc || !doc.root || doc.root.nodeId === 0) throw new ListingError('DOM 文档不可用')
    const q = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector }).catch(() => null)
    if (!q || !q.nodeId) throw new ListingError('未定位到上传控件: ' + selector)
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: q.nodeId, files })
  }

  async _shot(wc, runId, name) {
    try {
      const image = await wc.capturePage()
      const dir = path.join(this.cfg.resultDir, String(runId))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG())
    } catch (_) { /* 截图失败静默 */ }
  }

  async _waitUploadDone(wc, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const uploading = await this._eval(wc, uploadingCheckScript())
        if (!uploading) return
      } catch (_) { return }
      await _sleep(500)
    }
  }

  async _clickText(wc, text, exact = false) {
    try {
      const r = await this._eval(wc, clickTextScript(text, exact))
      return r === true
    } catch (_) { return false }
  }

  async _switchTab(wc, tabName) {
    if (await this._clickText(wc, tabName, true)) { await _sleep(800); return true }
    if (await this._clickText(wc, tabName, false)) { await _sleep(800); return true }
    return false
  }

  _findSkuImage(info, name) {
    const target = normalizeText(name)
    for (const p of info.sku_images) {
      const base = normalizeText(path.basename(p).replace(/\.[^.]+$/, ''))
      if (base === target || target.includes(base) || base.includes(target)) return p
    }
    return info.sku_images[0] || ''
  }

  // ── 状态机主流程 ──

  /** 完整任务（对位原 run）：校验 → 登录 → 店铺 → 创建页 → 阶段1/2 → 保存草稿 → 可选上架 */
  async run({ inputPath, shopKey, publishAfterSave, runId } = {}) {
    this._emit('校验', `准备数据包：${inputPath}`)
    const res = await this._prepareAndStage(inputPath, shopKey || this.cfg.shopKey, runId, publishAfterSave)
    const info = res.info
    this._emit('校验', `校验通过：${info.title || '（未命名商品）'} / ${info.skus.length} 个SKU`)
    return await this._runCore(info, { runId: res.runId, publishAfterSave })
  }

  /** 断点续跑（读 state.json + URL 特征，PRD 14.5） */
  async resume({ runId, publishAfterSave } = {}) {
    if (!runId) throw new ListingError('缺少 runId')
    this._runId = String(runId)
    const runsRoot = runsRootDir(this.cfg.syncDir)
    const state = readState(runsRoot, runId)
    if (!state) throw new ListingError(`未找到任务状态：${runId}`)
    const staged = stagingDir(this.cfg.syncDir, runId)
    const located = locateWorkingDir(staged)
    if (!fs.existsSync(path.join(located, 'sku.xlsx'))) {
      throw new ListingError(`数据包 staging 缺失：${staged}`)
    }
    const info = await inspectPackage(located, state.sourceName || '', state.shopKey || this.cfg.shopKey)
    const wc = this._wc()
    const plan = resumePlan(state, (wc.getURL && wc.getURL()) || '')
    if (!plan.canResume) throw new ListingError(`任务不可续跑：${plan.reason}`)
    this._emit('续跑', `从阶段 ${plan.stage} 继续（runId=${runId}）`)
    writeState(runsRoot, runId, { status: 'running', error: '' })
    return await this._runCore(info, {
      runId: String(runId),
      publishAfterSave: typeof publishAfterSave === 'boolean' ? publishAfterSave : !!state.publishAfterSave,
      resumeFromStage2: plan.stage === 'stage2',
    })
  }

  /** 数据包准备 + staging（runId=时间戳；resume 场景可复用既有 staging） */
  async _prepareAndStage(inputPath, shopKey, runId, publishAfterSave) {
    const res = await preparePackage(inputPath, shopKey, { syncDir: this.cfg.syncDir, runId })
    this._runId = res.runId
    const runsRoot = runsRootDir(this.cfg.syncDir)
    writeState(runsRoot, res.runId, {
      stage: 'validate', status: 'running', sourceName: res.sourceName, shopKey,
      publishAfterSave: !!publishAfterSave, url: '',
    })
    return res
  }

  /** 核心编排（对位原 run L92-118 内 6 步 + 阶段1/2 拆分） */
  async _runCore(info, { runId, publishAfterSave, resumeFromStage2 = false }) {
    this._runId = String(runId)
    this._pubAfterSave = !!publishAfterSave
    const wc = this._wc()
    const runsRoot = runsRootDir(this.cfg.syncDir)

    await this._checkLogin(wc)
    await this._checkShop(wc, info)

    if (resumeFromStage2) {
      this._emit('阶段2', '断点续跑：直接进入详情配置页')
    } else {
      await this._openCreatePage(wc)
      await this._stage1(wc, info, runId)
    }

    await this._stage2(wc, info, runId)

    this._emit('保存草稿', '点击保存草稿并校验页面状态')
    const saved = await this._saveDraft(wc, runId)
    if (publishAfterSave && saved) {
      this._emit('上架', '尝试直接上架')
      await this._tryPublish(wc, runId)
    }

    await this._shot(wc, runId, 'final')
    writeState(runsRoot, runId, { stage: 'final', status: 'done', url: (wc.getURL && wc.getURL()) || '' })
    return {
      saved: !!saved,
      publish_attempted: !!(publishAfterSave && saved),
      working_dir: info.working_dir,
      result_dir: path.join(this.cfg.resultDir, String(runId)),
      sku_count: info.skus.length,
      runId: String(runId),
    }
  }

  // ── 前置检查（对位原 _check_login / _check_shop / _open_create_page）──

  async _checkLogin(wc) {
    const url = (wc.getURL ? wc.getURL() : '') || ''
    if (/login|passport/i.test(url)) {
      throw new ListingError('检测到抖店登录页。请在打开的浏览器中扫码登录后重试。')
    }
    const r = await this._eval(wc, loginCheckScript())
    if (r && r.kind === 'login') {
      throw new ListingError('检测到抖店登录页。请在打开的浏览器中扫码登录后重试。')
    }
  }

  async _checkShop(wc, info) {
    const infoData = DOUYIN_STORES[info.shop_key] || {}
    const targetNames = [info.shop_name].concat(infoData.aliases || [])
    const otherNames = Object.entries(DOUYIN_STORES)
      .filter(([k]) => k !== info.shop_key)
      .map(([, s]) => s.name)
      .filter(Boolean)
    const r = await this._eval(wc, shopCheckScript({ targetNames, otherNames }))
    if (r && r.kind === 'wrong_shop') {
      throw new ListingError(`当前页面疑似店铺「${r.other}」，与目标店铺「${info.shop_name}」不一致。`)
    }
  }

  async _openCreatePage(wc) {
    const url = (wc.getURL ? wc.getURL() : '').toLowerCase()
    if (url.includes('create') && !url.includes('login')) return
    for (const u of CREATE_URLS) {
      try {
        await wc.loadURL(u)
        await _sleep(2000)
        const cur = (wc.getURL ? wc.getURL() : '').toLowerCase()
        if (cur.includes('login') || cur.includes('passport')) continue
        const r = await this._eval(wc, createPageCheckScript())
        if (r && r.kind === 'create') return
      } catch (_) { /* 单 URL 失败继续下一个 */ }
    }
    throw new ListingError('未能打开抖店商品创建页，请确认已登录且有商品创建权限。')
  }

  // ── 阶段1（对位原 _stage1 + _upload_main_images + _fill_title）──

  async _stage1(wc, info, runId) {
    this._emit('阶段1', '上传主图 / 填写标题 / 等待类目')
    writeState(runsRootDir(this.cfg.syncDir), runId, { stage: 'stage1', url: (wc.getURL && wc.getURL()) || '' })
    await this._uploadMainImages(wc, info.main_images)
    await this._fillTitle(wc, info.title)
    await _sleep(5000)
    if (!(await this._clickText(wc, '下一步'))) {
      this._emit('阶段1', '未找到「下一步」按钮，继续尝试详情页')
    }
    await _sleep(1500)
    await this._shot(wc, runId, 'stage1')
  }

  async _uploadMainImages(wc, images) {
    if (!images || !images.length) throw new ListingError('数据包没有主图')
    await _sleep(1000)
    const marked = await this._eval(wc, markMainUploadScript())
    const selector = marked ? 'input[data-als-main="1"]' : 'input[type="file"]'
    try {
      await this._setFileInput(wc, selector, images)
    } catch (_) {
      // 单张兜底（对位原 set_input_files(images[0])）
      await this._setFileInput(wc, selector, [images[0]])
    }
    await this._eval(wc, clearMarkScript('data-als-main'))
    await this._waitUploadDone(wc)
  }

  async _fillTitle(wc, title) {
    if (!title) return
    const marked = await this._eval(wc, markTitleScript())
    if (marked) {
      await this._eval(wc, setInputValueScript('[data-als-title="1"]', title))
      await this._eval(wc, pressTabScript())
      await this._eval(wc, clearMarkScript('data-als-title'))
    } else {
      // 兜底（对位原 L340-342）
      await this._eval(wc, setInputValueScript('input[placeholder*="请输入2-60"]', title))
    }
  }

  // ── 阶段2（对位原 _stage2 五 Tab）──

  async _stage2(wc, info, runId) {
    this._emit('阶段2', '填写基础信息 / 图文信息 / 价格库存 / 服务与履约 / 其他信息')
    writeState(runsRootDir(this.cfg.syncDir), runId, { stage: 'stage2', url: (wc.getURL && wc.getURL()) || '' })

    await this._switchTab(wc, '基础信息')
    await this._fillBrand(wc, info)
    await this._fillModelAndManufacturer(wc, info)
    await this._shot(wc, runId, 'basic_info')

    await this._switchTab(wc, '图文信息')
    await this._uploadDetailImages(wc, info.detail_images)
    await this._shot(wc, runId, 'image_text')

    await this._switchTab(wc, '价格库存')
    await this._fillPriceInventory(wc, info)
    await this._shot(wc, runId, 'price_inventory')

    await this._switchTab(wc, '服务与履约')
    await this._clickText(wc, '下架')
    await this._shot(wc, runId, 'service')

    await this._switchTab(wc, '其他信息')
    await this._shot(wc, runId, 'other_info')
  }

  async _fillBrand(wc, info) {
    const brand = (info.brand || '无品牌').trim()
    if (brand === '无品牌') { await this._clickText(wc, '无品牌', true); return }
    if (!(await this._fillTextByLabel(wc, '品牌', brand))) {
      this._emit('基础信息', `品牌字段填写未命中（目标：${brand}）`)
    }
  }

  async _fillModelAndManufacturer(wc, info) {
    if (info.model) await this._fillTextByLabel(wc, '型号', info.model)
    if (info.manufacturer) await this._fillTextByLabel(wc, '生产厂家', info.manufacturer)
  }

  /** Label 关联输入（几何评分，对位原 _fill_text_by_label L344-399） */
  async _fillTextByLabel(wc, label, value) {
    if (!label || !value) return false
    const marker = 'als-' + _hash(`${label}|${value}`).toString(36)
    const marked = await this._eval(wc, markLabelInputScript(label, marker))
    if (!marked) return false
    try {
      await this._eval(wc, setInputValueScript(`input[data-als-label-input="${marker}"]`, value))
      await this._eval(wc, pressTabScript())
      return true
    } finally {
      await this._eval(wc, clearMarkScript('data-als-label-input'))
    }
  }

  async _uploadDetailImages(wc, images) {
    if (!images || !images.length) return
    const marked = await this._eval(wc, markDetailUploadScript())
    if (!marked) {
      this._emit('图文信息', '未定位到详情图上传控件，跳过详情图上传')
      return
    }
    try {
      const multiple = await this._eval(wc, detailInputMultipleScript())
      if (multiple) {
        await this._setFileInput(wc, '[data-als-detail="1"]', images)
        await this._waitUploadDone(wc, 300000)
      } else {
        for (const img of images) {
          await this._setFileInput(wc, '[data-als-detail="1"]', [img])
          await this._waitUploadDone(wc, 60000)
        }
      }
    } catch (e) {
      this._emit('图文信息', `详情图上传异常：${e.message || e}`)
    }
    await this._eval(wc, clearMarkScript('data-als-detail'))
  }

  async _fillPriceInventory(wc, info) {
    await this._clickText(wc, '48小时', true)
    await _sleep(500)
    const names = info.skus.map((s) => s.name)
    if (!names.length) return
    await _sleep(500)
    let count = await this._eval(wc, specInputCountScript())
    if (count === 0) {
      await this._createNewSpecType(wc)
      await _sleep(1500)
      count = await this._eval(wc, specInputCountScript())
    }
    for (let i = 0; i < names.length; i++) {
      if (i >= count) {
        await this._clickText(wc, '添加规格')
        await _sleep(400)
        count = await this._eval(wc, specInputCountScript())
        if (i >= count) break
      }
      const set = await this._eval(wc, setSpecNameScript(names[i], i))
      if (set) { await this._eval(wc, pressEnterScript()); await _sleep(300) }
    }

    for (const sku of info.skus) {
      const img = this._findSkuImage(info, sku.name)
      if (!img) continue
      const marked = await this._eval(wc, markSkuUploadScript(sku.name))
      if (marked) {
        try {
          await this._setFileInput(wc, '[data-als-sku-upload="1"]', [img])
          await this._waitUploadDone(wc, 60000)
        } catch (_) { /* 单 SKU 图失败跳过 */ }
        await this._eval(wc, clearMarkScript('data-als-sku-upload'))
      }
    }

    await this._fillPriceTable(wc, info)
  }

  async _createNewSpecType(wc) {
    await this._clickText(wc, '添加规格类型')
    await _sleep(800)
    await this._eval(wc, clickSelectSpecTypeScript())
    await _sleep(600)
    await this._clickText(wc, '创建类型')
    await _sleep(600)
    await this._eval(wc, setLastInputValueScript('型号'))
  }

  async _fillPriceTable(wc, info) {
    for (const sku of info.skus) {
      const marked = await this._eval(wc, markPriceRowScript(sku.name))
      if (!marked) continue
      try {
        await this._eval(wc, setInputValueScript('[data-als-price="1"]', '999'))
        await this._eval(wc, setInputValueScript('[data-als-inv="1"]', '999'))
        if (sku.merchant_code) {
          const hasCode = await this._eval(wc, `(() => !!document.querySelector('[data-als-code="1"]'))()`)
          if (hasCode) await this._eval(wc, setInputValueScript('[data-als-code="1"]', sku.merchant_code))
        }
      } catch (_) { /* 单行填写失败跳过 */ }
      await this._eval(wc, clearPriceMarksScript())
    }
  }

  // ── 保存草稿强校验（PRD 14.5 验收点，对位原 _save_draft L646-690）──

  async _saveDraft(wc, runId) {
    writeState(runsRootDir(this.cfg.syncDir), runId, { stage: 'save_draft', url: (wc.getURL && wc.getURL()) || '' })
    await this._clickText(wc, '保存草稿')
    await _sleep(500)
    let success = false
    let errorMsg = ''
    for (let i = 0; i < 15; i++) {
      await _sleep(200)
      try {
        const state = await this._eval(wc, saveDraftPollScript())
        if (state) {
          if (state.kind === 'error') { errorMsg = state.text || ''; break }
          success = true
          break
        }
        const url = (wc.getURL && wc.getURL()) || ''
        if (!url.includes('create')) { success = true; break }
      } catch (_) { /* 单轮轮询失败继续 */ }
    }
    if (success) this._emit('保存草稿', '草稿保存成功')
    else if (errorMsg) this._emit('保存草稿', `保存失败：${errorMsg}`)
    else this._emit('保存草稿', '已点击保存草稿，但未检测到明确成功/失败提示')
    return success
  }

  async _tryPublish(wc, runId) {
    await this._clickText(wc, '上架')
    await _sleep(2000)
    this._emit('上架', '已点击上架，请到商品管理中确认最终状态')
  }
}

module.exports = { AutoListingEngine, ListingError }
