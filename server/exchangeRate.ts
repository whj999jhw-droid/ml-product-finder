/**
 * 汇率服务（参考文档设计：frankfurter.app + 6 小时缓存）
 * 用途：利润测算需要 CNY→USD 与 各站点货币→USD 的稳定汇率。
 * 策略：frankfurter.app（免费、无 key）→ 失败回退 ML currency_conversions → 硬编码兜底。
 */
import { getExchangeRate as mlGetExchangeRate } from './mercadolibre.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

interface CacheEntry {
  rate: number;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

// 硬编码兜底（2026 年量级，仅在所有源都失败时使用）
const FALLBACK_RATES: Record<string, number> = {
  CNY: 0.14,
  MXN: 0.055,
  BRL: 0.19,
  CLP: 0.00105,
  COP: 0.00025,
  USD: 1,
};

async function fetchFrankfurter(from: string, to: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const rate = data?.rates?.[to];
    return typeof rate === 'number' && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

/**
 * 获取 from → USD 汇率（带 6h 缓存）
 */
export async function getRateToUsd(from: string): Promise<number> {
  const cur = (from || 'USD').toUpperCase();
  if (cur === 'USD') return 1;
  const key = `${cur}_USD`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.rate;

  // 1) frankfurter
  let rate = await fetchFrankfurter(cur, 'USD');
  // 2) ML currency_conversions（frankfurter 不含 CLP/COP 等时回退）
  if (!rate) {
    try {
      const r = await mlGetExchangeRate(cur);
      if (r > 0) rate = r;
    } catch {
      /* ignore */
    }
  }
  // 3) 硬编码兜底
  if (!rate) rate = FALLBACK_RATES[cur] || 0;

  if (rate > 0) cache.set(key, { rate, ts: Date.now() });
  return rate || 0;
}

/** CNY → USD 快捷方法 */
export async function getCnyUsd(): Promise<number> {
  return getRateToUsd('CNY');
}

/** 清空缓存（测试用） */
export function clearRateCache(): void {
  cache.clear();
}
