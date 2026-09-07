// ═══════════════════════════════════════════════════════════════
// useViralClone — 仿爆款（Viral Clone）编排层（runner 层）
// 业务对齐原客户端（双源一比一方法论）：
//   · studio/utils/viral_clone_client.py run_clone L191-232
//     （优先 flow 一条调用 → 失败回退 analyze+plan；need_login/captcha 透传）
//   · studio/gui/viral_clone_dialog.py（页面交互 + 右侧工作流编辑 _EditWorker L98-172）
// 纯函数在 viralCloneLogic.ts（normalize/source 归一化、buildFlowBody、
//   formatCloneResult、buildFormEntries、collectEditPayload、workflow 归一化），
//   本文件仅编排（IRON-06）。组件零 URL 拼装（IRON-07）。
//
// 2026-09-06 用户裁决：下载 / 素材浏览器链路不移植，输入统一为「本地视频上传」。
//   本地文件 → window.tintin.server 通用 upload 到服务端 output/upload 区
//   → 拿 video_path 回填 → 走 flow/analyze。客户端不传 url，不做服务端下载。
//
// 上传端点：/viral/clone/upload（契约正文无此端点，见 docs/仿爆款移植需求文档_2026-09-06.md
//   待裁决清单#2 —— 服务端需提供「multipart 上传本地视频到 output/upload 区并返还
//   video_path」；当前契约 /viral/clone/analyze 的 video_path 指向 server/output 区）。
//   服务端就绪前，上传调用会返回 404，本层将错误透出给用户。
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onUnmounted } from 'vue'
import {
  normalizeSource,
  buildFlowBody,
  buildAnalyzeBody,
  buildPlanBody,
  i18nFlowError,
  formatCloneResult,
  normalizeServerWorkflow,
  filterVideoWorkflows,
  workflowDisplayName,
  workflowDescText,
  buildFormEntries,
  collectEditPayload,
  productDisplayName,
  productPromptText,
  toEditorText,
  type ServerWorkflow,
  type FormEntry,
} from './viralCloneLogic'
import { fetchProducts } from './useWorkbenchPickers'
import { clientError } from '../utils/clientLog'

function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) {}
}

