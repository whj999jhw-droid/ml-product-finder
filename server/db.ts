import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Render 临时文件系统下，DB 文件会随部署/休眠重置，但 access_token 可由
// 持久化的 refresh_token 自动重建，因此 WAL 模式足够。
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'mlfinder.db');

// 桌面版打包后不捆绑 better-sqlite3 原生模块；这里动态加载并在缺失时优雅降级。
// db 为 null 时本地数据库（聊天/多租户）功能停用，核心抓取/导出不受影响。
let db: any = null;

async function initDatabase() {
  try {
    const mod: any = await import('better-sqlite3');
    db = new mod.default(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
-- ============ Chat 会话 / 消息（Agent SDK 聊天功能） ============
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  model TEXT,
  sdk_session_id TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  model TEXT,
  created_at TEXT,
  tool_calls TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

-- ============ 多租户：用户 + Token ============
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_tokens (
  user_id TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  app_id TEXT,
  secret_key TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 抓取运行 + 商品结果 ============
CREATE TABLE IF NOT EXISTS fetch_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  site TEXT NOT NULL,
  status TEXT NOT NULL,
  total_count INTEGER DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  site TEXT,
  category_id TEXT,
  title TEXT,
  price_usd REAL,
  permalink TEXT,
  weight TEXT,
  dimensions TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_products_run ON products(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_user ON fetch_runs(user_id);

-- ============ 订单持久化（订单管理页缓存 + 后台定时同步） ============
-- 每次进入订单页不再全量拉取美客多，而是先读此表（即时）；后台定时增量同步负责保鲜。
-- source: 'manual' = 页面首次/手动刷新回填（不标记）；'sync' = 后台定时同步新增（列表中显著标记）。
CREATE TABLE IF NOT EXISTS orders (
  id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  site TEXT,
  order_json TEXT,
  ml_status TEXT,
  order_status TEXT,
  ship_status TEXT,
  total_amount REAL,
  currency_id TEXT,
  date_created TEXT,
  buyer_nickname TEXT,
  item_title TEXT,
  source TEXT DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id);
CREATE INDEX IF NOT EXISTS idx_orders_store_date ON orders(store_id, date_created);

-- 每店铺订单同步状态：last_sync_at 最近同步时间；last_max_date 已同步到的最大下单时间（增量游标）；
-- last_seen_at 用户最近一次「查看并消除」提示的时间（用于统计定时同步新增条数）。
CREATE TABLE IF NOT EXISTS order_sync_state (
  store_id TEXT PRIMARY KEY,
  last_sync_at TEXT,
  last_max_date TEXT,
  last_seen_at TEXT,
  updated_at TEXT NOT NULL
);
`);
    console.log(`[DB] SQLite initialized at ${DB_PATH}`);
  } catch (e: any) {
    console.warn('[DB] SQLite 不可用（已跳过本地数据库功能）:', e?.message || String(e));
  }
}
initDatabase();

// ============ Chat 数据访问函数 ============
export function getAllSessions() {
  if (!db) return [];
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
}

export function getSession(id: string) {
  if (!db) return undefined;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

export function getMessagesBySession(sessionId: string) {
  if (!db) return [];
  return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
}

export function createSession(data: {
  id: string; title: string; model: string; sdk_session_id?: string | null;
  created_at: string; updated_at: string;
}) {
  if (!db) return null;
  db.prepare(`
    INSERT INTO sessions (id, title, model, sdk_session_id, created_at, updated_at)
    VALUES (@id, @title, @model, @sdk_session_id, @created_at, @updated_at)
  `).run(data);
  return getSession(data.id);
}

export function updateSession(
  id: string,
  updates: { title?: string; model?: string; sdk_session_id?: string | null }
) {
  if (!db) return false;
  const sets: string[] = [];
  const params: any = { id };
  if (updates.title !== undefined) { sets.push('title = @title'); params.title = updates.title; }
  if (updates.model !== undefined) { sets.push('model = @model'); params.model = updates.model; }
  if (updates.sdk_session_id !== undefined) { sets.push('sdk_session_id = @sdk_session_id'); params.sdk_session_id = updates.sdk_session_id; }
  if (sets.length === 0) return true;
  const result = db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return result.changes > 0;
}

export function deleteSession(id: string) {
  if (!db) return false;
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function createMessage(data: {
  id: string; session_id: string; role: string; content: string;
  model?: string | null; created_at: string; tool_calls?: string | null;
}) {
  if (!db) return data;
  db.prepare(`
    INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
    VALUES (@id, @session_id, @role, @content, @model, @created_at, @tool_calls)
  `).run(data);
  return data;
}

// ============ 订单持久化数据访问 ============
export function getCachedOrders(storeId: string): { orders: any[]; counts: { total: number; unshipped: number; shipped: number; cancelled: number } } {
  const empty = { orders: [], counts: { total: 0, unshipped: 0, shipped: 0, cancelled: 0 } };
  if (!db) return empty;
  const rows = db.prepare('SELECT order_json, source FROM orders WHERE store_id = ? ORDER BY date_created DESC').all(storeId);
  const orders = rows
    .map((r: any) => {
      try {
        const o = JSON.parse(r.order_json);
        o.syncSaved = r.source === 'sync'; // 后台定时同步新增的订单，列表里显著标记
        return o;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const counts = {
    total: orders.length,
    unshipped: orders.filter((o: any) => o.mlStatus === 'unshipped').length,
    shipped: orders.filter((o: any) => o.mlStatus === 'shipped').length,
    cancelled: orders.filter((o: any) => o.mlStatus === 'cancelled').length,
  };
  return { orders, counts };
}

export function getCachedOrderIds(storeId: string): Set<string> {
  if (!db) return new Set();
  const rows = db.prepare('SELECT id FROM orders WHERE store_id = ?').all(storeId);
  return new Set(rows.map((r: any) => r.id));
}

/** 统计「后台定时同步新增」且未读（created_at > last_seen_at）的订单数；last_seen_at 为空时统计全部 sync 订单 */
export function countNewSyncOrders(storeId: string, sinceIso: string | null): number {
  if (!db) return 0;
  const row = sinceIso
    ? db.prepare("SELECT COUNT(*) AS c FROM orders WHERE store_id = ? AND source = 'sync' AND created_at > ?").get(storeId, sinceIso)
    : db.prepare("SELECT COUNT(*) AS c FROM orders WHERE store_id = ? AND source = 'sync'").get(storeId);
  return row?.c || 0;
}

/** 批量 upsert 订单。冲突时保留原 source 与 created_at（不覆盖首次来源/时间），仅刷新业务字段 */
export function upsertOrders(storeId: string, site: string, orders: any[], source: string): void {
  if (!db) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO orders (id, store_id, site, order_json, ml_status, order_status, ship_status, total_amount, currency_id, date_created, buyer_nickname, item_title, source, created_at, updated_at)
    VALUES (@id, @storeId, @site, @json, @ml, @os, @ss, @total, @cur, @date, @buyer, @title, @source, @now, @now)
    ON CONFLICT(id, store_id) DO UPDATE SET
      order_json = excluded.order_json,
      ml_status = excluded.ml_status,
      order_status = excluded.order_status,
      ship_status = excluded.ship_status,
      total_amount = excluded.total_amount,
      currency_id = excluded.currency_id,
      date_created = excluded.date_created,
      buyer_nickname = excluded.buyer_nickname,
      item_title = excluded.item_title,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((items: any[]) => {
    for (const o of items) {
      const total =
        typeof o.total_amount === 'number' ? o.total_amount
        : o.total && typeof o.total === 'object' ? o.total.amount
        : null;
      stmt.run({
        id: String(o.id),
        storeId,
        site: site || '',
        json: JSON.stringify(o),
        ml: o.mlStatus || 'other',
        os: o.orderStatus || o.status || '',
        ss: o.shipStatus || o.shipping?.status || '',
        total,
        cur: o.currency_id || '',
        date: o.date_created || '',
        buyer: o.buyer?.nickname || o.buyer?.email || '',
        title: o.order_items?.[0]?.item?.title || '',
        source,
        now,
      });
    }
  });
  tx(orders);
}

export function getOrderSyncState(storeId: string): any {
  if (!db) return null;
  return db.prepare('SELECT * FROM order_sync_state WHERE store_id = ?').get(storeId);
}

export function setOrderSyncState(
  storeId: string,
  patch: { last_sync_at?: string | null; last_max_date?: string | null; last_seen_at?: string | null }
): void {
  if (!db) return;
  const existing = getOrderSyncState(storeId);
  const now = new Date().toISOString();
  const merged = {
    last_sync_at: patch.last_sync_at !== undefined ? patch.last_sync_at : (existing?.last_sync_at ?? null),
    last_max_date: patch.last_max_date !== undefined ? patch.last_max_date : (existing?.last_max_date ?? null),
    last_seen_at: patch.last_seen_at !== undefined ? patch.last_seen_at : (existing?.last_seen_at ?? null),
  };
  db.prepare(`
    INSERT INTO order_sync_state (store_id, last_sync_at, last_max_date, last_seen_at, updated_at)
    VALUES (@storeId, @last_sync_at, @last_max_date, @last_seen_at, @updated_at)
    ON CONFLICT(store_id) DO UPDATE SET
      last_sync_at = excluded.last_sync_at,
      last_max_date = excluded.last_max_date,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `).run({ storeId, ...merged, updated_at: now });
}

export default db;
export { db };
