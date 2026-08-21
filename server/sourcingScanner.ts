/**
 * AI 选品扫描器（MVP）
 * 目标：按站点扫描「近期新上 + 销量持续增长」的 ML 商品，作为候选货源。
 * 策略：先用官方 /sites/{site}/search 按分类拉取，再按上架时间、销量、价格过滤，
 *       不依赖付费数据服务，后续可接入 LinkFox/蓝鲸增强。
 */
import {
  searchWithHighlightsFallback,
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

export interface ScanProgress {
  message: string;
  totalScanned?: number;
  totalMatched?: number;
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
  onProgress?: (p: ScanProgress) => void; // 进度回调
  scanTimeoutMs?: number; // 整体扫描超时，默认 5 分钟
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
// 每个分类带 zh 中文名，用于在候选列表/预览中做「中英文」展示
const DEFAULT_CATEGORIES: Record<string, { id: string; name: string; zh: string }[]> = {
  MLM: [
    { id: 'MLM1574', name: 'Hogar, Muebles y Jardín', zh: '家居、家具和园艺' },
    { id: 'MLM1132', name: 'Juegos y Juguetes', zh: '玩具和游戏' },
    { id: 'MLM1430', name: 'Ropa, Bolsas y Calzado', zh: '服装、箱包和鞋类' },
    { id: 'MLM1648', name: 'Computación', zh: '电脑及计算设备' },
    { id: 'MLM1000', name: 'Electrónica, Audio y Video', zh: '电子、音频和视频' },
    { id: 'MLM1246', name: 'Belleza y Cuidado Personal', zh: '美妆和个人护理' },
    { id: 'MLM1144', name: 'Consolas y Videojuegos', zh: '游戏主机和视频游戏' },
    { id: 'MLM180800', name: 'Accesorios para Vehículos', zh: '汽车配件' },
  ],
  MLB: [
    { id: 'MLB1574', name: 'Casa, Móveis e Decoração', zh: '家居、家具和装饰' },
    { id: 'MLB1132', name: 'Brinquedos e Hobbies', zh: '玩具和爱好' },
    { id: 'MLB1430', name: 'Roupas, Bolsas e Calçados', zh: '服装、箱包和鞋类' },
    { id: 'MLB1648', name: 'Informática', zh: '电脑及信息技术' },
    { id: 'MLB1000', name: 'Eletrônicos, Áudio e Vídeo', zh: '电子、音频和视频' },
    { id: 'MLB1246', name: 'Beleza e Cuidado Pessoal', zh: '美妆和个人护理' },
    { id: 'MLB1144', name: 'Games', zh: '游戏' },
    { id: 'MLB180800', name: 'Acessórios para Veículos', zh: '汽车配件' },
  ],
  MLC: [
    { id: 'MLC1574', name: 'Hogar y Muebles', zh: '家居和家具' },
    { id: 'MLC1132', name: 'Juegos y Juguetes', zh: '玩具和游戏' },
    { id: 'MLC1430', name: 'Ropa, Zapatos y Accesorios', zh: '服装、鞋类和配饰' },
    { id: 'MLC1648', name: 'Computación', zh: '电脑及计算设备' },
    { id: 'MLC1000', name: 'Electrónica, Audio y Video', zh: '电子、音频和视频' },
    { id: 'MLC1246', name: 'Belleza y Cuidado Personal', zh: '美妆和个人护理' },
    { id: 'MLC1144', name: 'Consolas y Videojuegos', zh: '游戏主机和视频游戏' },
  ],
  MCO: [
    { id: 'MCO1574', name: 'Hogar y Muebles', zh: '家居和家具' },
    { id: 'MCO1132', name: 'Juegos y Juguetes', zh: '玩具和游戏' },
    { id: 'MCO1430', name: 'Ropa, Zapatos y Accesorios', zh: '服装、鞋类和配饰' },
    { id: 'MCO1648', name: 'Computación', zh: '电脑及计算设备' },
    { id: 'MCO1000', name: 'Electrónica, Audio y Video', zh: '电子、音频和视频' },
    { id: 'MCO1246', name: 'Belleza y Cuidado Personal', zh: '美妆和个人护理' },
    { id: 'MCO1144', name: 'Consolas y Videojuegos', zh: '游戏主机和视频游戏' },
  ],
};

// 类目 id → 中文名 映射，供流水线入库时生成「中文 (Native)」双语类目名
export const CATEGORY_ZH_BY_ID: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const cats of Object.values(DEFAULT_CATEGORIES)) {
    for (const c of cats) map[c.id] = c.zh;
  }
  return map;
})();

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

