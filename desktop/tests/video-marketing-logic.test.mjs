// ══════════════════════════════════════════════════════════════
// video-marketing-logic.test.mjs — 视频营销检测纯函数单测
// 被测：renderer/src/composables/videoMarketingLogic.ts
// 对照原客户端 studio/gui/marketing_detect_page.py：
//   · _sample_times（全片均匀抽 5~10 帧；分支顺序 dur<=0 → n → dur<=2.0 → 均匀）
//   · MarketingDetectWorker.do_work（sys_prompt / content 拼接 / temperature=0.3）
//   · _render（结论文案与配色、置信度、推广分类、涉及品牌商品）
// 运行：cd desktop && node --test "tests/*.test.mjs"
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../renderer/src/composables/videoMarketingLogic.ts')

/** 造帧 */
function frame(timeSec, base64 = 'QUJD') {
  return { path: `/tmp/m_${timeSec}.jpg`, timeSec, base64 }
}

// ── 常量 ────────────────────────────────────────────────────────

test('MARKETING_CATEGORIES：6 类且与 sys_prompt 取值集合一致', () => {
  assert.deepEqual([...M.MARKETING_CATEGORIES], [
    '直销带货', '品牌广告', '软广植入', '知识付费/教育推广', '非营销/纯内容', '其他（请注明）',
  ])
})

// ── marketingSampleTimes（对照 _sample_times）───────────────────

test('marketingSampleTimes：dur<=0 / 非法 → [0.5]', () => {
  assert.deepEqual(M.marketingSampleTimes(0), [0.5])
  assert.deepEqual(M.marketingSampleTimes(-3), [0.5])
  assert.deepEqual(M.marketingSampleTimes(NaN), [0.5])
  assert.deepEqual(M.marketingSampleTimes(Infinity), [0.5])
  assert.deepEqual(M.marketingSampleTimes(undefined), [0.5])
})

test('marketingSampleTimes：dur<=2.0 → 单帧取中点 dur/2（n 已算但不使用）', () => {
  assert.deepEqual(M.marketingSampleTimes(2.0), [1])
  assert.deepEqual(M.marketingSampleTimes(1.0), [0.5])
  const short = M.marketingSampleTimes(0.4)
  assert.equal(short.length, 1)
  assert.ok(Math.abs(short[0] - 0.2) < 1e-9)
})

test('marketingSampleTimes：短视频取下限 5 帧（对照 max(5, int(dur/3.0))）', () => {
  assert.deepEqual(M.marketingSampleTimes(2.5), [0.3, 0.8, 1.3, 1.8, 2.3])
  assert.deepEqual(M.marketingSampleTimes(9), [0.9, 2.7, 4.5, 6.3, 8.1])
  assert.deepEqual(M.marketingSampleTimes(15), [1.5, 4.5, 7.5, 10.5, 13.5])
})

test('marketingSampleTimes：int(dur/3.0) 生效 → 帧数随时长增长', () => {
  assert.deepEqual(M.marketingSampleTimes(24), [1.5, 4.5, 7.5, 10.5, 13.5, 16.5, 19.5, 22.5])
  assert.equal(M.marketingSampleTimes(24).length, 8)
})

test('marketingSampleTimes：长视频取上限 10 帧（对照 min(10, …)）', () => {
  const t100 = M.marketingSampleTimes(100)
  assert.equal(t100.length, 10)
  assert.deepEqual(t100, [5, 15, 25, 35, 45, 55, 65, 75, 85, 95])

  assert.equal(M.marketingSampleTimes(30).length, 10)
  assert.equal(M.marketingSampleTimes(600).length, 10)
})

test('marketingSampleTimes：帧点覆盖全片、递增、严格落在 (0, dur) 内', () => {
  for (const dur of [2.1, 3, 5, 12, 33, 77, 250]) {
    const t = M.marketingSampleTimes(dur)
    assert.ok(t.length >= 5 && t.length <= 10, `dur=${dur} 帧数越界：${t.length}`)
    for (const x of t) {
      assert.ok(x > 0 && x < dur, `dur=${dur} 帧点 ${x} 越界`)
    }
    for (let i = 1; i < t.length; i++) {
      assert.ok(t[i] > t[i - 1], `dur=${dur} 帧点必须严格递增`)
    }
    // 全片覆盖：末帧应落在后半段
    assert.ok(t[t.length - 1] > dur / 2, `dur=${dur} 末帧未覆盖后半段`)
  }
})

