<script setup lang="ts">
// FavoritesView — 收藏记录视图展示组件
// 模板与样式来源：views/Browser.vue 原 template L1503-1565 +
// style .favorites-*/.favorite-*/.empty-* 区段（类名/结构不变）
import type { FavoriteItem } from '../composables/useBrowserFavorites'

defineProps<{
  /** 收藏列表 */
  favorites: FavoriteItem[]
  /** 收藏数（标题徽标） */
  favoritesCount: number
}>()

defineEmits<{
  (e: 'navigate', item: FavoriteItem): void
  (e: 'remove', url: string, event?: Event): void
}>()
</script>

<template>
  <div class="favorites-view-area">
    <div class="favorites-header">
      <div class="favorites-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
        <span>网页收藏</span>
        <span class="favorites-count">{{ favoritesCount }}</span>
      </div>
    </div>
    <div v-if="favorites.length > 0" class="favorites-list">
      <div
        v-for="item in favorites"
        :key="item.url"
        class="favorite-card"
        @click="$emit('navigate', item)"
      >
        <div class="favorite-icon" :class="item.type">
          <svg v-if="item.type === 'video'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          <svg v-else-if="item.type === 'audio'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </div>
        <div class="favorite-info">
          <div class="favorite-name" :title="item.name">{{ item.name }}</div>
          <div class="favorite-meta">
            <span class="favorite-url" :title="item.url">{{ item.url }}</span>
          </div>
          <div class="favorite-time">
            <span>{{ new Date(item.addedAt).toLocaleString() }}</span>
          </div>
        </div>
        <button
          class="favorite-delete-btn"
          title="取消收藏"
          @click="$emit('remove', item.url, $event)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
    <div v-else class="favorites-empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
      <div class="empty-title">暂无网页收藏</div>
      <div class="empty-sub">这里保存的是你收藏的网页 URL：在浏览器中打开页面后，点击工具栏「收藏」按钮即可加入；素材入库请走侧栏「素材采集」</div>
    </div>
  </div>
</template>

<style scoped>
/* ─── 收藏记录视图 ─── */
.favorites-view-area {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--background);
}

.favorites-header {
  flex: 0 0 auto;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.favorites-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.favorites-title svg {
  color: var(--primary);
}

.favorites-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
}

.favorites-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.favorite-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all var(--duration-fast);
}

.favorite-card:hover {
  background: var(--surface-container);
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--ring);
}

.favorite-icon {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-container);
  border-radius: var(--radius-md);
  color: var(--muted-foreground);
}

.favorite-icon.video {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.favorite-icon.audio {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.1);
}

.favorite-icon.image {
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.1);
}

.favorite-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.favorite-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.favorite-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.favorite-url {
  font-size: 12px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

.favorite-time {
  font-size: 11px;
  color: var(--muted-foreground);
  opacity: 0.8;
}

.favorite-delete-btn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--muted-foreground);
  transition: all var(--duration-fast);
}

.favorite-delete-btn:hover {
  background: var(--error);
  color: white;
}

.favorites-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  color: var(--muted-foreground);
}

.favorites-empty svg {
  opacity: 0.4;
}

.empty-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--foreground);
}

.empty-sub {
  font-size: 13px;
  text-align: center;
  max-width: 280px;
  line-height: 1.5;
}

.favorites-list::-webkit-scrollbar { width: 6px; }
.favorites-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.favorites-list::-webkit-scrollbar-track { background: transparent; }
</style>
