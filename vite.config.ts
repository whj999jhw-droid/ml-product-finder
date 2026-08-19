import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { realpathSync } from 'fs';

// 工作目录可能是 Windows 目录联接（junction），cwd 显示 C: 但真实路径在 D:，
// 导致 vite 用 C: 作 root、rollup 把 index.html 解析成 D: 绝对路径，
// 相对路径计算失败并报 "must be strings that are neither absolute nor relative paths"。
// 统一用 realpath 作 root 消除盘符不一致。
const root = realpathSync(process.cwd());

export default defineConfig({
  root,
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
        // 带 hash 文件名，避免浏览器/CDN 长期缓存旧 bundle，导致前端轮询逻辑不更新
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      }
    }
  }
});
