/**
 * 订单轮询：每 5 分钟遍历各启用店铺，拉取「已付款」新订单并触发邮件/短信提醒。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllStores, getStoreSellerInfo, storeApiGet, updateStore, Store } from './stores.js';
import { notifyNewOrder } from './notify.js';
import { broadcastNewOrder } from './mobilePush.js';
import { extractHandlingDeadline, FulfillmentDeadline } from './fulfillment.js';
import {
  getCachedOrderIds,
  getCachedOrders,
  upsertOrders,
  getOrderSyncState,
  setOrderSyncState,
  countNewSyncOrders,
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ALERTS_FILE = path.join(__dirname, '..', 'data', 'order-alerts.json');

// 订单轮询游标重叠窗口：游标不推进到「已拉取订单的最大时间」，而是推进到「现在 - 该窗口」。
// 原因：美客多搜索接口具有最终一致性，同一时刻产生的多笔订单可能分散在相邻两次轮询返回；
// 若按最大 date_created 推进游标，后到的那笔会因 date_created <= 游标被永久漏掉（表现为「同时2单只提醒1单」）。
// 预留一段重叠窗口可在下轮重新扫到延迟到达的订单，再配合「已提醒订单号去重」避免重复通知。
const ORDER_CURSOR_SLACK_MS = 2 * 60 * 1000; // 2 分钟

interface AlertLog {
  storeId: string;
  storeName: string;
  orderId: string;
  at: string;
  channels: string[];
  total?: string;
  status: 'success' | 'failed' | 'skipped';
  content?: string; // 实际发送的短信/Webhook 内容摘要
  results?: Array<{ channel: string; success: boolean; message: string }>;
}

let alertLog: AlertLog[] = loadAlerts();

function loadAlerts(): AlertLog[] {
  try {
    if (fs.existsSync(ALERTS_FILE)) return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8'));
  } catch {
    /* ignore */
  }
  return [];
}

function saveAlerts() {
  try {
    const dir = path.dirname(ALERTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alertLog.slice(-300), null, 2));
  } catch {
    /* ignore */
  }
}

export function getAlertLog(): AlertLog[] {
  // 每次从文件读取，避免 tsx watch 未重载时内存与文件不一致
  const data = loadAlerts();
  // 兼容旧数据：未带 status 的记录统一标记为 skipped
  return data.map((a: AlertLog) => ({
    ...a,
    status: a.status || 'skipped',
    content: a.content,
    results: a.results,
  }));
}

/** 追加一条提醒记录（用于把「测试发送」结果也写入发送记录列表） */
export function addAlert(alert: AlertLog): void {
  alertLog.push(alert);
  saveAlerts();
}

/** 按 orderId 删除一条提醒记录（测试记录使用 test-<ts> 这类唯一 orderId） */
export function deleteAlert(orderId: string): boolean {
  const data = loadAlerts();
  const filtered = data.filter((a) => a.orderId !== orderId);
  if (filtered.length === data.length) return false;
  alertLog = filtered;
  saveAlerts();
  return true;
}

/** 简单并发限制，避免一次性发起几十个请求触发限流 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length);
  if (n <= 0) return results;
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** 内存缓存：订单物流状态/商品图片，减少重复 API 调用 */
const orderImageCache = new Map<string, { at: number; data: any }>();
const shipCache = new Map<string, { at: number; data: any }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟

function getCache<T>(map: Map<string, { at: number; data: T }>, key: string): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    map.delete(key);
    return undefined;
  }
  return entry.data;
}

function setCache<T>(map: Map<string, { at: number; data: T }>, key: string, data: T) {
  map.set(key, { at: Date.now(), data });
}

/** 为 CBT 订单查询每个子订单的真实物流状态（子订单 shipping.status 本身为空） */
async function fetchMarketplaceShipmentStatuses(store: Store, orders: any[]): Promise<Map<string, string>> {
  const isCbt = (store.site || '').toUpperCase() === 'CBT';
  console.log(`[Orders] fetchMarketplaceShipmentStatuses site=${store.site} isCbt=${isCbt} orders=${orders.length}`);
  if (!isCbt) return new Map();
  const map = new Map<string, string>();
  const withShip = orders.filter((o) => o.shipping?.id);
  console.log(`[Orders] withShip=${withShip.length}/${orders.length}`);
  await mapLimit(withShip, 5, async (o: any) => {
    try {
      const shipId = String(o.shipping.id);
      const orderId = String(o.id);
      const cached = getCache(shipCache, shipId);
      console.log(`[Orders] shipment orderId=${orderId} shipId=${shipId} cached=${cached ? 'yes' : 'no'}`);
      // CBT shipments 端点需要 x-format-new=true 才能拿到 status，
      // 否则可能返回 404 或不包含 status，导致已发货订单被误判为未发货。
      const ship = cached || (await storeApiGet(store, `/marketplace/shipments/${shipId}`, 3, { 'x-format-new': 'true' }));
      if (!cached) setCache(shipCache, shipId, ship);
      const status = ship?.status;
      const keys = Object.keys(ship || {});
      console.log(`[Orders] shipment orderId=${orderId} status=${JSON.stringify(status)} shipKeys=[${keys.join(',')}] substatus=${JSON.stringify(ship?.substatus)}`);
      if (status) map.set(orderId, String(status));
    } catch (e: any) {
      console.warn(`[Orders] CBT 物流状态获取失败 ${o.id}:`, e?.message || e);
    }
  });
  console.log(`[Orders] fetchMarketplaceShipmentStatuses done mapSize=${map.size}`);
  return map;
}

