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
test('buildDubFFmpegArgs: 字幕 drawtext（新口径：字号 0.035 + 底边贴安全框 + 可配背景）', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10, addSubtitles: true,
    subtitleFontPath: 'C\\:/Windows/Fonts/msyh.ttc',
    timing: [{ text: '第一句', start: 0, end: 2 }],
  })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('drawtext=fontfile='))
  assert.ok(fc.includes('fontsize=h*0.035'))
  assert.ok(fc.includes('boxcolor=black@0.50'))
  assert.ok(fc.includes('y=h*(1-0.1)-text_h-h*0.02'))
  assert.ok(fc.includes("enable='between(t,0.000,2.000)'"))
})
test('buildDubFFmpegArgs: 字幕背景不透明度 0 → 无背景框；65% → black@0.65', () => {
  const mk = (op) => L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10, addSubtitles: true, subtitleBoxOpacity: op,
    timing: [{ text: '第一句', start: 0, end: 2 }],
  })
  assert.ok(!mk(0)[mk(0).indexOf('-filter_complex') + 1].includes('boxcolor'))
  assert.ok(mk(0.65)[mk(0.65).indexOf('-filter_complex') + 1].includes('boxcolor=black@0.65'))
})
test('buildDubFFmpegArgs: 超长字幕按时间窗切段依次显示（折行 + 占比切分）', () => {
  const long = '一'.repeat(22)
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10, addSubtitles: true,
    text: long, timing: [{ text: long, start: 0, end: 4 }],
  })
  const fc = args[args.indexOf('-filter_complex') + 1]
  // 22 等效字 → 2 段（8/22 与 14/22 占比切 0..4 秒窗）
  assert.ok(fc.includes("enable='between(t,0.000,1.455)'"))
  assert.ok(fc.includes("enable='between(t,1.455,4.000)'"))
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
test('buildDubFFmpegArgs: 花字自动提取卖点（h*0.08 + 中上位置 + 提前量 + 默认淡入）', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10,
    fancyText: true, fancyStyle: 'yellow_red',
    text: '只要199元超值好听',
    timing: [{ text: '只要199元超值好听', start: 1, end: 5 }],
  })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('fontsize=h*0.08'))
  assert.ok(fc.includes('y=h*0.3'))
  assert.ok(fc.includes('fontcolor=0xFFFF00'))
  assert.ok(fc.includes("text='只要199元'"))
  // 提前 0.3s：字幕行 1..5 → 花字 0.7..5
  assert.ok(fc.includes("enable='between(t,0.700,5.000)'"))
  assert.ok(fc.includes("alpha='if(lt(t,0.700+0.4),(t-0.700)/0.4,1)'"))
})
test('buildDubFFmpegArgs: 花字模板 → style 覆盖 + jy 动画映射 slide 位移', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10,
    fancyText: true, text: '只要199元超值好听',
    timing: [{ text: '只要199元超值好听', start: 1, end: 5 }],
    fancyTemplate: { template_id: 'jy_x', style: 'fontcolor=0xFF0000:borderw=6', jy_intro_anim: '向左滑动' },
  })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('fontcolor=0xFF0000:borderw=6'))
  assert.ok(fc.includes("x='((w-text_w)/2)+(1-min((t-0.700)/0.4,1))*w*0.10'"))
  assert.ok(fc.includes('y=h*0.3'))
})
test('buildDubFFmpegArgs: 模板音效 → 追加输入 + adelay/amix + a_mix 映射', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10,
    fancyText: true, text: '只要199元超值好听',
    timing: [{ text: '只要199元超值好听', start: 1, end: 5 }],
    fancyTemplate: { template_id: 'gold_pop', style: 'fontcolor=0xF0C040', anim: 'pop' },
    fancySoundPath: 'D:\\f\\sfx\\pop.mp3', fancySoundGainDb: -8,
  })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('[2:a]adelay=700:all=1,volume=-8.0dB[s0]'))
  assert.ok(fc.includes('amix=inputs=2:normalize=0:duration=longest[a_mix]'))
  assert.ok(args.includes('D:\\f\\sfx\\pop.mp3'))
  assert.ok(args.includes('[a_mix]'))
  // pop 弹跳动画
  assert.ok(fc.includes("alpha='if(lt(t,0.700+0.15),(t-0.700)/0.15,1)'"))
  assert.ok(fc.includes('abs(sin((t-0.700)*14))'))
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

