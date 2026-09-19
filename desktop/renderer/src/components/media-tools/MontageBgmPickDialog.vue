<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// MontageBgmPickDialog.vue — 智能混剪 Step4·BGM 选择弹窗（铁律 10 P4b，2026-09-19）
// 自 MontageStep4Panel.vue 逐字搬迁（IRON-02 五项 checklist）。
// 左栏音频库列表 + 右栏 AI 生成（useAudioGen 独立实例，与音频生成页互不影响，
// 2026-09-09 用户裁决）；2026-09-18 用户裁决：生成结果可直接确定应用，
// target 为空=回填全局 bgmPath，target=视频路径=指派该行逐行 BGM。
// ═══════════════════════════════════════════════════════════════
import { ref, computed, watch, inject } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import { useAudioGen } from '@/composables/useAudioGen'
import { montageShellKey } from './montageUiContext'
import { pathBasename } from '@/composables/videoMontageLogic'

const shell = inject(montageShellKey)!
const { setRowBgm, bgmPath, bgmName, downloadLibraryBgm, applyLibraryBgm } = shell.s

/** 本地路径 → file URL（面板内私有拷贝） */
function toFileUrl(p: string): string {
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23')
}

// ── Step4 BGM 选择弹窗 + AI 生成 BGM（2026-09-09 用户裁决：复用音频生成页域，
//    独立实例与 AudioGen 页互不影响；AI 生成用「生成 BGM」同款结构化布局，
//    生成/选中后回填 bgmPath 本地混音链路）──
const ag = useAudioGen()
const {
  bgmStyle, bgmStyleOptions, bgmDuration, bgmBusy, bgmResultLabel, bgmUrl, bgmSaving,
  bgmLocal, generateBgm, saveBgmToLib, openBgmLocation,
  bgmMood, bgmMoodOptions, bgmScene, bgmSceneOptions,
  listQuery, listTag, listKind, LIST_KIND_OPTIONS,
  listRows, listLoading, listError, listStat, listPageSize,
  pageLabel, canPrevPage, canNextPage,
  doSearch, goPrevPage, goNextPage, loadBgmTags,
  playingMid, listAudioEl, playListRow,
  toAbsolute,
} = ag

// 生成完成自动归档本地后回填 BGM 路径（混音/剪映导出走同一本地链路）
// 2026-09-18 用户裁决：AI 生成 BGM 集成进「选择 BGM」弹窗右栏——生成结果按弹窗当前
// 目标回填（target 非空=逐行指派到该视频；空=回填全局 bgmPath）
watch(bgmLocal, (p) => {
  if (!p) return
  const target = bgmPickDlg.value.target
  if (target) setRowBgm(target, p, pathBasename(p))
  else { bgmPath.value = p; bgmName.value = pathBasename(p) }
})

/** 生成面板内联播放条（2026-09-15 用户裁决：删「播放生成的 BGM」按钮，<audio controls>
 *  的 src 直挂就地播放；取源口径同原 playAgBgm——本地归档优先，未就绪回退在线 URL；
 *  src 变化时 audio 自动重载，新生成即播新文件） */
const agBgmAudioSrc = computed(() => bgmLocal.value
  ? toFileUrl(bgmLocal.value)
  : bgmUrl.value ? toAbsolute(bgmUrl.value) : '')

/** BGM 选择弹窗（2026-09-18 用户裁决：左栏音频库列表 + 右栏 AI 生成，2:1）。
 *  target='' 指派全局 BGM；target=视频路径 指派该视频逐行 BGM。 */
