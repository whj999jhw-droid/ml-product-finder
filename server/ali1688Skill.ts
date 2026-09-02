/**
 * 1688-shopkeeper 技能封装
 * 通过调用技能 CLI（python cli.py）完成 1688 关键词搜索与商品详情获取。
 * 依赖环境变量 ALI_1688_AK 或 ~/.openclaw/openclaw.json 中的 apiKey；首次使用需先写入 AK。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

const SKILL_DIR = path.join(process.env.WORKBUDDY_SKILLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.workbuddy', 'skills'), '1688-shopkeeper-bak__skillhub');
const CLI_PATH = path.join(SKILL_DIR, 'cli.py');

export interface Ali1688Product {
  id: string;
  title: string;
  price: number; // CNY
  url: string;
  imageUrl?: string;
  stats?: {
    totalSales?: number;
    last30DaysSales?: number;
    last30DaysDropShippingSales?: number;
    goodRates?: number;
    repurchaseRate?: number;
    remarkCnt?: number;
    collectionRate24h?: number;
    downstreamOffer?: number;
    totalOrder?: number;
    categoryListName?: string;
    earliestListingTime?: string;
  };
}

export interface Ali1688SearchResult {
  success: boolean;
  message: string;
  dataId?: string;
  products: Ali1688Product[];
  raw?: any;
  /** 是否因 1688 侧限流（429）导致失败：调用方可据此区分"没货源"与"被限流" */
  rateLimited?: boolean;
  /** 结果是否来自进程内去重缓存（相同查询词复用） */
  cached?: boolean;
}

/* ============================================================================
 * 1688 搜索限流治理（2026-09-03 实测驱动）
 * 服务器真实日志基线：35 次搜索中 17 成功 / 18 失败，18 次失败 100% 是
 * "请求被限流（429）"，非 429 失败为 0；且 35 次里只有 21 个唯一查询词
 * （同一 run 内重复搜索同一商品最多 5 次）。也就是说：只要请求能发出去，
 * 命中率是满额的（每次返回 20 个商品），瓶颈在限流与重复请求，而非搜索词。
 * 对策：① 相同查询词去重缓存 ② 全局最小间隔节流 ③ 429 指数退避重试。
 * ========================================================================== */
const SEARCH_CACHE_TTL_MS = Number(process.env.ALI1688_CACHE_TTL_MS ?? 30 * 60 * 1000);
const SEARCH_MIN_INTERVAL_MS = Number(process.env.ALI1688_MIN_INTERVAL_MS ?? 1200);
const SEARCH_429_RETRY = Number(process.env.ALI1688_429_RETRY ?? 3);
const SEARCH_429_BACKOFF_MS = Number(process.env.ALI1688_429_BACKOFF_MS ?? 4000);

const searchCache = new Map<string, { at: number; result: Ali1688SearchResult }>();
const searchStats = { requests: 0, cacheHits: 0, successes: 0, rateLimited: 0 };
let lastSearchAt = 0;

/** 读取 1688 搜索统计（供流水线在 run 结束时输出命中率，验证限流治理效果） */
export function getAli1688SearchStats(): { requests: number; cacheHits: number; successes: number; rateLimited: number } {
  return { ...searchStats };
}

/** 重置统计（每次流水线 run 开始时调用，便于按轮统计） */
export function resetAli1688SearchStats(): void {
  searchStats.requests = 0;
  searchStats.cacheHits = 0;
  searchStats.successes = 0;
  searchStats.rateLimited = 0;
}
let throttleChain: Promise<unknown> = Promise.resolve();

function cacheKeyOf(query: string): string {
  return query.trim().toLowerCase();
}

function readSearchCache(key: string): Ali1688SearchResult | undefined {
  const hit = searchCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return undefined;
  }
  return hit.result;
}