// ── PR#4 新口径（2026-09-07）：读音标注 / 卖点提取 / 折行 / 花字事件 / 动画映射 ──
test('preprocessTtsText: 读音标注 → TTS 读括号内读法（第 0 步，数字转中文之前）', () => {
  assert.equal(L.preprocessTtsText('555(三五)电池'), '三五电池')
  assert.equal(L.preprocessTtsText('型号A1(亿一)上门'), '型号亿一上门')
  // 非紧贴字母/数字的普通括号注释不替换
  assert.equal(L.preprocessTtsText('好(真的)东西'), '好(真的)东西')
})
test('stripPronAnnotation: 字幕侧剠括号显示原文，普通括号不误伤', () => {
  assert.equal(L.stripPronAnnotation('555(三五)电池'), '555电池')
  assert.equal(L.stripPronAnnotation('好(真的)东西'), '好(真的)东西')
  assert.equal(L.stripPronAnnotation(''), '')
})
test('extractFancyWordsInLine: 价格 > 数字参数 > 关键词，位置排序 + 去重', () => {
  assert.deepEqual(
    L.extractFancyWordsInLine('只要199元，续航70小时，超轻便携', 3),
    ['只要199元', '续航70小时', '超轻'],
  )
  // 「只要199元」同时命中参数正则 → 区间重叠去重只保价格
  assert.deepEqual(L.extractFancyWordsInLine('只要199元', 3), ['只要199元'])
  // 无卖点 → 空数组
  assert.deepEqual(L.extractFancyWordsInLine('普通日常文案'), [])
  // limit 上限
  assert.deepEqual(L.extractFancyWordsInLine('超轻超薄', 1), ['超轻'])
})
test('extractFancyWordsFromText: 跨行累计到 maxWords', () => {
  assert.deepEqual(
    L.extractFancyWordsFromText('第一行超轻\n第二行大容量\n第三行防水', 2),
    ['超轻', '大容量'],
  )
})
test('resolveFancyOverlaps: 压缩前段 / 丢弃后段 / 背靠背不视为重叠', () => {
  // 可压缩：前段结束提前到 next.start - gap
  assert.deepEqual(
    L.resolveFancyOverlaps([['A', 0, 5], ['B', 4.8, 8]]),
    [['A', 0, 4.75], ['B', 4.8, 8]],
  )
  // 压不动（低于最短显示）→ 丢弃后一个
  assert.deepEqual(
    L.resolveFancyOverlaps([['A', 4, 5], ['B', 4.2, 8]]),
    [['A', 4, 4.4]],
  )
  // 背靠背（s == pe）保留
  assert.deepEqual(
    L.resolveFancyOverlaps([['A', 0, 2], ['B', 2, 4]]),
    [['A', 0, 2], ['B', 2, 4]],
  )
})
test('buildFancyEvents: 提前量 + quota 递减 + 行内多卖点均分 + 重叠消解', () => {
  const ev = L.buildFancyEvents({
    subLines: ['只要199元超值', '续航70小时很给力', '没有卖点的一行'],
    subStarts: [0, 3, 6], subEnds: [2.5, 5, 9], displayDur: 10,
  })
  assert.equal(ev.length, 2)
  assert.deepEqual([ev[0][0], ev[0][1], ev[0][2]], ['只要199元', 0, 2.5])
  assert.equal(ev[1][0], '续航70小时')
  assert.ok(Math.abs(ev[1][1] - 2.7) < 1e-9)
  assert.ok(Math.abs(ev[1][2] - 5) < 1e-9)
  // 行内多卖点：时间窗均分（首段保提前量）
  const ev2 = L.buildFancyEvents({
    subLines: ['超轻超薄'], subStarts: [1], subEnds: [5], displayDur: 6,
  })
  assert.equal(ev2.length, 2)
  assert.equal(ev2[0][0], '超轻')
  assert.ok(Math.abs(ev2[0][1] - 0.7) < 1e-9)
  assert.ok(Math.abs(ev2[0][2] - 2.85) < 1e-9)
  assert.equal(ev2[1][0], '超薄')
  assert.ok(Math.abs(ev2[1][1] - 2.85) < 1e-9)
  assert.ok(Math.abs(ev2[1][2] - 5) < 1e-9)
})
test('wrapSubtitleLine: 短行原样 / 空行 / 长行均衡分段不在英数串中间硬断', () => {
  assert.deepEqual(L.wrapSubtitleLine('短句'), ['短句'])
  assert.deepEqual(L.wrapSubtitleLine(''), [])
  const parts = L.wrapSubtitleLine('中中中中中中中中中中中中8000DPI速')
  assert.equal(parts.length, 2)
  assert.ok(parts[1].includes('8000DPI')) // 英数连续串不被拆开
  // 数字+量词不作断点
  assert.equal(L.badSubBoundary(['9', '元'], 1), true)
  assert.equal(L.badSubBoundary(['0', 'D'], 1), true)
  assert.equal(L.badSubBoundary(['中', '文'], 1), false)
})
test('FANCY_POSITIONS: 8 项全落安全框内', () => {
  assert.equal(Object.keys(L.FANCY_POSITIONS).length, 8)
  assert.equal(L.FANCY_POSITIONS.top.y, 'h*0.08')
  assert.equal(L.FANCY_POSITIONS.bottom_left.y, 'h*(1-0.1)-text_h-h*0.02')
  assert.equal(L.FANCY_POSITIONS.top_right.x, 'w-text_w-w*0.08')
})
test('getFancyAnim: anim 显式优先 → jy 语义映射 → 回退 fade', () => {
  assert.equal(L.getFancyAnim({ anim: 'pop' }), 'pop')
  assert.equal(L.getFancyAnim({ jy_intro_anim: '向左滑动' }), 'slide')
  assert.equal(L.getFancyAnim({ jy_intro_anim: '波浪弹入' }), 'pop')
  assert.equal(L.getFancyAnim({ jy_intro_anim: '复古打字机' }), 'fade')
  assert.equal(L.getFancyAnim({ jy_intro_anim: '未知动画' }), 'fade')
  assert.equal(L.getFancyAnim({}), 'fade')
  assert.equal(L.getFancyAnim(null), 'fade')
})

