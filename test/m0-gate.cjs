// test/m0-gate.cjs — 剪映互通 M1 复测驱动脚本（可复现）
// 用法：node test/m0-gate.cjs
// 1) 清理旧「M0闸门测试_tintin」草稿（文件夹+索引条目）
// 2) 用 v2 完整 schema 导出双片段草稿（转场+字幕+关键词轨+BGM）+ 封面
// 3) registerInRootMeta 登记首页索引（内含备份）
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..')
const JY = require(path.join(REPO, 'desktop/main/jianying-exporter.js'))

const FFPROBE = 'ffprobe'
const FFMPEG = path.join(REPO, 'resources', 'bin', 'ffmpeg.exe')

function probeMedia(fp) {
  const dur = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fp], { encoding: 'utf-8' }).trim()
  const wh = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', fp], { encoding: 'utf-8' }).trim()
  const [w, h] = wh.split(',').map((x) => Math.round(parseFloat(x)))
  return { durationSec: parseFloat(dur) || 0, width: w || 1080, height: h || 1920 }
}

const workDir = path.join(REPO, 'test', 'm0-out')
fs.mkdirSync(workDir, { recursive: true })

const srt1 = path.join(workDir, 'seg1.srt')
const srt2 = path.join(workDir, 'seg2.srt')
// cue 时长须匹配片段实际时长（3s each），越界 cue 会被按段边界钳掉
fs.writeFileSync(srt1, `1\n00:00:00,200 --> 00:00:01,600\n只要199元 超值套装\n\n2\n00:00:01,800 --> 00:00:02,900\n快充技术 告别续航焦虑\n`, 'utf-8')
fs.writeFileSync(srt2, `1\n00:00:00,200 --> 00:00:01,500\n第二代升级 续航翻倍\n\n2\n00:00:01,700 --> 00:00:02,800\n今天下单立减三百\n`, 'utf-8')

const videoPaths = [
  path.join(REPO, 'test', 'probe-allfx-in.mp4'),
  path.join(REPO, 'test', 'probe-mute-in.mp4'),
]
const bgmPath = path.join(REPO, 'test', 'probe-bgm.mp3')
const draftName = 'M0闸门测试_tintin'

// 1) 清理旧测试草稿（文件夹 + 索引条目）
const draftRoot = JY.getDefaultDraftRoot()
const rootMetaPath = path.join(draftRoot, 'root_meta_info.json')
try {
  const rootMeta = JSON.parse(fs.readFileSync(rootMetaPath, 'utf-8'))
  const stale = (rootMeta.all_draft_store || []).filter((e) => e && e.draft_name === draftName)
  for (const e of stale) {
    try { fs.rmSync(e.draft_fold_path, { recursive: true, force: true }); console.log('[M1] 已移除旧草稿文件夹:', e.draft_fold_path) } catch (_) {}
  }
  if (stale.length) {
    rootMeta.all_draft_store = (rootMeta.all_draft_store || []).filter((e) => e && e.draft_name !== draftName)
    fs.writeFileSync(rootMetaPath, JSON.stringify(rootMeta, null, 2), 'utf-8')
    console.log('[M1] 已移除旧索引条目:', stale.length, '条')
  }
} catch (e) { console.warn('[M1] 清理旧草稿失败（继续）:', e.message) }

// 2) v2 导出（M2a：文字入场动画 + 花字原生效果随行）
const res = JY.exportMultiToDraft({
  videoPaths,
  transitions: 'fade',
  bgmPath,
  bgmVolume: 50,
  srtPaths: [srt1, srt2],
  fxWords: ['199元', '快充'],
  fxKinds: ['fancy', 'tpl'],
  textAnim: '复古打字机',
  fancyEffectId: '7495312625169911065', // resources/fancy/templates/jy_7495312625169911065.json 的花字效果 id
  draftName,
  deps: { probeMedia },
})
if (!res.success) { console.error('[M1] 生成失败:', res.message); process.exit(1) }
const draftFolder = res.message
console.log('[M1] 草稿已生成(v2 schema):', draftFolder)
console.log('[M1] schemaVersion:', JSON.stringify(res.schemaVersion))

// 3) 封面
const cover = path.join(draftFolder, 'draft_cover.jpg')
try {
  execFileSync(FFMPEG, ['-y', '-ss', '1', '-i', videoPaths[0], '-frames:v', '1', '-q:v', '3', cover], { stdio: 'pipe' })
  console.log('[M1] 封面已生成:', cover)
} catch (e) { console.warn('[M1] 封面生成失败（继续，cover 置空）:', e.message) }

// 4) 登记首页索引
const totalUs = Math.round((probeMedia(videoPaths[0]).durationSec + probeMedia(videoPaths[1]).durationSec) * 1e6)
const reg = JY.registerInRootMeta({ draftFolder, draftName, durationUs: totalUs, coverPath: fs.existsSync(cover) ? cover : '' })
console.log('[M1] 索引已登记，备份 →', reg.backupPath)
console.log('[M1] 完成。')