/**
 * 强制刷新 DB 缓存订单的真实物流状态（主要用于 CBT 列表状态修正）。
 * - sync 完成后调用，确保列表状态与 /marketplace/shipments 实时一致。
 * - 仅对 CBT 店铺、有 shipping.id、且非 cancelled 的订单查 shipments。
 * - 以内查结果为准覆盖 mlStatus/shipStatus，并重新计算履约截止时间。
 */
export async function refreshCachedOrderShipmentStatuses(
  store: Store
): Promise<{ checked: number; changed: number }> {
  const isCbt = (store.site || '').toUpperCase() === 'CBT';
  if (!isCbt) return { checked: 0, changed: 0 };

  const { orders } = getCachedOrders(store.id);
  // 已取消的不会再变化，不需要浪费 API；已发货/未发货都可能与内查不一致，统一刷新
  const toCheck = orders.filter((o: any) => o.shipping?.id && o.mlStatus !== 'cancelled');
  console.log(
    `[Orders] refreshCachedOrderShipmentStatuses store=${store.id} total=${orders.length} toCheck=${toCheck.length}`
  );
  if (toCheck.length === 0) return { checked: 0, changed: 0 };

  const shipStatusMap = await fetchMarketplaceShipmentStatuses(store, toCheck);
  let changed = 0;
  const updated = orders.map((o: any) => {
    const orderId = String(o.id);

    // 已发货 / 已取消订单：无论物流内查是否成功，都强制清掉履约截止时间，
    // 避免旧 handlingDeadline 残留被误算成「已超时」。这是「已发货订单在手机端
    // 显示未发货+已超时」的根因——即使物流状态获取失败，mlStatus 已是权威分类。
    if (o.mlStatus && o.mlStatus !== 'unshipped') {
      if (o.handlingDeadline == null && o.remainingHours == null && o.remainingHoursText === '—') {
        return o; // 已干净，无需写库
      }
      changed++;
      return { ...o, handlingDeadline: null, remainingHours: null, remainingHoursText: '—' };
    }

    const shipStatus = shipStatusMap.get(orderId);
    if (shipStatus === undefined) return o; // 内查无结果，保持原样避免误判

    const prevMlStatus = o.mlStatus;
    const newO: any = { ...o, shipStatus };
    // 同步更新 shipping.status，让 classifyOrder/attachFulfillmentDeadline 读到最新值
    if (!newO.shipping) newO.shipping = {};
    newO.shipping = { ...newO.shipping, status: shipStatus };
    newO.mlStatus = classifyOrder(newO, shipStatus);

    if (newO.mlStatus === prevMlStatus && shipStatus === o.shipStatus) return o; // 无变化

    changed++;
    return attachFulfillmentDeadline(newO);
  });

  if (changed > 0) {
    upsertOrders(store.id, store.site, updated, 'manual');
  }
  console.log(`[Orders] refreshCachedOrderShipmentStatuses done checked=${toCheck.length} changed=${changed}`);
  return { checked: toCheck.length, changed };
}

/** 批量为订单取物流详情并计算履约截止时间（仅针对未发货订单，避免浪费 API） */
/**
 * 计算各未发货订单的履约截止时间（按「72 营业小时 + 跳过周末/节假日」规则）。
 * 注：新规则只依赖「下单时间 + 站点国家」，无需再逐单调用物流接口，
 * 因此这里直接计算，省去大量 shipments API 请求。
 */
async function fetchShipmentDeadlines(store: Store, orders: any[]): Promise<Map<string, FulfillmentDeadline>> {
  const map = new Map<string, FulfillmentDeadline>();
  for (const o of orders) {
    const cat = classifyOrder(o, o.shipping?.status);
    if (cat === 'unshipped') {
      map.set(String(o.id), extractHandlingDeadline(o, null, store.site));
    }
  }
  return map;
}

/** 将履约截止时间字段附加到订单对象（仅未发货订单需要） */
function attachFulfillmentDeadline(order: any, fd?: FulfillmentDeadline): any {
  const cat = classifyOrder(order, order.shipping?.status);
  if (cat !== 'unshipped') {
    // 已发货/已取消：不展示履约剩余
    return {
      ...order,
      handlingDeadline: null,
      remainingHours: null,
      remainingHoursText: '—',
    };
  }
  const fallback = fd || extractHandlingDeadline(order, null, order.site || '');
  return {
    ...order,
    handlingDeadline: fallback.deadline,
    remainingHours: fallback.remainingHours,
    remainingHoursText: fallback.remainingHoursText,
  };
}

