/**
 * 商品管理：按 SKU / 标题模糊查询，查看与编辑商品信息（标题、图片、重量、长宽高、描述）
 * 走 per-store token（与订单、抓取一致的授权体系）。
 */

import { Store, ensureStoreToken } from './stores.js';
import { getMlApiBase } from './mercadolibre.js';

// ===== 通用 PUT 辅助（用于修改商品）=====

/** 以该店铺身份调用 ML API（PUT/POST），带 429 自动退避重试 */
export async function storeApiMutate(
  store: Store,
  method: 'PUT' | 'POST' | 'DELETE',
  apiPath: string,
  body?: any,
  retries = 2,
  extraHeaders?: Record<string, string>,
): Promise<any> {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const token = await ensureStoreToken(store);
      const resp = await fetch(`${getMlApiBase()}${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(extraHeaders || {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      // 204 / 200 都可能；ML 部分更新返回 200 + 修改后的对象，描述更新有时返回 200 无体
      if (!resp.ok) {
        const t = await resp.text();
        // 403 PolicyAgent 通常是权限/scope 问题，打详细日志便于排查
        if (resp.status === 403) {
          console.warn(
            `[Products] ML API 403 被拒绝: method=${method} url=${getMlApiBase()}${apiPath} token=${token.slice(0, 12)}... bodyKeys=${Object.keys(body || {}).join(',')} bodyPreview=${JSON.stringify(body).slice(0, 300)}`,
          );
          console.warn(`[Products] ML API 403 响应: ${t.slice(0, 400)}`);
        }
        const err = new Error(`ML API ${resp.status}: ${t.slice(0, 400)}`);
        if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
          lastErr = err;
          const delay = Math.min(800 * Math.pow(2, attempt) + Math.random() * 300, 8000);
          await new Promise((r) => setTimeout(r, Math.round(delay)));
          continue;
        }
        throw err;
      }
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try {
          return await resp.json();
        } catch {
          return { ok: true };
        }
      }
      return { ok: true };
    } catch (e: any) {
      lastErr = e;
      if (e?.message?.includes('429') && attempt < retries) {
        const delay = Math.min(800 * Math.pow(2, attempt) + Math.random() * 300, 8000);
        await new Promise((r) => setTimeout(r, Math.round(delay)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ===== 卖家 ID =====

/** 取店铺对应的美客多卖家 ID（优先用已存 mlUserId，否则 /users/me） */
export async function getStoreSellerId(store: Store): Promise<string> {
  if (store.mlUserId) return String(store.mlUserId);
  const me = await ensureStoreTokenThen(store, '/users/me');
  return String(me.id);
}

// 轻量 GET（仅本项目内用于取卖家信息，复用 mutate 的 token 逻辑代价大，这里直接 fetch）
async function ensureStoreTokenThen(store: Store, apiPath: string): Promise<any> {
  const token = await ensureStoreToken(store);
  const resp = await fetch(`${getMlApiBase()}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) throw new Error(`ML API ${resp.status}`);
  return resp.json();
}

// ===== 尺寸 / 重量解析 =====
// ML shipping.dimensions 官方字符串格式："高x宽x长,重量"（厘米 / 克，整数）。
// 同时后台“包裹重量与尺寸”对应 attributes 里的 PACKAGE_HEIGHT/WIDTH/LENGTH/WEIGHT，
// 优先从 attributes 读取，shipping.dimensions 作为 fallback。

export function parseDimensions(dim?: string): {
  length: string;
  width: string;
  height: string;
  weight: string;
} {
  if (!dim) return { length: '', width: '', height: '', weight: '' };
  const [dimsPart, weightPart] = dim.split(',');
  const parts = (dimsPart || '').split('x').map((s) => s.trim());
  const weight = (weightPart || '').replace(/[^\d.]/g, '');
  // 官方顺序：高 x 宽 x 长，重量
  return {
    height: parts[0] || '',
    width: parts[1] || '',
    length: parts[2] || '',
    weight,
  } as any;
}

export function buildDimensions(d: {
  length: string;
  width: string;
  height: string;
  weight: string;
}): string | undefined {
  // 按官方顺序回写：高 x 宽 x 长，重量
  const dims = [d.height, d.width, d.length]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!dims.length && !String(d.weight || '').trim()) return undefined;
  let s = dims.join('x');
  const w = String(d.weight || '').trim();
  if (w) s += `,${w}`;
  return s;
}

// ===== attributes 辅助 =====

function getAttrValue(item: any, id: string): string | undefined {
  const attr = (item?.attributes || []).find(
    (a: any) => String(a?.id || '').toUpperCase() === id.toUpperCase(),
  );
  if (!attr) return undefined;
  return attr.value_name ?? attr.value_id ?? undefined;
}

function parseNumberUnit(v: any): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  const m = s.match(/^([\d.]+)/);
  return m ? m[1] : s.replace(/[^\d.]/g, '');
}

function buildAttrNumberUnit(value: string, unit: string): string | undefined {
  const n = String(value || '').trim();
  if (!n) return undefined;
  return `${n} ${unit}`;
}

