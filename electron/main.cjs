const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

// 开发模式：ELECTRON_DEV=true（由 electron:dev 脚本设置）时使用 Vite dev server
const isDev = process.env.ELECTRON_DEV === 'true' || !app.isPackaged;

// 创建主窗口
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ML Product Finder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: false,
  });

  // 窗口准备好后再显示，避免白屏
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // 生产模式：后端（同进程已启动）在 3000 托管前端，直接同源加载
    mainWindow.loadURL('http://localhost:3000');
  }

  // 外部链接在系统浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Electron 准备就绪
app.whenReady().then(() => {
  if (!isDev) {
    // 生产模式：同进程加载后端（dist-server/index.mjs 已自包含依赖）
    const appRoot = path.join(__dirname, '..');

    // 让 server 的 process.cwd()/data 与 __dirname 解析都落在 app 目录
    // （electron-builder 已设 asar:false，resources/app/data 可写）
    try { process.chdir(appRoot); } catch (e) { /* ignore */ }

    const distPath = path.join(appRoot, 'dist');
    process.env.ELECTRON_MODE = 'true';
    process.env.ELECTRON_DIST_PATH = distPath;

    const serverEntry = path.join(appRoot, 'dist-server', 'index.mjs');
    if (fs.existsSync(serverEntry)) {
      // 动态 import() 在 CJS 主进程里加载 ESM 后端包
      import(serverEntry).catch((err) => {
        console.error('[Electron] 后端加载失败:', err);
      });
    } else {
      console.error('[Electron] 未找到后端包:', serverEntry, '请先运行 npm run build:server');
    }

    // 等后端监听 3000 后再显示窗口
    setTimeout(createWindow, 1800);
  } else {
    setTimeout(createWindow, 2000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时退出 (非 macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