/**
 * CBT 跨境卖家订单：marketplace 搜索返回的是「父订单」（只有 id/buyer/config/orders/shipment），
 * 真正的订单挂在父订单的 orders[] 子数组里。这里展开所有子订单 id，再用
 * /marketplace/orders/{childId} 逐个取完整详情。
 * 注意：CBT 子订单的 seller.id 与 /users/me 返回的账号 id 不是同一个值，
 * 所以 marketplace 搜索【不能】带 seller.id 参数（带上会过滤成 0），直接按当前授权账号返回即可。
 */
async function expandMarketplaceChildren(store: Store, parents: any[]): Promise<any[]> {
  const childIds: string[] = [];
  for (const p of parents || []) {
    for (const c of p?.orders || []) {
      if (c?.id) childIds.push(String(c.id));
    }
  }
  if (!childIds.length) return [];
  return mapLimit(childIds, 5, (id) => storeApiGet(store, `/marketplace/orders/${id}`));
}

/** 店铺最近订单（用于页面顶部的「最近订单」展示） */
export async function fetchRecentOrdersForStore(store: Store, limit = 10): Promise<any[]> {
  const isCbt = (store.site || '').toUpperCase() === 'CBT';
  if (isCbt) {
    const data = await storeApiGet(store, `/marketplace/orders/search?order.status=paid&sort=date_desc&limit=${limit}&offset=0`);
    const children = await expandMarketplaceChildren(store, data.results || []);
    return children.sort((a: any, b: any) => new Date(b.date_created).getTime() - new Date(a.date_created).getTime());
  }
  const seller = await getStoreSellerInfo(store);
  const data = await storeApiGet(store, `/orders/search?seller=${seller.id}&order.status=paid&sort=date_desc&limit=${limit}`);
  return data.results || [];
}

/** 获取最近一条已有订单（含商品图片），用于通知测试以真实订单为例 */
export async function getLastRealOrderForTest(): Promise<{ store: Store; order: any } | null> {
  const stores = getAllStores().filter((s) => s.enabled);
  for (const s of stores) {
    try {
      const recent = await fetchRecentOrdersForStore(s, 1);
      if (recent.length) {
        const order = recent[0];
        order.order_items = await enrichItemsWithImages(s, order.order_items || []);
        return { store: s, order };
      }
    } catch (e: any) {
      console.error(`[Orders] 获取测试订单失败 ${s.nickname}:`, e?.message || e);
    }
  }
  return null;
}

/**
 * 拉取某店铺自上次于 check 以来的新订单（已付款）。
 * 加固点：分页拉取（不再受单页 limit=50 截断影响），确保窗口内即使 >50 笔付款订单也不会漏抓；
 * 并在搜索结果层就按游标过滤，只对新订单拉取详情，控制 API 调用量。
 */
export async function fetchNewOrdersForStore(store: Store): Promise<any[]> {
  const isCbt = (store.site || '').toUpperCase() === 'CBT';

  const last = store.lastOrderCheck;
  const now = Date.now();
  const lastTime = last ? new Date(last).getTime() : 0;
  // 首次运行或超过 7 天未轮询：只把游标推进到「现在 - 重叠窗口」，不返回历史订单，避免首次把大量旧订单都当成新订单轰炸
  const isColdStart = !lastTime || (now - lastTime > 7 * 24 * 60 * 60 * 1000);

  if (isColdStart) {
    updateStore(store.id, { lastOrderCheck: new Date(now - ORDER_CURSOR_SLACK_MS).toISOString() });
    console.log(`[Orders] ${store.nickname || store.site} 首次轮询或超过7天未检查，已同步订单游标，跳过历史订单提醒`);
    return [];
  }

  // 分页拉取「已付款」订单。ML 搜索结果上限约 1000 条，故最多翻 MAX_PAGES 页。
  // 搜索结果已带 date_created，可直接在搜索层按游标过滤，避免对历史订单逐个拉详情。
  // 注意：CBT 的 /marketplace/orders/search 返回的「父订单」没有 date_created 字段，
  // 不能在搜索层做游标过滤，只能收集全部子订单 id 后由下方子订单详情过滤。
  const MAX_PAGES = 20;
  const MAX_CHILD_IDS = 200; // CBT 收集子订单 id 的安全阀，防止一次轮询拉过多详情
  const PAGE = 50;
  let orderIds: string[] = [];

  if (isCbt) {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await storeApiGet(store, `/marketplace/orders/search?order.status=paid&sort=date_desc&limit=${PAGE}&offset=${offset}`);
      const parents = data.results || [];
      // CBT 父订单没有 date_created，无法在搜索层按游标过滤，统一收集子订单 id，
      // 交给下方「逐个拉详情后按子订单 date_created > lastTime」精确过滤。
      for (const p of parents) {
        for (const c of p?.orders || []) if (c?.id) orderIds.push(String(c.id));
      }
      if (orderIds.length >= MAX_CHILD_IDS || parents.length < PAGE) break;
      offset += PAGE;
    }
  } else {
    const seller = await getStoreSellerInfo(store);
    if (seller.id) updateStore(store.id, { mlUserId: String(seller.id), mlUserNick: seller.nickname });
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await storeApiGet(store, `/orders/search?seller=${seller.id}&order.status=paid&sort=date_desc&limit=${PAGE}&offset=${offset}`);
      const results = data.results || [];
      if (results.length && new Date(results[0]?.date_created || 0).getTime() <= lastTime) break;
      for (const o of results) {
        if (new Date(o?.date_created || 0).getTime() > lastTime) {
          if (o?.id) orderIds.push(String(o.id));
        }
      }
      if (results.length < PAGE) break;
      offset += PAGE;
    }
  }

  if (!orderIds.length) {
    // 窗口内无新订单也要推进游标，保持滑动窗口正确
    updateStore(store.id, { lastOrderCheck: new Date(now - ORDER_CURSOR_SLACK_MS).toISOString() });
    return [];
  }

  // 逐个拉取完整订单详情（含 date_created / 商品等），再按游标精确过滤出新订单
  const orders = await mapLimit(orderIds, 5, (id) =>
    isCbt ? storeApiGet(store, `/marketplace/orders/${id}`) : storeApiGet(store, `/orders/${id}`)
  );

  const newOrders = orders.filter((o: any) => new Date(o?.date_created || 0).getTime() > lastTime);

  // 关键修复：游标推进到「现在 - 重叠窗口」，而不是已拉取订单的最大 date_created。
  // 这样即使本轮只拉到同一时刻多笔订单中的部分（搜索最终一致性导致），
  // 延迟到达的其余订单仍会落在下一轮的扫描窗口内被补抓，配合下方「已提醒去重」不会重复通知。
  updateStore(store.id, { lastOrderCheck: new Date(now - ORDER_CURSOR_SLACK_MS).toISOString() });

  return newOrders;
}

