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
      return await execFileAsync(python, [CLI_PATH, ...args], { cwd: SKILL_DIR, timeout: timeoutMs });
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

/**
 * 按自然语言描述搜索 1688 商品。
 * @param query 自然语言，例如 "露营椅 一件代发 包邮"
 */
export async function search1688ByQuery(query: string): Promise<Ali1688SearchResult> {
  if (!query?.trim()) {
    return { success: false, message: '搜索词为空', products: [] };
  }
  const ak = getAkFromConfig();
  if (!ak || ak.length < 8) {
    const msg = 'ALI_1688_AK 未配置，无法搜索 1688（请在页面「配置 1688 AK」或设置环境变量 ALI_1688_AK）';
    console.error('[Ali1688Skill] search 失败:', msg);
    return { success: false, message: msg, products: [] };
  }
  try {
    const { stdout, stderr } = await runCli(['search', '--query', query.trim(), '--channel', '']);
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
