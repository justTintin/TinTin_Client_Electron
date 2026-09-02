// ══════════════════════════════════════════════════════════════
// vision-logic.test.mjs — 视觉模型研判共用纯函数单测
// 被测：renderer/src/composables/visionLogic.ts
// 对照原客户端：
//   · utils/llm_output_utils.safe_json_parse（三格式容错）
//   · hook_score_page.py / marketing_detect_page.py 共用的
//     base64 → data:image/jpeg 拼接、title 取法、模型状态卡文案
// 运行：cd desktop && node --test "tests/*.test.mjs"
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const V = await import('../renderer/src/composables/visionLogic.ts')

/** 造帧（base64 只需非空即可参与拼接） */
function frame(timeSec, base64 = 'QUJD') {
  return { path: `/tmp/f_${timeSec}.jpg`, timeSec, base64 }
}

// ── jpegDataUrl ────────────────────────────────────────────────

test('jpegDataUrl：拼 data:image/jpeg;base64 前缀（对照 f-string）', () => {
  assert.equal(V.jpegDataUrl('QUJD'), 'data:image/jpeg;base64,QUJD')
})

test('jpegDataUrl：空/undefined 不抛异常', () => {
  assert.equal(V.jpegDataUrl(''), 'data:image/jpeg;base64,')
  assert.equal(V.jpegDataUrl(undefined), 'data:image/jpeg;base64,')
})

// ── videoTitleOf / videoBaseName ───────────────────────────────

test('videoTitleOf：splitext(basename(path)) 口径，兼容 \\ 与 /', () => {
  assert.equal(V.videoTitleOf('D:\\videos\\我的作品.mp4'), '我的作品')
  assert.equal(V.videoTitleOf('/home/u/clip.final.mov'), 'clip.final')
  assert.equal(V.videoTitleOf('noext'), 'noext')
  assert.equal(V.videoTitleOf(''), '')
  assert.equal(V.videoTitleOf(undefined), '')
})

test('videoBaseName：保留扩展名（对照 os.path.basename）', () => {
  assert.equal(V.videoBaseName('D:\\videos\\a.mp4'), 'a.mp4')
  assert.equal(V.videoBaseName('/x/y/b.mkv'), 'b.mkv')
  assert.equal(V.videoBaseName(''), '')
})

// ── buildVisionContent ─────────────────────────────────────────

test('buildVisionContent：首段为文本引导句，其后逐帧 image_url', () => {
  const c = V.buildVisionContent('引导句', [frame(0.5), frame(1.5)])
  assert.equal(c.length, 3)
  assert.deepEqual(c[0], { type: 'text', text: '引导句' })
  assert.equal(c[1].type, 'image_url')
  assert.equal(c[1].image_url.url, 'data:image/jpeg;base64,QUJD')
  assert.equal(c[2].type, 'image_url')
})

test('buildVisionContent：无 base64 的帧被跳过（不产生空图片段）', () => {
  const c = V.buildVisionContent('L', [frame(0.5, ''), frame(1.5), null])
  assert.equal(c.length, 2, '只保留 1 帧有效图片')
  assert.equal(c[1].type, 'image_url')
})

test('buildVisionContent：空帧列表 → 仅文本段', () => {
  const c = V.buildVisionContent('L', [])
  assert.equal(c.length, 1)
  assert.equal(c[0].type, 'text')
})

// ── pickLlmText ────────────────────────────────────────────────

test('pickLlmText：取 choices[0].message.content 并 trim', () => {
  assert.equal(V.pickLlmText({ choices: [{ message: { content: '  hi  ' } }] }), 'hi')
})

test('pickLlmText：结构缺失一律返回空串（防御解析）', () => {
  assert.equal(V.pickLlmText(null), '')
  assert.equal(V.pickLlmText(undefined), '')
  assert.equal(V.pickLlmText({}), '')
  assert.equal(V.pickLlmText({ choices: [] }), '')
  assert.equal(V.pickLlmText({ choices: [{}] }), '')
  assert.equal(V.pickLlmText({ choices: [{ message: {} }] }), '')
})

// ── throwIfIpcError ────────────────────────────────────────────

test('throwIfIpcError：null/undefined（服务端离线）→ 抛兜底文案', () => {
  assert.throws(() => V.throwIfIpcError(null, '离线'), /离线/)
  assert.throws(() => V.throwIfIpcError(undefined, '离线'), /离线/)
})

test('throwIfIpcError：{error} → 抛 error 内容', () => {
  assert.throws(() => V.throwIfIpcError({ error: '抽帧失败' }, '兜底'), /抽帧失败/)
})

test('throwIfIpcError：正常返回体不抛', () => {
  assert.doesNotThrow(() => V.throwIfIpcError({ frames: [] }, '兜底'))
  assert.doesNotThrow(() => V.throwIfIpcError({ choices: [] }, '兜底'))
})

// ── probeDurationSec ───────────────────────────────────────────

test('probeDurationSec：数字/数字串均取值（对照 _probe_duration or 10.0）', () => {
  assert.equal(V.probeDurationSec({ duration: 12.5 }), 12.5)
  assert.equal(V.probeDurationSec({ duration: '12.5' }), 12.5)
})

