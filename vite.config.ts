import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  base: '/cam/',
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
        // rewrite: (path) => path.replace(/^\/api/, '') // 去掉前綴
      },
      '/cam1': {
        target: 'https://su.hackdog.tw', // HLS 或其他服務
        changeOrigin: true,
        // rewrite: (path) => path.replace(/^\/cam/, '')
      },
      '/cam2': {
        target: 'https://su.hackdog.tw', // HLS 或其他服務
        changeOrigin: true,
        // rewrite: (path) => path.replace(/^\/cam/, '')
      }
    }
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
})
