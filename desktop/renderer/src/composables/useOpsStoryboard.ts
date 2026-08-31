// ═══════════════════════════════════════════════════════════════
// useOpsStoryboard — 分镜脚本创作域 composable（媒体工具 · P1 实装）
// 对照原客户端 gui/storyboard_page.py：
//   · 挂载消费 appStore.pendingStoryboard（文案创作卡带来的草案，
//     对齐原 set_copywriting：文案 + 产品上下文）
//   · 生成分镜：llmChat → parseStoryboardShots（失败回退单镜提示）
//   · 镜头编辑：竖向镜头卡（镜别/时长/画面/旁白/音效），增删镜头
//   · 引用素材：POST /material/search 语义搜索 → 选中绑定
//     material_path/hash/id（对齐 _bind_materials 单素材口径）；
//     即梦/联网生成素材先占位（落地文档 §七）
//   · 保存：POST /api/storyboard/scripts（ScriptIn 契约，
//     同 topic 覆盖更新；保存后工作台「选择脚本」刷新即可见）
// 分层（IRON-06）：URL 拼装仅在本层；组件零 URL/IPC 调用。
// ═══════════════════════════════════════════════════════════════

import { ref, onMounted, onUnmounted } from 'vue'
import { getTintin } from './useSettingsConfig'
import { useAppStore } from '@/stores/app'
import {
  buildScriptPayload,
  buildStoryboardPrompt,
  defaultStoryboardTopic,
  normalizeShot,
  parseStoryboardShots,
  ratioToOrient,
  totalDuration,
  type StoryboardShot,
} from './opsStoryboardLogic'

/** /llm/chat/completions 响应 → 文本（choices[0].message.content，防御解析） */
function pickLlmText(res: unknown): string {
  const r = res as { choices?: Array<{ message?: { content?: unknown } }> } | null
  return String(r?.choices?.[0]?.message?.content ?? '').trim()
}

export interface MaterialHit {
  id: string
  name: string
  path: string
  hash: string
  score: number
}