test('probeDurationSec：非法/缺失/非正 → 兜底 10.0', () => {
  assert.equal(V.probeDurationSec(null), 10.0)
  assert.equal(V.probeDurationSec({}), 10.0)
  assert.equal(V.probeDurationSec({ duration: 0 }), 10.0)
  assert.equal(V.probeDurationSec({ duration: -3 }), 10.0)
  assert.equal(V.probeDurationSec({ duration: 'abc' }), 10.0)
})

test('probeDurationSec：可自定义兜底值', () => {
  assert.equal(V.probeDurationSec({}, 5), 5)
})

// ── safeJsonParse ──────────────────────────────────────────────

test('safeJsonParse：纯 JSON 直接解析', () => {
  assert.deepEqual(V.safeJsonParse('{"a":1}'), { a: 1 })
  assert.deepEqual(V.safeJsonParse('  {"a":1}  '), { a: 1 })
})

test('safeJsonParse：markdown ```json 代码块', () => {
  assert.deepEqual(V.safeJsonParse('```json\n{"a":1}\n```'), { a: 1 })
})

test('safeJsonParse：markdown 无语言标记代码块', () => {
  assert.deepEqual(V.safeJsonParse('```\n{"a":2}\n```'), { a: 2 })
})

test('safeJsonParse：前后带解释文本 → 截首个 { 到末个 }', () => {
  const txt = '好的，结果如下：{"total":88,"dims":{"节奏":70}} 希望有帮助。'
  assert.deepEqual(V.safeJsonParse(txt), { total: 88, dims: { 节奏: 70 } })
})

test('safeJsonParse：数组/标量不算对象 → null', () => {
  assert.equal(V.safeJsonParse('[1,2,3]'), null)
  assert.equal(V.safeJsonParse('"str"'), null)
  assert.equal(V.safeJsonParse('123'), null)
})

test('safeJsonParse：空串/非字符串/坏 JSON → null', () => {
  assert.equal(V.safeJsonParse(''), null)
  assert.equal(V.safeJsonParse(null), null)
  assert.equal(V.safeJsonParse(undefined), null)
  assert.equal(V.safeJsonParse('不是 JSON'), null)
  assert.equal(V.safeJsonParse('{坏掉的'), null)
})

// ── toStringList ───────────────────────────────────────────────

test('toStringList：数组只保留字符串项（对照 isinstance(x, list)）', () => {
  assert.deepEqual(V.toStringList(['a', 'b']), ['a', 'b'])
  assert.deepEqual(V.toStringList(['a', 1, null, 'b']), ['a', 'b'])
})

test('toStringList：单字符串退化为单元素；空白/其它 → []', () => {
  assert.deepEqual(V.toStringList('建议1'), ['建议1'])
  assert.deepEqual(V.toStringList('  建议1  '), ['建议1'])
  assert.deepEqual(V.toStringList('   '), [])
  assert.deepEqual(V.toStringList(null), [])
  assert.deepEqual(V.toStringList(undefined), [])
  assert.deepEqual(V.toStringList(42), [])
})

// ── clampScore ─────────────────────────────────────────────────

test('clampScore：0-100 夹紧 + 四舍五入取整', () => {
  assert.equal(V.clampScore(88), 88)
  assert.equal(V.clampScore(88.4), 88)
  assert.equal(V.clampScore(88.6), 89)
  assert.equal(V.clampScore(150), 100)
  assert.equal(V.clampScore(-20), 0)
})

test('clampScore：数字串可解析；非法 → 0', () => {
  assert.equal(V.clampScore('77'), 77)
  assert.equal(V.clampScore('abc'), 0)
  assert.equal(V.clampScore(null), 0)
  assert.equal(V.clampScore(undefined), 0)
})

// ── 视觉模型状态卡 ──────────────────────────────────────────────

test('visionModelStatusText：六态文案（对照 lbl_model_status 分支）', () => {
  assert.equal(V.visionModelStatusText('configured'), '已配置')
  assert.equal(V.visionModelStatusText('unconfigured'), '未配置')
  assert.equal(V.visionModelStatusText('testing'), '正在测试…')
  assert.equal(V.visionModelStatusText('ok'), '连接成功')
  assert.equal(V.visionModelStatusText('fail'), '无法连接')
  assert.equal(V.visionModelStatusText('unknown'), '未检测')
})

test('visionModelStatusColor：绿/红/黄/灰四色（对照 setStyleSheet）', () => {
  assert.equal(V.visionModelStatusColor('ok'), '#2ecc71')
  assert.equal(V.visionModelStatusColor('configured'), '#2ecc71')
  assert.equal(V.visionModelStatusColor('fail'), '#e74c3c')
  assert.equal(V.visionModelStatusColor('unconfigured'), '#e74c3c')
  assert.equal(V.visionModelStatusColor('testing'), '#f1c40f')
  assert.equal(V.visionModelStatusColor('unknown'), '#a0aec0')
})

test('visionModelInfoText：有/无服务端地址两分支', () => {
  assert.equal(V.visionModelInfoText(true), '视频大模型：由服务端选择')
  assert.equal(V.visionModelInfoText(false), '视频大模型：未配置服务端地址')
})
