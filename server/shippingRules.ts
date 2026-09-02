/**
 * 美客多运费规则自动更新模块（服务端一体化：抓取 + AI 解析 + 正则保底）
 *
 * 背景（2026-09-02 实测定位的失败根因）：
 *   1) 前端旧方案用 3 个免费 CORS 代理抓页面 —— cors.eu.org 429、allorigins 520、codetabs 超时，
 *      全部失效，页面内容根本拿不到；
 *   2) 美客多帮助页是 Google Sheets 型内嵌内容，运费表格被 **7 层 unicode 转义**
 *      （\\u003C / \\u002F ...）嵌套在页面数据里，真实 DOM 没有 <tr>/<td>；
 *      浏览器端 parseShippingHTML 只还原 1 层，即使拿到 HTML 也解析失败。
 *
 * 本模块方案：
 *   - 服务器直连抓取帮助页（无 CORS 限制，已验证 6 国全部 200）；
 *   - 多层 unicode 转义还原 → 抽取表格行文本；
 *   - AI 优先：走 ml-finder aiService.llmGenerate（多平台自动 failover）提取档位 JSON；
 *   - 正则保底：AI 不可用/输出非法时，用改进规则引擎解析；
 *   - 返回 { country, engine: 'ai'|'rule', tiers, ... } 供前端直接落 localStorage。
 *
 * 挂载方式（index.ts，须在 app.get('*') SPA 兜底之前）：
 *   import shippingRouter from './shippingRules.js';
 *   app.use('/api/profit/shipping', shippingRouter);
 * 公网入口： https://ml.w999w.dpdns.org/api/profit/shipping/refresh
 */
import express from 'express';

import { llmGenerate, getLlmProviders } from './aiService.js';

const router = express.Router();

