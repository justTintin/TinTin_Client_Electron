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

const { getStreamRotationDeg, applyRotationSize } = require('../main/ffmpeg-gate.js')

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
