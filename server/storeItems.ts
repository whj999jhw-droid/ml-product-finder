/**
 * server/storeItems.ts
 * 美客多「全店商品索引」—— 两个页面共用：
 *  1. 妙手采集箱 → 视频生成 tab（列出在售商品，逐个/批量生成并上传视频）
 *  2. 商品管理（分店铺列出全部商品、按状态/违规风险筛选、查看全字段详情、一键改为合规）
 *
 * 为什么需要索引：
 *  单店 3000+ 件商品，逐件实时查接口既慢又浪费配额。这里一次性用
 *  `/users/{id}/items/search?search_type=scan`（offset 上限 1000，必须走 scroll）
 *  + `/items?ids=…&attributes=…`（每批 20，实测 0.15s）把标题/状态/属性拉全，
 *  计算侵权风险标记后落盘 data/ml-store-items.json，后续查询走内存。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Store, getStoreRaw, storeApiGet } from './stores.js';
import {
  hitsAnyRiskWord,
  ALL_RISK_WORDS,
  IP_BLACKLIST,
  SPORTS_BLACKLIST,
  BRAND_BLACKLIST,
  BANNED_WORDS_ES,
  BANNED_WORDS_PT,
  sanitizeComplianceText,
} from './bannedWords.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_FILE = path.join(__dirname, '..', 'data', 'ml-store-items.json');

// ============ 类型 ============

export type RiskLevel = 'none' | 'platform' | 'brand' | 'ip';

export interface RiskFieldHit {
  /** 属性 id（标题命中时为空） */
  id?: string;
  name?: string;
  value: string;
  hits: string[];
}

export interface StoreItemRisk {
  level: RiskLevel;
  /** 全部命中词（去重） */
  hits: string[];
  titleHits: string[];
  attrHits: RiskFieldHit[];
  /**
   * 能否「一键改为符合规范」：
   *  - true  仅命中品牌词 / 平台违禁词 → 洗掉即可继续卖
   *  - false 命中影视动漫游戏 IP 或体育赛事/球星 → 卖的就是 IP 本身，改名字也侵权，只能下架
   */
  fixable: boolean;
  message: string;
}

export interface StoreItemRow {
  id: string;
  title: string;
  /** active / paused / closed / under_review / inactive / not_yet_active */
  status: string;
  subStatus: string[];
  price: number;
  currencyId: string;
  availableQuantity: number;
  soldQuantity: number;
  condition?: string;
  listingTypeId?: string;
  categoryId?: string;
  sellerSku?: string;
  brand?: string;
  model?: string;
  thumbnail: string;
  pictures: string[];
  /** 各站点的本地 item id（如 MLM5707581750），用于拼真实商品链接 */
  siteItemIds: string[];
  dateCreated?: string;
  lastUpdated?: string;
  risk: StoreItemRisk;
  /** 关联到的妙手采集箱 detailId（用于找 1688 源视频；未关联为 undefined） */
  miaoshouDetailId?: string;
}

export interface StoreIndex {
  storeId: string;
  storeNick: string;
  site: string;
  builtAt: number;
  building: boolean;
  progress: { done: number; total: number };
  error?: string;
  items: StoreItemRow[];
  counts: {
    total: number;
    active: number;
    paused: number;
    risk: number;
    riskIp: number;
    riskBrand: number;
    riskPlatform: number;
  };
}

interface IndexFile {
  version: number;
  stores: Record<string, StoreIndex>;
}

// ============ 落盘 ============

let cache: IndexFile = load();

function load(): IndexFile {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const p = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
      if (p && p.stores) return p as IndexFile;
    }
  } catch (e: any) {
    console.error('[StoreItems] 索引读取失败:', e?.message || e);
  }
  return { version: 1, stores: {} };
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(cache));
  } catch (e: any) {
    console.error('[StoreItems] 索引写入失败:', e?.message || e);
  }
}

export function getIndex(storeId: string): StoreIndex | undefined {
  return cache.stores[storeId];
}

export function listIndexes(): StoreIndex[] {
  return Object.values(cache.stores);
}

// ============ 侵权风险扫描 ============