const bgmPickDlg = ref<{ show: boolean; target: string; pickedMid: string; busy: boolean; error: string }>({ show: false, target: '', pickedMid: '', busy: false, error: '' })
function openBgmPickDlg(target = ''): void {
  bgmPickDlg.value.show = true
  bgmPickDlg.value.target = target
  bgmPickDlg.value.pickedMid = ''
  bgmPickDlg.value.error = ''
  // 2026-09-10 用户裁决：BGM 选择弹窗默认分类「音乐」（列表状态与音频生成页共享，
  // 仅在打开弹窗时置分类并刷新，不影响音频生成页自身默认「全部」）
  if (listKind.value !== 'music') {
    listKind.value = 'music'
    doSearch()
  } else if (!listRows.value.length && !listLoading.value) {
    doSearch()
  }
  void loadBgmTags()
}
function confirmBgmPick(): void {
  if (bgmPickDlg.value.busy) return
  const target = bgmPickDlg.value.target
  // 2026-09-18 用户裁决：AI 生成结果可直接「确定」应用（无需先保存到 BGM 库再回左栏选）——
  // 未选左栏条目但右栏已生成本地文件时，直接按弹窗目标回填生成结果并关闭
  const it = listRows.value.find((r) => r.mid === bgmPickDlg.value.pickedMid)
  if (!it) {
    const gen = bgmLocal.value
    if (!gen) { bgmPickDlg.value.error = '请先在左栏选择音频，或在右栏生成 BGM'; return }
    if (target) setRowBgm(target, gen, pathBasename(gen))
    else { bgmPath.value = gen; bgmName.value = pathBasename(gen) }
    bgmPickDlg.value.show = false
    return
  }
  bgmPickDlg.value.busy = true
  bgmPickDlg.value.error = ''
  const done = (r: { path?: string; error?: string }): void => {
    bgmPickDlg.value.busy = false
    if (r && r.error) { bgmPickDlg.value.error = r.error; return }
    if (target && r && r.path) setRowBgm(target, r.path, it.filename || pathBasename(r.path))
    bgmPickDlg.value.show = false
  }
  if (target) void downloadLibraryBgm(it.mid).then(done)
  else void applyLibraryBgm(it.mid, it.filename).then(done)
}



defineExpose({ show: openBgmPickDlg })
</script>

