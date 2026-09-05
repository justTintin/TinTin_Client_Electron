// ═══════════════════════════════════════════════════════════════
// useAudioGen.ts — 音频生成（媒体工具·音频组）
// 一比一移植原客户端 audio_material_page.py「 AI 生成」tab（L1568-1852）：
//   · 生成 BGM→ audio:genBgm（gen_bgm L159-175）
//   · 生成音效→ audio:genSfx（gen_sfx L179-196）
//   · 保存到 BGM 库 → 临时落盘 + audio:bgmUpload（bgm_upload L71-94，tag="AI生成"）
//   · 保存到音效库 → 临时落盘 + audio:sfxAnalyze（sfx_analyze L127-147）
// UI 文案铁律：按钮/标签/提示逐字对照原版 view 源码（前导空格为原版 icon 占位，不移植）
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue'
import type { AudioAPI } from '../../../types/server-api-audio'

function notify(title: string, body: string): void {
  try { window.tintin?.shell?.showNotification?.(title, body) } catch (_) { /* 预览环境无桥 */ }
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

// ═══ 音频列表域（原「全部」tab 一比一：_AudioListWorker L156-192 + _fill_list L626-686
//     + 分页 L961-983；2026-09-04 用户裁决：左列表 + 右侧两生成面板上下排列）
//     勾选列与「卡点成片」未移植——V3 无卡点成片页，列入待裁决 ═══

export interface AudioListItem {
  mid: string
  filename: string
  /** 本地分类原始判定（sfx/voice/music/''），可被 kindOverrides 覆盖 */
  kindCode: string
  kindName: string
  durStr: string
  sizeStr: string
  scene: string
}

const KIND_TEXT: Record<string, string> = { sfx: '音效', voice: '配音', music: '音乐' }

// ── 行内分类本地覆盖（2026-09-04 用户裁决：行内分类可改）──
// 2026-09-05 更新：服务端音频分流 audio_library 表后 category 已是四值枚举字段，
// 分类展示优先读服务端 category（categoryToKind）；本地覆盖仅作为用户手动改后的优先值。
// 若要彻底服务端落库可切 PUT /audio/library/{id}（待裁决）。
const KIND_OVERRIDE_KEY = 'tintin_audio_kind_overrides'

function loadKindOverrides(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KIND_OVERRIDE_KEY) || '{}') || {} } catch (_) { return {} }
}

