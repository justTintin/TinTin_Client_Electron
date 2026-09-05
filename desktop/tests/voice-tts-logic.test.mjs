// ═══════════════════════════════════════════════════════════════
// voice-tts-logic.test.mjs — 智能混剪 Step3 纯函数单测
// 对照：main/voice-tts-logic.js ↔ 原版 voice_workers.py / voxcpm_client.py /
// concat_workers.py VideoDubbingWorker / script_workers.py BatchAITextRewriteWorker
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const L = require('../main/voice-tts-logic.js')

// ── preprocessTtsText（voice_workers.py L74-138 口径）──
test('preprocessTtsText: 整数转中文 + 大写缩写拆字母（8000 DPI）', () => {
  assert.equal(L.preprocessTtsText('8000 DPI'), '八千 D P I')
})
test('preprocessTtsText: 小数转「点」（空格分隔成立时）', () => {
  assert.equal(L.preprocessTtsText('转速 5.5 倍'), '转速 五点五 倍')
})
test('preprocessTtsText: Python Unicode 词边界口径——中文紧贴数字不转换', () => {
  // 原版 re \b 为 Unicode 口径（中文属 \w），中文紧贴数字时边界不成立
  assert.equal(L.preprocessTtsText('含5.5倍光学'), '含5.5倍光学')
  assert.equal(L.preprocessTtsText('频率2.4GHz'), '频率2.4GHz')
})
test('preprocessTtsText: 品牌词逐字母（LIGHTSPEED）', () => {
  assert.equal(L.preprocessTtsText('LIGHTSPEED'), 'L I G H T S P E E D')
})
test('preprocessTtsText: 连字符转空格（Type-C）', () => {
  assert.equal(L.preprocessTtsText('Type-C'), 'Type C')
})
test('preprocessTtsText: 万/亿位与零位（10005→一万零五，100000000→一亿）', () => {
  assert.equal(L.intToCn(10005), '一万零五')
  assert.equal(L.intToCn(100000000), '一亿')
  assert.equal(L.intToCn(0), '零')
  assert.equal(L.intToCn(10), '十')
  assert.equal(L.intToCn(110), '一百一十')
})
test('preprocessTtsText: 单位词 MHz 不拆', () => {
  assert.equal(L.preprocessTtsText('频率 2.4 GHz'), '频率 二点四 GHz')
})

// ── splitSentences（L190-204 口径）──
test('splitSentences: 按句末标点切分并保留标点', () => {
  assert.deepEqual(L.splitSentences('你好。世界！END？'), ['你好。', '世界！', 'END？'])
})
test('splitSentences: 多行拆分', () => {
  assert.deepEqual(L.splitSentences('第一行。\n第二行'), ['第一行。', '第二行'])
})
test('splitSentences: 过滤只含标点的片段', () => {
  assert.deepEqual(L.splitSentences('。。。！'), [])
})

// ── computeSpeedAdjust（run L371-380 口径）──
test('computeSpeedAdjust: 差异≤2% 不调整', () => {
  assert.deepEqual(L.computeSpeedAdjust(10, 10.2, 0.9, 1.2), { should: false, ratio: 1 })
})
test('computeSpeedAdjust: 差异>2% 且在范围内按原比例', () => {
  assert.deepEqual(L.computeSpeedAdjust(10, 11, 0.9, 1.2), { should: true, ratio: 1.1 })
})
test('computeSpeedAdjust: 超范围 clamp（15/10→1.2）', () => {
  assert.deepEqual(L.computeSpeedAdjust(10, 15, 0.9, 1.2), { should: true, ratio: 1.2 })
})
test('computeSpeedAdjust: clamp 后≈1 不调整（raw=0.97 clamp 至 speedMin=0.996）', () => {
  assert.deepEqual(L.computeSpeedAdjust(10, 9.7, 0.996, 1.2), { should: false, ratio: 0.996 })
})
test('computeSpeedAdjust: 音频短于视频 → 拉慢（0.9）', () => {
  assert.deepEqual(L.computeSpeedAdjust(10, 9, 0.9, 1.2), { should: true, ratio: 0.9 })
})

