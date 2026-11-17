import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 构建产物直接落到 Django 的静态目录，由 `console/vite.py` 读 manifest 引用。
 *
 * 开发时走 `npm run dev`（5173），API 和 WebSocket 都代理到 Django，
 * 页面和接口同源，不用改任何 URL。Django 换端口就改下面这个常量。
 */
const DJANGO_ORIGIN = 'http://127.0.0.1:8010'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../static/dist',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: './src/main.tsx',
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': DJANGO_ORIGIN,
      '/ws': { target: DJANGO_ORIGIN.replace(/^http/, 'ws'), ws: true },
    },
  },
})
