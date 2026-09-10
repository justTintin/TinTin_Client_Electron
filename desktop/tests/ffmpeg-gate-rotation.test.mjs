// ═══════════════════════════════════════════════════════════════
// ffmpeg-gate-rotation.test.mjs — ffprobe 旋转元数据处理单测
// 对照原客户端 TinTin_AI_Agent_Main BUGFIX #010：镜头重组「与原片一致」
// 输出画幅不正确（未处理旋转元数据）。ffprobe width/height 是编码尺寸，
// ±90/270 旋转元数据的视频显示时宽高需互换（手机竖拍横存视频等）。
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ffmpeg-gate.js 顶层 require('electron')，node --test 环境预注入最小 mock
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ipcMain: { handle: () => {} } }
  return originalLoad.call(this, request, parent, isMain)
}

const { getStreamRotationDeg, applyRotationSize, parseFfmpegInfo } = require('../main/ffmpeg-gate.js')

// ── getStreamRotationDeg：旋转角度提取 ──────────────────────────

test('rotation：side_data_list(displaymatrix) 现代格式提取', () => {
  assert.equal(getStreamRotationDeg({ side_data_list: [{ rotation: -90 }] }), 90)
  assert.equal(getStreamRotationDeg({ side_data_list: [{ rotation: 90 }] }), 90)
  assert.equal(getStreamRotationDeg({ side_data_list: [{ rotation: 270 }] }), 270)
  assert.equal(getStreamRotationDeg({ side_data_list: [{ rotation: 180 }] }), 180)
  assert.equal(getStreamRotationDeg({ side_data_list: [{ rotation: 0 }] }), 0)
})

test('rotation：tags.rotate 旧格式回退（含大小写变体）', () => {
  assert.equal(getStreamRotationDeg({ tags: { rotate: '90' } }), 90)
  assert.equal(getStreamRotationDeg({ tags: { rotate: '-90' } }), 90)
  assert.equal(getStreamRotationDeg({ tags: { ROTATE: '270' } }), 270)
})

test('rotation：side_data_list 优先于 tags.rotate', () => {
  assert.equal(
    getStreamRotationDeg({ side_data_list: [{ rotation: 90 }], tags: { rotate: '270' } }),
    90,
  )
})

test('rotation：无元数据/空流安全返回 0', () => {
  assert.equal(getStreamRotationDeg(undefined), 0)
  assert.equal(getStreamRotationDeg({}), 0)
  assert.equal(getStreamRotationDeg({ side_data_list: [], tags: {} }), 0)
  assert.equal(getStreamRotationDeg({ side_data_list: [{}] }), 0)
})

// ── applyRotationSize：显示宽高换算 ────────────────────────────

test('rotation size：±90/270 宽高互换（编码横存 → 显示竖屏）', () => {
  assert.deepEqual(applyRotationSize(1920, 1080, 90), { width: 1080, height: 1920 })
  assert.deepEqual(applyRotationSize(1920, 1080, -90), { width: 1080, height: 1920 })
  assert.deepEqual(applyRotationSize(1920, 1080, 270), { width: 1080, height: 1920 })
})

test('rotation size：0/180/无旋转保持编码尺寸', () => {
  assert.deepEqual(applyRotationSize(1920, 1080, 0), { width: 1920, height: 1080 })
  assert.deepEqual(applyRotationSize(1080, 1920, 180), { width: 1080, height: 1920 })
  assert.deepEqual(applyRotationSize(1920, 1080, undefined), { width: 1920, height: 1080 })
  assert.deepEqual(applyRotationSize(1920, 1080, 360), { width: 1920, height: 1080 })
})

// ── parseFfmpegInfo：无 ffprobe 环境的 ffmpeg -i stderr 兜底探测 ──
// 样张取自 2026-09-11 实测 resources/bin/ffmpeg.exe -hide_banner -i 输出（逐字对拍）

const SAMPLE = [
  'Input #0, mov,mp4,m4a,3gp,3g2,mj2, \'t_rot.mp4\':',
  '  Metadata:',
  '    major_brand     : isom',
  '  Duration: 00:00:01.00, start: 0.000000, bitrate: 104 kb/s',
  '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 480x854 [SAR 1:1 DAR 240:427], 12 kb/s, 29.97 fps, 29.97 tbr, 11988 tbn (default)',
  '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 70 kb/s (default)',
].join('\n')

test('ffmpeg 兜底解析：时长/宽高/小数帧率/编码名', () => {
  const i = parseFfmpegInfo(SAMPLE)
  assert.equal(i.duration, 1)
  assert.equal(i.width, 480)
  assert.equal(i.height, 854)
  // 取 "29.97 fps" 而非后面的 tbr；取整交 resolveConcatFps/契约口径
  assert.equal(i.fps, 29.97)
  assert.equal(i.video, 'h264')
  assert.equal(i.audio, 'aac')
})

test('ffmpeg 兜底解析：fourcc 里的 0x31637661 不被误当宽高', () => {
  const i = parseFfmpegInfo(SAMPLE)
  assert.notEqual(i.width, 3163)
  assert.ok(i.width < 10000 && i.height < 10000)
})

test('ffmpeg 兜底解析：无视频流/空输出 → 全 0（调用方据此走默认值）', () => {
  assert.deepEqual(parseFfmpegInfo(''), { duration: 0, width: 0, height: 0, fps: 0, video: '', audio: '' })
  const audioOnly = parseFfmpegInfo('  Stream #0:0[0x1](und): Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s')
  assert.equal(audioOnly.width, 0)
  assert.equal(audioOnly.audio, 'aac')
})

test('ffmpeg 兜底解析：整数帧率且无音频流（静音素材）', () => {
  const i = parseFfmpegInfo('  Duration: 00:00:03.02, start: 0.000000, bitrate: 26 kb/s\n  Stream #0:0[0x1](und): Video: hevc (Main) (HEVC / 0x43564548), yuv420p(tv), 1080x1920, 25 fps, 25 tbr, 12800 tbn')
  assert.equal(i.fps, 25)
  assert.equal(i.width, 1080)
  assert.equal(i.audio, '')
})
