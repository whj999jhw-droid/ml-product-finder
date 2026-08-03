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

export default db;
export { db };
