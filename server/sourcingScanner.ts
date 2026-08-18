/**
 * AI 选品扫描器（MVP）
 * 目标：按站点扫描「近期新上 + 销量持续增长」的 ML 商品，作为候选货源。
 * 策略：先用官方 /sites/{site}/search 按分类拉取，再按上架时间、销量、价格过滤，
 *       不依赖付费数据服务，后续可接入 LinkFox/蓝鲸增强。
 */
import {
  searchProductsByCategory,
  fetchProductDetails,
  fetchProductItems,
  getExchangeRate,
} from './mercadolibre.js';
import { getAllStores, ensureStoreToken } from './stores.js';

/**
 * 解析一个用于扫描的店铺 token。
 * 优先使用「已启用 + 已授权」的店铺 token（可自动刷新，免去手动维护全局 ML_ACCESS_TOKEN）；
 * 找不到任何店铺时回退到全局 token（可能为空，搜索会受限）。
 */
async function resolveScanToken(): Promise<{ token: string; storeNick: string } | null> {
  const stores = getAllStores().filter((s) => s.enabled && s.accessToken);
  if (stores.length === 0) {
    console.warn('[SourcingScanner] 未找到已授权的店铺，扫描将使用全局 ML_ACCESS_TOKEN（可能为空/过期）');
    return null;
  }
  // 优先用 CBT 跨境店铺（搜索跨站点通用），否则取第一个
  const chosen = stores.find((s) => s.site === 'CBT') || stores[0];
  try {
    const token = await ensureStoreToken(chosen);
    console.log(`[SourcingScanner] 使用店铺「${chosen.nickname || chosen.site}」的 token 扫描（自动刷新）`);
    return { token, storeNick: chosen.nickname || chosen.site };
  } catch (e: any) {
    console.warn(`[SourcingScanner] 店铺 token 刷新失败(${chosen.nickname}): ${e?.message?.slice(0, 120)}，回退全局 token`);
    return null;
  }
}

export interface ScannerOptions {
  sites?: string[]; // 默认 MLM / MLB / MLC / MCO
  categories?: { id: string; name: string }[]; // 为空时按站点内置分类扫
  maxAgeDays?: number; // 只保留近 N 天上架，默认 30
  minSold?: number; // 最低销量，默认 1
  maxPriceUsd?: number; // 最高售价 USD，默认 50
  minPriceUsd?: number; // 最低售价 USD，默认 5
  limitPerCategory?: number; // 每个分类拉取数，默认 50
  minDailySales?: number; // 日均销量门槛，默认 0.5
}

export interface RawCandidate {
  site: string;
  itemId: string;
  productId?: string;
  title: string;
  priceUsd: number;
  currency: string;
  soldQuantity: number;
  availableQuantity: number;
  categoryId: string;
  categoryName?: string;
  permalink: string;
  thumbnail: string;
  sellerId?: number;
  sellerName?: string;
  sellerCountry?: string;
  listingDate: string; // ISO
  condition: string;
  logisticsType?: string;
  daysListed: number;
  dailySales: number;
  rawItem: any;
}

const DEFAULT_SITES = ['MLM', 'MLB', 'MLC', 'MCO'];