test('marketingSampleTimes：全部保留一位小数（对照 round(…, 1)）', () => {
  for (const dur of [2.5, 7, 11, 23, 45, 99]) {
    for (const x of M.marketingSampleTimes(dur)) {
      assert.ok(Math.abs(x * 10 - Math.round(x * 10)) < 1e-9, `${x} 非一位小数`)
    }
  }
})

// ── buildMarketingPrompt / content ─────────────────────────────

test('buildMarketingPrompt：含角色设定、任务、严格 JSON 约束与全部字段', () => {
  const p = M.buildMarketingPrompt()
  assert.ok(p.includes('营销内容审查专家'))
  assert.ok(p.includes('营销/广告宣传/带货/商业推广/引流'))
  assert.ok(p.includes('严格只输出符合以下格式的 JSON'))
  assert.ok(p.includes('json.loads()'))
  for (const k of ['is_marketing', 'confidence', 'category', 'product_or_brand', 'clues', 'analysis', 'suggestions']) {
    assert.ok(p.includes(`"${k}"`), `prompt 缺字段 ${k}`)
  }
})

test('buildMarketingPrompt：category 枚举逐项写入 prompt', () => {
  const p = M.buildMarketingPrompt()
  for (const c of M.MARKETING_CATEGORIES) assert.ok(p.includes(c), `prompt 缺分类 ${c}`)
})

test('buildMarketingLeadText：对照 f"视频名称：{title}。以下为按时间先后抽取的关键帧："', () => {
  assert.equal(
    M.buildMarketingLeadText('测评视频'),
    '视频名称：测评视频。以下为按时间先后抽取的关键帧：'
  )
})

test('buildMarketingContent：文本引导句 + 逐帧 image_url，空 base64 帧被跳过', () => {
  const c = M.buildMarketingContent('T', [frame(0.5), frame(1.5, ''), frame(2.5)])
  assert.equal(c.length, 3)
  assert.equal(c[0].type, 'text')
  assert.ok(c[0].text.includes('T'))
  assert.equal(c[1].image_url.url, 'data:image/jpeg;base64,QUJD')
  assert.equal(c[2].type, 'image_url')
})

// ── parseMarketingResponse ─────────────────────────────────────

const GOOD = JSON.stringify({
  is_marketing: true,
  confidence: 88,
  category: '直销带货',
  product_or_brand: '某护肤品牌',
  clues: ['画面出现价格标签', '口播引导下单'],
  analysis: '全程围绕商品卖点展开。',
  suggestions: ['补充使用场景', '标注广告标识'],
})

test('parseMarketingResponse：完整 JSON → 原样归一', () => {
  const r = M.parseMarketingResponse(GOOD)
  assert.equal(r.is_marketing, true)
  assert.equal(r.confidence, 88)
  assert.equal(r.category, '直销带货')
  assert.equal(r.product_or_brand, '某护肤品牌')
  assert.deepEqual(r.clues, ['画面出现价格标签', '口播引导下单'])
  assert.equal(r.analysis, '全程围绕商品卖点展开。')
  assert.deepEqual(r.suggestions, ['补充使用场景', '标注广告标识'])
})

test('parseMarketingResponse：markdown 代码块 / 带前后缀文本均可解析', () => {
  assert.equal(M.parseMarketingResponse('```json\n' + GOOD + '\n```').confidence, 88)
  assert.equal(M.parseMarketingResponse('结论：' + GOOD + ' 完毕').confidence, 88)
})

test('parseMarketingResponse：is_marketing 缺失 → 按 confidence>=50 兜底判定', () => {
  assert.equal(M.parseMarketingResponse('{"confidence":80}').is_marketing, true)
  assert.equal(M.parseMarketingResponse('{"confidence":50}').is_marketing, true)
  assert.equal(M.parseMarketingResponse('{"confidence":49}').is_marketing, false)
  assert.equal(M.parseMarketingResponse('{"confidence":0}').is_marketing, false)
})

test('parseMarketingResponse：is_marketing 存在时不被 confidence 覆盖', () => {
  const r = M.parseMarketingResponse('{"is_marketing":false,"confidence":95}')
  assert.equal(r.is_marketing, false)
  assert.equal(r.confidence, 95)
})

test('parseMarketingResponse：仅有 is_marketing（无 confidence）→ 置信度归 0', () => {
  const r = M.parseMarketingResponse('{"is_marketing":true}')
  assert.equal(r.is_marketing, true)
  assert.equal(r.confidence, 0)
})

