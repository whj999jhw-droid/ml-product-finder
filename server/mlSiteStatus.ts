/**
 * server/mlSiteStatus.ts
 * 美客多 CBT（全球售）**站点级**真实售卖状态。
 *
 * 背景（用户反馈「两条重复链接里只有一条是激活的」）：
 *   CBT 父商品的 `status` 常年是 active，**不能**代表它在各站点是否真的在卖。
 *   一条 CBT 商品在墨西哥/巴西/智利/哥伦比亚各自有一条本地 listing
 *   （MLM…/MLB…/MLC…/MCO…），挂在美客多的**子账号**下面。
 *   只有本地 listing 的 active/paused 才是买家能看到的真实状态。
 *
 * 实测得到的三条关键路径（2026-09-18 验证）：
 *   1. 子账号清单：  GET /marketplace/users/{父账号id} → marketplaces[{site_id,user_id,logistic_type,pricing_model}]
 *      （MLM 下面有两个子账号：fulfillment/本地仓 + remote/跨境直发）
 *   2. 商品→各站点本地 listing id：
 *      GET /marketplace/items/{CBT_ID}?attributes=id,status,marketplace_items
 *      ⚠️ 只支持单条，`/marketplace/items?ids=` 批量会 404；`/items?ids=` 也取不到 marketplace_items。
 *   3. 子账号的在售集合：GET /marketplace/users/{子账号}/items/search?status=active|paused&limit=100
 *      （同样必须走 search_type=scan + scroll_id，普通分页 offset+limit≤1000）
 *
 * 4. 本地 listing 的**真实状态**直读（2026-09-18 关键发现）：
 *      GET /marketplace/items/{本地 item_id}?attributes=id,status,sub_status
 *      返回例如 status=under_review / sub_status=["forbidden"] —— 这才是「被美客多禁止」的
 *      真正信号。⚠️ 只能单条，`/marketplace/items?ids=` 批量会 404。
 *
 * 判定顺序：
 *   ① 本地 item_id 在子账号 active 集合 → active（快路径，批量扫描得出）
 *   ② 在 paused 集合 → paused
 *   ③ 都不是 → **逐条直读**该本地 listing，拿真实 status + sub_status
 *      （这一步能区分「被禁止 forbidden」「待补资料 waiting_for_patch」等，
 *       仅 step①③ 时约有 7000 次请求，走 6h 缓存、后台并发处理）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Store, storeApiGet } from './stores.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.join(__dirname, '..', 'data', 'ml-site-status.json');

export type SiteState = 'active' | 'paused' | 'inactive' | 'unknown';

export interface SiteAccount {
  siteId: string;
  userId: number;
  logisticType: string;
  pricingModel: string;
  businessModel?: string;
}

/** ML 站点 sub_status 常见值 → 中文说明（给 UI 直接展示） */
export const SUB_STATUS_LABEL: Record<string, string> = {
  forbidden: '被美客多禁止',
  waiting_for_patch: '待补充资料',
  mandate_required: '需授权文件',
  blocked: '被拦截',
  inactive: '未激活',
  deleted: '已删除',
  needs_synchronized_tax_information: '需同步税务信息',
  suspended: '被暂停',
};

export interface SiteItemRef {
  siteId: string;
  itemId: string;
  userId: number;
  logisticType: string;
  state: SiteState;
  /** ML 原生 status（under_review / paused / closed …） */
  raw?: string;
  /** ML 原生 sub_status（如 ["forbidden"]） */
  sub?: string[];
}

export interface ItemSiteStatus {
  /** 站点 → 状态 */
  sites: Record<string, SiteState>;
  /** 站点 → sub_status 原文（如 MLM → ["forbidden"]） */
  subStatuses: Record<string, string[]>;
  siteItems: SiteItemRef[];
  activeSites: string[];
  pausedSites: string[];
  inactiveSites: string[];
  /** 至少一个站点在售 → 买家真能看到 */
  onSale: boolean;
  /** 被美客多禁止的站点（sub_status 含 forbidden / blocked / suspended） */
  blockedSites: string[];
  /** 在审核中但未被禁的站点（如 waiting_for_patch） */
  reviewSites: string[];
  /** 中文原因汇总：如 MLM 被美客多禁止；MLC 待补充资料 */
  reasons: string[];
  checkedAt: number;
}

