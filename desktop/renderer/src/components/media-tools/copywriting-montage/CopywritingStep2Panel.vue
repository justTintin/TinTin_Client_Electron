<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// CopyStep2Panel.vue — 智能混剪 Step2 镜头重组面板（铁律 10 Phase3 P2，2026-09-19）
// 模板/样式自 VideoMontage.vue 逐字搬迁；状态经 inject 解构回原名（零改动）。
// 本面板本地逻辑：右栏预览 computed、排列/时长/画幅下拉选项、方案与镜头详情
// 右键菜单、口播弹窗产品选择（WbPickProductPanel）、scoreClass（Step1/2 各持一份）。
// 注：toAbsolute 在面板内以原名解构，模板沿用原别名 vdToAbsolute（与 Shell 等价）。
// ═══════════════════════════════════════════════════════════════
import { ref, reactive, computed, watch, inject, onUnmounted } from 'vue'
import TButton from '@/components/common/TButton.vue'
import TSelect from '@/components/common/TSelect.vue'
import WbPickProductPanel from '@/components/workbench/WbPickProductPanel.vue'
import VdStepBar from '../VdStepBar.vue'
import { markdownListLines, stripProductCodeFromModel, parseProductKeywords } from '@/composables/opsProductLibraryLogic'
import { parseScriptDetail } from '@/composables/opsStoryboardLogic'
import { copyPreviewText, SHOT_TYPE_COLORS, SHOT_TYPE_LABELS, buildAssignPool } from '@/composables/copywritingMontageLogic'
import { buildAssignCandidateSet, buildAssignMatchPrompt, parseAssignMatchResponse, mergeTabAssignment, planShotGroup } from '@/composables/copywritingMontageAssignLogic'
import { fetchMaterialGrid, fetchMaterialDistinct, type PickerItem } from '@/composables/useWorkbenchPickers'
import { buildMediaServeUrl, buildMediaThumbUrl } from '@/composables/workbenchChatContext'
import { errText, notify } from '@/composables/copywritingMontage/context'
import { clientError } from '@/utils/clientLog'
import CopyStoryboard from './CopyStoryboard.vue'
import { copywritingMontageShellKey } from './copywritingMontageUiContext'

const shell = inject(copywritingMontageShellKey)!
const { step, go, steps } = shell
const {
  // 参数与方案（2026-09-23 用户裁决：输出画幅/时长限制/转场动画/输出帧率改用按
  // 激活 tab 读写的绑定视图——每个分镜脚本各自一份，切换 tab 即切换设置）
  activeTabLayout, activeTabFps, activeTabDurationLimit,
  activeTabTransition, concatBusy, copyBusy,
  TRANSITIONS, FPS_OPTIONS, splitFps,
  statusText, concatProgress, splitResolution, filteredScenes,
  assemblePlans, currentPlanIdx, currentPlan,
  hasUnconfirmed, confirmedPaths, concatResults, planDurText,
  // 上一步（口播配音）的分镜脚本 + 每镜绑定素材（2026-09-21 用户裁决：
  // 确认合成的视频来源=分割镜头按分镜绑定；自动分配/单独选素材都写 shotClipIdx）
  storyboards, activeStoryboard, shotClipGroup, runConcatFromAllStoryboards, syncStoryboardsToServer,
  // 素材上传与镜头分割（2026-09-21 用户裁决：自智能混剪 Step1 移植到本页「本地上传」tab）
  // 2026-09-23 用户裁决：分割阈值输入框删除（智能匹配直采分割结果无需人工调敏；
  // 编排层 threshold 仍以默认 50 传服务端，行为不变）
  srcVideos, srcDurations, minSceneLen, imageDuration,
  scenes, scoreFilter, splitBusy, splitError, splitMsg, splitProgress,
  selectFolder, onDrop, removeVideo, runSplit, requestStopSplit, splitStatusOf, updateSceneDesc,
  previewSourceVideo, previewScene, clearSplitCache, openSplitsDir, splitsDownloading,
  // 动作
  planRowText, selectPlan, startSeqPreview, onSeqEnded,
  submitConcatTask, confirmAllPrecompose, confirmPlanSingle,
  openProductDlg, productDlg, closeProductDlg, productDlgGenerate,
  copyViewDlg, viewPlanCopy, closeCopyView, planMenu, openPlanMenu, closePlanMenu,
  onDetailDragStart, onDetailDragEnd, onDetailDrop, toggleClipDeleted,
  toAbsolute: vdToAbsolute,
} = shell.s

// ── 素材来源 tabs（2026-09-21 用户裁决：本地上传/素材库/在线库/AI生成/混合；
//    当前仅本地上传实装，其余占位）──
const SOURCE_TABS = ['本地上传', '素材库', '在线搜索', 'AI生成', '混合']
const sourceTab = ref('本地上传')

// ── 素材库 tab（2026-09-22 用户裁决：A1 落地——参考会话素材选择对话框界面：
//  关键字/品牌/型号/分类过滤 + 卡片网格勾选（跨页保留）+ 分页；数据源 /material/list
//  （useWorkbenchPickers，服务端字段实测含 duration_s/shot_type/scene_desc/quality_score，
//  智能匹配语义层齐备）。「加入素材池」把选中项转 SplitSceneRow 追加 scenes——
//  serverPath=material://{id}（服务端 concat 原生支持，见 0921 成片日志）、
//  clipUrl=/material/serve（预览/按需下载）──
const LIB_PAGE_SIZE = 30
const libServerUrl = ref('')
async function ensureLibServerUrl(): Promise<void> {
  if (libServerUrl.value) return
  try { libServerUrl.value = String((await (window as any).tintin?.env?.serverPing?.())?.url || '') } catch (_) {}
}
const libKw = ref('')
const libBrand = ref('')
const libModel = ref('')
const libCategory = ref('')
const libBrandOpts = ref<string[]>([])
const libModelOpts = ref<string[]>([])
const libCatOpts = ref<string[]>([])
const libItems = ref<PickerItem[]>([])
const libLoading = ref(false)
const libError = ref('')
const libPage = ref(1)
const libTotal = ref(0)
const libTotalPages = computed(() => Math.max(1, Math.ceil(libTotal.value / LIB_PAGE_SIZE)))
const libHasPager = computed(() => libTotal.value > LIB_PAGE_SIZE)
const libSelected = ref(new Map<string, PickerItem>())
const libSelectedCount = computed(() => libSelected.value.size)
const libThumbFailed = ref<Record<number, boolean>>({})
const libMsg = ref('')

// ── 素材来源弹窗（2026-09-22 用户裁决：素材选择与主界面分离——点击「选择素材」
//  弹出素材来源弹窗（本地上传/素材库等多 tab）；确认后自动智能镜头分割；
//  已选择过则按钮变「重新选择素材」，分割进行中再点先停止确认（已完成素材保留、
//  确认后只分割未完成的素材））──
const srcDlg = ref(false)
const hasSelected = ref(false)
const srcStopConfirm = ref(false)
// 2026-09-23 用户裁决：素材列表可折叠——标题行箭头收起/展开「已选择的原始视频素材」
// 列表与计数行，为弹窗内分割参数/进度区省出高度；仅内存态，重开弹窗自动展开
const srcListCollapsed = ref(false)
// 2026-09-23 用户裁决：弹窗右上角窗口化控制——最大化铺满父窗口（100vw×100vh）、
// 还原回 min(1840px,92vw) 常规尺寸、关闭=取消；双击标题行同最大化/还原切换
const srcDlgMax = ref(false)
const srcSummary = computed(() => {
  const parts: string[] = []
  if (srcVideos.value.length) parts.push(`本地视频 ${srcVideos.value.length} 个`)
  if (filteredScenes.value.length) parts.push(`素材池 ${filteredScenes.value.length} 条片段`)
  return parts.length ? `已选素材：${parts.join('，')}` : '尚未选择素材：点下方「选择素材」开始'
})
/** 选择池构成摘要（2026-09-23 用户裁决：本地分割/素材库两来源分计数） */
const poolSummary = computed(() => {
  const lib = filteredScenes.value.filter((s) => s.serverPath.startsWith('material://')).length
  const local = filteredScenes.value.length - lib
  const parts: string[] = []
  if (local) parts.push(`本地分割 ${local}`)
  if (lib) parts.push(`素材库 ${lib}`)
  return `${filteredScenes.value.length} 条片段${parts.length ? '（' + parts.join(' · ') + '）' : ''}`
    + (filteredScenes.value.some((s) => poolIsDup(s)) ? ` · 重复 ${filteredScenes.value.filter((s) => poolIsDup(s)).length}` : '')
})
/** 从选择池删除（2026-09-23 用户裁决）：按 idx 从 scenes 移除（池=filteredScenes 的
 *  直接来源，scoreFilter=0 时两者同径）。已被分镜绑定的片段删除后，方案构建会点名
 *  「绑定的素材已失效」，重新智能匹配即可重建绑定；下次分割会整体重建池并连续重编号 */