/** IpcError 三态分流：null=离线 / {error}=业务与 HTTP 错误 / 正常数据 */
function unwrapIpc<T>(res: T | null | { error: string }, label: string): T {
  if (res === null || res === undefined) {
    throw new Error(`${label}：服务端不可达（OFFLINE），请检查服务端地址与网络`)
  }
  if (typeof res === 'object' && 'error' in (res as Record<string, unknown>)) {
    throw new Error(`${label}：${String((res as Record<string, unknown>).error)}`)
  }
  return res as T
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const EDIT_POLL_INTERVAL_MS = 3000 // 对照 _EditWorker.time.sleep(3) L170
const EDIT_POLL_TIMEOUT_MS = 30 * 60 * 1000 // max_wait=1800s（30 分钟）L138

export function useViralClone() {
  // ── 来源/上传 ──
  const sourceVideoPath = ref('')   // 本地视频路径（未上传）
  const uploadedVideoPath = ref('') // 上传成功后的服务端 video_path
  const uploaded = ref(false)
  const uploadPercent = ref(0)
  const uploading = ref(false)

  // ── 产品 ──
  const productItems = ref<Array<Record<string, unknown>>>([])
  const selectedProduct = ref<Record<string, unknown> | null>(null)
  const customProduct = ref('')
  const productStatus = ref('就绪')
  const productsLoading = ref(false)

  // ── 拆解 + 复刻 ──
  const running = ref(false)
  const statusText = ref('就绪')
  const structure = ref<unknown>(null)
  const script = ref<unknown>(null)
  const outputText = ref('')
  const errorMessage = ref('')

  // ── 视频编辑工作流（右侧）──
  const workflows = ref<ServerWorkflow[]>([])
  const selectedWfId = ref('')
  const wfLoading = ref(false)
  const wfDesc = ref('')
  const formEntries = ref<FormEntry[]>([])
  const formState = ref<Record<string, unknown>>({})
  const editSubmitting = ref(false)
  const editPolling = ref(false)
  const editProgress = ref(0)
  const editStatus = ref('等待提交…')
  const editOutput = ref('')
  const editError = ref('')

  let editPollTimer: ReturnType<typeof setInterval> | null = null

  // ── 计算 ──
  const hasSource = computed(() => !!sourceVideoPath.value || !!uploadedVideoPath.value)
  const productInfo = computed(() => {
    if (selectedProduct.value) return productPromptText(selectedProduct.value)
    return customProduct.value.trim()
  })
  const canRun = computed(() => !!sourceVideoPath.value && !!productInfo.value && !running.value && !uploading.value)
  const editCanSubmit = computed(() => !!selectedWfId.value && !editSubmitting.value && !editPolling.value)

  const wfOptions = computed(() =>
    workflows.value.map((w) => ({ label: workflowDisplayName(w), value: w.id })),
  )

  const selectedWorkflow = computed(
    () => workflows.value.find((w) => w.id === selectedWfId.value) || null,
  )

  // ── 来源选择/上传 ──
  function setSourceVideo(path: string): void {
    sourceVideoPath.value = path
    uploadedVideoPath.value = ''
    uploaded.value = false
    errorMessage.value = ''
  }

  function clearSource(): void {
    sourceVideoPath.value = ''
    uploadedVideoPath.value = ''
    uploaded.value = false
    uploadPercent.value = 0
    errorMessage.value = ''
  }

  /** 上传本地视频到服务端 output/upload 区 → 拿 video_path 回填 */
  async function uploadSource(): Promise<boolean> {
    if (!sourceVideoPath.value) {
      errorMessage.value = '请先选择/拖入本地视频'
      return false
    }
    uploading.value = true
    uploadPercent.value = 0
    errorMessage.value = ''
    try {
      const res = await window.tintin.server.viralCloneUpload(
        sourceVideoPath.value,
        (p: number) => { uploadPercent.value = Math.round(p) },
      )
      if (!res) throw new Error('上传失败：服务端不可达（OFFLINE）')
      if (typeof res === 'object' && 'error' in (res as Record<string, unknown>)) {
        throw new Error(`上传失败：${String((res as Record<string, unknown>).error)}`)
      }
      const vp = String((res as Record<string, unknown>)?.video_path || '')
      if (!vp) throw new Error('上传失败：服务端未返回 video_path（上传端点待服务端确认）')
      uploadedVideoPath.value = vp
      uploaded.value = true
      statusText.value = `已上传：${vp}`
      notify('仿爆款', '爆款视频上传完成')
      syncFormVideoPath(vp)
      return true
    } catch (e) {
      const msg = errText(e)
      errorMessage.value = msg
      statusText.value = `上传失败：${msg}`
      clientError('viral-clone', '仿爆款上传失败', e)
      notify('仿爆款上传失败', msg)
      return false
    } finally {
      uploading.value = false
    }
  }

  // ── 产品库加载 ──
  async function loadProducts(): Promise<void> {
    productsLoading.value = true
    try {
      const list = await fetchProducts('')
      productItems.value = (Array.isArray(list) ? list : []).filter((it) =>
        productDisplayName(it),
      )
      productStatus.value = productItems.value.length
        ? `就绪（产品库已加载 ${productItems.value.length} 条）`
        : '就绪（产品库为空，可使用自定义产品描述）'
    } catch (e) {
      productStatus.value = `就绪（产品库加载失败：${errText(e)}）`
    } finally {
      productsLoading.value = false
    }
  }

  // ── 拆解 + 复刻 ──
  async function runClone(): Promise<void> {
    if (!sourceVideoPath.value) {
      errorMessage.value = '请先选择/拖入爆款视频'
      return
    }
    if (!productInfo.value) {
      errorMessage.value = '请选择本店产品或填写自定义产品描述'
      return
    }
    running.value = true
    errorMessage.value = ''
    outputText.value = ''
    structure.value = null
    script.value = null
    statusText.value = uploaded.value ? '正在拆解 + 复刻…' : '正在上传并拆解 + 复刻…'

    try {
      // 0. 本地文件未上传 → 先上传拿 video_path
      let videoPath = uploadedVideoPath.value
      if (!videoPath && sourceVideoPath.value) {
        const ok = await uploadSource()
        if (!ok) throw new Error(errorMessage.value || '上传失败，无法继续')
        videoPath = uploadedVideoPath.value
      }

      // 1. 来源归一化（本地文件已上传 → videoPath 优先；否则退回 materialId 次选）
      const norm = normalizeSource(videoPath || sourceVideoPath.value)
      if (!norm.ok) throw new Error(norm.note)
      statusText.value = `爆款来源：${norm.note}`

      // 2. 优先 flow 一条调用
      const flowBody = buildFlowBody(norm.videoPath, norm.materialId, productInfo.value)
      const flowRes = await window.tintin.server.viralCloneFlow(flowBody)
      const fd = unwrapIpc(flowRes, '仿爆款流程')
      const flowOk = Boolean((fd as Record<string, unknown>)?.ok)

      if (flowOk) {
        structure.value = (fd as Record<string, unknown>)?.structure ?? null
        script.value = (fd as Record<string, unknown>)?.script ?? null
        statusText.value = '拆解 + 复刻脚本完成（生成/组装待服务端 E-3.0 开放）'
        outputText.value = formatCloneResult(structure.value, script.value)
        notify('仿爆款', '拆解 + 复刻脚本完成')
        return
      }

      // 3. need_login / captcha → 透传（抖音风控）
      if ((fd as Record<string, unknown>)?.need_login || (fd as Record<string, unknown>)?.captcha) {
        throw new Error(
          i18nFlowError({
            needLogin: Boolean((fd as Record<string, unknown>)?.need_login),
            captcha: Boolean((fd as Record<string, unknown>)?.captcha),
            error: String((fd as Record<string, unknown>)?.error || ''),
          }),
        )
      }

      // 4. flow 失败（如旧服务端未实现）→ 回退 analyze + plan
      statusText.value = `flow 不可用（${String((fd as Record<string, unknown>)?.error || '未知')}），回退分步调用`
      const anaBody = buildAnalyzeBody(norm.videoPath, norm.materialId)
      const anaRes = await window.tintin.server.viralCloneAnalyze(anaBody)
      const structureData = unwrapIpc(anaRes, '爆款拆解')
      if (!structureData) throw new Error('爆款拆解失败（analyze 未返回结构），请检查视频来源或服务端日志')
      structure.value = structureData
      const meta = (structureData as Record<string, unknown>)?.meta as Record<string, unknown> | undefined
      statusText.value = `拆解完成：时长 ${meta?.duration ?? '?'}s，镜头 ${meta?.shot_count ?? '?'} 个`

      const planBody = buildPlanBody(structureData, productInfo.value)
      const planRes = await window.tintin.server.viralClonePlan(planBody)
      const scriptData = unwrapIpc(planRes, '复刻规划')
      if (!scriptData) throw new Error('复刻规划失败（plan 未返回脚本）')
      script.value = scriptData
      statusText.value = '拆解 + 复刻脚本完成（生成/组装待服务端 E-3.0 开放）'
      outputText.value = formatCloneResult(structure.value, script.value)
      notify('仿爆款', '拆解 + 复刻脚本完成')
    } catch (e) {
      const msg = errText(e)
      errorMessage.value = msg
      statusText.value = msg
    } finally {
      running.value = false
    }
  }

  // ── 占位按钮（generate / montage / review：服务端 E-3.0 未就绪）──
  function onGenerate(): void {
    if (!script.value) {
      statusText.value = '请先执行「拆解并复刻」拿到复刻脚本'
      return
    }
    const reason = '服务端 E-3.0 节点工作流引擎未就绪：三替换素材生成尚未开放'
    statusText.value = reason
    outputText.value = `${outputText.value}\n\n生成素材（占位）：${reason}`
  }
  function onMontage(): void {
    if (!script.value) {
      statusText.value = '请先执行「拆解并复刻」'
      return
    }
    const reason = '服务端 E-3.0 节点工作流引擎未就绪：复刻素材组装尚未开放'
    statusText.value = reason
    outputText.value = `${outputText.value}\n\n组装成片（占位）：${reason}`
  }
  function onReview(): void {
    if (!script.value) {
      statusText.value = '请先执行「拆解并复刻」'
      return
    }
    const reason = '服务端 E-3.0 节点工作流引擎未就绪：对比评审尚未开放'
    statusText.value = reason
    outputText.value = `${outputText.value}\n\n对比评审（占位）：${reason}`
  }

  /** 复制复刻脚本 JSON 到剪贴板（原版 QApplication.clipboard().setText） */
  async function copyScript(): Promise<void> {
    if (!script.value) {
      statusText.value = '暂无可复制的复刻脚本'
      return
    }
    try {
      await navigator.clipboard.writeText(toEditorText(script.value))
      statusText.value = '复刻脚本已复制到剪贴板'
    } catch (e) {
      statusText.value = `复制失败：${errText(e)}`
    }
  }

  // ── 视频编辑工作流（右侧）──
  async function loadWorkflows(): Promise<void> {
    wfLoading.value = true
    editStatus.value = '正在从服务端加载工作流…'
    clearEditForm()
    selectedWfId.value = ''
    editError.value = ''
    try {
      const res = await window.tintin.server.listServerWorkflows('client')
      const payload = unwrapIpc(res, '加载工作流')
      const raw = (payload as Record<string, unknown>)?.workflows || []
      const list = (Array.isArray(raw) ? raw : []).map(normalizeServerWorkflow).filter(Boolean)
      workflows.value = filterVideoWorkflows(list)
      if (!workflows.value.length) {
        editStatus.value = '未加载到工作流：请确认 compute_server_url 配置且服务端已启动并存在 output_type=video 的工作流'
        return
      }
      selectedWfId.value = workflows.value[0].id
      editStatus.value = `已加载 ${workflows.value.length} 个视频编辑工作流，请选择并填写参数后提交`
    } catch (e) {
      editError.value = errText(e)
      editStatus.value = `加载工作流失败：${errText(e)}`
    } finally {
      wfLoading.value = false
    }
  }

  /** 工作流选择变化 → 更新描述 + 重建动态表单 */
  function onWfChanged(): void {
    const wf = selectedWorkflow.value
    if (!wf) {
      wfDesc.value = '（请先选择一个工作流）'
      clearEditForm()
      return
    }
    wfDesc.value = workflowDescText(wf)
    formEntries.value = buildFormEntries(wf, uploadedVideoPath.value || sourceVideoPath.value)
    syncFormDefaults()
  }

  function clearEditForm(): void {
    formEntries.value = []
    formState.value = {}
  }

  /** 重建 formState 默认值（对照原版 _build_edit_form 每次重建 widget 时回填 default） */
  function syncFormDefaults(): void {
    const st: Record<string, unknown> = {}
    for (const e of formEntries.value) {
      if (e.default !== undefined && e.default !== null && e.default !== '') st[e.key] = e.default
    }
    formState.value = st
  }

  /** 上传成功后同步编辑工作流 video 字段（原版拖入本地视频 → 同步到右侧 video 字段） */
  function syncFormVideoPath(path: string): void {
    if (!formEntries.value.length) return
    const next: Record<string, unknown> = { ...formState.value }
    let changed = false
    for (const e of formEntries.value) {
      if (e.kind === 'video' && e.key) { next[e.key] = path; changed = true }
    }
    if (changed) formState.value = next
  }

  /** 单个文件类字段 → 本地路径选择（dialog.openFile 多态扩展名） */
  async function pickEditFile(entry: FormEntry): Promise<void> {
    const extMap: Record<string, string[]> = {
      image: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'],
      audio: ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg'],
      video: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv'],
    }
    const res = await window.tintin.dialog.openFile({
      title: `选择${entry.kind}文件`,
      filters: [{ name: entry.kind, extensions: extMap[entry.kind] || [] }],
    })
    if (res) formState.value = { ...formState.value, [entry.key]: res }
  }

  /** 提交视频编辑工作流任务（对照 _EditWorker：提交 → 轮询 → 结果） */
  async function submitEdit(): Promise<void> {
    const wf = selectedWorkflow.value
    if (!wf) {
      editError.value = '请先在右侧选择一个视频编辑工作流'
      return
    }
    const { files, values, error } = collectEditPayload(formEntries.value, formState.value)
    if (error) {
      editError.value = error
      return
    }
    if (!Object.keys(files).length && !Object.keys(values).length) {
      editError.value = '请至少填写一个编辑参数（视频文件/素材 ID）'
      return
    }

    editSubmitting.value = true
    editError.value = ''
    editProgress.value = 0
    editStatus.value = `正在提交编辑工作流：${wf.name}`
    editOutput.value = `═══ ${wf.name} (id=${wf.id}) ===\n提交文件字段：${Object.keys(files)}\n提交值字段：${Object.keys(values).sort()}`

    try {
      const fields: Record<string, string | Blob> = {}
      for (const [k, v] of Object.entries(files)) {
        fields[k] = { path: v } as unknown as Blob
      }
      const itype = wf.instanceType || 'default'
      const payload = { ...values, instance_type: itype }
      const res = await window.tintin.server.runServerWorkflow(
        wf.id,
        { ...fields, ...{ __values: JSON.stringify(payload) } },
        (p) => { editProgress.value = Math.round(p) },
      )
      if (!res) throw new Error('服务端不可达（OFFLINE）')
      const taskId = String((res as Record<string, unknown>)?.task_id || '')
      if (!taskId) throw new Error('提交失败：未返回 task_id')
      editSubmitting.value = false
      editStatus.value = '编辑中，请稍候…'
      startEditPolling(wf.id, taskId)
    } catch (e) {
      editSubmitting.value = false
      editError.value = errText(e)
      editStatus.value = `编辑失败：${errText(e)}`
    }
  }

  /** 轮询任务状态（对照 _EditWorker L136-170：成功/失败/平滑进度/30 分钟超时） */
  function startEditPolling(workflowId: string, taskId: string): void {
    stopEditPolling()
    editPolling.value = true
    const startAt = Date.now()
    let lastPct = 30
    const tick = async (): Promise<void> => {
      try {
        const resp = await window.tintin.server.serverWorkflowStatus(taskId)
        if (!resp) return
        const data = (resp as Record<string, any>)?.data || (resp as Record<string, any>) || {}
        const st = String(data.status || (resp as Record<string, any>)?.status || '')
        if (['SUCCESS', 'success', 'done', 'DONE', 'completed'].includes(st)) {
          editProgress.value = 100
          editStatus.value = `编辑任务完成：${taskId}`
          const results = data.results || (resp as Record<string, any>)?.results || []
          editOutput.value = `${editOutput.value}\n\n══ 编辑结果 ══\n${toEditorText({ ok: true, task_id: taskId, results })}`
          stopEditPolling()
          notify('仿爆款编辑', `任务 ${taskId} 完成`)
          return
        }
        if (['FAILED', 'failed', 'error', 'ERROR'].includes(st)) {
          const msg = String(data.error || (resp as Record<string, any>)?.error || '任务失败')
          editOutput.value = `${editOutput.value}\n\n[错误] ${msg}`
          editStatus.value = `编辑失败：${msg}`
          stopEditPolling()
          return
        }
        // 平滑推进进度
        const pct = data.progress !== undefined ? Number(data.progress) : NaN
        if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
          editProgress.value = Math.max(lastPct, Math.min(100, Math.floor(pct)))
        } else {
          const elapsed = Date.now() - startAt
          editProgress.value = Math.max(lastPct, Math.min(90, 30 + Math.floor((elapsed / EDIT_POLL_TIMEOUT_MS) * 60)))
        }
        lastPct = editProgress.value
        editStatus.value = '编辑中，请稍候…'
      } catch (_) {
        // 单次查询异常不终止轮询
      }
    }
    void tick()
    editPollTimer = setInterval(() => { void tick() }, EDIT_POLL_INTERVAL_MS)
  }

  function stopEditPolling(): void {
    if (editPollTimer) { clearInterval(editPollTimer); editPollTimer = null }
    editPolling.value = false
  }

  onUnmounted(() => {
    stopEditPolling()
  })

  return {
    // 来源/上传
    sourceVideoPath, uploadedVideoPath, uploaded, uploadPercent, uploading,
    hasSource,
    // 产品
    productItems, selectedProduct, customProduct, productStatus, productsLoading,
    // 拆解+复刻
    running, statusText, structure, script, outputText, errorMessage, productInfo,
    canRun,
    // 编辑工作流
    workflows, wfOptions, selectedWfId, selectedWorkflow, wfLoading, wfDesc,
    formEntries, formState, editSubmitting, editPolling, editProgress,
    editStatus, editOutput, editError, editCanSubmit,
    // methods
    setSourceVideo, clearSource, uploadSource,
    loadProducts,
    runClone, onGenerate, onMontage, onReview, copyScript,
    loadWorkflows, onWfChanged, pickEditFile, submitEdit, stopEditPolling,
  }
}