// ── WAV 字节层（voxcpm_client + voice_workers L206-243）──
function makeWav(frames, { rate = 8000, ch = 1, width = 2 } = {}) {
  const dataLen = frames * ch * width
  const head = L.buildWavHeader(dataLen, 1, ch, rate, rate * ch * width, ch * width, width * 8)
  return Buffer.concat([head, Buffer.alloc(dataLen)])
}
test('repairWavBytes: data 头声明小于实际时重写', () => {
  const real = makeWav(100) // 100帧×1声道×16bit = data 200 字节，总长 244
  const bad = Buffer.from(real)
  bad.writeUInt32LE(4, 40) // data 声明 4 字节，实际 244-(36+8)=200
  const fixed = L.repairWavBytes(bad)
  assert.equal(fixed.readUInt32LE(40), 200)
  assert.equal(fixed.readUInt32LE(4), 236)
})
test('repairWavBytes: 正常 wav 原样返回', () => {
  const real = makeWav(100)
  assert.equal(L.repairWavBytes(real), real)
})
test('wavBytesDuration: 帧数/采样率', () => {
  assert.equal(L.wavBytesDuration(makeWav(8000)), 1)
})
test('concatWavBuffers: 拼接 + 0.15s 静音（8000Hz ×2 段 → 2.15s）', () => {
  const out = L.concatWavBuffers([makeWav(8000), makeWav(8000)], 0.15)
  assert.ok(Math.abs(L.wavBytesDuration(out) - 2.15) < 1e-9)
})

// ── deriveHealthUrl（_health_url L41-55 口径）──
test('deriveHealthUrl: /tts 结尾 → 去后缀换 /health（原版 u[:-len]+/health）', () => {
  assert.equal(L.deriveHealthUrl('http://x:8000/voxcpm/tts'), 'http://x:8000/voxcpm/health')
  // 2026-09-05 口播配音切 IndexTTS：/indextts/tts → /indextts/health（同规则命中）
  assert.equal(L.deriveHealthUrl('http://x:8000/indextts/tts'), 'http://x:8000/indextts/health')
})
test('deriveHealthUrl: /v1/tts 结尾 → 整段去除换 /health', () => {
  assert.equal(L.deriveHealthUrl('http://x/v1/tts'), 'http://x/health')
})
test('deriveHealthUrl: 兜底 host + /health', () => {
  assert.equal(L.deriveHealthUrl('http://x:9000/a/b'), 'http://x:9000/health')
})

// ── AI 改写（script_workers L449-493 口径）──
test('buildAiRewriteSystemPrompt: 四档指令与温度换算', () => {
  assert.ok(L.buildAiRewriteSystemPrompt(0.1).includes('最小幅度的润色'))
  assert.ok(L.buildAiRewriteSystemPrompt(0.5).includes('较大幅度的改写'))
  assert.ok(L.buildAiRewriteSystemPrompt(0.7).includes('大幅改写和重构'))
  assert.ok(L.buildAiRewriteSystemPrompt(0.95).includes('彻底的重写'))
  assert.ok(L.buildAiRewriteSystemPrompt(0.3).includes('15-35字'))
})
test('cleanRewriteContent: 剥代码块与引号包裹', () => {
  assert.equal(L.cleanRewriteContent('```\n改写文本\n```'), '改写文本')
  assert.equal(L.cleanRewriteContent('"改写文本"'), '改写文本')
  assert.equal(L.cleanRewriteContent('“改写文本”'), '改写文本')
})

// ── 花字与目录（controller L3726-3730 / _get_out_montage_dir L3969-3981）──
test('parseFancyWords: 全角/半角逗号混拆 + 去空白', () => {
  assert.deepEqual(L.parseFancyWords('超轻量化，8000DPI, 续航70小时'), ['超轻量化', '8000DPI', '续航70小时'])
  assert.deepEqual(L.parseFancyWords(''), [])
})
test('resolveOutMontageDir: 普通目录 → 父级/outputs', () => {
  assert.equal(L.resolveOutMontageDir('D:\\a\\b'), 'D:\\a\\outputs')
})
test('resolveOutMontageDir: 目录本身是 outputs → 原样', () => {
  assert.equal(L.resolveOutMontageDir('D:\\a\\outputs'), 'D:\\a\\outputs')
})
test('resolveOutMontageDir: outputs 子目录 → 取该 outputs', () => {
  assert.equal(L.resolveOutMontageDir('D:\\a\\outputs\\x'), 'D:\\a\\outputs')
})