function removePoolScene(idx: number): void {
  scenes.value = scenes.value.filter((s) => s.idx !== idx)
}
/** 重复标注（2026-09-23 用户裁决：相同文件=文件内容 hash 相同——MD5 主进程流式计算）。
 *  仅本地落盘片段（clipLocalPath）可算；素材库条目未下载前无文件可比对，不参与判重。
 *  占位空串=该路径哈希失败/不可判，防列表每次变化反复重试。 */
const poolHashes = reactive(new Map<string, string>())
let poolHashSeq = 0
watch(filteredScenes, (list) => {
  const token = ++poolHashSeq
  void (async () => {
    for (const s of list) {
      if (token !== poolHashSeq) return // 列表又变了：本次扫描作废，新 watch 触发会重扫
      const p = s.clipLocalPath || ''
      if (!p || poolHashes.has(p)) continue
      const r = await window.tintin.liveclip.hashFile({ path: p }).catch(() => null)
      poolHashes.set(p, (r && !('error' in r) && r.hash) ? r.hash : '')
    }
  })()
})
const poolHashDup = computed(() => {
  const count = new Map<string, number>()
  for (const s of filteredScenes.value) {
    const h = s.clipLocalPath ? poolHashes.get(s.clipLocalPath) || '' : ''
    if (!h) continue
    count.set(h, (count.get(h) || 0) + 1)
  }
  return new Set([...count].filter(([, c]) => c > 1).map(([h]) => h))
})
function poolIsDup(r: { clipLocalPath?: string }): boolean {
  const h = r.clipLocalPath ? poolHashes.get(r.clipLocalPath) || '' : ''
  return !!h && poolHashDup.value.has(h)
}
function openSrcDlg(): void {
  if (splitBusy.value) { srcStopConfirm.value = true; return }
  srcDlg.value = true
}
function confirmStopAndReselect(): void {
  requestStopSplit()
  srcStopConfirm.value = false
  srcDlg.value = true
}
function confirmSrcDlg(): void {
  srcDlg.value = false
  hasSelected.value = true
  // 断点续分：已完成的素材自动跳过，只分割未完成的（重新选择=只补分割新素材）
  if (srcVideos.value.length) void runSplit()
}

function libMid(it: PickerItem): string {
  return String(it?.material_id ?? it?.id ?? '').trim()
}
function libName(it: PickerItem): string {
  return String(it?.filename || '') || (libMid(it) ? `素材 ${libMid(it)}` : '未命名素材')
}
function libSub(it: PickerItem): string {
  return [String(it?.brand || ''), String(it?.model || ''), String(it?.product || it?.share_name || '')].filter(Boolean).join(' / ')
}
function libThumb(it: PickerItem): string {
  const mid = libMid(it)
  return mid ? buildMediaThumbUrl(libServerUrl.value, mid) : ''
}
function libThumbFail(i: number): void {
  libThumbFailed.value[i] = true
}
function libIsSelected(it: PickerItem): boolean {
  return libSelected.value.has(libMid(it))
}
function libToggle(it: PickerItem): void {
  const k = libMid(it)
  if (!k) return
  if (libSelected.value.has(k)) libSelected.value.delete(k)
  else libSelected.value.set(k, it)
}
function libSelectPageAll(): void {
  for (const it of libItems.value) {
    const k = libMid(it)
    if (k) libSelected.value.set(k, it)
  }
}
async function loadLibOpts(): Promise<void> {
  try {
    const [b, m, c] = await Promise.all([
      fetchMaterialDistinct('brand'),
      fetchMaterialDistinct('model'),
      fetchMaterialDistinct('category'),
    ])
    libBrandOpts.value = b
    libModelOpts.value = m
    libCatOpts.value = c
  } catch (_) { /* 候选拉取失败静默（过滤框仍可手输） */ }
}
async function runLib(p = 1): Promise<void> {
  await ensureLibServerUrl()
  libPage.value = Math.max(1, p)
  libLoading.value = true
  libError.value = ''
  libThumbFailed.value = {}
  try {
    const r = await fetchMaterialGrid({
      search: libKw.value,
      brand: libBrand.value,
      model: libModel.value,
      category: libCategory.value,
      mediaType: 'video',
      page: libPage.value,
      size: LIB_PAGE_SIZE,
    })
    libItems.value = r.items
    libTotal.value = r.total
  } catch (e) {
    libItems.value = []
    libTotal.value = 0
    libError.value = errText(e)
  } finally {
    libLoading.value = false
  }
}
watch(sourceTab, (t) => {
  if (t === '素材库') {
    void ensureLibServerUrl()
    void runLib(1)
    void loadLibOpts()
  }
})
/** 勾选 → 素材池：转 SplitSceneRow 追加 scenes（按 serverPath 去重；缺时长的条目
 *  无法参与装填，跳过并计数） */
function addLibToPool(): void {
  const picked = [...libSelected.value.values()]
  if (!picked.length) { libMsg.value = '请先勾选素材卡片。'; return }
  const existing = new Set(scenes.value.map((s) => s.serverPath))
  let nextIdx = scenes.value.reduce((m, s) => Math.max(m, s.idx), 0)
  let added = 0
  let skipped = 0
  for (const it of picked) {
    const mid = libMid(it)
    const dur = Number(it.duration_s) || 0
    const sp = mid ? `material://${mid}` : ''
    if (!sp || dur <= 0 || existing.has(sp)) { skipped++; continue }
    nextIdx++
    const desc = [String(it.scene_desc_primary || ''), String(it.scene_desc_secondary || '')].filter(Boolean).join('；')
    scenes.value.push({
      idx: nextIdx,
      name: libName(it),
      sourceName: libName(it),
      startSec: 0,
      endSec: dur,
      duration: dur,
      description: desc,
      analysis: desc,
      score: Number((it.quality_score as Record<string, unknown> | undefined)?.total) || undefined,
      clipUrl: `/material/serve?material_id=${mid}`,
      serverPath: sp,
      downloadState: 'pending',
      checked: true,
      shotType: String(it.shot_type || '') || undefined,
      resolution: it.width && it.height ? `${Number(it.width)}x${Number(it.height)}` : undefined,
    })
    existing.add(sp)
    added++
  }
  libSelected.value.clear()
  libMsg.value = added
    ? `已把 ${added} 条素材库素材加入素材池${skipped ? `（${skipped} 条重复/缺时长跳过）` : ''}；请点「智能匹配到分镜脚本」。`
    : '所选素材均已在素材池中（或缺少时长元数据）。'
}


