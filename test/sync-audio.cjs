// test/sync-audio.cjs — 音效库/音乐库对齐：剪映本地音频缓存 → 服务端统一音频库（S-A 扫描 + S-B 上传）
// 用法：
//   node test/sync-audio.cjs             # 干跑：扫描/分类/清单，不上传
//   node test/sync-audio.cjs --upload    # 实传（统一库 /audio/library/upload：category=BGM(→音乐)/音效）
// 分类：时长 ≥ 45s → 音乐库(bgm)；< 45s → 音效库(sfx，PANNs 自动分类打标)
// 幂等：manifest（test/m0-out/jy-audio-manifest.json）记录已传 md5 + 服务端文件名存在即跳过
// 注：/sfx/* 与 /audio/bgm/upload 为废弃/旁路通道——统一走 /audio/library（2026-09-12 服务端裁决）
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const SERVER = '192.168.111.31'
const CACHE = path.join(process.env.LOCALAPPDATA, 'JianyingPro', 'User Data', 'Cache', 'music')
const OUT = path.resolve(__dirname, 'm0-out')
const MANIFEST = path.join(OUT, 'jy-audio-manifest.json')
const UPLOAD = process.argv.includes('--upload')
const APP_VERSION = '11.5.5.14461'
const BGM_MIN_SEC = 45

function probe(fp) {
  let dur = 0
  try {
    dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fp], { encoding: 'utf-8', maxBuffer: 1e7 }).trim()) || 0
  } catch (_) {}
  return dur
}

function md5File(fp) {
  return crypto.createHash('md5').update(fs.readFileSync(fp)).digest('hex')
}

// ── S-A 扫描 ──
const files = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter((f) => f.toLowerCase().endsWith('.mp3')) : []
const items = []
for (const f of files) {
  const fp = path.join(CACHE, f)
  const bytes = fs.statSync(fp).size
  const md5 = md5File(fp)
  const dur = probe(fp)
  items.push({ md5, file: fp, bytes, durationSec: Number(dur.toFixed(2)), kind: dur >= BGM_MIN_SEC ? 'bgm' : 'sfx', name: (dur >= BGM_MIN_SEC ? 'jy_bgm_' : 'jy_sfx_') + md5.slice(0, 8) })
}
items.sort((a, b) => a.md5.localeCompare(b.md5))
const bgmN = items.filter((i) => i.kind === 'bgm').length
console.log(`扫描完成：${items.length} 个音频（音乐向 ${bgmN} / 音效向 ${items.length - bgmN}），共 ${(items.reduce((s, i) => s + i.bytes, 0) / 1048576).toFixed(1)}MB`)

// ── manifest（含来源版本三元组 + 上传状态）──
const manifest = fs.existsSync(MANIFEST)
  ? JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'))
  : { source: { app: 'jianying', appVersion: APP_VERSION, cache: 'Cache/music', note: '剪映本机音频缓存同步' }, items: {} }
const prev = manifest.items || {}
let uploadedN = 0
for (const it of items) {
  const old = prev[it.md5]
  if (old && old.uploaded) { it.uploaded = true; uploadedN++ }
}
console.log('manifest 已上传标记:', uploadedN, '个')

function curlUpload(endpoint, name, fp, extraFields) {
  const args = ['-s', '-m', '120', '-X', 'POST']
  for (const [k, v] of Object.entries(extraFields || {})) args.push('-F', `${k}=${v}`)
  args.push('-F', `file=@${fp}`)
  args.push(`http://${SERVER}:8000${endpoint}`)
  return execFileSync('curl', args, { encoding: 'utf-8', maxBuffer: 1e7 })
}

if (!UPLOAD) {
  console.log('（干跑：加 --upload 实传）')
  console.log('样例:', JSON.stringify(items.slice(0, 3), null, 1))
  process.exit(0)
}

// ── S-B 上传（2026-09-12 架构对齐：音效库已并入统一音频库 /audio/library；
//    /sfx/* 仅为兼容层。上传走官方 /audio/library/upload：category=BGM(→音乐)/音效，
//    文件名前缀 bgm_/jy_sfx_ 便于库内检索；幂等=服务端文件名存在即跳过）──
const TAGS = '剪映同步,source=jianying-cache,app=' + APP_VERSION
let okN = 0, failN = 0, skipN = 0
function httpGetJson(p) {
  const out = execFileSync('curl', ['-s', '-m', '30', `http://${SERVER}:8000${p}`], { encoding: 'utf-8', maxBuffer: 1e8 })
  return JSON.parse(out)
}
// 幂等键 = md5 前 8 位指纹（迁移/改名后仍稳定；检查库 JSON 全文是否含该指纹）
function existingLibraryRaw() {
  let raw = ''
  let page = 1
  for (;;) {
    raw += execFileSync('curl', ['-s', '-m', '30', `http://${SERVER}:8000/audio/library?page=${page}&size=500`], { encoding: 'utf-8', maxBuffer: 1e8 })
    page++
    if (page > 20) break
  }
  return raw
}
const existing = UPLOAD ? existingLibraryRaw() : ''
for (const it of items) {
  if (it.uploaded) { skipN++; continue }
  const md5Key = it.md5.slice(0, 8)
  const targetName = (it.kind === 'bgm' ? 'bgm_jy_' : 'jy_sfx_') + md5Key + path.extname(it.file)
  if (existing.includes(md5Key)) { it.uploaded = true; it.serverName = targetName; skipN++; continue }
  try {
    let resp
    const fields = it.kind === 'bgm'
      ? { category: 'BGM', tags: TAGS, share: 'false' }
      : { category: '音效', tags: TAGS }
    const args = ['-s', '-m', '120', '-X', 'POST']
    for (const [k, v] of Object.entries(fields)) args.push('-F', `${k}=${v}`)
    args.push('-F', `file=@${it.file};filename=${targetName}`)
    args.push(`http://${SERVER}:8000/audio/library/upload`)
    resp = execFileSync('curl', args, { encoding: 'utf-8', maxBuffer: 1e7 })
    if (resp.includes('detail')) throw new Error(resp.slice(0, 60))
    it.uploaded = true
    it.serverName = targetName
    it.resp = String(resp).slice(0, 60)
    // 音效走 PANNs 自动分类打标（结果写音频库 audio_analysis）
    if (it.kind === 'sfx') {
      try {
        const id = (JSON.parse(resp).id)
        if (id) execFileSync('curl', ['-s', '-m', '60', '-X', 'POST', `http://${SERVER}:8000/audio/library/${id}/analyze`], { encoding: 'utf-8', maxBuffer: 1e7 })
      } catch (_) {}
    }
    okN++
    console.log(`[${okN + skipN}/${items.length}] 上传 ${it.kind} ${targetName} → ${it.resp.slice(0, 50)}`)
  } catch (e) {
    failN++
    it.error = String(e.message).slice(0, 80)
    console.error('FAIL', it.name, it.error)
  }
  fs.writeFileSync(MANIFEST, JSON.stringify({ source: { app: 'jianying', appVersion: APP_VERSION, cache: 'Cache/music' }, items }, null, 1))
}
console.log(`上传完成: ok=${okN} skip(已传)=${skipN} fail=${failN}`)