// App 是 WebView（file:// / localhost 源），按路由放开 CORS
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// ---------- 国家与默认帮助页 URL（与前端 js/data.js window.DEFAULT_SHIPPING 一致） ----------
export const DEFAULT_COUNTRIES: { code: string; name: string; url: string }[] = [
  { code: 'Mexico', name: '墨西哥', url: 'https://global-selling.mercadolibre.com/help/shipping-costs-envio-cainiao-mexico_41817' },
  { code: 'Brazil', name: '巴西', url: 'https://global-selling.mercadolibre.com/help/41814' },
  { code: 'Colombia', name: '哥伦比亚', url: 'https://global-selling.mercadolibre.com/help/42435' },
  { code: 'Chile', name: '智利', url: 'https://global-selling.mercadolibre.com/help/shipping-fees-chile-cainiao_38716' },
  { code: 'Argentina', name: '阿根廷', url: 'https://global-selling.mercadolibre.com/help/42837' },
  { code: 'Uruguay', name: '乌拉圭', url: 'https://global-selling.mercadolibre.com/help/48391' },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 25000;
// 单次 AI 调用超时：40s 保证两个候选 + 规则保底后，整批（3 并发 × 每 worker 2 国）< Cloudflare 100s
const AI_TIMEOUT_MS = 40000;
/** 至少多少档才算一次成功解析（美客多各国有 20~40 档） */
const MIN_TIERS = 8;

export interface Tier { min: number; max: number; above: number; below: number; }
export interface RefreshResult {
  code: string;
  name: string;
  url: string;
  ok: boolean;
  engine: 'ai' | 'rule' | 'none';
  tiers?: Tier[];
  htmlLen?: number;
  rows?: number;
  error?: string;
  ms: number;
}

// ============ 数值清洗 ============
// '08.06' → 8.06（前导零）；'4,71' → 4.71（西语小数逗号）；'1,234.5' → 1234.5（千分位）；'USD 3.46' → 3.46
export function cleanNumber(s: unknown): number | null {
  if (s == null) return null;
  let t = String(s).trim();
  if (!t) return null;
  t = t.replace(/[^\d.,-]/g, '');
  if (!t || t === '-' || t === '.') return null;
  // 千分位 vs 小数逗号：形如 1,234 / 12,345.6 视为千分位；1,23 / 4,7 视为小数逗号
  if (t.includes(',')) {
    const [, dec] = t.split('.');
    const decLen = dec ? dec.length : 0;
    // 以逗号结尾、或逗号后 3 位且（无小数点或小数点后 1~2 位）→ 千分位
    const m = t.match(/^(\d+),(\d{3})(?:\.(\d{1,2}))?$/);
    if (m) {
      t = m[1] + m[2] + (m[3] ? '.' + m[3] : '');
    } else if (/^\d+,\d{1,2}$/.test(t)) {
      t = t.replace(',', '.');
    } else {
      // 其它情况：去掉逗号（如 4,71 落在上条；4,711 罕见按千分位去逗号）
      t = t.replace(/,/g, '');
    }
    void decLen;
  }
  if (t.includes('.')) {
    // 去除前导零（08.06 → 8.06）
    t = t.replace(/^0+(\d)/, '$1');
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// ============ 多层 unicode 转义还原 ============
// 页面里表格被 \\u003C → \u003C → < 层层嵌套（实测最多 ~7 层），循环还原到不再变化。
export function deepUnescape(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  for (let i = 0; i < 10; i++) {
    const next = s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    if (next === s) break;
    s = next;
  }
  return s;
}

// ============ 从还原后 HTML 抽取表格行文本 ============
// 注意：Google Sheets 型页面把整张表格以多层转义嵌在 <script> 数据里，
// 还原后 <tr>/<td> 可能仍在 script 标签包裹内 —— 因此这里【不剥离 script/style】，
// 还原后直接按 <tr> 切行（行文本不关心原始容器）。
export function htmlToRows(html: string): string[] {
  const dec = deepUnescape(html);
  // 优先按 <tr> 行切；若无 <tr>（页面结构变化/纯文本表格），按 td 分隔/换行切
  let chunks: string[];
  if (/<tr[\s>]/i.test(dec)) {
    chunks = dec.split(/<tr[\s>]/i).slice(1);
  } else {
    chunks = dec
      .replace(/<td[\s>]/gi, ' | ')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\n')
      .split(/\n+/);
  }
  const rows: string[] = [];
  for (const c of chunks) {
    const t = c
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&#?[a-z0-9]+;/gi, ' ')
      .replace(/\\/g, ' ') // 还原后可能残留孤立反斜杠，视为空白
      .replace(/\s+/g, ' ')
      .trim();
    if (t) rows.push(t);
  }
  return rows;
}

// ============ 从行文本解析档位（保底规则引擎） ============
export function parseTiersFromRows(rows: string[]): Tier[] {
  const tiers: Tier[] = [];
  const rangeRe = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/;
  const openRe = /(\d+(?:\.\d+)?)\s*(?:kg|kilos?)?\s*(?:and\s+)?(?:above|beyond|more|over|up\b)/i;
  const openRe2 = /(?:more|over|above|beyond)\s+(\d+(?:\.\d+)?)/i;
  for (const line of rows) {
    // 只处理疑似运费行的：含 '-' 区间或 "above" 开放区间，且含数字
    if (!/\d/.test(line)) continue;
    let min = NaN;
    let max: number = Infinity;
    let m = line.match(rangeRe);
    if (m) {
      min = parseFloat(m[1]);
      max = parseFloat(m[2]);
    } else {
      m = line.match(openRe) || line.match(openRe2);
      if (m) {
        // "15 and above" / "above 15"
        const idx = m[0].search(/\d/);
        min = parseFloat(m[0].slice(idx));
        max = Infinity;
      }
    }
    if (!Number.isFinite(min)) continue;
    if (min < 0 || (Number.isFinite(max) && max <= min)) continue;
    // 提取 USD 数值：先直接收数字模式 "USD xxx"
    const nums: number[] = [];
    const usdRe = /(?:USD|US\$|US)\s*([\d.,]+)/gi;
    let mm: RegExpExecArray | null;
    while ((mm = usdRe.exec(line))) {
      const n = cleanNumber(mm[1]);
      if (n != null) nums.push(n);
    }
    if (nums.length >= 2) {
      // 最后两列为 above/below；表头 "above threshold" 列通常更高或相等，故 max→above，min→below
      const a = nums[nums.length - 2];
      const b = nums[nums.length - 1];
      const above = Math.max(a, b);
      const below = Math.min(a, b);
      if (!Number.isFinite(above) || !Number.isFinite(below) || above < 0 || below < 0) continue;
      tiers.push({ min: round3(min), max: Number.isFinite(max) ? round3(max) : Infinity, above: round3(above), below: round3(below) });
    } else if (nums.length === 1 && !Number.isFinite(max)) {
      // 只有一列开放区间（极少见），above=below=该值
      const v = round3(nums[0]);
      tiers.push({ min: round3(min), max: Infinity, above: v, below: v });
    }
  }
  // 排序（开放区间排最后）+ 处理页面笔误的重叠起点
  // 2026-09-02 实测：巴西页 14kg 段写为 "14.0-14.5 → 150" 后直接接 "14.0-15.0 → 156.4"（起点笔误，应为 14.5）。
  // 旧逻辑按 min 去重会把细分档覆盖成 156.4（38 档，少 1 档）；改为【顺延修复】：起点相同且内容不同时，
  // 把后档起点修正为前档终点（14.0 → 14.5），区间连续单调、两档价格都保留（39 档，与 AI 修正一致但确定性）。
  tiers.sort((x, y) => {
    if (x.min !== y.min) return x.min - y.min;
    const xm = Number.isFinite(x.max) ? x.max : Number.MAX_SAFE_INTEGER;
    const ym = Number.isFinite(y.max) ? y.max : Number.MAX_SAFE_INTEGER;
    return xm - ym;
  });
  const out: Tier[] = [];
  for (const t of tiers) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.min - t.min) < 1e-9) {
      const sameMax = last.max === t.max || Math.abs(last.max - t.max) < 1e-9;
      const samePrice = Math.abs(last.above - t.above) < 1e-9 && Math.abs(last.below - t.below) < 1e-9;
      if (sameMax && samePrice) continue; // 整行完全相同 → 真重复，去重
      if (Number.isFinite(last.max)) {
        t.min = last.max; // 顺延修复
        if (!Number.isFinite(t.max) || t.max > t.min) {
          out.push(t);
          continue;
        }
      }
      continue; // 无法顺延（前档开放区间/顺延后非法）则丢弃，保守不猜
    }
    out.push(t);
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ============ 档位有效性 ============
export function validTiers(tiers: Tier[] | null | undefined): tiers is Tier[] {
  if (!tiers || !Array.isArray(tiers) || tiers.length < MIN_TIERS) return false;
  // 首档须从很轻开始（≤0.3kg），且价格均为有限正数
  if (tiers[0].min > 0.3) return false;
  for (const t of tiers) {
    if (!Number.isFinite(t.min) || !Number.isFinite(t.above) || !Number.isFinite(t.below)) return false;
    if (t.min < 0 || t.above < 0 || t.below < 0) return false;
    if (Number.isFinite(t.max) && t.max <= t.min) return false;
  }
  return true;
}

// ============ 抓取帮助页 ============
export async function fetchHelpPage(url: string): Promise<string> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.length < 3000) throw new Error(`页面过小(${text ? text.length : 0} 字节)，疑似被拦截`);
    return text;
  } finally {
    clearTimeout(to);
  }
}

