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
// ML shipping.dimensions 字符串格式："WIDTHxLENGTHxHEIGHT,WEIGHT"（厘米 / 克）
// 三个维度顺序为 宽x长x高，编辑时保持原顺序回写即可，不强求语义对齐。

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
  return {
    length: parts[0] || '',
    width: parts[1] || '',
    height: parts[2] || '',
    weight,
  };
}

export function buildDimensions(d: {
  length: string;
  width: string;
  height: string;
  weight: string;
}): string | undefined {
  const dims = [d.length, d.width, d.height]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!dims.length && !String(d.weight || '').trim()) return undefined;
  let s = dims.join('x');
  const w = String(d.weight || '').trim();
  if (w) s += `,${w}`;
  return s;
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
 * 按站点类型取正确的基础路径：
 * - CBT 全球售：/marketplace/users/{seller_id}
 * - 普通站点：/users/{seller_id}
 */
function getSellerItemsBasePath(site: string) {
  return (site || '').toUpperCase() === 'CBT' ? '/marketplace/users' : '/users';
}

/**
 * 调用卖家商品搜索接口，返回 item id 列表（需再批量 /items?ids= 取详情）。
 * 官方文档明确支持（CBT 与普通站点都适用）的参数：
 *   sku=          -> seller_custom_field
 *   seller_sku=   -> SELLER_SKU 属性
 *   q=            -> 文本/标题
 */
async function searchBySellerItems(
  store: Store,
  sellerId: string,
  params: { sku?: string; seller_sku?: string; q?: string },
): Promise<string[]> {
  if (!params.sku && !params.seller_sku && !params.q) return [];
  const site = (store.site || '').toUpperCase();
  const base = site === 'CBT' ? '/marketplace/users' : '/users';
  const qs = new URLSearchParams();
  if (params.sku) qs.set('sku', params.sku);
  if (params.seller_sku) qs.set('seller_sku', params.seller_sku);
  if (params.q) qs.set('q', params.q);
  qs.set('limit', '50');
  try {
    const sd = await ensureStoreTokenThen(store, `${base}/${encodeURIComponent(sellerId)}/items/search?${qs.toString()}`);
    const ids = (sd.results || []).map(String);
    console.log(`[Products] seller-items 搜索 [site=${store.site} sku=${params.sku || ''} seller_sku=${params.seller_sku || ''} q=${params.q || ''}] => ${ids.length} 个 id: ${ids.slice(0, 5).join(',')}${ids.length > 5 ? '...' : ''}`);
    return ids;
  } catch (e: any) {
    console.warn('[Products] seller-items 搜索失败:', params, e?.message?.slice(0, 120));
    return [];
  }
}

/**
 * 批量从 item id 列表取详情（每次最多 20 个）。
 * 兼容 /items?ids= 的两种返回形态：
 *   - [{ code: 200, body: {...} }, ...]
 *   - [{ ... }, ...]（直接是 item 对象）
 */
async function fetchItemDetailsBatch(ids: string[], store: Store): Promise<any[]> {
  if (!ids.length) return [];
  const items: any[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    try {
      const batchData: any = await ensureStoreTokenThen(
        store,
        `/items?ids=${batch.map(encodeURIComponent).join(',')}`,
      );
      console.log(`[Products] /items?ids=${batch.join(',')}] raw type=${typeof batchData} isArray=${Array.isArray(batchData)} length=${Array.isArray(batchData) ? batchData.length : 'N/A'}`);
      const arr = Array.isArray(batchData) ? batchData : [];
      for (const entry of arr) {
        const code = entry?.code;
        const body = entry?.body;
        if ((code === 200 || code === '200') && body) {
          console.log(`[Products] /items?ids body id=${body.id} seller_sku=${body.seller_sku || extractSku(body) || '(empty)'}`);
          items.push(body);
        } else if (entry && typeof entry === 'object' && entry.id) {
          // 有些返回直接是 item 对象
          console.log(`[Products] /items?ids direct id=${entry.id} seller_sku=${entry.seller_sku || extractSku(entry) || '(empty)'}`);
          items.push(entry);
        } else {
          console.log(`[Products] /items?ids 无法解析 entry:`, JSON.stringify(entry).slice(0, 200));
        }
      }
    } catch (e: any) {
      console.warn('[Products] 批量取详情失败:', e?.message?.slice(0, 200));
    }
  }
  return items;
}

/** 单个取 item 详情兜底 */
async function fetchItemDetailSingle(itemId: string, store: Store): Promise<any | null> {
  try {
    const item = await ensureStoreTokenThen(store, `/items/${itemId}`);
    console.log(`[Products] /items/${itemId} id=${item?.id} seller_sku=${item?.seller_sku || extractSku(item) || '(empty)'}`);
    return item;
  } catch (e: any) {
    console.warn(`[Products] /items/${itemId} 失败:`, e?.message?.slice(0, 200));
    return null;
  }
}