// 轻量内置分类：覆盖四大站点的常见跨境类目，后续可扩展为可配置
const DEFAULT_CATEGORIES: Record<string, { id: string; name: string }[]> = {
  MLM: [
    { id: 'MLM1574', name: 'Hogar, Muebles y Jardín' },
    { id: 'MLM1132', name: 'Juegos y Juguetes' },
    { id: 'MLM1430', name: 'Ropa, Bolsas y Calzado' },
    { id: 'MLM1648', name: 'Computación' },
    { id: 'MLM1000', name: 'Electrónica, Audio y Video' },
    { id: 'MLM1246', name: 'Belleza y Cuidado Personal' },
    { id: 'MLM1144', name: 'Consolas y Videojuegos' },
    { id: 'MLM180800', name: 'Accesorios para Vehículos' },
  ],
  MLB: [
    { id: 'MLB1574', name: 'Casa, Móveis e Decoração' },
    { id: 'MLB1132', name: 'Brinquedos e Hobbies' },
    { id: 'MLB1430', name: 'Roupas, Bolsas e Calçados' },
    { id: 'MLB1648', name: 'Informática' },
    { id: 'MLB1000', name: 'Eletrônicos, Áudio e Vídeo' },
    { id: 'MLB1246', name: 'Beleza e Cuidado Pessoal' },
    { id: 'MLB1144', name: 'Games' },
    { id: 'MLB180800', name: 'Acessórios para Veículos' },
  ],
  MLC: [
    { id: 'MLC1574', name: 'Hogar y Muebles' },
    { id: 'MLC1132', name: 'Juegos y Juguetes' },
    { id: 'MLC1430', name: 'Ropa, Zapatos y Accesorios' },
    { id: 'MLC1648', name: 'Computación' },
    { id: 'MLC1000', name: 'Electrónica, Audio y Video' },
    { id: 'MLC1246', name: 'Belleza y Cuidado Personal' },
    { id: 'MLC1144', name: 'Consolas y Videojuegos' },
  ],
  MCO: [
    { id: 'MCO1574', name: 'Hogar y Muebles' },
    { id: 'MCO1132', name: 'Juegos y Juguetes' },
    { id: 'MCO1430', name: 'Ropa, Zapatos y Accesorios' },
    { id: 'MCO1648', name: 'Computación' },
    { id: 'MCO1000', name: 'Electrónica, Audio y Video' },
    { id: 'MCO1246', name: 'Belleza y Cuidado Personal' },
    { id: 'MCO1144', name: 'Consolas y Videojuegos' },
  ],
};

function toUsd(price: number, currency: string, rates: Record<string, number>): number {
  if (currency === 'USD') return price;
  const rate = rates[currency];
  if (!rate) return 0;
  return price * rate;
}

function parseDate(d: any): Date | null {
  if (!d) return null;
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? null : dt;
}

function normalizeItem(site: string, item: any, categoryName: string, rates: Record<string, number>): RawCandidate | null {
  const priceLocal = typeof item.price === 'number' ? item.price : 0;
  const currency = item.currency_id || (site === 'MLM' ? 'MXN' : site === 'MLB' ? 'BRL' : site === 'MLC' ? 'CLP' : 'COP');
  const priceUsd = toUsd(priceLocal, currency, rates);
  const listingDate = parseDate(item.start_time || item.date_created);
  if (!listingDate) return null;
  const daysListed = Math.max(1, Math.floor((Date.now() - listingDate.getTime()) / (24 * 60 * 60 * 1000)));
  const sold = typeof item.sold_quantity === 'number' ? item.sold_quantity : 0;
  return {
    site,
    itemId: String(item.id || ''),
    title: String(item.title || ''),
    priceUsd,
    currency,
    soldQuantity: sold,
    availableQuantity: typeof item.available_quantity === 'number' ? item.available_quantity : 0,
    categoryId: item.category_id || '',
    categoryName,
    permalink: item.permalink || '',
    thumbnail: item.thumbnail || '',
    sellerId: item.seller?.id,
    sellerName: item.seller?.nickname,
    sellerCountry: item.seller?.country_id || '',
    listingDate: listingDate.toISOString(),
    condition: item.condition || '',
    logisticsType: item.shipping?.logistic_type,
    daysListed,
    dailySales: sold / daysListed,
    rawItem: item,
  };
}

/**
 * 扫描「近期新上 + 有销量」的商品。
 * 每个站点按分类串行，避免触发 ML 限速；分类内部批量拉取。
 */
