import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const root = path.dirname(fileURLToPath(import.meta.url));

// 清理 server 下的旧编译产物（.js/.d.ts/.map）。
// server 源全是 .ts，这些 .js 是历史产物；若不清理，esbuild 会优先精确匹配
// `./xxx.js` 而非 `./xxx.ts` 源，导致导出不匹配（如 ensureValidToken/initAutoRenew）。
for (const pat of [
  'server/**/*.js',
  'server/**/*.d.ts',
  'server/**/*.js.map',
  'server/**/*.d.ts.map',
]) {
  for (const f of globSync(pat, { cwd: root })) {
    try { fs.rmSync(path.join(root, f), { force: true }); } catch { /* ignore */ }
  }
}

await build({
  entryPoints: [path.join(root, 'server', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: path.join(root, 'dist-server', 'index.mjs'),
  // better-sqlite3 原生模块桌面版不捆绑，运行时缺失会优雅降级；electron 仅主进程用
  external: ['better-sqlite3', 'electron'],
  // ESM 输出内联了 CJS 依赖（express 等），用 createRequire 让其中的 require() 正常工作
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
  sourcemap: false,
  splitting: false,
});

console.log('[build-server] server compiled -> dist-server/index.mjs');