// ── atempo 链（VideoDubbingWorker L974-995 口径）──
test('buildAtempoChain: >2 逐级拆分', () => {
  assert.deepEqual(L.buildAtempoChain(3.0), ['atempo=2.0', 'atempo=1.5000'])
})
test('buildAtempoChain: <0.5 补 0.5 段', () => {
  assert.deepEqual(L.buildAtempoChain(0.25), ['atempo=0.5', 'atempo=0.5000'])
})
test('buildAtempoChain: 1.0 无需滤镜', () => {
  assert.deepEqual(L.buildAtempoChain(1.0), [])
})

// ── buildDubFFmpegArgs（run L843-1019 口径）──
const DUB_BASE = {
  videoPath: 'D:\\v\\a.mp4', voiceWavPath: 'D:\\v\\voices\\voice_1.wav',
  outputVideoPath: 'D:\\v\\dubbed\\dubbed_a.mp4', text: '文案',
}
test('buildDubFFmpegArgs: 无字幕/花字/变速 → 直通 copy + shortest', () => {
  const args = L.buildDubFFmpegArgs({ ...DUB_BASE, videoDur: 10, audioDur: 10 })
  assert.ok(args.includes('-c:v') && args.includes('copy'))
  assert.ok(args.includes('-shortest'))
  assert.ok(!args.includes('-filter_complex'))
})
test('buildDubFFmpegArgs: 字幕 drawtext（timing 对轴 + 白字 50% 黑底）', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10, addSubtitles: true,
    subtitleFontPath: 'C\\:/Windows/Fonts/msyh.ttc',
    timing: [{ text: '第一句', start: 0, end: 2 }],
  })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('drawtext=fontfile='))
  assert.ok(fc.includes('fontsize=h*0.025'))
  assert.ok(fc.includes('boxcolor=black@0.5'))
  assert.ok(fc.includes("enable='between(t,0.000,2.000)'"))
})
test('buildDubFFmpegArgs: 以声音为准 → tpad 补帧 + -t 裁剪', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 5, audioDur: 8, lengthMode: 'audio',
  })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('tpad=stop_mode=clone:stop_duration=3.000'))
  assert.ok(args.includes('-t') && args.includes('8.000'))
})
test('buildDubFFmpegArgs: 变速对齐（audio 12 / video 10 → atempo=1.2000）', () => {
  const args = L.buildDubFFmpegArgs({ ...DUB_BASE, videoDur: 10, audioDur: 12 })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('[1:a:0]atempo=1.2000[a]'))
})
test('buildDubFFmpegArgs: 仅变速时插入视频直通占位（L993-995）', () => {
  const args = L.buildDubFFmpegArgs({ ...DUB_BASE, videoDur: 10, audioDur: 12 })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.startsWith('[0:v]null[v0];'))
})
test('buildDubFFmpegArgs: 花字（h*0.08 大号 + 居中偏上）', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10,
    fancyText: true, fancyStyle: 'yellow_red', fancyWords: ['8000DPI'],
  })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('fontsize=h*0.08'))
  assert.ok(fc.includes('y=h*0.3'))
  assert.ok(fc.includes('fontcolor=0xFFFF00'))
})
test('buildSubtitleLines: 无时间轴按字数比例估算', () => {
  const r = L.buildSubtitleLines({ text: '12345\n123', displayDur: 8 })
  assert.deepEqual(r.rawLines, ['12345', '123'])
  assert.ok(Math.abs(r.lineStarts[1] - 5) < 1e-9)
  assert.ok(Math.abs(r.lineEnds[1] - 8) < 1e-9)
})
test('resolveSubtitleFontPath: 族名命中 → 盘符冒号转义；未命中回退微软雅黑', () => {
  assert.equal(
    L.resolveSubtitleFontPath('Arial', { familyPath: 'C:\\Windows\\Fonts\\arial.ttf', path: () => false }),
    'C\\:/Windows/Fonts/arial.ttf',
  )
  assert.equal(
    L.resolveSubtitleFontPath('不存在', { familyPath: '', path: (p) => p === 'C:/Windows/Fonts/msyh.ttc' }),
    'C\\:/Windows/Fonts/msyh.ttc',
  )
  assert.equal(L.resolveSubtitleFontPath('', { familyPath: '', path: () => false }), 'msyh')
})
