/**
 * server/publisherAi.ts
 * 「妙手自动发布助手」插件专用端点（AI 代跑 + 商品素材聚合）。
 *
 * 背景：Chrome 插件（miaoshou-auto-publisher）跑在用户浏览器里，本身不该持有 AI key：
 *   1) ml-finder 的 GET /api/ml/llm-config 出于安全**不返回 apiKey**，插件拿到的是空壳 provider；
 *   2) content script 里跨域直连第三方 LLM 还会被浏览器 CORS 拦。
 * 所以把 AI 任务统一发到服务器，用服务器已配好的 LLM（data/llm-config.json / 环境变量 LLM_*）
 * 跑完只返回结果 —— 即「配置都在服务器上，插件直接在服务器上拿」。
 *
 * 挂载：app.use('/api/ml/publisher', publisherAiRouter)
 * 端点：
 *   GET  /api/ml/publisher/health          → { ok, providers, chatProviders, models[] }
 *   POST /api/ml/publisher/ai              → { task, ...payload }
 *     task=clean-title      { title }                        → { text }
 *     task=translate        { text, target?, kind? }         → { text }
 *     task=pick-trends      { title, keywords[], maxWords? } → { picks[] }
 *     task=extract-attrs    { notesFull, existing? }         → { json }
 *     task=decide-variation { skuInfo }                      → { json }
 *   GET  /api/ml/publisher/material?detailId=&site=&ai=1   → 商品素材聚合包（★ 见下）
 *
 * ★ /material —— 「商品数据不用爬 DOM，服务器直连妙手开放平台拿」
 *   插件原来靠读弹框 DOM「猜」标题/属性/SKU/进价，页面一改版就失效。
 *   服务器上有 MIAOSHOU_APP_KEY，进程内直连妙手开放平台就能拿到**结构化全字段**：
 *     详情接口 get_site_collect_item_info 返回 title/notes/notesFull/cid/breadcrumb/
 *     sourceImgUrls[]/videoUrl/attributes[]/saleAttributes[]/siteAndTitleList[]/skuMap(含 weight/尺寸/imgUrls)
 *   /material 把这些 + AI（净化标题/译标题/挑热搜词）一次聚合返回，插件只负责往 DOM 里写。
 *   → 入参只需 detailId：shopId/cid/货源价/净收益 都从采集箱列表缓存补齐（插件零配置）。
 *   → 注意：妙手详情接口**不返回 globalPrice**，且其 price 字段语义与列表不同，
 *     所以货源价/净收益一律取列表接口的 price / globalPrice（见 hidePitfall 注释）。
 *
 * ★ 鲁棒性（都是实测踩出来的，别改回去）：
 *   1) aiService.llmGenerate 不传 timeoutMs 时默认 **120 秒** —— 这里必须给每个平台设 15s，
 *      否则一次失败要等两分钟。
 *   2) 免费平台会整批限额/返空（实测 agnes 429「reached the API rate limit for free users」+
 *      智谱连续「返回空内容」），必须并发抢答 + 多轮换平台，别串行死磕。
 *   3) 个别免费模型会「反问用户」而不是干活（实测返回「你方便补充一下具体的型号和规格吗？」），
 *      也有永久下架的（实测 openrouter 若干 :free 模型直接 404「unavailable for free」）。
 *      所以结果要过业务校验，失败平台要按类型**分级冷却**（永久 10min / 临时 90s）。
 *   4) 冷却表 + 轮转起点让请求自动避开刚挂的平台，下次调用更快更稳。
 *
 * 全部失败返回 { success:false, message }，插件侧再回退本地规则（永不抛错中断主流程）。
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { llmGenerate, getLlmProviders, detectProviderType } from './aiService.js';
import type { LlmProvider } from './aiService.js';
import {
  getMercadoCollectBoxDetail,
  getCachedBoxList,
  setCachedBoxList,
  searchMercadoCollectBoxAll,
} from './miaoshou.js';
import { getTrendsKeywords } from './trends.js';

// ESM 下的 __dirname（server/ 是 ESM，项目里 db.ts / trends.ts 同款写法）。
// 注意：绝对不要直接用裸露的 __dirname —— tsx/esbuild 会据此判定本文件为 CJS，
// 与顶层 await 冲突后抛 ERR_AMBIGUOUS_MODULE_SYNTAX 把进程带崩。
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

type LLMOpts = Parameters<typeof llmGenerate>[0];

const PER_PROVIDER_TIMEOUT_MS = 15000; // 单平台超时（aiService 默认 120s，太长）
const DEFAULT_POOL = 8;                // 每轮并发平台数
const DEFAULT_WAVES = 3;               // 最多几轮
const DEFAULT_OVERALL_MS = 34000;      // 总预算（插件侧单次超时 40s）

// ===== 失败平台分级冷却 =====
const BAD_COOLDOWN_MS = 90_000;        // 临时故障（限额/空返/超时）
const BAD_COOLDOWN_LONG_MS = 600_000;  // 永久不可用（403/404/模型下架）
const _badUntil = new Map<string, number>();
let _rr = 0;

/** 只保留 chat 类平台（OCR/图像/视频/嵌入端点是专用接口，拿来跑文本必失败，白等一轮） */
function chatProviders(): LlmProvider[] {
  return getLlmProviders().filter((p) => detectProviderType(p.baseUrl, p.model) === 'chat');
}