function formatAlertTotal(o: any): string | undefined {
  if (o.total && typeof o.total === 'object') {
    return `${o.total.currency_id || ''} ${o.total.amount ?? ''}`.trim();
  }
  if (typeof o.total === 'number') return `${o.currency_id || ''} ${o.total}`.trim();
  // CBT 跨境订单 total 为 null，金额在 paid_amount
  if (o.paid_amount != null) {
    const amt = typeof o.paid_amount === 'object' ? o.paid_amount.amount : o.paid_amount;
    return `${o.currency_id || ''} ${amt ?? ''}`.trim();
  }
  return undefined;
}

/** 轮询所有启用店铺，返回每个店铺的处理报告 */
export async function pollAllStores(): Promise<Array<{ storeId: string; store: string; newOrders?: number; error?: string }>> {
  const stores = getAllStores();
  const report: Array<{ storeId: string; store: string; newOrders?: number; error?: string }> = [];
  // 已提醒订单号集合（来自历史提醒记录），用于重叠窗口重复扫描时去重，避免同一笔订单重复通知
  const notifiedIds = new Set(getAlertLog().map((a) => a.orderId));
  for (const s of stores) {
    if (!s.enabled) continue;
    try {
      const newOrders = await fetchNewOrdersForStore(s);
      for (const o of newOrders) {
        // 该订单此前已提醒过（如上一轮重叠窗口已抓到），跳过，避免重复通知
        const orderId = String(o.id);
        if (notifiedIds.has(orderId)) continue;
        notifiedIds.add(orderId);
        // 补充商品图片，让通知内容包含商品图
        try {
          o.order_items = await enrichItemsWithImages(s, o.order_items || []);
        } catch {
          /* 图片补充失败不影响通知 */
        }
        const notifyResult = await notifyNewOrder(s, o);
        // 同步广播给手机 APP（SSE 实时 + 已注册设备推送），作为独立于邮件/短信的又一通知渠道
        try {
          broadcastNewOrder(s, o);
        } catch {
          /* 移动端广播失败不影响主流程 */
        }
        const anySuccess = notifyResult.results.some((r) => r.success);
        const anyAttempt = notifyResult.results.length > 0;
        alertLog.push({
          storeId: s.id,
          storeName: s.nickname || s.site,
          orderId: String(o.id),
          at: new Date().toISOString(),
          channels: notifyResult.results.filter((c) => c.success).map((c) => c.channel),
          total: formatAlertTotal(o),
          status: anyAttempt ? (anySuccess ? 'success' : 'failed') : 'skipped',
          content: notifyResult.smsText,
          results: notifyResult.results,
        });
      }
      saveAlerts();
      report.push({ storeId: s.id, store: s.nickname || s.site, newOrders: newOrders.length });
    } catch (e: any) {
      report.push({ storeId: s.id, store: s.nickname || s.site, error: e?.message || String(e) });
    }
  }
  return report;
}

/**
 * 拉取某店铺的「全部订单」用于订单管理页展示。
 *
 * Mercado Libre /orders/search 的 order.status 过滤只支持：
 *   confirmed / payment_required / payment_in_process / partially_paid /
 *   paid / partially_refunded / cancelled / invalid
 * 不支持 shipped / delivered / closed，传这些会报 400 "Invalid filters"。
 *
 * 因此这里只按 paid 和 cancelled 拉取，再根据订单里的 shipping.status 把 paid 订单
 * 细分为「未发货」和「已发货」。
 */
const ORDER_STATUSES = ['paid', 'cancelled'];
const MAX_PAGES_PER_STATUS = 20; // 上限 20*50 = 1000 单/状态，防止极端情况无限翻页

