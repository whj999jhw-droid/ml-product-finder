/**
 * M3：合规上架到美客多（CBT 全球售：POST /global/items）
 * 合规红线：只用你自己的标题/描述/图片/品牌；绝不复制竞品销量、评论、原图。
 * CBT 全球售规则（来自 global-selling.mercadolibre.com 官方文档，勿猜）：
 *  - 创建必须 POST /global/items（绝不用本地 /items，否则不符合 CBT 模型、不会复制到本地市场）。
 *  - 图片必须传 {id}（不是 {source}）；外部/1688 图先 POST /pictures/items/upload 取 id。
 *  - 价格按国家写在 sites_to_sell[]（USD）；不要单站点顶层 price。
 *  - 包裹尺寸/重量用 attributes PACKAGE_HEIGHT/WIDTH/LENGTH/WEIGHT（"10 cm"/"500 g"）；
 *    不要用 shipping.dimensions（仅本地站有效）。品牌/模型/成色用 BRAND/MODEL/ITEM_CONDITION。
 *  - 注意：官方两份文档对「创建时 pictures 放根级 vs 放进 sites_to_sell 内部」说法矛盾，
 *    本实现按 global-listing 主文档放根级（与 PUT /global/items 更新路径一致）；若 API 报
 *    pictures schema 错，将其移入 sites_to_sell[].pictures 再联调。
 */
import { getAccessToken } from './mercadolibre.js';
import { checkBannedWords } from './bannedWords.js';
import { getStoreRaw, ensureStoreToken } from './stores.js';
import { generateSellerSku } from './db.js';

export interface ListingDraft {
  site: string; // MLM / MLB / MLC / MCO
  storeId?: string; // 多店铺：指定用哪个店铺的 write token 上架（不传则回退全局 token）
  title: string;
  category_id: string;
  price: number;
  currency_id?: string; // 不传则按站点自动取
  available_quantity: number;
  description: string;
  pictureUrls: string[]; // 公网可访问的图片 URL（必须是你自有/已授权的图）
  brand: string; // 你的品牌或 Generic
  model?: string; // 模型（可选，对应 MODEL attribute）
  /** 卖家自定义 SKU 编号（美客多 seller_custom_field / seller_sku）。不传则自动生成 */
  seller_custom_field?: string;
  /** 多 SKU（规格）：标题来自 1688 SKU 标题，图片来自 1688 SKU 图片（取不到时回退主图） */
  skus?: Array<{ title: string; imageUrl: string }>;
  weight?: number;
  height?: number;
  width?: number;
  length?: number;
  // 保修（sale_terms）一般可选：仅在调用方显式提供时才发送，默认不强制填写
  warrantyType?: string; // 如 'Factory warranty' / 'No warranty'
  warrantyTime?: string; // 如 '90 days' / '1 year'
  listing_type_id?: string; // CBT: gold_special (Classic) / gold_pro (Premium)
  // 类目属性（ML category attributes），会与系统默认属性合并；相同 id 时外部值优先
  attributes?: Array<{ id: string; value_id?: string; value_name?: string; values?: any[] }>;
  // 多国售价/类型覆盖：若提供，则覆盖默认单条 sites_to_sell，实现逐国家独立定价与 listing_type
  sites_to_sell?: Array<{
    site_id: string;
    price: number;
    listing_type_id?: string;
    title?: string;
    attributes?: Array<{ id: string; value_id?: string; value_name?: string; values?: any[] }>;
  }>;
}

export interface PrecheckResult {
  ok: boolean;
  hits: string[];
  message: string;
}

export function precheckCompliance(draft: Partial<ListingDraft>): PrecheckResult {
  const hits: string[] = [];
  const text = `${draft.title || ''} ${draft.brand || ''} ${draft.description || ''}`;
  const banned = checkBannedWords(text, draft.site);
  for (const b of banned.brandHits) hits.push(`品牌侵权词: ${b}`);
  for (const w of banned.wordHits) hits.push(`平台违禁词: ${w}`);
  if (!draft.title || draft.title.trim().length < 5) hits.push('标题过短或为空（须为你自己撰写）');
  if (!draft.pictureUrls || draft.pictureUrls.length === 0) hits.push('未提供商品图片（须为你自有/已授权图，禁止盗用竞品原图）');
  if (!draft.description || draft.description.trim().length < 5) hits.push('描述过短或为空');
  return {
    ok: hits.length === 0,
    hits,
    message: hits.length ? `命中 ${hits.length} 项需确认：${hits.join(', ')}` : '合规预检通过',
  };
}

