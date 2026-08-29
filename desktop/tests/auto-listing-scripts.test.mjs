// ═══════════════════════════════════════════════════════════════
// auto-listing-scripts.test.mjs — B12 自动上架：注入脚本纯函数单测
// 对位：原 engine.py 内嵌 JS 中的可抽纯函数：
//   normalizeText（价格表 norm L564-569）、labelGeometryScore
//   （_fill_text_by_label 几何评分 L370-377）、saveDraftPollScript 错误集
//   （L655-662）。脚本本体为自包含 IIFE 字符串（executeJavaScript 注入）。
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, INLINE_VISIBLE, clearMarkScript, uploadingCheckScript, pressEnterScript, setInputValueScript } from '../main/auto-listing/scripts/common.js'
import { clickTextScript } from '../main/auto-listing/scripts/click-text.js'
import { markMainUploadScript } from '../main/auto-listing/scripts/main-upload.js'
import { markTitleScript } from '../main/auto-listing/scripts/title.js'
import { labelGeometryScore, markLabelInputScript } from '../main/auto-listing/scripts/label-input.js'
import { markDetailUploadScript, detailInputMultipleScript } from '../main/auto-listing/scripts/detail-upload.js'
import { markSkuUploadScript } from '../main/auto-listing/scripts/sku-upload.js'
import { markPriceRowScript, clearPriceMarksScript } from '../main/auto-listing/scripts/price-table.js'
import { saveDraftPollScript, ERROR_TEXTS, SUCCESS_TEXTS } from '../main/auto-listing/scripts/save-draft.js'
import { loginCheckScript, shopCheckScript, createPageCheckScript } from '../main/auto-listing/scripts/detect.js'
import { specInputCountScript, setSpecNameScript } from '../main/auto-listing/scripts/spec.js'

// ── normalizeText（对位原价格表 norm）──
test('normalizeText 去空白 + 全角括号/破折号转半角', () => {
  assert.equal(normalizeText('  A款（红色）－B '), 'A款(红色)-B')
  assert.equal(normalizeText('X—Y'), 'X-Y')
  assert.equal(normalizeText(''), '')
  assert.equal(normalizeText(null), '')
  assert.equal(normalizeText(123), '123')
})

// ── labelGeometryScore（对位原 dy*10+dx 最小分）──
test('labelGeometryScore 命中区间内返回 dy*10+dx，越界返回 null', () => {
  assert.equal(labelGeometryScore({ bottom: 100, left: 10 }, { top: 110, left: 15 }), 105)
  assert.equal(labelGeometryScore({ bottom: 100, left: 10 }, { top: 99, left: 15 }), -5) // dy=-1 ∈[-20,280] 合法
  assert.equal(labelGeometryScore({ bottom: 100, left: 10 }, { top: 79, left: 15 }), null)  // dy=-21 < -20 → null
  assert.equal(labelGeometryScore({ bottom: 100, left: 10 }, { top: 381, left: 15 }), null) // dy=281 > 280 → null
  assert.equal(labelGeometryScore({ bottom: 100, left: 10 }, { top: 110, left: 531 }), null) // dx=521 > 520 → null
  assert.equal(labelGeometryScore({ bottom: 100, left: 10 }, { top: 110, left: 10 }), 100)
})

// ── 注入脚本：自包含 IIFE + 关键逻辑片段（对位原内嵌 JS）──
test('clickTextScript 含可见性过滤 + 文本匹配 + ≤60 字符 + scrollIntoView', () => {
  const s = clickTextScript('下一步', false)
  assert.ok(s.includes('span,div,label,a,button,[role="button"]'))
  assert.ok(s.includes('"下一步"'))
  assert.ok(s.includes('t.length > 60'))
  assert.ok(s.includes('scrollIntoView'))
  assert.ok(s.includes('el.click()'))
  assert.ok(s.includes('exact ? t === text : t.includes(text)'))
})

test('clickTextScript exact=true 用全等匹配', () => {
  const s = clickTextScript('下架', true)
  assert.ok(s.includes('const exact = true'))
})

test('markMainUploadScript 冒泡 8 层 + 主图/详情图判定 + data-als-main 标记', () => {
  const s = markMainUploadScript()
  assert.ok(s.includes('input[type="file"]'))
  assert.ok(s.includes('i < 8'))
  assert.ok(s.includes('主图上传') && s.includes('上传主图'))
  assert.ok(s.includes('商品详情') && s.includes('详情图'))
  assert.ok(s.includes('data-als-main'))
})

test('markTitleScript 三级 placeholder + label 冒泡 6 层', () => {
  const s = markTitleScript()
  assert.ok(s.includes('请输入2-60') && s.includes('商品标题') && s.includes('input[placeholder*="标题"]'))
  assert.ok(s.includes('i < 6'))
  assert.ok(s.includes('data-als-title'))
})

test('markLabelInputScript 精确 label + 几何评分边界 + marker 标记', () => {
  const s = markLabelInputScript('品牌', 'als-abc')
  assert.ok(s.includes('"品牌"'))
  assert.ok(s.includes('dy < -20 || dy > 280'))
  assert.ok(s.includes('dx > 520'))
  assert.ok(s.includes('data-als-label-input'))
  assert.ok(s.includes('als-abc'))
})

