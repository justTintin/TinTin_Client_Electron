// ═══════════════════════════════════════════════════════════════
// useOpsProductLibrary — 产品资料域 composable（运营工具 · P1 实装）
// 对照原客户端 gui/product_library_page.py + utils/product_library_manager.py：
//   · 树：grouped（空关键词）/ search?q=（关键词）→ 渲染层建树（纯函数）
//   · 同步：POST /sync → 轮询 GET /sync/status（2s，对齐 StockSyncWorker L70-86）
//   · 智能挖掘（单条）：POST /mine {item_ids:[id]} → 轮询 /mine/status →
//     GET /items/{id} 回填（L118-166，含 10 分钟上限与重试回读）
//   · 全量挖掘：POST /mine {item_ids:[]} → 轮询（BulkMineWorker L185-218）
//   · 增删改：POST /items、PUT /items/{id}、DELETE /items/{id}（必填校验前置）
//   · 详情：缓存命中直读 / 未命中 GET /items/{id}（L664-674）
// 服务端契约（openapi-latest.json 已核实）：/api/product-library/clients/{machine_id}/*
//   全套端点存在；X-Machine-ID 头由主进程 server-proxy 自动注入，machine_id 路径
//   参数经 env:getMachineId 获取（与头同值，同一 config-store 口径）。
// 分层（IRON-06）：本层只做 HTTP 编排与轮询；树/校验/摘要等纯逻辑在
// opsProductLibraryLogic.ts（有单测）；组件零 URL 拼装。
// Excel 导入导出：原版有（openpyxl），新端待引入 SheetJS 后单独批次实装。
// ═══════════════════════════════════════════════════════════════

import { ref, onUnmounted } from 'vue'
import { getTintin } from './useSettingsConfig'
import {
  buildProductTree,
  fieldLockMap,
  isWarehouseItem,
  normalizeItem,
  parseImportRows,
  parseMineStatus,
  parseSyncStatus,
  searchResultLabel,
  treeToNodes,
  validateItem,
  type ProductItem,
  type ProductTreeNode,
} from './opsProductLibraryLogic'

/** 轮询间隔（原版 time.sleep(2)）与挖掘上限（原版 10 分钟） */
const POLL_MS = 2000
const MINE_TIMEOUT_MS = 10 * 60 * 1000
/** 搜索防抖（原版 QTimer 300ms） */
const SEARCH_DEBOUNCE_MS = 300