// ============ AI 解析 ============
function pickChatProviders(): ReturnType<typeof getLlmProviders> {
  const provs = getLlmProviders();
  // 2026-09-02 实测排序（墨西哥页 40 行真实数据）：
  //   - 智谱 glm-5.3-flash：18.9s、finish=stop、JSON 完整、reasoning 短 → 首选
  //   - b.ai deepseek-v4-flash：12.6s 但输出易触 max_tokens 截断（finish=length）→ 次选（已调大 maxTokens 兜底）
  //   - glm-4.5-air / agnes-2.5-flash：reasoning 超长吃光输出预算，content 为空 → 不首选
  // 注意：llmGenerate(opts, provider) 传单 provider 会禁用跨平台 failover（如智谱 429 余额不足时
  // 不会自动尝试 b.ai），因此这里返回【有序候选列表】，由 aiExtractTiers 逐个尝试。
  // 只保留前两个候选：整批 6 国须在 Cloudflare 隧道 100s 内返回（超时即 524），
  // 候选过多（glm-4.5-air / agnes 等 reasoning 悬挂 40s+）会拖垮整批；两候选全败时规则保底即时接管。
  const preferred: { base: string; model: string }[] = [
    { base: 'open.bigmodel.cn', model: 'glm-5.3-flash' },
    { base: 'api.b.ai', model: 'deepseek-v4-flash' },
  ];
  const out: ReturnType<typeof getLlmProviders> = [];
  for (const p of preferred) {
    const hit = provs.find(
      (x) => (x.baseUrl || '').includes(p.base) && x.model === p.model && x.type !== 'volcano-rest' && x.type !== 'volcano-sdk',
    );
    if (hit) out.push(hit);
  }
  return out;
}

const AI_SYSTEM = `你是精确的数据抽取器。输入是美客多(Mercado Libre)跨境运费帮助页的表格行文本。
每行形如：0.1 - 0.2 USD 4.76 USD 1.86
- 第一列：重量区间（kg），开放区间写作 "15 and above" / "above 15" / "15 or more"；
- 其后每 2 列一组：货币(通常 USD) + 价格；第 2 个价格为"高于包邮门槛"档(above)，第 3 个为"低于包邮门槛"档(below)。
- 来源可能有噪声：西语小数逗号 4,71 = 4.71；前导零 08.06 = 8.06；货币符号 USD/US$。
- 行里也可能混入表头（Weight/Shipping cost/Listings above ... / MXN ...）或其它说明文字，请忽略。
只输出 JSON 数组，每项 {"min":number,"max":number,"above":number,"below":number}；
开放区间的 max 用 null；保留 2 位小数即可。不要输出任何解释、前后缀或 markdown 围栏。`;