// ── 字幕样式预设（2026-09-09 裁决：样式属字幕配置；SUBTITLE_STYLES 查表进字幕 drawtext）──
test('SUBTITLE_STYLES: 24 项；默认白字无描边（与旧版口径一致）', () => {
  assert.equal(Object.keys(L.SUBTITLE_STYLES).length, 24)
  assert.equal(L.SUBTITLE_STYLES.white, 'fontcolor=white')
})
test('buildDubFFmpegArgs: subtitleStyle 查表（white_blk → 白字黑描边）', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10, addSubtitles: true, subtitleStyle: 'white_blk',
    timing: [{ text: '第一句', start: 0, end: 2 }],
  })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('fontsize=h*0.035:fontcolor=0xFFFFFF:borderw=3:bordercolor=0x000000:'))
})
test('buildDubFFmpegArgs: 未知 subtitleStyle 回退默认白字；缺省同旧口径', () => {
  const mk = (style) => L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10, addSubtitles: true, subtitleStyle: style,
    timing: [{ text: '第一句', start: 0, end: 2 }],
  })
  assert.ok(mk('no_such_key')[mk('no_such_key').indexOf('-filter_complex') + 1].includes('fontsize=h*0.035:fontcolor=white:'))
  assert.ok(mk(undefined)[mk(undefined).indexOf('-filter_complex') + 1].includes('fontsize=h*0.035:fontcolor=white:'))
})

