// ═══════════════════════════════════════════════════════════════
// browserLoginLogic — 平台登录状态判定（纯函数，无 vue/IPC 依赖）
// 对照原客户端（以原代码为准，对齐文档描述有出入处已按原代码口径）：
//   · apps/asset-browser/main.js L1016-1041 `check-login-status`：
//     原版用 **cookie 特征** 判断登录态（session.fromPartition +
//     cookies.get({}) → 每平台 domain+name 匹配），非对齐文档所述
//     「页面特征判断」。新客户端分区为 persist:tintin-<pid>（platform-meta.js），
//     cookie 经既有 browser:cookieList IPC 读取，判定逻辑逐项对齐原版：
//       douyin:      douyin.com + sessionid            （原 L1029）
//       bilibili:    bilibili.com + SESSDATA           （原 L1027）
//       xiaohongshu: xiaohongshu.com + web_session|webId（原 L1028）
//       youtube:     youtube.com + LOGIN_INFO|SID      （原 L1030）
//     新平台（原版无规则，推断特征；误判仅影响徽章展示，不阻塞浏览）：
//       kuaishou:    kuaishou.com + passToken|kuaishou.server.web_st
//       weixin:      weixin.qq.com + sfst|sessionid
//       jimeng:      jimeng.jianying.com + sessionid|sessionid_ss（字节系 SSO 惯例）
//       fxg:         jinritemai.com + sessionid|sessionid_ss（抖店工作台，B12 自动上架载体）
//   · 原版 app.js L1698-1736 renderLoginStatusBadges：每平台徽章
//     （已登录绿/未登录红）；检测失败不阻塞浏览。
// 检测链路（新客户端）：渲染层并行 tintinBrowser.browser.cookieList(pid)
//   → 本模块判定 → 工具栏徽章 + 左栏平台状态点（useBrowserLogin 编排）。
// 说明（D2 搬迁）：本模块为纯函数共享模块，浏览器域（src/browser/）与
//   主应用设置域（useSettingsAccounts / settings-account-logic.test.mjs）
//   共同引用，不依赖任何 window 命名空间。
// ═══════════════════════════════════════════════════════════════

/** 登录态四态：checking=检测中 / unsupported=无规则不判定 */
export type LoginState = 'checking' | 'logged_in' | 'logged_out' | 'unsupported'

/** cookie 最小结构（对齐 browser:cookieList 返回 summarized 项） */
export interface LoginCookieLike {
  name?: string
  domain?: string
}

/** 各平台登录 cookie 特征规则（domain=包含匹配；names=任一全等命中） */
export const LOGIN_COOKIE_RULES: Record<string, Array<{ domain: string; names: string[] }>> = {
  douyin:      [{ domain: 'douyin.com',           names: ['sessionid'] }],
  bilibili:    [{ domain: 'bilibili.com',         names: ['SESSDATA'] }],
  xiaohongshu: [{ domain: 'xiaohongshu.com',      names: ['web_session', 'webId'] }],
  youtube:     [{ domain: 'youtube.com',          names: ['LOGIN_INFO', 'SID'] }],
  // ── 新平台扩展（原版无规则，推断特征；误判仅影响徽章展示，不阻塞浏览）──
  kuaishou:    [{ domain: 'kuaishou.com',         names: ['passToken', 'kuaishou.server.web_st'] }],
  weixin:      [{ domain: 'weixin.qq.com',        names: ['sfst', 'sessionid'] }],
  jimeng:      [{ domain: 'jimeng.jianying.com',  names: ['sessionid', 'sessionid_ss'] }],
  // fxg 抖店工作台（B12 自动上架载体分区 persist:tintin-fxg）：字节系 SSO 惯例
  fxg:         [{ domain: 'jinritemai.com',       names: ['sessionid', 'sessionid_ss'] }],
}

/**
 * 判定平台登录态（对照原 hasCookie：domain 小写包含 + name 包含匹配；
 * 本实现 name 用全等——原版 `c.name.includes(namePart)` 对 SESSDATA/sessionid
 * 等完整名与全等等价，且避免 'sid' 误命中 'sid_tt' 类子串）
 */
export function judgeLoginState(platformId: string, cookies: Array<LoginCookieLike | null | undefined>): LoginState {
  const rules = LOGIN_COOKIE_RULES[platformId]
  if (!rules || rules.length === 0) return 'unsupported'
  if (!Array.isArray(cookies) || cookies.length === 0) return 'logged_out'
  for (const rule of rules) {
    for (const c of cookies) {
      if (!c || typeof c.name !== 'string') continue
      const domain = typeof c.domain === 'string' ? c.domain.toLowerCase() : ''
      if (!domain.includes(rule.domain)) continue
      if (rule.names.includes(c.name)) return 'logged_in'
    }
  }
  return 'logged_out'
}

/** 徽章文案（对照原徽章「已登录/未登录」；checking 为新客户端检测中态） */
export function loginStateText(s: LoginState): string {
  if (s === 'logged_in') return '已登录'
  if (s === 'logged_out') return '未登录'
  if (s === 'checking') return '检测中…'
  return '未检测'
}
