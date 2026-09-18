// ══════════════════════════════════════════════════════════
// useMontageBgmGen.ts — 智能混剪 Step4·AI 生成 BGM 子编排（铁律 10 E4b 收口，2026-09-19）
// 自 useMontageStep4Final.ts 纯搬迁（IRON-02 五项 checklist）。
// 原口径：POST /audio/gen/bgm（原客户端 _GenBgmWorker L272-286 同口）；
//   生成成功后主进程下载落盘并回填全局 bgmPath（本地混音/剪映草稿需本地文件）。
// ─────────────────────────────────────────────────═
import { ref, computed } from 'vue'
import type { Ref } from 'vue'
import { clientError } from '../../utils/clientLog'
import { readCacheDir } from '../useSettingsConfig'
import {
  buildBgmGenPayload, parseBgmGenResponse, pathBasename, resolveOutMontageDir,
  type BgmGenPayload,
} from '../videoMontageLogic'
import { notify, unwrapIpc, errText, joinPath } from './context'

export interface MontageBgmGenContext {
  ensureServerUrl: () => Promise<string>
  toAbsolute: (url: string) => string
  voiceDirInput: Ref<string>
  bgmPath: Ref<string>
  bgmName: Ref<string>
}

export function useMontageBgmGen(ctx: MontageBgmGenContext) {
  const { ensureServerUrl, toAbsolute, voiceDirInput, bgmPath, bgmName } = ctx

  // ── AI 生成 BGM（本端保留功能：POST /audio/gen/bgm，原客户端 _GenBgmWorker 同口径：
  // prompt 必填 + style 英文值下拉 + duration；无 mood —— BGM 库的标签体系不属生成）──
  const bgmSource = ref<'local' | 'ai'>('local')   // 'ai' 仅作 AI 面板展开开关
  const bgmGenPrompt = ref('')
  const bgmGenStyle = ref('auto')
  const bgmGenDuration = ref(30)   // 秒（2026-09-05 用户裁决：客户端生成 BGM 上限 30 秒，滑杆 max=30 + 生成前 clamp）
  const bgmGenBusy = ref(false)
  const bgmGenError = ref('')
  const bgmGenUrl = ref('')        // 生成结果相对路径（预览/下载用）
  const bgmGenMeta = ref('')       // engine · duration 展示

  /** AI 生成 BGM：成功后主进程下载落盘（本地混音需本地文件，本端扩展）并回填 bgmPath */
  async function generateBgm(): Promise<void> {
    let payload: BgmGenPayload
    try {
      payload = buildBgmGenPayload({
        prompt: bgmGenPrompt.value,
        style: bgmGenStyle.value,
        duration: Math.min(30, Math.max(3, Math.round(Number(bgmGenDuration.value) || 30))),
      })
    } catch (e) {
      bgmGenError.value = errText(e)
      return
    }
    bgmGenError.value = ''
    bgmGenBusy.value = true
    try {
      await ensureServerUrl()
      const res = unwrapIpc(await window.tintin.server.audioGenBgm(payload), 'AI 生成 BGM')
      const parsed = parseBgmGenResponse(res)
      bgmGenUrl.value = parsed.url
      bgmGenMeta.value = [
        parsed.engine || 'MusicGen',
        parsed.duration ? `${Math.round(parsed.duration)}s` : '',
      ].filter(Boolean).join(' · ')
      // 本端扩展：本地 ffmpeg 混音/剪映草稿都需本地文件，主进程下载落盘（待裁决清单）
      const destDir = voiceDirInput.value
        ? joinPath(resolveOutMontageDir(voiceDirInput.value), 'bgm_ai')
        : joinPath(await readCacheDir(), 'montage_cache', 'bgm_ai')
      const dl = await window.tintin?.server?.bgmDownloadUrl?.({ url: bgmGenUrl.value, destDir })
      if (dl && 'path' in dl && dl.path) {
        bgmPath.value = dl.path
        bgmName.value = pathBasename(dl.path)
      }
      bgmSource.value = 'ai'
      notify('BGM 生成完成', `${payload.style === 'auto' ? '自动风格' : payload.style}｜已落盘：${bgmName.value || '(下载失败，仅预览可用)'}`)
    } catch (e) {
      bgmGenError.value = errText(e)
      clientError('video-montage', 'BGM生成失败', e)
      notify('BGM 生成失败', bgmGenError.value)
    } finally {
      bgmGenBusy.value = false
    }
  }

  /** 生成结果的预览地址（相对路径拼服务端基址） */
  const bgmPreviewUrl = computed(() => toAbsolute(bgmGenUrl.value))

  /** 下载音频库 BGM 到本地（仅下载不回填全局）——全局指派与逐行指派共用（2026-09-18） */
  async function downloadLibraryBgm(mid: string): Promise<{ path?: string; error?: string }> {
    try {
      const destDir = voiceDirInput.value
        ? joinPath(resolveOutMontageDir(voiceDirInput.value), 'bgm_lib')
        : joinPath(await readCacheDir(), 'montage_cache', 'bgm_lib')
      const dl = await window.tintin?.server?.bgmDownloadUrl?.({ url: `/audio/library/${mid}/file`, destDir })
      if (!dl || !('path' in dl) || !dl.path) return { error: '下载失败（服务端不可达或文件不存在）' }
      return { path: dl.path }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** BGM 选择弹窗确认（2026-09-09 用户裁决）：音频库音频经 /audio/library/{mid}/file
   *  下载落盘后回填全局 bgmPath（ffmpeg 混音/剪映导出需本地文件） */
  async function applyLibraryBgm(mid: string, filename: string): Promise<{ path?: string; error?: string }> {
    const r = await downloadLibraryBgm(mid)
    if (r.error || !r.path) return { error: r.error || '下载失败' }
    bgmPath.value = r.path
    bgmName.value = filename || pathBasename(r.path)
    return { path: r.path }
  }

  return {
    bgmSource, bgmGenPrompt, bgmGenStyle, bgmGenDuration, bgmGenBusy, bgmGenError, bgmGenUrl, bgmGenMeta, bgmPreviewUrl, generateBgm, downloadLibraryBgm, applyLibraryBgm
  }
}