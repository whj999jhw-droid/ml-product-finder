import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { recalcHandlingDeadline, extractHandlingDeadline } from './fulfillment.js';

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
    console.log(`[DB] 已连接 SQLite: ${DB_PATH}`);
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
  handling_deadline TEXT,
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

-- ============ AI 选品与自动核价 ============
-- 选品运行日志：每次夜间定时扫描一条记录
CREATE TABLE IF NOT EXISTS sourcing_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  total_scanned INTEGER DEFAULT 0,
  total_matched INTEGER DEFAULT 0,
  total_scored INTEGER DEFAULT 0,
  total_approved INTEGER DEFAULT 0,
  total_rejected INTEGER DEFAULT 0,
  message TEXT,
  error TEXT
);

-- 兼容老数据库：补充 sourcing_runs.message 字段（旧表可能早于该列创建）
try {
  db.exec('ALTER TABLE sourcing_runs ADD COLUMN message TEXT');
  console.log('[DB] sourcing_runs.message 列已添加');
} catch (e: any) {
  const msg = e?.message || String(e);
  // 列已存在不是错误；其它异常才打印
  if (!/duplicate column name|already exists|已存在/i.test(msg)) {
    console.warn('[DB] 补加 sourcing_runs.message 列失败:', msg);
  }
}

-- 候选商品：ML 竞品 + 1688 货源 + 利润测算 + 五维评分 + 审核状态
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  site TEXT NOT NULL,
  ml_item_id TEXT NOT NULL,
  ml_title TEXT,
  ml_price_usd REAL,
  ml_currency TEXT,
  ml_sold_quantity INTEGER DEFAULT 0,
  ml_category_id TEXT,
  ml_category_name TEXT,
  ml_permalink TEXT,
  ml_thumbnail TEXT,
  ml_seller_id TEXT,
  ml_listing_date TEXT,
  source_title TEXT,
  source_image_url TEXT,
  ali1688_product_id TEXT,
  ali1688_title TEXT,
  ali1688_price_cny REAL,
  ali1688_shipping_cny REAL DEFAULT 0,
  ali1688_url TEXT,
  ali1688_supplier TEXT,
  ali1688_image_url TEXT,
  length_cm REAL,
  width_cm REAL,
  height_cm REAL,
  weight_kg REAL,
  -- 利润测算结果（USD）
  listing_price_usd REAL,
  profit_net_usd REAL,
  profit_rate REAL,
  roi REAL,
  break_even_price REAL,
  cost_breakdown_json TEXT,
  -- 五维评分（0~1）
  score_demand REAL,
  score_competition REAL,
  score_profit REAL,
  score_logistics REAL,
  score_compliance REAL,
  score_total REAL,
  -- 审核工作流
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  reviewed_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_site ON candidates(site);
CREATE INDEX IF NOT EXISTS idx_candidates_score ON candidates(score_total);
CREATE INDEX IF NOT EXISTS idx_candidates_item ON candidates(ml_item_id);

-- 上架任务：一个候选商品可发布到多个店铺
CREATE TABLE IF NOT EXISTS publish_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  store_id TEXT NOT NULL,
  site TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  ml_item_id TEXT,
  ml_permalink TEXT,
  error TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publish_jobs_candidate ON publish_jobs(candidate_id);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_status ON publish_jobs(status);