export async function aiExtractTiers(rows: string[]): Promise<Tier[]> {
  // 只给有数字的行，且去掉明显表头，控制 token
  const lines = rows
    .filter((r) => /\d/.test(r))
    .filter((r) => !/^\s*(weight|peso|shipping cost|costo|listings|publicaciones|envio|mxn|usd|moneda|currency)\b/i.test(r))
    .slice(0, 80)
    .join('\n');
  if (lines.length > 9000) return Promise.reject(new Error('AI 输入过长'));
  const providers = pickChatProviders();
  if (!providers.length) throw new Error('未找到可用的 chat 类 LLM 配置');
  // AI 优先：按候选顺序逐个平台尝试（一个 429/超时/空内容 → 自动换下一个平台）
  const errors: string[] = [];
  for (const provider of providers) {
    const tag = provider.name || provider.model || 'provider';
    try {
      const raw = await llmGenerate(
        {
          systemPrompt: AI_SYSTEM,
          prompt: '以下是表格文本，请输出档位 JSON 数组：\n' + lines,
          temperature: 0,
          maxTokens: 4000,
          timeoutMs: AI_TIMEOUT_MS,
        },
        provider,
      );
      const tiers = parseAiJson(raw);
      if (validTiers(tiers)) return tiers;
      errors.push(`${tag}: 输出非法(${tiers ? tiers.length : 0} 档)`);
    } catch (e: any) {
      errors.push(`${tag}: ${e?.message || String(e)}`);
    }
  }
  throw new Error('AI 全平台失败：' + errors.join('；'));
}

function parseAiJson(raw: string): Tier[] | null {
  if (!raw) return null;
  let s = raw.trim();
  // 去掉 ```json 围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);
  // 截断容错：若以 '[' 开头但缺少结尾（max_tokens 截断），尝试补 ']'
  const tryParse = (txt: string): Tier[] | null => {
    try {
      const arr = JSON.parse(txt);
      if (!Array.isArray(arr)) return null;
      const out: Tier[] = [];
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const min = cleanNumber((it as any).min);
        if (min == null) continue;
        const rawMax = (it as any).max;
        const max = rawMax == null || rawMax === 'null' ? Infinity : cleanNumber(rawMax);
        const above = cleanNumber((it as any).above);
        const below = cleanNumber((it as any).below);
        if (above == null || below == null) continue;
        out.push({ min, max: max == null ? Infinity : max, above, below });
      }
      out.sort((a, b) => a.min - b.min);
      return out.length ? out : null;
    } catch {
      return null;
    }
  };
  let out = tryParse(s);
  if (!out && s.startsWith('[') && !s.trimEnd().endsWith(']')) {
    out = tryParse(s + ']');
  }
  if (!out && s.startsWith('[')) {
    // max_tokens 截断：可能断在最后一个对象中间（如 ...[{"min":12.5, ），
    // 从最后一个完整 } 处截断并补 ]，丢弃不完整末项
    const cut = s.lastIndexOf('}');
    if (cut > 1) {
      out = tryParse(s.slice(0, cut + 1) + ']');
    }
  }
  return out;
}

// ============ 单页主流程：纯代码优先 → AI 兜底 ============
export type ParseMode = 'auto' | 'code' | 'ai';

/**
 * mode:
 *  - 'code'：纯代码模式——只用规则引擎 parseTiersFromRows，毫秒级、零 AI 依赖、结果可预期。
 *  - 'ai'  ：AI 优先（慢，依赖第三方平台余额/速度），AI 失败再规则保底。
 *  - 'auto'（默认）：纯代码先行——规则引擎解析成功即返回，不再碰 AI（快且免费）；
 *    规则解析不足时才启用 AI 兜底。
 * 2026-09-02 变更（用户要求"传统纯代码方式"）：实测智谱欠费 429、b.ai 单次约 38s 且可能超时，
 * AI 平台波动会把"更新运费"拖慢甚至拖挂；而规则引擎实测 6 国档数与 AI 完全一致且毫秒级，
 * 故默认走纯代码，AI 降级为可选兜底。
 */
