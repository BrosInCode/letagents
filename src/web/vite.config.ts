import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { rename } from 'fs/promises'

// Plugin to rename index.vue.html → index.html in dist
function renameHtmlPlugin() {
  return {
    name: 'rename-html',
    closeBundle: async () => {
      const distDir = resolve(__dirname, 'dist')
      try {
        await rename(
          resolve(distDir, 'index.vue.html'),
          resolve(distDir, 'index.html')
        )
      } catch {
        // already renamed or doesn't exist
      }
    },
  }
}

export default defineConfig({
  plugins: [vue(), renameHtmlPlugin()],
  root: resolve(__dirname),
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.vue.html'),
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/auth': 'http://localhost:3001',
      '/in': 'http://localhost:3001',
    },
  },
})