function looksLikeMlPictureId(s: string): boolean {
  // e.g. 123-MLM456_112021, 679765-CBT423366854653_082021
  return /^\d+-[A-Z]{2,3}\d+_[\d]{6}$/i.test(s);
}

function looksLikeMlPictureUrl(s: string): boolean {
  return /^https?:\/\/.*\.mlstatic\.com\//i.test(s);
}

function extractPictureIdFromUrl(url: string): string | undefined {
  // URL like https://http2.mlstatic.com/D_NQ_NP_123-MLM456_112021-F.jpg
  const m = url.match(/D_NQ_NP_([\d]+-[A-Z]{2,3}\d+_[\d]+)/i);
  if (m) return m[1];
  return undefined;
}

// ===== 搜索：按 SKU / 标题模糊查询 =====

export interface ProductSearchHit {
  id: string;
  title: string;
  seller_sku?: string;
  price: number;
  currency_id: string;
  thumbnail: string;
  permalink: string;
  available_quantity: number;
  status?: string;
  pictures: string[];
  matchType?: 'title' | 'sku';
}

/** 从 item 里提取 SKU（可能在顶层 seller_sku，也可能在 attributes.SELLER_SKU） */
function extractSku(item: any): string {
  if (item?.seller_sku) return String(item.seller_sku);
  const attr = (item?.attributes || []).find((a: any) => String(a?.id || '').toUpperCase() === 'SELLER_SKU');
  return attr?.value_name || attr?.value_id || '';
}

/**
 * 把 /items 返回体转换为前端需要的产品命中结构
 */
function itemToHit(item: any, matchType: 'title' | 'sku'): ProductSearchHit {
  const pictures: string[] = (item.pictures || []).map((p: any) => p.url || p.secure_url).filter(Boolean);
  return {
    id: item.id,
    title: item.title || '',
    seller_sku: extractSku(item),
    price: Number(item.price) || 0,
    currency_id: item.currency_id || '',
    thumbnail: item.thumbnail || pictures[0] || '',
    permalink: item.permalink || '',
    available_quantity: Number(item.available_quantity) || 0,
    status: item.status,
    pictures,
    matchType,
  };
}

/**
 * 单个商品详情：GET /items/{id}（官方文档确认返回完整 item：title / seller_sku /
 * pictures / shipping.dimensions 等）。用于搜索结果取详情，避免 /items?ids=
 * multiget 返回格式歧义（其返回 [{ code:200, body:{...} }] 且 code 为数字）。
 */
async function fetchItemDetail(itemId: string, store: Store): Promise<any | null> {
  const looksLikeCbtId = (id?: string) => /^CBT\d+$/i.test(String(id || ''));
  try {
    // CBT 全球售商品：官方读取端点是 /marketplace/items/{CBT_id}（返回 marketplace_items 等 CBT 专属字段）
    const path = looksLikeCbtId(itemId)
      ? `/marketplace/items/${encodeURIComponent(itemId)}`
      : `/items/${encodeURIComponent(itemId)}`;
    const item = await ensureStoreTokenThen(store, path);
    console.log(`[Products] GET ${path} => id=${item?.id} sku=${item?.seller_sku || extractSku(item) || '(empty)'}`);
    return item;
  } catch (e: any) {
    console.warn(`[Products] GET 详情失败 ${itemId}:`, e?.message?.slice(0, 160));
    return null;
  }
}

/**
 * 卖家商品搜索接口（官方文档支持 ?q= / ?seller_sku= / ?sku=）：
 * - CBT 全球售：/marketplace/users/{merchant_id}/items/search
 * - 普通站点：/users/{seller_id}/items/search
 * 返回 item id 列表（results）。
 */
async function searchSellerItems(
  store: Store,
  sellerId: string,
  params: { q?: string; seller_sku?: string; sku?: string },
): Promise<string[]> {
  if (!params.q && !params.seller_sku && !params.sku) return [];
  const base = (store.site || '').toUpperCase() === 'CBT' ? '/marketplace/users' : '/users';
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.seller_sku) qs.set('seller_sku', params.seller_sku);
  if (params.sku) qs.set('sku', params.sku);
  qs.set('limit', '50');
  try {
    const sd: any = await ensureStoreTokenThen(
      store,
      `${base}/${encodeURIComponent(sellerId)}/items/search?${qs.toString()}`,
    );
    const ids: string[] = (sd.results || []).map(String);
    console.log(`[Products] 搜索 [site=${store.site} ${JSON.stringify(params)}] => ${ids.length} 个: ${ids.slice(0, 5).join(',')}${ids.length > 5 ? '...' : ''}`);
    return ids;
  } catch (e: any) {
    console.warn('[Products] 搜索失败:', params, e?.message?.slice(0, 160));
    return [];
  }
}

