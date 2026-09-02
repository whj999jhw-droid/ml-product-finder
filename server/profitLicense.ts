/**
 * 美客多利润计算器 — 授权 + 资讯 模块
 *
 * 从腾讯云 CloudBase 云函数（license-server）整体迁移到 ml-product-finder 服务内，
 * 彻底不再依赖 CloudBase CLI / 扫码 / 环境变量部署。数据改存 ml-finder 同库 SQLite，
 * AI 统一走 aiService.llmGenerate（ml-finder 配置中心多平台 failover）。
 *
 * 挂载方式（在 index.ts）： app.use('/api/profit/license-server', profitLicenseRouter)
 * 前端 LICENSE_URL = https://ml.w999w.dpdns.org/api/profit/license-server
 *
 * 路由（与旧云函数路径一一对应）：
 *   POST /generate      管理员批量生成激活码
 *   POST /activate      激活 + 设备绑定
 *   POST /reactivate    设备级重激活（清数据后授权不失效）
 *   POST /verify        校验 token
 *   POST /revoke        管理员吊销（码作废）
 *   POST /unbind        管理员解绑（码恢复未使用，可换设备重激活）
 *   GET  /admin         网页版授权码管理后台（server/license-admin.html）
 *   POST /list          管理员查看全部
 *   POST /my            用户查看本机授权码
 *   POST|GET /news      资讯（服务端抓取公开热搜/每日资讯）
 *   GET /daily          每日精选（即时返回云端生成内容）
 *   POST /cron-daily    定时生成（cronKey 保护）
 *   POST|GET /refresh   客户端主动刷新
 *   GET /extract        服务端抓网页正文
 *   POST /ocr-text      OCR 文本结构化
 *   GET|POST /diag /llm 诊断 / 通用 LLM
 */
import express from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { db } from './db.js';
import { llmGenerate, getLlmProviders } from './aiService.js';

const router = express.Router();

// ---------- 配置（与旧云函数一致，可用环境变量覆盖） ----------
const ADMIN_KEY = process.env.PROFIT_ADMIN_KEY || process.env.ADMIN_KEY || 'ml-profit-admin';
const TOKEN_SECRET = process.env.PROFIT_TOKEN_SECRET || process.env.TOKEN_SECRET || 'ml-profit-token-secret-change-me';
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const CRON_SECRET = process.env.PROFIT_CRON_SECRET || process.env.CRON_SECRET || 'ml-profit-cron-change-me';
const ADMIN_CODES = (process.env.PROFIT_ADMIN_CODES || process.env.ADMIN_CODES || '')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// CORS：App 是 WebView（file:// 或 localhost 源），ml-finder 无全局 CORS，这里按路由放开
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function ok(data: any) { return { statusCode: 200, data: { ok: true, ...data } }; }
function fail(statusCode: number, msg: string) { return { statusCode, data: { ok: false, error: msg } }; }

function dbReady() { return !!db; }
function jparse(s: any) { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } }

// 管理员鉴权：adminKey 或 管理员 token 二选一（网页后台只凭管理员码即可操作）
function adminAuthorized(body: any) {
  if (body && body.adminKey && body.adminKey === ADMIN_KEY) return true;
  const p = body && body.token ? unsignToken(body.token) : null;
  return !!(p && p.isAdmin === true);
}

// ---------- token / 激活码 ----------
function hmac(payload: string) { return crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex'); }
function signToken(obj: any) {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return payload + '.' + hmac(payload);
}
function unsignToken(token: any) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [p, h] = token.split('.');
  if (!p || !h) return null;
  if (hmac(p) !== h) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  const seg = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  return `ML-${seg()}-${seg()}-${seg()}`;
}
async function ensureUniqueCode(): Promise<string> {
  if (!dbReady()) throw new Error('数据库不可用');
  for (let i = 0; i < 20; i++) {
    const code = genCode();
    const row = db.prepare('SELECT id FROM licenses WHERE code=?').get(code);
    if (!row) return code;
  }
  throw new Error('生成激活码冲突，请重试');
}
function insertLicense(code: string, status: string, kind: string, deviceId: string | null, deviceInfo: any, activatedAt: number | null, note: string) {
  db.prepare('INSERT INTO licenses (code,status,kind,device_id,device_info,activated_at,created_at,note) VALUES (?,?,?,?,?,?,?,?)')
    .run(code, status, kind, deviceId || null, deviceInfo ? JSON.stringify(deviceInfo) : null, activatedAt, Date.now(), note || '');
}
function rowToLicense(d: any) {
  return {
    code: d.code,
    status: d.status,
    kind: d.kind || 'user',
    deviceId: d.device_id || null,
    deviceInfo: d.device_info ? jparse(d.device_info) : null,
    activatedAt: d.activated_at || null,
    createdAt: d.created_at || null,
    note: d.note || ''
  };
}

// ---------- 授权路由 ----------
async function handleGenerate(body: any) {
  const tokenPayload = body.token ? unsignToken(body.token) : null;
  const isAdminByToken = !!(tokenPayload && tokenPayload.isAdmin === true);
  if (!isAdminByToken) {
    if (!body.adminKey || body.adminKey !== ADMIN_KEY) return fail(401, '管理员密钥错误');
  }
  const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 500);
  const note = String(body.note || '');
  const kind = (isAdminByToken && body.kind === 'admin') ? 'admin' : 'user';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = await ensureUniqueCode();
    insertLicense(code, 'unused', kind, null, null, null, note);
    codes.push(code);
  }
  return ok({ count: codes.length, kind, codes });
}

