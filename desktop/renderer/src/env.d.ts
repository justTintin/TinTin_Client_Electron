/// <reference types="vite/client" />

/** 构建时间（vite.config.ts define 注入，'YYYY-MM-DD HH:mm'；dev 模式为提示文案） */
declare const __BUILD_TIME__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
