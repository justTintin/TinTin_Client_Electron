// ═══════════════════════════════════════════════════════════════
// 浏览器域独立渲染入口（D1）
// 职责：创建独立 Vue 应用并挂载 Browser.vue（浏览器域容器）。
// 与主应用入口（renderer/src/main.ts）完全解耦：
//   · 不引入 pinia / vue-router / 主应用 store
//   · 只经 tintinBrowser 桥（browser-preload.js）走 IPC
// 加载方式（批次2）：独立 BrowserWindow 加载 dist/browser/index.html
// ═══════════════════════════════════════════════════════════════

import { createApp } from 'vue'

import Browser from '../src/browser/Browser.vue'

// 全局样式：先 tokens 后 global，保证 token 优先级
import '../src/styles/tokens.css'
import '../src/styles/global.css'

/** 应用级主题初始化：读 tintinBrowser.config（electron-store）→ 应用 dark class + glass-mode class。
 *  与主应用 stores/app.initTheme/initVisualStyle 口径一致（system 跟随系统偏好）。 */
async function initTheme(): Promise<void> {
  try {
    const t = (window as any).tintinBrowser
    let mode = 'light'
    let visualStyle = 'standard'
    if (t?.config?.get) {
      const v = await t.config.get('themeMode')
      if (v === 'light' || v === 'dark' || v === 'system') mode = v
      const vs = await t.config.get('visualStyle')
      if (vs === 'standard' || vs === 'glass') visualStyle = vs
    }
    const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    if (dark) document.documentElement.classList.add('dark')
    if (visualStyle === 'glass') document.documentElement.classList.add('glass-mode')
  } catch (_) { /* 主题初始化失败不阻塞挂载 */ }
}

void initTheme()

const app = createApp(Browser)
app.mount('#app')
