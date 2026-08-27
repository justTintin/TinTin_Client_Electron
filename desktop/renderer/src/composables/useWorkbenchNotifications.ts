import { ref, computed } from 'vue'

/* ── 通知中心（对齐设计稿：侧栏底部“通知中心”入口 + 徽标） ── */
export interface NotifyItem {
  id: string
  title: string
  desc: string
  time: string
  unread: boolean
}

/**
 * 工作台通知域：示例通知 / 未读徽标计数 / 抽屉开关 / 已读标记。
 * 经核对原实现：通知抽屉与任务队列抽屉之间没有任何联动逻辑
 * （toggleNotifications 仅翻转自身开关），故本 composable 无需外部依赖。
 */
export function useWorkbenchNotifications() {
  const notifications = ref<NotifyItem[]>([
    { id: 'n1', title: '脚本流程任务完成', desc: '「JBL CHARGE6 脚本创作」已生成 3 个镜头', time: '09:12', unread: true },
    { id: 'n2', title: '服务器状态变化', desc: '本地推理服务已就绪，可离线使用', time: '08:47', unread: true },
    { id: 'n3', title: '新版本提示', desc: 'V3.0.0 已发布，新增浏览器解析能力', time: '昨天', unread: true }
  ])

  /** 未读数量（设计稿徽标显示 3） */
  const unreadCount = computed(() => notifications.value.filter((n) => n.unread).length)

  /** 通知中心抽屉是否展开 */
  const notificationOpen = ref(false)

  /** 打开通知抽屉；打开时若全部未读，可点“全部已读”清空 */
  function toggleNotifications() {
    notificationOpen.value = !notificationOpen.value
  }

  /* ── 点击遮罩关闭通知抽屉 */
  function closeNotifications() {
    notificationOpen.value = false
  }

  /** 点击单条：标记已读 */
  function markNotifyRead(id: string) {
    const n = notifications.value.find((x) => x.id === id)
    if (n) n.unread = false
  }

  /** 一键全部已读 */
  function markAllRead() {
    notifications.value.forEach((n) => (n.unread = false))
  }

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
