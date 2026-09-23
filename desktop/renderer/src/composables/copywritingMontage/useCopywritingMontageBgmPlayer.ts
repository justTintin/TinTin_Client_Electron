// ══════════════════════════════════════════════════════════
// useCopywritingMontageBgmPlayer.ts — 智能混剪 Step4·BGM 试听播放器子编排（铁律 10 E4 收口，2026-09-19）
// 自 useCopywritingMontageStep4Final.ts 纯搬迁（IRON-02 五项 checklist）。
// 原口径：_toggle_bgm_play/_stop_bgm_play/_on_bgm_position_changed；
// QMediaPlayer → HTMLAudioElement，进度条 range=duration、拖动 seek、增益实时生效。
// ─────────────────────────────────────────────────═
import { ref } from 'vue'
import type { Ref } from 'vue'
import { clientError } from '../../utils/clientLog'
import { notify, errText } from './context'

export interface MontageBgmPlayerContext {
  bgmPath: Ref<string>
  bgmVolume: Ref<number>
}

export function useCopywritingMontageBgmPlayer(ctx: MontageBgmPlayerContext) {
  const { bgmPath, bgmVolume } = ctx

  // ── BGM 试听播放器（_toggle_bgm_play/_stop_bgm_play/_on_bgm_position_changed 等；
  // QMediaPlayer → HTMLAudioElement，进度条 range=duration、拖动 seek、增益实时生效）──
  let bgmAudioEl: HTMLAudioElement | null = null
  const bgmPlaying = ref(false)
  const bgmPosMs = ref(0)
  const bgmDurMs = ref(0)

  function toggleBgmPlay(): void {
    if (!bgmPath.value) { notify('文件不存在', '请先选择有效的背景音乐文件！'); return }
    try {
      if (!bgmAudioEl || bgmAudioEl.dataset.src !== bgmPath.value) {
        bgmAudioEl?.pause()
        bgmAudioEl = new Audio('file:///' + encodeURI(bgmPath.value.replace(/\\/g, '/')).replace(/#/g, '%23'))
        bgmAudioEl.dataset.src = bgmPath.value
        bgmAudioEl.ontimeupdate = () => { bgmPosMs.value = (bgmAudioEl?.currentTime || 0) * 1000 }
        bgmAudioEl.onloadedmetadata = () => { bgmDurMs.value = (bgmAudioEl?.duration || 0) * 1000 }
        bgmAudioEl.onended = () => { bgmPlaying.value = false; bgmPosMs.value = 0 }
      }
      if (bgmPlaying.value) {
        bgmAudioEl.pause()
        bgmPlaying.value = false
      } else {
        // 应用当前 BGM 增益（滑块 0-200%；HTML volume 上限 1，>100% 试听按满量，合成不受影响）
        bgmAudioEl.volume = Math.min(1, bgmVolume.value / 100)
        void bgmAudioEl.play()
        bgmPlaying.value = true
      }
    } catch (e) {
      clientError('video-montage', '播放背景音乐失败', e)
      notify('播放错误', `播放背景音乐失败: ${errText(e)}`)
    }
  }

  /** 停止试听（_stop_bgm_play：stop + 进度/时间复位，⏹ 在播放后可用） */
  function stopBgmPlay(): void {
    try {
      if (bgmAudioEl) { bgmAudioEl.pause(); bgmAudioEl.currentTime = 0 }
      bgmPlaying.value = false
      bgmPosMs.value = 0
    } catch (_) { /* 原版仅 log */ }
  }

  /** 增益滑杆拖动实时改变试听音量（_on_bgm_volume_changed；HTML volume 上限 1） */
  function onBgmVolumeInput(): void {
    if (bgmAudioEl) bgmAudioEl.volume = Math.min(1, bgmVolume.value / 100)
  }

  /** 进度条拖动定位（_set_bgm_position） */
  function seekBgm(e: Event): void {
    const v = Number((e.target as HTMLInputElement).value)
    if (bgmAudioEl) bgmAudioEl.currentTime = v / 1000
  }

  return {
    bgmPlaying, bgmPosMs, bgmDurMs, toggleBgmPlay, stopBgmPlay, onBgmVolumeInput, seekBgm
  }
}