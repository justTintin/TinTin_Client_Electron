// ═══════════════════════════════════════════════════════════════
// 路由配置
// 使用 hash 模式（Electron 文件协议下兼容性最好）
// 三 Tab 对应三条懒加载路由
// ═══════════════════════════════════════════════════════════════

import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/workbench'
  },
  {
    // 工作台（聊天会话形态）：定时任务以侧栏入口+抽屉组件进入（P1 微调，框架不动）
    path: '/workbench',
    name: 'workbench',
    component: () => import('@/views/Workbench.vue'),
    meta: { tab: 'workbench', title: '工作台' }
  },
  {
    // 运营工具（落地文档 2026-08-30：产品库/企业知识库/视频打分预估/视频营销选题）
    path: '/ops-tools',
    name: 'ops-tools',
    component: () => import('@/views/OpsTools.vue'),
    meta: { tab: 'ops-tools', title: '运营工具' }
  },
  {
    path: '/media-tools',
    name: 'media-tools',
    component: () => import('@/views/MediaTools.vue'),
    meta: { tab: 'media-tools', title: '媒体工具' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/Settings.vue'),
    meta: { tab: 'settings', title: '系统设置' }
  },
  {
    path: '/montage',
    name: 'montage',
    component: () => import('@/components/media-tools/VideoMontage.vue'),
    meta: { tab: 'montage', title: '智能混剪' }
  },
  {
    path: '/live-clip',
    name: 'live-clip',
    component: () => import('@/components/media-tools/LiveClip.vue'),
    meta: { tab: 'live-clip', title: '直播切片' }
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
