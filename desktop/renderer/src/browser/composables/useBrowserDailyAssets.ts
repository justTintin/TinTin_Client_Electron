// ═══════════════════════════════════════════════════════════════
// useBrowserDailyAssets — B9 每日素材域 composable（浏览器域）
// 职责：每日素材加载/四维筛选/勾选/文件定位打开。
// 纯函数在 logic/dailyAssets.ts（filterDailyAssets/formatBytes/
//   buildMaterialPreviewType），本模块只做状态编排与 IPC 转发。
// 数据源：主进程 browser:getDailyAssets（main/daily-assets.js，按日期
//   扫描 media-downloader 下载目录），与 B3 下载目录同源打通。
// IPC：window.tintinBrowser.browser.getDailyAssets / revealFile /
//   openFilePath（browser-preload.js 白名单收口）
// ═══════════════════════════════════════════════════════════════

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import {
  filterDailyAssets,
  formatBytes,
  buildMaterialPreviewType,
} from '../logic/dailyAssets'
import type {
  DailyAssetFile,
  DailyAssetGroup,
  MaterialPreviewType,
} from '../logic/dailyAssets'

export interface UseBrowserDailyAssetsReturn {
  groups: Ref<DailyAssetGroup[]>
  loading: Ref<boolean>
  filterDate: Ref<string>
  filterType: Ref<string>
  filterQuery: Ref<string>
  filterSort: Ref<string>
  filteredGroups: ComputedRef<DailyAssetGroup[]>
  dates: ComputedRef<string[]>
  totalCount: ComputedRef<number>
  selectedPaths: Ref<Set<string>>
  selectedCount: ComputedRef<number>
  loadDailyAssets: () => Promise<void>
  setDate: (v: string) => void
  setType: (v: string) => void
  setQuery: (v: string) => void
  setSort: (v: string) => void
  toggleSelect: (path: string) => void
  clearSelection: () => void
  /** 单击卡片：文件定位（对照原版 openFileFolder） */
  revealFile: (path: string) => Promise<void>
  /** 双击卡片：打开文件（对照原版 openPath） */
  openFile: (path: string) => Promise<void>
  formatBytes: (b?: number | null) => string
  previewType: (file: DailyAssetFile, groupFiles: DailyAssetFile[] | null | undefined) => MaterialPreviewType
  // B8 素材入库（勾选 → material:import → /material/web_download）
  importing: Ref<boolean>
  importPhase: Ref<string>
  importSelected: () => Promise<void>
}

export function useBrowserDailyAssets(): UseBrowserDailyAssetsReturn {
const groups = ref<DailyAssetGroup[]>([])
const loading = ref(false)
const filterDate = ref('all')
const filterType = ref('all')
const filterQuery = ref('')
const filterSort = ref('date_desc')
const selectedPaths = ref<Set<string>>(new Set())
// B8 素材入库状态（勾选 → material:import）
const importing = ref(false)
const importPhase = ref('')

const filteredGroups = computed(() =>
  filterDailyAssets(groups.value, {
    date: filterDate.value,
    type: filterType.value,
    query: filterQuery.value,
    sort: filterSort.value,
  })
)
const dates = computed(() => groups.value.map((g) => g.date).filter(Boolean))
const totalCount = computed(() => groups.value.reduce((n, g) => n + (g.files || []).length, 0))
const selectedCount = computed(() => selectedPaths.value.size)

async function loadDailyAssets(): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.browser?.getDailyAssets) return
  loading.value = true
  try {
    const res = await t.browser.getDailyAssets()
    if (res?.success && Array.isArray(res.data)) {
      groups.value = res.data
    }
  } catch (_) { /* 失败保持旧数据，不阻塞浏览 */ }
  loading.value = false
}

function setDate(v: string): void { filterDate.value = v }
function setType(v: string): void { filterType.value = v }
function setQuery(v: string): void { filterQuery.value = v }
function setSort(v: string): void { filterSort.value = v }

function toggleSelect(path: string): void {
  const s = selectedPaths.value
  if (s.has(path)) s.delete(path)
  else s.add(path)
  // Set 原地变更不触发响应式 → 重建引用
  selectedPaths.value = new Set(s)
}
function clearSelection(): void {
  selectedPaths.value = new Set()
}

/** 单击定位文件（对照原版 app.js L2409-2412 openFileFolder） */
async function revealFile(path: string): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.browser?.revealFile) return
  try { await t.browser.revealFile(path) } catch (_) {}
}

/** 双击打开文件（对照原版 app.js L2414-2417 openPath） */
async function openFile(path: string): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.browser?.openFilePath) return
  try { await t.browser.openFilePath(path) } catch (_) {}
}

/** B8 勾选条目入库（本地文件由主进程反查下载历史补来源 url；无 url 归 noUrl 提示） */
async function importSelected(): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.materialImport?.import) return
  const items: Array<Record<string, any>> = []
  for (const g of groups.value) {
    for (const f of (g.files || [])) {
      if (selectedPaths.value.has(f.path)) {
        items.push({ name: f.name, path: f.path, size: f.size, type: f.type, title: f.name, platform: 'local' })
      }
    }
  }
  if (items.length === 0 || importing.value) return
  importing.value = true
  importPhase.value = '正在提交入库…'
  try {
    const res = await t.materialImport.import({
      items,
      opts: { shareName: 'web_download', enqueueAnalysis: false },
    })
    if (res?.success && res.data) {
      const parts: string[] = [`已提交 ${res.data.submitted} 条`]
      if (Number(res.data.failed) > 0) parts.push(`失败 ${res.data.failed} 条`)
      if (Number(res.data.noUrl) > 0) parts.push(`无来源链接 ${res.data.noUrl} 条`)
      importPhase.value = `入库完成：${parts.join('，')}`
      if (Number(res.data.submitted) > 0 || Number(res.data.noUrl) > 0) clearSelection()
    } else {
      importPhase.value = String(res?.error || '入库失败')
    }
  } catch (e) {
    importPhase.value = String((e as Error)?.message || e)
  } finally {
    importing.value = false
  }
}

return {
  groups, loading, filterDate, filterType, filterQuery, filterSort,
  filteredGroups, dates, totalCount, selectedPaths, selectedCount,
  loadDailyAssets, setDate, setType, setQuery, setSort,
  toggleSelect, clearSelection, revealFile, openFile,
  formatBytes, previewType: buildMaterialPreviewType,
  importing, importPhase, importSelected,
}
}
