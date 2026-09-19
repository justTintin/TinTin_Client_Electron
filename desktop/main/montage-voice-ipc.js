// ═══════════════════════════════════════════════════════════════
// montage-voice-ipc.js — 智能混剪 Step3「口播配音」域 IPC
// 对照原客户端（studio/gui/montage/）：
//   · workers/voice_workers.py  VoiceCloneWorker（api 模式）→ voice:cloneBatch
//     （2026-09-09 用户裁决：整句 TTS（原版逐句+句间 0.15s 静音拼接）+ 变速 atempo
//     + .timing.json 句级时间轴估算）
//   · workers/concat_workers.py VideoDubbingWorker → voice:dubVideos
//     （ffmpeg 字幕烧制/花字/tpad/atempo 链/替换原声）
//   · video_montage_page.py     _do_scan_voice_video_dir L1621-1695 → voice:scanDir
//   · _refresh_server_fonts     GET /config/fonts → voice:fonts
//   · _on_btn_export_clicked    shutil.copy2 → voice:exportAudio
// 契约（禁止臆造）：POST /indextts/tts（2026-09-05 用户告知：服务端将删除全部 /voxcpm/* 接口，
//   口播配音通道随声音克隆裁决统一切 IndexTTS）
//   IndexTTSRequest = {"text": 预处理后, "prompt_audio": base64|null}（无 speaker 字段；
//   lang/duration_factor/emo_text/emo_alpha 不传用服务端默认），响应 WAV 二进制，超时 180s，
//   3 次重试（503/连接中断 → /indextts/health 轮询恢复，max_wait 20s/15s）。
//   原版 inference_timesteps/cfg_value 存而不用（不发送服务端，原版同口径）。
// 纯函数在 voice-tts-logic.js（本文件仅编排与进程/文件 IO）。
// ═══════════════════════════════════════════════════════════════

'use strict'

const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./voice-tts-logic')
const FT = require('./fancy-templates')

// ── ffmpeg/ffprobe 路径（同 ffmpeg-gate.js getBinDir 口径，未导出故本地等价实现）──
function getBinDir() {
  if (process.resourcesPath) {
    const pkgBin = path.join(process.resourcesPath, 'bin')
    if (fs.existsSync(pkgBin)) return pkgBin
  }
  const devBin = path.resolve(__dirname, '..', 'resources', 'bin', 'win')
  if (fs.existsSync(devBin)) return devBin
  return ''
}

function getFfmpegPath() {
  const binDir = getBinDir()
  if (binDir) {
    const exe = path.join(binDir, 'ffmpeg.exe')
    if (fs.existsSync(exe)) return exe
  }
  return 'ffmpeg'
}

function getFfprobePath() {
  const binDir = getBinDir()
  if (binDir) {
    const exe = path.join(binDir, 'ffprobe.exe')
    if (fs.existsSync(exe)) return exe
  }
  return 'ffprobe'
}

/** 媒体时长（秒）（对照 utils_media.py get_media_duration L168-183：ffprobe format=duration） */
function getMediaDuration(filepath) {
  try {
    const out = execSync(
      `"${getFfprobePath()}" -v error -show_entries format=duration -of csv=p=0 "${filepath}"`,
      { timeout: 10000, windowsHide: true, encoding: 'utf-8' },
    ).trim()
    if (out) return parseFloat(out) || 0.0
  } catch (_) { /* 原版失败返回 0.0 */ }
  return 0.0
}