const SHIPPED_STATUSES = ['shipped', 'delivered', 'closed', 'not_delivered'];

export function classifyOrder(o: any, externalShipStatus?: string): 'unshipped' | 'shipped' | 'cancelled' {
  const orderStatus = String(o.status || '').toLowerCase();
  if (orderStatus === 'cancelled') return 'cancelled';

  const shipStatus = String(externalShipStatus || o.shipping?.status || '').toLowerCase();
  // 物流状态直接说明已发货（最准），不限制订单主状态必须是 paid
  if (SHIPPED_STATUSES.includes(shipStatus)) {
    return 'shipped';
  }
  // 订单主状态本身已是 shipped/delivered/closed 也视为已发货
  if (SHIPPED_STATUSES.includes(orderStatus)) {
    return 'shipped';
  }
  // paid / handling / ready_to_ship / 其它非取消都归为未发货
  return 'unshipped';
}

export async function fetchAllOrdersForStore(store: Store): Promise<{
  orders: any[];
  counts: { total: number; unshipped: number; shipped: number; cancelled: number };
}> {
  const isCbt = (store.site || '').toUpperCase() === 'CBT';

  if (isCbt) {
    // CBT（Global Selling 跨境卖家）订单模型与普通订单完全不同：
    //  - /marketplace/orders/search 返回的是「父订单」，其父订单对象里【没有】订单状态；
    //  - 真正的订单在父订单的 orders[] 子数组里，子订单的 seller.id 与 /users/me 的账号 id 不一致，
    //    因此搜索【不能】带 seller.id 参数（带上会把订单全部过滤成 0）；
    //  - 子订单必须通过 /marketplace/orders/{childId} 单独取详情（直接 /orders/{childId} 会 403）；
    //  - 子订单的 shipping 只包含 {id}，没有 status，需要额外调 /marketplace/shipments/{id} 获取真实状态。
    const byId = new Map<string, any>();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES_PER_STATUS; page++) {
      const data = await storeApiGet(store, `/marketplace/orders/search?sort=date_desc&limit=50&offset=${offset}`);
      const parents = data.results || [];
      const children = await expandMarketplaceChildren(store, parents);
      // 批量查询每个子订单的真实物流状态，用于正确区分已发货/未发货
      const shipStatusMap = await fetchMarketplaceShipmentStatuses(store, children);
      // 为未发货订单取真实发货截止时间
      const deadlineMap = await fetchShipmentDeadlines(store, children.map((o: any) => ({ ...o, site: store.site })));
      for (const o of children) {
        const shipStatus = shipStatusMap.get(String(o.id));
        const category = classifyOrder(o, shipStatus);
        console.log(`[Orders] classify orderId=${o.id} orderStatus=${o.status} shippingStatus=${o.shipping?.status} externalShipStatus=${shipStatus} -> category=${category}`);
        const fd = deadlineMap.get(String(o.id));
        const enriched = attachFulfillmentDeadline({ ...o, site: store.site }, fd);
        byId.set(String(o.id), {
          ...enriched,
          mlStatus: category,
          orderStatus: o.status,
          shipStatus,
        });
      }
      if (parents.length < 50) break;
      offset += 50;
    }
    const orders = [...byId.values()].sort(
      (a, b) => new Date(b.date_created).getTime() - new Date(a.date_created).getTime()
    );
    const counts = {
      total: orders.length,
      unshipped: orders.filter((o) => o.mlStatus === 'unshipped').length,
      shipped: orders.filter((o) => o.mlStatus === 'shipped').length,
      cancelled: orders.filter((o) => o.mlStatus === 'cancelled').length,
    };
    return { orders, counts };
  }

  // 普通站点（MLM/MLB/MLC/MCO）：按 paid/cancelled 拉取，再按 shipping.status 细分已发货/未发货
  const seller = await getStoreSellerInfo(store);
  const sellerId = seller.id;
  if (!sellerId) throw new Error('无法获取店铺卖家 ID');

  const byId = new Map<string, any>();
  for (const st of ORDER_STATUSES) {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES_PER_STATUS; page++) {
      const url = `/orders/search?seller=${sellerId}&order.status=${st}&sort=date_desc&limit=50&offset=${offset}`;
      const data = await storeApiGet(store, url);
      const results: any[] = data.results || [];
      for (const o of results) {
        const category = classifyOrder(o);
        byId.set(String(o.id), { ...o, site: store.site, mlStatus: category, orderStatus: o.status, shipStatus: o.shipping?.status });
      }
      if (results.length < 50) break;
      offset += 50;
    }
  }

  // 为未发货订单取真实发货截止时间（已发货/已取消用兜底估算即可）
  const allOrders = [...byId.values()];
  const deadlineMap = await fetchShipmentDeadlines(store, allOrders);
  for (const o of allOrders) {
    const fd = deadlineMap.get(String(o.id));
    const enriched = attachFulfillmentDeadline(o, fd);
    byId.set(String(o.id), enriched);
  }

  const orders = [...byId.values()].sort(
    (a, b) => new Date(b.date_created).getTime() - new Date(a.date_created).getTime()
  );

  const counts = {
    total: orders.length,
    unshipped: orders.filter((o) => o.mlStatus === 'unshipped').length,
    shipped: orders.filter((o) => o.mlStatus === 'shipped').length,
    cancelled: orders.filter((o) => o.mlStatus === 'cancelled').length,
  };
  return { orders, counts };
}