/** 秒 → M:SS（原 _fmt_sec L119-122） */
function fmtSec(seconds: unknown): string {
  const s = Math.floor(Number(seconds) || 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function useAudioGen() {
  // ── 服务端地址（结果相对路径拼绝对 URL 供播放）──
  const serverUrl = ref('')
  async function ensureServerUrl(): Promise<string> {
    if (serverUrl.value) return serverUrl.value
    try {
      const ping = await (window as any).tintin?.env?.serverPing?.()
      serverUrl.value = String(ping?.url || '')
    } catch (_) { /* 预览环境无 env 桥 → 空串 */ }
    return serverUrl.value
  }

  /** 相对路径 → 绝对 URL（http 原样；无 serverUrl 时保持相对） */
  function toAbsolute(url: string): string {
    const u = String(url || '')
    if (!u || /^https?:\/\//i.test(u)) return u
    return serverUrl.value ? serverUrl.value.replace(/\/$/, '') + u : u
  }

  // ── 生成 BGM──
  // 2026-09-05 最终裁决：纯结构化口径 {style, mood?, duration}，无描述输入——GUIDE
  //  明确无 prompt 字段（服务端自组 prompt，提示词工程收归服务端）；描述框若保留
  //  则服务端不消费=假功能。style 值对齐 /audio/bgm/tags 的 style 组，
  //  'auto'=按历史评价优选。
  const bgmStyle = ref('auto')
  const bgmDuration = ref(30)          // 2026-09-05 用户裁决：上限 30 秒（输入框 max=30 + 生成前 clamp 双保险），默认 30
  const bgmBusy = ref(false)
  const bgmResultLabel = ref('')       // 原 ai_bgm_result_label（muted 多行）
  const bgmUrl = ref('')               // 原 _ai_bgm_url
  const bgmName = ref('')              // 原 _ai_bgm_name
  const bgmSaving = ref(false)         // 保存中（原按钮文案→"保存中..."）

  // ── BGM 标签体系：服务端端点 GET /audio/bgm/tags（openapi 未收录；2026-09-05 实测
  // 服务端响应 { style:string[], mood:string[], scene:string[], groups }）。
  // 2026-09-05 用户裁决合并：「风格」与「标签」两下拉同源（style 组）语义重复——
  // 删除「标签」下拉，生成与入库统一用「风格」（bgmStyle）；normalizeTagOptions
  // 保留供 groupOptions 复用（防御兼容旧口径 tags|items，元素支持 string | 对象）。

  function normalizeTagOptions(data: unknown): Array<{ label: string; value: string }> {
    let arr: unknown[] = []
    if (Array.isArray(data)) {
      arr = data
    } else if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>
      const inner = (d.data && typeof d.data === 'object' ? d.data : d) as Record<string, unknown>
      arr = (inner.tags || inner.items || inner.style || []) as unknown[]
    }
    const out = arr
      .map((t) => {
        if (typeof t === 'string' || typeof t === 'number') return { label: String(t), value: String(t) }
        const o = (t || {}) as Record<string, unknown>
        const value = String(o.value ?? o.name ?? o.tag ?? o.label ?? '')
        const label = String(o.label ?? o.name ?? o.tag ?? o.value ?? value)
        return { label, value }
      })
      .filter((o) => o.value)
    return out.length ? out : [{ label: '（服务端未定义）', value: '' }]
  }

  // ── 情绪/场景精控（2026-09-05 用户裁决：服务端 /audio/bgm/tags 的 mood/scene 组，
  //    保存时随 upload 契约的 mood/scene 字段上传；默认「不指定」传空串） ──
  const bgmMood = ref('')
  const bgmScene = ref('')
  const bgmMoodOptions = ref<Array<{ label: string; value: string }>>([])
  const bgmSceneOptions = ref<Array<{ label: string; value: string }>>([])

  /** 从 /audio/bgm/tags 响应取指定组（mood|scene）→ 下拉选项；空组/请求失败 → 「不指定」单选 */
  function groupOptions(data: unknown, key: string): Array<{ label: string; value: string }> {
    let arr: unknown[] = []
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const d = data as Record<string, unknown>
      const inner = (d.data && typeof d.data === 'object' ? d.data : d) as Record<string, unknown>
      arr = (inner[key] || []) as unknown[]
    }
    const out = normalizeTagOptions(arr).filter((o) => o.value)
    return [{ label: '不指定', value: '' }, ...out]
  }

  /** 拉取服务端 BGM 标签体系（失败静默 → 显示占位项，保存时 tag 传空） */
  async function loadBgmTags(): Promise<void> {
    try {
      await ensureServerUrl()
      const data = await serverGet('/audio/bgm/tags', {})
      bgmMoodOptions.value = groupOptions(data, 'mood')
      bgmSceneOptions.value = groupOptions(data, 'scene')
      // 生成用风格下拉 = 自动 + style 组（中文值对齐服务端 GUIDE 新口径）
      const styleGroup = groupOptions(data, 'style').filter((o) => o.value)
      bgmStyleOptions.value = [{ label: '自动', value: 'auto' }, ...styleGroup]
    } catch (_) {
      bgmMoodOptions.value = [{ label: '不指定', value: '' }]
      bgmSceneOptions.value = [{ label: '不指定', value: '' }]
    }
  }

  /** 生成用风格下拉（2026-09-05 切服务端口径）：自动(auto=按历史评价优选) + /audio/bgm/tags
   *  的 style 组；loadBgmTags 成功后填充，失败/未拉取时兜底「自动」单选 */
  const bgmStyleOptions = ref<Array<{ label: string; value: string }>>([{ label: '自动', value: 'auto' }])

  /** 生成 BGM（2026-09-05 最终裁决：纯结构化口径 {style, mood?, duration}） */
  async function generateBgm(): Promise<void> {
    bgmBusy.value = true
    bgmResultLabel.value = 'BGM 生成中，可能需要 30-60 秒...'
    try {
      await ensureServerUrl()
      // 2026-09-05 用户裁决：上限 30 秒——input max 挡不住手输，发请求前 clamp 双保险
      bgmDuration.value = Math.min(30, Math.max(5, Math.round(Number(bgmDuration.value) || 30)))
      const data = unwrapIpc<AudioAPI.GenBgmResponse>(
        await window.tintin.server.audioGenBgm({ style: bgmStyle.value, mood: bgmMood.value, duration: bgmDuration.value }),
        '生成 BGM')
      const url = String(data.url || data.audio_url || (data as Record<string, unknown>).file_url || '')
      const name = String(data.filename || (data as Record<string, unknown>).name || 'AI 生成 BGM')
      bgmUrl.value = url
      bgmName.value = name
      bgmResultLabel.value = `生成成功！${name}\n时长: ${data.duration ?? '—'} 秒\nURL: ${url}`
    } catch (e) {
      bgmResultLabel.value = `BGM 生成失败：${errText(e)}`
    } finally {
      bgmBusy.value = false
    }
  }

  // ── 生成音效──
  const sfxPrompt = ref('')
  const sfxDuration = ref(3)           // 原版 QSpinBox 1-15 默认 3（L1647-1649）；2026-09-04 用户澄清：音效维持原版默认 3 秒，仅 BGM 改 35
  const sfxBusy = ref(false)
  const sfxResultLabel = ref('')
  const sfxUrl = ref('')
  const sfxName = ref('')
  const sfxSaving = ref(false)

  /** 生成音效（原 _on_gen_sfx L1769-1782 + _on_gen_sfx_done/_error；name 候选顺序与 BGM 相反：name|filename） */
  async function generateSfx(): Promise<void> {
    const prompt = sfxPrompt.value.trim()
    if (!prompt) { notify('提示', '请输入音效描述。'); return }
    sfxBusy.value = true
    sfxResultLabel.value = '音效生成中，可能需要 15-30 秒...'
    try {
      await ensureServerUrl()
      const data = unwrapIpc<AudioAPI.GenSfxResponse>(
        await window.tintin.server.audioGenSfx({ prompt, duration: sfxDuration.value }),
        '生成音效')
      const url = String(data.url || data.audio_url || data.file_url || '')
      const name = String(data.name || data.filename || 'AI 生成音效')
      sfxUrl.value = url
      sfxName.value = name
      sfxResultLabel.value = `生成成功！${name}\n时长: ${data.duration ?? '—'} 秒\nURL: ${url}`
    } catch (e) {
      sfxResultLabel.value = `音效生成失败：${errText(e)}`
    } finally {
      sfxBusy.value = false
    }
  }

  // ── 保存入库（原 _on_save_bgm_to_lib/_on_save_sfx_to_lib：下载临时文件 → 上传/分析入库）──
  /** 响应 dict 摘要（原 QMessageBox 展示 python dict repr；V3 用 JSON 文本，架构差异注明） */
  function summarize(data: unknown): string {
    try { return JSON.stringify(data) } catch (_) { return String(data) }
  }

  /** 保存到 BGM 库（2026-09-04 服务端契约更新：multipart 字段 tag→style，服务端固定
   *  category='配乐'；bgmTag 下拉值即剪映风格标签 → 新契约 style 字段，无选择传空） */
  async function saveBgmToLib(): Promise<void> {
    if (!bgmUrl.value || bgmSaving.value) return
    bgmSaving.value = true
    try {
      const dl = unwrapIpc<{ path: string }>(
        await window.tintin.server.audioDownloadTemp({ url: bgmUrl.value, prefix: 'ai_bgm_', defaultExt: '.mp3' }),
        '保存到 BGM 库')
      const data = unwrapIpc<Record<string, unknown>>(
        // 2026-09-04 契约：style=剪映风格标签；2026-09-05 用户裁决：风格/标签合并——
        // 入库 style 沿用「风格」选择（'auto' 无具体风格 → 传空让服务端自定），
        // mood/scene 随情绪/场景下拉上传（「不指定」传空串）
        await window.tintin.server.audioBgmUpload({
          filePath: dl.path,
          style: bgmStyle.value !== 'auto' ? bgmStyle.value : '',
          mood: bgmMood.value,
          scene: bgmScene.value,
        }),
        '保存到 BGM 库')
      notify('成功', `已保存到 BGM 库！\n${summarize(data)}`)
      // 2026-09-04 用户裁决：保存成功后自动刷新左列表（新条目按时间倒序在首页）
      doSearch()
    } catch (e) {
      notify('失败', `保存失败：${errText(e)}`)
    } finally {
      bgmSaving.value = false
    }
  }

  /** 保存到音效库（2026-09-05 服务端音频分流 audio_library 表：/sfx/analyze 旧音效库
   *  不进左列表 → 切 /audio/library/upload category='音效' 入音频库，上传后触发
   *  PANNs 单条分析补全 emotion/风格标签（失败静默，不阻断入库流程） */
  async function saveSfxToLib(): Promise<void> {
    if (!sfxUrl.value || sfxSaving.value) return
    sfxSaving.value = true
    try {
      const dl = unwrapIpc<{ path: string }>(
        await window.tintin.server.audioDownloadTemp({ url: sfxUrl.value, prefix: 'ai_sfx_', defaultExt: '.wav' }),
        '保存到音效库')
      const data = unwrapIpc<Record<string, unknown>>(
        await window.tintin.server.audioLibraryUpload({ filePath: dl.path, category: '音效' }),
        '保存到音效库')
      // 触发 PANNs 分析补全标签（后台性质，失败不阻断；服务端 analyze_all 亦可补全）
      const newId = Number((data as Record<string, unknown>).id)
      if (Number.isInteger(newId) && newId > 0) {
        void (window as any).tintin?.server?.post?.(`/audio/library/${newId}/analyze`, {}).catch(() => { /* 静默 */ })
      }
      notify('成功', `已保存到音效库！\n${summarize(data)}`)
      // 同上：保存成功后自动刷新左列表
      doSearch()
    } catch (e) {
      notify('失败', `保存失败：${errText(e)}`)
    } finally {
      sfxSaving.value = false
    }
  }

  // ── 列表试听（原 _play_by_mid L752-770 + _on_cell_double_clicked L716-732：
  //    双击切歌，同曲再击暂停/继续；V3 内联 audio 流式，URL= /material/serve）──
  const playingMid = ref('')
  const playingName = ref('')
  const listAudioEl = ref<HTMLAudioElement | null>(null)

  /** 音频库文件流 URL（2026-09-05 列表切 audio_library 后替代 /material/serve；
   *  实测 GET /audio/library/{id}/file 200 audio/x-wav，404=不存在） */
  function buildAudioFileUrl(mid: string): string {
    return toAbsolute(`/audio/library/${mid}/file`)
  }

  function playListRow(item: AudioListItem): void {
    if (!item.mid) return
    if (playingMid.value === item.mid) { toggleListPlay(); return }
    playingMid.value = item.mid
    playingName.value = item.filename
    const el = listAudioEl.value
    if (!el) return
    el.src = buildAudioFileUrl(item.mid)
    void el.play().catch(() => { /* 加载失败静默（流式 URL 由服务端提供） */ })
  }

  function toggleListPlay(): void {
    const el = listAudioEl.value
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }

  // ── 行内下载（2026-09-04 用户裁决：行加下载按钮）──
  // 复用既有通道：dialog:saveFile 选保存路径 + server:downloadResult 落盘（三态同口径）
  async function downloadRow(item: AudioListItem): Promise<void> {
    try {
      const savePath = await (window as any).tintin?.dialog?.saveFile?.({
        title: '下载音频',
        defaultPath: item.filename,
        filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg'] }],
      })
      if (!savePath) return // 用户取消
      await ensureServerUrl()
      const url = buildAudioFileUrl(item.mid)
      const res = await window.tintin.server.downloadResult(url, savePath)
      if (res === null) { notify('失败', `下载失败：${item.filename}（服务端不可达）`); return }
      notify('成功', `已下载：${savePath}`)
    } catch (e) {
      notify('失败', `下载失败：${errText(e)}`)
    }
  }

  // ── 行内删除（2026-09-05 用户裁决：每行最右加删除；同日服务端上线连文件删除）──
  // 契约：DELETE /audio/library/{id}?delete_file=true（GUIDE：先删 NAS 源文件（WebDAV）
  //  成功后才删记录，孤儿分析行一并清理；文件已不存在 → 幂等 file_deleted=false 记录照删；
  //  文件删不掉 → 500「源文件删除失败…记录未删除」。响应 {id, deleted, file_deleted}）。
  //  前身 POST /material/delete 仅删素材库记录——音频已分流 audio_library 表，统一切音频库口径。
  async function deleteRow(item: AudioListItem): Promise<void> {
    const midNum = Number(item.mid)
    if (!item.mid || !Number.isInteger(midNum)) { notify('失败', `删除失败：无效的音频 ID（${item.mid}）`); return }
    if (!window.confirm(`确定删除「${item.filename}」吗？\n将同时删除 NAS 源文件，不可恢复。`)) return
    try {
      const data = await (window as any).tintin?.server?.delete?.(`/audio/library/${midNum}`, { delete_file: true })
      if (data === null || data === undefined) throw new Error('无法连接服务端，请检查服务端是否在线')
      if (typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
        throw new Error(String((data as Record<string, unknown>).error))
      }
      // 本地分类覆盖一并清理（条目已删，残留无意义）
      if (kindOverrides.value[item.mid]) {
        delete kindOverrides.value[item.mid]
        try { localStorage.setItem(KIND_OVERRIDE_KEY, JSON.stringify(kindOverrides.value)) } catch (_) { /* 静默 */ }
      }
      // 成功后刷新列表（条目消失，总数/分页同步更新）
      doSearch()
    } catch (e) {
      notify('失败', `删除失败：${errText(e)}`)
    }
  }

  // ── 音频列表状态（原 _do_search/_run_search/分页同口径）──
  const kindOverrides = ref<Record<string, string>>(loadKindOverrides())

  /** 行内改分类（空串=恢复未分类）；仅本地覆盖，服务端无更新端点（见铁律注释） */
  function setRowKind(item: AudioListItem, kind: string): void {
    if (kind) kindOverrides.value[item.mid] = kind
    else delete kindOverrides.value[item.mid]
    try { localStorage.setItem(KIND_OVERRIDE_KEY, JSON.stringify(kindOverrides.value)) } catch (_) { /* 存储满/隐私模式静默 */ }
  }

  const listQuery = ref('')
  const listTag = ref('')
  const listKind = ref('')
  const LIST_KIND_OPTIONS = [
    { label: '全部', value: '' },
    { label: '音效（场景/氛围音）', value: 'sfx' },
    { label: '配音（口播/旁白）', value: 'voice' },
    { label: '音乐（BGM/配乐）', value: 'music' },
  ] as const
  const listRows = ref<AudioListItem[]>([])
  const listLoading = ref(false)
  const listError = ref('')
  const listStat = ref('')
  const listPageSize = ref(20)         // 2026-09-05 二次裁决：回 20 条/页（与列表区域一屏可见 ≈20 条匹配）
  const listOffset = ref(0)
  const listTotal = ref(0)

  /** 页码标签（原 _update_page_label L961-967 同口径） */
  const pageLabel = computed(() => {
    if (listTotal.value <= 0) return '第 0 / 0 页'
    const size = listPageSize.value || 1
    const cur = Math.floor(listOffset.value / size) + 1
    const totalPages = Math.max(1, Math.ceil(listTotal.value / size))
    return `第 ${cur} / ${totalPages} 页`
  })
  const canPrevPage = computed(() => listOffset.value > 0)
  const canNextPage = computed(() => listOffset.value + listPageSize.value < listTotal.value)

  /** audio_library.category（四值枚举）→ 本地 kind 过滤码（'BGM' 为 seed 旧值，归 music） */
  function categoryToKind(category: unknown): string {
    const c = String(category || '')
    if (c === '配乐' || c === 'BGM' || c === 'music') return 'music'
    if (c === '音效' || c === 'sfx') return 'sfx'
    if (c === '配音' || c === 'voice') return 'voice'
    return ''
  }

  /** 填充列表（2026-09-05 切 audio_library：kind = 分类覆盖 > category 映射；
   *  tooltip 描述行改带 tags；kind 过滤仍在本地——服务端无 kind 参数） */
  function fillList(rows: Record<string, unknown>[]): void {
    const kind = listKind.value
    const out: AudioListItem[] = []
    for (const item of rows) {
      const mid = String(item.id || '')
      const kindCode = kindOverrides.value[mid] ?? categoryToKind(item.category)
      if (kind && kindCode !== kind) continue
      const fsize = Number(item.file_size || 0)
      const dur = item.duration_s
      const tags = Array.isArray(item.tags) ? (item.tags as unknown[]).map(String).join(' ') : ''
      out.push({
        mid,
        filename: String(item.filename ?? '') || '未命名',
        kindCode,
        kindName: KIND_TEXT[kindCode] || '未分类',
        durStr: dur ? fmtSec(dur) : '—',
        sizeStr: fsize ? `${(fsize / 1048576).toFixed(1)}MB` : '—',
        scene: tags,
      })
    }
    listRows.value = out
    listStat.value = `共 ${listTotal.value} 条音频（本页显示 ${out.length} 条）`
  }

  /** 通用 GET 三态分流（server:get 兜底通道） */
  async function serverGet(path: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await (window as any).tintin?.server?.get?.(path, params)
    if (data === null || data === undefined) {
      throw new Error('无法连接服务端，请检查服务端是否在线')
    }
    if (typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
      throw new Error(String((data as Record<string, unknown>).error))
    }
    return data as Record<string, unknown>
  }

  /** 检索（2026-09-05 服务端音频分流至独立 audio_library 表——/material/list 不再返回
   *  新入库音频，列表/检索统一切 GET /audio/library：page/size 分页 + query 语义检索
   *  + tag 筛选（实测 200：{items,total,page,size}）；分类过滤仍在本地做（kind 覆盖优先） */
  async function runList(): Promise<void> {
    listLoading.value = true
    listError.value = ''
    try {
      await ensureServerUrl()
      const params: Record<string, unknown> = {
        page: Math.floor(listOffset.value / listPageSize.value) + 1,
        size: listPageSize.value,
      }
      const tag = listTag.value.trim()
      const query = listQuery.value.trim()
      if (tag) params.tag = tag
      if (query) params.query = query
      const data = await serverGet('/audio/library', params)
      const rows = (data.items || []) as Record<string, unknown>[]
      const total = Number(data.total ?? rows.length)
      listTotal.value = total
      fillList(rows)
    } catch (e) {
      listError.value = errText(e)
      listRows.value = []
      listTotal.value = 0
      listStat.value = ''
    } finally {
      listLoading.value = false
    }
  }

  /** 新检索（原 _do_search：offset 归零） */
  function doSearch(): void {
    listOffset.value = 0
    void runList()
  }

  function goPrevPage(): void {
    if (listOffset.value <= 0) return
    listOffset.value = Math.max(0, listOffset.value - listPageSize.value)
    void runList()
  }

  function goNextPage(): void {
    if (listOffset.value + listPageSize.value >= listTotal.value) return
    listOffset.value += listPageSize.value
    void runList()
  }

  return {
    // BGM
    bgmStyle, bgmStyleOptions, bgmDuration, bgmBusy, bgmResultLabel, bgmUrl, bgmName, bgmSaving,
    generateBgm, saveBgmToLib,
    // SFX
    sfxPrompt, sfxDuration, sfxBusy, sfxResultLabel, sfxUrl, sfxName, sfxSaving,
    generateSfx, saveSfxToLib,
    // 播放辅助
    toAbsolute,
    // 音频列表（原「全部」tab）
    listQuery, listTag, listKind, LIST_KIND_OPTIONS,
    listRows, listLoading, listError, listStat, listPageSize,
    pageLabel, canPrevPage, canNextPage,
    doSearch, goPrevPage, goNextPage,
    loadBgmTags,
    bgmMood, bgmMoodOptions, bgmScene, bgmSceneOptions,
    playingMid, playingName, listAudioEl, playListRow,
    downloadRow, deleteRow,
    kindOverrides, setRowKind,
  }
}
