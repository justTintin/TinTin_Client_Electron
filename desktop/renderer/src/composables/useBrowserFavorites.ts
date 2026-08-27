// ═══════════════════════════════════════════════════════════════
// useBrowserFavorites — Browser.vue 收藏域 composable
// 来源：views/Browser.vue 原 script setup L392-479 整体搬移（行为不变）。
// 职责：收藏列表加载/增删、当前页收藏态、一键收藏当前页、从收藏跳回浏览器。
//
// 跨域接线约定：依赖 nav 域的 addressUrl / activeNavId / activePlatformName /
//   browseMode，全部由 Browser.vue 容器创建 useBrowserNav 后以参数显式传入，
//   不引入任何全局单例。
// ═══════════════════════════════════════════════════════════════

import { computed, nextTick, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

export interface UseBrowserFavoritesDeps {
  /** 地址栏 URL（nav 域状态） */
  addressUrl: Ref<string>
  /** 当前激活导航项 ID（nav 域状态） */
  activeNavId: Ref<string>
  /** 当前平台名（nav 域计算属性） */
  activePlatformName: ComputedRef<string>
  /** 浏览/收藏 模式（nav 域状态） */
  browseMode: Ref<'browser' | 'favorites'>
}

export interface UseBrowserFavoritesReturn {
  favorites: Ref<FavoriteItem[]>
  favoritesCount: ComputedRef<number>
  currentPageFavorited: ComputedRef<boolean>
  loadFavorites: () => Promise<void>
  addToFavorites: (item: FavoriteItem) => Promise<void>
  removeFromFavorites: (url: string) => Promise<void>
  collectCurrentPage: () => Promise<void>
  navigateToFavorite: (item: FavoriteItem) => Promise<void>
  removeFavoriteItem: (url: string, event?: Event) => Promise<void>
}

export interface FavoriteItem {
  url: string
  name: string
  type: 'video' | 'audio' | 'image'
  size?: number
  sizeText?: string
  platformId?: string
  addedAt: number
  updatedAt?: number
  audioUrl?: string
}

export function useBrowserFavorites(deps: UseBrowserFavoritesDeps): UseBrowserFavoritesReturn {
const { addressUrl, activeNavId, activePlatformName, browseMode } = deps

const favorites = ref<FavoriteItem[]>([])
const favoritesCount = computed(() => favorites.value.length)
const currentPageFavorited = computed(() => {
  const url = addressUrl.value
  return url ? favorites.value.some(f => f.url === url) : false
})

async function loadFavorites(): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  try {
    const res = await t.mediaStorage.getFavorites()
    if (res?.data && Array.isArray(res.data)) {
      favorites.value = res.data
    }
  } catch (_) {}
}

async function addToFavorites(item: FavoriteItem): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  try {
    const res = await t.mediaStorage.addFavorite(item)
    if (res?.data && Array.isArray(res.data)) {
      favorites.value = res.data
    }
  } catch (_) {}
}

async function removeFromFavorites(url: string): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  try {
    const res = await t.mediaStorage.removeFavorite(url)
    if (res?.data && Array.isArray(res.data)) {
      favorites.value = res.data
    }
  } catch (_) {}
}

async function collectCurrentPage(): Promise<void> {
  const t = (window as any).tintin
  if (!t?.mediaStorage) return
  const url = addressUrl.value
  if (!url) return
  const item: FavoriteItem = {
    url,
    name: activePlatformName.value || url,
    type: 'video',
    platformId: activeNavId.value || undefined,
    addedAt: Date.now(),
  }
  await addToFavorites(item)
}

async function navigateToFavorite(item: FavoriteItem): Promise<void> {
  const t = (window as any).tintin
  if (!t?.browser?.navigate) return
  const platformId = item.platformId || activeNavId.value
  if (!platformId) return
  // 切回浏览器模式
  browseMode.value = 'browser'
  // 等模式切换完成后导航
  await nextTick()
  try {
    await t.browser.navigate({ platformId, url: item.url })
  } catch (_) {}
}

async function removeFavoriteItem(url: string, event?: Event): Promise<void> {
  if (event) {
    event.stopPropagation()
    event.preventDefault()
  }
  await removeFromFavorites(url)
}

return {
  favorites, favoritesCount, currentPageFavorited,
  loadFavorites, addToFavorites, removeFromFavorites,
  collectCurrentPage, navigateToFavorite, removeFavoriteItem,
}
}