export function useOpsStoryboard() {
  const appStore = useAppStore()

  /* ── 文案 / 画幅 / 主题 ── */
  const copyText = ref('')
  const ratio = ref<string>('9:16')
  const topic = ref('')
  const product = ref<Record<string, string>>({})

  /* ── 镜头 ── */
  const shots = ref<StoryboardShot[]>([])

  /* ── 状态 ── */
  const generating = ref(false)
  const saving = ref(false)
  const status = ref('')

  /* ── 素材引用（单个镜头的搜索弹层） ── */
  const matSearching = ref(false)
  const matHits = ref<MaterialHit[]>([])
  /** 当前正在引用素材的镜头下标（-1 = 弹层关闭） */
  const matTargetIndex = ref(-1)

  /** 挂载：消费文案创作卡带来的草案（原 set_copywriting 语义） */
  onMounted(() => {
    const draft = appStore.takePendingStoryboard()
    if (draft?.copyText) {
      copyText.value = draft.copyText
      product.value = draft.product || {}
      status.value = '已载入来自「产品文案创作」的文案，可直接生成分镜。'
    }
    if (!topic.value) topic.value = defaultStoryboardTopic()
  })

  /* ── 生成分镜（对齐 _generate_storyboard + _fill_storyboard） ── */

  async function generate(): Promise<void> {
    if (generating.value) return
    if (!copyText.value.trim()) { status.value = '请先填写或生成视频文案。'; return }
    const t = getTintin()
    if (!t?.llmChat) { status.value = '服务端 LLM 不可用，请检查服务端连接。'; return }
    generating.value = true
    status.value = 'AI 正在拆解分镜…'
    try {
      const { systemPrompt, userPrompt } = buildStoryboardPrompt(copyText.value.trim(), ratio.value)
      const res = await t.llmChat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      })
      if (res && typeof res === 'object' && 'error' in (res as Record<string, unknown>)) {
        throw new Error(String((res as Record<string, unknown>).error || '生成失败'))
      }
      const text = pickLlmText(res)
      if (!text) throw new Error('模型未返回内容')
      const parsed = parseStoryboardShots(text)
      shots.value = parsed.shots
      const total = Math.round(totalDuration(parsed.shots.map((s) => s.duration)))
      status.value = parsed.fallback
        ? '分镜解析失败，已将原始结果放入第一格，可手动拆分编辑。'
        : `分镜已生成（${parsed.shots.length} 个镜头，约 ${total}s），可直接编辑各镜头字段，或点击「引用素材」关联素材。`
    } catch (e) {
      status.value = `生成失败：${(e as Error)?.message || e}`
    } finally {
      generating.value = false
    }
  }

  /* ── 镜头编辑 ── */

  function addShot(): void {
    shots.value.push(normalizeShot({}, shots.value.length + 1))
  }

  function removeShot(index: number): void {
    shots.value = shots.value
      .filter((_, i) => i !== index)
      .map((s, i) => ({ ...s, index: i + 1 }))
  }

  /** 重置（清空镜头，保留文案） */
  function clearShots(): void {
    shots.value = []
    status.value = ''
  }

  /* ── 引用素材（对齐 _bind_materials：单素材绑定 + 相似度展示） ── */

  function openMaterialPicker(index: number): void {
    matTargetIndex.value = index
    matHits.value = []
  }

  function closeMaterialPicker(): void {
    matTargetIndex.value = -1
    matHits.value = []
  }

  /** 语义搜索素材（query = 画面描述 + 产品上下文，对齐原检索词口径） */
  async function searchMaterials(): Promise<void> {
    if (matTargetIndex.value < 0) return
    const t = getTintin()
    if (!t?.server) { status.value = '预览环境：无 IPC'; return }
    const shot = shots.value[matTargetIndex.value]
    const kw = [shot?.visual?.trim(), product.value.brand, product.value.model]
      .filter(Boolean).join(' ').trim()
    if (!kw) { status.value = '画面描述为空，无法检索素材。'; return }
    matSearching.value = true
    try {
      const res = await t.server.post('/material/search', { query: kw, limit: 20 })
      if (res === null || res === undefined) throw new Error('无法连接服务端。')
      if (typeof res === 'object' && 'error' in (res as Record<string, unknown>)) {
        throw new Error(String((res as Record<string, unknown>).error || '检索失败'))
      }
      const list = Array.isArray(res)
        ? res
        : ((res as Record<string, unknown>).results ?? (res as Record<string, unknown>).items ?? [])
      matHits.value = (list as Record<string, unknown>[]).map((m) => ({
        id: String(m.id ?? m.mid ?? ''),
        name: String(m.name ?? m.title ?? ''),
        path: String(m.path ?? ''),
        hash: String(m.hash ?? ''),
        score: Number(m.score ?? 0) || 0,
      }))
    } catch (e) {
      status.value = `素材检索失败：${(e as Error)?.message || e}`
    } finally {
      matSearching.value = false
    }
  }

  /** 选中素材绑定到镜头（对齐 _bind_materials 单素材） */
  function bindMaterial(hit: MaterialHit): void {
    const i = matTargetIndex.value
    if (i < 0 || !shots.value[i]) return
    shots.value[i] = {
      ...shots.value[i],
      material_path: hit.path,
      material_type: 'local',
      material_hash: hit.hash,
      material_id: Number.isFinite(Number(hit.id)) ? Math.trunc(Number(hit.id)) : 0,
      material_name: hit.name,
    }
    status.value = `镜头 ${shots.value[i].index} 已绑定素材：${hit.name || hit.path}`
    closeMaterialPicker()
  }

  /** 解绑镜头素材 */
  function unbindMaterial(index: number): void {
    if (!shots.value[index]) return
    shots.value[index] = {
      ...shots.value[index],
      material_path: '', material_type: '', material_hash: '', material_id: 0, material_name: undefined,
    }
  }

  /* ── 保存（POST /api/storyboard/scripts，同 topic 覆盖更新） ── */

  async function save(): Promise<void> {
    if (saving.value) return
    if (!shots.value.length) { status.value = '当前没有分镜内容，请先生成分镜脚本。'; return }
    const t = getTintin()
    if (!t?.server) { status.value = '预览环境：无 IPC'; return }
    saving.value = true
    status.value = '正在同步到服务端…'
    try {
      const payload = buildScriptPayload({
        topic: topic.value.trim() || defaultStoryboardTopic(),
        ratio: ratio.value,
        shots: shots.value,
        product: product.value,
      })
      const res = await t.server.post('/api/storyboard/scripts', payload)
      if (res === null || res === undefined) throw new Error('无法连接服务端。')
      if (typeof res === 'object' && 'error' in (res as Record<string, unknown>)) {
        throw new Error(String((res as Record<string, unknown>).error || '保存失败'))
      }
      const total = Math.round(Number(payload.total_duration) || 0)
      status.value = `已保存（${ratioToOrient(ratio.value)} · ${payload.shot_count} 镜 · ${total}s · 选题：${payload.topic}），工作台「选择脚本」刷新后可选。`
    } catch (e) {
      status.value = `保存失败：${(e as Error)?.message || e}`
    } finally {
      saving.value = false
    }
  }

  onUnmounted(() => { /* 无轮询定时器；弹层状态随组件销毁 */ })

  return {
    // 输入
    copyText, ratio, topic, product,
    // 镜头
    shots, addShot, removeShot, clearShots,
    // 动作
    generating, saving, status, generate, save,
    // 素材引用
    matSearching, matHits, matTargetIndex, openMaterialPicker, closeMaterialPicker,
    searchMaterials, bindMaterial, unbindMaterial,
  }
}

export type OpsStoryboard = ReturnType<typeof useOpsStoryboard>
