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
  getItemSiteStatus,
  getItemSiteStatusBatch,
  clearStoreSiteCache,
  type SiteState,
} from './mlSiteStatus.js';
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
  /**
   * 真实售卖状态：由 `/users/{id}/items/search?status=` 过滤得出（active / paused）。
   * ⚠️ 不能用 `/items?ids=` 返回的 status —— 实测它对本店 3000+ 件常年全是 active，
   * 导致「已被美客多暂停」的商品仍在列表里显示（用户已反馈）。
   */
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
  /** ML 商品页链接（CBT 商品自带；批量接口拿不到 marketplace_items，只能靠它） */
  mlPermalink?: string;
  dateCreated?: string;
  lastUpdated?: string;
  risk: StoreItemRisk;
  /**
   * CBT 商品自身返回的 status。
   * ⚠️ CBT 子母商品模式下它常年是 active，**不能**当作「是否在售」依据，
   * 真正的售卖状态看下面的 `status`（由搜索接口 status= 过滤得出）。
   */
  cbtStatus?: string;
  /**
   * 同款去重键：优先 SELLER_SKU（= 1688 商品ID_规格），缺失时退化为规范化标题前缀。
   * 实测同一件 1688 商品被重复上架时 SELLER_SKU 完全相同，可精准识别重复 listing。
   */
  dupKey?: string;
  /** 关联到的妙手采集箱 detailId（用于找 1688 源视频；未关联为 undefined） */
  miaoshouDetailId?: string;
  /**
   * ★ 站点级真实售卖状态（MLM/MLB/MLC/MCO → active|paused|inactive）。
   * `status` 只反映 CBT 父商品在父账号搜索接口里的归属，
   * 而买家看到的是**各站点本地 listing** —— 实测存在「父状态 active、4 个站点全部未激活」
   * 的链接（用户反馈「两条重复链接里只有一条是激活的」就是这个原因）。
   */
  siteStatus?: Record<string, SiteState>;
  activeSites?: string[];
  pausedSites?: string[];
  inactiveSites?: string[];
  /** 至少一个站点在售 = 买家真能看到 */
  onSale?: boolean;
  /** 被美客多禁止的站点（sub_status 含 forbidden/blocked/suspended） */
  blockedSites?: string[];
  /** 审核中但未被禁的站点 */
  reviewSites?: string[];
  /** 中文原因，如「MLM 被美客多禁止」 */
  reasons?: string[];
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
    /** 站点级口径：至少一个站点在售 / 全部站点未激活（被平台下架、买家看不到） */
    onSale: number;
    offShelf: number;
    /** 至少一个站点被美客多禁止（forbidden） */
    blocked: number;
    /** 全部站点都被禁止 —— 这类链接已经救不回来，应考虑下架重发 */
    allBlocked?: number;
    /** 同款重复链接（同一 SKU 多 listing）合并掉的条数 */
    mergedAway?: number;
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
  'listing_type_id,category_id,seller_custom_field,thumbnail,pictures,attributes,date_created,last_updated,' +
  // marketplace_items 批量接口取不到（实测请求了也不返回），
  // 所以商品真实链接改用 CBT 商品自带的 permalink 字段
  'permalink';

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

/**
 * 按售卖状态拉全量 item id 集合。
 * `/users/{id}/items/search?status=active|paused` 是 ML 判定的**真实售卖状态**
 * （会把已被平台暂停/下架的商品排除出 active），这是 `/items?ids=` 拿不到的。
 */
async function fetchIdSetByStatus(store: Store, status: string): Promise<Set<string>> {
  const set = new Set<string>();
  // ⚠️ 必须用 search_type=scan + scroll_id 翻页：
  //    ML 的普通分页有 `offset + limit ≤ 1000` 硬限制，本店 3000+ 件，
  //    直接 offset 翻到 1000 就会 400 `Invalid limit and offset values`。
  // 实测（瑞桥万汇）：全量 scan 3799 件 = scan(status=active) 3796 + scan(status=paused) 3，
  //    两个集合互不相交、并集等于全集 → 这套口径可以放心用来判「是否还在卖」。
  let scrollId = '';
  for (let page = 0; page < 200; page++) {
    const qs = scrollId
      ? `status=${status}&search_type=scan&scroll_id=${encodeURIComponent(scrollId)}&limit=100`
      : `status=${status}&search_type=scan&limit=100`;
    const d: any = await storeApiGet(store, `/users/${store.mlUserId}/items/search?${qs}`, 2);
    const rs: string[] = d?.results || [];
    for (const id of rs) set.add(id);
    scrollId = d?.scroll_id || '';
    if (!scrollId || !rs.length) break;
  }
  return set;
}