/**
 * 按查询词搜索店铺商品（严格按美客多官方 API）：
 * 1) 查询词像商品 ID（含去掉 p_ 前缀）：直接 GET /items/{id}。
 * 2) SKU 精确搜索：/users|/marketplace/users/{sellerId}/items/search?
 *    seller_sku= / sku=（CBT 走 /marketplace/users，普通走 /users）。
 * 3) 标题/文本搜索：同一接口的 ?q=。
 * 4) 拿到 id 后逐个 GET /items/{id} 取详情（官方文档确认返回完整 item）。
 * 5) 非 CBT 额外用公开 /sites/{site}/search?q=&seller_id= 补一轮标题命中。
 * 注：美客多没有「按 SKU 模糊」搜索，SKU 为精确匹配；标题为文本模糊匹配。
 */
export async function searchStoreProducts(
  store: Store,
  query: string,
  opts: { skuScanPages?: number } = {},
): Promise<ProductSearchHit[]> {
  const sellerId = await getStoreSellerId(store);
  const q = (query || '').trim();
  const map = new Map<string, ProductSearchHit>();

  const addHit = (item: any, matchType: 'title' | 'sku') => {
    if (!item?.id || map.has(item.id)) return;
    map.set(item.id, itemToHit(item, matchType));
  };
  const detailAndAdd = async (id: string, matchType: 'title' | 'sku') => {
    const item = await fetchItemDetail(id, store);
    if (item) addHit(item, matchType);
  };

  // 1) 查询词像商品 ID：直接取详情（去除常见 p_ 前缀）
  const idCandidate = q.replace(/^p_/i, '').toUpperCase();
  if (/^[A-Z]{2,3}\d{6,}$/i.test(idCandidate)) {
    try {
      const item = await ensureStoreTokenThen(store, `/items/${encodeURIComponent(idCandidate)}`);
      addHit(item, 'sku');
    } catch (e: any) {
      console.warn('[Products] 按 ID 查找失败:', e?.message?.slice(0, 120));
    }
  }

  // 2) + 3) SKU 精确（seller_sku / sku）+ 标题文本（q=）
  const skuVariants = Array.from(
    new Set([q, q.replace(/^p_/i, '')].map((s) => s.trim()).filter(Boolean)),
  );
  for (const v of skuVariants) {
    const skuIds = await searchSellerItems(store, sellerId, { seller_sku: v });
    for (const id of skuIds) await detailAndAdd(id, 'sku');
    const customIds = await searchSellerItems(store, sellerId, { sku: v });
    for (const id of customIds) await detailAndAdd(id, 'sku');
  }
  if (q) {
    const titleIds = await searchSellerItems(store, sellerId, { q });
    for (const id of titleIds) await detailAndAdd(id, 'title');
  }

  // 4) 非 CBT 补充：公开站点搜索（返回完整 item 对象）
  if (q && (store.site || '').toUpperCase() !== 'CBT') {
    try {
      const sd: any = await ensureStoreTokenThen(
        store,
        `/sites/${encodeURIComponent(store.site)}/search?q=${encodeURIComponent(q)}&seller_id=${encodeURIComponent(sellerId)}&limit=50`,
      );
      for (const it of sd.results || []) addHit(it, 'title');
    } catch (e: any) {
      console.warn('[Products] 公开站点搜索失败:', e?.message?.slice(0, 120));
    }
  }

  return [...map.values()];
}

// ===== 详情：/items/{id} + /items/{id}/description =====

export interface ProductSiteToSell {
  site_id: string;
  price: number;
  currency_id?: string;
  listing_type_id?: string;
  logistic_type?: string;
  // 该站点是否以「净收入（net_proceeds）」定价（CBT 新定价方式，卖家设净收入，系统自动加成本算公开价）。
  // true 时保存走 net_proceeds 字段；false 时走 price 字段。
  net_proceeds?: boolean;
}

export interface ProductPicture {
  id?: string;
  url: string;
}

export interface ProductDetail extends ProductSearchHit {
  seller_sku: string;
  description: string;
  dimensions: { length: string; width: string; height: string; weight: string };
  condition?: string;
  site_id?: string; // CBT 商品需要目标市场站点（如 MLM）才能更新描述
  // CBT 全球售商品在各本地站点（如 MLM）可能有独立的标题和价格
  localized_title?: string;
  localized_price?: number;
  localized_site_id?: string;
  localized_item_id?: string;
  marketplace_items?: { site_id: string; item_id: string; logistic_type?: string }[];
  // 搜索接口可能返回本地站点 item ID（如 MLM...），保存时必须用 CBT 根 ID（CBT...）
  root_item_id: string;
  // User Products 新模型标识（如果存在，更新需走 /global/user-products）
  siteless_user_product_id?: string;
  user_product_id?: string;
  // 主要特性
  brand?: string;
  model?: string;
  // 库存（后台“您的仓库库存和识别码”）
  available_quantity: number;
  // CBT 按国家价格（后台“按国家的价格和销售条件”）
  sites_to_sell?: ProductSiteToSell[];
  // 图片（带 id，CBT 更新必须用 id）
  pictures_with_id?: ProductPicture[];
}

