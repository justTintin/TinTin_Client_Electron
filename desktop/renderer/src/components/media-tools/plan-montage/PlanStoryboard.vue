<script setup lang="ts">
// ═════════════════════════════════════════════════════════════
// CopyStoryboard.vue — 文案混剪分镜脚本公共显示组件（四步共用，状态不同）
// 2026-09-21 用户裁决：生成脚本的界面与逻辑在第一步文案下方；生成后整个脚本
// 作为四步公共组件，每一步都有、只是状态不同：
//   edit（第一步）    = ✨AI 生成分镜 + 全字段可编辑（镜别/时长/画面/旁白/音效，增删镜）
//   voice（第二步）   = 只读（旁白已整体克隆为声音，按分镜时间轴对齐）
//   material（第三步）= 只读 + 智能匹配绑定的素材镜头列表（planMontageAssignLogic 方案C）
//   fx（第四步）      = 只读（字幕/花字/文字模板挂接的旁白与画面依据）
// 数据源 = shell.s.copyShots（四步共享同一份分镜数据）；组件自注入 shell。
// ═════════════════════════════════════════════════════════════
import { computed, reactive, ref, inject } from 'vue'
import TButton from '@/components/common/TButton.vue'
import type { StoryboardShot } from '@/composables/opsStoryboardLogic'
import { planMontageShellKey } from './planMontageUiContext'

const props = defineProps<{ mode: 'edit' | 'voice' | 'material' | 'fx'; sfxBusy?: boolean }>()
const emit = defineEmits<{ (e: 'sfx-regen', shot: StoryboardShot): void }>()

const shell = inject(planMontageShellKey)!
const {
  copyShots, copyShotsStale, genStoryboard, storyboardBusy, scriptSaving, saveStoryboard,
  scriptPickDlg, openScriptPick, refreshScriptOptions, pickDetail, selectScriptOption, applySelectedScript,
  scenes, shotClipGroup, bindShotMaterial, removeShotClipAt, unbindShotMaterial, toAbsolute,
  storyboards, activeStoryboardId, setActiveStoryboard, renameStoryboardTab, removeStoryboardTab, COPY_STORYBOARD_MAX,
} = shell.s

const editable = computed(() => props.mode === 'edit')
/** 激活分镜 tab（脚本基本信息来源：topic/scriptId 均为服务端原值字段，2026-09-22
 *  用户裁决：显示与服务端返回字段定义对齐，不做截断/改名加工） */
const activeMeta = computed(() => storyboards.value.find((t) => t.id === activeStoryboardId.value) || null)
/** 分镜预计总时长（各镜 duration 求和） */
const shotsTotalSec = computed(() => copyShots.value.reduce((s, x) => s + (Number(x.duration) || 0), 0))
// 选脚本弹窗右栏：详情总时长
const infoTotalSec = computed(() =>
  (pickDetail.value.detail?.shots || []).reduce((s, x) => s + (Number(x.duration) || 0), 0))

// ── 分镜 tab 管理（多分镜：每 tab 一个脚本对应一个视频；上限 10；双击重命名；
//    删除=2026-09-22 用户裁决改弹窗确认——原「确认」挤在 × 图标上重叠）──
const renamingId = ref('')
const renameValue = ref('')
const delDlg = reactive({ show: false, id: '', name: '' })
function startRename(id: string, name: string): void {
  renamingId.value = id
  renameValue.value = name
}
function commitRename(id: string): void {
  if (renamingId.value !== id) return
  renameStoryboardTab(id, renameValue.value)
  renamingId.value = ''
}
function onTabClose(id: string): void {
  const sb = storyboards.value.find((s) => s.id === id)
  if (!sb) return
  delDlg.id = id
  delDlg.name = sb.name
  delDlg.show = true
}
function confirmDelTab(): void {
  if (delDlg.id) removeStoryboardTab(delDlg.id)
  delDlg.show = false
  delDlg.id = ''
}

/** 第 i 镜绑定的分割素材组（2026-09-22 用户裁决：一镜多片——按序返回已解析片段行） */
function boundClips(i: number) {
  const g = shotClipGroup.value[i] || []
  return g
    .map((idx) => scenes.value.find((s) => s.idx === idx))
    .filter((s): s is NonNullable<typeof s> => !!s)
}
/** 第 i 镜装填覆盖时长（Σ片段全长；裁剪在预合成渲染时落地，此处按全长估算） */
function coveredSec(i: number): number {
  return boundClips(i).reduce((acc, s) => acc + (Number(s.duration) || 0), 0)
}
/** 装填达标徽标（2026-09-22 用户裁决 B2，方案文档 §六）：|Σ−标|/标 <15% 绿（超装
 *  无害——渲染时裁到镜标，同样计绿）；欠装按程度黄（≥50%）/红（<50%）；
 *  镜标未知/未绑定 → 无徽标 */