// 2026-09-07 缩略图改主进程 ffmpeg 抽帧（dataURL <img>）：根治多路 <video> 解码器
// 并发初始化崩溃，且全部素材行均有缩略图，抽帧失败行回退占位图标（自智能混剪 Step1 移植）
const thumbs = reactive(new Map<string, string>())
let thumbSeq = 0
let thumbToken = 0
watch(() => [...srcVideos.value], (list) => {
  const token = ++thumbToken
  void (async () => {
    // 3 路并发池：4K XAVC 单帧解码较慢，串行 50 行需数分钟
    const pending = list.filter((v) => !thumbs.has(v))
    let cursor = 0
    const worker = async () => {
      while (token === thumbToken && cursor < pending.length) {
        const v = pending[cursor++]
        // 每素材独立 tag（extractFrames 输出目录按 tag 清空重建，避免互踩）
        try {
          const r = await window.tintin.ffmpeg.extractFrames({
            videoPath: v, times: [1.0], tag: `copysrcthumb${++thumbSeq}`, width: 160, quality: 3,
          })
          if (token !== thumbToken) return
          const b64 = r?.frames?.[0]?.base64
          if (b64) thumbs.set(v, `data:image/jpeg;base64,${b64}`)
        } catch { /* 抽帧失败 → 该行显示占位图标 */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()))
  })()
}, { immediate: true })
onUnmounted(() => { thumbToken++ })

/** 素材行时长文案（ffprobe 探测结果；未就绪/失败显 —） */
function fmtSrcDur(v: string): string {
  const d = srcDurations.get(v)
  return d && d > 0 ? d.toFixed(1) + 's' : '—'
}

/** 输出画幅下拉（首项动态附分割片段画幅） */
const LAYOUTS = computed(() => [
  { label: splitResolution.value ? `与分割视频一致 (${splitResolution.value})` : '与分割视频一致', value: 'source' },
  { label: '竖屏 (1080x1920 抖音流)', value: 'vertical' },
  { label: '横屏 (1920x1080 宽屏)', value: 'horizontal' },
])

const assignMsg = ref('')

/** 已分割镜头表显隐（2026-09-22 用户裁决：暂时不显示；恢复时改 true。
 *  显式 boolean 注解——字面量 false 会让 vue-tsc 对分支内类型收窄变严连锁报错） */
const splitTableVisible: boolean = false

/** 智能匹配到分镜脚本（2026-09-21 用户裁决方案 C：「自动分配到分镜脚本」按钮直接升级——
 *  逐脚本一次 llm:chat：本地硬约束预筛候选（景别桶>时长窗>评分，copywritingMontageAssignLogic）
 *  → LLM 候选内语义精选 → 校验解析；失败/缺槽按原循环轮转兜底（全局镜头序跨脚本连续
 *  取模，各素材使用次数均衡）。素材来源将来含在线/AI 生成时同样进 buildAssignPool 池 */
const smartAssignBusy = ref(false)
/** 匹配目标选择弹窗（2026-09-23 用户裁决）：点「智能匹配到分镜脚本」先弹窗勾选要
 *  匹配哪些分镜脚本（默认全选=原批量口径），确认后才执行；单选 narrowing 即取消勾选 */
const matchDlg = ref({ show: false, selectedIds: [] as string[] })
function openMatchDlg(): void {
  if (splitBusy.value) {
    assignMsg.value = '镜头分割进行中：素材池尚未完整，请等分割完成后再智能匹配。'
    return
  }
  if (!filteredScenes.value.length) {
    assignMsg.value = '没有可用素材：请先上传素材并完成镜头分割。'
    return
  }
  if (!storyboards.value.length) {
    assignMsg.value = '还没有分镜脚本：请先在「文案编写」页生成。'
    return
  }
  matchDlg.value = { show: true, selectedIds: storyboards.value.map((t) => t.id) }
  // 产品快照懒回填（2026-09-23 用户裁决：弹窗展示脚本基本信息）——旧 tab 无快照时
  // 按脚本库 id 拉详情补品牌/产品/型号（best-effort 静默，取到即写入 tab 长期缓存）
  for (const t of storyboards.value) {
    if (t.productBrief || !t.scriptId) continue
    void (async () => {
      try {
        const data = (await window.tintin.server.get(`/api/storyboard/scripts/${encodeURIComponent(t.scriptId)}`, {})) as unknown
        if (!data || typeof data !== 'object' || 'error' in data) return
        const script = parseScriptDetail(data)
        const brief = script
          ? [script.product.brand, script.product.category, script.product.model].filter(Boolean).join(' / ')
          : ''
        if (brief) t.productBrief = brief
      } catch (_) { /* 静默：缺产品信息不阻断弹窗 */ }
    })()
  }
}
async function confirmMatchDlg(): Promise<void> {
  const ids = matchDlg.value.selectedIds.slice()
  if (!ids.length) return
  matchDlg.value.show = false
  await applyAssignment(ids)
}
async function applyAssignment(matchIds?: string[]): Promise<void> {
  // 2026-09-22 用户报障：分割未完成时匹配成功、合成有进度，但分割完成刷新表格后
  // 合成"丢失"（产物孤儿化 + 方案素材集过期）——分割期间禁入，双按钮同口径禁用
  if (splitBusy.value) {
    assignMsg.value = '镜头分割进行中：素材池尚未完整，请等分割完成后再智能匹配。'
    return
  }
  const pool = buildAssignPool(filteredScenes.value)
  if (!pool.length) {
    assignMsg.value = '没有可用素材：请先上传素材并完成镜头分割。'
    return
  }
  const all = storyboards.value.slice()
  if (!all.length) {
    assignMsg.value = '还没有分镜脚本：请先在「文案编写」页生成。'
    return
  }
  // 2026-09-23 用户裁决：只匹配弹窗勾选的脚本；未传=全量（兼容口径）
  const tabs = matchIds && matchIds.length ? all.filter((t) => matchIds.includes(t.id)) : all
  if (!tabs.length) {
    assignMsg.value = '未选择要匹配的分镜脚本。'
    return
  }
  smartAssignBusy.value = true
  let cyclicK = 0
  let total = 0
  let aiHit = 0
  let coveredAll = 0
  let targetAll = 0
  const failedTabs: string[] = []
  try {
    for (let ti = 0; ti < tabs.length; ti++) {
      const tab = tabs[ti]
      if (!tab.shots.length) { tab.clipGroups = []; continue }
      statusText.value = `智能匹配中（第 ${ti + 1}/${tabs.length} 个分镜脚本）…`
      const candidates = buildAssignCandidateSet(tab.shots, pool)
      let parsed: Map<number, number> | null = null
      try {
        const { systemPrompt, userPrompt } = buildAssignMatchPrompt(tab.shots, candidates)
        const res = await window.tintin.server.llmChat({
          model: '',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        })
        if (res && 'error' in res) throw new Error(String(res.error) || 'LLM 返回空错误')
        const content = String(res?.choices?.[0]?.message?.content ?? '')
        parsed = parseAssignMatchResponse(content, tab.shots.length, candidates.length)
        if (!parsed) throw new Error('匹配结果解析失败（未返回合法 matches JSON）')
      } catch (e) {
        clientError('copywriting-montage', '智能匹配 LLM 失败（该脚本整组循环兜底）', errText(e))
        failedTabs.push(tab.name)
        parsed = null
      }
      const { idxs, matched, nextK } = mergeTabAssignment(tab.shots.length, parsed, candidates, pool, cyclicK)
      cyclicK = nextK
      // 一镜多片装填（2026-09-22 用户裁决开工：方案C——主片按镜标×0.9 封镜，末端超长
      // 裁剪到剩余量；每镜绑定组写 tab.clipGroups，确认预合成按组渲染/拼接）
      const groups: number[][] = []
      tab.shots.forEach((shot, si) => {
        const fill = planShotGroup(shot, idxs[si] ?? -1, pool)
        groups.push(fill.idxs)
        coveredAll += fill.coveredSec
        targetAll += Math.max(0, Number(shot.duration) || 0)
        const first = pool.find((pc) => pc.scene.idx === (fill.idxs[0] ?? -1))
        if (first && shot) {
          shot.material_path = first.scene.clipUrl || first.scene.name || ''
          shot.material_type = 'video'
        }
      })
      tab.clipGroups = groups
      total += tab.shots.length
      aiHit += matched
    }
    const fallback = total - aiHit
    const failNote = failedTabs.length ? `；脚本「${failedTabs.join('」「')}」LLM 不可用已整组兜底` : ''
    assignMsg.value = `智能匹配完成：${tabs.length} 个分镜脚本共 ${total} 镜，AI 命中 ${aiHit}、循环兜底 ${fallback}；装填后画面 Σ${coveredAll.toFixed(1)}s（镜标设计 Σ${targetAll.toFixed(1)}s，素材池去重后 ${pool.length} 段）${failNote}`
    void syncStoryboardsToServer()
  } finally {
    smartAssignBusy.value = false
  }
}

/** 生成剪辑方案（2026-09-22 用户裁决·架构：虚拟时间轴——出方案即就绪，不再渲染
 *  预合成 mp4；导出草稿直接按方案逐镜片段+useDurs 源裁剪组装，转场/时长进剪映可编辑）：
 *  按分镜出方案 → 同步脚本库 */
async function onConfirmCompose(): Promise<void> {
  // 2026-09-22 用户报障：分割未完成时的方案素材集过期——分割期间禁入
  if (splitBusy.value) {
    notify('镜头分割进行中', '素材池尚未完整，请等分割完成后再生成剪辑方案。')
    return
  }
  const tabs = storyboards.value.map((s) => ({ id: s.id, name: s.name, narrative: s.narrative, shots: s.shots, clipGroups: s.clipGroups.map((g) => g.slice()) }))
  const ok = await runConcatFromAllStoryboards(tabs)
  // 2026-09-23 用户裁决：生成剪辑方案成功后同步脚本到服务端（await 确保确定性执行，
  // 同步进行中的重复触发由尾随合并守卫合并，不再静默丢弃）
  if (ok) await syncStoryboardsToServer()
}

/** 全部 tab 绑定齐全才允许预合成（用户裁决 4：必须全部 tab 绑定全——每镜至少 1 片） */
const tabsAllBound = computed(() =>
  storyboards.value.length > 0 &&
  storyboards.value.every((tab) =>
    tab.shots.length > 0 && tab.clipGroups.length === tab.shots.length && tab.clipGroups.every((g) => g.length >= 1)))

/** 预合成完成标识（2026-09-22 用户裁决）：全部方案已确认合成 → 按钮前缀对号，
 *  同智能匹配完成形态；重新智能匹配生成新方案（未确认）后对号自然消失 */
const precomposeDone = computed(() => assemblePlans.value.length > 0 && !hasUnconfirmed.value)

/** 评分着色（原版 L1443-1448：≥8 绿 / ≥6 黄 / ≥0 红）；Step1 用途已迁 Step1Panel，Step2 详情表仍消费 */
function scoreClass(score: number | undefined): string {
  if (!score) return ''
  if (score >= 8) return 'score-high'
  if (score >= 6) return 'score-mid'
  return 'score-low'
}
</script>

<template>
      <section class="card">
        <VdStepBar :step="step" :steps="steps" @go="go" />
        <!-- 分镜脚本（2026-09-21 用户裁决：上一步的分镜脚本在页面顶部显示（material 态，
             只读 + 自动分配的素材镜头列表）；素材上传/分割区移到脚本下面） -->
        <CopyStoryboard mode="material" />

        <!-- 素材来源（2026-09-21 用户裁决：本地上传/素材库/在线库/AI生成/混合 五个 tab，
             当前仅本地上传实装；上传素材+镜头分割自智能混剪 Step1 移植） -->
      </section>

      <!-- 选择素材弹窗（2026-09-22 用户裁决：素材选择与主界面分离——
           点击「选择素材」弹出素材来源弹窗（本地上传/素材库等 tab），
           确认后关闭弹窗并自动智能镜头分割） -->
      <teleport to="body">
        <div v-if="srcDlg" class="modal-mask srcdlg-mask" @click.self="srcDlg = false">
          <div class="modal srcdlg-modal" :class="{ 'srcdlg-modal--max': srcDlgMax }">
            <!-- 2026-09-23 用户裁决：标题行右上角窗口化控制（最大化/还原/关闭） -->
            <div class="srcdlg-head" @dblclick="srcDlgMax = !srcDlgMax">
              <span class="modal-title">选择素材</span>
              <span class="spacer"></span>
              <button class="wnd-btn" type="button"
                :title="srcDlgMax ? '还原' : '最大化'"
                @click="srcDlgMax = !srcDlgMax">
                <svg v-if="!srcDlgMax" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <rect x="8" y="8" width="12" height="12" rx="2" />
                  <path d="M4 16V6a2 2 0 0 1 2-2h10" />
                </svg>
              </button>
              <button class="wnd-btn wnd-btn--close" type="button" title="关闭" @click="srcDlg = false">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div class="srcdlg-body">
        <!-- 2026-09-23 用户裁决：弹窗左右两栏 1:1——左=素材来源 tabs（原内容），
             右=选择池（本地上传分割产物/素材库加入/AI 生成确认后统一进池，
             确认关闭后执行卡常显选择池条，供智能匹配消费） -->
        <div class="srcdlg-cols">
        <div class="srcdlg-left">
        <div class="src-tabs">
          <button v-for="t in SOURCE_TABS" :key="t" class="src-tab" :class="{ active: sourceTab === t }"
            @click="sourceTab = t">{{ t }}</button>
        </div>

        <template v-if="sourceTab === '本地上传'">
          <div class="dropzone" @click="selectFolder" @drop.prevent="onDrop" @dragover.prevent>
            <span class="dz-main">拖入素材文件夹（自动遍历子文件夹内全部视频） 或 点击选择文件夹</span>
            <span class="dz-hint">支持 mp4 / mov / avi / mkv / flv / webm / m4v，服务端完成分割与逐镜分析</span>
          </div>

          <div class="row sec-head">
            <span class="sec-label">已选择的原始视频素材 (双击可播放预览):</span>
            <!-- 2026-09-23 用户裁决：折叠箭头——收起素材列表省高度；折叠时标题补条数 -->
            <button class="src-collapse" type="button"
              :title="srcListCollapsed ? '展开素材列表' : '折叠素材列表'"
              @click="srcListCollapsed = !srcListCollapsed">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                :style="{ transform: srcListCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <span v-if="srcListCollapsed && srcVideos.length" class="muted">已折叠，共 {{ srcVideos.length }} 个素材</span>
          </div>
          <ul v-show="!srcListCollapsed" class="file-list src-video-list">
            <li v-for="(v, i) in srcVideos" :key="v" :title="v" class="split-status-row" :class="'split-' + (splitStatusOf(v) || 'none')">
              <img v-if="thumbs.get(v)" class="video-thumb" :src="thumbs.get(v)" alt="" />
              <span v-else class="video-thumb video-thumb--ph" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="15" height="14" rx="2" /><polygon points="10 8 16 11 10 14" fill="currentColor" stroke="none" /><path d="M19 8l3-2v12l-3-2" /></svg>
              </span>
              <span class="video-path" @dblclick="previewSourceVideo(v)">{{ v }}</span>
              <span class="video-dur">{{ fmtSrcDur(v) }}</span>
              <button class="video-play-btn" title="播放" @click="previewSourceVideo(v)">▶</button>
              <button class="video-remove-btn" title="从素材列表移除" @click="removeVideo(i)">×</button>
            </li>
            <li v-if="!srcVideos.length" class="muted">暂无素材，拖入或点击上方区域选择</li>
          </ul>
          <div v-if="srcVideos.length && !srcListCollapsed" class="video-count-footer">选择视频共 {{ srcVideos.length }} 行</div>

          <!-- 分割参数行 + 行内右对齐「开始智能镜头分割」
               （2026-09-23 用户裁决：分割阈值输入框删除——分割结果由智能匹配直采，
               无需人工调敏感度；编排层仍以默认 50 传服务端 montageSplit，行为不变） -->
          <div class="row">
            <label class="param-label">最小镜头(秒):</label>
            <input v-model.number="minSceneLen" type="number" step="0.1" min="0.1" max="60" class="input w80" />
            <label class="param-label" title="无法分割的视频，自动挑出多长的片段">分镜头时长(秒):</label>
            <input v-model.number="imageDuration" type="number" min="1" max="30"
              title="无法分割的视频，自动挑出多长的片段" class="input w80" />
            <span class="spacer"></span>
            <TButton label="开始智能镜头分割" icon="cut" :loading="splitBusy" @click="runSplit" />
            <!-- 2026-09-22 用户裁决：停止分割（当前素材完成后停止，已完成素材保留可断点续分） -->
            <TButton label="停止分割" variant="secondary" :disabled="!splitBusy" title="停止智能镜头分割：当前素材完成后停止，已完成素材保留（列表淡绿标识）" @click="requestStopSplit" />
          </div>
          <progress v-if="splitBusy" class="vd-progress split-progress" :value="splitProgress" max="100" />
          <div v-if="splitMsg" class="hint">{{ splitMsg }}</div>
          <div v-if="splitError" class="error-msg">⚠ {{ splitError }}（修正后重按「开始智能镜头分割」重试）</div>

          <!-- 已分割镜头表（2026-09-22 用户裁决：暂时不显示——分割结果由智能匹配直接消费，
               无需人工浏览勾选；恢复显示时把 splitTableVisible 改回 true 即可） -->
          <template v-if="splitTableVisible">
          <div class="row between">
            <span class="sec-label">已分割出的最小单位镜头片段 (双击可播放预览，双击画面描述列可手动修改):</span>
            <label class="muted">评分过滤:
              <select v-model.number="scoreFilter" class="input" title="按评分筛选镜头：达到阈值的镜头才会进入镜头列表参与自动分配">
                <option :value="0">不过滤</option>
                <option v-for="s in [1,2,3,4,5,6,7,8,9]" :key="s" :value="s">≥ {{ s }} 分</option>
              </select>
            </label>
          </div>
          <div class="tbl-scroll-wrap">
            <table class="tbl">
              <thead><tr>
                <th class="w32"></th><th>序号</th><th style="min-width:140px">视频片段</th><th>景别</th><th>位置</th><th>时长</th>
                <th>画幅</th><th style="min-width:200px">主要画面</th><th>产品</th><th>型号</th><th>评分</th>
              </tr></thead>
              <tbody>
                <tr v-for="r in filteredScenes" :key="r.idx" @dblclick="previewScene(r)">
                  <td><input v-model="r.checked" type="checkbox" @dblclick.stop /></td>
                  <td class="ta-c">{{ r.idx }}</td>
                  <td :title="r.clipUrl || r.name">{{ r.name }}</td>
                  <td class="ta-c">
                    <span v-if="r.shotType" class="shot-type-badge"
                      :style="{ color: SHOT_TYPE_COLORS[r.shotType] || '#888', borderColor: SHOT_TYPE_COLORS[r.shotType] || '#888' }">
                      {{ SHOT_TYPE_LABELS[r.shotType] || r.shotType }}
                    </span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td class="ta-c shot-source-cell" :title="r.positionSource || ''">
                    <span v-if="r.position" class="shot-type-badge"
                      :style="{ color: SHOT_TYPE_COLORS[r.position] || '#888', borderColor: SHOT_TYPE_COLORS[r.position] || '#888' }">
                      {{ SHOT_TYPE_LABELS[r.position] || r.position }}
                    </span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td class="ta-c">{{ r.duration > 0 ? r.duration.toFixed(1) + 's' : '—' }}</td>
                  <td class="ta-c">{{ r.resolution || splitResolution || '—' }}</td>
                  <td>
                    <input class="input desc-input" :value="r.description" placeholder="—"
                      @dblclick.stop @change="updateSceneDesc(r.idx, ($event.target as HTMLInputElement).value)" />
                  </td>
                  <td>{{ r.product || '—' }}</td>
                  <td>{{ r.model || '—' }}</td>
                  <td class="ta-c" :class="scoreClass(r.score)">{{ r.score ? r.score.toFixed(1) : '—' }}</td>
                </tr>
                <tr v-if="!filteredScenes.length"><td colspan="11" class="muted">暂无已分割镜头，请先上传素材并开始智能镜头分割</td></tr>
              </tbody>
            </table>
          </div>
          </template>
        </template>
        <template v-else-if="sourceTab === '素材库'">
          <!-- 素材库（2026-09-22 用户裁决 A1：参考会话素材选择对话框界面——过滤 + 卡片
               网格勾选（跨页保留）+ 分页 + 加入素材池；时长/景别/描述/评分走服务端字段） -->
          <div class="row">
            <input v-model="libKw" class="input grow" placeholder="搜索文件名/关键字…" @keydown.enter="runLib(1)" />
            <input v-model="libBrand" class="input lib-input-sm" list="lib-brand-opts" placeholder="品牌…" @keydown.enter="runLib(1)" />
            <input v-model="libModel" class="input lib-input-sm" list="lib-model-opts" placeholder="型号…" @keydown.enter="runLib(1)" />
            <input v-model="libCategory" class="input lib-input-sm" list="lib-cat-opts" placeholder="分类…" @keydown.enter="runLib(1)" />
            <datalist id="lib-brand-opts"><option v-for="o in libBrandOpts" :key="o" :value="o" /></datalist>
            <datalist id="lib-model-opts"><option v-for="o in libModelOpts" :key="o" :value="o" /></datalist>
            <datalist id="lib-cat-opts"><option v-for="o in libCatOpts" :key="o" :value="o" /></datalist>
            <TButton label="搜索" size="small" :loading="libLoading" @click="runLib(1)" />
          </div>
          <div class="lib-grid-wrap">
            <div v-if="libLoading" class="muted lib-state">加载中…</div>
            <div v-else-if="libError" class="error-msg lib-state">{{ libError }}</div>
            <div v-else-if="!libItems.length" class="muted lib-state">未找到匹配素材，换个条件试试。</div>
            <div v-else class="lib-grid">
              <button v-for="(it, i) in libItems" :key="libMid(it) || i" type="button"
                class="lib-card" :class="{ checked: libIsSelected(it) }"
                :title="`${libName(it)} · 点击勾选/取消`" @click="libToggle(it)">
                <img v-if="libThumb(it) && !libThumbFailed[i]" class="lib-thumb" :src="libThumb(it)" loading="lazy" alt="" @error="libThumbFail(i)" />
                <span v-else class="lib-thumb lib-thumb--ph">视频</span>
                <span class="lib-check" :class="{ on: libIsSelected(it) }">✓</span>
                <span class="lib-name">{{ libName(it) }}</span>
                <span class="lib-sub">{{ libSub(it) }}</span>
              </button>
            </div>
          </div>
          <div class="row between">
            <div class="row">
              <TButton label="全选本页" variant="secondary" size="small" :disabled="!libItems.length" @click="libSelectPageAll" />
              <TButton label="取消全选" variant="secondary" size="small" :disabled="!libSelectedCount" @click="libSelected.clear()" />
              <span class="muted">已选 {{ libSelectedCount }} 项（跨页保留）</span>
            </div>
            <div class="row">
              <span v-if="libHasPager" class="muted">共 {{ libTotal }} 条 · 第 {{ libPage }}/{{ libTotalPages }} 页</span>
              <TButton label="上一页" variant="secondary" size="small" :disabled="libPage <= 1 || libLoading" @click="runLib(libPage - 1)" />
              <TButton label="下一页" variant="secondary" size="small" :disabled="libPage >= libTotalPages || libLoading" @click="runLib(libPage + 1)" />
              <TButton :label="`加入素材池（${libSelectedCount}）`" :disabled="!libSelectedCount" @click="addLibToPool" />
            </div>
          </div>
          <div v-if="libMsg" class="hint">{{ libMsg }}</div>
        </template>
        <div v-else class="src-placeholder muted">「{{ sourceTab }}」素材来源暂不支持，当前仅支持本地上传</div>
        </div><!-- /srcdlg-left -->

        <!-- 右栏：选择池（智能匹配的输入；来源=本地上传分割产物 + 素材库加入 + AI 生成确认） -->
        <div class="srcdlg-pool">
          <div class="row between">
            <span class="sec-label">选择池</span>
            <span v-if="filteredScenes.length" class="muted">{{ poolSummary }}</span>
          </div>
          <div v-if="!filteredScenes.length" class="muted pool-empty">
            选择池为空：左侧上传素材完成「智能镜头分割」，或在「素材库」勾选后「加入素材池」，都会自动进入这里
          </div>
          <div v-else class="pool-list">
            <div v-for="r in filteredScenes" :key="r.idx" class="pool-card"
              :class="{ 'pool-card--dup': poolIsDup(r) }"
              :title="(r.description || r.name) + '（双击预览）'" @dblclick="previewScene(r)">
              <span class="pool-idx">#{{ r.idx }}</span>
              <!-- 2026-09-23 用户裁决：编号后带缩略图（clipUrl 首帧；#t=0.1 强制绘帧） -->
              <video class="pool-thumb" :src="vdToAbsolute(r.clipUrl) + '#t=0.1'"
                preload="metadata" muted tabindex="-1"></video>
              <span class="pool-name" :title="r.name">{{ r.name }}</span>
              <span class="pool-dur">{{ r.duration > 0 ? r.duration.toFixed(1) + 's' : '—' }}</span>
              <span v-if="r.shotType" class="pool-shot"
                :style="{ color: SHOT_TYPE_COLORS[r.shotType] || '#888', borderColor: SHOT_TYPE_COLORS[r.shotType] || '#888' }">
                {{ SHOT_TYPE_LABELS[r.shotType] || r.shotType }}
              </span>
              <span v-if="r.score" class="pool-score">{{ r.score.toFixed(1) }}分</span>
              <span v-if="poolIsDup(r)" class="pool-dup" title="与池内其他片段文件内容相同（MD5 一致）；素材库条目未下载前不参与比对">重复</span>
              <button class="pool-del" type="button" title="从选择池删除"
                @click.stop="removePoolScene(r.idx)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        </div><!-- /srcdlg-cols -->
            </div>
            <div class="modal-actions">
              <TButton label="取消" plain @click="srcDlg = false" />
              <TButton :label="hasSelected ? '选择完成，重新分割' : '选择完成，开始智能镜头分割'"
                :disabled="!srcVideos.length && !filteredScenes.length" @click="confirmSrcDlg" />
            </div>
          </div>
        </div>
      </teleport>

      <!-- 停止确认弹窗（分割进行中重选：先停止当前分割，已完成素材保留） -->
      <teleport to="body">
        <div v-if="srcStopConfirm" class="modal-mask" @click.self="srcStopConfirm = false">
          <div class="modal">
            <span class="modal-title">分割进行中</span>
            <div class="srcdlg-confirm">当前智能镜头分割尚未完成。确定停止当前分割并重新选择素材？已完成的素材会保留（淡绿标识），确认后只分割未完成的素材。</div>
            <div class="modal-actions">
              <TButton label="取消" plain @click="srcStopConfirm = false" />
              <TButton label="停止并重新选择" @click="confirmStopAndReselect" />
            </div>
          </div>
        </div>
      </teleport>

      <!-- 匹配目标选择弹窗（2026-09-23 用户裁决：匹配前先勾选要匹配到哪些分镜脚本，
           默认全选=原批量口径；确认后逐勾选脚本 LLM 匹配+兜底装填） -->
      <teleport to="body">
        <div v-if="matchDlg.show" class="modal-mask" @click.self="matchDlg.show = false">
          <div class="modal">
            <span class="modal-title">选择要匹配的分镜脚本</span>
            <div class="match-pick-list">
              <label v-for="t in storyboards" :key="t.id" class="match-pick-row">
                <input v-model="matchDlg.selectedIds" type="checkbox" :value="t.id" />
                <span class="match-pick-main">
                  <!-- 第一行：脚本名 + 统计；第二行：产品快照/选题/脚本 id（2026-09-23 用户裁决） -->
                  <span class="match-pick-line">
                    <span class="match-pick-name" :title="t.name">{{ t.name }}</span>
                    <span class="muted">{{ t.shots.length }} 镜{{ t.clipGroups.some((g) => g.length) ? ' · 已有绑定（匹配后覆盖）' : '' }}</span>
                  </span>
                  <span class="match-pick-meta">
                    <span :class="t.productBrief ? '' : 'muted'">{{ t.productBrief || '产品信息未记录' }}</span>
                    <span v-if="t.topic && t.topic !== t.name"> · 选题 {{ t.topic }}</span>
                    <span v-if="t.scriptId"> · {{ t.scriptId }}</span>
                  </span>
                </span>
              </label>
            </div>
            <div class="modal-actions">
              <TButton label="取消" plain @click="matchDlg.show = false" />
              <TButton :label="`开始匹配（已选 ${matchDlg.selectedIds.length} 个）`"
                :disabled="!matchDlg.selectedIds.length" :loading="smartAssignBusy" @click="confirmMatchDlg" />
            </div>
          </div>
        </div>
      </teleport>

      <section class="card">
        <!-- 选择素材 + 智能匹配到分镜脚本（2026-09-23 用户裁决：两按钮同一行平分；
             选择过素材后文案变「重新选择素材」，分割进行中再点先停止确认。
             匹配=本地预筛+LLM 精选+循环兜底，分配明细见顶部分镜脚本各镜） -->
        <div class="row duel-row">
          <TButton :label="hasSelected ? '重新选择素材' : '选择素材'" class="duel-half"
            title="选择素材来源（本地上传 / 素材库）" @click="openSrcDlg" />
          <TButton label="智能匹配到分镜脚本" icon="check" class="duel-half" :loading="smartAssignBusy"
            :disabled="splitBusy || !filteredScenes.length || !storyboards.length"
            :title="splitBusy ? '镜头分割进行中：素材池尚未完整，请等分割完成后再智能匹配' : '选择要匹配的分镜脚本，按分镜镜头的景别/时长/画面语义，从已分割素材中智能匹配并绑定素材'" @click="openMatchDlg" />
        </div>
        <div v-if="assignMsg" class="hint">{{ assignMsg }}</div>

        <!-- 选择池常显条（2026-09-23 用户裁决：弹窗确认关闭后，池内容在本卡展示——
             汇总来源计数 + 横向片段 chip（点击预览），即智能匹配的输入池） -->
        <div v-if="filteredScenes.length" class="pool-strip">
          <div class="row between">
            <span class="sec-label">选择池</span>
            <span class="muted">{{ poolSummary }}</span>
          </div>
          <div class="pool-chips">
            <button v-for="r in filteredScenes" :key="r.idx" type="button" class="pool-chip"
              :title="(r.description || r.name) + '（点击预览）'" @click="previewScene(r)">
              <span class="pool-idx">#{{ r.idx }}</span>
              <span class="pool-dur">{{ r.duration > 0 ? r.duration.toFixed(1) + 's' : '—' }}</span>
              <span v-if="r.shotType" class="pool-shot">{{ SHOT_TYPE_LABELS[r.shotType] || r.shotType }}</span>
            </button>
          </div>
        </div>
        <div v-else class="pool-strip pool-strip--empty">
          <span class="muted">选择池为空：点上方「选择素材」上传素材并完成智能镜头分割，或从素材库加入，即可进行智能匹配</span>
        </div>

        <!-- 参数设置组（2026-09-23 用户裁决：视频设置按 tab 绑定——输出画幅/时长限制/
             转场动画/输出帧率读写激活分镜自己的配置，切换上方分镜 tab 即切换设置；
             导出按各分镜自身 transition 消费） -->
        <div class="params-group">
          <div class="param-row">
            <span class="param-label" title="设置随上方激活的分镜 tab 切换；每个分镜脚本各自保存一份">当前分镜:</span>
            <span class="tab-bound-name" :title="activeStoryboard ? '本行设置为该分镜脚本独有配置' : '无分镜 tab 时为全局缺省'">
              {{ activeStoryboard ? activeStoryboard.name : '全局（无分镜）' }}</span>
            <span class="param-label">输出画幅:</span>
            <select v-model="activeTabLayout" class="input w180">
              <option v-for="o in LAYOUTS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span v-if="activeTabLayout === 'source'" class="src-res"
              title="分割片段画幅（2026-09-15 裁决：画幅基准=分割片段而非原素材），选择'与分割视频一致'时将使用此分辨率">
              分割画幅: {{ splitResolution || '未知' }}</span>
            <span class="param-label">时长限制:</span>
            <!-- 时长跟随本分镜口播声音的实际时长（派生只读）；未生成声音时为缺省 30 秒 -->
            <input :value="activeTabDurationLimit" readonly class="input w80"
              title="跟随本分镜克隆声音的实际时长；未生成声音时为缺省 30 秒" />
            <span class="hint">跟随声音</span>
            <!-- 2026-09-21 用户裁决：成片数=分镜脚本数，生成视频数量输入删除 -->
            <span class="param-label">转场动画:</span>
            <select v-model="activeTabTransition" class="input w120" title="本分镜成片的镜头间转场（剪映常用转场）；「随机」=镜间从三种转场随机">
              <option v-for="o in TRANSITIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <!-- 2026-09-22 用户裁决：「出入场加速」下拉移除——虚拟时间轴架构下无生效路径
                 （时长由装填+末端裁剪控制），镜级变速实装时以按镜设置新形态回归 -->
            <span class="param-label">输出帧率:</span>
            <select v-model="activeTabFps" class="input w140"
              title="成片帧率，随服务端合成提交 fps 字段（契约 integer，默认 30）。&#10;跟随原片：用服务端 split 响应的 source_resolution.fps（2026-09-11 实测有此字段），&#10;服务端未给时本地探测兑底；都不行则回退 30。&#10;29.97/23.976 等小数帧率服务端不收，一律取整。">
              <option v-for="o in FPS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span v-if="activeTabFps === 'source'" class="src-res"
              title="服务端 source_resolution.fps 优先，本地探测兑底；都拿不到时按 30 fps 提交">
              原片: {{ splitFps > 0 ? splitFps + ' fps' : '未知（回退 30）' }}</span>
          </div>
        </div>

        <!-- 确认行（2026-09-22 用户裁决·架构：预合成 mp4 移除——「生成剪辑方案」=
             虚拟时间轴就绪（秒级），导出草稿直接消费；完成对号=方案就绪标识） -->
        <div class="row confirm-row">
          <TButton label="生成剪辑方案" :loading="concatBusy"
            :icon="precomposeDone ? 'check' : ''"
            :disabled="splitBusy || !tabsAllBound"
            :title="splitBusy ? '镜头分割进行中：请等分割完成后再生成剪辑方案' : (precomposeDone ? '剪辑方案已生成；重新智能匹配后可再次生成' : '所有分镜脚本绑定完整素材后才能生成剪辑方案；有分镜缺素材时不能生成')" @click="onConfirmCompose" />
          <!-- 2026-09-21 用户裁决：「生成口播文案」删除——文案在第一步编写/生成，旁白已在第二步克隆 -->
        </div>
        <!-- 2026-09-22 架构：剪辑方案=虚拟时间轴秒级生成，原渲染进度条块随之移除 -->

        <!-- 导航行（2026-09-10 用户裁决：上/下步按钮属操作区，归左栏底部；原版 nav_row L288-301） -->
        <div class="row between">
          <!-- 2026-09-17 用户裁决：上一步删除；下一步=跳转口播配音界面（换序后 go(1)） -->
          <TButton label="上一步：口播配音" icon="left" @click="go(1)" />
          <!-- 2026-09-21 用户裁决：完成第三步可进入第四步特效包装 -->
          <TButton label="下一步：特效包装" icon="right" @click="go(3)" />
        </div>
      </section>




</template>

<style scoped>
/* 顶部步骤条 .step-bar 系样式已迁入 VdStepBar.vue（2026-09-10 tab 入操作区） */

.sec-label { font-size: 13px; font-weight: 600; color: var(--foreground); }
/* 素材列表折叠标题行 + 箭头按钮（2026-09-23 用户裁决：可收起素材列表省高度） */
.sec-head { gap: var(--space-2); }
.src-collapse {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0;
  background: transparent; border: 1px solid var(--border); border-radius: var(--radius-md);
  color: var(--muted-foreground); cursor: pointer;
  transition: all var(--duration-fast);
}
.src-collapse:hover { color: var(--primary); border-color: var(--primary); }
.src-collapse svg { transition: transform var(--duration-fast); }
.param-label { font-size: 13px; color: var(--foreground); white-space: nowrap; }
/* 每脚本视频设置：当前绑定分镜名徽标（2026-09-23 用户裁决：设置按 tab 绑定的可视锚点） */
.tab-bound-name {
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 10px; font-size: 12px; font-weight: 700; color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent); border-radius: 999px;
}
.spacer { flex: 1; }
.ta-c { text-align: center; }
.w32 { width: 32px; }
.card { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.shot-source-cell { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
/* Step1 解析进度条（复用 vd-progress 配色） */
.split-progress { margin: 6px 0 2px; }
.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.row.right { justify-content: flex-end; }
.row.left { justify-content: flex-start; }
.label, .card-title { font-size: 13px; font-weight: 600; color: var(--foreground); }
.muted { color: var(--muted-foreground); font-size: 12px; }
.hint { color: var(--muted-foreground); font-size: 12px; }
.error-msg { color: var(--danger, #e74c3c); font-size: 12px; }
.clip-count { font-weight: 700; }
.input { height: 32px; padding: 0 10px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--foreground); outline: none; font-size: 13px; }
.input:focus { border-color: var(--primary); }
.input.grow { flex: 1; min-width: 120px; }
.w80 { width: 80px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl-scroll-wrap { max-height: 420px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
.tbl-scroll-wrap .tbl { border-radius: 0; }
.tbl th, .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.tbl th { color: var(--muted-foreground); font-weight: 500; font-size: 12px; position: sticky; top: 0; background: var(--surface-container); z-index: 1; }
.shot-type-badge {
  display: inline-block; padding: 1px 6px; border: 1px solid;
  border-radius: 4px; font-size: 11px; font-weight: 600; line-height: 1.4;
}
/* Step2 镜头重组（原版 params_group/result_box/player 等同布局；颜色走 V3 design tokens） */
.params-group {
  display: flex; flex-direction: column; gap: 10px; padding: 10px 12px;
  background: var(--surface-container); border: 1px solid var(--border); border-radius: var(--radius-md);
}
.param-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.param-row .param-label { margin-left: var(--space-3); }
.param-row .param-label:first-child { margin-left: 0; }
.src-res { color: var(--warning); font-size: 11px; margin-left: 4px; }
.w60 { width: 60px; }
.w90 { width: 90px; }
.w120 { width: 120px; }
.w140 { width: 140px; }
.w180 { width: 180px; }
.clip-count { font-weight: 700; font-size: 14px; color: var(--warning); }
.result-box {
  display: flex; flex-direction: column; gap: 10px; padding: 10px;
  background: var(--surface-container); border: 1px dashed var(--border); border-radius: var(--radius-md);
}
/* 预合成列表（2026-09-09 用户裁决改表格；2026-09-11 用户裁决：最大 10 行高度，
   超出滚动；不足 10 行随真实行数收缩——占位行已删，防止两表之间空余过多） */
.plan-tbl-wrap {
  /* 380px = 表头(约30px) + 10 行(约35px/行) 完整可见（旧值 332px 行高下只能显 9 行） */
  max-height: 380px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-md);
}
.plan-tbl-wrap .plan-tbl { border-radius: 0; }
.plan-tbl tr { cursor: pointer; }
.plan-tbl tbody tr:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
.plan-tbl tr.picked { background: color-mix(in srgb, var(--primary) 12%, transparent); }
.plan-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.plan-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); }
.plan-empty { padding: 8px 10px; }
.w48 { width: 48px; white-space: nowrap; }
.w64 { width: 64px; white-space: nowrap; }
/* 下半区：分割镜头详情表（表头 + 10 行高，见 .detail-scroll-wrap） */
.result-bottom { display: flex; gap: 15px; align-items: flex-start; }
.detail-col { flex: 3; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.detail-scroll-wrap {
  /* 用户裁决(2026-09-11)：镜头详情至少显示 10 行 → 380px（同上方预合成列表口径） */
  max-height: 380px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.detail-scroll-wrap .tbl { border-radius: 0; }
.detail-placeholder-row td { height: 30px; border-bottom: 1px solid var(--border); }
/* 右侧播放器 .player-col/.player-wrap 系已删：连播预览迁右侧统一预览栏 StepPreviewPane（2026-09-10） */
.detail-tbl td { height: 30px; }
.grip-cell { cursor: grab; color: var(--muted-foreground); user-select: none; }
.row-deleted td {
  color: var(--muted-foreground); text-decoration: line-through;
  background: rgba(231, 76, 60, 0.12);
}
.clip-name, .clip-desc { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.confirm-row > * { flex: 1; }
.pick-right .modal-field--stack :deep(.input) { width: 100%; flex: none; }
/* 参考文案（2026-09-11 用户裁决：单行 input 显示不全 → 两行高度，可纵向拉伸）。
   源序必须在 .input 之后（同特异性覆盖其 height:32px / padding:0 10px） */
.ref-text {
  height: auto; min-height: 52px; padding: 6px 10px;
  line-height: 1.5; font-family: inherit; resize: vertical;
}
.dropzone { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px; min-height: 120px; padding: var(--space-5); background: color-mix(in srgb, var(--primary) 6%, var(--surface-container)); border: 1.5px dashed color-mix(in srgb, var(--primary) 40%, var(--border)); border-radius: var(--radius-lg); cursor: pointer; color: var(--foreground); transition: border-color var(--duration-fast), background var(--duration-fast); }
.dropzone:hover, .dropzone.is-active { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, var(--surface-container)); }
.dz-main { font-size: var(--font-size-body); font-weight: var(--font-weight-medium); }
.dz-hint { font-size: var(--font-size-caption); color: var(--muted-foreground); }
.icon-btn {
  width: 28px; height: 24px; padding: 0; font-size: 13px; line-height: 1; flex: none;
  background: var(--card); color: var(--foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.icon-btn:hover:not(:disabled) { border-color: var(--primary); }
.icon-btn:disabled { opacity: .4; cursor: not-allowed; }
.vd-progress-text { font-size: 11px; color: var(--primary); }
.concat-status-line { font-size: 11px; color: var(--primary); margin: 4px 0 2px; }
.muted-tag { width: 48px; color: var(--muted-foreground); }
.vd-progress { width: 100%; height: 6px; appearance: none; border-radius: 3px; overflow: hidden; }
.vd-progress::-webkit-progress-bar { background: var(--surface-container); }
.vd-progress::-webkit-progress-value { background: var(--primary); transition: width 0.3s; }
.bgm-pick-right .row { gap: 6px; }
/* 折叠按钮（最右侧）：不用 .icon-btn（28px 宽装不下中文） */
.textfx-toggle {
  flex: none; height: 24px; padding: 0 8px; font-size: 12px; white-space: nowrap;
  background: var(--card); color: var(--muted-foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.w80 { width: 80px; flex: none; }
/* ── 素材来源 tabs + 本地上传（自智能混剪 Step1 移植，2026-09-21 用户裁决）── */
.src-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.src-tab {
  height: 32px; padding: 0 16px; border: none; background: transparent;
  color: var(--muted-foreground); font-size: 13px; cursor: pointer;
  border-bottom: 2px solid transparent;
}
.src-tab:hover { color: var(--foreground); }
.src-tab.active { color: var(--primary); font-weight: 600; border-bottom-color: var(--primary); }
.src-placeholder { padding: 24px; text-align: center; background: var(--surface-container); border-radius: var(--radius-md); }
/* 选择素材弹窗（2026-09-22 用户裁决：素材选择与主界面分离） */
.srcdlg-mask { z-index: 120; }
/* ⚠ 宽度覆盖必须 .modal.srcdlg-modal 双类（优先级压过后方 .modal 的 440px/90vw）——
   此前单类 .srcdlg-modal 写在前被 .modal 反压，弹窗一直按 440px 渲染（最大化同被压）。
   2026-09-23 用户裁决：宽度=原来的 2.5 倍（440→1100px），94vw 封顶 */
.modal.srcdlg-modal { width: min(1100px, 94vw); max-height: 86vh; }
/* 2026-09-23 用户裁决：最大化态铺满父窗口（100vw×100vh），去圆角与限高 */
.modal.srcdlg-modal--max { width: 100vw; height: 100vh; max-width: none; max-height: none; border-radius: 0; }
/* 标题行窗口化控制（最大化/还原/关闭，双击标题行同切换） */
.srcdlg-head { display: flex; align-items: center; gap: var(--space-2); }
.wnd-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 24px; padding: 0;
  background: transparent; border: none; border-radius: var(--radius-md);
  color: var(--muted-foreground); cursor: pointer;
  transition: all var(--duration-fast);
}
.wnd-btn:hover { background: var(--surface-container); color: var(--foreground); }
.wnd-btn--close:hover { background: var(--destructive, #e5484d); color: #fff; }
.srcdlg-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-3); }
/* 2026-09-23 用户裁决：弹窗左右两栏 1:1——左=素材来源 tabs，右=选择池 */
.srcdlg-cols { display: flex; gap: var(--space-4); align-items: flex-start; }
.srcdlg-left { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.srcdlg-pool {
  flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-3); background: var(--surface-container);
  border: 1px dashed color-mix(in srgb, var(--primary) 35%, var(--border)); border-radius: var(--radius-lg);
}
/* 选择池：一行一条（2026-09-23 用户裁决：高度加倍+编号后缩略图，替代过密的网格） */
.pool-list { display: flex; flex-direction: column; gap: 8px; }
.pool-card {
  display: flex; align-items: center; gap: 10px; padding: 5px 10px; min-width: 0;
  min-height: 56px;
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);
  cursor: pointer; transition: border-color var(--duration-fast);
}
.pool-card:hover { border-color: var(--primary); }
/* 重复条目标注（2026-09-23 用户裁决：同名/同路径判重，琥珀色徽标+边框） */
.pool-card--dup { border-color: color-mix(in srgb, #f5a623 55%, var(--border)); }
.pool-dup {
  flex: none; font-size: 11px; font-weight: 700; padding: 0 6px;
  color: #d98a00; border: 1px solid #f5a623; border-radius: 999px;
}
.pool-idx { flex: none; min-width: 30px; font-size: 12px; font-weight: 700; color: var(--primary); }
.pool-thumb {
  flex: none; width: 84px; height: 48px; object-fit: cover;
  background: #000; border-radius: var(--radius-md); pointer-events: none;
}
.pool-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--foreground); }
.pool-dur { flex: none; font-size: 12px; font-weight: 700; color: var(--success); }
.pool-shot { flex: none; font-size: 11px; padding: 0 5px; border: 1px solid #888; border-radius: 999px; color: #888; }
.pool-score { flex: none; font-size: 11px; color: var(--muted-foreground); }
/* 池条目删除（2026-09-23 用户裁决：可从选择池移除素材） */
.pool-del {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; margin-left: auto;
  background: transparent; border: 1px solid var(--border); border-radius: var(--radius-md);
  color: var(--muted-foreground); cursor: pointer;
  transition: all var(--duration-fast);
}
.pool-del:hover { background: var(--destructive, #e5484d); border-color: var(--destructive, #e5484d); color: #fff; }
.pool-empty { line-height: 1.6; }
/* 执行卡选择池常显条（弹窗确认后在本卡展示池内容） */
.pool-strip { display: flex; flex-direction: column; gap: 6px; }
.pool-strip--empty { padding: 8px 12px; background: var(--surface-container); border-radius: var(--radius-md); }
.pool-chips { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.pool-chip {
  flex: none; display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px;
  background: var(--surface-container); border: 1px solid var(--border); border-radius: 999px;
  cursor: pointer; transition: border-color var(--duration-fast);
}
.pool-chip:hover { border-color: var(--primary); }
.pool-chip .pool-shot { border-color: var(--border); }
.srcdlg-confirm { font-size: 13px; color: var(--foreground); }
/* 匹配目标选择弹窗（2026-09-23 用户裁决：匹配前先勾选分镜脚本） */
.match-pick-list { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; }
.match-pick-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: var(--radius-md); cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.match-pick-row:hover { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 6%, transparent); }
.match-pick-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.match-pick-line { display: flex; align-items: center; gap: 10px; min-width: 0; }
.match-pick-name {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 13px; font-weight: 600; color: var(--foreground);
}
/* 第二行基本信息（产品快照/选题/脚本 id；产品缺失时 muted 提示占位） */
.match-pick-meta {
  font-size: 12px; color: var(--foreground-muted, var(--muted-foreground));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 选择素材 + 智能匹配同行平分（2026-09-23 用户裁决：原 src-pick-full 全行样式废除） */
.duel-row { align-items: stretch; }
.duel-half { flex: 1 1 0; min-width: 0; height: 40px; font-size: 14px; }
/* 选择素材弹窗样式（此前本面板无任何弹窗样式——缺 fixed 遮罩致弹窗渲染在页尾不可见） */
.modal-mask { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.55); }
.modal { display: flex; flex-direction: column; gap: 12px; width: 440px; max-width: 90vw; max-height: 80vh; padding: 20px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.modal-title { font-size: 15px; font-weight: 600; color: var(--foreground); }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* 素材库 tab（2026-09-22 用户裁决 A1：参考会话素材选择对话框，嵌入面板精简版） */
.lib-input-sm { width: 110px; flex: none; }
.lib-grid-wrap { max-height: 320px; overflow-y: auto; }
.lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
.lib-card {
  position: relative; display: flex; flex-direction: column; gap: 3px;
  padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--surface-container); text-align: left; cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.lib-card:hover { border-color: var(--primary); }
.lib-card.checked { border-color: var(--primary); background: var(--surface-container-high); }
.lib-check {
  position: absolute; top: 5px; right: 5px; width: 18px; height: 18px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.92); color: transparent; font-size: 11px; font-weight: 700;
}
.lib-check.on { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.lib-thumb { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: var(--radius-sm); background: var(--surface-container-high); }
.lib-thumb--ph { display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--muted-foreground); }
.lib-name { font-size: 12px; color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-sub { font-size: 11px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-state { padding: var(--space-5) var(--space-3); text-align: center; }

/* 素材列表（缩略图 + 路径 + 时长 + 播放/删除按钮） */
.file-list { display: flex; flex-direction: column; list-style: none; margin: 0; padding: 0; font-size: 13px; }
.file-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 10px; border-bottom: 1px solid var(--border); word-break: break-all; }
.file-list li:last-child { border-bottom: none; }
.src-video-list { max-height: 480px; overflow-y: auto; }
.src-video-list li { padding: 4px 8px; }
.video-thumb { width: 60px; height: 40px; object-fit: cover; border-radius: var(--radius-sm); background: #000; flex: none; }
.video-thumb--ph { display: inline-flex; align-items: center; justify-content: center; color: var(--muted-foreground); background: var(--surface-container-high); }
.video-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.video-dur { flex: none; width: 52px; text-align: right; font-size: 12px; color: var(--muted-foreground); margin-right: 8px; font-variant-numeric: tabular-nums; }
.video-play-btn { width: 24px; height: 24px; padding: 0; font-size: 12px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; margin-right: 4px; }
.video-play-btn:hover { color: var(--success); border-color: var(--success); }
.video-remove-btn { width: 24px; height: 24px; padding: 0; font-size: 16px; line-height: 1; flex: none; background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.video-remove-btn:hover { color: var(--danger); border-color: var(--danger); }
.video-count-footer { text-align: center; color: var(--muted-foreground); font-size: 12px; padding: 4px 0; }
/* 逐素材分割状态行底色（2026-09-22 用户裁决：done=淡绿、splitting=淡黄、failed=淡红、未分割无底色） */
.split-status-row.split-done { background: rgba(46, 204, 113, 0.14); }
.split-status-row.split-splitting { background: rgba(241, 196, 15, 0.14); }
.split-status-row.split-failed { background: rgba(231, 76, 60, 0.12); }
.desc-input { height: 28px; width: 100%; padding: 0 8px; font-size: 12px; }
/* 评分着色（分割镜头表；≥8 绿 / ≥6 黄 / 其余红，原版 L1443-1448 口径） */
.score-high { color: #2ecc71; font-weight: 600; }
.score-mid { color: #f1c40f; font-weight: 600; }
.score-low { color: #e74c3c; font-weight: 600; }
/* 分镜脚本卡样式在公共组件 CopyStoryboard.vue（material 态自注入） */
</style>