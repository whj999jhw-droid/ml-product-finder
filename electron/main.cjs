const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let quitRequested = false; // 仅托盘「退出」时置 true，关窗口不退出进程

// 开发模式：ELECTRON_DEV=true（由 electron:dev 脚本设置）时使用 Vite dev server
const isDev = process.env.ELECTRON_DEV === 'true' || !app.isPackaged;

// 远程服务器地址：桌面版只作为「远程客户端」，与 Web 版共用同一后端和数据库，
// 不在本地启动后端、不存储任何业务数据。
// 优先级：环境变量 ML_SERVER_URL > 同目录 server-url.txt > 默认生产域名。
function getServerUrl() {
  if (process.env.ML_SERVER_URL) {
    return process.env.ML_SERVER_URL.replace(/\/+$/, '');
  }
  try {
    const file = path.join(app.getAppPath(), 'server-url.txt');
    if (fs.existsSync(file)) {
      const u = fs.readFileSync(file, 'utf8').trim().replace(/\/+$/, '');
      if (u) return u;
    }
  } catch { /* ignore */ }
  return 'https://ml.w999w.dpdns.org';
}

// 创建 / 显示主窗口（窗口已存在则只是 show，避免重复创建）
function showWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
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
    // 生产模式：纯远程客户端，加载线上服务器（后端与数据都在服务器，本地不存储）
    mainWindow.loadURL(getServerUrl());
  }

  // 外部链接在系统浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关闭窗口：仅隐藏到托盘，不退出进程。
  // 关键：后端（订单轮询 / 每日定时抓取 / token 续期）与前端同进程运行，
  // 若此处 app.quit() 会让所有定时任务随进程一起停止。改为隐藏窗口，
  // 由托盘菜单的「退出」显式退出，保证关窗口后自动化继续运行。
  mainWindow.on('close', (e) => {
    if (!quitRequested) {
      e.preventDefault();
      mainWindow?.hide();
      return;
    }
    mainWindow = null;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 创建系统托盘：关窗口后进程仍在后台运行，自动化任务（订单轮询等）不中断
function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  if (icon.isEmpty()) {
    // 兜底：内联一个蓝色方块，避免无图标时托盘异常
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR4nO3TMQEAAAgEoNP+nTWFDz6gJJJIIogkgkgiiiCKCCCIIIIIIogggggiiCCCIIIIIggiAE3aBxR0AAAAAElFTkSuQmCC'
    );
  }
  tray = new Tray(icon);
  tray.setToolTip('ML Product Finder（后台运行中）');
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitRequested = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  // 单击托盘图标也能恢复窗口
  tray.on('click', () => showWindow());
}

// Electron 准备就绪
app.whenReady().then(() => {
  if (!isDev) {
    // 生产模式：桌面版作为「远程客户端」，不再本地启动后端。
    // 后端 / 数据库 / 订单轮询 / 每日抓取 / token 续期等全部运行在远程服务器上，
    // 与关不关窗口、退不退桌面程序都无关——数据始终与 Web 版同步。
    process.env.ELECTRON_MODE = 'true';
    setTimeout(() => {
      createTray();
      createWindow();
    }, 800);
  } else {
    setTimeout(() => {
      createTray();
      createWindow();
    }, 2000);
  }

  app.on('activate', () => {
    // macOS 点击 dock 图标 / 其它平台托盘「显示窗口」时恢复
    showWindow();
  });
});

// 所有窗口关闭时【不再自动退出】：后端定时任务需持续运行。
// 仅在托盘菜单「退出」显式 app.quit() 时（quitRequested=true）才真正退出。
app.on('window-all-closed', () => {
  /* 保持进程运行，等待托盘「退出」 */
});

app.on('before-quit', () => {
  quitRequested = true;
});