// ── 特效迁 Step4 统一烧制（2026-09-09 裁决：配音链只出声音，特效在 final:mix 前烧制）──
test('buildDubFFmpegArgs: burnEffects:false → 不烧字幕/花字（配音纯化）', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10, addSubtitles: true, fancyText: true,
    burnEffects: false,
    timing: [{ text: '第一句', start: 0, end: 2 }],
  })
  assert.ok(!args.includes('-filter_complex'))
})
test('buildDubFFmpegArgs: burnEffects 缺省 true → 仍烧字幕（向后兼容既有单测口径）', () => {
  const args = L.buildDubFFmpegArgs({
    ...DUB_BASE, videoDur: 10, audioDur: 10, addSubtitles: true,
    timing: [{ text: '第一句', start: 0, end: 2 }],
  })
  assert.ok(args.includes('-filter_complex'))
})
test('buildEffectBurnArgs: 字幕烧制（无配音替换，音频 copy）', () => {
  const args = L.buildEffectBurnArgs({
    videoPath: 'D:\\v\\dubbed\\dubbed_a.mp4', outputVideoPath: 'D:\\v\\final\\dubbed_a.fx.mp4',
    text: '第一句', videoDur: 10, addSubtitles: true,
    subtitleFontPath: 'C\\:/Windows/Fonts/msyh.ttc', subtitleStyle: 'white',
    subtitleBoxOpacity: 0.5,
    timing: [{ text: '第一句', start: 0, end: 2 }],
  })
  assert.ok(Array.isArray(args))
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('drawtext='))
  assert.ok(args.includes('-c:a') && args.includes('copy'))
  assert.ok(!args.includes('-shortest'))
})
test('buildEffectBurnArgs: 字幕入场动画（fade/rise/slide/pop/none；无效值回退 fade）', () => {
  const base = {
    videoPath: 'D:\\v\\dubbed\\dubbed_a.mp4', outputVideoPath: 'D:\\v\\final\\dubbed_a.fx.mp4',
    text: '第一句', videoDur: 10, addSubtitles: true,
    subtitleFontPath: 'C\\:/Windows/Fonts/msyh.ttc', subtitleStyle: 'white',
    subtitleBoxOpacity: 0.5,
    timing: [{ text: '第一句', start: 0, end: 2 }],
  }
  const fcOf = (o) => {
    const a = L.buildEffectBurnArgs(o)
    return a[a.indexOf('-filter_complex') + 1]
  }
  // fade：纯 alpha 淡入；rise：alpha + y 位移；slide：alpha + x 位移；pop：短 alpha + y 弹跳
  assert.ok(fcOf({ ...base, subtitleAnim: 'fade' }).includes("alpha='if(lt(t,"))
  const rise = fcOf({ ...base, subtitleAnim: 'rise' })
  assert.ok(rise.includes('alpha=') && rise.includes('(1-min((t-'))
  const slide = fcOf({ ...base, subtitleAnim: 'slide' })
  assert.ok(slide.includes('alpha=') && slide.includes('w*0.10'))
  const pop = fcOf({ ...base, subtitleAnim: 'pop' })
  assert.ok(pop.includes('alpha=') && pop.includes('sin((t-'))
  // none=硬切保持旧版行为；缺省/无效值回退 fade
  assert.ok(!fcOf({ ...base, subtitleAnim: 'none' }).includes('alpha='))
  assert.ok(fcOf(base).includes('alpha='))
  assert.ok(fcOf({ ...base, subtitleAnim: 'bogus' }).includes('alpha='))
})
test('buildEffectBurnArgs: 花字烧制（卖点提取 + 模板音效 aac 重编码）', () => {
  const args = L.buildEffectBurnArgs({
    videoPath: 'D:\\v\\dubbed\\dubbed_a.mp4', outputVideoPath: 'D:\\v\\final\\dubbed_a.fx.mp4',
    text: '这款扫地机只要199元', videoDur: 10, fancyText: true,
    fancyStyle: 'gold', fancyPosition: 'upper_middle', fancyFontPath: 'msyh',
    fancySoundPath: 'D:\\f\\sfx.wav',
    timing: [{ text: '这款扫地机只要199元', start: 0, end: 3 }],
  })
  assert.ok(Array.isArray(args))
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('drawtext='))
  assert.ok(args.includes('-c:a') && args.includes('aac'))
})
test('buildEffectBurnArgs: 无特效/时长不可读 → null（调用方直通）', () => {
  assert.equal(L.buildEffectBurnArgs({ videoPath: 'a', outputVideoPath: 'b', videoDur: 10 }), null)
  assert.equal(L.buildEffectBurnArgs({ videoPath: 'a', outputVideoPath: 'b', videoDur: 0, addSubtitles: true, text: 'x' }), null)
})

// ── buildTextFxDrawtextList / 文字模板本地烧制（2026-09-10 用户裁决：本地合成同烧）──

