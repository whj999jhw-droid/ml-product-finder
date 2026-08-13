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
// 解析按 API 返回的顺序切分三段 + 重量，回写时保持原顺序拼接，避免语义错位。

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
 * 单个商品详情：GET /items/{id}（官方文档确认返回完整 item：title / seller_sku /
 * pictures / shipping.dimensions 等）。用于搜索结果取详情，避免 /items?ids=
 * multiget 返回格式歧义（其返回 [{ code:200, body:{...} }] 且 code 为数字）。
 */
async function fetchItemDetail(itemId: string, store: Store): Promise<any | null> {
  try {
    const item = await ensureStoreTokenThen(store, `/items/${encodeURIComponent(itemId)}`);
    console.log(`[Products] GET /items/${itemId} => id=${item?.id} sku=${item?.seller_sku || extractSku(item) || '(empty)'}`);
    return item;
  } catch (e: any) {
    console.warn(`[Products] GET /items/${itemId} 失败:`, e?.message?.slice(0, 160));
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
  marketplace_items?: { site_id: string; item_id: string }[];
  // 搜索接口可能返回本地站点 item ID（如 MLM...），保存时必须用 CBT 根 ID（CBT...）
  root_item_id: string;
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
  // CBT 更新描述需要目标市场 site_id；优先取商品字段，其次从 permalink 推断（如 ...mercadolibre.com.mx/... -> MLM）
  let site_id = item.site_id || item.original_site_id || '';
  if (!site_id && item.permalink) {
    const m = String(item.permalink).match(/mercadolibre\.com\.([a-z]+)/i);
    if (m) {
      const domainToSite: Record<string, string> = {
        ar: 'MLA', br: 'MLB', mx: 'MLM', co: 'MCO', cl: 'MLC', pe: 'MPE', uy: 'MLU', ve: 'MLV', ec: 'MEC',
      };
      site_id = domainToSite[m[1].toLowerCase()] || '';
    }
  }

  // 搜索接口（/marketplace/users/{id}/items/search）可能返回本地站点 item ID（MLM...），
  // 但 CBT 更新必须用 global 根 ID（CBT...）。优先从返回体取 cbt_item_id，其次判断 id 前缀。
  const looksLikeCbtId = (id?: string) => /^CBT\d+$/i.test(String(id || ''));
  const root_item_id =
    (looksLikeCbtId(item.cbt_item_id) ? item.cbt_item_id : undefined) ||
    (looksLikeCbtId(item.id) ? item.id : undefined) ||
    itemId;
  if (root_item_id !== itemId && root_item_id !== item.id) {
    console.log(`[Products] 商品 ID 映射: 请求=${itemId} 返回=${item.id} 根=${root_item_id}`);
  }

  // CBT 全球售：通过 /items/{id}/marketplace_items 获取各站点本地 item 映射，
  // 再 GET /items/{local_id} 取本地站点的标题/价格（和美客多后台一致）。
  // 参考：https://global-selling.mercadolibre.com/devsite/items-and-searches-global-selling
  let localized_title: string | undefined;
  let localized_price: number | undefined;
  let localized_site_id: string | undefined;
  let localized_item_id: string | undefined;
  let marketplace_items: { site_id: string; item_id: string }[] | undefined;
  const storeSite = (store.site || '').toUpperCase();
  if (storeSite === 'CBT' || item.site_id === 'CBT' || looksLikeCbtId(root_item_id)) {
    try {
      const mapping = await ensureStoreTokenThen(
        store,
        `/items/${encodeURIComponent(itemId)}/marketplace_items`,
      );
      marketplace_items = (mapping?.marketplace_items || []).map((m: any) => ({
        site_id: String(m.site_id || ''),
        item_id: String(m.item_id || ''),
      }));
      const targetSite = site_id || 'MLM';
      const local = marketplace_items.find((m) => m.site_id === targetSite);
      if (local?.item_id) {
        localized_item_id = local.item_id;
        localized_site_id = targetSite;
        const localItem = await ensureStoreTokenThen(
          store,
          `/items/${encodeURIComponent(local.item_id)}`,
        );
        localized_title = localItem?.title;
        localized_price = Number(localItem?.price) || undefined;
        console.log(
          `[Products] CBT 本地站点映射 ${itemId} -> ${local.item_id} title=${localized_title || '(empty)'} price=${localized_price || '(empty)'}`,
        );
      } else {
        console.log(`[Products] CBT 本地站点映射 ${itemId} 未找到 ${targetSite}: ${JSON.stringify(marketplace_items)}`);
      }
    } catch (e: any) {
      console.warn(`[Products] 获取 CBT 本地站点映射失败 ${itemId}:`, e?.message?.slice(0, 160));
    }
  }

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
    site_id,
    localized_title,
    localized_price,
    localized_site_id,
    localized_item_id,
    marketplace_items,
    root_item_id,
  };
}