async function handleActivate(body: any) {
  if (!dbReady()) return fail(500, '数据库不可用');
  const code = String(body.code || '').trim().toUpperCase();
  const deviceId = String(body.deviceId || '').trim();
  if (!code) return fail(400, '缺少激活码');
  if (!deviceId) return fail(400, '缺少设备标识');

  if (ADMIN_CODES.includes(code)) {
    const devInfo = body.deviceInfo || null;
    const row = db.prepare('SELECT * FROM licenses WHERE code=?').get(code);
    if (!row) {
      insertLicense(code, 'active', 'admin', deviceId, devInfo, Date.now(), '管理员码');
    } else {
      db.prepare('UPDATE licenses SET status=?, device_id=?, device_info=?, activated_at=? WHERE code=?')
        .run('active', deviceId, devInfo ? JSON.stringify(devInfo) : null, Date.now(), code);
    }
    const token = signToken({ code, deviceId, isAdmin: true, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS });
    return ok({ token, admin: true });
  }

  const row = db.prepare('SELECT * FROM licenses WHERE code=?').get(code);
  if (!row) return fail(404, '无效激活码');
  const devInfo = body.deviceInfo || null;
  if (row.status === 'revoked') return fail(403, '该激活码已被吊销');
  if (row.status === 'active') {
    if (row.device_id === deviceId) {
      db.prepare('UPDATE licenses SET device_info=? WHERE code=?').run(devInfo ? JSON.stringify(devInfo) : null, code);
      const token = signToken({ code, deviceId, isAdmin: false, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS });
      return ok({ token, sameDevice: true });
    }
    return fail(403, '该激活码已绑定其他设备，无法在新设备上激活');
  }
  db.prepare('UPDATE licenses SET status=?, device_id=?, device_info=?, activated_at=? WHERE code=?')
    .run('active', deviceId, devInfo ? JSON.stringify(devInfo) : null, Date.now(), code);
  const token = signToken({ code, deviceId, isAdmin: false, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS });
  return ok({ token });
}

async function handleVerify(body: any) {
  if (!dbReady()) return fail(500, '数据库不可用');
  const payload = unsignToken(body.token);
  if (!payload) return fail(401, 'token 无效');
  if (payload.exp && Date.now() > payload.exp) return fail(401, 'token 已过期，请重新激活');
  const row = db.prepare('SELECT * FROM licenses WHERE code=?').get(payload.code);
  if (!row) return fail(403, '激活码不存在');
  if (row.status !== 'active') return fail(403, '激活码状态异常');
  if (!payload.isAdmin && row.device_id && row.device_id !== payload.deviceId) return fail(403, '设备不匹配');
  return ok({ code: payload.code, isAdmin: !!payload.isAdmin });
}

async function handleRevoke(body: any) {
  if (!dbReady()) return fail(500, '数据库不可用');
  if (!adminAuthorized(body)) return fail(401, '仅管理员可吊销激活码');
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return fail(400, '缺少激活码');
  const row = db.prepare('SELECT * FROM licenses WHERE code=?').get(code);
  if (!row) return fail(404, '激活码不存在');
  db.prepare('UPDATE licenses SET status=? WHERE code=?').run('revoked', code);
  return ok({ code });
}

// 解绑：把激活码恢复为「未使用」并清空设备，可换设备重新激活（码本身保留，区别于吊销）
async function handleUnbind(body: any) {
  if (!dbReady()) return fail(500, '数据库不可用');
  if (!adminAuthorized(body)) return fail(401, '仅管理员可解绑激活码');
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return fail(400, '缺少激活码');
  const row = db.prepare('SELECT * FROM licenses WHERE code=?').get(code);
  if (!row) return fail(404, '激活码不存在');
  db.prepare("UPDATE licenses SET status='unused', device_id=NULL, device_info=NULL, activated_at=NULL WHERE code=?").run(code);
  return ok({ code, status: 'unused' });
}

async function handleList(body: any) {
  if (!dbReady()) return fail(500, '数据库不可用');
  const payload = unsignToken(body.token);
  if (!payload || !payload.isAdmin) return fail(401, '仅管理员可查看授权码列表');
  const rows = db.prepare('SELECT * FROM licenses').all();
  const codes = rows.map(rowToLicense);
  return ok({ count: codes.length, codes });
}

async function handleReactivate(body: any) {
  if (!dbReady()) return fail(500, '数据库不可用');
  const deviceId = String(body.deviceId || '').trim();
  if (!deviceId) return fail(400, '缺少设备标识');
  const row = db.prepare("SELECT * FROM licenses WHERE device_id=? AND status='active' LIMIT 1").get(deviceId);
  if (!row) return fail(404, '该设备尚未授权，请使用激活码激活');
  const isAdmin = row.kind === 'admin';
  const devInfo = body.deviceInfo || null;
  db.prepare('UPDATE licenses SET device_info=? WHERE code=?').run(devInfo ? JSON.stringify(devInfo) : null, row.code);
  const token = signToken({ code: row.code, deviceId, isAdmin, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS });
  return ok({ token, code: row.code, admin: isAdmin, reactivated: true });
}

async function handleMy(body: any) {
  if (!dbReady()) return fail(500, '数据库不可用');
  const payload = unsignToken(body.token);
  if (!payload || !payload.code) return fail(401, 'token 无效');
  const row = db.prepare('SELECT * FROM licenses WHERE code=?').get(payload.code);
  if (!row) return fail(404, '未找到授权码');
  const d = rowToLicense(row);
  return ok({ code: d.code, status: d.status, kind: d.kind, deviceId: d.deviceId, deviceInfo: d.deviceInfo, activatedAt: d.activatedAt });
}

// ---------- 资讯：服务端抓取 ----------
const NEWS_TTL = 10 * 60 * 1000;
let newsCache: any = { at: 0, feeds: [] };
const NEWS_COL = 'news_cache';

async function getNewsCache() {
  if (!dbReady()) return null;
  try {
    const row = db.prepare('SELECT * FROM news_cache WHERE key=?').get('current');
    if (row && row.feeds) return { at: row.at || 0, feeds: jparse(row.feeds) || [] };
  } catch { /* ignore */ }
  return null;
}
async function setNewsCache(feeds: any[]) {
  if (!dbReady()) return;
  try { db.prepare('INSERT OR REPLACE INTO news_cache (key, at, feeds) VALUES (?,?,?)').run('current', Date.now(), JSON.stringify(feeds)); } catch { /* ignore */ }
}

