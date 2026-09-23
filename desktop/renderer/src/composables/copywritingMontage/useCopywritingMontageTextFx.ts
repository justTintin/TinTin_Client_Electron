// ══════════════════════════════════════════════════════════
// useCopywritingMontageTextFx.ts — 智能混剪 Step3·文字模板（textfx）子编排（铁律 10 E3b，2026-09-19）
// 自 useCopywritingMontageStep3Voice.ts 纯搬迁（IRON-02 五项 checklist；蓝图见
// docs/智能混剪拆分迁移映射_2026-09-18.md §五 Step3 E3b）。
// 消费方：本文件内部（useCopywritingMontageStep3Voice）与主文件 Step4 段（startFinalMix/
//   剪映导出经 step3 解构透传）。
// ─────────────────────────────────────────────────═
import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import {
  TEXT_KEYWORD_DENSITY_MAX, pickRandomItems,
  buildSubtitleRows, buildTextFxTracks, pathBasename,
  type TextFxTrack, type PrecomposePlan, type VoiceRow,
} from '../copywritingMontageLogic'
import {
  LLM_KEYWORDS_SYSTEM_PROMPT, matchKeywordHits, parseLlmKeywords,
} from '../copywritingMontageStep4FxBgmLogic'

export interface CopywritingMontageTextFxContext {
  voiceRows: Ref<VoiceRow[]>
  assemblePlans: Ref<PrecomposePlan[]>
  finalBusy: Ref<boolean>
  step4Candidates: Ref<string[]>
  collectCandidates: (useSource?: boolean) => Promise<string[]>
  /** 产品信息（2026-09-19 架构：关键词命中词源=产品资料关联关键词） */
  sharedProductInfo: Ref<{ brand: string; product: string; model: string; extra: string; keywords: string[] }>
}

