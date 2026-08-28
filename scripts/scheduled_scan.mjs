// 凌晨定时任务：跑「定制新品提前布局」扫描（runCustomNewScan）
// 通过本地 HTTP 接口触发（复用服务器已加载的 LLM 配置 / 1688 AK / DB），
// 不重复 import 业务代码，避免 ESM/tsx 路径问题。
//
// 用法（cron 示例，每天 03:17 跑）：
//   17 3 * * * cd /home/ubuntu/ml-product-finder && /usr/bin/node scripts/scheduled_scan.mjs >> data/scheduled_scan.log 2>&1
//
// 可选环境变量：
//   SCAN_SITES=MLM,MLB,MLC,MCO   要扫描的站点（逗号分隔）
//   SCAN_MAX_PER_KEYWORD=8       每个种子词最多取多少货源
//   API_BASE=http://127.0.0.1:3000
//   SCAN_TIMEOUT_MS=900000       单个站点最长等待（默认 15 分钟）
//   LOCK_FILE=/home/ubuntu/ml-product-finder/data/.scheduled_scan.lock

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const SITES = (process.env.SCAN_SITES || 'MLM,MLB,MLC,MCO').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PER_KEYWORD = parseInt(process.env.SCAN_MAX_PER_KEYWORD || '8', 10);
const TIMEOUT_MS = parseInt(process.env.SCAN_TIMEOUT_MS || '900000', 10);
const RETRY_ON_EMPTY = parseInt(process.env.SCAN_RETRY_ON_EMPTY || '1', 10); // 整站点 0 命中（多为 429 限流）时重试次数
const RETRY_GAP_MS = parseInt(process.env.SCAN_RETRY_GAP_MS || '180000', 10); // 重试间隔（默认 3 分钟，错开限流窗口）
const LOCK_FILE = process.env.LOCK_FILE || path.join(ROOT, 'data', '.scheduled_scan.lock');

const log = (...args) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
};

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json };
}

async function getJSON(url) {
  const res = await fetch(url);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

async function runSiteOnce(site) {
  log(`▶ 启动 ${site} 定制新品扫描 (maxPerKeyword=${MAX_PER_KEYWORD})`);
  const { status, json } = await postJSON(`${API_BASE}/api/ml/sourcing/run`, {
    mode: 'custom-new',
    site,
    maxPerKeyword: MAX_PER_KEYWORD,
  });
  if (status !== 200 || !json || !json.runId) {
    log(`✗ ${site} 触发失败 HTTP=${status} body=${JSON.stringify(json).slice(0, 200)}`);
    return null;
  }
  const runId = json.runId;
  log(`  runId=${runId}，开始轮询状态…`);

  const start = Date.now();
  let lastMsg = '';
  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 10000));
    const data = await getJSON(`${API_BASE}/api/ml/sourcing/runs/${runId}`);
    const run = data && data.run;
    if (!run) continue;
    if (run.message && run.message !== lastMsg) {
      lastMsg = run.message;
      log(`  ${site} 进度: status=${run.status} scanned=${run.total_scanned} approved=${run.total_approved} msg=${run.message}`);
    }
    if (run.status === 'done' || run.status === 'failed') {
      log(`✔ ${site} 结束: status=${run.status} scanned=${run.total_scanned} approved=${run.total_approved} msg=${run.message}`);
      return run;
    }
  }
  log(`⚠ ${site} 超时未结束（>${TIMEOUT_MS / 60000} 分钟），runId=${runId}`);
  return null;
}

async function runSite(site) {
  let attempts = 0;
  let run = null;
  while (attempts <= RETRY_ON_EMPTY) {
    run = await runSiteOnce(site);
    if (!run) return;
    const empty = (run.total_scanned || 0) === 0 && (run.total_approved || 0) === 0;
    if (!empty || attempts >= RETRY_ON_EMPTY) return;
    attempts++;
    log(`  ${site} 本次 0 命中（疑似 1688 限流 429），${RETRY_GAP_MS / 1000}s 后第 ${attempts} 次重试…`);
    await new Promise((r) => setTimeout(r, RETRY_GAP_MS));
  }
}

async function main() {
  // 防重叠：若锁文件存在且进程仍活着则退出
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* 进程已死 */ }
    if (alive) {
      log(`已有实例在运行 (pid=${pid})，本次跳过。`);
      return;
    }
    log(`发现陈旧锁文件 (pid=${pid} 已退出)，清理后继续。`);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  try {
    log(`===== 定时扫描开始，站点=[${SITES.join(',')}] =====`);
    for (const site of SITES) {
      try {
        await runSite(site);
      } catch (e) {
        log(`✗ ${site} 异常: ${e?.message || e}`);
      }
    }
    log(`===== 定时扫描全部完成 =====`);
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
