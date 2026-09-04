const { contextBridge } = require('electron');

// 通过 contextBridge 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  version: process.versions.electron,
});

// 窗口加载完成后通知
window.addEventListener('DOMContentLoaded', () => {
  console.log('[Electron] Preload script loaded');
});