const IP_SET = new Set(IP_BLACKLIST.map((w) => w.toLowerCase()));
const SPORTS_SET = new Set(SPORTS_BLACKLIST.map((w) => w.toLowerCase()));
const BRAND_SET = new Set(BRAND_BLACKLIST.map((w) => w.toLowerCase()));

/** 命中的词按类别拆开（用 Set 成员判断，避免重复跑正则） */
function classifyHit(word: string): 'brand' | 'ip' | 'sports' | 'platform' {
  const w = word.toLowerCase();
  if (IP_SET.has(w)) return 'ip';
  if (SPORTS_SET.has(w)) return 'sports';
  if (BRAND_SET.has(w)) return 'brand';
  return 'platform';
}

const LEVEL_ORDER: Record<RiskLevel, number> = { none: 0, platform: 1, brand: 2, ip: 3 };

/**
 * 扫描一件商品（标题 + 全部属性值）的侵权/违禁风险。
 * 先粗筛（合并成一段文本跑一遍词库），命中后再逐字段定位，避免逐字段跑 250+ 词。
 */
export function scanItemRisk(
  title: string,
  attrs: Array<{ id?: string; name?: string; value_name?: string }> = [],
  site?: string,
): StoreItemRisk {
  const attrList = (attrs || []).filter((a) => typeof a?.value_name === 'string' && a.value_name);
  const combined = `${title || ''} ${attrList.map((a) => a.value_name).join(' ')}`.toLowerCase();

  const wordList =
    (site || '').toUpperCase() === 'MLB'
      ? [...ALL_RISK_WORDS, ...BANNED_WORDS_PT]
      : [...ALL_RISK_WORDS, ...BANNED_WORDS_ES];
  const uniqueWords = Array.from(new Set(wordList.map((w) => w.toLowerCase())));

  const hits: string[] = [];
  for (const w of uniqueWords) {
    if (hitsAnyRiskWord(combined, w)) hits.push(w);
  }
  if (hits.length === 0) {
    return { level: 'none', hits: [], titleHits: [], attrHits: [], fixable: true, message: '未命中侵权/违禁词' };
  }

  // 逐字段定位（只有命中商品才走这一趟）
  const hitSet = new Set(hits);
  const titleHits: string[] = [];
  const titleLower = (title || '').toLowerCase();
  for (const w of hitSet) if (hitsAnyRiskWord(titleLower, w)) titleHits.push(w);

  const attrHits: RiskFieldHit[] = [];
  for (const a of attrList) {
    const v = String(a.value_name);
    const vl = v.toLowerCase();
    const fh = [...hitSet].filter((w) => hitsAnyRiskWord(vl, w));
    if (fh.length) attrHits.push({ id: a.id, name: a.name, value: v, hits: fh });
  }

  const cats = new Set(hits.map(classifyHit));
  let level: RiskLevel = 'platform';
  if (cats.has('ip') || cats.has('sports')) level = 'ip';
  else if (cats.has('brand')) level = 'brand';
  else if (cats.has('platform')) level = 'platform';

  const fixable = level !== 'ip';
  const msgParts: string[] = [];
  if (level === 'ip') msgParts.push(`命中影视/动漫/游戏 IP 或体育赛事词 ${hits.length} 个：${hits.join(', ')}`);
  else if (level === 'brand') msgParts.push(`命中品牌词 ${hits.length} 个：${hits.join(', ')}`);
  else msgParts.push(`命中平台违禁词 ${hits.length} 个：${hits.join(', ')}`);
  if (attrHits.length) {
    msgParts.push(
      `（属性字段 ${attrHits.length} 处：${attrHits.map((a) => `${a.name || a.id}="${a.value}"`).join('；')}）`,
    );
  }
  return {
    level,
    hits,
    titleHits,
    attrHits,
    fixable,
    message: msgParts.join(''),
  };
}

// ============ 全店拉取 ============

const ITEM_TLD: Record<string, string> = {
  MLM: 'com.mx', MLB: 'com.br', MLC: 'cl', MCO: 'co', MLA: 'com.ar', MPE: 'com.pe', MPT: 'com.uy',
};

