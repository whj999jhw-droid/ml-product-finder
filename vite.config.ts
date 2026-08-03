import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  // Electron 兼容: 使用相对路径
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      }
    }
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // 跳过清空 dist：WorkBuddy 沙箱的安全删除封装会拦截 vite 的 fs.rmSync(dist)，
    // 导致构建中断。设 false 后 vite 直接覆盖写入，由 .gitignore/手动清理管理旧文件。
    emptyOutDir: false,
    // Electron 兼容
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      }
    }
  }
});