/** sub_status → 是否算「被禁售」 */
function isBlockedSub(subs: string[]): boolean {
  return (subs || []).some((x) => ['forbidden', 'blocked', 'suspended'].includes(String(x).toLowerCase()));
}

function blockedSitesOf(siteItems: SiteItemRef[]): string[] {
  const out = new Set<string>();
  for (const s of siteItems) if (s.state !== 'active' && isBlockedSub(s.sub || [])) out.add(s.siteId);
  return [...out];
}

function reviewSitesOf(siteItems: SiteItemRef[]): string[] {
  const out = new Set<string>();
  for (const s of siteItems) {
    if (s.state !== 'active' && !isBlockedSub(s.sub || []) && String(s.raw || s.state) === 'under_review') {
      out.add(s.siteId);
    }
  }
  return [...out];
}

function reasonsOf(siteItems: SiteItemRef[]): string[] {
  const map = new Map<string, Set<string>>();
  for (const s of siteItems) {
    if (s.state === 'active') continue;
    const key = `${s.siteId}`;
    const set = map.get(key) || new Set<string>();
    if (isBlockedSub(s.sub || [])) set.add('被美客多禁止');
    for (const x of s.sub || []) set.add(SUB_STATUS_LABEL[x] || x);
    if (!set.size) set.add(SITE_STATE_LABEL[s.state] || s.state);
    map.set(key, set);
  }
  return [...map.entries()].map(([site, set]) => `${site} ${[...set].join('、')}`);
}

export const SITE_STATE_LABEL: Record<string, string> = {
  active: '在售',
  paused: '已暂停',
  inactive: '未激活',
  unknown: '状态未知',
};

// ============ 缓存 ============

/** 单条本地 listing 的直读结果 */
interface LocalInfo {
  state: SiteState;
  raw: string;
  sub: string[];
}

interface CacheShape {
  accounts: Record<string, { at: number; list: SiteAccount[] }>;
  sets: Record<string, { at: number; byKey: Record<string, { active: string[]; paused: string[] }> }>;
  items: Record<string, { at: number; data: ItemSiteStatus }>;
  /** 本地 listing id → 直读状态（跨商品复用，避免重复请求同一件 listing） */
  locals: Record<string, { at: number; info: LocalInfo }>;
}

const EMPTY: CacheShape = { accounts: {}, sets: {}, items: {}, locals: {} };
let cache: CacheShape = EMPTY;
let loaded = false;

const ACCOUNT_TTL = 6 * 60 * 60 * 1000;
const SET_TTL = 30 * 60 * 1000;
const ITEM_TTL = 6 * 60 * 60 * 1000;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      cache = {
        accounts: raw?.accounts || {},
        sets: raw?.sets || {},
        items: raw?.items || {},
        locals: raw?.locals || {},
      };
    }
  } catch (e: any) {
    console.warn(`[SiteStatus] 缓存读取失败（忽略）: ${String(e?.message || e).slice(0, 120)}`);
    cache = { accounts: {}, sets: {}, items: {}, locals: {} };
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
      pruneLocals();
    } catch (e: any) {
      console.warn(`[SiteStatus] 缓存写入失败: ${String(e?.message || e).slice(0, 120)}`);
    }
  }, 5000);
}

const LOCAL_TTL = 6 * 60 * 60 * 1000;
const LOCAL_MAX = 60000;

/** 本地 listing 状态缓存上限控制（13k+ 条，用 FIFO 淘汰最旧的） */
function pruneLocals() {
  const keys = Object.keys(cache.locals || {});
  if (keys.length <= LOCAL_MAX) return;
  keys
    .sort((a, b) => (cache.locals[a]?.at || 0) - (cache.locals[b]?.at || 0))
    .slice(0, keys.length - LOCAL_MAX)
    .forEach((k) => delete cache.locals[k]);
}