const BATCH_ATTRS =
  'id,title,status,sub_status,price,currency_id,available_quantity,sold_quantity,condition,' +
  'listing_type_id,category_id,seller_custom_field,thumbnail,pictures,attributes,date_created,last_updated';

/** 并发池 */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 分页拉全店 item id（search_type=scan + scroll_id） */
async function fetchAllItemIds(store: Store): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let scrollId = '';
  for (let page = 0; page < 200; page++) {
    const qs = scrollId
      ? `search_type=scan&scroll_id=${encodeURIComponent(scrollId)}&limit=100`
      : 'search_type=scan&limit=100';
    const d = await storeApiGet(store, `/users/${store.mlUserId}/items/search?${qs}`, 2);
    for (const id of d?.results || []) {
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    scrollId = d?.scroll_id || '';
    if (!scrollId || !(d?.results || []).length) break;
  }
  return ids;
}

function toRow(store: Store, raw: any): StoreItemRow {
  const attrs: Array<{ id?: string; name?: string; value_name?: string }> = raw?.attributes || [];
  const attrVal = (id: string) =>
    attrs.find((a) => String(a?.id || '').toUpperCase() === id)?.value_name || undefined;
  const pictures = (raw?.pictures || []).map((p: any) => p?.secure_url || p?.url).filter(Boolean);
  const siteItemIds = (raw?.marketplace_items || []).map((m: any) => m?.item_id).filter(Boolean);
  return {
    id: String(raw?.id || ''),
    title: String(raw?.title || ''),
    status: String(raw?.status || ''),
    subStatus: Array.isArray(raw?.sub_status) ? raw.sub_status : [],
    price: Number(raw?.price) || 0,
    currencyId: String(raw?.currency_id || 'USD'),
    availableQuantity: Number(raw?.available_quantity) || 0,
    soldQuantity: Number(raw?.sold_quantity) || 0,
    condition: raw?.condition,
    listingTypeId: raw?.listing_type_id,
    categoryId: raw?.category_id,
    sellerSku: raw?.seller_custom_field || undefined,
    brand: attrVal('BRAND'),
    model: attrVal('MODEL'),
    thumbnail: String(raw?.thumbnail || pictures[0] || ''),
    pictures: pictures.slice(0, 10),
    siteItemIds,
    dateCreated: raw?.date_created,
    lastUpdated: raw?.last_updated,
    risk: scanItemRisk(String(raw?.title || ''), attrs, store.site),
  };
}

function summarize(items: StoreItemRow[]): StoreIndex['counts'] {
  const c = { total: items.length, active: 0, paused: 0, risk: 0, riskIp: 0, riskBrand: 0, riskPlatform: 0 };
  for (const it of items) {
    if (it.status === 'active') c.active++;
    if (it.status !== 'active') c.paused++;
    if (it.risk.level !== 'none') {
      c.risk++;
      if (it.risk.level === 'ip') c.riskIp++;
      else if (it.risk.level === 'brand') c.riskBrand++;
      else c.riskPlatform++;
    }
  }
  return c;
}

/** 索引构建状态（供前端轮询进度） */
const building = new Set<string>();

export function isBuilding(storeId: string): boolean {
  return building.has(storeId);
}

/**
 * 构建/重建某店铺索引（幂等：同一店铺并发调用只跑一次）。
 * @param onProgress 进度回调（done/total）
 */