/** 同款去重键：SELLER_SKU 优先；缺失时用规范化标题前缀（NFKD+小写+非字母数字折叠） */
export function makeDupKey(sellerSku: string | undefined, title: string): string {
  const sku = String(sellerSku || '').trim().toLowerCase();
  if (sku) return `sku:${sku}`;
  const t = String(title || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 30);
  return t ? `ttl:${t}` : '';
}

function toRow(store: Store, raw: any, statusSets?: { active: Set<string>; paused: Set<string> }): StoreItemRow {
  const attrs: Array<{ id?: string; name?: string; value_name?: string }> = raw?.attributes || [];
  const attrVal = (id: string) =>
    attrs.find((a) => String(a?.id || '').toUpperCase() === id)?.value_name || undefined;
  const pictures = (raw?.pictures || []).map((p: any) => p?.secure_url || p?.url).filter(Boolean);
  const siteItemIds = (raw?.marketplace_items || []).map((m: any) => m?.item_id).filter(Boolean);
  const id = String(raw?.id || '');
  const title = String(raw?.title || '');
  const rawStatus = String(raw?.status || '');
  // ⚠️ SKU 藏在 attributes 的 SELLER_SKU 里，seller_custom_field 实测全为空！
  // 之前只读 seller_custom_field → 页面按 SKU 搜索永远搜不到（用户已反馈「搜索没反应」）。
  const sellerSku = attrVal('SELLER_SKU') || raw?.seller_custom_field || undefined;
  // 用搜索接口的推算状态覆盖 CBT 自报状态（后者常年失真）
  let status = rawStatus;
  if (statusSets) {
    if (statusSets.active.has(id)) status = 'active';
    else if (statusSets.paused.has(id)) status = 'paused';
  }
  return {
    id,
    title,
    status,
    cbtStatus: rawStatus,
    subStatus: Array.isArray(raw?.sub_status) ? raw.sub_status : [],
    price: Number(raw?.price) || 0,
    currencyId: String(raw?.currency_id || 'USD'),
    availableQuantity: Number(raw?.available_quantity) || 0,
    soldQuantity: Number(raw?.sold_quantity) || 0,
    condition: raw?.condition,
    listingTypeId: raw?.listing_type_id,
    categoryId: raw?.category_id,
    sellerSku,
    dupKey: makeDupKey(sellerSku, title),
    brand: attrVal('BRAND'),
    model: attrVal('MODEL'),
    thumbnail: String(raw?.thumbnail || pictures[0] || ''),
    pictures: pictures.slice(0, 10),
    siteItemIds,
    mlPermalink: raw?.permalink || undefined,
    dateCreated: raw?.date_created,
    lastUpdated: raw?.last_updated,
    risk: scanItemRisk(title, attrs, store.site),
  };
}

