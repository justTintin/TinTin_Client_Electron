// ═══════════════════════════════════════════════════════════════
// useBrowserCreators — B10 达人/创作者库域 composable（浏览器域）
// 职责：达人列表加载/新增/删除、主页采集（IPC + 进度订阅）、采集清单
//   编组展示、进入达人主页浏览。
// 纯函数在 logic/creators.ts（filterCreators/groupCollectedItems）。
// 数据源：主进程 creators:* IPC（main/creators-store.js，JSON 文件存储
//   userData/creators/creators.json + collected.json）。
// 跨域约定：进入达人主页需要 nav 域能力，由 Browser.vue 注入回调
//   onOpenHomepage(creator)（切回浏览器模式 + navigate），本模块不
//   直接触碰 BrowserView。
// ═══════════════════════════════════════════════════════════════

import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { filterCreators, groupCollectedItems, platformDisplayName, importResultMessage } from '../logic/creators'
import type { CollectedGroupMode, CollectedItem, CreatorItem } from '../logic/creators'

export interface UseBrowserCreatorsDeps {
  /** 进入达人主页回调（容器注入：切 browseMode='browser' + navigate） */
  onOpenHomepage: (creator: CreatorItem) => void
}

export interface UseBrowserCreatorsReturn {
  creators: Ref<CreatorItem[]>
  collected: Ref<CollectedItem[]>
  loading: Ref<boolean>
  collecting: Ref<boolean>
  collectPhase: Ref<string>
  query: Ref<string>
  groupMode: Ref<CollectedGroupMode>
  filteredCreators: ComputedRef<CreatorItem[]>
  collectedGroups: ComputedRef<{ key: string; items: CollectedItem[] }[]>
  loadCreators: () => Promise<void>
  loadCollected: () => Promise<void>
  addCreator: (creator: CreatorItem) => Promise<boolean>
  deleteCreator: (id: string, platform: string) => Promise<void>
  collectFromCreator: (creator: CreatorItem) => Promise<boolean>
  openCreatorHomepage: (creator: CreatorItem) => void
  platformName: (platform: string) => string
  // B8 素材入库（采集清单 → /material/web_download）
  importing: Ref<boolean>
  importPhase: Ref<string>
  collectedSelected: Ref<Set<string>>
  collectedSelectedCount: ComputedRef<number>
  toggleCollectedSelect: (url: string) => void
  clearCollectedSelection: () => void
  importItems: (items: CollectedItem[]) => Promise<boolean>
  importOne: (item: CollectedItem) => Promise<boolean>
  importSelected: () => Promise<boolean>
}

export function useBrowserCreators(deps: UseBrowserCreatorsDeps): UseBrowserCreatorsReturn {
const { onOpenHomepage } = deps

const creators = ref<CreatorItem[]>([])
const collected = ref<CollectedItem[]>([])
const loading = ref(false)
const collecting = ref(false)
const collectPhase = ref('')
const query = ref('')
const groupMode = ref<CollectedGroupMode>('date')
// B8 素材入库状态（采集清单 → /material/web_download）
const importing = ref(false)
const importPhase = ref('')
const collectedSelected = ref<Set<string>>(new Set())

const filteredCreators = computed(() => filterCreators(creators.value, query.value))
const collectedGroups = computed(() => groupCollectedItems(collected.value, groupMode.value))
const collectedSelectedCount = computed(() => collectedSelected.value.size)

/** 采集进度订阅（creators:collect-progress，返回退订函数） */
function _subscribeProgress(): () => void {
  const t = (window as any).tintinBrowser
  if (!t?.creators?.onCollectProgress) return () => {}
  return t.creators.onCollectProgress((p: any) => {
    if (p && typeof p.phase === 'string') collectPhase.value = p.phase
  })
}

async function loadCreators(): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.creators?.getCreators) return
  loading.value = true
  try {
    const res = await t.creators.getCreators()
    if (res?.success && Array.isArray(res.data)) creators.value = res.data
  } catch (_) { /* 失败保持旧数据 */ }
  loading.value = false
}