export async function buildIndex(
  storeId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<StoreIndex> {
  const store = getStoreRaw(storeId);
  if (!store) throw new Error('店铺不存在');
  if (building.has(storeId)) {
    const cur = cache.stores[storeId];
    if (cur) return cur;
  }
  building.add(storeId);
  const prev = cache.stores[storeId];
  const shell: StoreIndex = {
    storeId,
    storeNick: store.nickname || storeId.slice(0, 8),
    site: store.site,
    builtAt: prev?.builtAt || 0,
    building: true,
    progress: { done: 0, total: 0 },
    items: prev?.items || [],
    counts: prev?.counts || { total: 0, active: 0, paused: 0, risk: 0, riskIp: 0, riskBrand: 0, riskPlatform: 0 },
  };
  cache.stores[storeId] = shell;
  try {
    const ids = await fetchAllItemIds(store);
    shell.progress = { done: 0, total: ids.length };
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 20) batches.push(ids.slice(i, i + 20));

    const rows: StoreItemRow[] = [];
    let done = 0;
    await pool(batches, 8, async (batch) => {
      try {
        const resp: any = await storeApiGet(
          store,
          `/items?ids=${batch.join(',')}&attributes=${BATCH_ATTRS}`,
          2,
        );
        for (const entry of Array.isArray(resp) ? resp : []) {
          const body = entry?.body || entry;
          if (body?.id) rows.push(toRow(store, body));
        }
      } catch (e: any) {
        console.warn(`[StoreItems] 批次拉取失败（${batch.length} 件）: ${e?.message?.slice(0, 120)}`);
      }
      done += batch.length;
      shell.progress = { done: Math.min(done, ids.length), total: ids.length };
      onProgress?.(shell.progress.done, shell.progress.total);
    });

    // 保持与妙手列表一致：新上架的排前面
    rows.sort((a, b) => String(b.dateCreated || '').localeCompare(String(a.dateCreated || '')));
    shell.items = rows;
    shell.counts = summarize(rows);
    shell.builtAt = Date.now();
    shell.building = false;
    shell.error = undefined;
    console.log(`[StoreItems] ${store.nickname} 索引完成：${rows.length} 件（在售 ${shell.counts.active} / 风险 ${shell.counts.risk}）`);
  } catch (e: any) {
    shell.building = false;
    shell.error = e?.message || String(e);
    console.error(`[StoreItems] ${store.nickname} 索引构建失败: ${shell.error}`);
  } finally {
    building.delete(storeId);
    persist();
  }
  return shell;
}

/** 索引新鲜度内直接用缓存，否则重建 */
export async function ensureIndex(storeId: string, maxAgeMs = 10 * 60 * 1000): Promise<StoreIndex> {
  const cur = cache.stores[storeId];
  if (cur && !cur.building && cur.items.length && Date.now() - cur.builtAt < maxAgeMs) return cur;
  if (cur?.building) return cur;
  return buildIndex(storeId);
}

// ============ 查询 ============

export interface ListFilter {
  status?: 'all' | 'active' | 'paused';
  risk?: 'all' | 'none' | 'risk' | 'ip' | 'brand' | 'platform';
  q?: string;
  page?: number;
  pageSize?: number;
  /** 只保留有关联妙手 detailId 的（视频 tab 用不到，商品管理用不到，留作扩展） */
  onlyLinked?: boolean;
}

export function listItems(storeId: string, f: ListFilter = {}): {
  total: number;
  page: number;
  pageSize: number;
  items: StoreItemRow[];
} {
  const idx = cache.stores[storeId];
  if (!idx) return { total: 0, page: 1, pageSize: f.pageSize || 50, items: [] };
  let rows = idx.items;

  if (f.status === 'active') rows = rows.filter((r) => r.status === 'active');
  else if (f.status === 'paused') rows = rows.filter((r) => r.status !== 'active');

  if (f.risk && f.risk !== 'all') {
    if (f.risk === 'none') rows = rows.filter((r) => r.risk.level === 'none');
    else if (f.risk === 'risk') rows = rows.filter((r) => r.risk.level !== 'none');
    else rows = rows.filter((r) => r.risk.level === f.risk);
  }
  if (f.onlyLinked) rows = rows.filter((r) => !!r.miaoshouDetailId);

  const q = (f.q || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.sellerSku || '').toLowerCase().includes(q) ||
        (r.brand || '').toLowerCase().includes(q) ||
        (r.model || '').toLowerCase().includes(q),
    );
  }

  // 上限放宽：视频 tab 的「来源筛选」需要全量扫描后再切片
  const pageSize = Math.min(Math.max(f.pageSize || 50, 1), 20000);
  const page = Math.max(f.page || 1, 1);
  return { total: rows.length, page, pageSize, items: rows.slice((page - 1) * pageSize, page * pageSize) };
}