function pkey(p: { name?: string; model?: string }): string {
  return `${p.name || '?'}:${p.model}`;
}

/**
 * 全部 chat 平台，按「上次失败时间」升序排成一条**候选队列**（健康的在前，冷却中的沉底），
 * 并把本请求的轮转起点前移 —— 避免每个请求都从同几个平台开始。
 *
 * 注意这里返回的是整条队列（不是一批）：新的滚动抢答会在窗口腾出一个位就补下一个。
 * 旧做法「每轮只取 pool 个」遇到「前 8 个恰好同时限额」就整轮全灭，实测会白等到 33s 后失败。
 */
function providerQueue(): LlmProvider[] {
  const all = chatProviders();
  if (!all.length) return [];
  const sorted = all.slice().sort((a, b) => (_badUntil.get(pkey(a)) || 0) - (_badUntil.get(pkey(b)) || 0));
  const start = (_rr++) % sorted.length;
  return sorted.slice(start).concat(sorted.slice(0, start));
}

/** 错误消息 → 冷却时长（0 = 不冷却） */
function cooldownMs(msg: string): number {
  const m = msg || '';
  // 日额度打满：实测 openrouter 免费档回 "Rate limit exceeded: free-models-per-day，
  // Add 10 credits..." —— 90 秒后重试必然还是失败，必须按长冷却处理，否则每轮都白等它。
  if (/per[-_ ]?day|free-models-per-day|daily|今日额度|今天的额度/i.test(m)) return BAD_COOLDOWN_LONG_MS;
  // 永久不可用：免费档不给用 / 模型已下架，重试没意义
  if (/403|404|unavailable|not available|only available|invalid model|no permission|model not found/i.test(m)) return BAD_COOLDOWN_LONG_MS;
  // 临时故障：限额、返空、超时、网关错误
  if (/429|rate limit|quota|返回空内容|empty content|aborted|hard timeout|ETIMEDOUT|ECONNRESET|50[234]/i.test(m)) return BAD_COOLDOWN_MS;
  return 0;
}