/**
 * 按查询词搜索店铺商品。
 * 策略：
 * 1) 查询词像商品 ID 时直接 GET /items/{id}。
 * 2) 优先用官方支持的卖家商品精确搜索：sku= / seller_sku= / q=。
 * 3) 如果查询词以 p_ 开头（常见 ERP 前缀），同时尝试去掉前缀后的值。
 * 4) 兜底用 scan 扫描全量商品，在内存里按 seller_sku 包含匹配。
 * 5) 非 CBT 站点额外走公开 /sites/{site}/search?q=&seller_id= 再补一轮标题命中。
 */
export async function searchStoreProducts(
  store: Store,
  query: string,
  opts: { skuScanPages?: number } = {},
): Promise<ProductSearchHit[]> {
  const sellerId = await getStoreSellerId(store);
  const site = (store.site || '').toUpperCase();
  const isCbt = site === 'CBT';
  const q = (query || '').trim();
  const ql = q.toLowerCase();
  const map = new Map<string, ProductSearchHit>();

  const addHit = (item: any, matchType: 'title' | 'sku') => {
    if (!item?.id || map.has(item.id)) return;
    map.set(item.id, itemToHit(item, matchType));
  };

  // 1) 按商品 ID 精确查找（MLM2047037776 / CBT123456789 等）
  if (/^[A-Z]{2,3}\d+$/i.test(q)) {
    try {
      const item = await ensureStoreTokenThen(store, `/items/${q.toUpperCase()}`);
      addHit(item, 'sku');
    } catch (e: any) {
      console.warn('[Products] 按 ID 查找失败:', e?.message?.slice(0, 120));
    }
  }

  // 构造要尝试的 SKU 变体：原始值、去掉 p_ 前缀、去掉下划线及前面前缀
  const skuVariants = [q];
  if (q.toLowerCase().startsWith('p_')) skuVariants.push(q.slice(2));
  const lastUnderscorePart = q.split('_').pop() || '';
  if (lastUnderscorePart && lastUnderscorePart !== q) skuVariants.push(lastUnderscorePart);

  // 2) 官方精确搜索：sku= / seller_sku= / q=（CBT 与普通站点都支持，但路径不同）
  for (const variant of skuVariants) {
    // seller_sku 精确搜索（文档说会匹配 SELLER_SKU 属性）
    if (variant) {
      const ids = await searchBySellerItems(store, sellerId, { seller_sku: variant });
      let details = await fetchItemDetailsBatch(ids, store);
      if (ids.length && !details.length) {
        // /items?ids= 可能解析失败，逐个兜底
        details = (await Promise.all(ids.map((id) => fetchItemDetailSingle(id, store)))).filter(Boolean) as any[];
      }
      for (const item of details) addHit(item, 'sku');
    }
    // sku 精确搜索（匹配 seller_custom_field）
    if (variant) {
      const ids = await searchBySellerItems(store, sellerId, { sku: variant });
      let details = await fetchItemDetailsBatch(ids, store);
      if (ids.length && !details.length) {
        details = (await Promise.all(ids.map((id) => fetchItemDetailSingle(id, store)))).filter(Boolean) as any[];
      }
      for (const item of details) addHit(item, 'sku');
    }
  }

  // 3) 官方文本/标题搜索：
  //    CBT -> /marketplace/users/{merchant_id}/items/search?q=...
  //    普通 -> /users/{seller_id}/items/search?q=...
  if (q) {
    const ids = await searchBySellerItems(store, sellerId, { q });
    let details = await fetchItemDetailsBatch(ids, store);
    if (ids.length && !details.length) {
      details = (await Promise.all(ids.map((id) => fetchItemDetailSingle(id, store)))).filter(Boolean) as any[];
    }
    for (const item of details) addHit(item, 'title');
  }

  // 4) 非 CBT 额外走公开站点搜索（返回完整结果，无需再批量取详情）
  if (q && !isCbt) {
    try {
      const sd = await ensureStoreTokenThen(
        store,
        `/sites/${encodeURIComponent(store.site)}/search?q=${encodeURIComponent(q)}&seller_id=${encodeURIComponent(sellerId)}&limit=50`,
      );
      for (const it of sd.results || []) addHit(it, 'title');
    } catch (e: any) {
      console.warn('[Products] 公开站点搜索失败:', e?.message?.slice(0, 120));
    }
  }

  // 5) 兜底：scan 全量扫描后在内存里按 seller_sku 包含匹配
  //    仅在前面都没结果，或查询词很短（可能是 SKU 的一部分）时才启用
  if (q && map.size === 0) {
    const maxPages = opts.skuScanPages ?? 2; // 默认 2 页（2000 个 id），避免超时
    const base = isCbt ? '/marketplace/users' : '/users';
    let scrollId: string | undefined;
    let page = 0;
    try {
      do {
        const path = scrollId
          ? `${base}/${encodeURIComponent(sellerId)}/items/search?search_type=scan&scroll_id=${encodeURIComponent(scrollId)}`
          : `${base}/${encodeURIComponent(sellerId)}/items/search?search_type=scan&limit=1000`;
        const sd: any = await ensureStoreTokenThen(store, path);
        const ids: string[] = (sd.results || []).map(String).filter((id) => !map.has(id));
        if (ids.length) {
          for (const item of await fetchItemDetailsBatch(ids, store)) {
            const sku = extractSku(item);
            if (sku && sku.toLowerCase().includes(ql)) addHit(item, 'sku');
            if (!isCbt && item.title && item.title.toLowerCase().includes(ql)) addHit(item, 'title');
          }
        }
        scrollId = sd.scroll_id;
        page++;
      } while (scrollId && page < maxPages && map.size === 0);
    } catch (e: any) {
      console.warn('[Products] SKU 扫描失败/中断:', e?.message?.slice(0, 120));
    }
  }

  return [...map.values()];
}