function fillBadge(i: number): { cls: string; text: string } | null {
  const target = Number(copyShots.value[i]?.duration) || 0
  if (target <= 0 || !boundClips(i).length) return null
  const ratio = coveredSec(i) / target
  if (ratio >= 0.85) return { cls: 'fill-ok', text: '达标' }
  if (ratio >= 0.5) return { cls: 'fill-warn', text: '欠装' }
  return { cls: 'fill-lack', text: '素材不足' }
}
/** 单镜选素材弹窗：目标分镜下标（-1=关闭） */
const matPickIdx = ref(-1)
/** 第 i 镜的视频预览地址 = 该镜首个绑定片段（相对路径拼服务端地址） */
function previewSrc(i: number): string {
  const first = boundClips(i)[0]
  return first ? toAbsolute(first.clipUrl || '') : ''
}

const MODE_STATUS: Record<string, string> = {
  voice: '口播状态：旁白整体克隆为声音，按分镜时间轴对齐',
  material: '素材状态：按各镜时长自动分配已分割素材',
  fx: '特效状态：字幕/花字/文字模板按旁白与画面挂接',
}
const EMPTY_HINT: Record<string, string> = {
  edit: '还没有分镜：点击「✨ AI 生成分镜」，AI 会把旁白按时间轴拆解成镜头，并补充镜别/画面描述/音效建议',
  voice: '尚未生成分镜：请回到「1. 文案编写」点击「✨ AI 生成分镜」',
  material: '尚未生成分镜：请回到「1. 文案编写」点击「✨ AI 生成分镜」，生成后此处按分镜自动分配素材',
  fx: '尚未生成分镜：请回到「1. 文案编写」点击「✨ AI 生成分镜」',
}
</script>

