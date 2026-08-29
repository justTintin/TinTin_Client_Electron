// ═══════════════════════════════════════════════════════════════
// useWorkbenchPickers — 工作台输入区·产品/素材/脚本选择弹窗搜索域
// 服务端契约（openapi-latest.json 已核实，响应为自由格式 → pickListItems
// 容错解析 {items}|{data}|{results}|裸数组）：
//   · GET  /api/product-library/search?q=&limit=   产品（品类/品牌/型号）
//   · POST /material/search {query,limit} / 空关键字 GET /material/list
//                                                  素材（文件名/品牌/型号）
//   · GET  /api/storyboard/scripts?topic=&page=    分镜脚本库（主题）
// HTTP 全部经主进程通用 server:get/post IPC（离线 null / 5xx 抛错），本层
// 只做调用编排与异常文案映射（searchErrorText），组件零 URL 拼装（IRON-06）。
// 异常分支（spec）：网络失败/5xx/空结果 均有提示。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import { getTintin } from './useSettingsConfig'
import { pickListItems, searchErrorText } from './workbenchChatContext'

export type PickerItem = Record<string, unknown>

/** 单次搜索调用的统一封装：离线/5xx/{error} → Error(用户可读文案) */
async function fetchJsonList(call: () => Promise<unknown>): Promise<PickerItem[]> {
  let data: unknown
  try {
    data = await call()
  } catch (e) {
    throw new Error(searchErrorText(e))
  }
  if (data === null || data === undefined) {
    throw new Error(searchErrorText(null)) // 离线静默 null
  }
  if (typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
    const msg = String((data as Record<string, unknown>).error || '')
    if (msg) throw new Error(searchErrorText(new Error(msg)))
  }
  return pickListItems(data)
}

/* ── 三个弹窗的搜索 fetcher（组件只消费，不感知 URL） ───────── */

/** 产品搜索：GET /api/product-library/search?q=&limit=200 */
export async function fetchProducts(kw: string): Promise<PickerItem[]> {
  const t = getTintin()
  if (!t?.server) throw new Error(searchErrorText(null))
  return fetchJsonList(() => t.server.get('/api/product-library/search', { q: kw, limit: 200 }))
}

/** 素材检索：有关键词 POST /material/search（语义），否则 GET /material/list 浏览 */
export async function fetchMaterials(kw: string): Promise<PickerItem[]> {
  const t = getTintin()
  if (!t?.server) throw new Error(searchErrorText(null))
  const q = String(kw || '').trim()
  return fetchJsonList(() =>
    q
      ? t.server.post('/material/search', { query: q, limit: 100 })
      : t.server.get('/material/list', { page: 1, size: 100 })
  )
}

/** 脚本列表：GET /api/storyboard/scripts?topic=&page=1&page_size=100 */
export async function fetchScripts(kw: string): Promise<PickerItem[]> {
  const t = getTintin()
  if (!t?.server) throw new Error(searchErrorText(null))
  return fetchJsonList(() =>
    t.server.get('/api/storyboard/scripts', { topic: String(kw || '').trim(), page: 1, page_size: 100 })
  )
}

/* ── 搜索状态工厂（弹窗组件内消费；状态即 UI 三态数据） ─────── */

export function usePickerSearch(fetcher: (kw: string) => Promise<PickerItem[]>) {
  const kw = ref('')
  const items = ref<PickerItem[]>([])
  const loading = ref(false)
  const error = ref('')
  /** 是否已完成至少一次搜索（区分「未搜索」与「空结果」两种空态） */
  const searched = ref(false)

  async function run() {
    loading.value = true
    error.value = ''
    try {
      items.value = await fetcher(kw.value)
    } catch (e) {
      items.value = []
      error.value = (e as Error)?.message || String(e)
    } finally {
      loading.value = false
      searched.value = true
    }
  }

  /** 弹窗每次打开时重置（原版弹窗每次 exec 都重新加载） */
  function reset() {
    kw.value = ''
    items.value = []
    error.value = ''
    searched.value = false
  }

  return { kw, items, loading, error, searched, run, reset }
}