/**
 * 增量拉取某店铺「date_created 晚于 sinceMs」的订单并分类。
 * 用于后台定时同步与页面手动刷新：仅扫近期订单，避免每次全量翻 1000 单。
 * - 普通站点：按 paid/cancelled 分页 date_desc，遇到整页最新订单已早于游标即提前停。
 * - CBT：父订单无 date_created，仍按页收集子订单，过滤出 date_created > sinceMs 的。
 */
export async function fetchRecentOrdersSince(store: Store, sinceMs: number): Promise<{ orders: any[] }> {
  const isCbt = (store.site || '').toUpperCase() === 'CBT';
  const byId = new Map<string, any>();

  if (isCbt) {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES_PER_STATUS; page++) {
      const data = await storeApiGet(store, `/marketplace/orders/search?sort=date_desc&limit=50&offset=${offset}`);
      const parents = data.results || [];
      const children = await expandMarketplaceChildren(store, parents);
      const shipStatusMap = await fetchMarketplaceShipmentStatuses(store, children);
      const deadlineMap = await fetchShipmentDeadlines(store, children.map((o: any) => ({ ...o, site: store.site })));
      for (const o of children) {
        if (new Date(o.date_created).getTime() > sinceMs) {
          const shipStatus = shipStatusMap.get(String(o.id));
          const category = classifyOrder(o, shipStatus);
          console.log(`[Orders] sync classify orderId=${o.id} orderStatus=${o.status} shippingStatus=${o.shipping?.status} externalShipStatus=${shipStatus} -> category=${category}`);
          const fd = deadlineMap.get(String(o.id));
          const enriched = attachFulfillmentDeadline({ ...o, site: store.site }, fd);
          byId.set(String(o.id), { ...enriched, mlStatus: category, orderStatus: o.status, shipStatus });
        }
      }
      if (parents.length < 50) break;
      offset += 50;
    }
  } else {
    const seller = await getStoreSellerInfo(store);
    if (!seller.id) return { orders: [] };
    for (const st of ORDER_STATUSES) {
      let offset = 0;
      for (let page = 0; page < MAX_PAGES_PER_STATUS; page++) {
        const url = `/orders/search?seller=${seller.id}&order.status=${st}&sort=date_desc&limit=50&offset=${offset}`;
        const data = await storeApiGet(store, url);
        const results: any[] = data.results || [];
        // 整页最新订单都已早于游标：后续页更旧，无需再翻
        if (results.length && new Date(results[0].date_created || 0).getTime() <= sinceMs) break;
        for (const o of results) {
          if (new Date(o?.date_created || 0).getTime() > sinceMs) {
            byId.set(String(o.id), { ...o, site: store.site, mlStatus: classifyOrder(o), orderStatus: o.status, shipStatus: o.shipping?.status });
          }
        }
        if (results.length < 50) break;
        offset += 50;
      }
    }
    // 为未发货订单取真实发货截止时间
    const allOrders = [...byId.values()];
    const deadlineMap = await fetchShipmentDeadlines(store, allOrders);
    for (const o of allOrders) {
      const fd = deadlineMap.get(String(o.id));
      const enriched = attachFulfillmentDeadline(o, fd);
      byId.set(String(o.id), enriched);
    }
  }

  const orders = [...byId.values()].sort(
    (a, b) => new Date(b.date_created).getTime() - new Date(a.date_created).getTime()
  );
  return { orders };
}

/**
 * 同步（拉取并持久化）某店铺订单。
 * - 首跑（无 last_max_date）：视为历史回填，source 强制 'manual'（列表不标记），仅建立增量游标。
 * - 后续：source 用 'sync'，真正新增的订单（DB 中此前无此 id）被标记，供列表与顶部提示使用。
 * - 始终更新 last_max_date 增量游标（带重叠窗口），保证不漏单且下一轮只需扫近期。
 */
export async function syncStoreOrders(
  store: Store,
  sourceOverride?: 'manual' | 'sync'
): Promise<{ newCount: number; total: number; fromBootstrap: boolean; refreshed: { checked: number; changed: number } }> {
  const state = getOrderSyncState(store.id);
  const isBootstrap = !state?.last_max_date;
  const effectiveSource: string = isBootstrap ? 'manual' : (sourceOverride || 'sync');
  const sinceMs = state?.last_max_date
    ? new Date(state.last_max_date).getTime() - ORDER_CURSOR_SLACK_MS
    : 0;

  const fetched = await fetchRecentOrdersSince(store, sinceMs);
  const existingIds = getCachedOrderIds(store.id);
  const newOnes = fetched.orders.filter((o: any) => !existingIds.has(String(o.id)));

  upsertOrders(store.id, store.site, fetched.orders, effectiveSource);

  let maxMs = sinceMs;
  for (const o of fetched.orders) {
    const t = new Date(o.date_created).getTime();
    if (!isNaN(t) && t > maxMs) maxMs = t;
  }
  setOrderSyncState(store.id, {
    last_sync_at: new Date().toISOString(),
    last_max_date: maxMs > 0 ? new Date(maxMs).toISOString() : null,
  });

  // 同步完成后，强制刷新 DB 中已有 CBT 订单的真实物流状态，以内查结果覆盖列表状态
  const refreshed = await refreshCachedOrderShipmentStatuses(store);

  return { newCount: newOnes.length, total: fetched.orders.length, fromBootstrap: isBootstrap, refreshed };
}