export async function getStoreItemDetail(store: Store, itemId: string): Promise<ProductDetail> {
  const looksLikeCbtId = (id?: string) => /^CBT\d+$/i.test(String(id || ''));
  const isCbtId = looksLikeCbtId(itemId);

  // 入口 itemId 可能是 CBT 父 ID（CBT...）或子站点 ID（MCO/MLM...）。
  // 先按形状取一次详情；若是子站点，再从 item.cbt_item_id 解析出父 ID。
  let item: any;
  try {
    item = isCbtId
      ? await ensureStoreTokenThen(store, `/marketplace/items/${encodeURIComponent(itemId)}`)
      : await ensureStoreTokenThen(store, `/items/${encodeURIComponent(itemId)}`);
  } catch (e: any) {
    console.warn(`[Products] GET 详情失败 ${itemId}:`, e?.message?.slice(0, 160));
    item = null;
  }
  if (!item) {
    // 兜底再试一次父商品端点（CBT 父 ID 用 /marketplace/items）
    try {
      if (!isCbtId) item = await ensureStoreTokenThen(store, `/marketplace/items/${encodeURIComponent(itemId)}`);
    } catch { /* ignore */ }
  }

  // 解析 CBT 父商品 ID：优先 item.cbt_item_id，其次 item.id（若本身是 CBT 父 ID）
  const cbtRootId =
    (looksLikeCbtId(item?.cbt_item_id) ? item.cbt_item_id : undefined) ||
    (looksLikeCbtId(item?.id) ? item.id : undefined);

  // 若入口是子站点 ID，需要通过父商品才能拿到 marketplace_items（按国家价格/净收入映射）
  let cbtItem = item;
  if (cbtRootId && (!item?.marketplace_items || item.id !== cbtRootId)) {
    try {
      cbtItem = await ensureStoreTokenThen(store, `/marketplace/items/${encodeURIComponent(cbtRootId)}`);
      console.log(`[Products] 入口为子站点 ${item?.id}，已解析父商品 ${cbtRootId} 取 marketplace_items`);
    } catch (e: any) {
      console.warn(`[Products] 取 CBT 父商品 ${cbtRootId} 失败:`, e?.message?.slice(0, 160));
    }
  }
  // 标题/图片等以父商品为准（父商品含完整英文标题与图片）
  const baseItem = cbtItem || item;
  if (!baseItem) {
    throw new Error('无法获取商品详情（CBT/本地端点均失败）');
  }

  // User Products 新模型标识：/marketplace/items/{CBT_id} 响应中可能直接存在，或从原始 marketplace_items 取第一个
  const rawMarketplaceItems = baseItem?.marketplace_items || [];
  const siteless_user_product_id =
    baseItem?.siteless_user_product_id ||
    rawMarketplaceItems[0]?.siteless_user_product_id ||
    undefined;
  const user_product_id =
    baseItem?.user_product_id ||
    baseItem?.parent_user_product_id ||
    rawMarketplaceItems[0]?.user_product_id ||
    undefined;

  const pictures: string[] = (baseItem.pictures || []).map((p: any) => p.url || p.secure_url).filter(Boolean);
  const picturesWithId: ProductPicture[] = (baseItem.pictures || []).map((p: any) => ({
    id: p.id,
    url: p.url || p.secure_url || '',
  })).filter((p: ProductPicture) => p.url || p.id);
  const thumbnail = baseItem.thumbnail || pictures[0] || '';
  // 优先从 attributes 的 PACKAGE_* 读包裹尺寸重量；fallback 到 shipping.dimensions
  const pkgH = parseNumberUnit(getAttrValue(baseItem, 'PACKAGE_HEIGHT'));
  const pkgW = parseNumberUnit(getAttrValue(baseItem, 'PACKAGE_WIDTH'));
  const pkgL = parseNumberUnit(getAttrValue(baseItem, 'PACKAGE_LENGTH'));
  const pkgWt = parseNumberUnit(getAttrValue(baseItem, 'PACKAGE_WEIGHT'));
  const dimsFromAttributes = pkgH || pkgW || pkgL || pkgWt;
  const dims = dimsFromAttributes
    ? { height: pkgH, width: pkgW, length: pkgL, weight: pkgWt }
    : parseDimensions(baseItem?.shipping?.dimensions);
  // CBT 更新描述需要目标市场 site_id；优先取商品字段，其次从 permalink 推断（如 ...mercadolibre.com.mx/... -> MLM）
  let site_id = baseItem.site_id || baseItem.original_site_id || '';
  if (!site_id && baseItem.permalink) {
    const m = String(baseItem.permalink).match(/mercadolibre\.com\.([a-z]+)/i);
    if (m) {
      const domainToSite: Record<string, string> = {
        ar: 'MLA', br: 'MLB', mx: 'MLM', co: 'MCO', cl: 'MLC', pe: 'MPE', uy: 'MLU', ve: 'MLV', ec: 'MEC',
      };
      site_id = domainToSite[m[1].toLowerCase()] || '';
    }
  }

  // CBT 更新必须用 global 根 ID（CBT...）。优先用已解析的 cbtRootId。
  const root_item_id = cbtRootId || itemId;

  // CBT 全球售：/marketplace/items/{CBT_id} 返回 marketplace_items（各站点本地 item 映射）。
  // 通过 GET /marketplace/items/{site_item_id} 取各站点的「净收入（net_proceeds.amount）」优先，
  // 回退公开标价 price（本地币种时折算展示）。美客多后台按国家改的正是净收入。
  // 参考：https://global-selling.mercadolibre.com/devsite/en_us/user-products-cbt/global-listing
  let localized_title: string | undefined;
  let localized_price: number | undefined;
  let localized_site_id: string | undefined;
  let localized_item_id: string | undefined;
  let marketplace_items: { site_id: string; item_id: string; logistic_type?: string }[] | undefined;
  let sites_from_marketplace: ProductSiteToSell[] | undefined;
  let cbtTargetSite = site_id || '';
  let cbtTargetLogisticType = 'remote';
  const isCbtItem = isCbtId || baseItem.site_id === 'CBT' || looksLikeCbtId(root_item_id);
  if (isCbtItem) {
    marketplace_items = (baseItem.marketplace_items || []).map((m: any) => ({
      site_id: String(m.site_id || ''),
      item_id: String(m.item_id || ''),
      logistic_type: String(m.logistic_type || ''),
    }));
    if (marketplace_items.length) {
      cbtTargetSite = site_id || marketplace_items[0].site_id || 'MLM';
      const targetLocal = marketplace_items.find((m) => m.site_id === cbtTargetSite);
      cbtTargetLogisticType = targetLocal?.logistic_type || marketplace_items[0].logistic_type || 'remote';
      if (targetLocal?.item_id) {
        localized_item_id = targetLocal.item_id;
        localized_site_id = cbtTargetSite;
      }
      // 取所有站点价格（净收入优先）
      sites_from_marketplace = [];
      for (const m of marketplace_items) {
        try {
          // 用 /marketplace/items/{site_item_id}：开启 net_proceeds 时返回 net_proceeds 节点与 net_proceeds_prices 标签
          const li = await ensureStoreTokenThen(
            store,
            `/marketplace/items/${encodeURIComponent(m.item_id)}`,
          );
          // 净收入（USD）：net_proceeds.amount 或直接数值
          const np = li?.net_proceeds?.amount ?? li?.net_proceeds;
          const priceVal = np != null ? Number(np) : (li?.price != null ? Number(li.price) : undefined);
          if (priceVal != null) {
            if (m.site_id === cbtTargetSite && !localized_price) {
              localized_title = li?.title;
              localized_price = Number(priceVal);
            }
            sites_from_marketplace.push({
              site_id: m.site_id,
              price: Number(priceVal),
              currency_id: np != null ? 'USD' : (li?.currency_id || 'USD'),
              listing_type_id: li?.listing_type_id,
              logistic_type: li?.shipping?.logistic_type || m.logistic_type || 'remote',
              net_proceeds: np != null,
            });
          }
        } catch (e: any) {
          console.warn(`[Products] 取站点价格失败 ${m.site_id}/${m.item_id}:`, e?.message?.slice(0, 120));
        }
      }
      if (!sites_from_marketplace.length) sites_from_marketplace = undefined;
      console.log(
        `[Products] CBT marketplace_items ${itemId} => ${marketplace_items.map((m) => `${m.site_id}:${m.item_id}`).join(', ')}; 价格条数=${sites_from_marketplace?.length || 0}`,
      );
    } else {
      console.log(`[Products] CBT marketplace_items ${itemId} 为空，按国家价格无法获取`);
    }
  }

  // CBT 描述读取：官方要求 GET /marketplace/items/{CBT_id}/description?site_id=&logistic_type=
  // 必须在 isCbtItem / cbtTargetSite / root_item_id 声明之后执行，避免 TDZ。
  let description = '';
  if (isCbtItem && cbtTargetSite) {
    try {
      const desc = await ensureStoreTokenThen(
        store,
        `/marketplace/items/${encodeURIComponent(root_item_id)}/description?site_id=${encodeURIComponent(cbtTargetSite)}&logistic_type=${encodeURIComponent(cbtTargetLogisticType)}`,
      );
      description = desc?.plain_text || desc?.text || '';
    } catch (e: any) {
      console.warn(`[Products] CBT 描述读取失败 ${root_item_id}/${cbtTargetSite}:`, e?.message?.slice(0, 120));
    }
  }
  if (!description) {
    try {
      const desc = await ensureStoreTokenThen(store, `/items/${encodeURIComponent(itemId)}/description`);
      description = desc?.plain_text || desc?.text || '';
    } catch {
      /* 描述接口可能限流/无权限，忽略 */
    }
  }

  // CBT 按国家价格：优先用刚才从 marketplace_items 拼装的（含 net_proceeds 标记），回退父商品 sites_to_sell
  const sites_to_sell: ProductSiteToSell[] | undefined = sites_from_marketplace?.length
    ? sites_from_marketplace
    : (Array.isArray(baseItem.sites_to_sell) && baseItem.sites_to_sell.length
        ? baseItem.sites_to_sell.map((s: any) => ({
            site_id: String(s.site_id || ''),
            price: Number(s.price) || 0,
            currency_id: s.currency_id || baseItem.currency_id || 'USD',
            listing_type_id: s.listing_type_id,
            logistic_type: s.logistic_type || 'remote',
            net_proceeds: false,
          }))
        : undefined);

  return {
    id: baseItem.id,
    title: baseItem.title || '',
    seller_sku: baseItem.seller_sku || '',
    price: Number(baseItem.price) || 0,
    currency_id: baseItem.currency_id || '',
    thumbnail,
    permalink: baseItem.permalink || '',
    available_quantity: Number(baseItem.available_quantity) || 0,
    status: baseItem.status,
    pictures,
    pictures_with_id: picturesWithId,
    description,
    dimensions: dims,
    condition: baseItem.condition,
    site_id,
    localized_title,
    localized_price,
    localized_site_id,
    localized_item_id,
    marketplace_items,
    root_item_id,
    siteless_user_product_id,
    user_product_id,
    brand: getAttrValue(baseItem, 'BRAND'),
    model: getAttrValue(baseItem, 'MODEL'),
    sites_to_sell,
  };
}

