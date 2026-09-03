// ═══════════════════════════════════════════════════════════════
// montage-voice-ipc.js — 智能混剪 Step3「口播配音」域 IPC
// 对照原客户端（studio/gui/montage/）：
//   · workers/voice_workers.py  VoiceCloneWorker（api 模式）→ voice:cloneBatch
//     （逐句 TTS + wav 帧拼接 + 变速 atempo + .timing.json 句级时间轴）
//   · workers/concat_workers.py VideoDubbingWorker → voice:dubVideos
//     （ffmpeg 字幕烧制/花字/tpad/atempo 链/替换原声）
//   · video_montage_page.py     _do_scan_voice_video_dir L1621-1695 → voice:scanDir
//   · _refresh_server_fonts     GET /config/fonts → voice:fonts
//   · _on_btn_export_clicked    shutil.copy2 → voice:exportAudio
// 契约（禁止臆造）：POST /voxcpm/tts
//   {"text": 预处理后, "prompt_audio": base64|null, "speaker": "default"}，超时 180s，
//   3 次重试（503/连接中断 → /health 轮询恢复，max_wait 20s/15s）。
//   api 模式下 inference_timesteps/cfg_value 存而不用（不发送服务端，原版同口径）。
// 纯函数在 voice-tts-logic.js（本文件仅编排与进程/文件 IO）。
// ═══════════════════════════════════════════════════════════════

'use strict'

const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./voice-tts-logic')

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
      const items = files.map((filepath, i) => {
        const expectedWav = path.join(voicesDir, `voice_${i + 1}.wav`)
        let originalText = ''
        const txtPath = filepath.replace(/\.[^.]+$/, '') + '.txt'
        try {
          if (fs.existsSync(txtPath)) originalText = fs.readFileSync(txtPath, 'utf-8').trim()
        } catch (_) { /* 读失败按空 */ }
        return {
          path: filepath,
          name: path.basename(filepath),
          wavPath: fs.existsSync(expectedWav) ? expectedWav : '',
          originalText,
          // 原版行构建时逐行 get_media_duration(filepath)（dialogs.py L1850 口径）
          durationSec: getMediaDuration(filepath),
        }
      })
      return { files: items, voicesDir }
    } catch (err) {
      return { error: err.message }
    }
  })

  // ── TTS 单次请求（对照 _post_tts L140-188：180s 超时、3 次重试、/health 恢复轮询）──
  async function postTts(apiUrl, text, refAudioB64) {
    const payload = {
      text: L.preprocessTtsText(text),
      prompt_audio: refAudioB64 || null,
      speaker: 'default',
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
   * 合成一条文案为 wav（对照 _synthesize_item L273-328 逐行）：
   * 多句 → 逐句合成记句级时间轴（.timing.json）再帧拼接；失败/单句 → 整体合成回退。
   */
  async function synthesizeItem(text, refAudioB64, outWavPath, apiUrl, emit) {
    const gap = 0.15
    const segs = L.splitSentences(text)
    if (segs.length >= 2) {
      try {
        const wavs = []
        const timing = []
        let cursor = 0
        for (let si = 0; si < segs.length; si++) {
          emit?.({ stage: `逐句合成 ${si + 1}/${segs.length}...` })
          const wb = L.repairWavBytes(await postTts(apiUrl, segs[si], refAudioB64))
          const dur = L.wavBytesDuration(wb)
          timing.push({ text: segs[si], start: Math.round(cursor * 1000) / 1000, end: Math.round((cursor + dur) * 1000) / 1000 })
          cursor += dur + gap
          wavs.push(wb)
          await sleep(200)
        }
        const combined = L.concatWavBuffers(wavs, gap)
        fs.writeFileSync(outWavPath, combined)
        writeTimingSidecar(outWavPath, timing)
        return
      } catch (_) {
        emit?.({ stage: '逐句合成失败，回退整体合成...' })
      }
    }
    // 整体合成（单句 / 逐句失败回退）：多行文案用「。」连接
    let mergedText = text.trim()
    if (mergedText.includes('\n')) {
      mergedText = mergedText.split('\n').map((l) => l.trim()).filter(Boolean).join('。') + '。'
    }
    const content = L.repairWavBytes(await postTts(apiUrl, mergedText, refAudioB64))
    fs.writeFileSync(outWavPath, content)
    try {
      const totalDur = L.wavBytesDuration(content)
      const timing = segs.length <= 1
        ? [{ text: mergedText, start: 0, end: Math.round(totalDur * 1000) / 1000 }]
        : L.buildFallbackTiming(segs, totalDur)
      writeTimingSidecar(outWavPath, timing)
    } catch (_) { /* 写时间轴失败不阻断（原版 OSError 兜底） */ }
  }

  function writeTimingSidecar(wavPath, timing) {
    try {
      fs.writeFileSync(wavPath + '.timing.json', JSON.stringify(timing, null, 1))
    } catch (_) { /* 对照 _write_timing_sidecar OSError 兜底 */ }
  }

  function scaleTimingSidecar(wavPath, factor) {
    const p = wavPath + '.timing.json'
    try {
      if (!fs.existsSync(p)) return
      const timing = JSON.parse(fs.readFileSync(p, 'utf-8'))
      for (const t of timing) {
        t.start = Math.round(Number(t.start ?? 0) * factor * 1000) / 1000
        t.end = Math.round(Number(t.end ?? 0) * factor * 1000) / 1000
      }
      fs.writeFileSync(p, JSON.stringify(timing, null, 1))
    } catch (_) { /* 对照 _scale_timing_sidecar 兜底 */ }
  }

  // ── voice:cloneBatch — 批量克隆人声（VoiceCloneWorker.run L330-412 口径）──
  // 单条失败记录跳过不中断；任务间 sleep 0.3s；变速对齐视频时长（clamp+timing 缩放）。
  ipcMain.handle('voice:cloneBatch', async (event, payload) => {
    try {
      const p = payload || {}
      const tasks = Array.isArray(p.tasks) ? p.tasks : []
      if (!tasks.length) throw new Error('voice:cloneBatch requires tasks[]')
      const apiUrl = String(p.apiUrl || '').trim() || (getServerUrl().replace(/\/$/, '') + '/voxcpm/tts')
      const speedMin = Number(p.speedMin ?? 0.9)
      const speedMax = Number(p.speedMax ?? 1.2)
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

      const emitRow = (rowIdx, value, stage) => {
        if (channel) event.sender.send(channel, { rowIdx, value, stage })
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
          await synthesizeItem(text, refAudioB64, t.outWavPath, apiUrl, (msg) => emitRow(t.rowIdx, 50, msg.stage))
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
          }

          results[t.videoPath] = t.outWavPath
          durations[t.videoPath] = getMediaDuration(t.outWavPath)
          emitRow(t.rowIdx, 100)
        } catch (err) {
          emitRow(t.rowIdx, 0)
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

  // ── voice:dubVideos — 批量替换原声（VideoDubbingWorker.run L843-1035 口径）──
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
            fancyWords: Array.isArray(p.fancyWords) ? p.fancyWords : [],
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

module.exports = { createMontageVoiceIpc, getFfmpegPath, getFfprobePath, getMediaDuration, lookupWindowsFontFile }
