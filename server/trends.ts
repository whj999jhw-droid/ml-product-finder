/**
 * Mercado Libre 站点热搜词服务
 *
 * 端点：GET https://api.mercadolibre.com/trends/{SITE_ID}
 * 返回：{ keyword: string, url: string }[]
 *
 * 策略：
 *   - 按站点缓存 1 小时（内存 + data/trends-cache.json）
 *   - 失败时返回缓存（即使过期）或空数组，不阻塞 AI 生成流程
 *   - 调用需要有效 access token（trends 端点部分站点/时段要求 Authorization）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureValidToken, getAccessToken } from './mercadolibre.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'trends-cache.json');
const TRANSLATION_FILE = path.join(DATA_DIR, 'trends-translations.json');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const TRANSLATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 翻译缓存 7 天

interface TrendItem {
  keyword: string;
  url?: string;
}

export type TrendSegment = 'fastest-growing' | 'most-wanted' | 'most-popular';

export interface TrendResult {
  keyword: string;
  url?: string;
  segment: TrendSegment;
  index: number;
  translation?: string;
}

interface TrendCacheEntry {
  site: string;
  keywords: string[];
  fetchedAt: string;
}

interface FullTrendCacheEntry {
  site: string;
  items: TrendResult[];
  fetchedAt: string;
}

interface TrendCache {
  entries: TrendCacheEntry[];
  fullEntries: FullTrendCacheEntry[];
}

interface TranslationCacheEntry {
  site: string;
  map: Record<string, string>;
  /** 翻译失败计数：连续失败达 2 次的词跳过不再重试（避免每次刷新都超时卡顿）。
   *  用计数而非直接跳过，是为了不误伤「冷启动」期间临时失败的好词——它们预热后下一次就能译出。 */
  failed?: Record<string, number>;
  fetchedAt: string;
}

interface TranslationCache {
  entries: TranslationCacheEntry[];
}

let memoryCache: Record<string, { keywords: string[]; ts: number }> = {};
let fullMemoryCache: Record<string, { items: TrendResult[]; ts: number }> = {};
let translationMemoryCache: Record<string, { map: Record<string, string>; ts: number }> = {};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadCache(): TrendCache {
  ensureDataDir();
  if (!fs.existsSync(CACHE_FILE)) return { entries: [], fullEntries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as TrendCache;
    return { entries: raw.entries || [], fullEntries: raw.fullEntries || [] };
  } catch {
    return { entries: [], fullEntries: [] };
  }
}

function saveCache(cache: TrendCache) {
  ensureDataDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function loadTranslationCache(): TranslationCache {
  ensureDataDir();
  if (!fs.existsSync(TRANSLATION_FILE)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(TRANSLATION_FILE, 'utf8')) as TranslationCache;
  } catch {
    return { entries: [] };
  }
}

function saveTranslationCache(cache: TranslationCache) {
  ensureDataDir();
  fs.writeFileSync(TRANSLATION_FILE, JSON.stringify(cache, null, 2));
}

function segmentByIndex(i: number): TrendSegment {
  if (i < 10) return 'fastest-growing';
  if (i < 30) return 'most-wanted';
  return 'most-popular';
}

function segmentLabel(seg: TrendSegment): string {
  if (seg === 'fastest-growing') return '增长最快';
  if (seg === 'most-wanted') return '用户最想要';
  return '最受欢迎';
}

async function fetchTrendsFromML(s: string): Promise<TrendResult[]> {
  await ensureValidToken();
  const token = getAccessToken();
  const url = `https://api.mercadolibre.com/trends/${s}`;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ML trends API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as TrendItem[] | unknown;
  if (!Array.isArray(data)) return [];

  return data
    .map((x, idx) => ({
      keyword: typeof x.keyword === 'string' ? x.keyword.trim() : '',
      url: typeof x.url === 'string' ? x.url : undefined,
      segment: segmentByIndex(idx),
      index: idx + 1,
    }))
    .filter((x) => x.keyword.length > 0);
}

/**
 * 获取某站点当前热搜关键词。
 * @param site  站点代码，如 MLM / MLB / MLC / MCO
 * @param limit 最多返回几条（默认 20，最大 50）
 */
export async function getTrendsKeywords(site: string, limit = 20): Promise<string[]> {
  const items = await getTrends(site, limit);
  return items.map((x) => x.keyword);
}

/**
 * 获取某站点完整热搜数据（含 keyword / url / segment）。
 * @param site         站点代码
 * @param limit        最多返回几条（默认 50，最大 50）
 * @param forceRefresh 是否跳过缓存强制刷新
 */