export function useCopywritingMontageTextFx(ctx: CopywritingMontageTextFxContext) {
  const { voiceRows, assemblePlans, finalBusy, step4Candidates, collectCandidates, sharedProductInfo } = ctx

  // ── 文字模板（2026-09-09 用户裁决：服务端 textfx 体系，与花字独立概念）──
  // textTemplateId 首项 'random'（随机样式，默认）：每次合成从全部模板随机选 N 个（默认 3）；
  // 2026-09-10 在线契约纠偏：服务端统一合成 POST /montage/concat（multipart）已支持全套
  // text_template_* 字段（enabled/id/words/timing/match_enabled/match_ids），不存在也不需要
  // 独立「文字模板烧制」接口——所有素材统一合成（用户裁决口径）；待把字段接入确认合成请求。
  // 2026-09-13 用户裁决：文字模板默认勾选（模板池/命中均由服务端承担，默认开不增本地负担）
  const textFxEnabled = ref(true)
  // 2026-09-14 服务端 /montage/concat 新增 lut_restore（bool，默认 false）：
  // 勾选=恢复旧行为（无显式 LUT 文件时自动抽帧匹配 LUT 库）；默认不勾=不还原 LUT
  const lutRestore = ref(false)
  // 2026-09-14 用户裁决：勾选还原后可选库内具体 LUT（GET /config/luts 清单单选）
  const lutId = ref('')
  const lutList = ref<Array<Record<string, unknown> & { id: string; name: string; kind?: string; description?: string }>>([])
  const lutListLoading = ref(false)
  async function loadLuts(): Promise<void> {
    if (lutListLoading.value) return
    lutListLoading.value = true
    try {
      const res = await window.tintin?.server?.lutList?.()
      lutList.value = res && 'luts' in res && Array.isArray(res.luts)
        ? res.luts.map((x) => ({ ...(x as Record<string, unknown>), id: String(x.id ?? ''), name: String(x.name ?? x.filename ?? x.id ?? '') }))
        : []
    } catch (_) { lutList.value = [] } finally { lutListLoading.value = false }
  }
  watch(lutRestore, (on) => {
    if (on) { void loadLuts() } else { lutId.value = '' } // 取消勾选清空选择
  })
  const textTemplateId = ref('random')
  const textRandomCount = ref(3)
  // 关键词密度档位（2026-09-10 用户裁决：低/中/高；调节后重新提取关键词并重新掷模板）
  const textKeywordDensity = ref('mid')
  const textTemplates = ref<Array<Record<string, unknown> & { template_id: string; name: string }>>([])
  const textTemplatesLoading = ref(false)
  /** 生效模板池（2026-09-10 用户二次裁决：随机数量 N 对应每条视频各自随机选——
   *  池恒为全量库，逐视频在烧制/预览端确定性洗牌取子集；指定模板则池=单模板）。
   *  2026-09-15 用户裁决：随机只从剪映同步模板（jy_ 前缀）中选，内置模板不参与；
   *  无 jy_ 模板时回退全量池（避免随机失效） */
  const activeTextPool = computed(() => {
    if (textTemplateId.value !== 'random') {
      const one = textTemplates.value.find((t) => t.template_id === textTemplateId.value)
      return one ? [one] : []
    }
    const jy = textTemplates.value.filter((t) => String(t.template_id || '').startsWith('jy_'))
    return jy.length ? jy : textTemplates.value
  })
  /** 随机模式生效个数（指定模板=1；每视频从 activeTextPool 独立随机选 N 个） */
  const activeTextCount = computed(() => textTemplateId.value === 'random' ? textRandomCount.value : 1)
  /** 文字模板下拉：首项随机样式（默认）；按 catalog 类目前缀分组平铺（「花字库｜」「文字模板｜」）；
   *  jy_ 前缀=剪映同步。TSelect 无嵌套分组，用前缀承载层级 */
  const CATALOG_LANE_TPL = '/text_templates/templates'
  const catalogTextLanes = ref<Array<{ lane: string; endpoint: string }>>([])
  function catalogLaneIdOf(t: { template_id?: string; description?: string }): string {
    const id = String(t.template_id || '')
    if (!id.startsWith('jy_')) return '内置'
    const m = /原始类目:([^|]+)/.exec(String(t.description || ''))
    return m && /文字模板/.test(m[1]) ? '文字模板' : '花字库'
  }
  const textTemplateOptions = computed(() => {
    const base = [{ label: '随机样式', value: 'random' }]
    if (!catalogTextLanes.value.length) {
      return [...base, ...textTemplates.value.map((t) => ({
        label: String(t.name || t.template_id) + (String(t.template_id).startsWith('jy_') ? '（剪映）' : ''),
        value: t.template_id,
      }))]
    }
    const lanes = [...catalogTextLanes.value.map((l) => l.lane), '内置']
    const out: Array<{ label: string; value: string }> = [...base]
    for (const lane of lanes) {
      for (const t of textTemplates.value) {
        if (catalogLaneIdOf(t) !== lane) continue
        out.push({ label: `${lane}｜${String(t.name || t.template_id)}`, value: String(t.template_id) })
      }
    }
    // 兜底：分类遗漏的模板（不该发生，防丢）
    const inLanes = new Set(out.map((o) => o.value))
    for (const t of textTemplates.value) {
      if (!inLanes.has(String(t.template_id))) out.push({ label: String(t.name || t.template_id), value: String(t.template_id) })
    }
    return out
  })
  async function loadCatalogLanes(): Promise<void> {
    try {
      const res = await window.tintin?.server?.jyTemplatesList?.()
      if (res && 'ok' in res && res.ok) {
        const textGroup = (res.groups || []).find((g) => g.group === '文本')
        catalogTextLanes.value = (textGroup?.lanes || [])
          .filter((l) => l.endpoint === CATALOG_LANE_TPL)
          .map((l) => ({ lane: l.lane, endpoint: l.endpoint }))
      }
    } catch (_) { /* catalog 不可用 → 兜底平铺 */ }
  }
  // extractTextFxWords（本地词典卖点提取）已删除（2026-09-19 架构：/text_templates/match
  // 下线，词源=产品资料关联关键词，产品未关联词 → LLM 兜底提词；本地词典退出导出链。
  // extractFancyWordsInLine/FromText 纯函数保留于 copywritingMontageStep4FxBgmLogic.ts，仅供测试
  // 与未来潜在消费）
  /** 效果预览：按视频分行时间轴（2026-09-10 用户裁决终态：轨数=上一步确认成片条数
   *  （assemblePlans confirmed 产物，不走 collectCandidates 配音优先口径——
   *  3 条成片只配 1 条音时也必须显示 3 条轨）；轨名列=视频名（用户明确要求显示视频名）；
   *  背景条=视频时长（probeDuration 实测），文案按 voiceRows 行（path 匹配成片）命中
   *  timing.json 真实时间点；无命中行仍保留空轨。异步组装（seq 过期响应丢弃）。
   *  2026-09-11 用户二次裁决：展示层轨名改「第N条」序号（完整视频名留 title 悬停），
   *  数据字段 name 仍为文件名，序号由渲染层按行序生成。
   *  2026-09-11 用户三次裁决：命中数据一律取自服务端 /text_templates/match（合成前自查，
   *  与 /montage/concat 命中模式共用选择逻辑 → 预览所见即合成所做；llm_fill=true 按
   *  合成口径补足；density 档位透传，不传 duration——与合成端同口径由服务端取字幕
   *  末行 t1）；客户端不再本地提取关键词，服务端离线/失败时呈空轨（不造数）。 */
  const textFxPreviewTracks = ref<TextFxTrack[]>([])
  /** 交互标注数据（2026-09-23 用户裁决，与智能混剪同款）：每视频一块 */
  interface TextFxAnnotateTrack {
    key: string
    name: string
    durationSec: number
    rows: Array<{ text: string; start: number; end: number }>
    hits: KeywordHit[]
    words: string[]
  }
  const textFxAnnotate = ref<TextFxAnnotateTrack[]>([])
  let textFxTrackSeq = 0
  // ── 关键词命中（2026-09-19 架构：服务端 /text_templates/match 删除，客户端不再调用）──
  // 词源=产品资料关联关键词（sharedProductInfo.keywords，产品库选择时带回）；
  // 产品未关联词 → LLM 兜底（/llm/chat/completions 从口播文案提卖点词）。
  // 命中=词×字幕行窗口（buildSubtitleRows：timing.json 优先，无 timing 按行长估算）；
  // templateId=候选池轮转（渲染样式层，与命中判定解耦）。
  type KeywordHit = { text: string; start: number; end: number; keywords: string[]; templateId?: string }
  /** LLM 兜底提词缓存（键=文案原文；同一文案整会话只调一次 LLM；空结果不缓存，下次重试） */
  const llmKeywordsCache = new Map<string, string[]>()
  // ── 手工标注关键词（2026-09-23 用户裁决，与智能混剪同款）：字幕文本选中→右键标注，
  //  右键已标注词→取消；按视频路径（planKey）存储并 localStorage 持久化；
  //  词表优先级=手工 → 产品关联 → LLM 补足（命中判定沿用 matchKeywordHits 词表序）──
  const MANUAL_KW_LS_KEY = 'copywriting-montage.textfx.manualKeywords'
  const manualKeywords = ref<Record<string, string[]>>(loadManualKeywords())
  function loadManualKeywords(): Record<string, string[]> {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(MANUAL_KW_LS_KEY) || '{}')
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {}
    } catch (_) { return {} }
  }
  function persistManualKeywords(): void {
    try { localStorage.setItem(MANUAL_KW_LS_KEY, JSON.stringify(manualKeywords.value)) } catch (_) {}
  }
  function addManualKeyword(planKey: string, word: string): boolean {
    const w = String(word || '').trim().slice(0, 30)
    if (!w || !planKey) return false
    const list = manualKeywords.value[planKey] || []
    if (list.some((x) => x === w)) return false
    manualKeywords.value = { ...manualKeywords.value, [planKey]: [...list, w].slice(0, 30) }
    persistManualKeywords()
    scheduleManualKwRefresh()
    return true
  }
  function removeManualKeyword(planKey: string, word: string): boolean {
    const list = manualKeywords.value[planKey] || []
    const next = list.filter((x) => x !== word)
    manualKeywords.value = { ...manualKeywords.value, [planKey]: next }
    persistManualKeywords()
    scheduleManualKwRefresh()
    return next.length !== list.length
  }
  let manualKwTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleManualKwRefresh(): void {
    if (manualKwTimer) clearTimeout(manualKwTimer)
    manualKwTimer = setTimeout(() => { void refreshTextFxTracks() }, 300)
  }
  /** 关键词判定 v2（2026-09-23 用户裁决，与智能混剪同款）：词表优先级=手工标注
   *  （planKey 维度）→ 产品关联词 → LLM 补足；命中词覆盖不足 min(3, 行数) 时自动
   *  追加 LLM 提取词重匹配（保证每条至少 3 词可命中）。门面保留只返回 hits。 */
  async function resolveKeywordState(text: string, timingPath: string, planKey = ''): Promise<{
    rows: Array<{ text: string; start: number; end: number }>
    hits: KeywordHit[]
    words: string[]
  }> {
    let timing: Array<{ text: string; start: number; end: number }> = []
    if (timingPath) {
      const res = await window.tintin?.server?.finalReadTiming?.({ timingPath })
      timing = res && 'items' in res ? res.items : []
    }
    const rows = buildSubtitleRows(String(text || '').trim(), timing, 0)
    if (!rows.length) return { rows: [], hits: [], words: [] }
    const pool = currentMatchTemplateIds()
    const manual = (manualKeywords.value[planKey] || []).map((w) => String(w || '').trim()).filter(Boolean)
    const owned = sharedProductInfo.value.keywords.map((w) => String(w || '').trim()).filter(Boolean)
    let words = [...new Set([...manual, ...owned])]
    let hits = matchKeywordHits(words, rows, pool)
    const want = Math.min(3, rows.length)
    if (hits.length < want) {
      const key = String(text || '').trim()
      let llm = llmKeywordsCache.get(key)
      if (!llm) {
        llm = await llmExtractKeywords(key)
        if (llm.length) llmKeywordsCache.set(key, llm)
      }
      const extra = llm.filter((w) => !words.some((x) => x.toLowerCase() === w.toLowerCase()))
      if (extra.length) {
        words = [...words, ...extra]
        hits = matchKeywordHits(words, rows, pool)
      }
    }
    return { rows, hits, words }
  }
  async function resolveKeywordHits(text: string, timingPath: string, planKey = ''): Promise<KeywordHit[]> {
    return (await resolveKeywordState(text, timingPath, planKey)).hits
  }
  /** LLM 兜底：从口播文案提取卖点关键词（数量随「关键词密度」档位；失败 → 空） */
  async function llmExtractKeywords(text: string): Promise<string[]> {
    const maxWords = TEXT_KEYWORD_DENSITY_MAX[textKeywordDensity.value] ?? 8
    try {
      const res = await window.tintin?.server?.llmChat?.({
        messages: [
          { role: 'system', content: LLM_KEYWORDS_SYSTEM_PROMPT.replace('{max}', String(maxWords)) },
          { role: 'user', content: String(text || '').slice(0, 2000) },
        ],
        temperature: 0.3,
      })
      const content = String((res as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? '')
      return parseLlmKeywords(content, maxWords)
    } catch (_) { return [] }
  }
  /** 当前勾选模板随 match 下发的候选池（与 concat text_template_match_ids 同源）：
   *  随机=当次随机池子集；指定=该模板自身。预览与合成共用 → 同 match_id 同 events */
  function currentMatchTemplateIds(): string[] {
    return textTemplateId.value === 'random'
      ? pickRandomItems(activeTextPool.value, textRandomCount.value).map((t) => String(t.template_id))
      : [textTemplateId.value]
  }
  async function refreshTextFxTracks(): Promise<void> {
    const seq = ++textFxTrackSeq
    if (!textFxEnabled.value) { textFxPreviewTracks.value = []; return }
    // 合成期间跳过预览刷新（2026-09-12）：与本地预取并发连击服务端 match 是 500
    // 诱因之一；合成完成后由 startFinalMix finally 统一重刷
    if (finalBusy.value) return
    const tplNames = activeTextPool.value.map((t) => String(t.name || ''))
    if (!tplNames.length) { textFxPreviewTracks.value = []; return }
    // Step4 右栏候选仍走混音口径（配音优先回退成片），与效果预览轨数据源分离
    void collectCandidates().then((cands) => { if (seq === textFxTrackSeq) step4Candidates.value = cands })
    const outputs = assemblePlans.value
      .map((p) => (p.confirmed && p.outputPath ? p.outputPath : ''))
      .filter(Boolean)
    if (!outputs.length) { textFxPreviewTracks.value = []; return }
    // 逐视频取关键词命中（与剪映导出同一取数函数 resolveKeywordHits：产品关联词，
    // 无关联词 LLM 兜底）；串行取数（2026-09-12：并发连击曾致服务端 500 的教训）
    const matched: Array<{ name: string; durationSec: number; lines: Array<{ text: string; start: number; end: number; keywords: string[] }> }> = []
    const annotate: TextFxAnnotateTrack[] = []
    for (const c of outputs) {
      const row = voiceRows.value.find((r) => r.path === c || r.dubbedPath === c)
      const dur = Number(await window.tintin?.ffmpeg?.probeDuration?.(c).catch?.(() => 0)) || 0
      // planKey=候选视频路径：手工标注关键词按视频维度存取（预览与导出同键同词表）
      const st = await resolveKeywordState(
        String(row?.text || '').trim(), row?.wavPath ? `${row.wavPath}.timing.json` : '', c,
      )
      matched.push({ name: pathBasename(c), durationSec: dur, lines: st.hits })
      annotate.push({ key: c, name: pathBasename(c), durationSec: dur, rows: st.rows, hits: st.hits, words: st.words })
    }
    if (seq !== textFxTrackSeq) return // 过期响应丢弃（连续触发只保留最新）
    // 2026-09-10 用户终裁：轨名列显示视频名（模板名拼接方案废止；name 字段自此=文件名）
    // 2026-09-11 用户二次裁决：展示层改「第N条」序号，见 VideoMontage.vue .textfx-track-name
    // 2026-09-10 用户裁决：词条按命中模板渲染颜色+动画（与样式橱窗 textFxStyleSamples
    //  同源同构，去除 fontSize 只取颜色/渐变；不命中模板的词条走 CSS 默认色）
    textFxAnnotate.value = annotate
    textFxPreviewTracks.value = buildTextFxTracks({
      rows: matched,
      tplNames,
      count: activeTextCount.value, // 每视频独立随机选 N 个（2026-09-10 用户二次裁决）
    })
    // 2026-09-15 用户裁决：词条=纯关键词标记（哪些词/哪个位置），不再拉 render-preview
    // 动画片段——那是近似物（默认字体+CSS 动画，实测非模板真值），渲染只在合成时发生
  }
  // 2026-09-11：match 含 LLM 补足（服务端 15s 内），防抖 800ms 收敛连续触发
  // （旧本地提取为纯计算，可直接同步跑；接入服务端后必须防抖）
  let textFxTracksTimer: ReturnType<typeof setTimeout> | null = null
  watch([textFxEnabled, textTemplateId, textRandomCount, textTemplates, textKeywordDensity, voiceRows, assemblePlans], () => {
    if (textFxTracksTimer) clearTimeout(textFxTracksTimer)
    textFxTracksTimer = setTimeout(() => { void refreshTextFxTracks() }, 800)
  }, { deep: true })
  // 2026-09-11 用户裁决：本地提取词表 → 上传服务端（旧 textfx:keywordsSave 桥）
  // 整链废止——关键词命中在合成请求内由服务端从随请求提交的字幕完成，服务端
  // 不保存待命中的字幕；服务端「全局常用关键词」库不再被客户端覆盖。
  /** 样式预览样本：按命中模板 variables 默认值本地渲染（服务端
   *  /text_templates/templates/{id}/preview 静态预览图 2026-09-10 复测已可用（200 png），
   *  但为单帧静态图无动画，与「文字模板预览要有动画」裁决不符，故预览仍走本地 CSS 动画；
   *  render-preview 动画预览接口实测 500（服务端内部错误，契约缺口已上报）。
   *  从 variables 推导：颜色收集≥2 个做渐变字，fontSize 按比例缩到预览口径） */
  const srvBase = ref('')
  const textFxStyleSamples = computed(() => {
    // 2026-09-15 用户裁决：橱窗只显示剪映同步模板（jy_ 前缀），内置模板不再展示；
    // 随机数量是每条视频各自随机选 N 个，在效果预览/烧制端逐视频应用，不在此处裁剪
    return textTemplates.value
      .filter((t) => String(t.template_id || '').startsWith('jy_'))
      .map((t) => {
      const vars = (t.variables && typeof t.variables === 'object' ? t.variables : {}) as Record<string, { default?: unknown }>
      const colors: string[] = []
      let fontSize = 0
      for (const v of Object.values(vars)) {
        const d = v && typeof v === 'object' ? (v as { default?: unknown }).default : v
        if (typeof d === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(d) && colors.length < 3) colors.push(d)
        if (typeof d === 'number' && d >= 10 && d <= 300) fontSize = Math.max(fontSize, d)
      }
      const text = String((vars.text && typeof vars.text === 'object' ? (vars.text as { default?: unknown }).default : undefined) || t.name || '')
      const size = fontSize ? Math.min(28, Math.max(14, Math.round((fontSize / 72) * 28))) : 20
      // 动画类型：按服务端模板定义对齐（服务端无结构化动画字段，以 id/name 语义
      //  命名 + variables 效果色变量约定动画；2026-09-10 全量对齐 10 个模板）
      // M2a：显式 anim 变量优先（同步 jy_ 模板声明），名称正则兜底
      const varsAnim = vars.anim && typeof vars.anim === 'object' ? String((vars.anim as { default?: unknown }).default || '') : ''
      const key = `${t.template_id || ''}${t.name || ''}`
      const anim = varsAnim || (/bounce|pop|弹/.test(key) ? 'bounce'
        : /flip|翻转/.test(key) ? 'flip'
        : /gradient|渐变/.test(key) ? 'flow'
        : /neon|glow|霓虹/.test(key) ? 'neon'
        : /shimmer|闪|扫/.test(key) ? 'shine'
        : /slide|滑/.test(key) ? 'slide'
        : /typewriter|打字/.test(key) ? 'type'
        : /pulse|zoom|脉冲|缩放/.test(key) ? 'pulse'
        : /fade|淡/.test(key) ? 'fade'
        : 'fade')
      // 效果色：variables 中除主色 color 外的第一个色值（jumpColor/popColor/shine/
      //  glow/pulse/accent/cursorColor/color2 —— 服务端为每个动画模板配的专用色）
      const mainColor = String((vars.color && typeof vars.color === 'object' ? (vars.color as { default?: unknown }).default : '') || '#FFFFFF')
      const effect = colors.find((c) => c.toLowerCase() !== mainColor.toLowerCase()) || mainColor
      const style: Record<string, string> = { fontSize: size + 'px', '--fx-color': effect }
      if (anim === 'flow') {
        // gradient_text：color+color2 双色渐变流动（background-position 循环）
        style.background = `linear-gradient(90deg, ${mainColor}, ${effect}, ${mainColor})`
        style.backgroundSize = '200% 100%'
        style.webkitBackgroundClip = 'text'
        style.backgroundClip = 'text'
        style.color = 'transparent'
      } else if (anim === 'shine') {
        // shimmer 闪光扫过：三段渐变含高光带（高光色用服务端 shine 变量）+ 扫光动画
        style.background = `linear-gradient(110deg, ${mainColor} 35%, ${effect} 50%, ${mainColor} 65%)`
        style.backgroundSize = '300% 100%'
        style.webkitBackgroundClip = 'text'
        style.backgroundClip = 'text'
        style.color = 'transparent'
      } else {
        style.color = mainColor
      }
      // M2a：服务端真实效果预览（上传时自动生成，贴纸+文字合成图）——有则优先用，
      // 无则回退本地近似画法。相对路径需绝对化（file:// origin 下 / 开头路径 404 → 碎图），
      // 基址经 env:serverPing 取一次缓存（ensureSrvBase，loadTextTemplates 时触发）
      const previewUrl = srvAbs(String((t as Record<string, unknown>).preview || ''))
      const previewWebmUrl = srvAbs(String((t as Record<string, unknown>).preview_webm || ''))
      return { id: String(t.template_id), name: String(t.name || t.template_id), text, anim, style, previewUrl, previewWebmUrl }
    })
  })
  /** 服务端基址缓存（预览 URL 绝对化用；loadTextTemplates 时经 env:serverPing 取一次）。
   *  ref 响应式：加载后 textFxStyleSamples 自动重算（修复预览碎图） */
  async function ensureSrvBase(): Promise<void> {
    if (srvBase.value) return
    try {
      const bridge = window.tintin as unknown as { env?: { serverPing?: () => Promise<{ url?: string }> } } | undefined
      const ping = await bridge?.env?.serverPing?.()
      srvBase.value = String(ping?.url || '')
    } catch (_) { /* 无 env 桥（预览环境） */ }
  }
  function srvAbs(p: string): string {
    if (!p || /^https:\/\//.test(p)) return p
    return srvBase.value ? srvBase.value.replace(/\/$/, '') + (p.startsWith('/') ? p : '/' + p) : p
  }
  /** 拉取服务端文字模板库（GET /text_templates/templates，2026-09-10 纠偏；进入 Step4 时调用；空库时下拉仅随机项） */
  async function loadTextTemplates(): Promise<void> {
    if (textTemplatesLoading.value) return
    textTemplatesLoading.value = true
    try {
      const sr = await window.tintin?.server?.textfxServerTemplates?.()
      const items = sr && !('error' in sr) && Array.isArray(sr.templates) ? sr.templates : []
      textTemplates.value = items.filter((t) => t && t.template_id)
      void ensureSrvBase() // 预览 URL 绝对化基址（异步不阻塞下拉）
      void loadCatalogLanes() // 二期：catalog 类目分组（异步不阻塞下拉）
    } catch (_) {
      textTemplates.value = []
    } finally {
      textTemplatesLoading.value = false
    }
  }

  return {
    textFxEnabled, lutRestore, lutId, lutList, lutListLoading, loadLuts,
    textTemplateId, textRandomCount, textKeywordDensity, textTemplates, textTemplatesLoading,
    activeTextPool, activeTextCount, textTemplateOptions, catalogTextLanes, loadCatalogLanes,
    textFxPreviewTracks, textFxStyleSamples, srvBase, loadTextTemplates,
    resolveKeywordHits, currentMatchTemplateIds, refreshTextFxTracks,
    textFxAnnotate, addManualKeyword, removeManualKeyword,
  }
}