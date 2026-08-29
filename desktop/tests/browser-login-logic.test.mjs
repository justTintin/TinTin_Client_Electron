// ═══════════════════════════════════════════════════════════════
// browser-login-logic.test.mjs — 平台登录状态判定（cookie 特征）单测
// 对照原客户端证据（以原代码为准）：
//   · apps/asset-browser/main.js L1016-1041 `check-login-status`
//     （session.fromPartition + cookies.get({}) → 每平台 cookie
//       domain+name 特征匹配；**原版是 cookie 特征判断，非页面特征**）
//       - bilibili:    bilibili.com + SESSDATA
//       - xiaohongshu: xiaohongshu.com + web_session | webId
//       - douyin:      douyin.com + sessionid
//       - youtube:     youtube.com + LOGIN_INFO | SID
//   · apps/asset-browser/renderer/app.js L1698-1736 renderLoginStatusBadges
//     （每平台徽章：已登录绿 / 未登录红；检测失败不阻塞浏览）
// 运行：node --test "tests/*.test.mjs"
// D2 搬迁：浏览器域代码已收拢至 src/browser/（browserLoginLogic 为纯函数共享模块）
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../renderer/src/browser/composables/browserLoginLogic.ts')

/** 构造 cookie（对齐 browser:cookieList 返回的 { name, domain } 最小结构） */
function ck(name, domain) {
  return { name, domain, path: '/', secure: true, httpOnly: false, session: false }
}

// ── 规则表对齐原版 ──

test('LOGIN_COOKIE_RULES 覆盖原版四平台规则（main.js L1027-1032 逐项对照）', () => {
  assert.deepEqual(R.LOGIN_COOKIE_RULES.douyin, [{ domain: 'douyin.com', names: ['sessionid'] }])
  assert.deepEqual(R.LOGIN_COOKIE_RULES.bilibili, [{ domain: 'bilibili.com', names: ['SESSDATA'] }])
  assert.deepEqual(R.LOGIN_COOKIE_RULES.xiaohongshu, [
    { domain: 'xiaohongshu.com', names: ['web_session', 'webId'] },
  ])
  assert.deepEqual(R.LOGIN_COOKIE_RULES.youtube, [
    { domain: 'youtube.com', names: ['LOGIN_INFO', 'SID'] },
  ])
})

test('新平台扩展规则存在（快手/视频号/即梦/抖店：推断特征，失败不阻塞）', () => {
  for (const p of ['kuaishou', 'weixin', 'jimeng', 'fxg']) {
    assert.ok(Array.isArray(R.LOGIN_COOKIE_RULES[p]) && R.LOGIN_COOKIE_RULES[p].length > 0, p)
  }
})

// ── judgeLoginState：命中语义（域名包含 + name 全等，对照原 hasCookie）──

test('抖音：sessionid + douyin.com 域 → logged_in', () => {
  const s = R.judgeLoginState('douyin', [ck('sessionid', '.douyin.com')])
  assert.equal(s, 'logged_in')
})

test('抖音：同名 cookie 但域名不属于平台（串分区）→ logged_out', () => {
  const s = R.judgeLoginState('douyin', [ck('sessionid', '.bilibili.com')])
  assert.equal(s, 'logged_out')
})

test('B站：SESSDATA 命中（name 全等，大小写敏感对照原 includes 语义）', () => {
  assert.equal(R.judgeLoginState('bilibili', [ck('SESSDATA', '.bilibili.com')]), 'logged_in')
  assert.equal(R.judgeLoginState('bilibili', [ck('sessdata', '.bilibili.com')]), 'logged_out')
})

test('小红书：web_session 或 webId 任一命中（OR 语义）', () => {
  assert.equal(R.judgeLoginState('xiaohongshu', [ck('web_session', '.xiaohongshu.com')]), 'logged_in')
  assert.equal(R.judgeLoginState('xiaohongshu', [ck('webId', '.xiaohongshu.com')]), 'logged_in')
  assert.equal(R.judgeLoginState('xiaohongshu', [ck('other', '.xiaohongshu.com')]), 'logged_out')
})

test('YouTube：LOGIN_INFO | SID 任一命中', () => {
  assert.equal(R.judgeLoginState('youtube', [ck('SID', '.youtube.com')]), 'logged_in')
  assert.equal(R.judgeLoginState('youtube', [ck('LOGIN_INFO', '.youtube.com')]), 'logged_in')
})

// ── 边界：空 cookie / 无规则平台 / 脏数据 ──

test('空 cookie 列表 → logged_out（从未登录过分区）', () => {
  assert.equal(R.judgeLoginState('douyin', []), 'logged_out')
})

test('无规则平台（web）→ unsupported（不展示误判徽章）', () => {
  assert.equal(R.judgeLoginState('web', [ck('anything', '.example.com')]), 'unsupported')
})

// ── fxg 抖店工作台（B12 自动上架载体分区 persist:tintin-fxg）──

test('抖店：sessionid + jinritemai.com 域 → logged_in（字节系 SSO 惯例）', () => {
  assert.equal(R.judgeLoginState('fxg', [ck('sessionid', '.jinritemai.com')]), 'logged_in')
  assert.equal(R.judgeLoginState('fxg', [ck('sessionid_ss', '.jinritemai.com')]), 'logged_in')
})

test('抖店：同名 cookie 但域不属 jinritemai.com → logged_out（串分区防御）', () => {
  assert.equal(R.judgeLoginState('fxg', [ck('sessionid', '.jimeng.jianying.com')]), 'logged_out')
})

test('脏数据：cookies 含 null / 缺域名条目不抛异常', () => {
  const s = R.judgeLoginState('douyin', [null, { name: 'sessionid' }, ck('sessionid', '.douyin.com')])
  assert.equal(s, 'logged_in')
})

// ── loginStateText：徽章文案（对照原徽章「已登录/未登录」+ 检测中态）──

test('loginStateText 四态文案', () => {
  assert.equal(R.loginStateText('logged_in'), '已登录')
  assert.equal(R.loginStateText('logged_out'), '未登录')
  assert.equal(R.loginStateText('checking'), '检测中…')
  assert.equal(R.loginStateText('unsupported'), '未检测')
})
