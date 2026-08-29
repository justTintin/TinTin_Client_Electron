// ═══════════════════════════════════════════════════════════════
// env-detect.js — 本地资源检测核（条目⑪ 环境检测口径重定义）
// 纯 Node 模块（不 require electron），依赖注入可单测。
// 口径对照原客户端 gui/env_config_page.py check_environment L412-513：
//   · ffmpeg 检测（原 L438-461）：候选路径存在性 → shutil.which('ffmpeg')
//     PATH 兜底。新客户端路径规则与 main/ffmpeg-gate.js getBinDir 同源：
//     打包 process.resourcesPath/bin → 开发 studioRoot/bin/win → PATH。
//   · 硬件信息（原 L495-510）：os/cpu/ram 轻量项保留（Node os 内建）；
//     gpu 弃检（需原生枚举，新端无本地 GPU 计算栈，A2 卡已有自检）。
//   · Python/CUDA/PyTorch/VSR 内嵌环境（原 L414-473）：新端无 Python /
//     字幕移除服务端化，弃检（VoxCPM/OCR/llm 等归服务端能力健康行）。
//   · 磁盘可用空间：新增轻量项（原版无；下载/混剪缓存容量预警需要），
//     fs.promises.statfs 统计 statPath 所在卷，失败（旧内核/权限）→ null。
// ═══════════════════════════════════════════════════════════════
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

/** PATH 兜底查找（Node 无 shutil.which，用 where Windows / which Unix） */
function whichAsync(exe) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    try {
      execFile(cmd, [exe], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (err || !stdout) return resolve('')
        resolve(String(stdout).split(/\r?\n/)[0].trim())
      })
    } catch (_) { resolve('') }
  })
}

/**
 * ffmpeg 检测（对齐原 L438-461 语义：候选路径 → which 兜底）
 * deps 注入：resourcesPath / studioRoot / fs / path / which
 */
async function detectFfmpegPath(deps = {}) {
  const _fs = deps.fs || fs
  const _path = deps.path || path
  const candidates = []
  // 打包后：resources/bin/（与 ffmpeg-gate.getBinDir 同源规则）
  if (deps.resourcesPath) candidates.push(_path.join(deps.resourcesPath, 'bin', 'ffmpeg.exe'))
  // 开发模式：studioRoot/bin/win/
  if (deps.studioRoot) candidates.push(_path.join(deps.studioRoot, 'bin', 'win', 'ffmpeg.exe'))
  for (const c of candidates) {
    try {
      if (_fs.existsSync(c) && _fs.statSync(c).isFile()) return { ok: true, path: c }
    } catch (_) { /* 候选探测失败继续下一个 */ }
  }
  const hit = typeof deps.which === 'function' ? await deps.which('ffmpeg') : await whichAsync('ffmpeg')
  if (hit) return { ok: true, path: hit }
  return { ok: false, path: '' }
}

/**
 * 本地资源聚合检测：ffmpeg + os + cpu + ram + 磁盘可用空间
 * @param {object} deps 注入：os/fs/which/statfs/statPath/resourcesPath/studioRoot
 */
async function detectLocalResources(deps = {}) {
  const _os = deps.os || os
  const _fs = deps.fs || fs
  const out = {
    ffmpeg: { ok: false, path: '' },
    os: '未知',
    cpu: '未知',
    ramGb: 0,
    disk: null, // { freeGb, totalGb } | null（获取失败 = unknown 行）
  }
  out.ffmpeg = await detectFfmpegPath(deps)
  try {
    out.os = typeof _os.version === 'function' ? _os.version() : `${_os.platform()} ${_os.release()}`
  } catch (_) { /* 保持 未知 */ }
  try {
    const cpus = _os.cpus() || []
    out.cpu = cpus.length ? `${cpus[0].model} (${cpus.length} 核)` : '未知'
  } catch (_) { /* 保持 未知 */ }
  try {
    out.ramGb = Math.round((_os.totalmem() / 1024 ** 3) * 10) / 10
  } catch (_) { /* 保持 0 */ }
  const statPath = deps.statPath
  if (statPath) {
    try {
      const st = typeof deps.statfs === 'function'
        ? await deps.statfs(statPath)
        : await fs.promises.statfs(statPath)
      const bsize = Number(st.bsize) || 4096
      const freeGb = Math.round((Number(st.bavail) * bsize / 1024 ** 3) * 10) / 10
      const totalGb = Math.round((Number(st.blocks) * bsize / 1024 ** 3) * 10) / 10
      out.disk = { freeGb, totalGb }
    } catch (_) { /* 保持 null → UI unknown 行 */ }
  }
  return out
}

module.exports = { detectFfmpegPath, detectLocalResources, whichAsync }
