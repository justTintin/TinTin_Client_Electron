// ═══════════════════════════════════════════════════════════════
// TinTin V3 渲染进程入口
// 职责：创建 Vue 应用、装载 Pinia 与路由、挂载到 #app
// ═══════════════════════════════════════════════════════════════

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'

// 全局样式：先 tokens 后 global，保证 token 优先级
import './styles/tokens.css'
import './styles/global.css'

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
app.use(router)

// 应用级初始化：在 mount 之前应用主题 → 避免首帧闪烁
import { useAppStore } from './stores/app'
const appStore = useAppStore(pinia)
appStore.initTheme()

app.mount('#app')