// ===== 更新：标题 / 图片 / 尺寸重量 / 描述 =====

export interface ProductUpdatePayload {
  title?: string;
  pictures?: string[]; // 图片 URL 列表（全量替换）
  price?: string; // 价格（字符串，由后端转数字）
  weight?: string;
  length?: string;
  width?: string;
  height?: string;
  description?: string;
  site_id?: string; // CBT 更新描述需要目标市场站点（如 MLM）
}

export interface ProductUpdateResult {
  success: boolean;
  message: string;
  item?: any;
  descriptionResult?: any;
}

/**
 * 修改商品。
 * - 普通站点：标题/图片/尺寸走 PUT /items/{id}；描述走 PUT /items/{id}/description。
 * - CBT 全球售：所有字段（含描述）统一走 PUT /global/items/{id}，描述需额外带 site_id + logistic_type=remote。
 * 每个字段只在被显式提供（非空字符串）时才发送，避免误覆盖。
 * 参考：https://global-selling.mercadolibre.com/devsite/zh_cn/shang-pin-miao-shu
 */
export async function updateStoreItem(
  store: Store,
  itemId: string,
  payload: ProductUpdatePayload,
): Promise<ProductUpdateResult> {
  const site = (store.site || '').toUpperCase();
  const isCbt = site === 'CBT';
  const itemPath = isCbt ? `/global/items/${itemId}` : `/items/${itemId}`;

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

  // 价格：官方文档（CBT 全球售）确认 PUT /global/items/{id} 支持 price 字段。
  // 若商品带变体，价格必须按变体设置（为每个变体设置相同价格，且必须发送全部变体 id，
  // 漏发会被删除）；无变体则直接设顶层 price。
  if (typeof payload.price === 'string' && payload.price.trim() !== '') {
    const priceNum = Number(payload.price);
    if (Number.isFinite(priceNum) && priceNum > 0) {
      if (isCbt) {
        try {
          const cur = await ensureStoreTokenThen(store, `/items/${encodeURIComponent(itemId)}`);
          const variations = Array.isArray(cur?.variations) ? cur.variations : [];
          if (variations.length) {
            itemBody.variations = variations.map((v: any) => ({ id: v.id, price: priceNum }));
          } else {
            itemBody.price = priceNum;
          }
        } catch (e: any) {
          console.warn('[Products] 取当前商品查变体失败，按无变体处理 price:', e?.message?.slice(0, 120));
          itemBody.price = priceNum;
        }
      } else {
        itemBody.price = priceNum;
      }
    }
  }

  let item: any = null;
  let descriptionResult: any = null;
  let warningNote = '';

  if (isCbt) {
    // CBT：描述必须和主字段一起通过 /global/items/{id} 提交，且需要 site_id + logistic_type
    if (typeof payload.description === 'string') {
      const cbtSiteId = payload.site_id || 'MLM';
      itemBody.site_id = cbtSiteId;
      itemBody.logistic_type = 'remote';
      itemBody.description = { plain_text: payload.description };
    }
    if (Object.keys(itemBody).length) {
      console.log(`[Products] CBT PUT ${itemPath} body keys=${Object.keys(itemBody).join(',')}`);
      item = await storeApiMutate(store, 'PUT', itemPath, itemBody);
      descriptionResult = item;
      // 价格自动化开启时，price 可能被忽略（返回 200 + warning）
      const warns: any[] = item?.warnings || item?.cause || [];
      const priceWarn = warns.find((w) =>
        String(w?.message || w?.cause?.[0]?.message || w || '')
          .toLowerCase()
          .includes('price'),
      );
      if (priceWarn) {
        warningNote = '（价格可能被自动调价功能忽略，请在美客多后台确认实际价格）';
      }
    }
  } else {
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