export async function analyzeCountryPage(
  url: string,
  mode: ParseMode = 'auto',
): Promise<{ engine: 'ai' | 'rule'; tiers: Tier[]; htmlLen: number; rows: number; aiError?: string }> {
  const html = await fetchHelpPage(url);
  const rows = htmlToRows(html);
  if (!rows.length) throw new Error('页面未解析出任何行');
  const tRule = parseTiersFromRows(rows);
  const ruleValid = validTiers(tRule);
  if (mode === 'code') {
    if (ruleValid) return { engine: 'rule', tiers: tRule, htmlLen: html.length, rows: rows.length };
    throw new Error(`规则引擎未解析出有效档位(${tRule.length} 档)`);
  }
  if (mode === 'auto' && ruleValid) {
    return { engine: 'rule', tiers: tRule, htmlLen: html.length, rows: rows.length };
  }
  // 走到这里 = mode==='ai'，或 auto 且规则引擎不足 → 用 AI 兜底
  let aiError: string | undefined;
  try {
    const t = await aiExtractTiers(rows);
    if (validTiers(t)) return { engine: 'ai', tiers: t, htmlLen: html.length, rows: rows.length };
    aiError = `AI 档数不足(${t.length})`;
  } catch (e: any) {
    aiError = e?.message || String(e);
  }
  if (ruleValid) return { engine: 'rule', tiers: tRule, htmlLen: html.length, rows: rows.length, aiError };
  throw new Error(`AI 失败(${aiError || 'unknown'})；规则引擎也未解析出有效档位(${tRule.length} 档)`);
}

// ============ 路由 ============

/** GET /countries：内置国家与 URL（供前端同步/展示） */
router.get('/countries', (_req, res) => {
  res.json({ success: true, countries: DEFAULT_COUNTRIES });
});

/** GET /probe?url=...&mode=auto|code|ai：单页诊断（返回 engine 与档位；默认 auto=纯代码优先） */
router.get('/probe', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ success: false, error: '缺少 url 参数' });
    return;
  }
  const mode = (['code', 'ai', 'auto'].includes(String(req.query.mode)) ? String(req.query.mode) : 'auto') as ParseMode;
  const t0 = Date.now();
  try {
    const r = await analyzeCountryPage(url, mode);
    res.json({ success: true, mode, ms: Date.now() - t0, ...r });
  } catch (e: any) {
    res.json({ success: false, mode, ms: Date.now() - t0, error: e?.message || String(e) });
  }
});

/** POST /refresh：批量刷新运费规则（默认 auto=纯代码优先；body 可传 {mode:'ai'|'code'|'auto'}） */
router.post('/refresh', async (req, res) => {
  const body = (req.body || {}) as { countries?: { code?: string; url?: string }[]; mode?: string };
  const mode = (['code', 'ai', 'auto'].includes(String(body.mode)) ? String(body.mode) : 'auto') as ParseMode;
  const countries = Array.isArray(body.countries) && body.countries.length
    ? body.countries
        .map((c) => {
          const def = DEFAULT_COUNTRIES.find((d) => d.code === c.code || d.url === c.url);
          return { code: c.code || def?.code || c.url || '', name: def?.name || '', url: String(c.url || def?.url || '').trim() };
        })
        .filter((c) => c.url)
    : DEFAULT_COUNTRIES;
  const t0 = Date.now();
  // 最多 3 个并发，避免瞬时打爆帮助页 / 拖垮 AI
  const results: RefreshResult[] = new Array(countries.length);
  const worker = async (idx: number) => {
    const c = countries[idx];
    const st = Date.now();
    try {
      const r = await analyzeCountryPage(c.url, mode);
      results[idx] = {
        code: c.code || String(c.url),
        name: c.name || c.code || String(c.url),
        url: c.url,
        ok: true,
        engine: r.engine,
        tiers: r.tiers,
        htmlLen: r.htmlLen,
        rows: r.rows,
        ms: Date.now() - st,
      };
    } catch (e: any) {
      results[idx] = {
        code: c.code || String(c.url),
        name: c.name || c.code || String(c.url),
        url: c.url,
        ok: false,
        engine: 'none',
        error: e?.message || String(e),
        ms: Date.now() - st,
      };
    }
  };
  let cursor = 0;
  const runner = async () => {
    while (cursor < countries.length) {
      const i = cursor++;
      await worker(i);
    }
  };
  await Promise.all([runner(), runner(), runner()]);
  const okCount = results.filter((r) => r.ok).length;
  res.json({ success: okCount > 0, total: results.length, ok: okCount, ms: Date.now() - t0, results });
});

export default router;