/**
 * 直读单个本地 listing 的真实状态（带缓存）。
 * ⚠️ 这是唯一能拿到「被美客多禁止 forbidden」的途径 —— 子账号扫描里它不在
 *    active/paused 任何一种状态，只在这里暴露出来。
 */
async function fetchLocalInfo(store: Store, localId: string): Promise<LocalInfo | null> {
  ensureLoaded();
  const hit = cache.locals[localId];
  if (hit && Date.now() - hit.at < LOCAL_TTL) return hit.info;
  try {
    const d: any = await storeApiGet(store, `/marketplace/items/${localId}?attributes=id,status,sub_status`, 2);
    const raw = String(d?.status || '');
    const sub = (d?.sub_status || []).map((x: any) => String(x));
    let state: SiteState;
    if (raw === 'active') state = 'active';
    else if (raw === 'paused') state = 'paused';
    else if (raw === 'closed') state = 'inactive';
    else if (raw === 'under_review') state = isBlockedSub(sub) ? 'inactive' : 'inactive';
    else state = 'inactive';
    const info: LocalInfo = { state, raw, sub };
    cache.locals[localId] = { at: Date.now(), info };
    return info;
  } catch (e: any) {
    if (!/429/.test(String(e?.message || ''))) {
      console.warn(`[SiteStatus] 本地 listing ${localId} 读取失败: ${String(e?.message || e).slice(0, 110)}`);
    }
    // 404/403 等：记一个占位，避免每次重建都重试
    cache.locals[localId] = { at: Date.now(), info: null as any };
    return null;
  }
}

/**
 * 是否在批量流程里做精修。默认 true。
 * ⚠️ 精修要对每条非在售的本地 listing 发一次请求，首次全量约数千次；
 *    结果按 listing 粒度缓存 6 小时，第二次基本直接命中。
 */
export function setRefineEnabled(v: boolean) {
  (refine as any).enabled = v;
}
(refine as any).enabled = true;

/** 并行拉取一批本地 listing 的真实状态 */
async function fetchLocalInfos(store: Store, ids: string[], concurrency = 6): Promise<Map<string, LocalInfo>> {
  const out = new Map<string, LocalInfo>();
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 10)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= ids.length) return;
      const id = ids[i];
      const info = await fetchLocalInfo(store, id);
      if (info) out.set(id, info);
    }
  });
  await Promise.all(workers);
  return out;
}

// ============ 子账号 ============

export async function getSiteAccounts(store: Store, force = false): Promise<SiteAccount[]> {
  ensureLoaded();
  const key = store.id;
  const hit = cache.accounts[key];
  if (!force && hit && Date.now() - hit.at < ACCOUNT_TTL) return hit.list;

  try {
    const d: any = await storeApiGet(store, `/marketplace/users/${store.mlUserId}`, 2);
    const list: SiteAccount[] = (d?.marketplaces || []).map((m: any) => ({
      siteId: String(m?.site_id || ''),
      userId: Number(m?.user_id) || 0,
      logisticType: String(m?.logistic_type || 'remote'),
      pricingModel: String(m?.pricing_model || ''),
      businessModel: m?.business_model ? String(m.business_model) : undefined,
    })).filter((a: SiteAccount) => a.siteId && a.userId);
    cache.accounts[key] = { at: Date.now(), list };
    saveSoon();
    console.log(`[SiteStatus] ${store.nickname} 子账号 ${list.length} 个：${list.map((a) => `${a.siteId}/${a.userId}/${a.logisticType}`).join(', ')}`);
    return list;
  } catch (e: any) {
    console.warn(`[SiteStatus] 子账号拉取失败: ${String(e?.message || e).slice(0, 140)}`);
    return hit?.list || [];
  }
}

// ============ 子账号的 active/paused 集合 ============

async function scanIdSet(store: Store, userId: number, status: string): Promise<Set<string>> {
  const set = new Set<string>();
  let scrollId = '';
  for (let page = 0; page < 60; page++) {
    const qs = scrollId
      ? `status=${status}&search_type=scan&scroll_id=${encodeURIComponent(scrollId)}&limit=100`
      : `status=${status}&search_type=scan&limit=100`;
    const d: any = await storeApiGet(store, `/marketplace/users/${userId}/items/search?${qs}`, 2);
    const rs: string[] = d?.results || [];
    for (const id of rs) set.add(String(id));
    scrollId = d?.scroll_id || '';
    if (!scrollId || !rs.length) break;
  }
  return set;
}

