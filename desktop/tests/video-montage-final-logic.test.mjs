// ══════════════════════════════════════════════════════════════
// video-montage-final-logic.test.mjs — 智能混剪 Step4 纯函数单测
// 运行：node --test "tests/*.test.mjs"
// 对照基准（以原代码为准）：
//   · studio/gui/video_montage_page.py L3983-3995（_get_out_final_dir）、
//     L4073-4112（_collect_mix_candidates）、L4132-4142（_start_final_mix
//     输出命名）、format_time（BGM 播放器时间标签）
// ══════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  resolveOutFinalDir,
  collectMixCandidates,
  buildFinalTasks,
  fmtBgmTime,
  srcDirName,
} = await import('../renderer/src/composables/videoMontageLogic.ts')

// ── resolveOutFinalDir（对照 _get_out_final_dir L3983-3995）──

test('resolveOutFinalDir：含 \\outputs\\ → 同级 final 目录', () => {
  assert.equal(
    resolveOutFinalDir('D:\\cache\\job\\outputs\\a.mp4'),
    'D:\\cache\\job\\final',
  )
})

test('resolveOutFinalDir：父目录为 dubbed/outputs → 再上一级 + final', () => {
  assert.equal(resolveOutFinalDir('D:\\cache\\dubbed\\a.mp4'), 'D:\\cache\\final')
  assert.equal(resolveOutFinalDir('D:\\cache\\outputs\\a.mp4'), 'D:\\cache\\final')
  // 大小写不敏感（原版 lower() 口径）
  assert.equal(resolveOutFinalDir('D:\\cache\\Dubbed\\a.mp4'), 'D:\\cache\\final')
})

test('resolveOutFinalDir：普通目录 → 同级 final；尾斜杠与正斜杠归一', () => {
  assert.equal(resolveOutFinalDir('D:\\x\\y\\a.mp4'), 'D:\\x\\y\\final')
  assert.equal(resolveOutFinalDir('D:\\x\\y\\a.mp4\\'), 'D:\\x\\y\\final')
  assert.equal(resolveOutFinalDir('D:/x/y/a.mp4'), 'D:\\x\\y\\final')
})

// ── collectMixCandidates（对照 _collect_mix_candidates L4073-4112）──

test('collectMixCandidates：dubbed 优先；dubbed 为空回退 outputs 扫描', () => {
  assert.deepEqual(
    collectMixCandidates(['D:\\a\\1.mp4', 'D:\\a\\2.mp4'], ['D:\\b\\3.mp4']),
    ['D:\\a\\1.mp4', 'D:\\a\\2.mp4'],
  )
  assert.deepEqual(
    collectMixCandidates([], ['D:\\b\\3.mp4', 'D:\\b\\4.webm']),
    ['D:\\b\\3.mp4', 'D:\\b\\4.webm'],
  )
})

test('collectMixCandidates：去重保序；空入参/null 安全', () => {
  assert.deepEqual(
    collectMixCandidates(['D:\\a\\1.mp4', 'D:\\a\\1.mp4', 'D:\\a\\2.mp4'], []),
    ['D:\\a\\1.mp4', 'D:\\a\\2.mp4'],
  )
  assert.deepEqual(collectMixCandidates(null, null), [])
  // dubbed 只有空串 → 视为空，走回退
  assert.deepEqual(collectMixCandidates([''], ['D:\\b\\3.mp4']), ['D:\\b\\3.mp4'])
})

// ── buildFinalTasks（对照 _start_final_mix L4132-4142 输出命名）──

test('buildFinalTasks：剥 dubbed_ 前缀 + {src}_final_{name}', () => {
  const r = buildFinalTasks(
    ['D:\\out\\dubbed_01.mp4', 'D:\\out\\clip2.mp4'],
    '我的素材',
    'D:\\out\\final',
  )
  assert.deepEqual(r, [
    { videoPath: 'D:\\out\\dubbed_01.mp4', outPath: 'D:\\out\\final\\我的素材_final_01.mp4' },
    { videoPath: 'D:\\out\\clip2.mp4', outPath: 'D:\\out\\final\\我的素材_final_clip2.mp4' },
  ])
})

test('buildFinalTasks：srcName 为空 → final_{name}；outDir 尾反斜杠归一', () => {
  const r = buildFinalTasks(['D:\\out\\01.mp4'], '', 'D:\\out\\final\\')
  assert.deepEqual(r, [{ videoPath: 'D:\\out\\01.mp4', outPath: 'D:\\out\\final\\final_01.mp4' }])
})

// ── fmtBgmTime（原版 format_time：ms → mm:ss）──

test('fmtBgmTime：ms → mm:ss；负数/非数字按 0', () => {
  assert.equal(fmtBgmTime(0), '00:00')
  assert.equal(fmtBgmTime(65000), '01:05')
  assert.equal(fmtBgmTime(125000), '02:05')
  assert.equal(fmtBgmTime(-5), '00:00')
  assert.equal(fmtBgmTime(NaN), '00:00')
})

// ── srcDirName（对照 _start_final_mix L4133 basename(rstrip("/\"))）──

test('srcDirName：取目录 basename，剥尾部分隔符', () => {
  assert.equal(srcDirName('D:\\cache\\job\\outputs'), 'outputs')
  assert.equal(srcDirName('D:\\cache\\job\\outputs\\'), 'outputs')
  assert.equal(srcDirName('D:/cache/job/outputs/'), 'outputs')
  assert.equal(srcDirName(''), '')
})