<template>
  <div class="sb-block">
    <!-- 操作行（2026-09-21 用户裁决：选择分镜脚本 / AI 生成分镜脚本单独一行，置于 tab 之上） -->
    <div v-if="mode === 'edit'" class="row sb-actions">
      <TButton label="选择分镜脚本" variant="secondary" :loading="scriptPickDlg.loading" @click="openScriptPick" />
      <TButton label="✨ AI 生成分镜脚本" :loading="storyboardBusy" @click="genStoryboard" />
    </div>

    <!-- 分镜 tab 条（多分镜：每 tab 一个脚本对应一个视频；双击重命名，删除二次确认，上限 10） -->
    <div class="sb-tabs">
      <div v-for="sb in storyboards" :key="sb.id" class="sb-tab" :class="{ active: sb.id === activeStoryboardId }"
        @click="setActiveStoryboard(sb.id)">
        <template v-if="renamingId === sb.id">
          <input v-model="renameValue" class="sb-rename" @click.stop
            @keyup.enter="commitRename(sb.id)" @keyup.esc="renamingId = ''" @blur="commitRename(sb.id)" />
        </template>
        <template v-else>
          <span class="sb-tab-name" :title="`${sb.name}（双击重命名）`" @dblclick.stop="startRename(sb.id, sb.name)">{{ sb.name }}</span>
        </template>
        <button class="sb-tab-close" title="删除该分镜"
          @click.stop="onTabClose(sb.id)">×</button>
      </div>
      <span v-if="storyboards.length < COPY_STORYBOARD_MAX" class="sb-info" title="生成新的分镜：在「文案编写」页点击「✨ AI 生成分镜」，或在「选择脚本」中选取脚本库脚本">{{ storyboards.length ? '' : '' }}可再添加 {{ COPY_STORYBOARD_MAX - storyboards.length }} 个分镜</span>
      <span v-else class="sb-info">已达分镜数量上限（{{ COPY_STORYBOARD_MAX }}）</span>
    </div>

    <div class="row between">
      <!-- 2026-09-22 用户裁决：脚本头部显示服务端脚本基本信息（选题/脚本库 id）——
           取回分镜脚本后基本信息随 tab 保存，不再只显示镜数/时长 -->
      <span class="sb-info">分镜脚本{{ copyShots.length ? `：共 ${copyShots.length} 镜 ｜ 总时长 ${shotsTotalSec} 秒` : '' }}<template v-if="activeMeta && copyShots.length"> ｜ 选题：{{ activeMeta.topic || '—' }}</template><template v-if="activeMeta?.scriptId"> ｜ 脚本 {{ activeMeta.scriptId }}</template>
        <span v-if="copyShotsStale" class="sb-stale">⚠ 分镜基于旧版文案（文案已修改），克隆将使用当前旁白全文；请重新生成分镜</span>
      </span>
      <div v-if="mode === 'edit'" class="row">
        <TButton label="保存脚本" variant="secondary" size="small" :loading="scriptSaving" :disabled="!copyShots.length" @click="saveStoryboard" />
      </div>
      <span v-else class="sb-info">{{ MODE_STATUS[mode] }}</span>
    </div>

    <template v-if="copyShots.length">
      <div v-for="(shot, i) in copyShots" :key="i" class="seg-card seg-card--row">
          <div class="seg-main">
        <div class="seg-head">
          <span class="seg-no">#{{ i + 1 }}</span>
          <template v-if="editable">
            <label class="seg-field head-field"><span class="lbl">镜别</span>
              <input v-model="shot.shot_type" class="input w70" placeholder="特写/中景" />
            </label>
            <label class="seg-field head-field"><span class="lbl">时长(秒)</span>
              <input v-model.number="shot.duration" type="number" min="1" max="15" class="input w60" />
            </label>
            <span class="spacer"></span>
            <TButton label="删除" variant="secondary" size="small" @click="copyShots.splice(i, 1)" />
          </template>
          <template v-else>
            <span class="sb-info">{{ shot.shot_type || '未定镜别' }} ｜ {{ shot.duration }}s</span>
            <span class="spacer"></span>
          </template>
        </div>

        <label v-if="editable" class="seg-field"><span class="lbl">画面描述（视频生成提示词）</span>
          <textarea v-model="shot.visual" rows="2" class="input carry-textarea" placeholder="具体的画面/动作链/镜头运动/光影（点「AI 生成分镜」自动填写，也可手写）"></textarea>
        </label>
        <div v-else-if="shot.visual" class="sb-line">画面：{{ shot.visual }}</div>

        <label v-if="editable" class="seg-field"><span class="lbl">旁白（该镜覆盖的文案原文片段）</span>
          <textarea v-model="shot.audio" rows="1" class="input carry-textarea carry-textarea--sm" placeholder="该镜对应的旁白"></textarea>
        </label>
        <div v-else-if="shot.audio" class="sb-line sb-audio">旁白：{{ shot.audio }}</div>

        <label v-if="editable" class="seg-field"><span class="lbl">音效建议</span>
          <input v-model="shot.sfx" class="input" placeholder="可选：如 按键声 / 轻快 BGM 起拍" />
        </label>
        <div v-else-if="shot.sfx" class="sb-line">音效：{{ shot.sfx }}</div>
        <!-- 音效包装产物（2026-09-22 用户裁决：AI 按音效提示词生成的音效挂在对应镜，就地试听；
             2026-09-22 二次裁决：行尾右对齐「重新生成音效」按钮——单镜重生成，与批量共享忙态） -->
        <div v-if="mode === 'fx' && shot.sfxWavUrl" class="sfx-row">
          <audio
            class="sfx-audio"
            controls
            preload="none"
            :src="toAbsolute(shot.sfxWavUrl)"
            :title="`AI 生成音效（${shot.sfx}）`"
          />
          <TButton
            label="重新生成音效"
            variant="secondary"
            size="small"
            class="sfx-regen"
            :disabled="!!sfxBusy"
            :title="sfxBusy ? '音效生成进行中' : '按该镜音效提示词重新生成音效'"
            @click="emit('sfx-regen', shot)"
          />
        </div>

        <!-- 绑定素材（material 态；2026-09-22 用户裁决：一镜多片·按时长装填——
             逐片列表 + 覆盖时长/镜标对比；「选择素材」追加式，单片可移除，「解绑」清空整组） -->
        <template v-if="mode === 'material'">
          <div class="seg-field"><span class="lbl">绑定素材</span>
            <div v-if="boundClips(i).length" class="sb-line">
              <span v-for="(s, j) in boundClips(i)" :key="s.idx" class="bound-clip">
                {{ j + 1 }}. {{ s.name }}（{{ s.duration > 0 ? s.duration.toFixed(1) + 's' : '—' }}）
                <button class="unbind-btn" title="移除该片段" @click="removeShotClipAt(i, j)">×</button>
              </span>
              <span class="fill-line">
                <span class="muted">共 {{ boundClips(i).length }} 片 · Σ {{ coveredSec(i).toFixed(1) }}s / 标 {{ shot.duration }}s</span>
                <span v-if="fillBadge(i)" class="fill-badge" :class="fillBadge(i)!.cls"
                  title="Σ片段全长 vs 镜标：差值<15% 达标；欠装时预合成按现有片段合成（末端裁剪照常）">{{ fillBadge(i)!.text }}</span>
              </span>
            </div>
            <div v-else class="muted">未绑定素材</div>
            <TButton label="选择素材（追加）" variant="secondary" size="small" @click="matPickIdx = i" />
            <TButton v-if="boundClips(i).length" label="解绑全部" variant="secondary" size="small" @click="unbindShotMaterial(i)" />
          </div>
        </template>
          </div><!-- /seg-main -->
          <div class="seg-video">
            <video v-if="previewSrc(i)" controls preload="metadata" :src="previewSrc(i)"></video>
            <span v-else class="sb-info seg-video-empty">未绑定素材</span>
          </div>
      </div>

      <div v-if="editable" class="row">
        <TButton label="＋ 添加镜头" variant="secondary" size="small" @click="copyShots.splice(copyShots.length, 0, {
          index: copyShots.length + 1, shot_type: '', visual: '', audio: '', sfx: '', duration: 3,
          material_path: '', material_type: '', material_hash: '', material_id: 0,
        })" />
      </div>
    </template>
    <div v-else class="muted">{{ EMPTY_HINT[mode] }}</div>

    <!-- 单镜选素材弹窗（material 态；素材池=本地上传分割出的镜头；2026-09-22 用户裁决：
         一镜多片——点选即追加进该镜绑定组，组内已选片段自动去重跳过） -->
    <teleport to="body">
      <div v-if="matPickIdx >= 0" class="modal-mask" @click.self="matPickIdx = -1">
        <div class="modal">
          <span class="modal-title">为分镜 #{{ matPickIdx + 1 }} 追加素材（点击追加，可多次选择）</span>
          <div class="script-list">
            <button v-for="s in scenes" :key="s.idx" class="script-row" :title="s.description"
              @click="bindShotMaterial(matPickIdx, s.idx)">
              <span class="script-topic">{{ s.idx }}. {{ s.name }}</span>
              <span class="script-meta">{{ s.duration > 0 ? s.duration.toFixed(1) + 's' : '—' }}{{ s.description ? ` · ${s.description}` : '' }}</span>
            </button>
            <div v-if="!scenes.length" class="muted script-empty">暂无已分割镜头：请先在下方「本地上传」完成素材上传与镜头分割</div>
          </div>
          <div class="modal-actions"><TButton label="关闭" plain @click="matPickIdx = -1" /></div>
        </div>
      </div>
    </teleport>

    <!-- 选择脚本弹窗（2026-09-21 用户裁决：加大并左右 1:1——左=脚本列表，右=脚本基本信息；
         「使用此脚本」将分镜与旁白整组回填为新分镜 tab） -->
    <teleport to="body">
      <div v-if="scriptPickDlg.show" class="modal-mask" @click.self="scriptPickDlg.show = false">
        <div class="modal modal--script">
          <span class="modal-title">选择脚本</span>
          <div class="script-cols">
            <div class="script-list-pane">
              <div class="row" style="margin-bottom: 6px">
                <TButton label="刷新" variant="secondary" size="small" :loading="scriptPickDlg.loading" @click="refreshScriptOptions" />
                <span class="muted">共 {{ scriptPickDlg.options.length }} 个脚本</span>
              </div>
              <div class="script-list">
                <button v-for="o in scriptPickDlg.options" :key="o.id" class="script-row"
                  :class="{ picked: scriptPickDlg.selectedId === o.id }" @click="selectScriptOption(o.id)">
                <span class="script-topic">【{{ o.topic }}】</span>
                <span class="script-meta">{{ o.shotCount }} 镜 · {{ o.savedAt }}{{ o.displayName ? ` · ${o.displayName}` : '' }}</span>
                </button>
                <div v-if="!scriptPickDlg.loading && !scriptPickDlg.options.length" class="muted script-empty">脚本库为空（可先「保存脚本」）</div>
                <div v-if="scriptPickDlg.error" class="muted script-empty">{{ scriptPickDlg.error }}</div>
              </div>
            </div>
            <div class="script-info-pane">
              <template v-if="pickDetail.detail">
                <div class="info-grid">
                  <div class="info-item"><span class="lbl">选题</span><b>{{ pickDetail.detail.topic || '未命名' }}</b></div>
                  <div class="info-item"><span class="lbl">镜数</span>{{ pickDetail.detail.shots.length }}</div>
                  <div class="info-item"><span class="lbl">总时长</span>{{ infoTotalSec }} 秒</div>
                  <div class="info-item"><span class="lbl">画幅</span>{{ pickDetail.detail.ratio || '竖屏' }}</div>
                </div>
                <div class="lbl" style="margin: 10px 0 4px">镜头列表</div>
                <div class="script-shots">
                  <div v-for="(s, i) in pickDetail.detail.shots" :key="i" class="shot-line">
                    <b>#{{ i + 1 }}</b> {{ s.shot_type || '—' }} · {{ s.duration }}s ｜ {{ s.audio || s.visual || '—' }}
                  </div>
                </div>
              </template>
              <div v-else-if="pickDetail.loading" class="muted">正在加载脚本详情...</div>
              <div v-else class="muted">在左侧选择一个脚本查看基本信息</div>
            </div>
          </div>
          <div class="modal-actions">
            <TButton label="使用此脚本" :disabled="!scriptPickDlg.selectedId || !pickDetail.detail" @click="applySelectedScript" />
            <TButton label="关闭" plain @click="scriptPickDlg.show = false" />
          </div>
        </div>
      </div>
    </teleport>

    <!-- 删除分镜确认弹窗（2026-09-22 用户裁决：删除确认改大弹窗——原「确认」挤在
         × 图标上重叠不可读；分镜内容已同步服务端脚本库的仍保留在库中） -->
    <teleport to="body">
      <div v-if="delDlg.show" class="modal-mask" @click.self="delDlg.show = false">
        <div class="modal">
          <span class="modal-title">删除分镜脚本</span>
          <div class="del-body">
            确定删除分镜「<b>{{ delDlg.name }}</b>」？
            <span class="del-hint">该分镜的镜头编排与绑定将一并移除；已同步到服务端脚本库的内容仍保留在库中。</span>
          </div>
          <div class="modal-actions">
            <TButton label="取消" plain @click="delDlg.show = false" />
            <TButton label="删除" @click="confirmDelTab" />
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>
<style scoped>
/* ── 布局与通用 ── */
.sb-block { display: flex; flex-direction: column; gap: 6px; }
.sb-info { font-size: 12px; color: var(--muted-foreground); }
.sb-actions { display: flex; }
.sb-actions :deep(.t-button) { flex: 1 1 0; }
.sb-line { font-size: 12px; color: var(--foreground); line-height: 1.5; }
.sb-audio { color: var(--primary); }
.sb-stale { color: var(--warning, #f1c40f); font-weight: 600; margin-left: 8px; }
.muted { color: var(--muted-foreground); font-size: 12px; }
.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.spacer { flex: 1; }

/* ── 分镜 tab 条（多分镜：切换/双击重命名/删除二次确认，上限 10） ── */
.sb-tabs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.sb-tab {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px;
  background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md);
  cursor: pointer; font-size: 12px; color: var(--muted-foreground);
}
.sb-tab.active { color: var(--primary); font-weight: 600; border-color: var(--primary); background: color-mix(in srgb, var(--primary) 8%, var(--surface-container)); }
.sb-tab-name { white-space: nowrap; }
.sb-rename { width: 90px; height: 22px; padding: 0 6px; font-size: 12px; }
.sb-tab-close {
  width: 18px; height: 18px; padding: 0; line-height: 1; font-size: 12px; flex: none;
  background: transparent; color: var(--muted-foreground); border: none; border-radius: 50%; cursor: pointer;
}
.sb-tab-close:hover { color: var(--danger, #e74c3c); }
.sb-tab-close.warn { color: #fff; background: var(--danger, #e74c3c); }

/* ── 镜头卡 ── */
.seg-card {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
  background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md);
}
.seg-card--row { flex-direction: row; align-items: stretch; }
.seg-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.seg-head { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.seg-no { font-weight: 700; color: var(--primary); }
.seg-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
.seg-field.head-field { flex: 0 0 auto; flex-direction: row; align-items: center; gap: 6px; }
.seg-field .lbl { font-size: 12px; color: var(--muted-foreground); flex: none; }
.seg-field .input { width: 100%; }
.seg-field.head-field .input { width: auto; }
.w70 { width: 90px; }
.w60 { width: 64px; }

.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
/* 源序在 .input 之后（覆盖其 height:32px / padding:0 10px） */
.carry-textarea { height: auto; min-height: 72px; padding: 8px 10px; line-height: 1.6; font-family: inherit; resize: vertical; }
.carry-textarea--sm { min-height: 48px; }

.sb-stale { }

/* ── 每镜视频预览（material/fx 态：右侧预览该镜绑定的素材视频；
     2026-09-21 用户裁决：宽 100px、顶部对齐不随卡片拉伸） ── */
.seg-video {
  flex: 0 0 100px; align-self: flex-start; display: flex; align-items: center; justify-content: center;
  background: #101010; border-radius: var(--radius-md); overflow: hidden;
}
.seg-video video { width: 100%; height: auto; object-fit: contain; display: block; }
.seg-video-empty { padding: 12px; text-align: center; }

/* ── 弹窗通用 ── */
.modal-mask {
  position: fixed; inset: 0; z-index: 1002; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.7);
}
.modal {
  display: flex; flex-direction: column; gap: 12px; width: 520px; max-width: 90vw; max-height: 80vh;
  padding: 20px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);
}
.modal-title { font-size: 15px; font-weight: 600; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* ── 选择脚本弹窗（2026-09-21 用户裁决：加大 + 左右 1:1——左列表右基本信息） ── */
.modal--script { width: min(960px, 94vw); height: min(640px, 84vh); }
.script-cols { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.script-list-pane { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.script-list { flex: 1 1 auto; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.script-row {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; text-align: left;
  background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-md); cursor: pointer; color: var(--foreground); font-size: 13px;
}
.script-row:hover { border-color: var(--primary); }
.script-row.picked { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, var(--surface-container)); }
.script-topic { font-weight: 600; }
.script-meta { color: var(--muted-foreground); font-size: 12px; }
.script-empty { padding: 12px; text-align: center; }
.script-info-pane {
  display: flex; flex-direction: column; gap: 6px; min-height: 0; overflow-y: auto;
  padding: 10px 12px; background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md);
}
.info-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 12px; font-size: 13px; }
.info-item .lbl { margin-right: 6px; color: var(--muted-foreground); font-size: 12px; }
.script-shots { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.shot-line { padding: 4px 6px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--foreground); line-height: 1.5; }
.shot-line b { color: var(--primary); margin-right: 4px; }
/* 一镜多片绑定（2026-09-22 用户裁决：逐片列表 + 移除） */
.bound-clip {
  display: inline-flex; align-items: center; gap: 2px; margin-right: 8px;
  padding: 1px 6px; background: var(--surface-container); border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 12px; color: var(--foreground);
}
/* 音效包装播放条（fx 态音效信息行内嵌，2026-09-22 用户裁决） */
.sfx-audio { width: 240px; height: 28px; margin-top: 2px; }
/* 音效行：播放条 + 右对齐重生成按钮（2026-09-22 二次裁决） */
.sfx-row { display: flex; align-items: center; gap: 8px; }
.sfx-row .sfx-regen { margin-left: auto; }
/* 装填达标徽标（2026-09-22 用户裁决 B2，方案文档 §六：差值<15% 绿、欠装黄/红） */
.fill-line { display: inline-flex; align-items: center; gap: 6px; }
.fill-badge { padding: 1px 6px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600; }
.fill-badge.fill-ok { color: #2ecc71; background: rgba(46, 204, 113, 0.12); }
.fill-badge.fill-warn { color: #f39c12; background: rgba(243, 156, 18, 0.12); }
.fill-badge.fill-lack { color: #e74c3c; background: rgba(231, 76, 60, 0.12); }
/* 删除分镜确认弹窗（2026-09-22 用户裁决：大弹窗替代图标上内联确认） */
.del-body { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--foreground); }
.del-hint { font-size: 12px; color: var(--muted-foreground); }
</style>