function extractPriceLocal(item: any): { price: number; currency: string } {
  // /products/{id}/items 返回的 price 字段位置不固定，尝试多个常见路径
  const candidates = [
    [item.price, item.currency_id || item.currency],
    [item.sale_price?.amount, item.sale_price?.currency_id || item.currency_id || item.currency],
    [item.buy_box_winner?.price?.amount, item.buy_box_winner?.price?.currency_id || item.currency_id || item.currency],
    [item.buy_box_winner?.sale_price?.amount, item.buy_box_winner?.sale_price?.currency_id || item.currency_id || item.currency],
    [item.prices?.prices?.[0]?.amount, item.prices?.prices?.[0]?.currency_id || item.currency_id || item.currency],
    [item.prices?.purchase_price?.amount, item.prices?.purchase_price?.currency_id || item.currency_id || item.currency],
    [item.official_store_price?.amount, item.official_store_price?.currency_id || item.currency_id || item.currency],
    [item.variations?.[0]?.price, item.variations?.[0]?.currency_id || item.currency_id || item.currency],
    [item.variations?.[0]?.sale_price?.amount, item.variations?.[0]?.sale_price?.currency_id || item.currency_id || item.currency],
    [item.price_range?.min?.amount ?? item.price_range?.min, item.price_range?.min?.currency_id || item.currency_id || item.currency],
    [item.price_range?.max?.amount ?? item.price_range?.max, item.price_range?.max?.currency_id || item.currency_id || item.currency],
    [item.base_price, item.currency_id || item.currency],
    [item.original_price, item.currency_id || item.currency],
  ];
  for (const [p, c] of candidates) {
    const parsed = typeof p === 'number' ? p : parseFloat(String(p || '').replace(/[^0-9.]/g, ''));
    if (parsed && parsed > 0) {
      return { price: parsed, currency: String(c || '') };
    }
  }
  return { price: 0, currency: '' };
}

function logPriceDebug(item: any, site: string, categoryName: string) {
  const fields = Object.keys(item).filter(k => /price|currency|amount|sale|winner|variation/i.test(k));
  const snippet = JSON.stringify(item, (k, v) => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v;
    if (Array.isArray(v)) return `[array:${v.length}]`;
    return v;
  }, 0).slice(0, 500);
  console.warn(`[SourcingScanner] [${site}/${categoryName}] 价格解析失败 itemId=${item.id} title=${String(item.title || '').slice(0, 40)} 字段=[${fields.join(',')}] snippet=${snippet}`);
}