export async function scanNewRisingProducts(
  opts: ScannerOptions = {}
): Promise<{ candidates: RawCandidate[]; totalScanned: number; errors: string[]; scanToken?: string }> {
  const sites = opts.sites || DEFAULT_SITES;
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const minSold = opts.minSold ?? 1;
  const maxPriceUsd = opts.maxPriceUsd ?? 50;
  const minPriceUsd = opts.minPriceUsd ?? 5;
  const limitPerCategory = opts.limitPerCategory ?? 50;
  const minDailySales = opts.minDailySales ?? 0.5;

  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const rates: Record<string, number> = {};
  const currencies = ['MXN', 'BRL', 'CLP', 'COP', 'USD'];
  await Promise.all(currencies.map(async (c) => { rates[c] = await getExchangeRate(c); }));

  // 解析店铺 token（自动刷新），用于带鉴权地扫描，避免全局 token 过期导致 0 结果
  const scanAuth = await resolveScanToken();
  const scanToken = scanAuth?.token;

  const all: RawCandidate[] = [];
  const errors: string[] = [];
  let totalScanned = 0;

  for (const site of sites) {
    const categories = opts.categories?.length ? opts.categories : (DEFAULT_CATEGORIES[site] || []);
    for (const cat of categories) {
      try {
        const results = await searchProductsByCategory(site, cat.id, limitPerCategory, 0, scanToken);
        totalScanned += results.length;
        for (const item of results) {
          const c = normalizeItem(site, item, cat.name, rates);
          if (!c) continue;
          // 过滤：近 N 天、有销量、价格区间
          if (new Date(c.listingDate) < cutoff) continue;
          if (c.soldQuantity < minSold) continue;
          if (c.priceUsd < minPriceUsd || c.priceUsd > maxPriceUsd) continue;
          if (c.dailySales < minDailySales) continue;
          // 仅 new（避免二手/翻新品）
          if (c.condition && c.condition !== 'new') continue;
          all.push(c);
        }
      } catch (err: any) {
        const msg = `[${site}/${cat.id}] ${err?.message || String(err)}`.slice(0, 200);
        console.warn('[SourcingScanner]', msg);
        errors.push(msg);
      }
      // 分类间限速，降低被封概率
      await sleep(600);
    }
  }

  // 按 itemId 去重，保留第一次出现（站点/分类优先级由调用顺序决定）
  const seen = new Set<string>();
  const unique = all.filter((c) => {
    if (seen.has(c.itemId)) return false;
    seen.add(c.itemId);
    return true;
  });

  // 按日均销量降序
  unique.sort((a, b) => b.dailySales - a.dailySales);
  return { candidates: unique, totalScanned, errors, scanToken: scanToken || undefined };
}

/**
 * 补充候选商品的详情：重量/尺寸/品牌/图片等。
 * 优先从 product 详情取，缺失时回退 item attributes。
 */
export async function enrichCandidate(item: RawCandidate, accessTokenOverride?: string): Promise<RawCandidate & {
  weightKg?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  brand?: string;
  model?: string;
  pictures: string[];
}> {
  let product: any = null;
  let items: any[] = [];
  try {
    // item.rawItem 里可能有 catalog_product_id
    const catalogId = item.rawItem?.catalog_product_id || item.rawItem?.catalog_product_id_suspended;
    if (catalogId) {
      product = await fetchProductDetails(catalogId, accessTokenOverride);
      items = await fetchProductItems(catalogId, 5, accessTokenOverride);
    } else {
      // 非 catalog item，直接从 item attributes 补
      items = [item.rawItem];
    }
  } catch (err: any) {
    console.warn(`[SourcingScanner] enrich ${item.itemId} 失败:`, err?.message?.slice(0, 100));
  }

  const source = product || items[0] || item.rawItem || {};
  const attrs = source.attributes || [];
  const getAttr = (id: string) => attrs.find((a: any) => String(a?.id || '').toUpperCase() === id)?.value_name;
  const parseNum = (v: any) => { const n = parseFloat(String(v).replace(/[^\d.]/g, '')); return isNaN(n) ? undefined : n; };

  // ML 重量单位多为 g，长度单位多为 cm
  const weightG = parseNum(getAttr('WEIGHT') || getAttr('PACKAGE_WEIGHT'));
  const weightKg = weightG ? weightG / 1000 : undefined;

  return {
    ...item,
    weightKg,
    lengthCm: parseNum(getAttr('LENGTH') || getAttr('DEPTH') || getAttr('PACKAGE_LENGTH')),
    widthCm: parseNum(getAttr('WIDTH') || getAttr('PACKAGE_WIDTH')),
    heightCm: parseNum(getAttr('HEIGHT') || getAttr('PACKAGE_HEIGHT')),
    brand: getAttr('BRAND'),
    model: getAttr('MODEL'),
    pictures: (source.pictures || item.rawItem?.pictures || []).map((p: any) => p.url || p.secure_url).filter(Boolean),
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
