// 打包为 Windows 桌面版（.exe）的编排脚本
//
// 关键设计：后端已用 esbuild 打成自包含单文件 dist-server/index.mjs（内联 express 等全部依赖），
// 前端是静态资源 dist，运行时都不需要 node_modules。
//
// 为阻止 electron-builder 把整个 node_modules（数万文件）复制进包，根 package.json 的
// `dependencies` 已置空（运行库全部移到 devDependencies，dev 环境照常安装使用）。
// 这样 electron-builder 读到零生产依赖，便不会复制 node_modules，打包快、安装包小。
import { execSync } from 'node:child_process';

const root = process.cwd();
const nodeBin = 'C:\\Users\\whj87\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node.exe';

function log(...a) { console.log('[build-electron]', ...a); }

// 1) 编译后端为单文件 bundle
log('compiling server -> dist-server/index.mjs');
execSync(`"${nodeBin}" build-server.mjs`, { stdio: 'inherit', cwd: root });

// 2) 构建前端 -> dist
log('building frontend -> dist');
execSync('npx vite build', { stdio: 'inherit', cwd: root });

// 3) 打包（根 package.json 的 dependencies 为空，不会复制 node_modules）
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
