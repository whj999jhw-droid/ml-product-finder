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

/**
 * 把 /items 返回体转换为前端需要的产品命中结构
 */
function itemToHit(item: any, matchType: 'title' | 'sku'): ProductSearchHit {
  const pictures: string[] = (item.pictures || []).map((p: any) => p.url || p.secure_url).filter(Boolean);
  return {
    id: item.id,
    title: item.title || '',
    seller_sku: item.seller_sku || '',
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
 * 按查询词模糊搜索店铺商品：
 * 1) 若查询词像商品 ID（如 MLM2047037776 / CBT123456）：直接 GET /items/{id}。
 * 2) 标题搜索：官方 /sites/{site}/search?q=...&seller_id=...（仅 active 刊登）。
 * 3) SKU 扫描：
 *    - CBT：/marketplace/users/{sellerId}/items/search?search_type=scan
 *    - 普通站点：/users/{sellerId}/items/search?search_type=scan
 *    分页拉取 item id 后批量 /items?ids=... 取详情，再比对 seller_sku。
 * 合并去重后返回。
 */
export async function searchStoreProducts(
  store: Store,
  query: string,
  opts: { skuScanPages?: number } = {},
): Promise<ProductSearchHit[]> {
  const sellerId = await getStoreSellerId(store);
  const site = (store.site || '').toUpperCase();
  const sellerItemsBase = getSellerItemsBasePath(store.site);
  const q = (query || '').trim();
  const ql = q.toLowerCase();
  const map = new Map<string, ProductSearchHit>();

  // 1) 按商品 ID 精确查找（MLM2047037776 / CBT123456789 等）
  if (/^[A-Z]{2,3}\d+$/i.test(q)) {
    try {
      const item = await ensureStoreTokenThen(store, `/items/${q.toUpperCase()}`);
      if (String(item?.seller_id) === String(sellerId)) {
        map.set(item.id, itemToHit(item, 'sku'));
      }
    } catch (e: any) {
      console.warn('[Products] 按 ID 查找失败:', e?.message?.slice(0, 120));
    }
  }

  // 批量从 item id 列表取详情（每次最多 20 个）
  const fetchItemDetailsBatch = async (ids: string[], matchType: 'title' | 'sku') => {
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      try {
        const batchData: any[] = await ensureStoreTokenThen(
          store,
          `/items?ids=${batch.map(encodeURIComponent).join(',')}`,
        );
        for (const entry of batchData || []) {
          if (entry?.code === '200' && entry.body) {
            map.set(entry.body.id, itemToHit(entry.body, matchType));
          }
        }
      } catch (e: any) {
        console.warn('[Products] 批量取详情失败:', e?.message?.slice(0, 120));
      }
    }
  };

  // 2) 标题搜索：用官方 /sites/{site}/search（支持 seller_id 过滤）
  if (q) {
    try {
      const searchSite = site === 'CBT' ? 'CBT' : store.site;
      const sd = await ensureStoreTokenThen(
        store,
        `/sites/${encodeURIComponent(searchSite)}/search?q=${encodeURIComponent(q)}&seller_id=${encodeURIComponent(sellerId)}&limit=50`,
      );
      for (const it of sd.results || []) {
        if (!map.has(it.id)) {
          map.set(it.id, itemToHit(it, 'title'));
        }
      }
    } catch (e: any) {
      console.warn('[Products] 标题搜索失败:', e?.message?.slice(0, 120));
    }
  }

  // 3) SKU 扫描（用 scan 接口扫全量商品，再用批量 /items?ids= 取详情过滤 seller_sku）
  if (q) {
    const maxPages = opts.skuScanPages ?? 4; // 每页默认 1000 个 id
    let scrollId: string | undefined;
    let page = 0;
    try {
      do {
        const path = scrollId
          ? `${sellerItemsBase}/${encodeURIComponent(sellerId)}/items/search?search_type=scan&scroll_id=${encodeURIComponent(scrollId)}`
          : `${sellerItemsBase}/${encodeURIComponent(sellerId)}/items/search?search_type=scan&limit=1000`;
        const sd: any = await ensureStoreTokenThen(store, path);
        const ids: string[] = (sd.results || []).filter((id: string) => !map.has(id));
        if (ids.length) {
          const details = new Map<string, any>();
          for (let i = 0; i < ids.length; i += 20) {
            const batch = ids.slice(i, i + 20);
            try {
              const batchData: any[] = await ensureStoreTokenThen(
                store,
                `/items?ids=${batch.map(encodeURIComponent).join(',')}`,
              );
              for (const entry of batchData || []) {
                if (entry?.code === '200' && entry.body) details.set(entry.body.id, entry.body);
              }
            } catch (e: any) {
              console.warn('[Products] SKU 扫描批量详情失败:', e?.message?.slice(0, 120));
            }
          }
          for (const [id, item] of details) {
            const sku = item?.seller_sku || '';
            if (sku && sku.toLowerCase().includes(ql)) {
              map.set(id, itemToHit(item, 'sku'));
            }
          }
        }
        scrollId = sd.scroll_id;
        page++;
      } while (scrollId && page < maxPages);
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