async function fetchText(url: string, headers: any = {}, timeoutMs = 6000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json, text/html, application/rss+xml' }, headers || {}),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}
async function fetchJson(url: string, headers: any = {}, timeoutMs = 6000): Promise<any> {
  return JSON.parse(await fetchText(url, headers, timeoutMs));
}
function stripHtml(s: any) {
  if (!s) return '';
  let t = String(s).replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1');
  t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#0*160;/g, ' ')
    .replace(/&amp;/g, '&');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&[a-z]+;/gi, ' ').replace(/&#\d+;/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

const NEWS_FEEDS = [
  {
    key: '60s', label: '每日热讯',
    url: 'https://60s.viki.moe/v2/60s',
    parse(j: any) {
      const d = (j && j.data) || {};
      const data = d.data || d;
      const news = Array.isArray(data.news) ? data.news : [];
      return news.slice(0, 8).map((t: any) => ({ title: String(t).replace(/^\s*\d+[.、)]\s*/, '').trim() }));
    }
  },
  {
    key: 'weibo', label: '微博热搜',
    url: 'https://weibo.com/ajax/side/hotSearch',
    headers: { 'Referer': 'https://weibo.com/' },
    parse(j: any) {
      const rt = (j && j.data && j.data.realtime) || [];
      return rt.slice(0, 8).map((it: any) => ({
        title: it.word || '',
        hot: it.num || 0,
        url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent(it.word || '')
      })).filter((x: any) => x.title);
    }
  },
  {
    key: 'tech', label: '科技AI', text: true,
    url: 'https://www.ithome.com/rss/',
    parse(text: string) {
      const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
      return items.slice(0, 5).map((it: string) => {
        const m = it.match(/<title>([\s\S]*?)<\/title>/);
        const lm = it.match(/<link>([\s\S]*?)<\/link>/);
        const dm = it.match(/<description>([\s\S]*?)<\/description>/);
        const title = m ? stripHtml(m[1]) : '';
        const link = lm ? lm[1].replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim() : '';
        const desc = dm ? stripHtml(dm[1]) : '';
        return { title, url: link, desc };
      }).filter((x: any) => x.title);
    }
  },
  {
    key: 'quote', label: '每日一句',
    url: 'https://v1.hitokoto.cn/?c=d&c=i&c=k',
    parse(j: any) {
      return [{
        title: j.hitokoto || '',
        meta: j.from ? `出自《${j.from}》` : '',
        type: 'quote',
        desc: [j.from_who, j.creator].filter(Boolean).join(' / ')
      }];
    }
  }
];

async function fetchAllNews() {
  const results = await Promise.all(NEWS_FEEDS.map(async (src) => {
    try {
      let items: any[];
      if (src.fn) items = await src.fn();
      else if (src.text) items = src.parse(await fetchText(src.url, src.headers));
      else items = src.parse(await fetchJson(src.url, src.headers));
      return { key: src.key, label: src.label, items: items || [], ok: !!(items && items.length) };
    } catch (e: any) {
      return { key: src.key, label: src.label, items: [], ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  }));
  return results.filter((r) => r.ok && r.items.length);
}
async function refreshNewsCache() {
  try {
    const feeds = await fetchAllNews();
    if (feeds.length) { newsCache = { at: Date.now(), feeds }; await setNewsCache(feeds); }
  } catch { /* best-effort */ }
}

async function handleGetNews() {
  if (!dbReady()) return fail(500, '数据库不可用');
  const cached = await getNewsCache();
  if (cached && cached.feeds.length) {
    const fresh = (Date.now() - cached.at) < NEWS_TTL;
    if (!fresh) refreshNewsCache();
    return ok({ updatedAt: cached.at, feeds: cached.feeds, stale: !fresh });
  }
  const feeds = await fetchAllNews();
  if (feeds.length) {
    newsCache = { at: Date.now(), feeds };
    await setNewsCache(feeds);
    return ok({ updatedAt: newsCache.at, feeds });
  }
  if (newsCache.feeds.length) return ok({ updatedAt: newsCache.at, feeds: newsCache.feeds, stale: true });
  return fail(502, '所有资讯源暂不可用');
}

// ---------- 每日精选（日历内容） ----------
const DAILY_COL = 'daily_content';
function todayStr(d?: Date) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
function parseJsonLoose(s: any) {
  if (!s) return null;
  let t = String(s).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  try { return JSON.parse(t); } catch { /* fallthrough */ }
  const blocks = t.match(/\{[\s\S]*?\}(?=\s*$)/) || t.match(/\{[\s\S]*\}/);
  if (blocks) {
    let cand = blocks[0];
    const sIdx = cand.indexOf('{'); const eIdx = cand.lastIndexOf('}');
    if (sIdx >= 0 && eIdx > sIdx) cand = cand.slice(sIdx, eIdx + 1);
    try { return JSON.parse(cand); } catch { /* ignore */ }
  }
  return null;
}
const PLACEHOLDER_RE = /（[^）]*?(暂未成功|暂不可用|请稍后|未配置|数据源|接口|密钥|空壳)[^）]*?）|^（[^）]+）$/;
function isPlaceholderTitle(title: any) { if (!title) return true; return PLACEHOLDER_RE.test(String(title)); }

async function getDaily(date: string) {
  if (!dbReady()) return null;
  try {
    const row = db.prepare('SELECT * FROM daily_content WHERE date=?').get(date);
    if (!row) return null;
    return { date: row.date, items: jparse(row.items) || {}, complete: !!row.complete, updatedAt: row.updated_at };
  } catch { return null; }
}
async function setDaily(date: string, items: any, complete: boolean) {
  if (!dbReady()) return;
  try { db.prepare('INSERT OR REPLACE INTO daily_content (date, items, complete, updated_at) VALUES (?,?,?,?)').run(date, JSON.stringify(items), complete ? 1 : 0, Date.now()); } catch { /* ignore */ }
}
function getMeta(key: string) {
  if (!dbReady()) return null;
  try { const row = db.prepare('SELECT val FROM profit_meta WHERE key=?').get(key); return row ? row.val : null; } catch { return null; }
}
function setMeta(key: string, val: string) {
  if (!dbReady()) return;
  try { db.prepare('INSERT OR REPLACE INTO profit_meta (key, val) VALUES (?,?)').run(key, val); } catch { /* ignore */ }
}

// 统一 AI（走 ml-finder 配置中心，自动 failover）
async function aiChat(systemPrompt: string, prompt: string, maxTokens = 1200): Promise<string | null> {
  try {
    return await llmGenerate({
      systemPrompt,
      prompt,
      timeoutMs: Math.min(Math.max(maxTokens, 400) * 12, 60000),
      maxTokens
    });
  } catch (e: any) {
    console.error('[profitLicense aiChat] 失败:', e?.message || String(e));
    return null;
  }
}
function hasAnyAiKey() { return getLlmProviders().length > 0; }
const AI_UNAVAILABLE_TIP = '（所有 AI 接口暂不可用）当前 ml-finder 未配置任何可用 LLM 供应商。请在 Oracle 服务器 .env 设置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL，或编辑 data/llm-config.json 填入可用供应商（SiliconFlow / 火山方舟 等），配置后会自动 failover。';

async function genHistory() {
  try {
    if (hasAnyAiKey()) {
      const md = new Date().getMonth() + 1, dd = new Date().getDate();
      const c = await aiChat(
        `你是历史科普编辑。严格只输出 JSON：{"events":[{"year":"年份(如1997)","text":"事件中文描述(20字内)","category":"政治/科技/文化/军事/经济等类别"}]}，列出${md}月${dd}日历史上发生的 8 条重要事件，按年代从古到今排列，必须中文。`,
        '直接输出 JSON，不要任何解释。', 1800);
      const j = parseJsonLoose(c);
      const evs = (j && j.events) || [];
      if (evs.length) return { key: 'history', label: '历史上的今天', items: evs.slice(0, 8).map((e: any) => ({
        title: (e.year ? e.year + '年 · ' : '') + (e.text || ''),
        meta: e.category || (e.year ? String(e.year) : '')
      })) };
    }
    const tip = hasAnyAiKey()
      ? 'AI 生成历史内容失败：ml-finder 配置中心的 LLM 供应商均调用失败，请到 /diag 查看具体错误。'
      : '在 Oracle 服务器 .env 配置 LLM_API_KEY 后，将用 AI 生成今日历史内容。';
    return { key: 'history', label: '历史上的今天', items: [{ title: '（历史上的今天数据源暂不可用）', desc: tip }] };
  } catch {
    return { key: 'history', label: '历史上的今天', items: [{ title: '（历史上的今天数据源暂不可用）', desc: '请稍后刷新重试，或访问 /diag 查看具体错误。' }] };
  }
}
async function genMovie() {
  try {
    const j = await fetchJson('https://movie.douban.com/j/chart/top_list?type=11&interval_id=100:90&action=&start=0&limit=10', {}, 5000);
    const arr = Array.isArray(j) ? j : [];
    const items = arr.slice(0, 8).map((it: any) => {
      const year = (it.release_date || '').slice(0, 4);
      const meta = [year, (it.types || []).join('/')].filter(Boolean).join(' · ');
      return { title: `${it.title || ''}（${it.score || ''}分）`, meta, url: it.url || '', actors: (it.actors || []).slice(0, 3), plot: '' };
    }).filter((x: any) => x.title);
    if (!items.length) return { key: 'movie', label: '经典老电影', items: [{ title: '（老电影源暂不可用）', desc: '稍后刷新重试。' }] };
    try {
      const sys = '你是经典电影推荐编辑。专长用 80-120 字中文写出每部电影剧情亮点，不剧透结局，客观克制。';
      const listStr = items.map((it: any, i: number) => {
        const cleanTitle = it.title.replace(/（\d+(\.\d+)?分）$/, '').trim();
        return `${i + 1}. ${cleanTitle}（${it.meta || ''}）主演：${(it.actors || []).join('/')}`;
      }).join('\n');
      const usr = `为下面 ${items.length} 部电影各写 80-120 字剧情介绍。严格只输出 JSON：{"plots":[{"plot":"80-120 字中文剧情介绍，不剧透"}]}，plots 数组长度严格等于 ${items.length}，顺序与上面列表一一对应（plots[0] 对应第 1 部、plots[1] 对应第 2 部...），不要 title 字段、不要其他字段或文字。\n\n${listStr}`;
      const c = await aiChat(sys, usr, 2000);
      if (c) {
        try {
          const parsed = JSON.parse(c);
          if (parsed && Array.isArray(parsed.plots)) {
            for (let i = 0; i < items.length && i < parsed.plots.length; i++) {
              const p = parsed.plots[i];
              if (p && typeof p.plot === 'string' && p.plot.trim()) items[i].plot = p.plot.trim().slice(0, 240);
            }
          }
        } catch { /* 解析失败保持原状 */ }
      }
      const missingIdx: number[] = [];
      for (let i = 0; i < items.length; i++) { if (!items[i].plot) missingIdx.push(i); }
      if (missingIdx.length) {
        await Promise.all(missingIdx.map(async (i) => {
          const it = items[i];
          const cleanTitle = it.title.replace(/（\d+(\.\d+)?分）$/, '').trim();
          const usr1 = `电影《${cleanTitle}》（${it.meta || ''}，主演：${(it.actors || []).join('/')}）的剧情介绍。严格只输出 JSON：{"plot":"80-120 字中文剧情介绍，不剧透结局"}，不要其他字段或文字。`;
          try {
            const c1 = await aiChat(sys, usr1, 600);
            if (c1) { const j1 = parseJsonLoose(c1); const p1 = j1 && j1.plot; if (p1 && String(p1).trim()) it.plot = String(p1).trim().slice(0, 240); }
          } catch { /* 单条失败不阻塞 */ }
        }));
      }
    } catch { /* LLM 失败不影响主流程 */ }
    for (const it of items) {
      const actorStr = (it.actors || []).slice(0, 3).join(' / ') + ((it.actors || []).length ? ' · 主演' : '');
      it.desc = it.plot ? `${actorStr}\n${it.plot}` : actorStr;
    }
    return { key: 'movie', label: '经典老电影', items };
  } catch { return { key: 'movie', label: '经典老电影', items: [{ title: '（老电影源暂不可用）', desc: '稍后刷新重试。' }] }; }
}
async function genEcon() {
  try {
    const j = await fetchJson('https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2510&num=14&encode=utf-8', { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }, 5000);
    const arr = (j && j.result && j.result.data) || [];
    const items = arr.slice(0, 10).map((it: any) => {
      const title = stripHtml(it.title || '').trim();
      const intro = stripHtml(it.intro || '').replace(/\s+/g, ' ').trim();
      const media = stripHtml(it.media || '').trim();
      return { title, desc: intro || media, url: it.url || '', meta: media };
    }).filter((x: any) => x.title);
    if (items.length) return { key: 'econ', label: '每日经济新闻', items };
    return { key: 'econ', label: '每日经济新闻', items: [{ title: '（经济新闻源暂不可用）', desc: '稍后刷新重试。' }] };
  } catch { return { key: 'econ', label: '每日经济新闻', items: [{ title: '（经济新闻源暂不可用）', desc: '稍后刷新重试。' }] }; }
}
async function genEnglish() {
  if (!hasAnyAiKey()) return { key: 'english', label: '每日英语', items: [{ title: '（需配置 AI 接口密钥）', desc: AI_UNAVAILABLE_TIP }] };
  const sys = '你是英语老师。严格只输出 JSON：{"words":[{"word":"单词","phonetic":"音标","pos":"词性","meaning":"中文释义","example":"英文例句","exampleZh":"例句中文","tip":"记忆提示(词根/联想/易混辨析)"}]}，生成 8 个职场/跨境电商实用单词（涵盖商务沟通/谈判/物流/营销），按使用场景从前到后排。';
  const usr = '请直接输出 JSON，不要任何解释文字。';
  const c = await aiChat(sys, usr, 1800);
  const j = parseJsonLoose(c);
  const words = (j && j.words) || [];
  if (!words.length) return { key: 'english', label: '每日英语', items: [{ title: '（AI 生成暂未成功）', desc: AI_UNAVAILABLE_TIP }] };
  return { key: 'english', label: '每日英语', items: words.slice(0, 8).map((w: any) => ({
    title: w.word || '', meta: [w.phonetic, w.pos].filter(Boolean).join(' '), desc: [w.meaning, w.tip].filter(Boolean).join('；'),
    example: w.example || '', exampleZh: w.exampleZh || '', url: ''
  })).filter((x: any) => x.title) };
}
async function genStory() {
  if (!hasAnyAiKey()) return { key: 'story', label: '睡前故事', title: '（需配置 AI 接口密钥）', body: AI_UNAVAILABLE_TIP, single: true, items: [] };
  const sys = '你是一位温柔的睡前故事作者。严格只输出 JSON：{"title":"故事标题(8字内)","subtitle":"副标题","body":"正文","segments":["段落一","段落二","段落三"]}。\n' +
    '正文要求：1) 字数 600~900 字；2) 共 3 段（开头铺陈/中段温暖转折/结尾留白），每段之间用换行隔开；3) 语言克制温柔，无说教；4) 结尾留一句开放式的回味。\n' +
    'segments 数组请对应正文切分成 3 段，便于 App 渲染。';
  const usr = '主题随机：森林小熊的星星灯 / 海边灯塔守夜人 / 小猫的第一次旅行 / 老钟表匠的雨夜 / 咖啡馆最后一桌客人。直接输出 JSON。';
  const c = await aiChat(sys, usr, 1600);
  const j = parseJsonLoose(c);
  if (j && j.title && (j.body || (j.segments && j.segments.length))) {
    const body = j.body || (j.segments || []).join('\n\n');
    const segs = Array.isArray(j.segments) && j.segments.length ? j.segments : body.split(/\n\n+/).filter(Boolean);
    return { key: 'story', label: '睡前故事', title: j.title, subtitle: j.subtitle || '', body, segments: segs, single: true, items: [] };
  }
  return { key: 'story', label: '睡前故事', title: '（AI 生成暂未成功）', body: AI_UNAVAILABLE_TIP, single: true, items: [] };
}
async function genAiDaily() {
  if (!hasAnyAiKey()) return { key: 'aiDaily', label: 'AI日报', items: [{ title: '（需配置 AI 接口密钥）', desc: AI_UNAVAILABLE_TIP }] };
  const AI_DAILY_SYS = '你是科技财经编辑。挑选最重要的 AI / 前沿科技 / 跨境电商相关新闻，严格只输出 JSON：' +
    '{"briefs":[{"title":"标题","summary":"80-120 字中文摘要(含新闻意义/影响)","url":"原文链接(不知道可留空字符串)","category":"AI/硬件/跨境/电商/投资/科研"}]}，' +
    '务必补全 category 字段；summary 要像给从业者看的新闻简报，不要空话。';

  // 容错提取：LLM 字段名可能不统一（title/headline/name、summary/desc/abstract…）
  function normBrief(b: any) {
    if (!b || typeof b !== 'object') return null;
    const title = String(b.title || b.headline || b.name || b.subject || '').trim();
    if (!title) return null;
    const summary = String(b.summary || b.desc || b.description || b.abstract || b.text || b.content || '').trim();
    const url = String(b.url || b.link || b.source || '').trim();
    const category = String(b.category || b.cat || b.tag || '').trim();
    return { title, desc: summary.slice(0, 240), meta: category, url };
  }
  function extractBriefs(c: string | null): any[] {
    if (!c) return [];
    const j = parseJsonLoose(c);
    const raw = (j && (j.briefs || j.news || j.items || j.list)) || [];
    if (!Array.isArray(raw)) return [];
    return raw.map(normBrief).filter(Boolean).slice(0, 8);
  }

  // 1) 多 RSS 源抓标题（任一可达即可）
  const heads: { t: string; u: string }[] = [];
  const RSS_SRCS = [
    'https://www.ithome.com/rss/',
    'https://36kr.com/feed',
    'https://sspai.com/feed'
  ];
  for (const url of RSS_SRCS) {
    try {
      const text = await fetchText(url, { 'User-Agent': 'Mozilla/5.0' }, 6000);
      const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const it of items.slice(0, 30)) {
        const m = it.match(/<title>([\s\S]*?)<\/title>/);
        const lm = it.match(/<link>([\s\S]*?)<\/link>/);
        const t = m ? stripHtml(m[1]).trim() : '';
        const u = lm ? lm[1].replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim() : '';
        if (t && !/^(IT之家|36氪|少数派|RSS|首页|订阅)/.test(t)) heads.push({ t, u });
      }
      if (heads.length >= 12) break;
    } catch { /* 试下一个源 */ }
  }

  try {
    // 2) 优先基于 RSS 标题让 LLM 提炼
    if (heads.length) {
      const usr = '基于以下今日新闻标题，挑选最重要 8 条并写摘要：\n' +
        JSON.stringify(heads.map((h) => ({ t: h.t, u: h.u })));
      const briefs = extractBriefs(await aiChat(AI_DAILY_SYS, usr, 2000));
      if (briefs.length) return { key: 'aiDaily', label: 'AI日报', items: briefs };
    }
    // 3) RSS 全失败或 LLM 没产出 → 让 LLM 凭自身知识生成（兜底，保证有内容）
    const usr = '请基于你自身知识，列出今天最值得关注的 8 条 AI / 前沿科技 / 跨境电商相关新闻并写摘要。直接输出 JSON，不要任何解释。';
    const briefs = extractBriefs(await aiChat(AI_DAILY_SYS, usr, 2000));
    if (briefs.length) return { key: 'aiDaily', label: 'AI日报', items: briefs };
    return { key: 'aiDaily', label: 'AI日报', items: [{ title: '（AI 生成暂未成功）', desc: AI_UNAVAILABLE_TIP }] };
  } catch {
    return { key: 'aiDaily', label: 'AI日报', items: [{ title: '（AI 生成暂未成功）', desc: AI_UNAVAILABLE_TIP }] };
  }
}
async function genWhy() {
  if (!hasAnyAiKey()) return { key: 'why', label: '每日一个为什么', items: [{ title: '（需配置 AI 接口密钥）', desc: AI_UNAVAILABLE_TIP }] };
  const sys = '你是生活科普编辑。严格只输出 JSON：{"qa":[{"q":"一个有趣的生活/科学/历史为什么","a":"简明回答 100-150 字","category":"生活/科学/历史/医学/心理","extend":"一句相关延伸或冷知识(可选)"}]}，生成 8 条多样化的趣味问答。';
  const usr = '例如：为什么天空是蓝色的？为什么面包会膨胀？为什么人在打哈欠时会传染？直接输出 JSON。';
  const c = await aiChat(sys, usr, 1800);
  const j = parseJsonLoose(c);
  const qa = (j && j.qa) || [];
  if (!qa.length) return { key: 'why', label: '每日一个为什么', items: [{ title: '（AI 生成暂未成功）', desc: AI_UNAVAILABLE_TIP }] };
  return { key: 'why', label: '每日一个为什么', items: qa.slice(0, 8).map((x: any) => ({
    title: x.q || '', desc: x.a || '', meta: x.category || '', extend: x.extend || '', url: ''
  })).filter((x: any) => x.title) };
}

// ---------- 每日内容：栏目定义 / 占位 / 合并 ----------
const DAILY_KEYS = ['history', 'movie', 'econ', 'english', 'story', 'aiDaily', 'why'];
const DAILY_LABELS: Record<string, string> = {
  history: '历史上的今天',
  movie: '经典老电影',
  econ: '每日经济新闻',
  english: '每日英语',
  story: '睡前故事',
  aiDaily: 'AI日报',
  why: '每日一个为什么',
};
const DAILY_GENERATORS: Record<string, () => Promise<any>> = {
  history: genHistory, movie: genMovie, econ: genEcon,
  english: genEnglish, story: genStory, aiDaily: genAiDaily, why: genWhy,
};

/** 某栏目是否已有真实内容（非占位）。 */
function sectionIsReal(key: string, sec: any) {
  if (!sec) return false;
  if (key === 'story') return !!(sec.title || sec.body) && !isPlaceholderTitle(sec.title);
  return Array.isArray(sec.items) && sec.items.some((x: any) => x && x.title && !isPlaceholderTitle(x.title));
}

/** 生成中占位块（结构与真实栏目一致，前端无需特殊处理）。 */
function dailyPlaceholder(key: string) {
  const label = DAILY_LABELS[key] || key;
  const tip = hasAnyAiKey()
    ? '内容正在后台生成（首次约 1-2 分钟）。页面会自动刷新，也可手动点右上角「刷新」。'
    : AI_UNAVAILABLE_TIP;
  if (key === 'story') return { key, label, title: '（内容生成中…）', body: tip, single: true, items: [] };
  return { key, label, items: [{ title: '（内容生成中…）', desc: tip }] };
}

/** 用缓存里已生成好的栏目填充，缺失的用占位补齐，保证 7 个栏目都在。 */
function mergeDailyItems(cached: any) {
  const out: any = {};
  for (const k of DAILY_KEYS) {
    const sec = cached ? cached[k] : null;
    out[k] = sectionIsReal(k, sec) ? sec : dailyPlaceholder(k);
  }
  return out;
}

/**
 * 后台生成全部栏目。
 * 关键点：7 个栏目并行跑，且每跑完一个立刻落库（complete=false），
 * 这样前端轮询能看到内容逐步填充，不必等最慢的栏目跑完。
 * （原 CloudBase 版是串行 + 只在最后写一次，首次访问要干等好几分钟。）
 */
async function generateDailyFull(date: string) {
  const prev = await getDaily(date);
  const items: any = { ...((prev && prev.items) || {}) };
  const t0 = Date.now();

  await Promise.allSettled(DAILY_KEYS.map(async (key) => {
    try {
      const sec = await DAILY_GENERATORS[key]();
      if (sec && sectionIsReal(key, sec)) {
        items[key] = sec;                        // 只接受真实内容，避免 LLM 抖动把已生成好的好栏目覆盖成占位
        await setDaily(date, items, false);     // 增量落库，前端轮询可见进度
      } else if (!items[key]) {
        // 首次且本次生成失败：保留占位，避免空白；已有真实内容则绝不被覆盖
        items[key] = sec || dailyPlaceholder(key);
        await setDaily(date, items, false);
      }
    } catch (e: any) {
      console.warn(`[profitLicense] 每日内容「${key}」生成失败: ${e?.message || e}`);
    }
  }));

  await setDaily(date, items, true);
  const done = DAILY_KEYS.filter((k) => sectionIsReal(k, items[k]));
  console.log(`[profitLicense] 每日内容生成完成 ${date}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，成功 ${done.length}/${DAILY_KEYS.length}: ${done.join(',')}`);
  return items;
}

/**
 * GET/POST /daily —— 必须「立即返回」，绝不能同步等 LLM。
 * 有缓存就直接给，缺的栏目用占位补齐，同时在后台触发生成；
 * 前端靠返回里的 complete 标志轮询，逐步拿到填充好的内容。
 */
async function handleGetDaily() {
  if (!dbReady()) return fail(500, '数据库不可用');
  const date = todayStr();
  const doc = await getDaily(date);
  const complete = !!(doc && doc.complete);

  // 缺失/未完成/过期(12h)才后台补生成（不 await，避免阻塞）；单栏 LLM 抖动不再触发无限重生成
  if (dailyNeedsRegen(doc)) refreshDailyIfNeeded(false).catch(() => {});

  const items = mergeDailyItems(doc && doc.items);
  return ok({
    date,
    updatedAt: (doc && doc.updatedAt) || Date.now(),
    items,
    complete,
    generating: !complete,
  });
}

async function handleCronDaily(body: any, _headers: any, query: any) {
  if (!dbReady()) return fail(500, '数据库不可用');
  const ckey = (body && body.cronKey) || (_headers && _headers['x-cron-key']) || '';
  if (ckey !== CRON_SECRET) return fail(403, 'cron key 错误');
  const force = !!(query && (query.force === '1' || query.force === 'true')) || !!(body && body.force);
  const date = todayStr();
  const doc = await getDaily(date);
  if (!force && !dailyNeedsRegen(doc)) return ok({ date, skipped: true });
  const items = await generateDailyFull(date);
  return ok({ date, items });
}

/**
 * 是否需要（重新）生成每日内容。
 * - 文档不存在或未完成 → 需要；
 * - 已生成但超过 12 小时（跨天/内容过期）→ 需要；
 * - 否则不需要（即使个别 LLM 栏偶尔抖动成占位，也保留已生成好的内容，避免无限重生成浪费 LLM 配额）。
 */
function dailyNeedsRegen(doc: any) {
  if (!doc) return true;
  if (!doc.complete) return true;
  const age = Date.now() - (doc.updatedAt || 0);
  return age > 12 * 3600 * 1000;
}

async function refreshDailyIfNeeded(force?: boolean) {
  const date = todayStr();
  const doc = await getDaily(date);
  if (!force && !dailyNeedsRegen(doc)) return { skipped: true, generating: false, doc };
  const startedAt = Number(getMeta('genStartedAt') || 0);
  const now = Date.now();
  if (!force && now - startedAt < 60 * 1000) return { skipped: true, generating: true, doc: doc || null };
  setMeta('genStartedAt', String(now));
  generateDailyFull(date).catch(() => {});
  return { skipped: false, generating: true, doc: doc || null };
}
async function handleRefresh(body: any, _headers: any, query: any) {
  if (!dbReady()) return fail(500, '数据库不可用');
  refreshNewsCache();
  const force = !!(query && (query.force === '1' || query.force === 'true'));
  const dr = await refreshDailyIfNeeded(force);
  const date = todayStr();
  const doc = await getDaily(date);
  return ok({
    newsRefreshing: true,
    dailySkipped: !!dr.skipped && !force,
    dailyGenerating: !!dr.generating,
    forced: force,
    daily: doc ? { date, updatedAt: doc.updatedAt, items: doc.items, complete: !!doc.complete } : null
  });
}

// 服务端抓网页正文
function extractTitle(html: string) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 140) : '';
}
const NAV_JUNK = /首页|新闻|体育|财经|娱乐|科技|博客|图片|专栏|更多|汽车|教育|时尚|女性|星座|健康|房产|视频|收藏|育儿|读书|佛学|游戏|旅游|邮箱|导航|移动客户端|新浪微博|新浪新闻|新浪首页|关于我们|联系我们|免责声明|隐私政策|版权声明|网站地图|广告服务|意见反馈|登录|注册|搜索|频道/;
function extractArticle(html: any) {
  if (!html) return '';
  let h = String(html);
  h = h.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  h = stripHtml(h);
  const lines = h.split(/\n|\r/).map((s: string) => s.trim()).filter((s: string) => {
    if (s.length < 18) return false;
    if (NAV_JUNK.test(s) && s.length < 80) return false;
    return true;
  });
  return lines.slice(0, 70).join('\n');
}
async function handleExtract(_body: any, _headers: any, query: any) {
  const url = query && query.url;
  if (!url || !/^https?:\/\//i.test(url)) return fail(400, '缺少或非法 url');
  try {
    const html = await fetchText(url, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 9000);
    const title = extractTitle(html);
    const text = extractArticle(html);
    if (!text) return fail(502, '无法提取正文（可能是需登录页面或强反爬站点）');
    return ok({ url, title, text: text.slice(0, 6000) });
  } catch (e: any) { return fail(502, '抓取失败: ' + ((e && e.message) || '')); }
}

// ---------- OCR 文本结构化（视觉模型未配置时走文本模式） ----------
const OCR_TEXT_SYS = '你是电商采购账单识别助手。用户会给你一段 OCR（光学字符识别）识别出的原始文本，可能很乱、有错字、有多条记录。' +
  '请从中提取采购记录，严格只输出 JSON：{"records":[{"name":"商品名(简洁)","amount":12.34,"channel":"购买渠道(1688/拼多多/淘宝/闲鱼/其他,尽量判断)","date":"YYYY-MM-DD(能从文本判断就填,否则留空)","shop":"店铺名(有就填,没有留空)","note":"备注(无则空)"}]}。' +
  '商品名规则（按优先级）：' +
  '1) 若文本里出现【已购规格/所选规格/规格/SKU】，且内容能独立表达“是什么商品”（如“方块捏捏乐--蓝色”、“曲奇饼干奶油裱花枪 铝合金裱花”），优先用它作为 name，忽略营销长标题；' +
  '2) 若规格只是数量/配件描述，不能独立说明商品主体（如“20个片+8个不锈钢嘴”、“x1”、“蓝色/大号”），则退回用主商品标题，去掉夸张营销词（“同款”“高颜值”“发泄”“神器”“必备”“网红”“爆款”），保留核心主体名称，控制在15字以内；' +
  '3) 若没有规格，则用主商品标题简化；' +
  '4) 绝对不要把按钮文字（“分享商品”“联系商家”“申请退款”“加采购车”“进店”）、优惠信息（“共优惠”“实付:”“免运费”）、店铺名当成商品名。' +
  '金额规则：金额必须是数字，只取“实际支付/实付/总实付/合计”后的数字。平台差异：①1688订单——优先取“总实付 ¥X.XX”（即使同时存在“实付”，也一律以“总实付”为准，例如总实付18.96）；没有“总实付”时才取“实付”；②拼多多订单——取右下角“实付: ¥X.XX”或“实付 ¥X.XX”；③其他渠道取“实付/实际支付/合计”。绝对不要把“共优惠”“原价总计”“定制服务”“运费”“减”后的数字当金额。' +
  '其他：1) 金额必须是数字(不要带货币符号);2) 若文本有多条记录就输出多条;3) 识别不出就输出 {"records":[]};4) 不要编造文本里没有的信息;5) 只输出 JSON 不要解释。';
function cleanOcrRecords(records: any[]) {
  return (records || []).slice(0, 50).map((r: any) => {
    const amt = parseFloat(String(r.amount || '').replace(/[^\d.]/g, ''));
    return {
      name: String(r.name || '').trim(),
      amount: isNaN(amt) ? 0 : amt,
      channel: String(r.channel || '').trim(),
      date: String(r.date || '').trim(),
      shop: String(r.shop || '').trim(),
      note: String(r.note || '').trim()
    };
  }).filter((r: any) => r.name || r.amount > 0);
}
let ocrTextCount = 0;
const OCR_TEXT_MAX_PER_MIN = 30;
async function handleOcrText(body: any) {
  if (!hasAnyAiKey()) return fail(503, '尚未配置任何 AI 密钥（请在 ml-finder 配置 LLM）');
  const image = String(body.image || '').trim();
  const text = String(body.text || '').slice(0, 8000);
  if (image.length > 6 * 1024 * 1024) return fail(400, '图片过大');
  if (!image && !text.trim()) return fail(400, '缺少 image 或 text');
  ocrTextCount++;
  if (ocrTextCount > OCR_TEXT_MAX_PER_MIN) return fail(429, '请求过于频繁，请稍后再试');
  setTimeout(() => { ocrTextCount = Math.max(0, ocrTextCount - 1); }, 60 * 1000);
  const mode = String(body.mode || '').trim();
  const modeHint = mode === 'pdd' ? '（这是拼多多订单截图）' : mode === '1688' ? '（这是1688采购订单截图）' : '';
  // 当前 ml-finder 仅配置文本模型，无视觉模型：图片直接走文本模式会丢失信息，
  // 因此仅支持 Tesseract 原文（text）结构化；若只收到图片且无文本，提示用文本模式。
  if (text.trim()) {
    try {
      const c = await aiChat(OCR_TEXT_SYS, '以下是OCR识别的原始文本' + modeHint + '：\n\n' + text, 1500);
      const j = parseJsonLoose(c);
      const records = (j && Array.isArray(j.records)) ? j.records : null;
      if (!records) return ok({ records: [], raw: String(c).slice(0, 500), engine: 'text' });
      return ok({ records: cleanOcrRecords(records), engine: 'text' });
    } catch (e: any) { return fail(502, 'AI 识别失败: ' + ((e && e.message) || String(e))); }
  }
  return fail(400, '当前服务器未配置视觉模型，请使用 OCR 文本模式（Tesseract 原文）');
}

async function handleDiag() {
  const providers = getLlmProviders();
  const anyOk = providers.length > 0;
  let testResult = 'not_run';
  if (anyOk) {
    try {
      const c = await llmGenerate({ systemPrompt: '你是助手', prompt: '用中文只回复两个字：测试', timeoutMs: 15000 });
      testResult = c ? 'ok' : 'empty';
    } catch (e: any) { testResult = 'error: ' + (e?.message || ''); }
  }
  return ok({
    diag: {
      providers: providers.map((p: any) => ({ name: p.name, baseUrl: p.baseUrl, model: p.model })),
      configured: providers.length,
      anyOk,
      testResult,
      note: anyOk
        ? 'AI 由 ml-finder 配置中心（环境变量 LLM_* 或 data/llm-config.json）统一提供，自动 failover。'
        : '未配置任何 LLM：请在 Oracle 服务器 .env 设置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL，或编辑 data/llm-config.json 填入可用供应商。'
    }
  });
}
async function handleLlm(body: any) {
  if (!hasAnyAiKey()) return fail(503, '尚未配置任何 AI 密钥（请设 LLM_API_KEY）');
  const sys = String(body.system || '你是 helpful assistant，回答简洁、准确。').slice(0, 4000);
  const usr = String(body.prompt || body.user || body.messages || '').slice(0, 12000);
  const maxTokens = Math.min(Math.max(parseInt(body.maxTokens || body.max_tokens || 900, 10) || 900, 16), 4000);
  if (!usr) return fail(400, '缺少 prompt');
  try {
    const c = await llmGenerate({ systemPrompt: sys, prompt: usr, timeoutMs: Math.min(maxTokens * 12, 60000), maxTokens });
    if (!c) return fail(502, 'AI 调用失败，请检查 /diag');
    return ok({ content: c });
  } catch (e: any) { return fail(502, 'AI 调用失败: ' + (e?.message || String(e))); }
}

// ---------- 路由注册 ----------
function wrap(fn: (body: any, headers: any, query: any) => Promise<any>) {
  return async (req: any, res: any) => {
    try {
      const r = await fn(req.body || {}, req.headers, req.query || {});
      res.status(r.statusCode).json(r.data);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: '服务器错误: ' + (e?.message || String(e)) });
    }
  };
}
router.post('/generate', wrap(handleGenerate));
router.post('/activate', wrap(handleActivate));
router.post('/reactivate', wrap(handleReactivate));
router.post('/verify', wrap(handleVerify));
router.post('/revoke', wrap(handleRevoke));
router.post('/unbind', wrap(handleUnbind));
router.post('/list', wrap(handleList));
router.post('/my', wrap(handleMy));
router.post('/news', wrap(handleGetNews));
router.get('/news', wrap(handleGetNews));
router.get('/daily', wrap(handleGetDaily));
router.post('/daily', wrap(handleGetDaily));
router.post('/cron-daily', wrap(handleCronDaily));
router.post('/refresh', wrap(handleRefresh));
router.get('/refresh', wrap(handleRefresh));
router.get('/extract', wrap(handleExtract));
router.post('/ocr-text', wrap(handleOcrText));
router.get('/diag', wrap(handleDiag));
router.post('/diag', wrap(handleDiag));