/** 遍历所有启用店铺做增量同步（后台定时任务调用） */
export async function syncAllStoreOrders(): Promise<
  Array<{ storeId: string; store: string; newOrders?: number; total?: number; error?: string }>
> {
  const stores = getAllStores().filter((s) => s.enabled);
  const report: Array<{ storeId: string; store: string; newOrders?: number; total?: number; error?: string }> = [];
  for (const s of stores) {
    try {
      const r = await syncStoreOrders(s);
      report.push({ storeId: s.id, store: s.nickname || s.site, newOrders: r.newCount, total: r.total });
    } catch (e: any) {
      report.push({ storeId: s.id, store: s.nickname || s.site, error: e?.message || String(e) });
    }
  }
  return report;
}

/** 供路由统计「定时同步新增且未读」条数 */
export function getNewSyncOrderCount(storeId: string): number {
  const state = getOrderSyncState(storeId);
  return countNewSyncOrders(storeId, state?.last_seen_at ?? null);
}

/** 补充订单商品图片（CBT 用 /marketplace/items，普通站点用 /items） */
async function enrichItemsWithImages(store: Store, orderItems: any[]): Promise<any[]> {
  if (!orderItems?.length) return [];
  const isCbt = (store.site || '').toUpperCase() === 'CBT';
  return mapLimit(orderItems, 5, async (it: any) => {
    const itemId = it.item?.id;
    if (!itemId) return { ...it, itemImages: [], itemThumbnail: null };
    try {
      const cached = getCache(orderImageCache, itemId);
      const detail = cached || (isCbt
        ? await storeApiGet(store, `/marketplace/items/${itemId}`)
        : await storeApiGet(store, `/items/${itemId}`));
      if (!cached) setCache(orderImageCache, itemId, detail);
      const images = (detail.pictures || [])
        .map((p: any) => p.secure_url || p.url)
        .filter(Boolean);
      const thumbnail = detail.thumbnail || images[0] || null;
      return {
        ...it,
        item: {
          ...it.item,
          thumbnail,
          pictures: detail.pictures || [],
          seller_sku: it.item?.seller_sku || detail.seller_sku || detail.seller_custom_field || '',
        },
        itemImages: images,
        itemThumbnail: thumbnail,
      };
    } catch {
      return { ...it, itemImages: [], itemThumbnail: null };
    }
  });
}

/** 计算订单财务汇总（商品总价 / 销售费用 / 物流费用 / 实得总计） */
function computeFinancialSummary(order: any, shipmentCosts: any): {
  productTotal: number;
  marketplaceFee: number;
  shippingCost: number;
  netTotal: number;
  currency: string;
} {
  const currency = order.currency_id || '';
  const items = order.order_items || [];
  const productTotal =
    typeof order.total_amount === 'number'
      ? order.total_amount
      : items.reduce((s: number, it: any) => s + (it.unit_price || 0) * (it.quantity || 1), 0);
  const paidAmount = typeof order.paid_amount === 'number' ? order.paid_amount : productTotal;

  // 销售费用：优先用各商品 sale_fee 合计，否则用首笔支付 marketplace_fee
  const saleFeeSum = items.reduce((s: number, it: any) => s + (typeof it.sale_fee === 'number' ? it.sale_fee : 0), 0);
  const paymentFee = (order.payments || []).reduce(
    (s: number, p: any) => s + (typeof p.marketplace_fee === 'number' ? p.marketplace_fee : 0),
    0
  );
  const marketplaceFee = saleFeeSum || paymentFee;

  // 物流费用：优先用 /shipments/{id}/costs 里卖家承担部分，否则用支付或订单里的 shipping_cost
  let shippingCost = 0;
  if (shipmentCosts?.senders?.[0] && typeof shipmentCosts.senders[0].cost === 'number') {
    shippingCost = shipmentCosts.senders[0].cost;
  } else if (shipmentCosts?.gross_amount != null && typeof shipmentCosts.gross_amount === 'number') {
    shippingCost = shipmentCosts.gross_amount;
  } else {
    shippingCost = (order.payments || []).reduce(
      (s: number, p: any) => s + (typeof p.shipping_cost === 'number' ? p.shipping_cost : 0),
      0
    );
  }
  if (!shippingCost && typeof order.shipping_cost === 'number') shippingCost = order.shipping_cost;

  const netTotal = paidAmount - marketplaceFee - shippingCost;
  return { productTotal, marketplaceFee, shippingCost, netTotal, currency };
}