// ===== 详情：/items/{id} + /items/{id}/description =====

export interface ProductDetail extends ProductSearchHit {
  seller_sku: string;
  description: string;
  dimensions: { length: string; width: string; height: string; weight: string };
  condition?: string;
}

export async function getStoreItemDetail(store: Store, itemId: string): Promise<ProductDetail> {
  const item = await ensureStoreTokenThen(store, `/items/${itemId}`);
  let description = '';
  try {
    const desc = await ensureStoreTokenThen(store, `/items/${itemId}/description`);
    description = desc?.plain_text || desc?.text || '';
  } catch {
    /* 描述接口可能限流/无权限，忽略 */
  }
  const pictures: string[] = (item.pictures || []).map((p: any) => p.url || p.secure_url).filter(Boolean);
  const thumbnail = item.thumbnail || pictures[0] || '';
  const dims = parseDimensions(item?.shipping?.dimensions);
  return {
    id: item.id,
    title: item.title || '',
    seller_sku: item.seller_sku || '',
    price: Number(item.price) || 0,
    currency_id: item.currency_id || '',
    thumbnail,
    permalink: item.permalink || '',
    available_quantity: Number(item.available_quantity) || 0,
    status: item.status,
    pictures,
    description,
    dimensions: dims,
    condition: item.condition,
  };
}

// ===== 更新：标题 / 图片 / 尺寸重量 / 描述 =====

export interface ProductUpdatePayload {
  title?: string;
  pictures?: string[]; // 图片 URL 列表（全量替换）
  weight?: string;
  length?: string;
  width?: string;
  height?: string;
  description?: string;
}

export interface ProductUpdateResult {
  success: boolean;
  message: string;
  item?: any;
  descriptionResult?: any;
}

/**
 * 修改商品。标题/图片/尺寸通过 PUT /items/{id}；描述通过 PUT /items/{id}/description。
 * 每个字段只在被显式提供（非空字符串）时才发送，避免误覆盖。
 */
export async function updateStoreItem(
  store: Store,
  itemId: string,
  payload: ProductUpdatePayload,
): Promise<ProductUpdateResult> {
  const itemBody: Record<string, any> = {};

  if (typeof payload.title === 'string' && payload.title.trim()) {
    itemBody.title = payload.title.trim();
  }
  if (Array.isArray(payload.pictures) && payload.pictures.length) {
    itemBody.pictures = payload.pictures
      .map((u) => String(u || '').trim())
      .filter(Boolean)
      .map((u) => ({ source: u }));
  }
  // 尺寸/重量：任一提供则整体重建 dimensions 发送
  if (
    payload.weight !== undefined ||
    payload.length !== undefined ||
    payload.width !== undefined ||
    payload.height !== undefined
  ) {
    const dims = buildDimensions({
      length: payload.length ?? '',
      width: payload.width ?? '',
      height: payload.height ?? '',
      weight: payload.weight ?? '',
    });
    if (dims) {
      itemBody.shipping = { dimensions: dims };
    }
  }

  let item: any = null;
  if (Object.keys(itemBody).length) {
    item = await storeApiMutate(store, 'PUT', `/items/${itemId}`, itemBody);
  }

  let descriptionResult: any = null;
  if (typeof payload.description === 'string') {
    descriptionResult = await storeApiMutate(store, 'PUT', `/items/${itemId}/description`, {
      plain_text: payload.description,
    });
  }

  return {
    success: true,
    message: '保存成功',
    item,
    descriptionResult,
  };
}