// 网页版管理后台：直接返回静态 HTML，方便在任意浏览器/手机打开管理授权码
router.get('/admin', (_req: any, res: any) => {
  const candidates = [
    path.join(process.cwd(), 'server', 'license-admin.html'),
    path.join(process.cwd(), 'license-admin.html'),
  ];
  try {
    const file = candidates.find((p) => fs.existsSync(p));
    if (!file) {
      res.status(404).type('text/plain; charset=utf-8').send('未找到 license-admin.html（已部署？）');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    res.status(500).type('text/plain; charset=utf-8').send('读取后台页面失败: ' + (e?.message || e));
  }
});
router.post('/llm', wrap(handleLlm));

// ---------- 启动初始化：确保管理员码存在（缺失时自动生成并日志输出） ----------
async function initProfit() {
  if (!dbReady()) { console.warn('[profitLicense] 数据库不可用，跳过初始化'); return; }
  for (const code of ADMIN_CODES) {
    const row = db.prepare('SELECT id FROM licenses WHERE code=?').get(code);
    if (!row) insertLicense(code, 'unused', 'admin', null, null, null, '管理员码');
  }
  if (!ADMIN_CODES.length) {
    // 未配置管理员码：生成一个随机管理员激活码，并写入库 + 日志，方便首次使用
    const seg = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    const code = `ML-ADMIN-${seg()}`;
    insertLicense(code, 'unused', 'admin', null, null, null, '自动生成的管理员码');
    console.log(`[profitLicense] 未配置 PROFIT_ADMIN_CODES，已自动生成管理员激活码（请妥善保存，可用于 App 进入管理员模式并生成用户码）：\n  ${code}`);
  }
  console.log('[profitLicense] 授权/资讯模块已挂载：/api/profit/license-server');
}
initProfit().catch((e) => console.error('[profitLicense] 初始化失败:', e?.message || e));

export default router;