`);
    // 兼容旧数据库：若 orders 表缺少 handling_deadline 列则补加
    try {
      const cols = db.prepare("PRAGMA table_info(orders)").all() as { name: string }[];
      if (!cols.find((c) => c.name === 'handling_deadline')) {
        db.exec("ALTER TABLE orders ADD COLUMN handling_deadline TEXT");
        console.log('[DB] orders.handling_deadline 列已添加');
      }
    } catch (e: any) {
      console.warn('[DB] 检查/补加 handling_deadline 列失败:', e?.message || String(e));
    }
    console.log(`[DB] SQLite initialized at ${DB_PATH}`);
  } catch (e: any) {
    console.error('[DB] SQLite 不可用（已跳过本地数据库功能）:', e?.message || String(e));
    console.error('[DB] 后续依赖本地数据库的功能（AI 选品运行记录、候选列表、订单缓存等）将无法写入！');
  }
}
await initDatabase();

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
  const rows = db.prepare('SELECT order_json, source, site, handling_deadline FROM orders WHERE store_id = ? ORDER BY date_created DESC').all(storeId);
  const orders = rows
    .map((r: any) => {
      try {
        const o = JSON.parse(r.order_json);
        o.syncSaved = r.source === 'sync'; // 后台定时同步新增的订单，列表里显著标记
        // 兼容旧数据：DB 列或 JSON 中可能没有履约截止时间
        if (r.handling_deadline && !o.handlingDeadline) {
          o.handlingDeadline = r.handling_deadline;
        }
        let fd = recalcHandlingDeadline(o);
        // 旧缓存没有 handlingDeadline 时，按下单时间+站点重新计算（兼容旧库数据）
        if (!fd.deadline && o.mlStatus === 'unshipped' && o.date_created) {
          fd = extractHandlingDeadline(o, null, r.site || o.site || '');
          o.handlingDeadline = fd.deadline;
        }
        o.remainingHours = fd.remainingHours;
        o.remainingHoursText = fd.remainingHoursText;
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
    INSERT INTO orders (id, store_id, site, order_json, ml_status, order_status, ship_status, total_amount, currency_id, date_created, buyer_nickname, item_title, handling_deadline, source, created_at, updated_at)
    VALUES (@id, @storeId, @site, @json, @ml, @os, @ss, @total, @cur, @date, @buyer, @title, @deadline, @source, @now, @now)
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
      handling_deadline = excluded.handling_deadline,
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
        deadline: o.handlingDeadline || null,
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

/**
 * 供移动端「离线补推」端点：返回 source='sync'（后台定时同步新增）的订单。
 * sinceIso 为空时返回全部 sync 订单；否则只返回 created_at 晚于 sinceIso 的（ISO 字符串可直接字典序比较）。
 */
export function getSyncOrdersSince(sinceIso: string | null): any[] {
  if (!db) return [];
  const rows = sinceIso
    ? db
        .prepare(
          "SELECT store_id, id, order_json, created_at, source, site, handling_deadline FROM orders WHERE source = 'sync' AND created_at > ? ORDER BY created_at DESC"
        )
        .all(sinceIso)
    : db
        .prepare("SELECT store_id, id, order_json, created_at, source, site, handling_deadline FROM orders WHERE source = 'sync' ORDER BY created_at DESC")
        .all();
  return rows.map((r: any) => {
    try {
      const o = JSON.parse(r.order_json);
      if (r.handling_deadline && !o.handlingDeadline) {
        o.handlingDeadline = r.handling_deadline;
      }
      let fd = recalcHandlingDeadline(o);
      if (!fd.deadline && o.mlStatus === 'unshipped' && o.date_created) {
        fd = extractHandlingDeadline(o, null, r.site || o.site || '');
        o.handlingDeadline = fd.deadline;
      }
      o.remainingHours = fd.remainingHours;
      o.remainingHoursText = fd.remainingHoursText;
      // 保留数据库元信息，便于调用方使用
      return { ...r, order_json: JSON.stringify(o), ...o };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ============ AI 选品与自动核价数据访问 ============

export function createSourcingRun(id: string): void {
  if (!db) throw new Error('SQLite 数据库未初始化，无法创建选品运行记录');
  db.prepare(`INSERT INTO sourcing_runs (id, status, started_at) VALUES (?, 'running', datetime('now'))`).run(id);
}

export function updateSourcingRun(
  id: string,
  patch: {
    status?: string;
    finished_at?: string;
    total_scanned?: number;
    total_matched?: number;
    total_scored?: number;
    total_approved?: number;
    total_rejected?: number;
    message?: string;
    error?: string;
  }
): void {
  if (!db) return;
  const fields: string[] = [];
  const params: any = { id };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      fields.push(`${k} = @${k}`);
      params[k] = v;
    }
  }
  if (fields.length === 0) return;
  const sql = `UPDATE sourcing_runs SET ${fields.join(', ')} WHERE id = @id`;
  try {
    db.prepare(sql).run(params);
  } catch (e: any) {
    console.error('[DB] updateSourcingRun 失败:', e?.message || String(e), '| SQL:', sql, '| params:', params);
    // 进度更新失败不应中断选品流水线
  }
}

export function getSourcingRun(id: string): any {
  if (!db) return null;
  return db.prepare('SELECT * FROM sourcing_runs WHERE id = ?').get(id);
}

export function getLatestSourcingRun(): any {
  if (!db) return null;
  return db.prepare('SELECT * FROM sourcing_runs ORDER BY started_at DESC LIMIT 1').get();
}

export function insertCandidate(data: any): number {
  if (!db) return 0;
  const now = new Date().toISOString();
  const cols = Object.keys(data).filter((k) => data[k] !== undefined);
  const placeholders = cols.map((k) => `@${k}`).join(', ');
  const stmt = db.prepare(
    `INSERT INTO candidates (${cols.join(', ')}, created_at, updated_at) VALUES (${placeholders}, @now, @now)`
  );
  const result = stmt.run({ ...data, now });
  return Number(result.lastInsertRowid) || 0;
}

export function getCandidates(opts?: {
  status?: string;
  runId?: string;
  site?: string;
  minScore?: number;
  limit?: number;
  offset?: number;
  orderBy?: string;
}): { rows: any[]; total: number } {
  if (!db) return { rows: [], total: 0 };
  const where: string[] = [];
  const params: any = {};
  if (opts?.status) { where.push('status = @status'); params.status = opts.status; }
  if (opts?.runId) { where.push('run_id = @runId'); params.runId = opts.runId; }
  if (opts?.site) { where.push('site = @site'); params.site = opts.site; }
  if (opts?.minScore !== undefined) { where.push('score_total >= @minScore'); params.minScore = opts.minScore; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM candidates ${whereSql}`).get(params);
  const total = totalRow?.c || 0;

  const order = opts?.orderBy || 'score_total DESC, created_at DESC';
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  const rows = db.prepare(
    `SELECT * FROM candidates ${whereSql} ORDER BY ${order} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset });

  return { rows, total };
}

export function getCandidateById(id: number): any {
  if (!db) return null;
  return db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
}

export function updateCandidateStatus(
  id: number,
  status: string,
  extra?: { reject_reason?: string; reviewed_at?: string; published_at?: string }
): void {
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE candidates
    SET status = @status, reject_reason = @reject_reason, reviewed_at = @reviewed_at,
        published_at = @published_at, updated_at = @now
    WHERE id = @id
  `).run({ id, status, reject_reason: extra?.reject_reason ?? null, reviewed_at: extra?.reviewed_at ?? null, published_at: extra?.published_at ?? null, now });
}

export function createPublishJob(data: { candidate_id: number; store_id: string; site: string; payload_json?: string }): number {
  if (!db) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO publish_jobs (candidate_id, store_id, site, status, payload_json, created_at, updated_at)
    VALUES (@candidate_id, @store_id, @site, 'pending', @payload_json, @now, @now)
  `);
  const result = stmt.run({ ...data, payload_json: data.payload_json ?? null, now });
  return Number(result.lastInsertRowid) || 0;
}

export function updatePublishJob(
  id: number,
  patch: { status?: string; ml_item_id?: string; ml_permalink?: string; error?: string; payload_json?: string }
): void {
  if (!db) return;
  const now = new Date().toISOString();
  const fields: string[] = [];
  const params: any = { id, now };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      fields.push(`${k} = @${k}`);
      params[k] = v;
    }
  }
  if (fields.length === 0) return;
  db.prepare(`UPDATE publish_jobs SET ${fields.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
}

export function getPublishJobsByCandidate(candidateId: number): any[] {
  if (!db) return [];
  return db.prepare('SELECT * FROM publish_jobs WHERE candidate_id = ? ORDER BY created_at DESC').all(candidateId);
}

export default db;
export { db };