export async function getSiteIdSets(
  store: Store,
  force = false,
): Promise<Record<string, { active: Set<string>; paused: Set<string> }>> {
  ensureLoaded();
  const key = store.id;
  const hit = cache.sets[key];
  if (!force && hit && Date.now() - hit.at < SET_TTL) {
    const out: Record<string, { active: Set<string>; paused: Set<string> }> = {};
    for (const [k, v] of Object.entries(hit.byKey)) {
      out[k] = { active: new Set(v.active), paused: new Set(v.paused) };
    }
    return out;
  }

  const accounts = await getSiteAccounts(store, force);
  const out: Record<string, { active: Set<string>; paused: Set<string> }> = {};
  const byKey: Record<string, { active: string[]; paused: string[] }> = {};
  for (const a of accounts) {
    const k = `${a.siteId}:${a.userId}`;
    try {
      const active = await scanIdSet(store, a.userId, 'active');
      const paused = await scanIdSet(store, a.userId, 'paused');
      out[k] = { active, paused };
      byKey[k] = { active: [...active], paused: [...paused] };
      if (active.size || paused.size) {
        console.log(`[SiteStatus] 子账号 ${k}: active ${active.size} / paused ${paused.size}`);
      }
    } catch (e: any) {
      console.warn(`[SiteStatus] 子账号 ${k} 集合拉取失败: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  cache.sets[key] = { at: Date.now(), byKey };
  saveSoon();
  return out;
}

// ============ 单件商品的站点级状态 ============

async function fetchSiteItems(store: Store, cbtId: string): Promise<{ status: string; items: Omit<SiteItemRef, 'state'>[] }> {
  const d: any = await storeApiGet(
    store,
    `/marketplace/items/${cbtId}?attributes=id,status,marketplace_items`,
    2,
  );
  const items = (d?.marketplace_items || []).map((m: any) => ({
    siteId: String(m?.site_id || ''),
    itemId: String(m?.item_id || ''),
    userId: Number(m?.user_id) || 0,
    logisticType: String(m?.logistic_type || ''),
  })).filter((m: any) => m.siteId && m.itemId);
  return { status: String(d?.status || ''), items };
}

function buildFrom(siteItems: SiteItemRef[]): ItemSiteStatus {
  const sites: Record<string, SiteState> = {};
  const subStatuses: Record<string, string[]> = {};
  // 同一站点可能有多个 listing（例如 MLM 的 fulfillment + remote）：只要有一条在售就算在售
  for (const s of siteItems) {
    const prev = sites[s.siteId];
    if (!prev || prev !== 'active') {
      sites[s.siteId] = s.state;
      subStatuses[s.siteId] = s.sub || [];
    }
  }
  const blockedSites = blockedSitesOf(siteItems);
  const reviewSites = reviewSitesOf(siteItems);
  return {
    sites,
    subStatuses,
    siteItems,
    activeSites: [...new Set(siteItems.filter((s) => s.state === 'active').map((s) => s.siteId))],
    pausedSites: [...new Set(siteItems.filter((s) => s.state === 'paused').map((s) => s.siteId))],
    inactiveSites: [...new Set(siteItems.filter((s) => s.state === 'inactive').map((s) => s.siteId))],
    onSale: siteItems.some((s) => s.state === 'active'),
    blockedSites,
    reviewSites,
    reasons: reasonsOf(siteItems),
    checkedAt: Date.now(),
  };
}

/**
 * 用「子账号 active/paused 集合」快速定级。
 * ⚠️ 集合里查不到 ≠ 一定未激活（可能是 active 集合没扫全），所以后续要 refine。
 */
function combine(
  rawRefs: Omit<SiteItemRef, 'state'>[],
  sets: Record<string, { active: Set<string>; paused: Set<string> }>,
): ItemSiteStatus {
  const siteItems: SiteItemRef[] = rawRefs.map((r) => {
    const s = sets[`${r.siteId}:${r.userId}`];
    let state: SiteState = 'unknown';
    if (s) state = s.active.has(r.itemId) ? 'active' : s.paused.has(r.itemId) ? 'paused' : 'unknown';
    return { ...r, state };
  });
  return buildFrom(siteItems);
}

/**
 * 精修：对集合判定为 unknown/paused 的本地 listing **逐条直读**真实状态。
 * 目的：把「被美客多禁止 forbidden」「待补资料 waiting_for_patch」这类
 *       在扫描集合里查无此人、但实际存在的状态挖出来（用户反馈的核心问题）。
 */
async function refine(store: Store, base: ItemSiteStatus): Promise<ItemSiteStatus> {
  const need: SiteItemRef[] = base.siteItems.filter((s) => s.state !== 'active');
  if (!need.length) return base;
  const infos = await fetchLocalInfos(store, need.map((s) => s.itemId));
  const siteItems: SiteItemRef[] = base.siteItems.map((s) => {
    if (s.state === 'active') return s;
    const info = infos.get(s.itemId);
    if (!info) return { ...s, state: s.state === 'unknown' ? 'inactive' : s.state };
    return { ...s, state: info.state, raw: info.raw, sub: info.sub };
  });
  return buildFrom(siteItems);
}

export async function getItemSiteStatus(store: Store, cbtId: string, force = false): Promise<ItemSiteStatus | null> {
  ensureLoaded();
  const key = `${store.id}|${cbtId}`;
  const hit = cache.items[key];
  if (!force && hit && Date.now() - hit.data.checkedAt < ITEM_TTL) return hit.data;
  try {
    const sets = await getSiteIdSets(store);
    const { items } = await fetchSiteItems(store, cbtId);
    const base = combine(items, sets);
    const data = await refine(store, base);
    cache.items[key] = { at: Date.now(), data };
    saveSoon();
    return data;
  } catch (e: any) {
    console.warn(`[SiteStatus] ${cbtId} 站点状态拉取失败: ${String(e?.message || e).slice(0, 130)}`);
    return hit?.data || null;
  }
}

/** 带并发的批量版：索引构建时用（3800 件左右，控制在 2-4 分钟内） */
export async function getItemSiteStatusBatch(
  store: Store,
  ids: string[],
  opts: { concurrency?: number; force?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, ItemSiteStatus>> {
  ensureLoaded();
  const concurrency = Math.max(1, Math.min(opts.concurrency || 6, 12));
  const out = new Map<string, ItemSiteStatus>();
  const queue: string[] = [...ids];
  let done = 0;

  // 先吃缓存，只有未命中/过期的才发请求
  const todo: string[] = [];
  for (const id of queue) {
    const hit = cache.items[`${store.id}|${id}`];
    if (!opts.force && hit && Date.now() - hit.data.checkedAt < ITEM_TTL) {
      out.set(id, hit.data);
      done++;
    } else {
      todo.push(id);
    }
  }
  opts.onProgress?.(done, queue.length);
  if (!todo.length) return out;

  const sets = await getSiteIdSets(store);
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      const id = todo[i];
      try {
        const { items } = await fetchSiteItems(store, id);
        const base = combine(items, sets);
        const data = refine.enabled ? await refine(store, base) : base;
        cache.items[`${store.id}|${id}`] = { at: Date.now(), data };
        out.set(id, data);
      } catch (e: any) {
        // 单件失败不影响整体
        if (!/429/.test(String(e?.message || ''))) {
          console.warn(`[SiteStatus] ${id} 失败: ${String(e?.message || e).slice(0, 110)}`);
        }
      }
      done++;
      if (done % 50 === 0) saveSoon();
      opts.onProgress?.(done, queue.length);
    }
  });
  await Promise.all(workers);
  saveSoon();
  return out;
}

/** 清掉某店铺的站点状态缓存（索引全量重建时用） */
export function clearStoreSiteCache(storeId: string) {
  ensureLoaded();
  for (const k of Object.keys(cache.items)) if (k.startsWith(`${storeId}|`)) delete cache.items[k];
  delete cache.accounts[storeId];
  delete cache.sets[storeId];
  saveSoon();
}
