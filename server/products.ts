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
 * 按查询词模糊搜索店铺商品：
 * 1) 标题搜索：GET /sites/{site}/search?q=&seller_id=  （快速，返回标题/缩略图/价格）
 * 2) SKU 扫描：GET /users/{sellerId}/items/search?search_type=scan 分页拿到全部 item id，
 *    逐个取 /items/{id} 比对 seller_sku 是否包含查询词（SKU 无独立搜索端点）。
 * 合并去重后返回。SKU 扫描有页数上限，超大店铺可能不全。
 */
export async function searchStoreProducts(
  store: Store,
  query: string,
  opts: { skuScanPages?: number } = {},
): Promise<ProductSearchHit[]> {
  const site = (store.site || '').toUpperCase() === 'CBT' ? 'MLM' : store.site; // CBT 用主站 search 兜底
  const sellerId = await getStoreSellerId(store);
  const q = (query || '').trim();
  const ql = q.toLowerCase();
  const map = new Map<string, ProductSearchHit>();

  // 1) 标题搜索（仅在有关键词时）
  if (q) {
    try {
      const sd = await ensureStoreTokenThen(
        store,
        `/sites/${site}/search?q=${encodeURIComponent(q)}&seller_id=${encodeURIComponent(sellerId)}&limit=50`,
      );
      for (const it of sd.results || []) {
        map.set(it.id, {
          id: it.id,
          title: it.title || '',
          price: Number(it.price) || 0,
          currency_id: it.currency_id || '',
          thumbnail: it.thumbnail || (it.pictures?.[0]?.url || ''),
          permalink: it.permalink || '',
          available_quantity: Number(it.available_quantity) || 0,
          status: it.status,
          pictures: (it.pictures || []).map((p: any) => p.url || p.secure_url).filter(Boolean),
          matchType: 'title',
        });
      }
    } catch (e: any) {
      console.warn('[Products] 标题搜索失败:', e?.message?.slice(0, 120));
    }
  }

  // 2) SKU 扫描（仅在有关键词时，且标题未覆盖）
  if (q) {
    const maxPages = opts.skuScanPages ?? 4; // 每页默认 1000 个 id，4 页 = 最多 4000 个商品
    let scrollId: string | undefined;
    let page = 0;
    try {
      do {
        const path = scrollId
          ? `/users/${sellerId}/items/search?search_type=scan&scroll_id=${encodeURIComponent(scrollId)}`
          : `/users/${sellerId}/items/search?search_type=scan&limit=1000`;
        const sd: any = await ensureStoreTokenThen(store, path);
        const ids: string[] = sd.results || [];
        for (const id of ids) {
          if (map.has(id)) continue; // 标题已命中，跳过避免重复拉取
          try {
            const item = await ensureStoreTokenThen(store, `/items/${id}`);
            const sku = item?.seller_sku || '';
            if (sku && sku.toLowerCase().includes(ql)) {
              map.set(id, {
                id,
                title: item.title || '',
                seller_sku: sku,
                price: Number(item.price) || 0,
                currency_id: item.currency_id || '',
                thumbnail: item.thumbnail || (item.pictures?.[0]?.url || ''),
                permalink: item.permalink || '',
                available_quantity: Number(item.available_quantity) || 0,
                status: item.status,
                pictures: (item.pictures || []).map((p: any) => p.url || p.secure_url).filter(Boolean),
                matchType: 'sku',
              });
            }
          } catch {
            /* 单个商品失败忽略 */
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
