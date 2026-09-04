const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow = null;
let serverProcess = null;

// 判断是否为开发模式
const isDev = process.env.ELECTRON_DEV === 'true' || !app.isPackaged;

// 启动后端服务器
function startServer() {
  if (isDev) {
    // 开发模式下后端由 npm run dev:server 单独启动
    console.log('[Electron] Dev mode: server started by npm run dev:server');
    return;
  }

  // 生产模式下启动打包后的服务器
  const serverPath = path.join(process.resourcesPath, 'server', 'index.js');
  console.log('[Electron] Starting server from:', serverPath);
  
  try {
    serverProcess = spawn('node', [serverPath], {
      stdio: 'pipe',
      env: {
        ...process.env,
        ELECTRON_MODE: 'true',
        NODE_ENV: 'production',
      },
    });

    serverProcess.stdout?.on('data', (data) => {
      console.log(`[Server] ${data}`);
    });

    serverProcess.stderr?.on('data', (data) => {
      console.error(`[Server Error] ${data}`);
    });
  } catch (err) {
    console.error('[Electron] Failed to start server:', err);
  }
}

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
    // 窗口样式
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: false,
  });

  // 窗口准备好后再显示，避免白屏
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 开发模式加载 Vite dev server，生产模式加载打包文件
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // 开发模式自动打开 DevTools
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
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
  startServer();
  
  // 开发模式下等待 Vite 服务器启动
  if (isDev) {
    setTimeout(createWindow, 2000);
  } else {
    // 生产模式下等待后端启动
    setTimeout(createWindow, 1500);
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

// 退出时清理后端进程
app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