async function loadCollected(): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.creators?.getCollected) return
  try {
    const res = await t.creators.getCollected()
    if (res?.success && Array.isArray(res.data)) collected.value = res.data
  } catch (_) { /* 失败保持旧数据 */ }
}

async function addCreator(creator: CreatorItem): Promise<boolean> {
  const t = (window as any).tintinBrowser
  if (!t?.creators?.addCreator) return false
  try {
    const res = await t.creators.addCreator(creator)
    if (res?.success && Array.isArray(res.data)) {
      creators.value = res.data
      return true
    }
    return false
  } catch (_) { return false }
}

async function deleteCreator(id: string, platform: string): Promise<void> {
  const t = (window as any).tintinBrowser
  if (!t?.creators?.deleteCreator) return
  try {
    const res = await t.creators.deleteCreator({ id, platform })
    if (res?.success && Array.isArray(res.data)) creators.value = res.data
  } catch (_) {}
}

/** 达人主页全量采集（主进程隐藏 BrowserView 自动滚动；对照原 collectAllFromCreator） */
async function collectFromCreator(creator: CreatorItem): Promise<boolean> {
  const t = (window as any).tintinBrowser
  if (!t?.creators?.collectFromCreator) return false
  if (collecting.value) return false
  collecting.value = true
  collectPhase.value = ''
  const unsub = _subscribeProgress()
  try {
    const res = await t.creators.collectFromCreator({ creator })
    if (res?.success && res.data && typeof res.data.count === 'number') {
      collectPhase.value = `采集完成，共 ${res.data.count} 条（已写入本地采集清单）`
      await loadCollected()
      return true
    }
    collectPhase.value = String(res?.error || '采集失败')
    return false
  } catch (e) {
    collectPhase.value = String((e as Error)?.message || e)
    return false
  } finally {
    collecting.value = false
    try { unsub() } catch (_) {}
  }
}

/** 进入达人主页浏览（转发容器：切浏览器模式 + 导航） */
function openCreatorHomepage(creator: CreatorItem): void {
  onOpenHomepage(creator)
}

function platformName(platform: string): string {
  return platformDisplayName(platform)
}

// ── B8 素材入库（采集清单 → material:import → /material/web_download）──

function toggleCollectedSelect(url: string): void {
  const s = collectedSelected.value
  if (s.has(url)) s.delete(url)
  else s.add(url)
  collectedSelected.value = new Set(s)
}

function clearCollectedSelection(): void {
  collectedSelected.value = new Set()
}

/** 提交入库（IPC 转发 + 结果提示 + 采集清单刷新；失败原因透出） */
async function importItems(items: CollectedItem[]): Promise<boolean> {
  const t = (window as any).tintinBrowser
  if (!t?.materialImport?.import) return false
  if (importing.value || items.length === 0) return false
  importing.value = true
  importPhase.value = '正在提交入库…'
  try {
    const res = await t.materialImport.import({
      items,
      opts: { shareName: 'web_download', enqueueAnalysis: false },
    })
    if (res?.success && res.data) {
      importPhase.value = `入库完成：${importResultMessage(res.data)}`
      await loadCollected()
      return true
    }
    importPhase.value = String(res?.error || '入库失败')
    return false
  } catch (e) {
    importPhase.value = String((e as Error)?.message || e)
    return false
  } finally {
    importing.value = false
  }
}

/** 行级入库（单条） */
async function importOne(item: CollectedItem): Promise<boolean> {
  return importItems([item])
}

/** 勾选批量入库（成功后清空勾选） */
async function importSelected(): Promise<boolean> {
  const items = collected.value.filter((it) => collectedSelected.value.has(it.url))
  const ok = await importItems(items)
  if (ok) clearCollectedSelection()
  return ok
}

return {
  creators, collected, loading, collecting, collectPhase, query, groupMode,
  filteredCreators, collectedGroups,
  loadCreators, loadCollected, addCreator, deleteCreator,
  collectFromCreator, openCreatorHomepage, platformName,
  importing, importPhase, collectedSelected, collectedSelectedCount,
  toggleCollectedSelect, clearCollectedSelection,
  importItems, importOne, importSelected,
}
}