test('markDetailUploadScript 类名 + 冒泡 20 层兜底', () => {
  const s = markDetailUploadScript()
  assert.ok(s.includes('decorateImgEditTitle'))
  assert.ok(s.includes('Wrapper'))
  assert.ok(s.includes('i < 20'))
  assert.ok(s.includes('data-als-detail'))
})

test('detailInputMultipleScript 读 multiple 属性', () => {
  const s = detailInputMultipleScript()
  assert.ok(s.includes('data-als-detail'))
  assert.ok(s.includes('multiple'))
})

test('markSkuUploadScript 按 input.value 匹配规格名 + 冒泡 8 层找 file input', () => {
  const s = markSkuUploadScript('A款')
  assert.ok(s.includes('"A款"'))
  assert.ok(s.includes('(el.value || \'\').trim() === val'))
  assert.ok(s.includes('i < 8'))
  assert.ok(s.includes('.ant-upload input[type="file"]'))
  assert.ok(s.includes('data-als-sku-upload'))
})

test('markPriceRowScript 首 td 归一化匹配 + price/inv/code 三标记', () => {
  const s = markPriceRowScript('A款')
  assert.ok(s.includes('first.includes(target)'))
  assert.ok(s.includes('data-als-price') && s.includes('data-als-inv') && s.includes('data-als-code'))
  assert.ok(s.includes('inp.placeholder'))
  assert.ok(s.includes('编码'))
})

test('saveDraftPollScript 错误集/成功集与 ERROR_TEXTS 一致（PRD 14.5）', () => {
  const s = saveDraftPollScript()
  for (const e of ERROR_TEXTS) assert.ok(s.includes(e), '错误集应含：' + e)
  for (const e of SUCCESS_TEXTS) assert.ok(s.includes(e), '成功集应含：' + e)
  assert.ok(s.includes('.ant-form-item-explain-error'))
  assert.deepEqual(ERROR_TEXTS, ['必填', '不能为空', '保存失败', '请输入', '请上传', '校验不通过'])
  assert.deepEqual(SUCCESS_TEXTS, ['保存成功', '草稿保存成功'])
})

// ── 检测脚本（对位原 _check_login / _check_shop / _open_create_page 判定）──
test('loginCheckScript URL login/passport + 扫码登录判定', () => {
  const s = loginCheckScript()
  assert.ok(s.includes("'login'") && s.includes("'passport'"))
  assert.ok(s.includes('扫码登录') && s.includes('商品'))
})

test('shopCheckScript 目标店铺命中即跳过其它店铺告警', () => {
  const s = shopCheckScript({ targetNames: ['桔柚数码外设严选', '桔柚'], otherNames: ['555井韵电池店铺'] })
  assert.ok(s.includes('"桔柚"'))
  assert.ok(s.includes('"555井韵电池店铺"'))
  assert.ok(s.includes("text.includes(other) && !hasTarget"))
})

test('createPageCheckScript 创建商品/商品创建/主图上传判定', () => {
  const s = createPageCheckScript()
  assert.ok(s.includes('创建商品') && s.includes('商品创建') && s.includes('主图上传'))
})

test('specInputCountScript / setSpecNameScript 规格输入框定位', () => {
  const s1 = specInputCountScript()
  assert.ok(s1.includes('请输入型号'))
  const s2 = setSpecNameScript('型号A')
  assert.ok(s2.includes('"型号A"'))
  assert.ok(s2.includes('dispatchEvent(new Event(\'input\''))
})

// ── 公共脚本（对位原清标记 / 上传中等待 / Enter / 原生 setter）──
test('clearMarkScript 移除指定 data-als-* 标记', () => {
  const s = clearMarkScript('data-als-main')
  assert.ok(s.includes('[data-als-main]'))
  assert.ok(s.includes("removeAttribute('data-als-main')"))
})

test('uploadingCheckScript 检测「上传中」文本（对位 _wait_upload_done）', () => {
  const s = uploadingCheckScript()
  assert.ok(s.includes('上传中'))
})

test('pressEnterScript / setInputValueScript 键盘事件与原生 setter', () => {
  const s1 = pressEnterScript()
  assert.ok(s1.includes('Enter'))
  const s2 = setInputValueScript('input[data-als-title="1"]', '标题X')
  assert.ok(s2.includes('data-als-title'))
  assert.ok(s2.includes('"标题X"'))
  assert.ok(s2.includes('HTMLInputElement.prototype'))
})

test('INLINE_VISIBLE 片段含可见性过滤核心', () => {
  assert.ok(INLINE_VISIBLE.includes('getComputedStyle'))
  assert.ok(INLINE_VISIBLE.includes('getBoundingClientRect'))
})

// ── 反序列化安全：脚本参数 JSON 内联（含引号文本不破坏脚本）──
test('clickTextScript 文本含引号 → JSON.stringify 内联安全', () => {
  const s = clickTextScript('他说"保存"成功', false)
  assert.ok(s.includes('\\"保存\\"'))
})