test('buildTextFxDrawtextList: 命中句时间窗顶部叠加 + 样式轮换 + 颜色 0x 化；未命中句不生条目', () => {
  const drawtexts = L.buildTextFxDrawtextList(
    {
      textFxWords: ['持久', '便宜'],
      textFxStyles: [
        { name: '脉冲', color: '#FFD24D', effectColor: '#FF8800', anim: 'pulse' },
        { name: '滑入', color: '#4FC3F7', effectColor: '#FFFFFF', anim: 'slide' },
      ],
    },
    ['持久续航很好用', '不划算', '真的便宜'],
    [0, 3, 6],
    [3, 6, 9],
    0, // videoIdx
  )
  assert.equal(drawtexts.length, 2) // 第 2 句无命中
  // 句 1：样式池 [0]（pulse）；句 3：样式池 [1]（slide）—— (videoIdx+句序)%池长 轮换
  assert.ok(drawtexts[0].includes('text=') && drawtexts[0].includes('持久'))
  assert.ok(drawtexts[0].includes('fontcolor=0xFFD24D')) // # → 0x（ffmpeg 色值）
  assert.ok(drawtexts[0].includes('bordercolor=0xFF8800@0.9'))
  assert.ok(drawtexts[0].includes("y='h*0.08'") && drawtexts[0].includes("between(t,0.000,3.000)"))
  assert.ok(drawtexts[0].includes('0.65+0.35*abs(sin((t-0.000)*6))')) // pulse 持续脉动
  assert.ok(drawtexts[1].includes('fontcolor=0x4FC3F7') && drawtexts[1].includes('便宜'))
  assert.ok(drawtexts[1].includes('w*0.10')) // slide x 位移
})

test('buildTextFxDrawtextList textFxCount：每视频确定性洗牌取子集；count<=0 全量轮换', () => {
  const styles = [
    { name: '甲', color: '#111111', effectColor: '#222222', anim: 'fade' },
    { name: '乙', color: '#333333', effectColor: '#444444', anim: 'fade' },
    { name: '丙', color: '#555555', effectColor: '#666666', anim: 'fade' },
    { name: '丁', color: '#777777', effectColor: '#888888', anim: 'fade' },
  ]
  const o = { textFxWords: ['持久'], textFxStyles: styles, textFxCount: 2 }
  const subLines = ['持久给力', '依然持久', '还是持久']
  const starts = [0, 3, 6]; const ends = [3, 6, 9]
  const run = (vi) => L.buildTextFxDrawtextList(o, subLines, starts, ends, vi)
  const v0 = run(0); const v0b = run(0)
  assert.equal(v0.length, 3)
  assert.deepEqual(v0, v0b) // 确定性：同视频同子集（预览/烧制同源）
  // 每条样式都应在该视频子集内：count=2 时至多 2 种主色
  const pool0 = new Set()
  for (const d of v0) {
    const m = d.match(/fontcolor=0x([0-9A-F]{6})/)
    if (m) pool0.add('#' + m[1])
  }
  assert.ok(pool0.size <= 2, `count=2 时视频 0 至多 2 种主色，实为 ${pool0.size}`)
  // count=0 → 全量轮换（4 样式均可能出现在同视频）
  const all = L.buildTextFxDrawtextList({ textFxWords: ['持久'], textFxStyles: styles }, subLines, starts, ends, 0)
  const poolAll = new Set(all.map((d) => (d.match(/fontcolor=0x([0-9A-F]{6})/) || [])[1]))
  assert.ok(poolAll.size > 2, `count=0 应全量轮换，实为 ${poolAll.size} 种`)
})

test('buildEffectBurnArgs: 仅勾文字模板（无字幕/花字）也生烧制参数；字幕+文字模板链式叠加 vtx', () => {
  const base = {
    videoPath: 'D:\\v\\dubbed\\dubbed_a.mp4', outputVideoPath: 'D:\\v\\final\\dubbed_a.fx.mp4',
    text: '持久续航真的便宜', videoDur: 10,
    textFxWords: ['持久', '便宜'],
    textFxStyles: [{ name: 's', color: '#FFD24D', effectColor: '#FF8800', anim: 'fade' }],
    timing: [{ text: '持久续航真的便宜', start: 0, end: 3 }],
    fancyFontPath: 'msyh',
  }
  // 仅文字模板：subLines 由 hasTextFx 触发构建，args 非 null 且含 vtx 链
  const only = L.buildEffectBurnArgs({ ...base })
  assert.ok(Array.isArray(only))
  let fc = only[only.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('[vtx]'))
  // 字幕 + 文字模板：链式叠加（字幕 [v] → 文字模板 [vtx]）
  const both = L.buildEffectBurnArgs({
    ...base, addSubtitles: true,
    subtitleFontPath: 'C\\:/Windows/Fonts/msyh.ttc', subtitleStyle: 'white', subtitleBoxOpacity: 0.5,
  })
  fc = both[both.indexOf('-filter_complex') + 1]
  assert.ok(fc.includes('[v]') && fc.includes('[v]drawtext') && fc.includes('[vtx]'))
})