function summarize(items: StoreItemRow[]): StoreIndex['counts'] {
  const c = {
    total: items.length,
    active: 0,
    paused: 0,
    risk: 0,
    riskIp: 0,
    riskBrand: 0,
    riskPlatform: 0,
    onSale: 0,
    offShelf: 0,
    blocked: 0,
    allBlocked: 0,
  };
  for (const it of items) {
    if (it.status === 'active') c.active++;
    if (it.status !== 'active') c.paused++;
    if (typeof it.onSale === 'boolean') {
      if (it.onSale) c.onSale++;
      else c.offShelf++;
    }
    const bs = it.blockedSites || [];
    if (bs.length) c.blocked++;
    if (bs.length && bs.length >= Math.max(1, (it.activeSites || []).length + (it.pausedSites || []).length + bs.length + (it.reviewSites || []).length)) {
      c.allBlocked = (c.allBlocked || 0) + 1;
    }
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
    // 真实售卖状态集合（active/paused）—— 决定视频生成列表「哪些商品还在卖」
    let statusSets: { active: Set<string>; paused: Set<string> } | undefined;
    try {
      const [act, pau] = await Promise.all([
        fetchIdSetByStatus(store, 'active'),
        fetchIdSetByStatus(store, 'paused'),
      ]);
      statusSets = { active: act, paused: pau };
      console.log(`[StoreItems] ${store.nickname} 售卖状态：active ${act.size} / paused ${pau.size}`);
    } catch (e: any) {
      console.warn(`[StoreItems] 售卖状态拉取失败（回退用 CBT 自报状态）: ${e?.message?.slice(0, 120)}`);
    }
    // 两阶段：① 批量拉商品字段 ② 逐件拉站点级 listing 状态（阶段②件数 ≈ ids.length）
    shell.progress = { done: 0, total: ids.length * 2 };
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
          if (body?.id) rows.push(toRow(store, body, statusSets));
        }
      } catch (e: any) {
        console.warn(`[StoreItems] 批次拉取失败（${batch.length} 件）: ${e?.message?.slice(0, 120)}`);
      }
      done += batch.length;
      shell.progress = { done: Math.min(done, ids.length), total: ids.length * 2 };
      onProgress?.(shell.progress.done, shell.progress.total);
    });

    // ---- 阶段②：站点级真实状态（各站点本地 listing 是否在售）----
    // 这一步要逐件调 /marketplace/items/{CBT}（该接口不支持批量），
    // 结果按 6 小时缓存落盘，二次刷新基本不耗时。失败不影响索引主体。
    try {
      const siteIds = rows.map((r) => r.id);
      const siteMap = await getItemSiteStatusBatch(store, siteIds, {
        concurrency: 6,
        onProgress: (d) => {
          shell.progress = { done: ids.length + d, total: ids.length * 2 };
          onProgress?.(shell.progress.done, shell.progress.total);
        },
      });
      let withSite = 0;
      for (const r of rows) {
        const st = siteMap.get(r.id);
        if (!st) continue;
        withSite++;
        r.siteStatus = st.sites;
        r.activeSites = st.activeSites;
        r.pausedSites = st.pausedSites;
        r.inactiveSites = st.inactiveSites;
        r.onSale = st.onSale;
        r.blockedSites = st.blockedSites;
        r.reviewSites = st.reviewSites;
        r.reasons = st.reasons;
      }
      console.log(`[StoreItems] ${store.nickname} 站点级状态：${withSite}/${rows.length} 件有数据`);
    } catch (e: any) {
      console.warn(`[StoreItems] 站点级状态阶段失败（不影响索引）: ${String(e?.message || e).slice(0, 140)}`);
    }

    // 保持与妙手列表一致：新上架的排前面
    rows.sort((a, b) => String(b.dateCreated || '').localeCompare(String(a.dateCreated || '')));
    shell.items = rows;
    shell.counts = summarize(rows);
    shell.builtAt = Date.now();
    shell.building = false;
    shell.error = undefined;
    console.log(
      `[StoreItems] ${store.nickname} 索引完成：${rows.length} 件` +
        `（父口径在售 ${shell.counts.active} / 站点级在售 ${shell.counts.onSale} / 全站未激活 ${shell.counts.offShelf} / 含禁售站点 ${shell.counts.blocked} / 含风险 ${shell.counts.risk}）`,
    );
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
  /**
   * 站点级在售过滤：
   *  - 'yes' 至少一个站点在售（买家真能看到）
   *  - 'no'  全部站点未激活（被平台下架/审核不过，列表默认应隐藏）
   */
  onSale?: 'all' | 'yes' | 'no';
  /**
   * 禁售筛选：
   *  - 'only'  只看有站点被美客多禁止（forbidden/blocked/suspended）的
   *  - 'none'  排除有禁售站点的
   */
  blocked?: 'all' | 'only' | 'none';
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
  if (f.onSale === 'yes') rows = rows.filter((r) => r.onSale !== false);
  else if (f.onSale === 'no') rows = rows.filter((r) => r.onSale === false);
  if (f.blocked === 'only') rows = rows.filter((r) => (r.blockedSites || []).length > 0);
  else if (f.blocked === 'none') rows = rows.filter((r) => !(r.blockedSites || []).length);

  const q = (f.q || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.sellerSku || '').toLowerCase().includes(q) ||
        (r.brand || '').toLowerCase().includes(q) ||
        (r.model || '').toLowerCase().includes(q) ||
        (r.categoryId || '').toLowerCase() === q,
    );
  }

  // 上限放宽：视频 tab 的「来源筛选」需要全量扫描后再切片
  const pageSize = Math.min(Math.max(f.pageSize || 50, 1), 20000);
  const page = Math.max(f.page || 1, 1);
  return { total: rows.length, page, pageSize, items: rows.slice((page - 1) * pageSize, page * pageSize) };
}