// ===== CBT 图片 id 解析 =====
// 把外部/1688 图片 URL 或 ML 图片 URL 解析为 CBT 可用的 picture id。
function looksLikeMlPictureId(s: string): boolean {
  return /^\d+-[A-Z]{2,3}\d+_[\d]{6}$/i.test(s.trim());
}
function extractPictureIdFromUrl(url: string): string | undefined {
  // 形如 https://http2.mlstatic.com/D_xxxx-MLM456_112021-O.jpg → xxxx-MLM456_112021
  const m = String(url).match(/D_[NQNP]_?([\d-]+-[A-Z]{2,3}\d+_\d{6})/i)
    || String(url).match(/([\d-]+-[A-Z]{2,3}\d+_\d{6})/i);
  return m ? m[1] : undefined;
}
async function resolvePictureId(url: string, token: string): Promise<string | undefined> {
  const u = (url || '').trim();
  if (!u) return undefined;
  if (looksLikeMlPictureId(u)) return u;
  const fromUrl = extractPictureIdFromUrl(u);
  if (fromUrl) return fromUrl;
  // 外部 URL：先上传到 ML 图床取 id（CBT 必须传 id）
  try {
    const imgResp = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
    if (!imgResp.ok) return undefined;
    const blob = await imgResp.blob();
    const form: any = new FormData();
    form.append('file', blob, 'image.jpg');
    const up = await fetch('https://api.mercadolibre.com/pictures/items/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!up.ok) return undefined;
    const d = await up.json();
    return d?.id;
  } catch {
    return undefined;
  }
}

// ===== 类目预测与必填属性补齐（2026-09-04）=====
// 妙手返回的 cid 是妙手内部类目 ID（如 1015338），不是 ML 类目；发布前需用标题预测真实 ML 类目。
const categoryPredictionCache = new Map<string, string>();
async function predictCategoryId(token: string, site: string, title: string): Promise<string | undefined> {
  const key = `${site}|${title}`;
  const cached = categoryPredictionCache.get(key);
  if (cached) return cached;
  try {
    const resp = await fetch(
      `https://api.mercadolibre.com/sites/${site}/domain_discovery/search?limit=1&q=${encodeURIComponent(title)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return undefined;
    const list = await resp.json();
    const cid = list?.[0]?.category_id;
    if (cid) {
      categoryPredictionCache.set(key, cid);
      return cid;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

const categoryAttrsCache = new Map<string, any[]>();
async function getCategoryAttributes(token: string, categoryId: string): Promise<any[]> {
  const cached = categoryAttrsCache.get(categoryId);
  if (cached) return cached;
  try {
    const resp = await fetch(`https://api.mercadolibre.com/categories/${categoryId}/attributes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return [];
    const list = await resp.json();
    categoryAttrsCache.set(categoryId, list);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// 这些属性由 createListing 统一处理，不参与枚举兜底
const HANDLED_ATTR_IDS = new Set([
  'BRAND', 'MODEL', 'ITEM_CONDITION', 'UPC', 'EAN',
  'PACKAGE_HEIGHT', 'PACKAGE_WIDTH', 'PACKAGE_LENGTH', 'PACKAGE_WEIGHT',
  'WARRANTY_TYPE', 'WARRANTY_TIME',
]);

export async function createListing(draft: ListingDraft, tokenOverride?: string): Promise<{ itemId: string; permalink: string; siteItems?: any[] }> {
  // 多店铺：优先用传入的店铺 token；其次按 draft.storeId 取对应店铺 token；最后回退全局 token
  let token = tokenOverride;
  if (!token && draft.storeId) {
    const store = getStoreRaw(draft.storeId);
    if (store) token = await ensureStoreToken(store);
  }
  if (!token) token = getAccessToken();
  if (!token) {
    throw new Error('未获取到卖家 write token，请先在「店铺管理」中添加并授权店铺（需含 write scope），或先在设置页完成全局授权');
  }

  // 图片：CBT 支持直接传 source URL（官方文档示例），也支持先上传图床取 id。
  // 优先尝试 source URL，若后续 API 报错再切到 id 模式。
  const pictures: any[] = [];
  for (const u of draft.pictureUrls || []) {
    const id = await resolvePictureId(u, token);
    if (id) {
      pictures.push({ id });
    } else if (u.startsWith('http')) {
      pictures.push({ source: u });
    } else {
      console.warn(`[Listing] 无法解析/上传图片，已跳过: ${u}`);
    }
  }

  // attributes：品牌 / 模型 / 成色 / 包裹尺寸重量（CBT 用 PACKAGE_*，不用 shipping.dimensions）
  const baseAttributes: any[] = [];
  baseAttributes.push({ id: 'BRAND', value_name: draft.brand || 'Generic' });
  if (draft.model) baseAttributes.push({ id: 'MODEL', value_name: draft.model });
  // CBT 用 ITEM_CONDITION attribute 替代旧 condition 字段（New 的 value_id 为官方值 2230284）
  baseAttributes.push({ id: 'ITEM_CONDITION', value_id: '2230284', value_name: 'New' });
  const addPkg = (id: string, val: number | undefined, unit: string) => {
    if (val != null && val > 0) baseAttributes.push({ id, value_name: `${val} ${unit}` });
  };
  addPkg('PACKAGE_HEIGHT', draft.height, 'cm');
  addPkg('PACKAGE_WIDTH', draft.width, 'cm');
  addPkg('PACKAGE_LENGTH', draft.length, 'cm');
  addPkg('PACKAGE_WEIGHT', draft.weight, 'g');

  // 合并外部传入的类目属性（相同 id 外部优先）
  const mergeAttributes = (extra?: any[]) => {
    const map = new Map<string, any>();
    for (const a of baseAttributes) map.set(a.id, a);
    for (const a of extra || []) {
      if (a?.id) map.set(a.id, a);
    }
    return Array.from(map.values());
  };
  const attributes = mergeAttributes(draft.attributes);

  // 类目：CBT 全球售必须用 CBT 命名空间的类目（如 CBT10626）。
  // 妙手 cid（如 10110626）是妙手内部类目 ID，直接用会被判 category_id invalid，需按标题走 domain_discovery(CBT) 预测。
  let categoryId = draft.category_id;
  if (!categoryId || !/^(CBT\d+|ML[A-Z]{3}\d+)$/.test(categoryId)) {
    const predicted = await predictCategoryId(token, 'CBT', draft.title);
    if (predicted) {
      console.log(`[Listing] 类目自动预测: ${draft.category_id || '(空)'} -> ${predicted}（标题: ${draft.title.slice(0, 40)}）`);
      categoryId = predicted;
    }
  }

  // 补齐类目必填属性：缺失的 required 枚举属性用第一个可选值兜底，避免 body.required_fields 报错
  // （兜底值仅供参考，发布后可在美客多后台修改）
  if (categoryId && /^ML/.test(categoryId)) {
    const catAttrs = await getCategoryAttributes(token, categoryId);
    const haveIds = new Set(attributes.map((a) => a?.id));
    for (const ca of catAttrs) {
      const id = ca?.id;
      if (!id || haveIds.has(id) || HANDLED_ATTR_IDS.has(id)) continue;
      const required = ca?.tags?.required || ca?.required;
      const values = ca?.values || [];
      if (required && values.length > 0) {
        attributes.push({ id, value_id: values[0].id, value_name: values[0].name });
        haveIds.add(id);
        console.log(`[Listing] 补必填属性 ${id}=${values[0].name}（类目 ${categoryId}，可在后台修改）`);
      }
    }
  }

  // 多 SKU（规格）：把 1688 识别到的 SKU 标题附到描述，便于买家与后台核对；图片写入 pictureUrls
  let descriptionText = draft.description || '';
  if (draft.skus && draft.skus.length) {
    const skuLines = draft.skus.map((s, i) => `${i + 1}. ${s.title || '-'}`).join('\n');
    descriptionText = `${descriptionText}\n\nEspecificaciones disponibles (SKU):\n${skuLines}`;
    // 把每个 SKU 的图片（若有且为公网地址）一并加入图床，最多补充到 6 张
    for (const s of draft.skus) {
      if (s.imageUrl && s.imageUrl.startsWith('http') && draft.pictureUrls.length < 6 && !draft.pictureUrls.includes(s.imageUrl)) {
        draft.pictureUrls.push(s.imageUrl);
      }
    }
  }

  // CBT 创建：POST /global/items，价格按国家写在 sites_to_sell（USD）
  // sale_terms 是 body 必填字段（缺失/空数组会报 body.required_fields: [sale_terms]）。
  // 元素格式是官方定义的 { id, value_id } 或 { id, value_name }（不是 { KEY: value }）。
  // 合法值来自 GET /categories/{category_id}/sale_terms，WARRANTY_TYPE 取值：
  //   2230280 Seller warranty / 2230279 Factory warranty / 6150835 No warranty
  // 无保修信息时默认 No warranty，保证 schema 校验通过。
  const saleTerms: any[] = [];
  if (draft.warrantyType) saleTerms.push({ id: 'WARRANTY_TYPE', value_name: draft.warrantyType });
  if (draft.warrantyTime) saleTerms.push({ id: 'WARRANTY_TIME', value_name: draft.warrantyTime });
  if (saleTerms.length === 0) saleTerms.push({ id: 'WARRANTY_TYPE', value_id: '6150835' });

  const payload: any = {
    title: draft.title, // CBT 要求英文标题（全局）
    currency_id: 'USD', // CBT 一律 USD
    catalog_listing: false,
    category_id: categoryId, // 预测后的真实 ML 类目
    available_quantity: draft.available_quantity,
    description: { plain_text: descriptionText },
    pictures,
    // 卖家自定义 SKU 编号：自动生成或调用方传入；用于与美客多后台 seller_sku 对应追踪
    seller_custom_field: draft.seller_custom_field || generateSellerSku(draft.site),
    attributes,
    sale_terms: saleTerms,
    sites_to_sell:
      draft.sites_to_sell && draft.sites_to_sell.length > 0
        ? draft.sites_to_sell.map((s) => ({
            site_id: s.site_id,
            logistic_type: 'remote',
            title: s.title || draft.title,
            price: s.price,
            listing_type_id: s.listing_type_id || draft.listing_type_id || 'gold_special',
            ...(s.attributes?.length ? { attributes: mergeAttributes(s.attributes) } : {}),
          }))
        : [
            {
              site_id: draft.site,
              logistic_type: 'remote',
              title: draft.title,
              price: draft.price,
              listing_type_id: draft.listing_type_id || 'gold_special',
            },
          ],
  };

  // 发布诊断日志：便于定位 ML 校验报错（类目/必填属性/sale_terms/站点）
  console.log(
    `[Listing] 请求创建: category=${categoryId} sale_terms=${JSON.stringify(saleTerms)} attrs=${attributes.map((a) => a.id).join(',')} sites=${JSON.stringify((payload.sites_to_sell || []).map((s: any) => s.site_id))} title=${draft.title.slice(0, 50)}`
  );

  const resp = await fetch('https://api.mercadolibre.com/global/items', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) {
    // 完整打印 ML 错误响应，便于定位 required_fields / invalid value 等细节
    console.error(`[Listing] ML 创建失败 HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 2000)}`);
    const cause = data?.cause?.[0]
      ? `${data.cause[0].type || ''}: ${data.cause[0].message || data.cause[0].code || ''}`.trim()
      : '';
    const msg = data?.message || data?.error || cause || '上架失败';
    const err: any = new Error(`上架失败 [${resp.status}]: ${msg}${cause ? ` (${cause})` : ''}`);
    err.status = resp.status;
    err.mlError = data;
    throw err;
  }
  // 打印 ML 返回体：确认 id / site_items 结构，便于回填每站点 itemId
  console.log(`[Listing] ML 创建成功返回: ${JSON.stringify(data).slice(0, 800)}`);
  // CBT /global/items 返回顶层 item_id（不是 id）+ site_items[]（每站点独立 item_id）
  const siteItems: any[] = Array.isArray(data.site_items) ? data.site_items : [];
  const firstSite = siteItems[0];
  return {
    itemId: data.item_id ?? data.id,
    // ML 不返回 permalink 时按第一个站点 item_id 拼可点击链接
    permalink: data.permalink || (firstSite?.item_id ? `https://www.mercadolibre.com/p/${firstSite.item_id}` : undefined),
    siteItems,
  };
}

// ============ 批量上架发布器（参考文档 listingPublisher 设计）============
export interface BatchPublishItemResult {
  index: number;
  title: string;
  site: string;
  success: boolean;
  itemId?: string;
  permalink?: string;
  error?: string;
  attempts: number;
  precheckHits?: string[];
  skipped?: boolean; // 因站点与所选店铺不符被跳过
  storeId?: string;
}

export interface BatchPublishResult {
  total: number;
  succeeded: number;
  failed: number;
  blocked: number; // 预检拦截数
  skipped: number; // 站点与所选店铺不符被跳过数
  results: BatchPublishItemResult[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 批量上架：每站点并发 3、429/5xx 指数退避 + 抖动、maxRetries=3。
 * 每条先跑合规预检，命中即拦截（不消耗 API 配额）。
 */
export async function publishBatch(
  drafts: ListingDraft[],
  opts?: {
    concurrency?: number;
    maxRetries?: number;
    onProgress?: (done: number, total: number, last?: BatchPublishItemResult) => void;
    token?: string; // 多店铺：该批统一使用的店铺 write token
    storeSite?: string; // 多店铺：所选店铺站点，草稿站点与之不符则跳过
    storeId?: string;
  }
): Promise<BatchPublishResult> {
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 3, 5));
  const maxRetries = opts?.maxRetries ?? 3;
  const results: BatchPublishItemResult[] = [];
  let done = 0;

  // 按站点分组，各站点内部串行分片、组间并发（对单站点限速最友好）
  const queue = drafts.map((d, i) => ({ d, i }));

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      const { d, i } = job;
      const item: BatchPublishItemResult = {
        index: i,
        title: d.title || '',
        site: d.site || '',
        success: false,
        attempts: 0,
        skipped: false,
        storeId: opts?.storeId,
      };

      // 0) 站点校验：多店铺模式下，草稿站点必须与所选店铺站点一致
      if (opts?.storeSite && d.site && d.site !== opts.storeSite) {
        item.skipped = true;
        item.success = false;
        item.attempts = 0;
        item.error = `站点与所选店铺不符（草稿站点 ${d.site}，店铺站点 ${opts.storeSite}），已跳过`;
        results.push(item);
        done++;
        opts?.onProgress?.(done, drafts.length, item);
        continue;
      }

      // 1) 合规预检（本地，不耗配额）
      const pre = precheckCompliance(d);
      if (!pre.ok) {
        item.error = `合规预检未通过：${pre.message}`;
        item.precheckHits = pre.hits;
        results.push(item);
        done++;
        opts?.onProgress?.(done, drafts.length, item);
        continue;
      }

      // 2) 带退避的上架重试
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        item.attempts = attempt;
        try {
          const r = await createListing(d, opts?.token);
          item.success = true;
          item.itemId = r.itemId;
          item.permalink = r.permalink;
          break;
        } catch (err: any) {
          const status = err?.status;
          const retriable = status === 429 || (status >= 500 && status < 600);
          item.error = err?.message || '未知错误';
          if (!retriable || attempt > maxRetries) break;
          // 指数退避 + 抖动：2^attempt 秒 + 0~1s 随机
          const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          await sleep(backoffMs);
        }
      }
      results.push(item);
      done++;
      opts?.onProgress?.(done, drafts.length, item);
      // 温和限速：条间固定间隔 500ms
      await sleep(500);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  results.sort((a, b) => a.index - b.index);
  const succeeded = results.filter((r) => r.success).length;
  const blocked = results.filter((r) => !r.success && r.precheckHits?.length).length;
  const skipped = results.filter((r) => r.skipped).length;
  return {
    total: drafts.length,
    succeeded,
    failed: results.length - succeeded - blocked - skipped,
    blocked,
    skipped,
    results,
  };
}

/** 查询卖家剩余可上架配额（best-effort，接口不可用时返回 null） */
export async function getListingQuota(): Promise<{ available: boolean; detail: any } | null> {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const meResp = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meResp.ok) return null;
    const me: any = await meResp.json();
    const capResp = await fetch(`https://api.mercadolibre.com/marketplace/users/${me.id}/cap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!capResp.ok) {
      return { available: false, detail: { status: capResp.status, sellerId: me.id, nickname: me.nickname } };
    }
    const cap = await capResp.json();
    return { available: true, detail: cap };
  } catch {
    return null;
  }
}
