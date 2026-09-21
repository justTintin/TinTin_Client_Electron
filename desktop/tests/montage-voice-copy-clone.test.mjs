// ═══════════════════════════════════════════════════════════════
// montage-voice-copy-clone.test.mjs — 文案混剪「纯文案克隆」链路单测
// 2026-09-21 用户裁决：文案混剪=先生成文案→再生成声音→再按文案剪辑（声音先行不依赖视频）
// 覆盖：
//   · voice:cloneBatch 通道复用——videoPath 仅作结果 map key（文件不存在 →
//     targetDuration=0 自然时长），纯文案任务无需视频即可合成
//   · qwen3 长文案（多句且 >120 字）→ 按句多次 TTS 请求 + concatWavBuffers 帧级拼接
//     （句间静音=「句间停顿」设置），分段实测时长攒 timing 落盘
//   · qwen3 短文案仍整段单次请求（单句路径零开销，不误伤延迟）
//   · indextts 长文案不走客户端分句（长文案机制=服务端 ((pause=ms)) 标记拆段）
// ffmpeg/whisper 依赖经注入的 httpRequest/getServerUrl mock 隔离：
//   whisper 返回空 cues → transcribeAlignedOnce 得 null，不触发 10s/30s 重试；
//   ffmpeg 缺失 → runFfmpeg error 事件 resolve → detectSpeechBounds 静默回退
// ═══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const M = require('../main/montage-voice-ipc.js')
const L = require('../main/voice-tts-logic.js')

/** 造一段 durSec 秒的单声道 16kHz 16bit PCM wav（各句时长不同便于断言拼接结果） */
function makeWav(durSec) {
  const rate = 16000
  const frames = Math.floor(durSec * rate)
  const pcm = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i * 2)
  return Buffer.concat([L.buildWavHeader(pcm.length, 1, 1, rate, rate * 2, 2, 16), pcm])
}

// 三句长文案（各 ≥40 字、合计 >120 字触发 qwen3 分句；无数字/大写字母 → 预处理恒等）
const SENTENCES = [
  '这一段开场白要把产品的整体印象讲清楚，语气自然一些，就像和朋友聊天一样慢慢展开话题，把人留住。',
  '中间的部分重点描述真实的使用感受，把细节讲透，节奏稍微放慢一点，让听众能够跟上你的描述和情绪变化。',
  '收尾的时候给出明确的建议和总结，告诉听众为什么值得选择，再把刚才提到的核心卖点简单地重复一遍。',
]
const LONG_TEXT = SENTENCES.join('')
const SENT_DURS = [0.5, 0.6, 0.7] // mock 服务端每句返回的 wav 时长

