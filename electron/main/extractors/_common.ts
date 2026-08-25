/**
 * extractors/_common.ts —— 5 平台抽取脚本共享契约（运行在 BrowserView 页面 DOM 上下文！不是 Node.js！）
 *
 *  ⚠️  关键运行时约束（E3）
 *     1) 这份代码是被 thickShell-ipc.js 的 fs.readFileSync + wc.executeJavaScript()
 *        以"纯文本 JS"方式直接注入页面执行的，**不经过 TypeScript / Node.js 编译**。
 *        因此本文件的 .ts 扩展名只为编辑器语义；实际语法必须是纯 ES2020。
 *        禁止使用：type/interface/enum/implements/private/public/readonly/const enum/import/export
 *        可以使用：var/let/const/箭头函数/解构/可选链/空值合并/class/bigint 等原生语法
 *     2) 运行在平台自己的 DOM 上下文中（document/window = 真实页面），
 *        能访问平台 DOM 与全局变量，但**不能**访问 require / fs / path / ipcRenderer。
 *     3) 所有平台脚本（douyin.ts ~ bilibili.ts）在调用本文件的工具函数前，
 *        会先被 thickShell 把本文件内容 prepend 进去，再 append 各自脚本。
 *        因此本文件用 var 声明工具挂在 window.__TIN_EXTRACT 命名空间上。
 *
 *  统一返回结构（所有 extractor 必须遵守，否则主进程会报 DOM_MISMATCH）：
 *    成功：{ ok: true,  data: { source, meta, content, ... } }
 *    失败：{ ok: false, error: { type, message, hint? } }
 *      type ∈ { NEED_LOGIN, RISK_CAPTCHA, DOM_MISMATCH, NETWORK_ERROR }
 */