export function useOpsProductLibrary() {
  /* ── 树 / 搜索状态 ── */
  const keyword = ref('')
  const nodes = ref<ProductTreeNode[]>([])
  const searchHits = ref<{ id: string; label: string }[]>([])
  const treeLoading = ref(false)
  const treeError = ref('')

  /* ── 表单状态 ── */
  const form = ref<Record<string, string>>({})
  const editingId = ref<string | null>(null)
  const lockedFields = ref<Record<string, boolean>>(fieldLockMap(false))
  const formStatus = ref('')
  const saving = ref(false)

  /* ── 同步 / 挖掘状态 ── */
  const syncing = ref(false)
  const syncStatus = ref('')
  const mining = ref(false)          // 单条挖掘中
  const bulkMining = ref(false)      // 全量挖掘中（再点=停止）
  const mineStatus = ref('')

  /* ── machine_id 路径参数（懒加载缓存） ── */
  let machineId = ''
  async function ensureMachineId(): Promise<string> {
    if (machineId) return machineId
    const t = getTintin()
    const r = await t?.env?.getMachineId?.()
    machineId = r?.ok ? String(r.machineId || '') : ''
    return machineId
  }

  function base(machineId: string): string {
    return `/api/product-library/clients/${encodeURIComponent(machineId)}`
  }

  /** 离线（null）→ Error；{error} → Error；其余原样返回 */
  async function callJson<T>(fn: () => Promise<T>): Promise<T> {
    const data = await fn()
    if (data === null || data === undefined) throw new Error('无法连接服务端，请检查服务端地址配置。')
    if (typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
      const msg = String((data as Record<string, unknown>).error || '')
      if (msg) throw new Error(msg)
    }
    return data
  }

  /* ── 树加载（对齐 refresh_tree / _fetch_tree_data） ─────────── */

  async function loadTree(): Promise<void> {
    const t = getTintin()
    if (!t?.server) { treeError.value = '预览环境：无 IPC'; return }
    const mid = await ensureMachineId()
    if (!mid) { treeError.value = '机器码获取失败'; return }
    const kw = keyword.value.trim()
    treeLoading.value = true
    treeError.value = ''
    try {
      if (kw) {
        // 搜索：结果为平铺列表（对齐原 search 分支 L639-647）
        const data = await callJson(() => t.server.get(`${base(mid)}/search`, { q: kw }))
        const items = extractItems(data)
        searchHits.value = items.map((it) => ({ id: String(it.id ?? ''), label: searchResultLabel(it) }))
        nodes.value = []
      } else {
        // 全量树：grouped（服务端 tree 缺失时渲染层降级建树，对齐 manager L333-344）
        const data = await callJson(() => t.server.get(`${base(mid)}/grouped`, {}))
        const tree = (data && typeof data === 'object' && 'tree' in data && typeof data.tree === 'object')
          ? data.tree as Record<string, Record<string, ProductItem[]>>
          : buildProductTree(extractItems(data))
        searchHits.value = []
        nodes.value = treeToNodes(tree)
      }
    } catch (e) {
      nodes.value = []
      searchHits.value = []
      treeError.value = (e as Error)?.message || String(e)
    } finally {
      treeLoading.value = false
    }
  }

  /** {items}|{data}|{results}|裸数组 容错展开（同 workbenchChatContext.pickListItems 口径） */
  function extractItems(data: unknown): ProductItem[] {
    if (Array.isArray(data)) return data as ProductItem[]
    if (data && typeof data === 'object') {
      for (const key of ['items', 'data', 'results']) {
        const v = (data as Record<string, unknown>)[key]
        if (Array.isArray(v)) return v as ProductItem[]
      }
    }
    return []
  }

  /* ── 搜索防抖（对齐原 QTimer 300ms） ─────────────────────────── */

  let searchTimer: ReturnType<typeof setTimeout> | null = null
  function onKeywordInput(v: string): void {
    keyword.value = v
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { void loadTree() }, SEARCH_DEBOUNCE_MS)
  }

  /* ── 详情 / 表单（对齐 _on_tree_clicked / clear_form） ───────── */

  async function selectNode(id: string): Promise<void> {
    const t = getTintin()
    if (!t?.server || !id) return
    const mid = await ensureMachineId()
    if (!mid) return
    try {
      // 缓存未命中兜底：直接向服务端取单条（对齐 _fetch_item_direct）
      const data = await callJson(() => t.server.get(`${base(mid)}/items/${encodeURIComponent(id)}`, {}))
      const item = (data && typeof data === 'object' && 'item' in data ? data.item : data) as ProductItem | null
      if (!item) { formStatus.value = `未找到产品（id=${id}），请稍后重试或先同步。`; return }
      editingId.value = id
      form.value = normalizeItem(item)
      const warehouse = isWarehouseItem(item)
      lockedFields.value = fieldLockMap(warehouse)
      formStatus.value = `正在编辑：${item.brand ?? ''} ${item.model ?? ''}`
        + (warehouse ? '（仓库产品：仅可改 商品名称/品类/备注）' : '')
    } catch (e) {
      formStatus.value = `读取产品失败：${(e as Error)?.message || e}`
    }
  }

  function clearForm(): void {
    editingId.value = null
    form.value = {}
    lockedFields.value = fieldLockMap(false)
    formStatus.value = '新增模式'
  }

  /* ── 保存 / 删除（对齐 _on_save / _on_delete） ───────────────── */

  async function save(): Promise<void> {
    if (saving.value) return
    const check = validateItem(form.value)
    if (!check.ok) { formStatus.value = check.message; return }
    const t = getTintin()
    if (!t?.server) { formStatus.value = '预览环境：无 IPC'; return }
    const mid = await ensureMachineId()
    if (!mid) { formStatus.value = '机器码获取失败'; return }
    saving.value = true
    try {
      const body = normalizeItem(form.value)
      if (editingId.value) {
        const id = editingId.value // 闭包内 .value 收窄失效，先落地常量
        const r = await callJson<{ message?: string }>(() => t.server.put(`${base(mid)}/items/${encodeURIComponent(id)}`, body))
        formStatus.value = String(r?.message ?? '已保存。')
      } else {
        const r = await callJson<{ message?: string; item?: { id?: string | number } }>(() => t.server.post(`${base(mid)}/items`, body))
        const newItem = r?.item
        editingId.value = newItem?.id ? String(newItem.id) : null
        formStatus.value = String(r?.message ?? '已添加。')
      }
      await loadTree()
    } catch (e) {
      formStatus.value = (e as Error)?.message || String(e)
    } finally {
      saving.value = false
    }
  }

  async function remove(): Promise<void> {
    if (!editingId.value) { formStatus.value = '当前为新增模式，无可删除条目。'; return }
    const id = editingId.value // 闭包内 .value 收窄失效，先落地常量
    const t = getTintin()
    if (!t?.server) return
    const mid = await ensureMachineId()
    if (!mid) return
    try {
      await callJson(() => t.server.delete(`${base(mid)}/items/${encodeURIComponent(id)}`, {}))
      formStatus.value = '已删除。'
      clearForm()
      await loadTree()
    } catch (e) {
      formStatus.value = `删除失败：${(e as Error)?.message || e}`
    }
  }

  /* ── 仓库同步（对齐 StockSyncWorker：触发 + 2s 轮询） ────────── */

  let syncTimer: ReturnType<typeof setTimeout> | null = null

  async function startSync(): Promise<void> {
    if (syncing.value) return
    const t = getTintin()
    if (!t?.server) { syncStatus.value = '预览环境：无 IPC'; return }
    const mid = await ensureMachineId()
    if (!mid) { syncStatus.value = '机器码获取失败'; return }
    syncing.value = true
    syncStatus.value = '正在触发服务端 ERP 同步...'
    try {
      await callJson(() => t.server.post(`${base(mid)}/sync`, {}))
      syncStatus.value = '正在等待服务端同步完成...'
      pollSync(mid)
    } catch (e) {
      syncing.value = false
      syncStatus.value = `同步失败：${(e as Error)?.message || e}`
    }
  }

  function pollSync(mid: string): void {
    const t = getTintin()
    syncTimer = setTimeout(async () => {
      try {
        const st = await t.server.get(`${base(mid)}/sync/status`, {})
        const parsed = parseSyncStatus(st === null ? {} : st)
        if (parsed.state === 'running') {
          syncStatus.value = parsed.text
          pollSync(mid)
          return
        }
        syncing.value = false
        syncStatus.value = parsed.state === 'error' ? parsed.text : `${parsed.text}`
        await loadTree()
      } catch (e) {
        syncing.value = false
        syncStatus.value = `同步失败：${(e as Error)?.message || e}`
      }
    }, POLL_MS)
  }

  /* ── 智能挖掘（单条，对齐 SingleMineWorker L118-166） ────────── */

  let mineTimer: ReturnType<typeof setTimeout> | null = null
  let mineDeadline = 0

  async function mineSingle(): Promise<void> {
    if (mining.value) return
    const brand = (form.value.brand || '').trim()
    const model = (form.value.model || '').trim()
    if (!brand || !model) { formStatus.value = '请确保产品“品牌”和“型号/货品名称”已填写！'; return }
    const t = getTintin()
    if (!t?.server) { formStatus.value = '预览环境：无 IPC'; return }
    const mid = await ensureMachineId()
    if (!mid) { formStatus.value = '机器码获取失败'; return }
    // 新增模式 → 先自动保存获得 item_id（挖掘即持久化前提，对齐 L520-533）
    let itemId = editingId.value || ''
    if (!itemId) {
      const check = validateItem(form.value)
      if (!check.ok) { formStatus.value = check.message; return }
      try {
        const r = await callJson<{ item?: { id?: string | number } }>(() => t.server.post(`${base(mid)}/items`, normalizeItem(form.value)))
        itemId = r?.item?.id ? String(r.item.id) : ''
        if (itemId) {
          editingId.value = itemId
          formStatus.value = '已自动保存新产品，正在挖掘...'
          await loadTree()
        }
      } catch { /* 自动保存失败不中断挖掘（原版 L532 同口径） */ }
    }
    mining.value = true
    mineStatus.value = '正在调用服务端 AI 挖掘（挖掘即持久化）...'
    mineDeadline = Date.now() + MINE_TIMEOUT_MS
    try {
      await callJson(() => t.server.post(`${base(mid)}/mine`, { item_ids: [itemId], model: '' }))
      pollMine(mid, itemId)
    } catch (e) {
      mining.value = false
      mineStatus.value = `挖掘失败：${(e as Error)?.message || e}`
    }
  }

  function pollMine(mid: string, itemId: string): void {
    const t = getTintin()
    mineTimer = setTimeout(async () => {
      if (Date.now() > mineDeadline) {
        mining.value = false
        mineStatus.value = '服务端挖掘超时（10 分钟），请稍后在批量挖掘中查看。'
        return
      }
      try {
        const st = await t.server.get(`${base(mid)}/mine/status`, {})
        const parsed = parseMineStatus(st === null ? {} : st)
        if (parsed.state === 'running') {
          mineStatus.value = parsed.text
          pollMine(mid, itemId)
          return
        }
        if (parsed.state === 'error') {
          mining.value = false
          mineStatus.value = parsed.text
          return
        }
        await refillMined(mid, itemId)
      } catch (e) {
        mining.value = false
        mineStatus.value = `挖掘失败：${(e as Error)?.message || e}`
      }
    }, POLL_MS)
  }

  /** 挖掘完成回读单条（小幅重试兼容服务端落库时序，对齐 L146-154） */
  async function refillMined(mid: string, itemId: string): Promise<void> {
    const t = getTintin()
    for (let attempt = 0; attempt < 8; attempt++) {
      const data = await t.server.get(`${base(mid)}/items/${encodeURIComponent(itemId)}`, {})
      const item = (data && typeof data === 'object' && 'item' in data ? data.item : data) as ProductItem | null
      if (item && (String(item.features ?? '').trim() || String(item.selling_points ?? '').trim())) {
        form.value = normalizeItem(item)
        mining.value = false
        mineStatus.value = 'AI 挖掘成功，已自动持久化。'
        return
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    mining.value = false
    mineStatus.value = 'AI 挖掘未返回有效结果，请重试或手动填写。'
  }

  /* ── 全量挖掘（对齐 BulkMineWorker：再点停止） ───────────────── */

  let bulkStop = false

  async function mineAll(): Promise<void> {
    if (bulkMining.value) { bulkStop = true; bulkMining.value = false; mineStatus.value = '已请求停止…'; return }
    const t = getTintin()
    if (!t?.server) { mineStatus.value = '预览环境：无 IPC'; return }
    const mid = await ensureMachineId()
    if (!mid) { mineStatus.value = '机器码获取失败'; return }
    bulkStop = false
    bulkMining.value = true
    mineStatus.value = '正在触发服务端批量挖掘...'
    try {
      await callJson(() => t.server.post(`${base(mid)}/mine`, { item_ids: [], model: '' }))
      pollBulk(mid)
    } catch (e) {
      bulkMining.value = false
      mineStatus.value = `无法连接服务端：${(e as Error)?.message || e}`
    }
  }

  function pollBulk(mid: string): void {
    const t = getTintin()
    mineTimer = setTimeout(async () => {
      if (bulkStop) { mineStatus.value = '已停止。'; return }
      try {
        const st = await t.server.get(`${base(mid)}/mine/status`, {})
        const parsed = parseMineStatus(st === null ? {} : st)
        if (parsed.state === 'running') {
          mineStatus.value = parsed.text
          pollBulk(mid)
          return
        }
        bulkMining.value = false
        if (parsed.state === 'error') { mineStatus.value = parsed.text; return }
        mineStatus.value = `一键挖掘完成：处理 ${parsed.done}/${parsed.total} 条。`
        await loadTree()
      } catch (e) {
        bulkMining.value = false
        mineStatus.value = `一键挖掘出错：${(e as Error)?.message || e}`
      }
    }, POLL_MS)
  }

  /* ── 组件卸载清理（轮询定时器） ──────────────────────────────── */

  onUnmounted(() => {
    if (searchTimer) clearTimeout(searchTimer)
    if (syncTimer) clearTimeout(syncTimer)
    if (mineTimer) clearTimeout(mineTimer)
  })

  /* ── Excel 导入解析（解析纯函数已测；文件读取待 SheetJS 批次） ── */
  void parseImportRows // 保留引用：导入批次直接消费

  return {
    // 树/搜索
    keyword, nodes, searchHits, treeLoading, treeError, loadTree, onKeywordInput,
    // 表单
    form, editingId, lockedFields, formStatus, saving, selectNode, clearForm, save, remove,
    // 同步
    syncing, syncStatus, startSync,
    // 挖掘
    mining, bulkMining, mineStatus, mineSingle, mineAll,
  }
}

export type OpsProductLibrary = ReturnType<typeof useOpsProductLibrary>