// ===== 更新：标题 / 图片 / 尺寸重量 / 描述 =====

export interface ProductUpdatePayload {
  title?: string;
  pictures?: string[] | { id?: string; url: string }[]; // 图片 URL 或带 id 对象（全量替换）
  price?: string; // 已废弃：保留兼容；新逻辑使用 sites_to_sell
  sites_to_sell?: ProductSiteToSell[]; // CBT 按国家价格
  weight?: string;
  length?: string;
  width?: string;
  height?: string;
  description?: string;
  site_id?: string; // CBT 更新描述需要目标市场站点（如 MLM）
  available_quantity?: string; // 库存
  brand?: string; // 主要特性 - 品牌
  model?: string; // 主要特性 - 模型
}

export interface ProductUpdateResult {
  success: boolean;
  message: string;
  item?: any;
  descriptionResult?: any;
}

/**
 * 上传外部图片 URL 到美客多图片服务器，返回 picture id。
 * 用于 CBT /global/items 更新（该端点只接受 {id}，不接受 {source}）。
 */
async function uploadPictureFromUrl(store: Store, url: string): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const imgResp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!imgResp.ok) throw new Error(`download ${imgResp.status}`);
    const blob = await imgResp.blob();
    const form = new FormData();
    form.append('file', blob, 'image.jpg');
    const token = await ensureStoreToken(store);
    const upResp = await fetch(`${getMlApiBase()}/pictures/items/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!upResp.ok) {
      const t = await upResp.text();
      throw new Error(`upload ${upResp.status}: ${t.slice(0, 200)}`);
    }
    const data = await upResp.json();
    return data.id;
  } catch (e: any) {
    console.warn('[Products] 上传图片失败:', url, e?.message?.slice(0, 200));
    return undefined;
  }
}

/**
 * 把前端传入的图片列表标准化为 ProductPicture[]。
 */
function normalizePicturesInput(input?: ProductUpdatePayload['pictures']): ProductPicture[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((p: any) => {
      if (typeof p === 'string') return { url: p };
      return { id: p?.id, url: p?.url || p?.source || '' };
    })
    .filter((p) => (p.id && String(p.id).trim()) || (p.url && String(p.url).trim()));
}

/**
 * CBT / User Products 更新图片必须用 picture id。
 * 把输入图片解析/上传为 { id } 数组；无法处理的会被跳过。
 */
async function resolveCbtPictureIds(store: Store, picInputs: ProductPicture[]): Promise<{ id: string }[]> {
  const out: { id: string }[] = [];
  for (const pic of picInputs) {
    let id = pic.id;
    if (!id && pic.url) {
      if (looksLikeMlPictureId(pic.url)) id = pic.url;
      else if (looksLikeMlPictureUrl(pic.url)) id = extractPictureIdFromUrl(pic.url);
    }
    if (!id && pic.url) {
      id = await uploadPictureFromUrl(store, pic.url);
    }
    if (id) out.push({ id });
    else console.warn('[Products] 无法识别/上传图片，已跳过:', pic.url);
  }
  return out;
}

/**
 * 打印 User Products 更新响应中的错误/警告，便于联调。
 */
function logUpResponse(prefix: string, res: any) {
  if (!res) return;
  if (res.errors) {
    console.warn(`[Products] ${prefix} 返回 errors:`, JSON.stringify(res.errors).slice(0, 500));
  }
  if (Array.isArray(res.listing_sites)) {
    for (const ls of res.listing_sites) {
      if (ls?.errors) {
        console.warn(`[Products] ${prefix} listing_site ${ls.id || ls.listing_id} 错误:`, JSON.stringify(ls.errors).slice(0, 500));
      }
    }
  }
}

/**
 * 修改商品。
 * - 普通站点：标题/图片/尺寸走 PUT /items/{id}；描述走 PUT /items/{id}/description。
 * - CBT 全球售：优先检测 User Products 新模型（存在 siteless_user_product_id）。
 *   - UP 模型：价格/站点销售条件走 PUT /global/user-products/{siteless_user_product_id} + listing_sites；
 *     描述/图片/属性/库存/标题（映射为 family_name）走同端点。
 *   - 旧模型：价格走 POST /global/items/{CBT_id} + sites_to_sell；其他走 PUT /global/items/{CBT_id}。
 * 每个字段只在被显式提供（非空字符串）时才发送，避免误覆盖。
 * 参考：
 *   https://global-selling.mercadolibre.com/devsite/zh_cn/shang-pin-miao-shu
 *   https://global-selling.mercadolibre.com/devsite/zh_cn/mei-kuan-chan-pin-de-jie-ge
 *   https://global-selling.mercadolibre.com/devsite/devsite/user-products-cbt
 */
export async function updateStoreItem(
  store: Store,
  itemId: string,
  payload: ProductUpdatePayload,
): Promise<ProductUpdateResult> {
  const site = (store.site || '').toUpperCase();
  const isCbt = site === 'CBT';
  const itemPath = isCbt ? `/global/items/${itemId}` : `/items/${itemId}`;

  // 通用属性构建
  const attributes: { id: string; value_name: string }[] = [];
  if (typeof payload.brand === 'string' && payload.brand.trim()) {
    attributes.push({ id: 'BRAND', value_name: payload.brand.trim() });
  }
  if (typeof payload.model === 'string' && payload.model.trim()) {
    attributes.push({ id: 'MODEL', value_name: payload.model.trim() });
  }
  const dimProvided =
    payload.weight !== undefined ||
    payload.length !== undefined ||
    payload.width !== undefined ||
    payload.height !== undefined;
  if (dimProvided) {
    const h = buildAttrNumberUnit(payload.height ?? '', 'cm');
    const w = buildAttrNumberUnit(payload.width ?? '', 'cm');
    const l = buildAttrNumberUnit(payload.length ?? '', 'cm');
    const wt = buildAttrNumberUnit(payload.weight ?? '', 'g');
    if (h) attributes.push({ id: 'PACKAGE_HEIGHT', value_name: h });
    if (w) attributes.push({ id: 'PACKAGE_WIDTH', value_name: w });
    if (l) attributes.push({ id: 'PACKAGE_LENGTH', value_name: l });
    if (wt) attributes.push({ id: 'PACKAGE_WEIGHT', value_name: wt });
  }

  // 图片标准化
  const picInputs = normalizePicturesInput(payload.pictures);
  const cbtPictures = isCbt && picInputs.length ? await resolveCbtPictureIds(store, picInputs) : [];

  let item: any = null;
  let descriptionResult: any = null;
  let warningNote = '';

  if (isCbt) {
    // 更新前先取一次父商品，判断是不是 User Products 模型，并拿到 marketplace_items 映射
    let cbtParent: any = null;
    let marketplace_items: any[] = [];
    let siteless_user_product_id: string | undefined;
    try {
      cbtParent = await ensureStoreTokenThen(store, `/marketplace/items/${encodeURIComponent(itemId)}`);
      marketplace_items = Array.isArray(cbtParent?.marketplace_items) ? cbtParent.marketplace_items : [];
      siteless_user_product_id =
        cbtParent?.siteless_user_product_id ||
        (marketplace_items[0]?.siteless_user_product_id);
    } catch (e: any) {
      console.warn(`[Products] 更新前取 CBT 父商品失败 ${itemId}，尝试旧接口:`, e?.message?.slice(0, 160));
    }

    if (siteless_user_product_id) {
      // ========== User Products 新模型 ==========
      const upPath = `/global/user-products/${encodeURIComponent(siteless_user_product_id)}`;
      console.log(`[Products] CBT 走 User Products 更新: ${upPath}`);

      // 1) 按国家价格（net_proceeds / price）-> listing_sites
      if (Array.isArray(payload.sites_to_sell) && payload.sites_to_sell.length && marketplace_items.length) {
        const listingSites: any[] = [];
        for (const s of payload.sites_to_sell) {
          const child = marketplace_items.find((m: any) => String(m.site_id) === s.site_id);
          if (!child?.item_id) {
            console.warn(`[Products] 找不到站点 ${s.site_id} 对应 listing_id，跳过该站点价格`);
            continue;
          }
          const entry: any = { listing_id: String(child.item_id) };
          if (s.net_proceeds) {
            entry.net_proceeds = Number(s.price);
          } else {
            entry.price = Number(s.price);
          }
          if (s.listing_type_id) entry.listing_type_id = s.listing_type_id;
          listingSites.push(entry);
        }
        if (listingSites.length) {
          console.log(`[Products] UP PUT ${upPath} listing_sites`);
          const priceRes = await storeApiMutate(store, 'PUT', upPath, { listing_sites: listingSites });
          item = priceRes;
          logUpResponse('UP 价格', priceRes);
        }
      }

      // 2) 描述
      if (typeof payload.description === 'string' && payload.description.trim() !== '') {
        console.log(`[Products] UP PUT ${upPath} description`);
        const descRes = await storeApiMutate(store, 'PUT', upPath, {
          description: { plain_text: payload.description },
        });
        descriptionResult = descRes;
        logUpResponse('UP 描述', descRes);
      }

      // 3) 产品信息（标题映射为 family_name，图片/属性/库存）
      const productBody: Record<string, any> = {};
      if (typeof payload.title === 'string' && payload.title.trim()) {
        productBody.family_name = payload.title.trim();
      }
      if (cbtPictures.length) productBody.pictures = cbtPictures;
      if (attributes.length) productBody.attributes = attributes;
      if (typeof payload.available_quantity === 'string' && payload.available_quantity.trim() !== '') {
        const q = Number(payload.available_quantity);
        if (Number.isFinite(q) && q >= 0) productBody.available_quantity = q;
      }
      if (Object.keys(productBody).length) {
        console.log(`[Products] UP PUT ${upPath} body keys=${Object.keys(productBody).join(',')}`);
        const prodRes = await storeApiMutate(store, 'PUT', upPath, productBody);
        item = prodRes || item;
        logUpResponse('UP 产品信息', prodRes);
      }
    } else {
      // ========== 传统 /global/items 路径（保留兼容） ==========
      const itemBody: Record<string, any> = {};

      if (typeof payload.title === 'string' && payload.title.trim()) itemBody.title = payload.title.trim();
      if (cbtPictures.length) itemBody.pictures = cbtPictures;
      if (attributes.length) itemBody.attributes = attributes;
      if (typeof payload.available_quantity === 'string' && payload.available_quantity.trim() !== '') {
        const q = Number(payload.available_quantity);
        if (Number.isFinite(q) && q >= 0) itemBody.available_quantity = q;
      }
      if (dimProvided) {
        const dims = buildDimensions({
          length: payload.length ?? '',
          width: payload.width ?? '',
          height: payload.height ?? '',
          weight: payload.weight ?? '',
        });
        if (dims) itemBody.shipping = { dimensions: dims };
      }

      // 描述单独请求，避免与其他字段冲突导致被忽略
      if (typeof payload.description === 'string' && payload.description.trim() !== '') {
        const cbtSiteId = payload.site_id || 'MLM';
        console.log(`[Products] 旧 CBT PUT ${itemPath} description`);
        descriptionResult = await storeApiMutate(store, 'PUT', itemPath, {
          site_id: cbtSiteId,
          logistic_type: 'remote',
          description: { plain_text: payload.description },
        });
      }

      // 价格：POST /global/items/{id} + sites_to_sell
      if (Array.isArray(payload.sites_to_sell) && payload.sites_to_sell.length) {
        const sitesBody = {
          sites_to_sell: payload.sites_to_sell.map((s) => {
            const base: any = {
              site_id: s.site_id,
              listing_type_id: s.listing_type_id,
              logistic_type: s.logistic_type || 'remote',
            };
            if (s.net_proceeds) base.net_proceeds = Number(s.price);
            else base.price = Number(s.price);
            return base;
          }),
        };
        console.log(`[Products] 旧 CBT POST /global/items/${itemId} sites_to_sell`);
        try {
          const postRes = await storeApiMutate(store, 'POST', itemPath, sitesBody);
          item = postRes;
          logUpResponse('旧 CBT 价格', postRes);
        } catch (e: any) {
          console.warn(`[Products] 旧 CBT POST /global/items/${itemId} 失败:`, e?.message?.slice(0, 200));
        }
      }

      // 其他基础字段
      if (Object.keys(itemBody).length) {
        console.log(`[Products] 旧 CBT PUT ${itemPath} body keys=${Object.keys(itemBody).join(',')}`);
        const putRes = await storeApiMutate(store, 'PUT', itemPath, itemBody);
        item = putRes || item;
      }
    }
  } else {
    // 普通站点
    const itemBody: Record<string, any> = {};
    if (typeof payload.title === 'string' && payload.title.trim()) itemBody.title = payload.title.trim();
    if (picInputs.length) itemBody.pictures = picInputs.map((p) => ({ source: p.url || p.id || '' })).filter((p) => p.source);
    if (attributes.length) itemBody.attributes = attributes;
    if (typeof payload.available_quantity === 'string' && payload.available_quantity.trim() !== '') {
      const q = Number(payload.available_quantity);
      if (Number.isFinite(q) && q >= 0) itemBody.available_quantity = q;
    }
    if (typeof payload.price === 'string' && payload.price.trim() !== '') {
      const priceNum = Number(payload.price);
      if (Number.isFinite(priceNum) && priceNum > 0) itemBody.price = priceNum;
    }
    if (dimProvided) {
      const dims = buildDimensions({
        length: payload.length ?? '',
        width: payload.width ?? '',
        height: payload.height ?? '',
        weight: payload.weight ?? '',
      });
      if (dims) itemBody.shipping = { dimensions: dims };
    }

    if (Object.keys(itemBody).length) {
      item = await storeApiMutate(store, 'PUT', itemPath, itemBody);
    }
    if (typeof payload.description === 'string') {
      descriptionResult = await storeApiMutate(store, 'PUT', `/items/${itemId}/description`, {
        plain_text: payload.description,
      });
    }
  }

  return {
    success: true,
    message: warningNote ? `保存成功${warningNote}` : '保存成功',
    item,
    descriptionResult,
  };
}
