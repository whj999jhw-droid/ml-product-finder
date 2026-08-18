/**
 * 1688-shopkeeper 技能封装
 * 通过调用技能 CLI（python3 cli.py）完成 1688 关键词搜索与商品详情获取。
 * 依赖环境变量 ALI_1688_AK；首次使用需先执行 configure。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
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

function getPythonCmd(): string {
  return process.env.ML_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
}

async function runCli(args: string[], timeoutMs = 60000): Promise<{ stdout: string; stderr: string }> {
  const python = getPythonCmd();
  console.log(`[Ali1688Skill] ${python} ${CLI_PATH} ${args.join(' ')}`);
  try {
    return await execFileAsync(python, [CLI_PATH, ...args], { cwd: SKILL_DIR, timeout: timeoutMs });
  } catch (err: any) {
    // execFile 在进程非 0 退出时会抛 AggregateError，把 stderr 带出来
    if (err.stderr) {
      throw new Error(`1688-shopkeeper CLI 失败：${err.stderr.slice(0, 400)}`);
    }
    throw err;
  }
}

function parseJson(stdout: string): any {
  const text = stdout.trim();
  // 取最后一行 JSON（前面可能有日志）
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
  try {
    const { stdout } = await runCli(['search', '--query', query.trim(), '--channel', '']);
    const json = parseJson(stdout);
    const products = (json.data?.products || []).map((p: any) => ({
      id: String(p.id || ''),
      title: String(p.title || ''),
      price: Number(p.price) || 0,
      url: String(p.url || ''),
      imageUrl: p.imageUrl ? String(p.imageUrl) : undefined,
      stats: p.stats || undefined,
    }));
    return {
      success: json.success === true,
      message: json.markdown || json.message || '',
      dataId: json.data?.data_id,
      products,
      raw: json,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[Ali1688Skill] search 失败:', msg);
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
 * 检查 1688-shopkeeper 是否已配置 AK（仅做 best-effort 探测）
 */
export async function check1688Config(): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout } = await runCli(['check'], 30000);
    const json = parseJson(stdout);
    return { ok: json.success === true, message: json.markdown || json.message || '' };
  } catch (err: any) {
    return { ok: false, message: err?.message || String(err) };
  }
}

/**
 * 配置 AK（谨慎使用，会写入技能本地配置）
 */
export async function configure1688AK(ak: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout } = await runCli(['configure', ak.trim()], 30000);
    const json = parseJson(stdout);
    return { ok: json.success === true, message: json.markdown || json.message || '' };
  } catch (err: any) {
    return { ok: false, message: err?.message || String(err) };
  }
}