<template>
      <div v-if="bgmPickDlg.show" class="modal-mask" @click.self="bgmPickDlg.show = false">
        <div class="modal modal-wide bgm-pick">
          <span class="modal-title">选择 BGM{{ bgmPickDlg.target ? '（当前视频）' : '（全局）' }}</span>
          <!-- 2026-09-18 用户裁决：左右 2:1 分栏——左=音频库列表，右=AI 生成 BGM -->
          <div class="bgm-pick-cols">
          <div class="bgm-pick-left">
          <div class="row">
            <input v-model="listQuery" class="input grow" placeholder="搜索音频（语义检索，如：激昂的背景音乐）" :disabled="listLoading" @keydown.enter="doSearch()" />
            <TButton label="搜索" :loading="listLoading" :disabled="listLoading" @click="doSearch()" />
          </div>
          <div class="row">
            <label class="label">分类:</label>
            <TSelect v-model="listKind" class="bgm-kind-select" :options="[...LIST_KIND_OPTIONS]" :disabled="listLoading" @update:model-value="doSearch()" />
            <input v-model="listTag" class="input bgm-tag-input" placeholder="情绪/场景标签" :disabled="listLoading" @keydown.enter="doSearch()" />
          </div>
          <div class="bgm-pick-rows">
            <div v-if="!listLoading && !listError && !listRows.length" class="bgm-pick-state">暂无音频，试试调整筛选条件。</div>
            <div
              v-for="it in listRows"
              v-else
              :key="it.mid"
              class="bgm-pick-row"
              :class="{ picked: bgmPickDlg.pickedMid === it.mid, playing: playingMid === it.mid }"
              :title="`${it.filename}\n分类: ${it.kindName}\n时长: ${it.durStr}\n大小: ${it.sizeStr}`"
              @click="bgmPickDlg.pickedMid = it.mid"
              @dblclick="playListRow(it)"
            >
              <span class="bgm-pick-name" :title="it.filename">{{ it.filename }}</span>
              <span class="vd-tag muted-tag">{{ it.kindName }}</span>
              <span class="bgm-pick-meta">{{ it.durStr }}</span>
              <span class="bgm-pick-meta">{{ it.sizeStr }}</span>
              <span class="bgm-pick-act" role="button" title="试听" @click.stop="playListRow(it)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
              </span>
            </div>
          </div>
          <div class="row">
            <span class="muted" :title="listError || listStat">{{ listError || (listLoading ? '加载中...' : `${listStat} · 单击选中，双击或 ▶ 试听`) }}</span>
            <span class="grow"></span>
            <TButton label="上一页" variant="secondary" size="small" :disabled="!canPrevPage || listLoading" @click="goPrevPage()" />
            <span class="muted">{{ pageLabel }}</span>
            <TButton label="下一页" variant="secondary" size="small" :disabled="!canNextPage || listLoading" @click="goNextPage()" />
            <label class="label">每页:</label>
            <input v-model.number="listPageSize" class="input bgm-page-input" type="number" min="10" max="200" step="10" :disabled="listLoading" @change="doSearch()" />
            <audio v-show="playingMid" ref="listAudioEl" controls class="bgm-pick-audio" />
          </div>
          </div><!-- /bgm-pick-left -->
          <!-- 2026-09-18 用户裁决：右栏 = AI 生成 BGM（自原内联面板移入；生成结果按弹窗目标回填） -->
          <div class="bgm-pick-right">
            <div class="bgm-pick-right-title">AI 生成 BGM</div>
            <div class="row">
              <label class="label">风格:</label>
              <TSelect v-model="bgmStyle" class="ag-style-select" :options="bgmStyleOptions" :disabled="bgmBusy" />
            </div>
            <div class="row">
              <label class="label">时长(秒):</label>
              <input v-model.number="bgmDuration" class="input ag-num-input" type="number" min="5" max="30" step="5" :disabled="bgmBusy" />
            </div>
            <div class="row">
              <label class="label">情绪:</label>
              <TSelect v-model="bgmMood" class="ag-tag-select" :options="bgmMoodOptions" :disabled="bgmBusy" />
            </div>
            <div class="row">
              <label class="label">场景:</label>
              <TSelect v-model="bgmScene" class="ag-tag-select" :options="bgmSceneOptions" :disabled="bgmBusy" />
            </div>
            <div class="row agb-gen-row">
              <TButton label="生成 BGM" :loading="bgmBusy" :disabled="bgmBusy" @click="generateBgm()" />
            </div>
            <p v-if="bgmResultLabel" class="agb-result">{{ bgmResultLabel }}</p>
            <div class="row">
              <TButton label="保存到 BGM 库" variant="secondary" size="small" :loading="bgmSaving" :disabled="!bgmUrl || bgmSaving" @click="saveBgmToLib" />
              <TButton label="打开位置" variant="secondary" size="small" :disabled="!bgmLocal" title="在资源管理器中打开生成的 BGM 本地文件（outputs/ai_audio）" @click="openBgmLocation" />
            </div>
            <audio v-if="agBgmAudioSrc" :src="agBgmAudioSrc" controls class="bgm-pick-right-audio" />
            <p class="bgm-pick-right-tip">生成后自动落盘；可直接点「确定」应用{{ bgmPickDlg.target ? '到当前视频行' : '为全局 BGM' }}，无需先保存到 BGM 库。</p>
          </div><!-- /bgm-pick-right -->
          </div><!-- /bgm-pick-cols -->
          <div v-if="bgmPickDlg.error" class="error-msg">⚠ {{ bgmPickDlg.error }}</div>
          <div class="modal-actions">
            <TButton label="取消" plain @click="bgmPickDlg.show = false" />
            <TButton label="确定" :loading="bgmPickDlg.busy" :disabled="(!bgmPickDlg.pickedMid && !bgmLocal) || bgmPickDlg.busy" @click="confirmBgmPick" />
          </div>
        </div>
      </div>
</template>

<style scoped>
/* 弹窗复用 Shell 共享类与 modal-mask 体系，本组件无新增私有样式 */
</style>