/** 去掉代码围栏/首尾引号 */
function tidy(raw: string): string {
  let t = String(raw || '').trim();
  t = t.replace(/^```(?:json|text)?\s*/i, '').replace(/```\s*$/, '').trim();
  t = t.replace(/^["'「『]+|["'」』]+$/g, '').trim();
  return t;
}

/** 模型在「聊天/反问/解释」而不是干活 —— 免费模型常见退化，必须拦掉 */
function looksLikeChatter(t: string): boolean {
  if (!t) return true;
  if (/[?？]/.test(t)) return true;
  if (/(请提供|你方便|补充一下|请问|需要我|无法|抱歉|对不起|作为一个|当然可以|我可以帮)/.test(t)) return true;
  if (/\n/.test(t) && t.length > 60) return true;
  if (/^(as an ai|i am|i'?m|sorry)/i.test(t)) return true;
  return false;
}

/** 取「核心词元」：中文 2-gram + 英文/数字词(小写)。用于判断结果是否与原文同源 */
function coreTokens(s: string): Set<string> {
  const out = new Set<string>();
  const txt = String(s || '');
  for (const cn of (txt.match(/[\u4e00-\u9fa5]{2,}/g) || [])) {
    for (let i = 0; i + 2 <= cn.length; i++) out.add(cn.slice(i, i + 2));
  }
  for (const w of (txt.match(/[A-Za-z0-9][A-Za-z0-9-]+/g) || [])) out.add(w.toLowerCase());
  return out;
}

/**
 * 标题合格判定。
 * ⚠️ 实测坑：模型有时只回一个词（真拿到过 text="Type"），若只判「长度 ≥4」会把它当合格，
 * 于是标题被写成 "Type"。所以除长度外，还必须与原文有词元交集（截断/跑偏一律不合格）。
 */
function validTitleText(t: string, source?: string): boolean {
  if (!t || t.length < 6 || t.length > 120) return false;
  if (/[。.]$/.test(t)) return false;
  if (looksLikeChatter(t)) return false;
  if (source) {
    const src = String(source);
    // 相比原文严重截断（不足原文 25% 且不足 12 字）→ 不合格
    if (t.length < 12 && t.length < src.length * 0.25) return false;
    const a = coreTokens(src), b = coreTokens(t);
    if (a.size && b.size) {
      let hit = 0;
      for (const x of b) if (a.has(x)) hit++;
      if (hit === 0) return false;   // 与原文毫无交集 = 截断/跑偏
    }
  }
  return true;
}

function validTranslatedText(t: string): boolean {
  if (!t || t.length < 2) return false;
  if (looksLikeChatter(t)) return false;
  const cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cn / t.length > 0.3) return false; // 中文占比过高 = 根本没翻
  return true;
}

function parseJson(text: string): any {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}

/** 只保留候选列表里的词（防模型编词） */
function filterPicks(picks: any[], allow: string[], cap: number): string[] {
  const map = new Map(allow.map((k) => [String(k).toLowerCase(), k]));
  const out: string[] = [];
  for (const p of Array.isArray(picks) ? picks : []) {
    const key = String(p ?? '').trim().toLowerCase();
    if (!key || key === 'none' || key === '无' || key === '不相关') continue;
    const hit = map.get(key);
    if (hit && !out.includes(hit)) out.push(hit);
    if (out.length >= cap) break;
  }
  return out;
}

/** 从模型输出里抽 picks（容忍 JSON / 裸数组 / 逗号分隔 / NONE） */
function extractPicks(raw: string, allow: string[], cap: number): { picks: string[]; wellFormed: boolean } {
  const j = parseJson(raw);
  if (j && Array.isArray(j.picks)) return { picks: filterPicks(j.picks, allow, cap), wellFormed: true };
  const m = String(raw || '').match(/\[[^\]]*\]/);
  if (m) { try { const a = JSON.parse(m[0]); if (Array.isArray(a)) return { picks: filterPicks(a, allow, cap), wellFormed: true }; } catch { /* ignore */ } }
  if (/NONE|无相关|不相关/i.test(raw || '')) return { picks: [], wellFormed: true };
  const parts = String(raw || '').split(/[,，\n;；]/).map((s) => s.replace(/["'`\[\]{}]/g, '').trim());
  const allowSet = new Set(allow.map((k) => k.toLowerCase()));
  const hit = parts.filter((s) => allowSet.has(s.toLowerCase()));
  if (hit.length) return { picks: filterPicks(hit, allow, cap), wellFormed: true };
  return { picks: [], wellFormed: false };
}

/**
 * 滚动窗口并发抢答：始终维持 pool 个平台在飞，谁先给出**合格**结果就用谁；
 * 每有一个平台失败就立刻从候选队列补下一个 —— 而不是「等整批死光再换一批」。
 *
 * 为什么改：旧版一轮只覆盖 pool(8) 个，实测遇到「前 8 个恰好同时限额」时
 * 整轮全灭、白等到 33s 才失败（free 额度是整批共享的，很容易一起挂）。
 * 滚动补位让一次请求内可以摸到队列里更多平台，同时不增加单请求耗时上限。
 */
async function raceProviders(
  opts: LLMOpts,
  accept: (raw: string) => boolean,
  opt?: { pool?: number; overallMs?: number }
): Promise<{ text: string; used: string; errors: string[] }> {
  const pool = Math.max(1, Math.min(opt?.pool || DEFAULT_POOL, 12));
  const overallMs = opt?.overallMs || DEFAULT_OVERALL_MS;
  const errors: string[] = [];
  const queue = providerQueue();
  if (!queue.length) return { text: '', used: '', errors: ['无可用 chat 类 LLM 平台'] };
  const deadline = Date.now() + overallMs;

  const callOpts: LLMOpts = Object.assign({}, opts, {
    timeoutMs: Math.min(opts.timeoutMs || PER_PROVIDER_TIMEOUT_MS, PER_PROVIDER_TIMEOUT_MS),
  });

  return await new Promise((resolve) => {
    let done = false;
    let inflight = 0;
    let qi = 0;
    const timer = setTimeout(() => finish('', ''), overallMs + 200);
    function finish(text: string, used: string) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ text, used, errors });
    }
    function pump() {
      if (done) return;
      while (inflight < pool && qi < queue.length && Date.now() < deadline - 1500) {
        const p = queue[qi++];
        const label = pkey(p);
        inflight++;
        (async () => {
          try {
            const raw = await llmGenerate(callOpts, p);
            if (accept(raw)) { _badUntil.delete(label); finish(raw, label); return; }
            // 结果不合格（反问/截断/废话）：同一模型下次多半还这样，先冷一冷
            errors.push(`${label} 结果不合格`);
            _badUntil.set(label, Date.now() + BAD_COOLDOWN_MS);
          } catch (e: any) {
            const msg = e?.message || String(e);
            errors.push(`${label} ${msg}`);
            const cd = cooldownMs(msg);
            if (cd > 0) _badUntil.set(label, Date.now() + cd);
          } finally {
            inflight--;
            if (!done) pump();   // 腾出位就补下一个平台
          }
        })().catch(() => { inflight--; if (!done) pump(); /* 兜底：绝不让单平台异常冒成 unhandled rejection */ });
      }
      if (!done && inflight === 0) finish('', '');   // 队列摸完且没有在飞的 → 真没戏
    }
    pump();
  });
}

/** 把 raceProviders 结果变成统一响应体 */
function respond(
  res: any,
  r: { text: string; used: string; errors: string[] },
  convert: (t: string) => any,
  key: string
) {
  const out = convert(r.text);
  const ok = typeof out === 'string' ? !!out : !!out;
  const body: any = {
    success: ok,
    engine: ok ? 'ai' : 'none',
    used: r.used || undefined,
    aiError: ok ? undefined : (r.errors.join('； ') || '所有平台均未返回合格结果'),
  };
  if (typeof out === 'string') body.text = out;
  else if (out) body[key] = out;
  return res.json(body);
}

// ============ AI 任务的提示词（/ai 与 /material 共用，只写一份） ============

const SYS_CLEAN_TITLE =
  '你是美客多(CBT)跨境刊登标题优化助手。把电商货源的中文/混杂标题清理成可发布的干净中文标题。规则：' +
  '1) 删除营销话术、店铺名、与商品无关的泛词(如"跨境专供""热销""工厂直供""现货批发""一件代发""包邮")、乱码、重复品牌词；' +
  '2) 保留并理顺:核心产品名+关键卖点+规格(型号/接口/适用机型/材质/颜色/尺寸/数量)；' +
  '3) 若含多个无关产品名只保留最主要的；' +
  '4) 只输出清理后的标题本身,不要任何解释、不要加引号、不要JSON、不要反问用户。';

function sysTranslate(kind: string, langName: string) {
  return kind === 'desc'
    ? `你是跨境电商商品描述翻译助手，把中文商品描述翻译成地道、简洁的${langName}，保留规格与参数，不要臆造信息。只输出译文，不要解释、不要反问。`
    : `你是跨境电商商品标题翻译助手，把中文标题翻译成符合 Mercado Libre（拉美）搜索习惯的${langName}标题，自然简洁、保留品牌/型号/规格，不要臆造参数。只输出译文，不要解释、不要反问。`;
}

function sysPickTrends(cap: number) {
  return `你是美客多(Mercado Libre)跨境刊登的 SEO 助手。给定商品标题与目标站点当前热搜词列表，` +
    `从中挑出与该商品**确属同一品类/强相关**的热搜词（最多 ${cap} 个），用于拼进标题提升搜索曝光。` +
    '规则：宁缺勿滥；语义不相关就一个都不要；不得编造列表以外的词；不要挑过于泛而无意义的⼤词。' +
    '严格只输出 JSON：{"picks":["词1","词2"]}；若一个都不相关就输出 {"picks":[]}。不要反问、不要解释。';
}

const SYS_EXTRACT_ATTRS =
  '你是一名跨境电商商品属性抽取助手。根据货源规格文本(可能来自1688商品详情快照)提取对美客多刊登有用的属性键值。' +
  '要求：只输出能作为类目属性填写的键值(如品牌/型号/适用机型/接口/线材长度/颜色/材质等)；丢弃营销废话。' +
  '已有属性请合并去重，别重复。若某信息不存在则不写该键。不要反问用户。' +
  '严格只输出 JSON：{"attributes":{"属性名":"值"},"notes":"一句话说明不确定点"}';

const SYS_DECIDE_VARIATION =
  '你是美客多刊登决策助手。给定一个商品当前 SKU 情况与货源描述，判断：' +
  '1) 该上"单品"还是"多规格(有变体)"？若只有1个SKU且无不同颜色/规格变体→单品；多个SKU(不同颜色/容量/尺寸等)→多规格。' +
  '2) 若是多规格，主属性叫什么(颜色/容量/尺寸/套餐...)，值分别是什么。' +
  '3) 若是单品但货源描述里提到颜色，给出建议颜色值。不要反问用户。' +
  '严格只输出 JSON：{"type":"single"|"multi","variationName":"","values":[],"notes":""}';

/** 净化标题（中文） */
function runCleanTitle(title: string, pool = DEFAULT_POOL, overallMs = DEFAULT_OVERALL_MS) {
  return raceProviders(
    { systemPrompt: SYS_CLEAN_TITLE, prompt: '原标题: ' + String(title || '').slice(0, 500), temperature: 0.2, maxTokens: 200 },
    (raw) => validTitleText(tidy(raw), title),
    { pool, overallMs }
  );
}

/** 翻译 */
function runTranslate(text: string, kind: string, target: string, pool = DEFAULT_POOL, overallMs?: number) {
  const langName = target.startsWith('es') ? '西班牙语' : target.startsWith('pt') ? '葡萄牙语' : '英文';
  const budget = overallMs || (kind === 'desc' ? 36000 : DEFAULT_OVERALL_MS);
  return raceProviders(
    {
      systemPrompt: sysTranslate(kind, langName),
      prompt: String(text || '').slice(0, 3000),
      temperature: 0.2,
      maxTokens: kind === 'desc' ? 2000 : 300,
      timeoutMs: kind === 'desc' ? 25000 : PER_PROVIDER_TIMEOUT_MS,
    },
    (raw) => validTranslatedText(tidy(raw)),
    { pool, overallMs: budget }
  );
}

/** 挑热搜词 */
function runPickTrends(title: string, keywords: string[], cap: number, pool = DEFAULT_POOL, overallMs = DEFAULT_OVERALL_MS) {
  return raceProviders(
    { systemPrompt: sysPickTrends(cap), prompt: JSON.stringify({ title: String(title || '').slice(0, 160), keywords }), temperature: 0.2, maxTokens: 300 },
    (raw) => extractPicks(raw, keywords, cap).wellFormed,
    { pool, overallMs }
  );
}

// ============ 健康检查 ============

/** 健康检查：插件启动时先探一次，能拿到 chat 平台就说明 AI 已就绪 */
router.get('/health', (_req, res) => {
  const providers = getLlmProviders();
  const chat = chatProviders();
  res.json({
    success: true,
    ok: chat.length > 0,
    providers: providers.length,
    chatProviders: chat.length,
    cooling: Array.from(_badUntil.entries()).filter(([, t]) => t > Date.now()).length,
    models: chat.map((p) => pkey(p)).slice(0, 12),
    tip: chat.length ? 'AI 就绪（服务端统一提供，插件无需配置 key）' : '服务端没有可用的 chat 类 LLM，请到 ml-finder 配置中心填写',
  });
});

// ============ AI 代跑（单任务） ============

router.post('/ai', async (req, res) => {
  const body = req.body || {};
  const task = String(body.task || '').trim();
  const pool = Number(body.pool) || DEFAULT_POOL;
  try {
    switch (task) {
      // ---------- 1) 净化中文标题（删营销话术/店铺名/乱码，保留核心卖点+规格） ----------
      case 'clean-title': {
        const title = String(body.title || '').slice(0, 500);
        if (!title) return res.status(400).json({ success: false, message: '请提供 title' });
        const r = await runCleanTitle(title, pool);
        return respond(res, r, (t) => (validTitleText(tidy(t)) ? tidy(t) : ''), 'text');
      }

      // ---------- 2) 翻译（标题/描述 → 目标语言，默认英文） ----------
      case 'translate': {
        const text0 = String(body.text || '').slice(0, 3000);
        if (!text0) return res.status(400).json({ success: false, message: '请提供 text' });
        const r = await runTranslate(text0, String(body.kind || 'title'), String(body.target || 'en').toLowerCase(), pool);
        return respond(res, r, (t) => (validTranslatedText(tidy(t)) ? tidy(t) : ''), 'text');
      }

      // ---------- 3) 从站点热搜词里挑「真正相关」的（不相关一个都不加） ----------
      case 'pick-trends': {
        const list: string[] = (Array.isArray(body.keywords) ? body.keywords : [])
          .map((k: any) => String(k || '').trim()).filter(Boolean).slice(0, 40);
        if (!list.length) return res.json({ success: true, picks: [], engine: 'ai' });
        const cap = Math.max(1, Math.min(Number(body.maxWords) || 2, 3));
        const r = await runPickTrends(String(body.title || ''), list, cap, pool);
        const picks = r.text ? extractPicks(r.text, list, cap).picks : [];
        return res.json({
          success: true, picks, engine: 'ai',
          used: r.used || undefined,
          aiError: r.text ? undefined : (r.errors.join('； ') || '所有平台均未返回合格结果'),
        });
      }

      // ---------- 4) 从货源规格快照抽取类目属性 ----------
      case 'extract-attrs': {
        const r = await raceProviders({
          systemPrompt: SYS_EXTRACT_ATTRS,
          prompt: JSON.stringify({ specText: String(body.notesFull || '').slice(0, 2500), existing: body.existing || {} }),
          temperature: 0.1,
          maxTokens: 800,
          jsonMode: true,
        }, (raw) => {
          const j = parseJson(raw);
          return !!(j && j.attributes && typeof j.attributes === 'object' && Object.keys(j.attributes).length);
        }, { pool });
        const json = parseJson(r.text);
        return res.json({
          success: !!(json && json.attributes), json: json || undefined, engine: json ? 'ai' : 'none',
          used: r.used || undefined, aiError: json ? undefined : r.errors.join('； '),
        });
      }

      // ---------- 5) 判单品/多规格 + 主属性 ----------
      case 'decide-variation': {
        const r = await raceProviders({
          systemPrompt: SYS_DECIDE_VARIATION,
          prompt: JSON.stringify(body.skuInfo || {}),
          temperature: 0.1,
          maxTokens: 400,
          jsonMode: true,
        }, (raw) => {
          const j = parseJson(raw);
          return !!(j && (j.type === 'single' || j.type === 'multi'));
        }, { pool });
        const json = parseJson(r.text);
        return res.json({
          success: !!(json && json.type), json: json || undefined, engine: json ? 'ai' : 'none',
          used: r.used || undefined, aiError: json ? undefined : r.errors.join('； '),
        });
      }

      default:
        return res.status(400).json({ success: false, message: '未知 task：' + task });
    }
  } catch (err: any) {
    // AI 全平台失败 → 交给插件侧规则兜底，不算致命错误
    return res.json({ success: false, message: err?.message || String(err), engine: 'none' });
  }
});

// ============ 商品素材聚合（★ 插件改造的核心） ============

/**
 * material 缓存：同一个 detailId 在 60s 内重复请求直接复用。
 * 场景：用户点「编辑」先探一次、正式开跑又探一次；或同商品重试。
 * 注意不能用太长的 TTL —— 妙手侧改了图/属性要能较快反映。
 */
const MATERIAL_TTL_MS = 60_000;
const _materialCache = new Map<string, { ts: number; data: any }>();

function materialCachePut(key: string, data: any) {
  _materialCache.set(key, { ts: Date.now(), data });
  if (_materialCache.size > 300) {
    // 简单淘汰：按时间排序，删掉最旧的 100 条
    const arr = Array.from(_materialCache.entries()).sort((a, b) => a[1].ts - b[1].ts);
    for (const [k] of arr.slice(0, 100)) _materialCache.delete(k);
  }
}

/** 保证采集箱列表在缓存里（material 要用它补 shopId/cid/货源价/净收益） */
async function ensureBoxList(): Promise<any[]> {
  const cached = getCachedBoxList();
  if (cached && cached.length) return cached as any[];
  const r = await searchMercadoCollectBoxAll({ status: 'notPublished', filterCidSite: 'CBT', pageSize: 500 });
  const items = (r.detailList || []) as any[];
  if (items.length) setCachedBoxList(items as any);
  return items;
}

function numOf(v: any): number | null {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

/**
 * GET /material?detailId=xxx[&site=MLM][&ai=1][&maxWords=2][&target=en]
 *
 * 返回：
 *   product  —— 妙手开放平台拿到的结构化商品数据（标题/描述/类目/图片/属性/SKU/货源价/净收益/站点）
 *   ai       —— cleanTitle(中文净化) / titleTranslated(译标题) / trendPicks(相关热搜词) / attrSuggestions
 *   meta     —— elapsedMs / cached / listMatched / aiEngine
 *
 * ★ 货源价与净收益取「列表接口」的 price / globalPrice：
 *   妙手详情接口的 price 字段在 netProceeds 模式下语义是「目标净利润」而非货源价，
 *   且详情**不返回** globalPrice（这里也不硬编码假设，先取列表权威值，详情值仅兜底）。
 */
router.get('/material', async (req, res) => {
  const wantAi = String(req.query.ai ?? '1') !== '0';
  const site = String(req.query.site || 'MLM').toUpperCase();
  const maxWords = Math.max(1, Math.min(Number(req.query.maxWords) || 2, 3));
  const target = String(req.query.target || 'en').toLowerCase();
  const withDesc = String(req.query.desc ?? '0') === '1';

  // ★ 三种定位方式（插件不知道 detailId 时也不用爬 DOM 猜）：
  //   detailId 精确 / thumb 缩略图 URL / title(+itemNum) 标题
  const qDetailId = String(req.query.detailId || '').trim();
  const qThumb = String(req.query.thumb || '').trim();
  const qTitle = String(req.query.title || '').trim();
  const qItemNum = String(req.query.itemNum || '').trim();
  if (!qDetailId && !qThumb && !qTitle) {
    return res.status(400).json({ success: false, message: '需要 detailId / thumb / title 三者之一' });
  }
  if (qDetailId && !/^\d+$/.test(qDetailId)) {
    return res.status(400).json({ success: false, message: 'detailId 应为纯数字' });
  }

  const ck = [qDetailId || ('t:' + qThumb) || ('n:' + qTitle), wantAi ? 1 : 0, site, maxWords, target, withDesc ? 1 : 0].join(':');
  const hit = _materialCache.get(ck);
  if (hit && Date.now() - hit.ts < MATERIAL_TTL_MS) {
    return res.json(Object.assign({}, hit.data, {
      meta: Object.assign({}, hit.data.meta, { cached: true, elapsedMs: Date.now() - hit.ts }),
    }));
  }

  const t0 = Date.now();
  try {
    // ---- 1) 定位列表项：detailId 精确 → 缩略图 URL → 标题(+货号) ----
    //  列表项同时给出 shopId / cid / 货源价 / 净收益（插件不必知道这些）
    const list = await ensureBoxList();
    const normThumb = (u: string) => String(u || '').split('?')[0].trim().toLowerCase();
    let item: any = null;
    let matchedBy = '';
    let ambiguous: any[] = [];

    if (qDetailId) {
      item = list.find((x: any) => String(x.collectBoxDetailId) === qDetailId) || null;
      if (item) matchedBy = 'detailId';
    }
    if (!item && qThumb) {
      const t = normThumb(qThumb);
      const hits = list.filter((x: any) => normThumb(x.thumbnail) === t);
      if (hits.length === 1) { item = hits[0]; matchedBy = 'thumb'; }
      else if (hits.length > 1) { ambiguous = hits; matchedBy = 'thumb'; }
    }
    if (!item && !ambiguous.length && qTitle) {
      const hits = list.filter((x: any) =>
        String(x.title || '').trim() === qTitle && (!qItemNum || String(x.itemNum || '') === qItemNum));
      if (hits.length === 1) { item = hits[0]; matchedBy = 'title'; }
      else if (hits.length > 1) { ambiguous = hits; matchedBy = 'title'; }
    }

    if (ambiguous.length) {
      // 反查撞车（同名/同图）→ 明确报错让插件退回 DOM 模式，绝不猜着填错商品
      return res.status(409).json({
        success: false,
        message: `按 ${matchedBy} 匹配到 ${ambiguous.length} 个商品，无法唯一确定`,
        candidates: ambiguous.slice(0, 5).map((x: any) => ({
          detailId: x.collectBoxDetailId, title: x.title, itemNum: x.itemNum, thumbnail: x.thumbnail,
        })),
      });
    }
    if (!item) {
      return res.status(404).json({
        success: false,
        message: '未在采集箱列表里匹配到该商品（可能已发布/移除，或不在当前「未发布」列表）',
      });
    }

    const detailId = String(item.collectBoxDetailId);
    const shopId = String(item?.collectBoxDetailShop?.shopId || req.query.shopId || '');
    const cid = String(item?.cid || req.query.cid || '');
    if (!shopId || !cid) {
      return res.status(404).json({
        success: false,
        message: `列表项缺少 shopId/cid（detailId=${detailId}）`,
      });
    }

    // ---- 2) 详情：妙手开放平台结构化全字段（AK 直连，进程内调用） ----
    const detail = await getMercadoCollectBoxDetail(detailId, shopId, cid);
    const d: any = (detail && (detail as any).siteCollectItemInfo) || {};

    /**
     * 把妙手的 skuMap（按 skuKey 的字典）拍平成有序数组，字段名统一：
     *   { skuKey, key(可读标签), stock, costCny, weightG, dims:{l,w,h}, imgUrls }
     * 目的：插件拿到就能直接用，不必再懂妙手的原始结构（weight 是字符串、单位可能是 kg…）。
     */
    const skuRows = (() => {
      const map: Record<string, any> = d?.skuMap || {};
      const sale: any[] = Array.isArray(d?.saleAttributes) ? d.saleAttributes : [];
      const label: Record<string, string[]> = {};
      // 妙手两边 skuKey 写法不一致（skuMap 里是 ";6bcf58ba;"，saleAttributes 里是 "6bcf58ba"）→ 归一化后匹配
      const skuKeyNorm = (k: any) => String(k || '').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
      for (const attr of sale) {
        for (const v of (attr?.values || [])) {
          const k = skuKeyNorm(v?.skuKey);
          if (!k) continue;
          (label[k] = label[k] || []).push(String(v?.name || ''));
        }
      }
      const rows: any[] = [];
      for (const [skuKey, s] of Object.entries(map)) {
        if (!s || (s as any).isDelete) continue;
        let weightG = numOf((s as any).weight);
        if (weightG != null && String((s as any).weightUnit || 'g').toLowerCase() === 'kg') {
          weightG = +(weightG * 1000).toFixed(1);
        }
        const xyz = [(s as any).length, (s as any).width, (s as any).height].map((x) => numOf(x));
        rows.push({
          skuKey,
          key: (label[skuKeyNorm(skuKey)] || []).join(' ') || String((s as any).itemNum || '') || skuKey,
          stock: numOf((s as any).stock),
          costCny: numOf((s as any).originPrice),
          weightG,
          dims: { l: xyz[0], w: xyz[1], h: xyz[2] },
          imgUrls: (s as any).imgUrls || [],
        });
      }
      return rows;
    })();

    const product = {
      title: d.title || item?.title || '',
      itemNum: d.itemNum || item?.itemNum || '',
      notes: d.notes || '',
      notesFull: d.notesFull || '',
      /** 货源价（CNY）—— 取列表的 price（详情接口同名字段语义不同，别用） */
      costCny: numOf(item?.price),
      /** 妙手已填的全球净收益（USD），列表有值则用 */
      globalPriceUsd: numOf(item?.globalPrice) ?? numOf(d.globalPrice),
      cid: String(d.cid || cid),
      breadcrumb: d.breadcrumb || item?.breadcrumb || '',
      cateList: d.cateList || [],
      sourceImgUrls: d.sourceImgUrls || [],
      videoUrl: d.videoUrl || '',
      mainImgVideoUrl: d.mainImgVideoUrl || '',
      sourceItemUrl: d.sourceItemUrl || '',
      sites: d.sites || item?.collectBoxDetailShop?.sites || [],
      siteAndTitleList: d.siteAndTitleList || [],
      attributes: d.attributes || [],
      saleAttributes: d.saleAttributes || [],
      skuMap: d.skuMap || {},
      /** 规范化后的 SKU 行（有序数组，插件直接用，不必懂妙手原始结构） */
      skuRows,
      pricingMode: d.pricingMode || item?.collectBoxDetailShop?.pricingMode || '',
      source: d.source || '',
    };

    // ---- 3) AI：净化标题 / 译标题 / 挑热搜词（三路并发，任一失败不影响其它） ----
    // ★ 预算必须收紧：实测三路并发时，只要有一路（多半是热搜词）全平台失败，
    //   raceProviders 会一直重试到 overallMs 上限 —— 曾把整体拖到 33.8s。
    //   这里统一按 aiBudget（默认 15s）封顶，拿不到就返回部分结果，绝不阻塞插件。
    let ai: any = { engine: 'none' };
    if (wantAi) {
      const aiBudget = Math.max(6000, Math.min(Number(req.query.aiBudget) || 12000, 30000));
      const keywords = await getTrendsKeywords(site, 50).catch(() => [] as string[]);
      const [cleanR, trR, trendR] = await Promise.all([
        runCleanTitle(product.title, DEFAULT_POOL, aiBudget),
        product.title ? runTranslate(product.title, 'title', target, DEFAULT_POOL, aiBudget) : Promise.resolve({ text: '', used: '', errors: [] as string[] }),
        keywords.length ? runPickTrends(product.title, keywords, maxWords, DEFAULT_POOL, Math.min(aiBudget, 8000)) : Promise.resolve({ text: '', used: '', errors: [] as string[] }),
      ]);
      const cleanTitle = cleanR.text ? tidy(cleanR.text) : '';
      const titleTranslated = trR.text ? tidy(trR.text) : '';
      const trendPicks = trendR.text ? extractPicks(trendR.text, keywords, maxWords).picks : [];
      ai = {
        engine: (cleanTitle || titleTranslated) ? 'ai' : 'none',
        cleanTitle,
        titleTranslated,
        trendPicks,
        trendSourceSite: keywords.length ? site : '',
        used: cleanR.used || trR.used || trendR.used || undefined,
        errors: [] as string[],
      };
      if (!cleanTitle) (ai.errors as string[]).push('clean-title：' + (cleanR.errors.join('； ') || '无合格结果'));
      if (product.title && !titleTranslated) (ai.errors as string[]).push('translate：' + (trR.errors.join('； ') || '无合格结果'));
      if (keywords.length && !trendPicks.length && !trendR.text) (ai.errors as string[]).push('pick-trends：' + (trendR.errors.join('； ') || '无合格结果'));
      if (!ai.errors.length) delete ai.errors;
    }

    // ---- 4) 可选：描述翻译 ----
    let descTranslated = '';
    if (wantAi && withDesc && product.notes) {
      const r = await runTranslate(product.notes, 'desc', target);
      descTranslated = r.text ? tidy(r.text) : '';
    }

    const data: any = {
      success: true,
      detailId,
      shopId,
      cid,
      matchedBy,
      product,
      ai,
      descTranslated: descTranslated || undefined,
      meta: {
        elapsedMs: Date.now() - t0,
        cached: false,
        listMatched: !!item,
        matchedBy,
        aiEngine: ai.engine,
      },
    };
    materialCachePut(ck, data);
    return res.json(data);
  } catch (e: any) {
    console.error(`[publisher/material] detailId=${detailId} 失败:`, e?.message || e);
    return res.json({ success: false, message: e?.message || String(e), elapsedMs: Date.now() - t0 });
  }
});

// ============ 已处理记录（跨设备一致） ============
/**
 * 插件原来把「已处理」记在 chrome.storage.local —— 换台电脑/换浏览器就丢，
 * 结果重复处理已发布的商品。挪到服务端，任何设备读同一份。
 * 文件：data/publisher-processed.json  { items: ["<shopId>:<detailId>", ...] }
 */
const PROCESSED_FILE = path.join(__dirname, '..', 'data', 'publisher-processed.json');
const PROCESSED_MAX = 20000;
let _processedItems: string[] = [];

(function loadProcessed() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
    if (raw && Array.isArray(raw.items)) {
      _processedItems = raw.items.filter((x: any) => typeof x === 'string');
    }
  } catch { /* 首次运行：文件不存在，留空 */ }
})();

function saveProcessed() {
  try {
    fs.mkdirSync(path.dirname(PROCESSED_FILE), { recursive: true });
    if (_processedItems.length > PROCESSED_MAX) _processedItems = _processedItems.slice(-PROCESSED_MAX);
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify({ items: _processedItems, ts: Date.now() }, null, 2));
  } catch (e: any) {
    console.error('[publisher/processed] 写入失败:', e?.message || e);
  }
}

/** 拉全量已处理 key（插件启动时一次，用于跳过已处理商品） */
router.get('/processed', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ success: true, count: _processedItems.length, items: _processedItems });
});

/** 标记已处理（插件每次成功/跳过后追加）；body.reset=true 可清空重来（测试用） */
router.post('/processed', (req, res) => {
  const body = req.body || {};
  if (body.reset === true) {
    _processedItems = [];
    saveProcessed();
    return res.json({ success: true, reset: true, count: 0 });
  }
  const keys = Array.isArray(body.keys) ? body.keys : (body.key ? [body.key] : []);
  if (!keys.length) return res.status(400).json({ success: false, message: '缺少 key / keys' });
  const set = new Set(_processedItems);
  let added = 0;
  for (const k of keys) {
    const s = String(k || '').trim();
    if (s && !set.has(s)) { set.add(s); added++; }
  }
  _processedItems = Array.from(set);
  if (added) saveProcessed();
  res.json({ success: true, added, count: _processedItems.length });
});

export default router;
