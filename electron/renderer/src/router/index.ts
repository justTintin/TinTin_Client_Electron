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
    path: '/workbench',
    name: 'workbench',
    component: () => import('@/views/Workbench.vue'),
    meta: { tab: 'workbench', title: '工作台' }
  },
  {
    path: '/browser',
    name: 'browser',
    component: () => import('@/views/Browser.vue'),
    meta: { tab: 'browser', title: '浏览器' }
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
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