/** 商品真实链接：CBT 父 ID 推不出站点域名，必须用 marketplace_items 里的本地 item id */
export function itemPermalink(row: Pick<StoreItemRow, 'siteItemIds'>): string {
  const sid = (row.siteItemIds || [])[0];
  if (!sid) return '';
  const tld = ITEM_TLD[sid.slice(0, 3)] || 'com.mx';
  return `https://www.mercadolibre.${tld}/p/${sid}`;
}

// ============ 单件全字段详情 ============

export interface StoreItemFullDetail {
  row: StoreItemRow | null;
  raw: any;
  description: string;
  marketplaceItems: any[];
  permalink: string;
  risk: StoreItemRisk;
  /** 建议的合规化结果（dry-run），供「一键改为符合规范」预览 */
  suggested: { title: string; attributeChanges: Array<{ id?: string; name?: string; from: string; to: string }> };
  /** 取数过程中部分接口失败的原因（有值时前端提示） */
  _errors?: string[];
}

/** 取单件商品的全部字段（/items/{id} + /description + /marketplace/items/{id}） */
export async function getItemFullDetail(storeId: string, itemId: string): Promise<StoreItemFullDetail> {
  const store = getStoreRaw(storeId);
  if (!store) throw new Error('店铺不存在');
  const idx = cache.stores[storeId];
  const cached = idx?.items.find((r) => r.id === itemId) || null;

  let raw: any = null;
  let description = '';
  let marketplaceItems: any[] = [];
  const errors: string[] = [];

  try {
    raw = await storeApiGet(store, `/items/${encodeURIComponent(itemId)}`, 2);
  } catch (e: any) {
    errors.push(`/items: ${e?.message?.slice(0, 160)}`);
  }
  // CBT 商品属性/本地站点信息只在 /marketplace/items 里返回（响应是 206）
  try {
    const mp = await storeApiGet(store, `/marketplace/items/${encodeURIComponent(itemId)}`, 2);
    marketplaceItems = mp?.marketplace_items || [];
    if (!raw) raw = mp;
    else if (!(raw.attributes || []).length && mp?.attributes) raw.attributes = mp.attributes;
    if (!marketplaceItems.length && mp?.marketplace_items) marketplaceItems = mp.marketplace_items;
  } catch (e: any) {
    errors.push(`/marketplace/items: ${e?.message?.slice(0, 160)}`);
  }
  try {
    const d = await storeApiGet(store, `/items/${encodeURIComponent(itemId)}/description`, 2);
    description = d?.plain_text || '';
  } catch (e: any) {
    errors.push(`/description: ${e?.message?.slice(0, 120)}`);
  }

  const row = raw ? toRow(store, { ...raw, marketplace_items: marketplaceItems }) : cached;
  const risk = row?.risk || scanItemRisk('', [], store.site);

  const suggested = row
    ? buildCompliancePreview(row.title, (raw?.attributes || []) as any[])
    : { title: '', attributeChanges: [] };

  return {
    row,
    raw: raw || {},
    description,
    marketplaceItems,
    permalink: row ? itemPermalink(row) : '',
    risk,
    suggested,
    ...(errors.length ? { _errors: errors } : {}),
  } as StoreItemFullDetail;
}

/** 生成「合规化预览」：新标题 + 需要改的属性 */
export function buildCompliancePreview(
  title: string,
  attrs: Array<{ id?: string; name?: string; value_name?: string }>,
): { title: string; attributeChanges: Array<{ id?: string; name?: string; from: string; to: string }> } {
  const newTitle = sanitizeComplianceText(title || '').slice(0, 60);
  const attributeChanges: Array<{ id?: string; name?: string; from: string; to: string }> = [];
  for (const a of attrs || []) {
    const v = a?.value_name;
    if (typeof v !== 'string' || !v) continue;
    if (/sku|gtin|upc|ean|mpn|part ?number|isbn|seal|fiscal/i.test(`${a.id || ''} ${a.name || ''}`)) continue;
    const nv = sanitizeComplianceText(v) || 'Generic';
    if (nv !== v) attributeChanges.push({ id: a.id, name: a.name, from: v, to: nv });
  }
  return { title: newTitle || 'Producto generico', attributeChanges };
}