/** 拉取单个订单的完整详情（含物流、商品图片、费用、买家证件），用于弹窗展示 */
export async function fetchOrderDetail(store: Store, orderId: string): Promise<{
  order: any;
  shipments: any[];
  itemsDetail: any[];
  category: 'unshipped' | 'shipped' | 'cancelled';
  shippingAddress?: any;
  shippingMethod?: string;
  buyerBilling?: { docType: string; docNumber: string; name: string; additionalInfo: any } | null;
  financialSummary?: { productTotal: number; marketplaceFee: number; shippingCost: number; netTotal: number; currency: string };
  fulfillment?: FulfillmentDeadline;
}> {
  const isCbt = (store.site || '').toUpperCase() === 'CBT';
  let buyerBilling: any = null;
  try {
    // 买家税务证件（RFC/CPF/CUIT/DNI 等）来自独立接口，订单对象里的 buyer.billing_info 仅有 id
    const billingPath = isCbt
      ? `/marketplace/orders/${orderId}/billing_info`
      : `/orders/${orderId}/billing_info`;
    const billing = await storeApiGet(store, billingPath, 2, isCbt ? undefined : { 'x-version': '2' });
    // 兼容两种返回结构：v1 顶层 doc_type/doc_number；v2 嵌套在 buyer.billing_info.identification
    const bi = billing?.billing_info || billing?.buyer?.billing_info || billing;
    if (bi) {
      const ident = bi.identification || {};
      buyerBilling = {
        docType: bi.doc_type || ident.type || '',
        docNumber: bi.doc_number || ident.number || '',
        name: bi.name || (billing?.buyer?.name) || '',
        additionalInfo: bi.additional_info || null,
      };
    }
  } catch {
    /* 部分站点/订单无 billing_info 权限或为空，忽略 */
  }

  // CBT 子订单必须用 /marketplace/orders/{id}（/orders/{id} 会 403）
  const order = isCbt
    ? await storeApiGet(store, `/marketplace/orders/${orderId}`)
    : await storeApiGet(store, `/orders/${orderId}`);

  let shipments: any[] = [];
  let shipmentCosts: any = null;
  if (isCbt && order.shipping?.id) {
    try {
      const ship = await storeApiGet(store, `/marketplace/shipments/${order.shipping.id}`, 3, { 'x-format-new': 'true' });
      shipments = ship ? [ship] : [];
    } catch {
      /* CBT 物流端点可能限流或无权限，忽略 */
    }
  } else if (!isCbt) {
    try {
      const ship = await storeApiGet(store, `/orders/${orderId}/shipments`, 3, { 'x-format-new': 'true' });
      shipments = Array.isArray(ship) ? ship : (ship ? [ship] : []);
    } catch {
      /* 某些站点/订单无 shipments 端点，忽略 */
    }
    // 取第一笔物流的详细费用（若存在）
    const firstShipId = shipments[0]?.id || order.shipping?.id;
    if (firstShipId) {
      try {
        shipmentCosts = await storeApiGet(store, `/shipments/${firstShipId}/costs`);
      } catch {
        /* 费用端点可能无权限，忽略 */
      }
    }
  }

  // 补充商品图片
  const itemsDetail = await enrichItemsWithImages(store, order.order_items || []);
  // 用真实物流状态重新分类，避免 CBT child order 的 status=paid 但已发货时显示错误
  const externalShipStatus = shipments[0]?.status || order.shipping?.status;
  const category = classifyOrder(order, externalShipStatus);

  // 统一收货地址：CBT 在 shipment.destination，普通站点在 shipping.receiver_address
  let shippingAddress: any = order.shipping?.receiver_address;
  if (!shippingAddress && shipments[0]?.destination) {
    shippingAddress = shipments[0].destination;
  }

  // 物流方式：优先 shipments.lead_time.shipping_method.name，其次 shipping_option.name
  const shippingMethod =
    shipments[0]?.lead_time?.shipping_method?.name ||
    shipments[0]?.shipping_option?.name ||
    order.shipping?.option?.name ||
    order.shipping?.method ||
    '';

  // 尝试补充买家基本信息（/users/{id} 为公开信息，email/phone 受隐私保护通常没有）
  if (order.buyer?.id && !order.buyer.email && !order.buyer.phone) {
    try {
      const buyerInfo = await storeApiGet(store, `/users/${order.buyer.id}`);
      if (buyerInfo) {
        order.buyer = { ...order.buyer, ...buyerInfo };
      }
    } catch {
      /* 忽略买家信息补充失败 */
    }
  }

  const financialSummary = computeFinancialSummary(order, shipmentCosts);
  const fulfillment = extractHandlingDeadline(order, null, store.site);

  return { order, shipments, itemsDetail, category, shippingAddress, shippingMethod, buyerBilling, financialSummary, fulfillment };
}

/** 订单状态 → 中文分类标签（以 mlStatus 为准） */
export function orderCategory(status: string): 'unshipped' | 'shipped' | 'cancelled' | 'other' {
  if (status === 'unshipped') return 'unshipped';
  if (status === 'shipped') return 'shipped';
  if (status === 'cancelled') return 'cancelled';
  return 'other';
}
