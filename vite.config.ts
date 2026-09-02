import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

const streamProxyTarget = process.env.CAM_STREAM_PROXY_TARGET ?? 'http://127.0.0.1:3000'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    vue(),
    vueDevTools(),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',  // 轉發到後端 API
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '') // 去掉前綴
      },
      '/cam1': {
        target: streamProxyTarget,
        changeOrigin: true,
      },
      '/cam2': {
        target: streamProxyTarget,
        changeOrigin: true,
      }
    }
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
})
