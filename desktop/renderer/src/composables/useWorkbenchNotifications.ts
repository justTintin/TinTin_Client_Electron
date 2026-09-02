import { ref, computed } from 'vue'
import { readCfg, writeCfg } from './useSettingsConfig'

/* ── 通知中心（对齐设计稿：侧栏底部“通知中心”入口 + 徽标） ── */
export interface NotifyItem {
  id: string
  title: string
  desc: string
  time: string
  unread: boolean
}

/** electron-store 持久化键（已读通知 ID 集合） */
const STORE_KEY = 'workbench.notifReadIds'

/**
 * 工作台通知域：示例通知 / 未读徽标计数 / 抽屉开关 / 已读标记。
 * 已读状态经 electron-store 持久化（2026-09-02 修复：此前 unread 仅在
 * Vue 响应式内存中，重启后全部恢复为未读，红圈永远不消失）。
 */
export function useWorkbenchNotifications() {
  const notifications = ref<NotifyItem[]>([
    { id: 'n1', title: '脚本流程任务完成', desc: '「JBL CHARGE6 脚本创作」已生成 3 个镜头', time: '09:12', unread: true },
    { id: 'n2', title: '服务器状态变化', desc: '本地推理服务已就绪，可离线使用', time: '08:47', unread: true },
    { id: 'n3', title: '新版本提示', desc: 'V3.0.0 已发布，新增浏览器解析能力', time: '昨天', unread: true }
  ])

  /** 未读数量 */
  const unreadCount = computed(() => notifications.value.filter((n) => n.unread).length)

  /** 通知中心抽屉是否展开 */
  const notificationOpen = ref(false)

  /** 初始化：从 electron-store 加载已读 ID，应用到通知列表 */
  async function loadReadState(): Promise<void> {
    try {
      const raw = await readCfg(STORE_KEY, '[]')
      const ids: string[] = Array.isArray(raw) ? raw : JSON.parse(String(raw || '[]'))
      if (ids.length) {
        const idSet = new Set(ids)
        notifications.value.forEach((n) => { if (idSet.has(n.id)) n.unread = false })
      }
    } catch (_) { /* 解析失败保持默认未读 */ }
  }

  /** 持久化当前已读 ID 列表到 electron-store */
  async function persistReadIds(): Promise<void> {
    const readIds = notifications.value.filter((n) => !n.unread).map((n) => n.id)
    await writeCfg(STORE_KEY, readIds)
  }

  /** 打开通知抽屉；打开时若全部未读，可点“全部已读”清空 */
  function toggleNotifications() {
    notificationOpen.value = !notificationOpen.value
  }

  /* ── 点击遮罩关闭通知抽屉 */
  function closeNotifications() {
    notificationOpen.value = false
  }

  /** 点击单条：标记已读 + 持久化 */
  function markNotifyRead(id: string) {
    const n = notifications.value.find((x) => x.id === id)
    if (n) {
      n.unread = false
      void persistReadIds()
    }
  }

  /** 一键全部已读 + 持久化 */
  function markAllRead() {
    notifications.value.forEach((n) => (n.unread = false))
    void persistReadIds()
  }

  // 启动时加载已读状态
  void loadReadState()

  return {
    notifications,
    unreadCount,
    notificationOpen,
    toggleNotifications,
    closeNotifications,
    markNotifyRead,
    markAllRead
  }
}