var __TIN_EX_COMMON__ = (function () {
  // ───────── 结构化错误工厂（E3）─────────
  function fail(type, message, hint) {
    return {
      ok: false,
      error: {
        type: String(type || 'DOM_MISMATCH'),
        message: String(message || '抽取失败'),
        hint: hint ? String(hint) : undefined,
      },
    }
  }
  function succ(data) {
    return { ok: true, data: data || null }
  }

  // ───────── 基础工具（DOM + 文本）─────────
  function $(sel, root) {
    try { return (root || document).querySelector(sel) || null } catch (_) { return null }
  }
  function $$(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel) || []) } catch (_) { return [] }
  }
  function text(el, maxLen) {
    try {
      if (!el) return ''
      var t = (el.innerText || el.textContent || '').trim()
      return maxLen && t.length > maxLen ? t.slice(0, maxLen) : t
    } catch (_) { return '' }
  }
  function attr(el, name, fallback) {
    try {
      if (!el) return fallback || ''
      var v = el.getAttribute(name)
      return v == null ? (fallback || '') : v
    } catch (_) { return fallback || '' }
  }
  function html(el, maxLen) {
    try {
      if (!el) return ''
      var h = String(el.innerHTML || '')
      return maxLen && h.length > maxLen ? h.slice(0, maxLen) : h
    } catch (_) { return '' }
  }
  function regexFirst(re, s) {
    try {
      if (!s) return ''
      var m = String(s).match(re)
      return m && m[1] != null ? m[1] : (m ? m[0] : '')
    } catch (_) { return '' }
  }
  function parseNum(s, fallback) {
    try {
      if (s == null || s === '') return fallback == null ? 0 : fallback
      var str = String(s).replace(/[\s,，]/g, '')
      // 中文万/亿 后缀
      var wan  = /万/i.test(str)
      var yi   = /亿/i.test(str)
      var dig  = parseFloat(str)
      if (!isFinite(dig)) return fallback == null ? 0 : fallback
      if (wan) dig *= 1e4
      if (yi)  dig *= 1e8
      return dig
    } catch (_) { return fallback == null ? 0 : fallback }
  }
  function now() { return Date.now() }

  // ───────── E3: NEED_LOGIN 启发式检测 ─────────
  //   命中任一 = 认为需要登录
  // 注意：不能匹配裸的"登录"两字——B站/抖音/快手首页头部永远有"登录"按钮，会误伤全部首页抽取
  var NEED_LOGIN_KEYS = [
    /请先登录/, /需要登录/, /未登录时/, /登录后可/, /登录后查看/, /登录后才能/,
    /登录后可见/, /请登入/, /立即登录/, /扫码登录/,
    /手机号登录/, /微信扫码/, /短信登录/, /验证码登录/, /密码登录/,
  ]
  var NEED_LOGIN_URL = [/\/passport/i, /\/login[\/?#]/i, /sign[-_]?in/i, /channel-login/, /account\/login/i, /oauth/i]
  var NEED_LOGIN_CLASS_ID = [
    /login[-_]?modal/i, /login[-_]?box/i, /login[-_]?wrap/i, /login[-_]?container/i,
    /passport/i, /dy-login/i, /bili[-_]?mini[-_]?login/i, /xhs[-_]?login/i,
    /channels-login/i, /ks-login/i, /geetest/i, // 极验一般是登录配套
  ]
  function detectNeedLogin(extraTextHints) {
    try {
      // 1) URL 命中登录路径
      var url = location.href || ''
      for (var i = 0; i < NEED_LOGIN_URL.length; i++) {
        if (NEED_LOGIN_URL[i].test(url)) return true
      }
      // 2) body 文本 粗略扫描（取 body.innerText 前 3000 字，避免超长文档卡顿）
      var bodyText = ''
      try { bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').slice(0, 4000) } catch (_) {}
      if (extraTextHints) bodyText += '\n' + String(extraTextHints)
      for (var j = 0; j < NEED_LOGIN_KEYS.length; j++) {
        if (NEED_LOGIN_KEYS[j].test(bodyText)) return true
      }
      // 3) 登录容器 class/id 命中
      var nodes = document.querySelectorAll('[class*="login"], [id*="login"], [class*="Login"], [id*="Login"], [class*="passport"], [id*="passport"]')
      if (nodes && nodes.length > 0) {
        for (var k = 0; k < nodes.length; k++) {
          var n = nodes[k]
          if (!n || n.offsetParent === null) continue  // 不可见 → 忽略
          var sig = (n.className || '') + ' ' + (n.id || '')
          for (var m = 0; m < NEED_LOGIN_CLASS_ID.length; m++) {
            if (NEED_LOGIN_CLASS_ID[m].test(sig)) return true
          }
        }
      }
      return false
    } catch (_) { return false }
  }

  // ───────── E3: RISK_CAPTCHA 风控/验证码 检测 ─────────
  var CAPTCHA_KEYS = [
    /验证码/, /验证你的身份/, /行为验证/, /滑块/, /拖动滑块/, /安全验证/,
    /请完成验证/, /人机验证/, /captcha/i, /recaptcha/i, /geetest/i, /拼图验证/,
    /点击对应/, /字符验证/, /防刷/, /风控验证/, /risk.*verif/i,
  ]
  var CAPTCHA_CLASS_ID = [
    /geetest/i, /captcha/i, /recaptcha/i, /verify[-_]?box/i, /verify[-_]?modal/i,
    /slide[-_]?captcha/i, /滑块/i, /puzzle[-_]?captcha/i, /sec[-_]?check/i,
  ]
  function detectRiskCaptcha(extraTextHints) {
    try {
      var bodyText = ''
      try { bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').slice(0, 5000) } catch (_) {}
      if (extraTextHints) bodyText += '\n' + String(extraTextHints)
      for (var i = 0; i < CAPTCHA_KEYS.length; i++) {
        if (CAPTCHA_KEYS[i].test(bodyText)) return true
      }
      var nodes = document.querySelectorAll('[class*="captcha"], [id*="captcha"], [class*="Captcha"], [id*="Captcha"], [class*="geetest"], [id*="geetest"], [class*="verify"]')
      if (nodes && nodes.length > 0) {
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j]
          if (!n || n.offsetParent === null) continue
          var sig = (n.className || '') + ' ' + (n.id || '')
          for (var k = 0; k < CAPTCHA_CLASS_ID.length; k++) {
            if (CAPTCHA_CLASS_ID[k].test(sig)) return true
          }
        }
      }
      return false
    } catch (_) { return false }
  }

  // ───────── source / meta 构造（跨平台统一字段）─────────
  function makeSource(platformId, extra) {
    var s = {
      platformId: String(platformId || ''),
      url: location.href || '',
      pathname: location.pathname || '',
      search: location.search || '',
      title: (document.title || '').trim(),
      referrer: document.referrer || '',
      extractedAt: now(),
      userAgent: navigator.userAgent || '',
      viewport: {
        innerWidth: window.innerWidth | 0,
        innerHeight: window.innerHeight | 0,
        devicePixelRatio: Math.round((window.devicePixelRatio || 1) * 100) / 100,
      },
    }
    if (extra && typeof extra === 'object') {
      var keys = Object.keys(extra)
      for (var i = 0; i < keys.length; i++) s[keys[i]] = extra[keys[i]]
    }
    return s
  }
  function makeMeta(extra) {
    var m = {
      ogTitle:       metaContent('og:title'),
      ogDescription: metaContent('og:description'),
      ogImage:       metaContent('og:image'),
      ogType:        metaContent('og:type'),
      description:   metaContent('description'),
      keywords:      metaContent('keywords'),
      author:        metaContent('author'),
      canonical:     linkHref('canonical'),
      charset:       document.characterSet || document.charset || '',
      lang:          (document.documentElement && document.documentElement.getAttribute('lang')) || '',
    }
    if (extra && typeof extra === 'object') {
      var keys = Object.keys(extra)
      for (var i = 0; i < keys.length; i++) m[keys[i]] = extra[keys[i]]
    }
    return m
  }
  function metaContent(nameOrProp) {
    try {
      var n = nameOrProp
      var el =
        document.querySelector('meta[property="' + n + '"]') ||
        document.querySelector('meta[name="' + n + '"]') ||
        document.querySelector('meta[itemprop="' + n + '"]')
      return el ? (el.getAttribute('content') || '').trim() : ''
    } catch (_) { return '' }
  }
  function linkHref(rel) {
    try {
      var el = document.querySelector('link[rel="' + rel + '"]')
      return el ? (el.getAttribute('href') || '').trim() : ''
    } catch (_) { return '' }
  }

  // ───────── 通用兜底：页面元素摘要（DOM_MISMATCH 时，仍然给用户点东西看）─────────
  function makeFallbackContent(maxLinks, maxImages, maxExcerpts) {
    var links = $$('a[href]').slice(0, (maxLinks || 80)).map(function (a) {
      return {
        text: text(a, 120),
        href: attr(a, 'href'),
        title: attr(a, 'title'),
      }
    }).filter(function (x) { return x.href && x.href.slice(0, 1) !== '#' })

    var images = $$('img[src], img[data-src]').slice(0, (maxImages || 60)).map(function (img) {
      return {
        src: attr(img, 'src') || attr(img, 'data-src') || attr(img, 'data-original'),
        alt: attr(img, 'alt'),
        width: parseInt(img.getAttribute('width') || img.naturalWidth || 0, 10) || 0,
        height: parseInt(img.getAttribute('height') || img.naturalHeight || 0, 10) || 0,
      }
    }).filter(function (x) { return x.src })

    var excerpts = []
    try {
      var bodyT = (document.body && (document.body.innerText || '') || '')
      var lines = bodyT.split(/\n+/).map(function (s) { return s.trim() }).filter(function (s) { return s.length >= 10 })
      excerpts = lines.slice(0, (maxExcerpts || 30))
    } catch (_) {}

    return {
      fallback: true,
      linkCount: links.length,
      imageCount: images.length,
      excerptsCount: excerpts.length,
      links: links,
      images: images,
      excerpts: excerpts,
    }
  }

  // ───────── "解析什么"的场景识别（按 URL pathname + meta og:type → 1 个主场景） ─────────
  // 返回 { kind: 'profile' | 'video' | 'live' | 'product' | 'note' | 'search' | 'article' | 'unknown', urlHints }
  function detectScene(urlHints) {
    var url = urlHints || (location.pathname + (location.search || ''))
    var ogType = (metaContent('og:type') || '').toLowerCase()
    var out = { kind: 'unknown', ogType: ogType, url: url }
    try {
      if (/live|直播|livestream|stream/.test(url) || /video\.live|broadcast|lives/i.test(url)) { out.kind = 'live'; return out }
      if (/product|商品|goods|shop\/item|detail\/item|sku|item\/\d|mall|\/p\//i.test(url) || ogType === 'product') { out.kind = 'product'; return out }
      if (/note|笔记|explore|discovery|post\/\d|feed\/\d/i.test(url)) { out.kind = 'note'; return out }
      if (/video|watch|play|\/v\/|\/bv|\/av|movies?|bangumi|drama|episode/i.test(url) || /video|movie|episode/.test(ogType)) { out.kind = 'video'; return out }
      if (/search|query|s\?|\/q\/|result|搜索/i.test(url)) { out.kind = 'search'; return out }
      if (/user|profile|account|member|u\/\d|homepage|channel|creator|主页|个人/i.test(url) || /profile|user\/page|author/.test(ogType)) { out.kind = 'profile'; return out }
      if (/article|column|read|opus|news|c\d+/i.test(url) || /article|blog post/.test(ogType)) { out.kind = 'article'; return out }
    } catch (_) {}
    return out
  }

  return {
    succ: succ,
    fail: fail,
    $: $,
    $$: $$,
    text: text,
    attr: attr,
    html: html,
    regexFirst: regexFirst,
    parseNum: parseNum,
    now: now,
    detectNeedLogin: detectNeedLogin,
    detectRiskCaptcha: detectRiskCaptcha,
    makeSource: makeSource,
    makeMeta: makeMeta,
    metaContent: metaContent,
    linkHref: linkHref,
    makeFallbackContent: makeFallbackContent,
    detectScene: detectScene,
  }
})()

// 浏览器环境（非 IIFE 内）也能直接拿到工具 → 挂 window
try { window.__TIN_EX_COMMON__ = __TIN_EX_COMMON__ } catch (_) {}

/*
 * 平台抽脚本使用指南（douyin.ts ~ bilibili.ts）：
 *
 *   1) 本文件会被 prepend 到所有平台脚本之前 → 平台脚本可直接用 __TIN_EX_COMMON__
 *   2) 每个平台脚本必须是"立即产出 {ok,data|error}"的结构
 *   3) 固定套路：
 *        var C = window.__TIN_EX_COMMON__ || __TIN_EX_COMMON__
 *        ;(function () {
 *           try {
 *             // ① 先跑 NEED_LOGIN / RISK_CAPTCHA：命中则直接 return fail(...)
 *             if (C.detectNeedLogin()) return C.fail('NEED_LOGIN', '请先登录' + platformName, '扫码/手机号登录后再抽取，部分接口登录才可看')
 *             if (C.detectRiskCaptcha()) return C.fail('RISK_CAPTCHA', platformName + '触发了风控验证', '请在本页手动完成验证码或滑块，稍后重试。若频繁出现，等待 30s 再试')
 *             // ② detectScene 或按 URL 规则判场景
 *             var s = C.detectScene()
 *             // ③ 按场景抽 DOM
 *             var content = {...}
 *             // ④ 任何关键字段为 null / undefined 不能直接 return（走 fallback）
 *             return C.succ({
 *               source: C.makeSource('douyin', {scene: s.kind}),
 *               meta:   C.makeMeta(),
 *               content: content,
 *             })
 *           } catch (e) {
 *             return C.fail('DOM_MISMATCH', platformName + ' DOM 结构已变更: ' + e.message, '等待脚本升级或使用服务端兜底解析')
 *           }
 *        })()
 */