export async function getTrends(site: string, limit = 50, forceRefresh = false): Promise<TrendResult[]> {
  const s = (site || 'MLM').toUpperCase();
  const max = Math.min(Math.max(1, limit), 50);
  const now = Date.now();

  const fileCache = loadCache();
  const fullEntry = fileCache.fullEntries.find((e) => e.site === s);

  let items: TrendResult[] | undefined;

  if (!forceRefresh) {
    // 1. 内存缓存
    const mem = fullMemoryCache[s];
    if (mem && now - mem.ts < CACHE_TTL_MS) {
      items = mem.items;
    }
    // 2. 文件缓存
    if (!items && fullEntry) {
      const entryTs = new Date(fullEntry.fetchedAt).getTime();
      if (now - entryTs < CACHE_TTL_MS) {
        items = fullEntry.items;
      }
    }
  }

  // 3. 从 ML 拉取（缓存未命中或强制刷新时）
  if (!items) {
    try {
      items = await fetchTrendsFromML(s);
    } catch (err: any) {
      console.error(`[trends] failed to fetch ${s}:`, err?.message || err);
      // 失败时返回过期缓存（带上已有翻译）
      if (fullEntry) items = fullEntry.items;
      else return [];
    }
    // 写回 trends 缓存（关键词 + 整条），供后续直接命中
    const newEntry: FullTrendCacheEntry = {
      site: s,
      items: items.map((x) => ({ ...x, translation: undefined })),
      fetchedAt: new Date(now).toISOString(),
    };
    const updated: TrendCache = {
      entries: [
        ...fileCache.entries.filter((e) => e.site !== s),
        { site: s, keywords: items.map((x) => x.keyword), fetchedAt: new Date(now).toISOString() },
      ],
      fullEntries: [...fileCache.fullEntries.filter((e) => e.site !== s), newEntry],
    };
    saveCache(updated);
  }

  // 4. 应用已缓存翻译（始终从翻译缓存取，保证后台补全后下次即生效）
  items = applyCachedTranslations(s, items);
  fullMemoryCache[s] = { items, ts: now };

  // 5. 缺失翻译 → 后台非阻塞补译（不阻塞本次响应）
  const missing = items.filter((x) => !x.translation).map((x) => x.keyword);
  if (missing.length && !translationInProgress.has(s)) {
    translationInProgress.add(s);
    void translateAndCacheMissing(s, missing);
  }

  return items.slice(0, max);
}

/**
 * 每站点「翻译进行中」标记，避免重复触发后台补译任务。
 */
const translationInProgress = new Set<string>();

/**
 * 同步应用已缓存的中文翻译（不调用 LLM，立即返回）。
 * 翻译统一存放在翻译缓存（trends-translations.json），每次出词都从这里取，
 * 这样后台补全写回后，下一次请求即可生效。
 */
function applyCachedTranslations(site: string, items: TrendResult[]): TrendResult[] {
  const transCache = loadTranslationCache();
  const transEntry = transCache.entries.find((e) => e.site === site);
  const now = Date.now();
  let existingMap: Record<string, string> = {};
  if (transEntry) {
    const entryTs = new Date(transEntry.fetchedAt).getTime();
    if (now - entryTs < TRANSLATION_TTL_MS) {
      existingMap = transEntry.map || {};
      translationMemoryCache[site] = { map: existingMap, ts: entryTs };
    }
  }
  return items.map((item) => ({
    ...item,
    translation: existingMap[item.keyword] || item.translation,
  }));
}

/**
 * 后台补译缺失词并写回翻译缓存（fire-and-forget，不阻塞热搜响应）。
 * SiliconFlow 免费模型延迟极不稳定（0.6s~60s+），阻塞等待会让页面长时间转圈甚至 502；
 * 因此改为「先返回英文、后台慢慢补全」，前端隔几秒再拉一次即可看到中文。
 */
async function translateAndCacheMissing(site: string, missing: string[]): Promise<void> {
  if (!missing.length) {
    translationInProgress.delete(site);
    return;
  }
  try {
    const { translateTrendsKeywords } = await import('./aiService.js');
    const newMap = await translateTrendsKeywords(missing, site);

    const transCache = loadTranslationCache();
    const transEntry = transCache.entries.find((e) => e.site === site);
    const now = Date.now();
    let existingMap: Record<string, string> = {};
    let existingFailed: Record<string, number> = {};
    if (transEntry) {
      existingMap = transEntry.map || {};
      existingFailed = transEntry.failed || {};
    }
    // 连续失败达 2 次的词跳过（冷启动临时失败的好词只有 1 次，不会被误伤）
    const skipSet = new Set(Object.keys(existingFailed).filter((k) => (existingFailed[k] || 0) >= 2));
    const finalFailed: Record<string, number> = { ...existingFailed };
    for (const k of missing) {
      if (newMap[k]) delete finalFailed[k];
      else if (!skipSet.has(k)) finalFailed[k] = (finalFailed[k] || 0) + 1;
    }
    const finalMap = { ...existingMap, ...newMap };
    const updated: TranslationCache = {
      entries: [
        ...transCache.entries.filter((e) => e.site !== site),
        { site, map: finalMap, failed: finalFailed, fetchedAt: new Date(now).toISOString() },
      ],
    };
    saveTranslationCache(updated);
    translationMemoryCache[site] = { map: finalMap, ts: now };
    // 同步更新内存里的热搜条目，下次命中内存缓存也能直接带翻译
    const mem = fullMemoryCache[site];
    if (mem) {
      fullMemoryCache[site] = {
        ts: mem.ts,
        items: mem.items.map((it) => ({ ...it, translation: finalMap[it.keyword] || it.translation })),
      };
    }
    console.log(`[trends] ${site} 后台补译完成：新增 ${Object.keys(newMap).length} 条，累计 ${Object.keys(finalMap).length} 条`);
  } catch (err: any) {
    console.error(`[trends] 后台补译失败 ${site}:`, err?.message || err);
  } finally {
    translationInProgress.delete(site);
  }
}

export { segmentLabel };

/**
 * 清除缓存。不传 site 则清除全部。
 */
export function clearTrendsCache(site?: string) {
  if (site) {
    delete memoryCache[site.toUpperCase()];
  } else {
    memoryCache = {};
  }
}