function normalizeItem(site: string, item: any, categoryName: string, rates: Record<string, number>): RawCandidate | null {
  const { price: priceLocal, currency: extractedCurrency } = extractPriceLocal(item);
  const currency = extractedCurrency || item.currency_id || item.currency || (site === 'MLM' ? 'MXN' : site === 'MLB' ? 'BRL' : site === 'MLC' ? 'CLP' : 'COP');
  const priceUsd = toUsd(priceLocal, currency, rates);
  const listingDate = parseDate(item.start_time || item.date_created);
  if (!listingDate) return null;
  const daysListed = Math.max(1, Math.floor((Date.now() - listingDate.getTime()) / (24 * 60 * 60 * 1000)));
  const sold = typeof item.sold_quantity === 'number' ? item.sold_quantity : parseInt(String(item.sold_quantity || '0'), 10) || 0;
  const rawTitle = String(item.title || item.name || item.family_name || '').trim();
  const title = rawTitle || categoryName || String(item.category_id || '');
  if (!rawTitle) {
    console.warn(`[SourcingScanner] [${site}/${categoryName}] 商品缺少标题，使用类目名兜底 itemId=${item.id || item.item_id}`);
  }
  return {
    site,
    itemId: String(item.id || item.item_id || ''),
    title,
    priceUsd,
    currency,
    soldQuantity: sold,
    availableQuantity: typeof item.available_quantity === 'number' ? item.available_quantity : parseInt(String(item.available_quantity || '0'), 10) || 0,
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
  const onProgress = opts.onProgress;
  const scanTimeoutMs = opts.scanTimeoutMs ?? 15 * 60 * 1000;

  const report = (msg: string, extra?: Partial<ScanProgress>) => {
    console.log(`[SourcingScanner] ${msg}`);
    onProgress?.({ message: msg, ...extra });
  };

  const doScan = async (): Promise<{ candidates: RawCandidate[]; totalScanned: number; errors: string[]; scanToken?: string }> => {
    report('正在获取汇率...');
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const rates: Record<string, number> = {};
    const currencies = ['MXN', 'BRL', 'CLP', 'COP', 'USD'];
    await Promise.all(currencies.map(async (c) => { rates[c] = await getExchangeRate(c); }));

    // 解析店铺 token（自动刷新），用于带鉴权地扫描，避免全局 token 过期导致 0 结果
    report('正在校验/刷新店铺 Token...');
    const scanAuth = await resolveScanToken();
    const scanToken = scanAuth?.token;
    report(scanToken ? `Token 就绪（店铺：${scanAuth?.storeNick}）` : 'Token 就绪（回退全局 token）');

    const all: RawCandidate[] = [];
    const errors: string[] = [];
    let totalScanned = 0;

    for (const site of sites) {
      const categories = opts.categories?.length ? opts.categories : (DEFAULT_CATEGORIES[site] || []);
      report(`开始扫描站点 ${site}，共 ${categories.length} 个分类...`, { totalScanned });
      for (let idx = 0; idx < categories.length; idx++) {
        const cat = categories[idx];
        report(`[${site}] 扫描分类 ${idx + 1}/${categories.length}: ${cat.name}`, { totalScanned });
        try {
          const res = await searchWithHighlightsFallback(site, cat.id, limitPerCategory, 0, scanToken);
          const results = res.items;
          const fromHighlights = res.fromHighlights;
          totalScanned += results.length;
          report(`[${site}/${cat.name}] 获取 ${results.length} 个结果${fromHighlights ? '（highlights 兜底）' : ''}`, { totalScanned });
          // 统计本分类被过滤原因，便于调试 highlights 数据
          const reasons: Record<string, number> = {};
          for (const item of results) {
            const c = normalizeItem(site, item, cat.name, rates);
            if (!c) { reasons['normalize_null'] = (reasons['normalize_null'] || 0) + 1; continue; }
            // highlights 兜底的货源是「长期热门」，没有「近30天新品」概念，
            // 且 /products/{id}/items 返回的 item 常缺少 sold_quantity/condition，
            // 因此放宽过滤：价格>0、能上 Best Sellers 默认有销量、condition 为空默认可通过
            if (item._fromHighlights) {
              // highlights 是官方 Best Sellers，/products/{id}/items 返回的 item
              // 常缺少 sold_quantity/condition，且价格分布广。这里只排除价格未转换成功的商品，
              // 让后端 1688 匹配 + 五维评分去淘汰，避免扫描阶段把候选全部刷掉。
              if (c.priceUsd <= 0) {
                reasons['price_zero'] = (reasons['price_zero'] || 0) + 1;
                logPriceDebug(item, site, cat.name);
                continue;
              }
              const effSold = c.soldQuantity > 0 ? c.soldQuantity : 1;
              const effCondition = c.condition || 'new';
              const corrected = { ...c, soldQuantity: effSold, condition: effCondition, dailySales: effSold / Math.max(1, c.daysListed) };
              all.push(corrected);
              continue;
            }
            // 过滤：近 N 天、有销量、价格区间
            if (new Date(c.listingDate) < cutoff) continue;
            if (c.soldQuantity < minSold) continue;
            if (c.priceUsd < minPriceUsd || c.priceUsd > maxPriceUsd) continue;
            if (c.dailySales < minDailySales) continue;
            // 仅 new（避免二手/翻新品）
            if (c.condition && c.condition !== 'new') continue;
            all.push(c);
          }
          if (Object.keys(reasons).length) {
            console.log(`[SourcingScanner] [${site}/${cat.name}] 过滤原因统计:`, reasons);
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
    report(`扫描完成：${totalScanned} 个商品，${unique.length} 个通过过滤`, {
      totalScanned,
      totalMatched: unique.length,
    });
    return { candidates: unique, totalScanned, errors, scanToken: scanToken || undefined };
  };

  return Promise.race([
    doScan(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`扫描超时（>${scanTimeoutMs / 1000}s），请检查网络或 ML 接口可达性`)), scanTimeoutMs)
    ),
  ]);
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