/** 商品真实链接：CBT 父 ID 推不出站点域名，必须用 marketplace_items 里的本地 item id */
export function itemPermalink(row: Pick<StoreItemRow, 'siteItemIds' | 'mlPermalink'>): string {
  const sid = (row.siteItemIds || [])[0];
  if (sid) {
    const tld = ITEM_TLD[sid.slice(0, 3)] || 'com.mx';
    return `https://www.mercadolibre.${tld}/p/${sid}`;
  }
  // 批量接口不返回 marketplace_items，退用 CBT 商品自带的 permalink
  return row.mlPermalink || '';
}

// ============ 单件全字段详情 ============

export interface StoreItemFullDetail {
  row: StoreItemRow | null;
  /** 站点级真实售卖状态（各站点本地 listing 是否在售） */
  siteStatus?: {
    sites: Record<string, SiteState>;
    subStatuses: Record<string, string[]>;
    siteItems: Array<{ siteId: string; itemId: string; userId: number; logisticType: string; state: SiteState; raw?: string; sub?: string[] }>;
    activeSites: string[];
    pausedSites: string[];
    inactiveSites: string[];
    onSale: boolean;
    blockedSites: string[];
    reviewSites: string[];
    reasons: string[];
  } | null;
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

  // 站点级状态：索引里有就直接用，没有就实时拉一次（详情页每次只看一件，代价可接受）
  let siteStatus = cached?.siteStatus
    ? {
        sites: cached.siteStatus,
        siteItems: (marketplaceItems || []).map((m: any) => ({
          siteId: String(m?.site_id || ''),
          itemId: String(m?.item_id || ''),
          userId: Number(m?.user_id) || 0,
          logisticType: String(m?.logistic_type || ''),
          state: (cached.siteStatus || {})[String(m?.site_id || '')] || 'unknown',
        })),
        subStatuses: {},
        activeSites: cached.activeSites || [],
        pausedSites: cached.pausedSites || [],
        inactiveSites: cached.inactiveSites || [],
        onSale: cached.onSale !== false,
        blockedSites: cached.blockedSites || [],
        reviewSites: cached.reviewSites || [],
        reasons: cached.reasons || [],
        subStatuses: {},
      }
    : null;
  try {
    const fresh = await getItemSiteStatus(store, itemId, true);
    if (fresh) {
      siteStatus = {
        sites: fresh.sites,
        subStatuses: fresh.subStatuses,
        siteItems: fresh.siteItems,
        activeSites: fresh.activeSites,
        pausedSites: fresh.pausedSites,
        inactiveSites: fresh.inactiveSites,
        onSale: fresh.onSale,
        blockedSites: fresh.blockedSites,
        reviewSites: fresh.reviewSites,
        reasons: fresh.reasons,
      };
    }
  } catch {
    /* 站点状态取不到不影响详情展示 */
  }

  const row = raw ? toRow(store, { ...raw, marketplace_items: marketplaceItems }, {
    // 详情页也要用真实售卖状态，而不是 CBT 自报的 active
    active: new Set(cached?.status === 'active' && cached ? [String(raw?.id || itemId)] : []),
    paused: new Set(cached?.status && cached.status !== 'active' ? [String(raw?.id || itemId)] : []),
  }) : cached;
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
    siteStatus,
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
