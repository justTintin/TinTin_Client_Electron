import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

/**
 * 构建时间注入（Settings「关于」卡展示，含时分以便区分同日多次出包）：
 *  - vite build（command==='build'）→ 本地时间 'YYYY-MM-DD HH:mm'；
 *    可用 TINTIN_BUILD_TIME 环境变量覆盖（打包程序注入，保持与产物目录名一致）
 *  - vite dev（command==='serve'）→ 提示文案（开发模式无构建语义）
 */
function resolveBuildTime(command: string): string {
  if (command !== 'build') return '开发模式（未构建）'
  if (process.env.TINTIN_BUILD_TIME) return process.env.TINTIN_BUILD_TIME
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default defineConfig(({ command }) => ({
  define: {
    __BUILD_TIME__: JSON.stringify(resolveBuildTime(command))
  },
  plugins: [
    vue({
      // Electron <webview> 是非标准自定义元素，告知 Vue 编译器原样渲染
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'webview'
        }
      }
    })
  ],
  root: path.resolve(__dirname, '.'),
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@stores': path.resolve(__dirname, 'src/stores'),
      '@views': path.resolve(__dirname, 'src/views'),
      '@styles': path.resolve(__dirname, 'src/styles')
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    // 开发环境代理：/api 下的请求直接转发到外部 AI 服务，
    // 让浏览器直连模式（无 Electron 壳）也能走通 materialList/materialOcr/montageSplit，
    // 不依赖 CORS 头；生产 / Electron 环境仍由 server-proxy.js 代理。
    proxy: {
      '/dev-api': {
        target: 'http://192.168.111.31:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/dev-api/, '')
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome124',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: {
        // 主应用入口（工作台/媒体工具/设置）
        main: path.resolve(__dirname, 'index.html'),
        // 浏览器域独立渲染入口（独立 BrowserWindow + 独立 preload，
        // 批次1：浏览器域与主应用物理解耦；构建产物 dist/browser/）
        browser: path.resolve(__dirname, 'browser/index.html')
      },
      output: {
        manualChunks: {
          vue: ['vue', 'vue-router', 'pinia']
        }
      }
    }
  }
}))