/** ffmpeg 运行（对照 utils_media change_audio_speed / VideoDubbingWorker _run_proc 口径） */
function runFfmpeg(args) {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (c) => { stderr += c })
    proc.on('close', (code) => resolve({ code, stderr }))
    proc.on('error', (e) => resolve({ code: -1, stderr: String(e) }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 2026-09-19 字幕对齐增强（用户报障：字幕落后声音约半秒）──
// 背景：整句合成后 timing 按句字数比例估算，与真实语音节奏（起音延迟/标点停顿/
//   语速起伏）存在 ±0.5s 漂移。此处用 ffmpeg silencedetect 实测 wav 的静音/语音
//   边界：句窗口整体平移+缩放到实测语音跨度，实测内部停顿数=句数-1 时句界
//   吸附到停顿中点；任何失败回退原估算 timing（既有行为不变）。

/** 解析 silencedetect stderr → 静音区间；推导 leadIn/tailOut/句间停顿（单位秒）。无法判定返回 null */
function parseSilencedetect(stderr, totalDur) {
  const silences = []
  for (const line of String(stderr).split(/\r?\n/)) {
    let m = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (m) { silences.push({ start: Math.max(0, Number(m[1])), end: totalDur }); continue }
    m = /silence_end:\s*([\d.]+)/.exec(line)
    if (m && silences.length) silences[silences.length - 1].end = Number(m[1])
  }
  const speech = []
  let pos = 0
  for (const s of silences) {
    if (s.start - pos >= 0.06) speech.push({ start: pos, end: s.start })
    pos = Math.max(pos, s.end)
  }
  if (totalDur - pos >= 0.06) speech.push({ start: pos, end: totalDur })
  if (!speech.length || !silences.length) return null // 全静音/无静音：无可对齐边界
  const leadIn = speech[0].start
  const tailOut = Math.max(0, totalDur - speech[speech.length - 1].end)
  const gaps = []
  for (let i = 1; i < speech.length; i++) {
    const g0 = speech[i - 1].end, g1 = speech[i].start
    if (g1 - g0 >= 0.18) gaps.push({ mid: Math.round(((g0 + g1) / 2) * 1000) / 1000 })
  }
  return { leadIn, tailOut, gaps }
}

/** 实测对齐：句窗口平移 leadIn、按实测语音跨度缩放；实测内部停顿数=句数-1 时句界吸附停顿中点 */
function alignTimingToSpeech(timing, m, totalDur) {
  if (!Array.isArray(timing) || !timing.length || !m) return timing
  // 2026-09-19 防御（用户报障：timing 全零）：测量对象必须带有限数值边界——
  // 非法（如误传 Promise/解析残缺）时原样返回估算 timing，不产出 NaN/null
  if (!Number.isFinite(m.leadIn) || !Number.isFinite(m.tailOut) || !Number.isFinite(totalDur)) return timing
  const span = Math.max(0.2, totalDur - m.leadIn - m.tailOut)
  const scale = span / Math.max(0.2, totalDur)
  const r3 = (x) => Math.round(x * 1000) / 1000
  const out = timing.map((t) => ({
    text: t.text,
    start: r3(m.leadIn + t.start * scale),
    end: r3(m.leadIn + t.end * scale),
  }))
  const gaps = m.gaps || []
  if (gaps.length === out.length - 1) {
    for (let j = 0; j < gaps.length; j++) {
      const mid = r3(gaps[j].mid)
      out[j].end = mid
      out[j + 1].start = mid
    }
    const last = out[out.length - 1]
    last.end = Math.max(last.start + 0.2, r3(totalDur - m.tailOut))
  }
  return out
}

/** 实测 wav 语音边界（ffmpeg silencedetect；失败返回 null → 回退估算 timing） */
async function detectSpeechBounds(wavPath, totalDur) {
  const { code, stderr } = await runFfmpeg([
    '-hide_banner', '-nostats', '-i', wavPath,
    '-af', 'silencedetect=noise=-35dB:d=0.25',
    '-f', 'null', '-',
  ])
  if (code !== 0 || !stderr) return null
  return parseSilencedetect(String(stderr), totalDur)
}

// ── Windows 注册表字体族解析（对照 VideoDubbingWorker._lookup_windows_font_file L787-824）──
// reg query 枚举 Fonts 键值；值名形如 "Microsoft YaHei (TrueType)" → 去 " (" 后缀，
// 复合族名按 " & " 拆分逐段精确比较（防误选字重）。
function lookupWindowsFontFile(family) {
  const target = String(family || '').trim().toLowerCase()
  if (!target || process.platform !== 'win32') return ''
  const fontsDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts')
  for (const root of ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
    try {
      const out = execSync(`reg query "${root}"`, { encoding: 'utf-8', windowsHide: true })
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.match(/^\s*(.+?)\s+REG_SZ\s+(.+?)\s*$/)
        if (!m) continue
        const regFamily = m[1].replace(/\s+\($/, '').trim()
        const parts = regFamily.split('&').map((p) => p.trim().toLowerCase()).filter(Boolean)
        if (!parts.includes(target)) continue
        const full = path.join(fontsDir, m[2])
        if (fs.existsSync(full)) return full
      }
    } catch (_) { continue }
  }
  return ''
}

function createMontageVoiceIpc(ipcMain, { httpRequest, isExpectedOfflineError, getServerUrl }) {

  // ── voice:scanDir — 扫描视频输入目录（_do_scan_voice_video_dir L1621-1695 口径）──
  // exts 无 .flv（.mp4/.mkv/.avi/.mov/.webm/.m4v）；basename 小写字典序；
  // 自动检测 voices/voice_{i+1}.wav 已生成；伴随同名 .txt 读入 original_texts。
  ipcMain.handle('voice:scanDir', async (_e, payload) => {
    try {
      const p = payload || {}
      const dirPath = String(p.dirPath || '').trim()
      const selected = Array.isArray(p.selectedFiles) ? p.selectedFiles : []
      if (!dirPath || !fs.existsSync(dirPath)) return { files: [], voicesDir: '' }

      // _cleanup_stale_montage_outputs L597-634 一比一：进入第③步时传入本次确认列表，
      // 删除 outputs 里不属于本次列表的旧 montage_concat_* 产物（含附属同名文件），
      // 避免配音列表把历次合成的旧视频全扫进来（原版「34个变9个」根因）
      const keepFiles = Array.isArray(p.keepFiles) ? p.keepFiles : []
      if (keepFiles.length) {
        try {
          const keepStems = new Set()
          for (const pf of keepFiles) {
            const stem = path.resolve(pf).replace(/\.[^.]+$/, '')
            keepStems.add(stem)
            keepStems.add(stem + '_sources')
            keepStems.add(stem + '.meta')
          }
          for (const f of fs.readdirSync(dirPath)) {
            if (!f.startsWith('montage_concat_')) continue // 只动混剪专属命名，不碰用户其它视频
            const full = path.resolve(path.join(dirPath, f))
            if (keepStems.has(full.replace(/\.[^.]+$/, ''))) continue
            try { fs.unlinkSync(full) } catch (_) { /* 删除失败按原版仅告警口径忽略 */ }
          }
        } catch (_) { /* 清理失败不阻断扫描 */ }
      }

      const exts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']
      let files = []
      // 显式选中的文件若仍在当前目录 → 原样使用（L1648-1653 口径）
      if (selected.length) {
        const firstParent = path.resolve(path.dirname(selected[0]))
        if (firstParent === path.resolve(dirPath)) files = selected.map((f) => path.resolve(f))
      }
      if (!files.length) {
        try {
          for (const f of fs.readdirSync(dirPath)) {
            if (exts.some((e) => f.toLowerCase().endsWith(e))) files.push(path.join(dirPath, f))
          }
        } catch (err) {
          return { error: `扫描视频目录失败: ${err.message}` }
        }
      }
      files.sort((a, b) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase()))

      const voicesDir = path.join(L.resolveOutMontageDir(dirPath), 'voices')
      // 配音产物重关联（2026-09-15 用户报障：dubbedPath 为会话态，重启后丢失 →
      // collectCandidates 回退未配音的第二步产物，导出时间轴静默丢口播）。
      // 配音产物固定落 <montage_cache>/dubbed/dubbed_<视频名>，存在即回填。
      const dubbedDir = path.join(path.dirname(voicesDir), 'dubbed')
      const items = files.map((filepath, i) => {
        const expectedWav = path.join(voicesDir, `voice_${i + 1}.wav`)
        let originalText = ''
        const txtPath = filepath.replace(/\.[^.]+$/, '') + '.txt'
        try {
          if (fs.existsSync(txtPath)) originalText = fs.readFileSync(txtPath, 'utf-8').trim()
        } catch (_) { /* 读失败按空 */ }
        const dubbedCand = path.join(dubbedDir, 'dubbed_' + path.basename(filepath))
        return {
          path: filepath,
          name: path.basename(filepath),
          wavPath: fs.existsSync(expectedWav) ? expectedWav : '',
          dubbedPath: fs.existsSync(dubbedCand) ? dubbedCand : '',
          originalText,
          // 原版行构建时逐行 get_media_duration(filepath)（dialogs.py L1850 口径）
          durationSec: getMediaDuration(filepath),
          // 克隆音频时长（voice_audio_durations 口径）：已生成 wav 顺带探测，
          // 返回 Step3 重建行时绿字不再回退 --:--（2026-09-10 用户报障修复）
          voiceDurSec: fs.existsSync(expectedWav) ? getMediaDuration(expectedWav) : 0,
        }
      })
      return { files: items, voicesDir }
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── TTS 单次请求（对照 _post_tts L140-188：180s 超时、3 次重试、恢复轮询）──
  // IndexTTSRequest 口径：无 speaker 字段（voxcpm 遗留）；extra = 克隆参数
  //  （duration_factor/emo_text/emo_alpha，2026-09-09 用户裁决「设置声音克隆」弹窗配置）
  // 停顿标记保护（2026-09-08 服务端句间停顿标记）：text 里的 ((pause=N)) 不得进
  //  preprocessTtsText（数字会被转中文、字母会被拆分），按标记切分逐段预处理后原样拼回。
  const PAUSE_MARK_RE = /\(\(pause=\d+\)\)/g
  function preprocessTtsKeepingPause(text) {
    if (!PAUSE_MARK_RE.test(text)) return L.preprocessTtsText(text)
    PAUSE_MARK_RE.lastIndex = 0
    return String(text)
      .split(/((?:\(\(pause=\d+\)\)))/)
      .map((p) => (/^\(\(pause=\d+\)\)$/.test(p) ? p : L.preprocessTtsText(p)))
      .join('')
  }
  async function postTts(apiUrl, text, refAudioB64, extra) {
    const payload = {
      text: preprocessTtsKeepingPause(text),
      prompt_audio: refAudioB64 || null,
      ...(extra || {}),
    }
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await httpRequest('POST', apiUrl, { body: payload, timeout: 180000 })
        // httpRequest 非 2xx 会 reject（err.status/err.response），2xx 返回 {data,status,raw}
        return res.raw || Buffer.from(JSON.stringify(res.data ?? ''))
      } catch (err) {
        const status = err && err.status
        const connReset = isExpectedOfflineError(err)
        if (status !== 503 && !connReset) {
          // 确定性错误直接抛（原版非 503 ApiError 直接 raise）
          throw new Error(`TTS 请求失败 HTTP ${status || '—'}: ${formatHttpErr(err)}`)
        }
        if (attempt < maxAttempts) {
          // 连接中断 → 等恢复（20s）；503 繁忙 → 等 15s；均带 /health 轮询
          await waitForServerRecovery(apiUrl, connReset ? 20.0 : 15.0)
          await sleep(2000)
          continue
        }
        throw new Error(`TTS 请求失败（已重试 ${maxAttempts} 次）: ${formatHttpErr(err)}`)
      }
    }
    throw new Error('TTS 请求失败')
  }

  function formatHttpErr(err) {
    if (!err) return '(无输出)'
    if (err.response !== undefined && err.response !== null) {
      const body = typeof err.response === 'string' ? err.response : JSON.stringify(err.response)
      return `HTTP ${err.status || ''} ${body}`.trim()
    }
    return err.message || String(err)
  }

  /** 连接中断后轮询 /health 等恢复（对照 _wait_for_server_recovery L57-72） */
  async function waitForServerRecovery(apiUrl, maxWait) {
    const health = L.deriveHealthUrl(apiUrl)
    if (!health) { await sleep(Math.min(3000, maxWait * 1000)); return false }
    const deadline = Date.now() + maxWait * 1000
    while (Date.now() < deadline) {
      try {
        const r = await httpRequest('GET', health, { timeout: 3000 })
        const d = typeof r.data === 'object' ? r.data : {}
        if (r.status === 200 && d.loaded) return true
      } catch (_) { /* 轮询期内失败继续 */ }
      await sleep(2000)
    }
    return false
  }

  /**
   * 合成一条文案为 wav（2026-09-09 用户裁决：整句合成——原版为逐句合成后拼接，
   *   句间固定插 0.15s 静音（_concat_wav_bytes gap_sec=0.15，不可配置）；整句化后
   *   句间停顿由模型按标点自然处理。.timing.json 仍按句估算写入（字幕烧制逐行时间轴依赖）。
   * 2026-09-08 服务端新增句间停顿标记（仅 indextts，写在 text 里）：((pause=毫秒)) / 连续
   *   空格 / 换行；服务端按标记拆段逐段推理后插精确静音拼接，无标记走单段路径（零开销）。
   *   pauseMs>0 时在句界插入显式标记（用户可调，替代原版固定 0.15s），>0 会多段推理、
   *   长文案耗时线性增加（文档明示）。
   */
  async function synthesizeItem(text, refAudioB64, outWavPath, apiUrl, emit, extra, pauseMs) {
    const segs = L.splitSentences(text)
    let mergedText = text.trim()
    const pause = Math.max(0, Math.round(Number(pauseMs ?? 0) || 0))
    if (pause > 0 && segs.length > 1) {
      // 句界插显式停顿标记（splitSentences 保留句尾标点，直接 join）
      mergedText = segs.join(`((pause=${pause}))`)
    } else if (mergedText.includes('\n')) {
      // 整句合成：多行文案用「。」连接为一次 TTS 请求（单句路径零开销）
      mergedText = mergedText.split('\n').map((l) => l.trim()).filter(Boolean).join('。') + '。'
    }
    emit?.({ stage: '正在合成语音...' })
    const content = L.repairWavBytes(await postTts(apiUrl, mergedText, refAudioB64, extra))
    fs.writeFileSync(outWavPath, content)
    try {
      const totalDur = L.wavBytesDuration(content)
      // 2026-09-18 用户裁决：停顿感知 timing——句界精确扣除/加回 pause 量，
      // 字幕句界不再因停顿均摊漂移（单句/无停顿等价旧口径）
      let timing = segs.length <= 1
        ? [{ text: mergedText, start: 0, end: Math.round(totalDur * 1000) / 1000 }]
        : L.buildPauseAwareTiming(segs, totalDur, pause)
      // 2026-09-19 字幕对齐增强（用户报障：字幕落后声音约半秒）：silencedetect
      //   实测语音起止与句间停顿，句窗口平移/缩放 + 句界吸附到实测停顿中点——
      //   消除字数比例估算与真实语音节奏的 ±0.5s 漂移；任何失败回退估算 timing。
      try {
        // 2026-09-19 修复（用户报障：预览词条/字幕全挤在 0 点）：此处必须 await——
        // detectSpeechBounds 是 async，裸调用返回 Promise（真值）→ alignTimingToSpeech
        // 拿到 Promise 当测量结果 → leadIn/tailOut=undefined → 全 NaN → JSON 序列化为
        // null → 变速时 scaleTimingSidecar Number(null)=0 → timing 整条清零
        const measured = await detectSpeechBounds(outWavPath, totalDur)
        if (measured) timing = alignTimingToSpeech(timing, measured, totalDur)
      } catch (_) { /* 实测失败回退估算 timing */ }
      writeTimingSidecar(outWavPath, timing)
    } catch (_) { /* 写时间轴失败不阻断（原版 OSError 兜底） */ }
  }

  // ── voice:cloneBatch — 批量克隆人声（VoiceCloneWorker.run L330-412 口径）──
  // 单条失败记录跳过不中断；任务间 sleep 0.3s；变速对齐视频时长（clamp+timing 缩放）。
  ipcMain.handle('voice:cloneBatch', async (event, payload) => {
    try {
      const p = payload || {}
      const tasks = Array.isArray(p.tasks) ? p.tasks : []
      if (!tasks.length) throw new Error('voice:cloneBatch requires tasks[]')
      // 2026-09-05：服务端将删除 /voxcpm/*，口播配音恒走 /indextts/tts（与声音克隆同通道）
      const apiUrl = String(p.apiUrl || '').trim() || (getServerUrl().replace(/\/$/, '') + '/indextts/tts')
      const speedMin = Number(p.speedMin ?? 0.9)
      const speedMax = Number(p.speedMax ?? 1.2)
      // 克隆参数（渲染层「设置声音克隆」弹窗配置；契约同声音克隆页 /indextts/tts）
      const tp = p.ttsParams || {}
      const ttsExtra = {
        duration_factor: Number(tp.durationFactor ?? 1.0),
        ...(String(tp.emoText || '').trim() ? { emo_text: String(tp.emoText).trim() } : {}),
        emo_alpha: Number(tp.emoAlpha ?? 0.5),
      }
      // 句间停顿（2026-09-08 服务端停顿标记）：毫秒值写在 text 里，不进请求载荷
      const pauseMs = Math.max(0, Math.round(Number(tp.pauseMs ?? 0) || 0))
      const channel = p.progressChannel || ''

      let refAudioB64 = null
      const refAudioPath = String(p.refAudioPath || '')
      if (refAudioPath && fs.existsSync(refAudioPath)) {
        refAudioB64 = fs.readFileSync(refAudioPath).toString('base64')
      } else if (p.refAudioUrl) {
        // 参考声音来自服务端样本库（GET /voice/samples 的 audio_url；相对路径拼 serverUrl）
        let u = String(p.refAudioUrl)
        if (!/^https?:/i.test(u)) u = getServerUrl().replace(/\/$/, '') + (u.startsWith('/') ? u : '/' + u)
        const r = await httpRequest('GET', u, { timeout: 30000 })
        refAudioB64 = Buffer.from(r.raw || '').toString('base64')
      }

      const emitRow = (rowIdx, value, stage, extra) => {
        if (channel) event.sender.send(channel, { rowIdx, value, stage, ...(extra || {}) })
      }
      const emitStage = (stage) => {
        if (channel) event.sender.send(channel, { stage })
      }

      const results = {}
      const durations = {} // videoPath → 克隆音频时长（原版 voice_audio_durations 口径）
      const failures = []
      const total = tasks.length
      for (let index = 0; index < total; index++) {
        const t = tasks[index]
        const text = String(t.text || '').trim()
        if (!text) continue
        emitStage(`正在克隆第 ${t.rowIdx + 1} 个声音片段 (${index + 1}/${total})...`)
        emitRow(t.rowIdx, 15)
        try {
          fs.mkdirSync(path.dirname(t.outWavPath), { recursive: true })
          emitRow(t.rowIdx, 50)
          await synthesizeItem(text, refAudioB64, t.outWavPath, apiUrl, (msg) => emitRow(t.rowIdx, 50, msg.stage), ttsExtra, pauseMs)
          emitRow(t.rowIdx, 90)

          // 变速对齐视频时长（L364-380 口径；clamp [speedMin, speedMax]）
          if (t.videoPath && fs.existsSync(t.videoPath) && ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v'].includes(path.extname(t.videoPath).toLowerCase())) {
            const vidDur = getMediaDuration(t.videoPath)
            const audDur = getMediaDuration(t.outWavPath)
            const adj = L.computeSpeedAdjust(vidDur, audDur, speedMin, speedMax)
            if (adj.should) {
              const tmpWav = t.outWavPath + '.tmp.wav'
              const r = await runFfmpeg(['-y', '-i', t.outWavPath, '-filter:a', `atempo=${adj.ratio}`, tmpWav])
              if (r.code === 0 && fs.existsSync(tmpWav) && fs.statSync(tmpWav).size > 0) {
                fs.renameSync(tmpWav, t.outWavPath)
                // 音频变速后句级时间轴同步缩放（atempo=X → 时长×1/X，L379-380）
                scaleTimingSidecar(t.outWavPath, 1.0 / adj.ratio)
              }
            }
            // 2026-09-18 用户裁决：凑长度手段替代句间停顿——变速 clamp 拉满仍短于
            //   视频时 apad 尾部补静音至视频时长（内部语句节奏零改动，timing/字幕
            //   不受影响；尾部静音本无字幕，口播轨时长覆盖整段视频）
            const audDur2 = getMediaDuration(t.outWavPath)
            if (vidDur > 0 && audDur2 > 0 && vidDur - audDur2 > 0.05) {
              const tmpPad = t.outWavPath + '.pad.wav'
              const rp = await runFfmpeg(['-y', '-i', t.outWavPath, '-af', 'apad', '-t', String(vidDur), tmpPad])
              if (rp.code === 0 && fs.existsSync(tmpPad) && fs.statSync(tmpPad).size > 0) {
                fs.renameSync(tmpPad, t.outWavPath)
              }
            }
          }

          results[t.videoPath] = t.outWavPath
          durations[t.videoPath] = getMediaDuration(t.outWavPath)
          // 2026-09-11 用户裁决「状态要实时」：完成事件随带 wavPath/时长，渲染层即时
          // 回写该行（此前 wavPath 只在整批返回后统一回写 → 已合成行整批期间仍显示未生成）
          emitRow(t.rowIdx, 100, undefined, { wavPath: t.outWavPath, durSec: durations[t.videoPath] })
        } catch (err) {
          emitRow(t.rowIdx, 0, undefined, { failed: true })
          failures.push({ rowIdx: t.rowIdx, msg: err.message })
          emitStage(`注意： 第 ${t.rowIdx + 1} 个声音克隆失败，已跳过继续...`)
        }
        await sleep(300)
      }
      return { results, durations, failures }
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── fancy:listTemplates — 花字模板列表 + 已缓存预览图（dataURL）──
  // 对照 step3_voice_view.py fancy_template_combo 填充 + _start_fancy_preview_loader。
  // 预览图主进程 ffmpeg 现场生成（ensureTemplatePreview 缓存），渲染层 <img> 直用。
  ipcMain.handle('fancy:listTemplates', async () => {
    try {
      const templates = FT.listFancyTemplates(true).map((tpl) => {
        // 全业务字段回传（渲染层选模板后原样回传给 dubVideos，音效/动画信息不丢）
        const { _path, ...rest } = tpl
        return { ...rest, anim: L.getFancyAnim(tpl), hasSound: !!FT.getFancySoundPath(tpl) }
      })
      const previews = {}
      for (const tpl of templates) {
        const p = FT.templatePreviewPath(tpl.template_id)
        if (fs.existsSync(p) && fs.statSync(p).size > 0) {
          previews[tpl.template_id] = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
        }
      }
      return { templates, previews }
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── fancy:serverTemplates — 服务端花字模板库（GET /fancy/templates）──
  // 对照 docs/CLIENT-FANCY-ACCESS.md：模板管理与渲染在服务端，客户端只做「选择设置」。
  // 响应 {items,total}（openapi 空 schema，宽容解析：数组直收 / items 包裹解包）；
  // 与 voice:fonts 同模式：离线返回 null，渲染层回退本地模板。
  ipcMain.handle('fancy:serverTemplates', async () => {
    try {
      const res = await httpRequest('GET', '/fancy/templates', { timeout: 10000 })
      const data = res.data
      const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
      return { templates: items, total: data?.total ?? items.length }
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      return { error: err.message }
    }
  })

  // ── textfx:serverTemplates — 服务端文字模板库 ──
  // 2026-09-09 用户裁决：文字模板（textfx 动画体系）与花字（fancy 模板）是独立概念，
  // 不得混淆。解析口径同 fancy:serverTemplates（{items,total} 宽容解包，离线 null）。
  // 2026-09-10 实测纠偏：服务端真实路由为 /text_templates/templates（本地契约快照
  // 记录的 /textfx/templates 在服务端从未存在、恒 404，宽容解析误显示为空库）；
  // 返回字段为 id（渲染层口径 template_id），在此归一化，渲染层零改动。
  // 注：2026-09-10 在线契约纠偏：统一合成 POST /montage/concat（multipart）已支持全套
  // text_template_* 字段，不存在也不需要独立「文字模板烧制」接口（所有素材统一合成）；
  // 本 handler 仅供选择/预览，烧制走统一合成字段接入。
  ipcMain.handle('textfx:serverTemplates', async () => {
    try {
      const res = await httpRequest('GET', '/text_templates/templates', { timeout: 10000 })
      const data = res.data
      const raw = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
      const items = raw
        .map((it) => {
          const id = it && (it.id ?? it.template_id ?? it.templateId)
          if (!id) return null
          return { ...it, template_id: String(id) }
        })
        .filter(Boolean)
      return { templates: items, total: data?.total ?? items.length }
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      return { error: err.message }
    }
  })

  // ── textfx:matchKeywords 已删除（2026-09-19 架构：服务端 /text_templates/match 下线，
  // 客户端不再调用关键词命中——词源=产品资料关联关键词（渲染层对字幕行命中），
  // 产品未关联词时渲染层走 LLM 兜底（llm:chat）提词 ──

  // ── fancy:ensurePreviews — 补齐缺失的模板预览图（逐个 ffmpeg 生成，后台调用）──
  // 2026-09-09 对齐：payload.templates 可选传入服务端 /fancy/templates 模板（与本地
  // 同格式，ensureTemplatePreview 按 style 串渲染，与本地模板同一预览口径）。
  ipcMain.handle('fancy:ensurePreviews', async (event, payload) => {
    try {
      const ffmpeg = getFfmpegPath()
      const fontPath = fs.existsSync('C:/Windows/Fonts/msyhbd.ttc')
        ? 'C:/Windows/Fonts/msyhbd.ttc'
        : (fs.existsSync('C:/Windows/Fonts/msyh.ttc') ? 'C:/Windows/Fonts/msyh.ttc' : '')
      const previews = {}
      let generated = 0
      const serverList = Array.isArray(payload && payload.templates) ? payload.templates : []
      const templates = [...FT.listFancyTemplates(true), ...serverList.filter((t) => t && t.template_id)]
      for (let i = 0; i < templates.length; i++) {
        const tpl = templates[i]
        const out = FT.ensureTemplatePreview(tpl, ffmpeg, fontPath)
        if (out) {
          previews[tpl.template_id] = `data:image/png;base64,${fs.readFileSync(out).toString('base64')}`
          generated++
          // 逐个回传进度（对照原版 _FancyPreviewWorker 串行后台生成）
          event.sender.send('fancy:previewProgress', { idx: i + 1, total: templates.length })
        }
      }
      return { previews, generated }
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── voice:dubVideos — 批量替换原声（VideoDubbingWorker.run L843-1456 口径）──
  ipcMain.handle('voice:dubVideos', async (event, payload) => {
    try {
      const p = payload || {}
      const tasks = Array.isArray(p.tasks) ? p.tasks : []
      if (!tasks.length) throw new Error('voice:dubVideos requires tasks[]')
      const channel = p.progressChannel || ''
      const emit = (rowIdx, value, stage) => { if (channel) event.sender.send(channel, { rowIdx, value, stage }) }

      // 字幕字体：族名 → 注册表解析本机字体文件，解析不到回退微软雅黑（L768-785 口径）
      const family = String(p.subtitleFont || '').trim()
      const fontPathEsc = p.addSubtitles
        ? L.resolveSubtitleFontPath(family, {
            familyPath: family ? lookupWindowsFontFile(family) : '',
            path: (cand) => fs.existsSync(cand.replace(/\\:/g, ':')),
          })
        : ''
      // 花字字体：msyhbd.ttc → msyh.ttc → msyh（L930-934 口径）
      const fancyFontPath = fs.existsSync('C:/Windows/Fonts/msyhbd.ttc')
        ? 'C\\:/Windows/Fonts/msyhbd.ttc'
        : (fs.existsSync('C:/Windows/Fonts/msyh.ttc') ? 'C\\:/Windows/Fonts/msyh.ttc' : 'msyh')

      // 花字模板（L1054-1055：非 dict → None=自定义样式）+ 模板音效（缺失静默跳过）
      // 2026-09-09 对齐核实：服务端 /fancy/templates 返回的剪映系模板与本地同格式
      // （style 即 ffmpeg drawtext 样式串），可直接进本地烧制链；anim 缺失时推导。
      let fancyTemplate = null
      if (p.fancyTemplate) {
        try {
          const parsed = typeof p.fancyTemplate === 'string' ? JSON.parse(p.fancyTemplate) : p.fancyTemplate
          if (parsed && typeof parsed === 'object' && parsed.template_id) {
            fancyTemplate = parsed
            // 服务端模板无 anim 字段（本地 listTemplates 时推导）→ 此处补推导，烧制动画不丢
            if (!fancyTemplate.anim) fancyTemplate.anim = L.getFancyAnim(fancyTemplate)
          }
        } catch (_) { fancyTemplate = null }
      }
      const fancySoundPath = fancyTemplate ? FT.getFancySoundPath(fancyTemplate) : ''
      const fancySoundGainDb = fancyTemplate ? FT.getFancySoundGainDb(fancyTemplate) : -6.0

      const results = {}
      const total = tasks.length
      for (let index = 0; index < total; index++) {
        const t = tasks[index]
        emit(index, Math.floor(index / total * 100), `正在进行视频原声替换配音 (${index + 1}/${total})...`)
        try {
          fs.mkdirSync(path.dirname(t.outVideoPath), { recursive: true })
          const lengthMode = (p.lengthModes || {})[t.videoPath] || 'video'
          const videoDur = getMediaDuration(t.videoPath)
          const audioDur = getMediaDuration(t.voiceWavPath)
          // 输入视频预检（run L1155-1161）：ffprobe 读不出时长 = 文件不完整/损坏
          //（如服务端成片下载中断导致 moov 缺失）。立即报明确错误，不带坏文件进 ffmpeg。
          if (videoDur <= 0) {
            throw new Error(
              `输入视频无法读取（文件可能不完整或损坏，常见原因为服务端`
              + `成片下载中断）：${t.videoPath}\n请重新执行镜头合成后再配音。`)
          }
          // .timing.json 句级时间轴（对照 _load_timing_sidecar L826-841：句 text 均非空才有效）
          let timing = null
          try {
            const sidecar = t.voiceWavPath + '.timing.json'
            if (fs.existsSync(sidecar)) {
              const arr = JSON.parse(fs.readFileSync(sidecar, 'utf-8'))
              if (Array.isArray(arr) && arr.length && arr.every((x) => x && x.text)) timing = arr
            }
          } catch (_) { timing = null }

          const args = L.buildDubFFmpegArgs({
            videoPath: t.videoPath,
            voiceWavPath: t.voiceWavPath,
            outputVideoPath: t.outVideoPath,
            text: String(t.text || ''),
            addSubtitles: !!p.addSubtitles,
            lengthMode,
            videoDur,
            audioDur,
            timing,
            fancyText: !!p.fancyText,
            fancyStyle: p.fancyStyle || 'gold',
            // 花字内容已改为自动提取卖点（PR#4），fancyWords 仅兼容保留不再参与渲染
            fancyWords: Array.isArray(p.fancyWords) ? p.fancyWords : [],
            fancyPosition: p.fancyPosition || 'upper_middle',
            // 背景不透明度缺省 20%（2026-09-15 用户裁决，原 0.5）
            subtitleBoxOpacity: p.subtitleBoxOpacity ?? 0.2,
            // 2026-09-09 裁决：字幕/花字特效迁 Step4 统一烧制，配音链只出声音（纯化配音）
            burnEffects: false,
            // 字幕文字样式预设 key（2026-09-09 裁决：样式属字幕配置；主进程 SUBTITLE_STYLES 查表）
            subtitleStyle: String(p.subtitleStyle || 'white'),
            // 服务端 /subtitle_styles 完整样式对象（2026-09-17 用户裁决：字幕样式统一
            // 来自服务端；配音链 burnEffects=false 不烧字幕，此处透传保持与 Step4 烧制链对称）
            subtitleStyleObj: (p.subtitleStyleObj && typeof p.subtitleStyleObj === 'object') ? p.subtitleStyleObj : null,
            subtitleAnim: String(p.subtitleAnim || 'fade'),
            fancyTemplate,
            fancySoundPath,
            fancySoundGainDb,
            subtitleFontPath: fontPathEsc,
            fancyFontPath,
          })
          const r = await runFfmpeg(args)
          if (r.code !== 0) {
            throw new Error(`视频原声替换配音失败：\n${r.stderr || '(无输出)'}\n命令: ${['ffmpeg', ...args].join(' ')}`)
          }
          results[t.videoPath] = t.outVideoPath
        } catch (err) {
          return { error: err.message, results }
        }
      }
      emit(total - 1, 100, '所有视频替换配音完成！')
      return { results }
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── voice:fonts — 服务端字体列表（对照 _refresh_server_fonts → GET /config/fonts）──
  ipcMain.handle('voice:fonts', async () => {
    try {
      const res = await httpRequest('GET', '/config/fonts', { timeout: 10000 })
      const data = res.data
      const fonts = Array.isArray(data) ? data : (Array.isArray(data?.fonts) ? data.fonts : [])
      return { fonts }
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      return { error: err.message }
    }
  })

  // ── voice:fontFile — 服务端字体文件字节（GET /config/fonts/{font_id}/file；
  // 2026-09-09 用户裁决：字体下拉按自身字体自渲染，FontFace 加载服务端字体文件）──
  ipcMain.handle('voice:fontFile', async (_e, fontId) => {
    const fid = String(fontId || '').trim()
    if (!fid || /[\\/]/.test(fid)) return { error: '非法 font_id' }
    try {
      // httpRequest 保留原始 Buffer（res.raw），非 JSON 二进制响应原样透传
      const res = await httpRequest('GET', `/config/fonts/${encodeURIComponent(fid)}/file`, { timeout: 30000 })
      const buf = res.raw
      if (!buf || !buf.length) return { error: '字体文件为空' }
      return { data: new Uint8Array(buf) }
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      return { error: err.message }
    }
  })

  // ── voice:subtitleStyles — 服务端字幕样式库（2026-09-17 用户裁决：字幕样式统一来自服务端）
  //     GET /subtitle_styles → 返回样式列表，渲染层用于 UI 色板 + 预览；
  //     主进程 buildServerFxFields 用于服务端烧制、serverStyleToDrawtext 用于本地 ffmpeg 烧制。──
  ipcMain.handle('voice:subtitleStyles', async () => {
    try {
      const res = await httpRequest('GET', '/subtitle_styles', { timeout: 10000 })
      const data = res.data
      const styles = Array.isArray(data) ? data : (Array.isArray(data?.styles) ? data.styles : [])
      return { styles }
    } catch (err) {
      if (isExpectedOfflineError(err)) return null
      return { error: err.message }
    }
  })

  // ── voice:exportAudio — 导出克隆声音（对照 _on_btn_export_clicked shutil.copy2）──
  ipcMain.handle('voice:exportAudio', async (_e, payload) => {
    try {
      const p = payload || {}
      if (!p.srcPath || !fs.existsSync(p.srcPath)) return { error: '源音频不存在' }
      if (!p.savePath) return { error: '缺少保存路径' }
      fs.copyFileSync(p.srcPath, p.savePath)
      return { ok: true, savePath: p.savePath }
    } catch (err) {
      return { error: err.message }
    }
  })
}

function writeTimingSidecar(wavPath, timing) {
  try {
    // 2026-09-19 防御：时间轴必须每行有限且 end>start（text 非空）才落盘——
    // 全零/NaN/null 的 timing 一经写入会被下游（变速缩放/字幕/SRT 资产）放大成
    // 整链污染；非法时跳过写入（下游无 timing 自动回退字数比例估算）
    const rows = Array.isArray(timing) ? timing : []
    const valid = rows.length > 0 && rows.every((x) => x && String(x.text || '').trim()
      && Number.isFinite(Number(x.start)) && Number.isFinite(Number(x.end))
      && Number(x.end) > Number(x.start))
    if (!valid) {
      console.warn('[voice] timing 非法（全零/NaN/空行），跳过写入 sidecar：', wavPath)
      return
    }
    fs.writeFileSync(wavPath + '.timing.json', JSON.stringify(timing, null, 1))
  } catch (_) { /* 对照 _write_timing_sidecar OSError 兜底 */ }
}

function scaleTimingSidecar(wavPath, factor) {
  const p = wavPath + '.timing.json'
  try {
    if (!fs.existsSync(p)) return
    const timing = JSON.parse(fs.readFileSync(p, 'utf-8'))
    // 2026-09-19 防御：仅缩放有限数值行——Number(null)=0 曾把 NaN/null 行批量
    // 清零成数值 0（timing 整链污染的放大器）；非法行原样保留
    let touched = false
    for (const t of timing) {
      const s = Number(t.start), e = Number(t.end)
      if (Number.isFinite(s) && Number.isFinite(e) && (s > 0 || e > 0)) {
        t.start = Math.round(s * factor * 1000) / 1000
        t.end = Math.round(e * factor * 1000) / 1000
        touched = true
      }
    }
    if (touched) fs.writeFileSync(p, JSON.stringify(timing, null, 1))
  } catch (_) { /* 对照 _scale_timing_sidecar 兜底 */ }
}

module.exports = { createMontageVoiceIpc, getFfmpegPath, getFfprobePath, getMediaDuration, lookupWindowsFontFile, parseSilencedetect, alignTimingToSpeech, writeTimingSidecar, scaleTimingSidecar }