/** 全局串行节流：保证任意两次 1688 搜索之间至少间隔 SEARCH_MIN_INTERVAL_MS */
function searchThrottled<T>(fn: () => Promise<T>): Promise<T> {
  const run = throttleChain.then(async () => {
    const wait = Math.max(0, SEARCH_MIN_INTERVAL_MS - (Date.now() - lastSearchAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastSearchAt = Date.now();
    }
  });
  // 链上任何一次失败都不能中断后续请求的排队
  throttleChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isRateLimitError(res: Ali1688SearchResult): boolean {
  const text = `${res?.message || ''} ${res?.raw?.markdown || ''} ${JSON.stringify(res?.raw || {}).slice(0, 200)}`;
  return /429|限流|rate.?limit|too.?many/i.test(text);
}

export interface Ali1688DetailResult {
  success: boolean;
  message: string;
  dataId?: string;
  details: Record<string, { all_info: string }>;
  raw?: any;
}

function getOpenClawConfigPath(): string {
  const base = process.env.OPENCLAW_CONFIG_DIR || path.join(os.homedir(), '.openclaw');
  return path.join(base, 'openclaw.json');
}

function readOpenClawConfig(): any {
  const p = getOpenClawConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function writeOpenClawAK(ak: string): void {
  const p = getOpenClawConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cfg = readOpenClawConfig();
  // 兼容多种读取方式：顶层 apiKey、skills.entries 中的 apiKey、以及 env.ALI_1688_AK
  cfg.apiKey = ak;
  cfg.skills = cfg.skills || {};
  cfg.skills.entries = cfg.skills.entries || {};
  cfg.skills.entries['1688-shopkeeper'] = cfg.skills.entries['1688-shopkeeper'] || {};
  cfg.skills.entries['1688-shopkeeper'].apiKey = ak;
  cfg.skills.entries['1688-shopkeeper'].env = cfg.skills.entries['1688-shopkeeper'].env || {};
  cfg.skills.entries['1688-shopkeeper'].env.ALI_1688_AK = ak;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
}

function getAkFromConfig(): string | undefined {
  const cfg = readOpenClawConfig();
  const skill = cfg?.skills?.entries?.['1688-shopkeeper'] || {};
  return skill.apiKey || skill.env?.ALI_1688_AK || cfg.apiKey;
}

function getPythonCandidates(): string[] {
  const list = [
    process.env.ML_PYTHON_PATH,
    // 优先使用 skill 自带虚拟环境，避免 Ubuntu 系统 pip 被 PEP 668 限制
    path.join(SKILL_DIR, '.venv', 'bin', 'python'),
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
    'python',
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  return Array.from(new Set(list));
}

async function runCli(args: string[], timeoutMs = 60000): Promise<{ stdout: string; stderr: string }> {
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(`1688-shopkeeper CLI 未安装：找不到 ${CLI_PATH}。请先在服务器安装该 skill（路径 ~/.workbuddy/skills/1688-shopkeeper-bak__skillhub）。`);
  }
  const candidates = getPythonCandidates();
  let lastErr: any;
  for (const python of candidates) {
    console.log(`[Ali1688Skill] try ${python} ${CLI_PATH} ${args.join(' ')}`);
    try {
      return await execFileAsync(python, [CLI_PATH, ...args], {
        cwd: SKILL_DIR,
        timeout: timeoutMs,
        // stdin 设为 ignore，避免 Python CLI 在非 TTY 环境下阻塞等待输入
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      if (err.code === 'ENOENT' || (err.message && /ENOENT/.test(err.message))) {
        lastErr = err;
        continue;
      }
      if (err.stderr) {
        throw new Error(`1688-shopkeeper CLI 失败：${err.stderr.slice(0, 400)}`);
      }
      throw err;
    }
  }
  throw lastErr || new Error('未找到可用的 python/python3 命令，请安装 Python 或设置 ML_PYTHON_PATH');
}

function parseJson(stdout: string): any {
  const text = stdout.trim();
  // cli.py check 输出美化后的多行 JSON，先整体解析
  try {
    return JSON.parse(text);
  } catch {
    /* continue */
  }
  // 整体失败时，取最后一行 JSON（前面可能有日志）
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* continue */
    }
  }
  throw new Error('CLI 输出无法解析为 JSON：' + text.slice(0, 200));
}

/** 单次搜索：只负责发一次请求并解析，缓存/节流/重试由 search1688ByQuery 包装 */
async function doSearch1688(query: string, timeoutMs: number): Promise<Ali1688SearchResult> {
  try {
    const { stdout, stderr } = await runCli(['search', '--query', query.trim(), '--channel', ''], timeoutMs);
    if (stderr) {
      console.warn('[Ali1688Skill] search stderr:', stderr.slice(0, 400));
    }
    const json = parseJson(stdout);
    const products = (json.data?.products || []).map((p: any) => ({
      id: String(p.id || ''),
      title: String(p.title || ''),
      price: Number(p.price) || 0,
      url: String(p.url || ''),
      imageUrl: p.imageUrl ? String(p.imageUrl) : undefined,
      stats: p.stats || undefined,
    }));
    if (json.success !== true) {
      const msg = json.markdown || json.message || '1688 搜索返回失败状态';
      console.error('[Ali1688Skill] search 失败:', msg, 'raw=', JSON.stringify(json).slice(0, 300));
      return { success: false, message: msg, products, raw: json };
    }
    return {
      success: true,
      message: json.markdown || json.message || '',
      dataId: json.data?.data_id,
      products,
      raw: json,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    const stderr = err?.stderr ? String(err.stderr).slice(0, 400) : '';
    console.error('[Ali1688Skill] search 失败:', msg, stderr ? `stderr=${stderr}` : '');
    return { success: false, message: msg, products: [] };
  }
}

/**
 * 按自然语言描述搜索 1688 商品。
 * 内置三层限流治理（可用环境变量热调，无需重新部署）：
 *  - 去重缓存：相同查询词在 ALI1688_CACHE_TTL_MS(默认30分钟) 内复用结果，省配额
 *  - 全局节流：任意两次搜索至少间隔 ALI1688_MIN_INTERVAL_MS(默认1200ms)
 *  - 429 退避重试：被限流时按 4s/8s/12s 退避重试 ALI1688_429_RETRY(默认3) 次
 * @param query 自然语言，例如 "露营椅 一件代发 包邮"
 * @param opts.timeoutMs 搜索超时（ms），默认 120000；可用环境变量 ALI1688_SEARCH_TIMEOUT_MS 覆盖。
 */
export async function search1688ByQuery(
  query: string,
  opts?: { timeoutMs?: number },
): Promise<Ali1688SearchResult> {
  if (!query?.trim()) {
    return { success: false, message: '搜索词为空', products: [] };
  }
  const ak = getAkFromConfig();
  if (!ak || ak.length < 8) {
    const msg = 'ALI_1688_AK 未配置，无法搜索 1688（请在页面「配置 1688 AK」或设置环境变量 ALI_1688_AK）';
    console.error('[Ali1688Skill] search 失败:', msg);
    return { success: false, message: msg, products: [] };
  }

  // ① 去重缓存：同一 run 内重复候选不再重复消耗 1688 配额
  const key = cacheKeyOf(query);
  const cached = readSearchCache(key);
  if (cached) {
    searchStats.cacheHits++;
    console.log(`[Ali1688Skill] search 命中去重缓存（省 1 次请求）: "${query.slice(0, 40)}"`);
    return { ...cached, cached: true };
  }

  const timeoutMs = opts?.timeoutMs ?? Number(process.env.ALI1688_SEARCH_TIMEOUT_MS ?? 120000);
  const maxAttempts = Math.max(1, SEARCH_429_RETRY + 1);
  let last: Ali1688SearchResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // ② 全局节流后发请求
    searchStats.requests++;
    const res = await searchThrottled(() => doSearch1688(query, timeoutMs));
    if (res.success) {
      searchStats.successes++;
      searchCache.set(key, { at: Date.now(), result: res });
      return res;
    }
    last = res;
    // 非限流失败（如 CLI 未安装、解析失败）不重试，避免无谓等待
    if (!isRateLimitError(res)) break;
    if (attempt < maxAttempts) {
      const backoff = SEARCH_429_BACKOFF_MS * attempt;
      console.warn(
        `[Ali1688Skill] search 被限流(429)，退避 ${backoff}ms 后第 ${attempt}/${SEARCH_429_RETRY} 次重试: "${query.slice(0, 40)}"`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  const fallback: Ali1688SearchResult = last || { success: false, message: '1688 搜索失败（未知原因）', products: [] };
  const rateLimited = isRateLimitError(fallback);
  if (rateLimited) {
    searchStats.rateLimited++;
    console.warn(`[Ali1688Skill] search 重试 ${SEARCH_429_RETRY} 次后仍被限流(429): "${query.slice(0, 40)}"`);
  }
  return { ...fallback, rateLimited };
}

/**
 * 获取 1688 商品详情。
 * @param itemIds 逗号分隔或数组
 */
export async function get1688ProductDetail(itemIds: string | string[]): Promise<Ali1688DetailResult> {
  const ids = Array.isArray(itemIds) ? itemIds.join(',') : itemIds;
  if (!ids.trim()) {
    return { success: false, message: 'item_ids 为空', details: {} };
  }
  try {
    const { stdout } = await runCli(['prod_detail', '--item-ids', ids], 90000);
    const json = parseJson(stdout);
    return {
      success: json.success === true,
      message: json.markdown || json.message || '',
      dataId: json.data?.data_id,
      details: json.data?.details || {},
      raw: json,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[Ali1688Skill] prod_detail 失败:', msg);
    return { success: false, message: msg, details: {} };
  }
}

/**
 * 检查 1688-shopkeeper 是否已配置 AK
 * 优先读本地配置文件；读不到再尝试 CLI check。
 */
export async function check1688Config(): Promise<{ ok: boolean; message: string }> {
  if (!fs.existsSync(CLI_PATH)) {
    return { ok: false, message: `1688-shopkeeper CLI 未安装：找不到 ${CLI_PATH}。请先在服务器安装该 skill。` };
  }
  const ak = getAkFromConfig();
  if (!ak || ak.length < 8) {
    return { ok: false, message: `AK 未配置（${getOpenClawConfigPath()}）` };
  }
  try {
    const { stdout } = await runCli(['check'], 30000);
    const json = parseJson(stdout);
    return { ok: json.success === true, message: json.markdown || json.message || '' };
  } catch (err: any) {
    return { ok: false, message: err?.message || String(err) };
  }
}

/**
 * 配置 AK（直接写入 openclaw.json，避免服务器没有 python3 导致 configure 失败）
 */
export async function configure1688AK(ak: string): Promise<{ ok: boolean; message: string }> {
  try {
    const trimmed = ak.trim();
    if (!trimmed) {
      return { ok: false, message: 'AK 为空' };
    }
    writeOpenClawAK(trimmed);
    // 让当前 Node 进程也能立即读到
    process.env.ALI_1688_AK = trimmed;
    return { ok: true, message: `AK 已保存到 ${getOpenClawConfigPath()}` };
  } catch (err: any) {
    return { ok: false, message: err?.message || String(err) };
  }
}
