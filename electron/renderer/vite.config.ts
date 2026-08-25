import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
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
        main: path.resolve(__dirname, 'index.html')
      },
      output: {
        manualChunks: {
          vue: ['vue', 'vue-router', 'pinia']
        }
      }
    }
  }
})
