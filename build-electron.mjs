// 打包为 Windows 桌面版（.exe）的编排脚本
//
// 当前 Electron 为「纯远程客户端」：exe 只负责打开一个窗口并加载线上服务器地址，
// 不启动本地后端、不在本地存储业务数据。因此不需要打包 dist-server（后端），也不
// 需要 dist（前端由服务器提供）。
//
// 为阻止 electron-builder 把整个 node_modules（数万文件）复制进包，根 package.json 的
// `dependencies` 已置空（运行库全部移到 devDependencies，dev 环境照常安装使用）。
// 这样 electron-builder 读到零生产依赖，便不会复制 node_modules，打包快、安装包小。
import { execSync } from 'node:child_process';

const root = process.cwd();

function log(...a) { console.log('[build-electron]', ...a); }

// 1) 打包（根 package.json 的 dependencies 为空，不会复制 node_modules）
//    CSC_IDENTITY_AUTO_DISCOVERY=false：跳过代码签名证书自动检测
//    win.signAndEditExecutable=false（在 package.json build 配置里）：跳过 rcedit，
//    避免 electron-builder 下载 winCodeSign 工具包（内含 macOS 符号链接，Windows
//    无管理员权限解压失败）。不影响功能，仅 exe 属性页无自定义图标/版本信息。
log('running electron-builder -> release');
execSync('npx electron-builder', {
  stdio: 'inherit', cwd: root,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
log('DONE');
