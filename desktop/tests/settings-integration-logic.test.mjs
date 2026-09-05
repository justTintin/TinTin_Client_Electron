// ═══════════════════════════════════════════════════════════════
// settings-integration-logic.test.mjs — S9 系统与运行编组单测
// 2026-08-30 用户裁决：S8 平台接入（数字人/ComfyUI/RunningHub 直连配置）
//   整体移除——三者均已通过统一服务端接入，原客户端已删除直连配置，
//   对应 S8 用例（PLATFORM_TABS/maskKey/validateComfyui/buildComfyuiBody/
//   validateRunninghub/buildRunninghubBody/parsePlatformStatus）同步删除。
// 对照原客户端（以原代码为准）：
//   · 缓存目录 L1973-2039（local_config.cache_dir）；系统信息 L1622-1637
// 2026-09-04 用户裁决：LUT 配置逻辑整体删除（本端无消费方），对应用例同步删除
// 运行：cd desktop && node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const S = await import('../renderer/src/composables/settingsIntegrationLogic.ts')

// ── S9 缓存目录 ──

test('CACHE_DIR_KEY：local.cacheDir（对齐原 local_config.cache_dir 语义）', () => {
  assert.equal(S.CACHE_DIR_KEY, 'local.cacheDir')
})

// ── 缓存目录消费端：下载默认路径拼接（对齐原 aigen L1044 cache_dir 优先语义） ──

test('joinDefaultPath：目录非空 → 目录/文件名（尾分隔符归一）', () => {
  assert.equal(S.joinDefaultPath('D:\\cache', 'montage_1.mp4'), 'D:/cache/montage_1.mp4')
  assert.equal(S.joinDefaultPath('D:\\cache\\', 'montage_1.mp4'), 'D:/cache/montage_1.mp4')
  assert.equal(S.joinDefaultPath('/home/u/cache/', 'render_abc.mp4'), '/home/u/cache/render_abc.mp4')
})

test('joinDefaultPath：目录为空/纯空白 → 原文件名（系统默认位置）', () => {
  assert.equal(S.joinDefaultPath('', 'montage_1.mp4'), 'montage_1.mp4')
  assert.equal(S.joinDefaultPath('   ', 'montage_1.mp4'), 'montage_1.mp4')
})

test('joinDefaultPath：文件名为空 → 空串（不产出「目录/」悬挂路径）', () => {
  assert.equal(S.joinDefaultPath('D:\\cache', ''), '')
  assert.equal(S.joinDefaultPath('', ''), '')
})

// ── S9 系统信息行 ──

test('buildSysInfoRows：os/cpu/ram/disk 四行；local=null → 未检测行', () => {
  const rows = S.buildSysInfoRows({ os: 'Windows 11', cpu: 'i7 (8 核)', ramGb: 16, disk: { freeGb: 120, totalGb: 512 } })
  assert.equal(rows.length, 4)
  assert.deepEqual(rows[0], { label: '操作系统', value: 'Windows 11' })
  assert.deepEqual(rows[1], { label: '处理器', value: 'i7 (8 核)' })
  assert.deepEqual(rows[2], { label: '内存', value: '16 GB' })
  assert.match(rows[3].value, /120 GB/)
  assert.equal(S.buildSysInfoRows(null)[0].label, '系统信息')
  assert.equal(S.buildSysInfoRows({ os: '', cpu: '', ramGb: 0, disk: null }).length, 4)
})