function setup({ pauseMs = 300 } = {}) {
  const handlers = {}
  const fakeIpcMain = { handle: (name, fn) => { handlers[name] = fn } }
  const ttsCalls = []
  const deps = {
    httpRequest: async (_method, url, opts = {}) => {
      if (String(url).endsWith('/indextts/tts')) {
        const text = String(opts.body?.text || '')
        ttsCalls.push(text)
        const idx = SENTENCES.indexOf(text)
        return { raw: makeWav(idx >= 0 ? SENT_DURS[idx] : 0.4) }
      }
      if (String(url).includes('/whisper/transcribe')) {
        // 空 cues/segments → transcribeAlignedOnce 返回 null → 不触发 10s/30s 重试
        return { data: JSON.stringify({ segments: [], cues: [] }) }
      }
      throw new Error('unexpected url: ' + url)
    },
    isExpectedOfflineError: () => false,
    getServerUrl: () => 'http://test-server',
  }
  M.createMontageVoiceIpc(fakeIpcMain, deps)
  const invoke = (payload) => handlers['voice:cloneBatch']({ sender: { send: () => {} } }, payload)
  return { invoke, ttsCalls }
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-clone-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('纯文案任务无需视频：videoPath 不存在 → 自然时长合成，产物落盘并回填 results', async (t) => {
  const dir = tmpDir(t)
  const { invoke, ttsCalls } = setup()
  const outWav = path.join(dir, 'copy_voice_t1.wav')
  const res = await invoke({
    tasks: [{ rowIdx: 0, text: '一句短文案，用来验证无视频任务。', videoPath: outWav, outWavPath: outWav }],
    apiUrl: 'http://test-server/indextts/tts',
    ttsParams: {},
    progressChannel: '',
  })
  assert.equal(res.failures.length, 0)
  assert.equal(res.results[outWav], outWav)
  assert.ok(fs.existsSync(outWav))
  assert.equal(ttsCalls.length, 1)
})

test('qwen3 长文案：按句 3 次 TTS 请求 + 帧级拼接（句间停顿静音）+ 分段 timing 落盘', async (t) => {
  const dir = tmpDir(t)
  const { invoke, ttsCalls } = setup({ pauseMs: 300 })
  const outWav = path.join(dir, 'copy_voice_t2.wav')
  const res = await invoke({
    tasks: [{ rowIdx: 0, text: LONG_TEXT, videoPath: outWav, outWavPath: outWav }],
    apiUrl: 'http://test-server/indextts/tts',
    engine: 'qwen3',
    ttsParams: { pauseMs: 300 },
    progressChannel: '',
  })
  assert.equal(res.failures.length, 0)
  // 按句拆成 3 次请求，每次只带对应句子（无 pause 标记——qwen3 会照读）
  assert.equal(ttsCalls.length, 3)
  assert.deepEqual(ttsCalls, SENTENCES)
  // 拼接后时长 = 各句实测 0.5+0.6+0.7 + 句间 2 处 0.3s 静音 = 2.4s
  const dur = L.wavBytesDuration(fs.readFileSync(outWav))
  assert.ok(Math.abs(dur - 2.4) < 0.02, `拼接时长=${dur}`)
  // 分段 timing：3 行、顺序正确；句界落在相邻两句真实语音之间（下界=前句实测结束、
  // 上界=后句实测开始）。有 ffmpeg 时 alignTimingToSpeech 会把边界吸附到实测停顿
  // 中点（0.65/1.55），无 ffmpeg 时保留估算值（0.5/1.4）——两种环境都必须满足不变量
  const sidecar = fs.readdirSync(dir).find((f) => f.endsWith('.timing.json'))
  assert.ok(sidecar, 'timing 旁车未落盘')
  const timing = JSON.parse(fs.readFileSync(path.join(dir, sidecar), 'utf-8'))
  assert.equal(timing.length, 3)
  assert.deepEqual(timing.map((r) => r.text), SENTENCES)
  assert.equal(timing[0].start, 0)
  assert.ok(timing[0].end >= 0.5 && timing[0].end <= 0.8, `句1界=${timing[0].end}`)
  assert.ok(timing[1].start >= 0.5 && timing[1].start <= 0.8, `句2起=${timing[1].start}`)
  assert.ok(timing[1].end >= 1.4 && timing[1].end <= 1.7, `句2界=${timing[1].end}`)
  assert.ok(timing[2].start >= 1.4 && timing[2].start <= 1.7, `句3起=${timing[2].start}`)
  assert.ok(timing[2].end > 1.8 && timing[2].end <= 2.4 + 0.01, `句3终=${timing[2].end}`)
  for (let i = 1; i < timing.length; i++) assert.ok(timing[i].start >= timing[i - 1].start, '行序错乱')
})

test('qwen3 短文案：多句但 ≤120 字仍整段单次请求（不误伤延迟）', async (t) => {
  const dir = tmpDir(t)
  const { invoke, ttsCalls } = setup({ pauseMs: 300 })
  const outWav = path.join(dir, 'copy_voice_t3.wav')
  const res = await invoke({
    tasks: [{ rowIdx: 0, text: '第一句比较短。第二句也不长，就是这样。', videoPath: outWav, outWavPath: outWav }],
    apiUrl: 'http://test-server/indextts/tts',
    engine: 'qwen3',
    ttsParams: { pauseMs: 300 },
    progressChannel: '',
  })
  assert.equal(res.failures.length, 0)
  assert.equal(ttsCalls.length, 1)
  const sidecar = fs.readdirSync(dir).find((f) => f.endsWith('.timing.json'))
  const timing = JSON.parse(fs.readFileSync(path.join(dir, sidecar), 'utf-8'))
  assert.ok(Array.isArray(timing) && timing.length >= 1)
  assert.ok(timing.every((r) => r.end > r.start))
})

test('indextts 长文案：不走客户端分句，长文案机制=服务端 ((pause=ms)) 标记拆段', async (t) => {
  const dir = tmpDir(t)
  const { invoke, ttsCalls } = setup({ pauseMs: 300 })
  const outWav = path.join(dir, 'copy_voice_t4.wav')
  const res = await invoke({
    tasks: [{ rowIdx: 0, text: LONG_TEXT, videoPath: outWav, outWavPath: outWav }],
    apiUrl: 'http://test-server/indextts/tts',
    // engine 缺省 = indextts 通道
    ttsParams: { pauseMs: 300 },
    progressChannel: '',
  })
  assert.equal(res.failures.length, 0)
  assert.equal(ttsCalls.length, 1)
  assert.ok(ttsCalls[0].includes('((pause=300))'))
  // 句界标记逐句分隔（splitSentences 保留句尾标点直接 join）
  assert.ok(ttsCalls[0].includes('。((pause=300))'))
})
