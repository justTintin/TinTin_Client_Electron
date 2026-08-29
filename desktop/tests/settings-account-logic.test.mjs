// ═══════════════════════════════════════════════════════════════
// settings-account-logic.test.mjs — 账号与登录（飞书/即梦）编组单测
// 对照原客户端证据（以原代码为准）：
//   · studio/gui/main_window_aiconfig.py L537-583 load/save_feishu_config：
//     字段 AppId/AppSecret/AppToken/TableId/TopicField(默认"选题")/
//     ScriptField(默认"脚本")/FolderToken → ini [Feishu]
//     （新客户端存储键 feishu.* 对齐原字段语义）
//   · L584-600 _test_feishu：POST open.feishu.cn /auth/v3/tenant_access_token/internal
//     {app_id, app_secret}；成功=HTTP 200 且响应含 tenant_access_token；
//     参数缺失拦截「请填入 App ID 和 Secret」
//   · 即梦（L481-536）：原版走 dreamina CLI 设备码 OAuth（Windows 专属），
//     新客户端无 Python/CLI → 口径替换为内置浏览器分区 + cookie 登录态检测
//     （browserLoginLogic.judgeLoginState，复用条目⑧链路）
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const R = await import('../renderer/src/composables/settingsAccountLogic.ts')

// ── 飞书字段元数据（对齐原 load/save_feishu_config 字段与默认值）──

test('FEISHU_FIELDS 七字段 + 默认值对齐原版（TopicField=选题 / ScriptField=脚本）', () => {
  assert.equal(R.FEISHU_FIELDS.length, 7)
  const byKey = Object.fromEntries(R.FEISHU_FIELDS.map((f) => [f.key, f]))
  assert.equal(byKey.appId.storeKey, 'feishu.appId')
  assert.equal(byKey.appSecret.storeKey, 'feishu.appSecret')
  assert.ok(byKey.appSecret.secret, 'AppSecret 必须标记 secret（脱敏展示）')
  assert.equal(byKey.topicField.def, '选题')
  assert.equal(byKey.scriptField.def, '脚本')
  assert.equal(byKey.folderToken.storeKey, 'feishu.folderToken')
})

// ── 脱敏：保存后只显示尾 4 位 ──

test('maskSecret：空值不脱敏（可区分未保存），常规值掩码保留尾 4 位', () => {
  assert.equal(R.maskSecret(''), '')
  assert.equal(R.maskSecret('abcd'), '••••')
  assert.equal(R.maskSecret('abc12345'), '••••12345'.slice(0, 4) + '2345')
  assert.equal(R.maskSecret('abc12345'), '••••2345')
})

// ── 测试连接：参数校验拦截（对照原 L589-591）──

test('validateFeishuConn：缺 AppId/Secret 拦截，消息对齐原版文案语义', () => {
  assert.equal(R.validateFeishuConn('', 's'), '请填入 App ID 和 Secret')
  assert.equal(R.validateFeishuConn('cli_x', ''), '请填入 App ID 和 Secret')
  assert.equal(R.validateFeishuConn('', ''), '请填入 App ID 和 Secret')
  assert.equal(R.validateFeishuConn('cli_x', 's'), '')
})

// ── 测试连接：响应判定（对照原 L595-598：200 + tenant_access_token）──

test('parseFeishuTestResult：200+token=成功；200 无 token / 5xx / 网络异常=失败', () => {
  assert.deepEqual(
    R.parseFeishuTestResult({ status: 200, json: { tenant_access_token: 't-xxx', code: 0 } }),
    { ok: true, message: '完成： 连接成功' },
  )
  assert.equal(R.parseFeishuTestResult({ status: 200, json: { code: 99991663, msg: 'invalid app_id' } }).ok, false)
  assert.equal(R.parseFeishuTestResult({ status: 400, json: {} }).ok, false)
  assert.equal(R.parseFeishuTestResult(null).ok, false)
  assert.equal(R.parseFeishuTestResult(undefined).ok, false)
})

test('parseFeishuTestResult：5xx 带消息透出（异常分支：HTTP 5xx）', () => {
  const r = R.parseFeishuTestResult({ status: 502, json: { msg: 'bad gateway' } })
  assert.equal(r.ok, false)
  assert.match(r.message, /502/)
})

// ── 主进程连接测试核（feishu-ipc.js）：注入 fake post，四类异常分支 ──

async function loadFeishuIpc() {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  return require('../main/feishu-ipc.js')
}

test('feishu-ipc testFeishuConnection：成功/缺参/HTTP 非 200/网络异常 四分支', async () => {
  const { testFeishuConnection } = await loadFeishuIpc()
  // 成功
  const ok = await testFeishuConnection(
    async () => ({ status: 200, json: { tenant_access_token: 't' } }), 'cli_x', 'sec')
  assert.equal(ok.ok, true)
  // 缺参拦截（不发起请求）
  const miss = await testFeishuConnection(
    async () => { throw new Error('should not be called') }, '', 'sec')
  assert.equal(miss.ok, false)
  assert.match(miss.message, /App ID/)
  // HTTP 非 200
  const http403 = await testFeishuConnection(
    async () => ({ status: 403, json: {} }), 'cli_x', 'sec')
  assert.equal(http403.ok, false)
  assert.match(http403.message, /403/)
  // 网络异常（DNS/超时）
  const net = await testFeishuConnection(
    async () => { throw new Error('getaddrinfo ENOTFOUND') }, 'cli_x', 'sec')
  assert.equal(net.ok, false)
  assert.match(net.message, /ENOTFOUND/)
})

test('feishu-ipc testFeishuConnection：useStoredSecret 时从存储读取（凭据不明文回显）', async () => {
  const { testFeishuConnection } = await loadFeishuIpc()
  let captured = null
  const ok = await testFeishuConnection(
    async (_url, body) => {
      captured = body
      return { status: 200, json: { tenant_access_token: 't' } }
    },
    'cli_x', '', // 渲染层输入为空
    () => 'stored-secret', // getCfg('feishu.appSecret')
  )
  assert.equal(ok.ok, true)
  assert.equal(captured.app_secret, 'stored-secret')
})

// ── 即梦登录态判定复用条目⑧（回归：jimeng 规则命中）──

test('即梦登录态：jimeng sessionid cookie → logged_in（复用 browserLoginLogic）', async () => {
  const BL = await import('../renderer/src/browser/composables/browserLoginLogic.ts')
  assert.equal(
    BL.judgeLoginState('jimeng', [{ name: 'sessionid', domain: '.jimeng.jianying.com' }]),
    'logged_in',
  )
})