test('parseMarketingResponse：is_marketing 与 confidence 皆缺 → null', () => {
  assert.equal(M.parseMarketingResponse('{"category":"品牌广告"}'), null)
  assert.equal(M.parseMarketingResponse('{}'), null)
})

test('parseMarketingResponse：置信度越界夹紧、字符串数字可解析', () => {
  assert.equal(M.parseMarketingResponse('{"confidence":150}').confidence, 100)
  assert.equal(M.parseMarketingResponse('{"confidence":-9}').confidence, 0)
  assert.equal(M.parseMarketingResponse('{"confidence":"77"}').confidence, 77)
  assert.equal(M.parseMarketingResponse('{"confidence":"abc"}').confidence, 0)
})

test('parseMarketingResponse：可选字段缺省 → 空串/空数组（对照 data.get）', () => {
  const r = M.parseMarketingResponse('{"is_marketing":false,"confidence":10}')
  assert.equal(r.category, '')
  assert.equal(r.product_or_brand, '')
  assert.deepEqual(r.clues, [])
  assert.equal(r.analysis, '')
  assert.deepEqual(r.suggestions, [])
})

test('parseMarketingResponse：字符串型 clues/suggestions 退化为单元素，非串项被剔除', () => {
  const r = M.parseMarketingResponse(JSON.stringify({
    is_marketing: true, confidence: 60, clues: '单条线索', suggestions: ['a', 1, null, 'b'],
  }))
  assert.deepEqual(r.clues, ['单条线索'])
  assert.deepEqual(r.suggestions, ['a', 'b'])
})

test('parseMarketingResponse：category/product 前后空白被 trim', () => {
  const r = M.parseMarketingResponse(JSON.stringify({
    is_marketing: true, confidence: 60, category: '  软广植入  ', product_or_brand: '  X  ',
  }))
  assert.equal(r.category, '软广植入')
  assert.equal(r.product_or_brand, 'X')
})

test('parseMarketingResponse：非 JSON → null（由编排层报原始返回前 500 字）', () => {
  assert.equal(M.parseMarketingResponse('这个视频不是营销视频'), null)
  assert.equal(M.parseMarketingResponse(''), null)
  assert.equal(M.parseMarketingResponse('[1,2]'), null)
})

// ── 结论文案与配色（对照 _render）───────────────────────────────

test('marketingVerdictText：营销 / 非营销两分支', () => {
  assert.equal(M.marketingVerdictText(true), '⚠️ 检测结论：营销/商业推广视频')
  assert.equal(M.marketingVerdictText(false), '✅ 检测结论：原创内容/非营销视频')
})

test('marketingVerdictColor：营销红 / 非营销绿（对照 setStyleSheet）', () => {
  assert.equal(M.marketingVerdictColor(true), '#e74c3c')
  assert.equal(M.marketingVerdictColor(false), '#2ecc71')
})

test('marketingConfidenceText：对照 f"（置信度: {conf}%）"', () => {
  assert.equal(M.marketingConfidenceText(88), '（置信度: 88%）')
  assert.equal(M.marketingConfidenceText(0), '（置信度: 0%）')
})

test('marketingProductText：空 → "无"（对照 str(prod) if prod else "无"）', () => {
  assert.equal(M.marketingProductText('某品牌'), '某品牌')
  assert.equal(M.marketingProductText(''), '无')
  assert.equal(M.marketingProductText('   '), '无')
  assert.equal(M.marketingProductText(null), '无')
  assert.equal(M.marketingProductText(undefined), '无')
})

test('marketingCategoryText：空 → "—"（对照 data.get("category","—")）', () => {
  assert.equal(M.marketingCategoryText('品牌广告'), '品牌广告')
  assert.equal(M.marketingCategoryText(''), '—')
  assert.equal(M.marketingCategoryText(null), '—')
})

test('marketingConfidenceColor：>=80 红 / >=50 黄 / else 灰', () => {
  assert.equal(M.marketingConfidenceColor(100), '#e74c3c')
  assert.equal(M.marketingConfidenceColor(80), '#e74c3c')
  assert.equal(M.marketingConfidenceColor(79), '#f1c40f')
  assert.equal(M.marketingConfidenceColor(50), '#f1c40f')
  assert.equal(M.marketingConfidenceColor(49), '#a0aec0')
  assert.equal(M.marketingConfidenceColor(0), '#a0aec0')
})
