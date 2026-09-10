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
 *     &dims=0 关掉重量尺寸补齐（只做规则兜底，快路径）；&dimsBudget=15000 控制 AI 估算预算
 *     &vision=0 关掉「视觉读参数图」；&visionBudget=18000 控制扫图预算
 *   ★ 返回里 product.shipping / product.skuRows[].shipping = 解析好的包裹重量尺寸
 *     （四层：妙手真值 → 视觉读参数图 → AI 估算 → 类目规则表；见 resolveShipping）
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

// ============ 包裹重量 / 尺寸解析（★ 净收益准不准全看这个） ============
//
// 为什么必须有：profit 引擎里 `计费重 = max(实重, 长×宽×高/5000)`。
// 尺寸为空时体积重为 0 → 计费重只剩实重 → 运费被低估 → **净收益虚高**。
// 例：20×15×5cm 的泡货体积重 0.3kg，实重才 0.065kg，差 4.6 倍。
//
// 三层取数（实测过每一层的可得性）：
//   1) 妙手 SKU：weight 有真值（来自 1688，实测 30g），但 length/width/height **常年为 null**
//      —— 妙手侧压根没采集尺寸，别指望它。
//   2) AI 估算：拿标题+类目+已知净重让服务端 LLM 估「商品本体」三边，过合理性校验才采用。
//   3) 类目规则表：命中品类关键词取典型值；再按净重修一下量级。保证**绝不留空**。
//
// 实测排除的路径（别再试）：
//   - 1688 官方 AK 接口 offer_detail：只回一段 markdown 摘要，无重量尺寸。
//   - 直接 curl detail.1688.com/offer/xxx.html：反爬壳页（HTTP 200 但仅 4.8KB，无内容）。
//   - 服务器 DB 历史（candidates/published_items 的 length_cm 等）：实测全为 null，无数据可挖。

/** 常见跨境品类的典型「商品本体尺寸(cm) + 净重(g)」。顺序即优先级（先匹配到先用）。 */
const DIM_RULES: Array<{ re: RegExp; l: number; w: number; h: number; g: number; note: string }> = [
  { re: /(转接头|转接器|转换头|转换器|otg|适配头)/i, l: 9, w: 6, h: 2, g: 30, note: '转接头' },
  { re: /(数据线|充电线|线材|延长线|usb线|type-?c\s*线|lightning\s*线)/i, l: 12, w: 8, h: 2, g: 55, note: '线材' },
  { re: /(充电器|充电头|电源适配器|快充头|插头|车充)/i, l: 10, w: 8, h: 4, g: 110, note: '充电头' },
  { re: /(充电宝|移动电源|power\s*bank)/i, l: 15, w: 10, h: 3, g: 220, note: '充电宝' },
  { re: /(耳机|蓝牙|earbud|headphone|headset)/i, l: 12, w: 10, h: 5, g: 90, note: '耳机' },
  { re: /(手机壳|保护壳|手机套|后壳)/i, l: 18, w: 10, h: 2, g: 40, note: '手机壳' },
  { re: /(钢化膜|贴膜|保护膜|screen\s*protector)/i, l: 18, w: 10, h: 1.5, g: 35, note: '贴膜' },
  { re: /(手表|手环|表带|watch|band)/i, l: 12, w: 10, h: 4, g: 80, note: '手表手环' },
  { re: /(支架|holder|stand)/i, l: 15, w: 12, h: 8, g: 130, note: '支架' },
  { re: /(鼠标|键盘|mouse|keyboard)/i, l: 20, w: 14, h: 5, g: 200, note: '鼠标键盘' },
  { re: /(音箱|喇叭|speaker)/i, l: 18, w: 12, h: 10, g: 300, note: '音箱' },
  { re: /(灯|led|lamp)/i, l: 18, w: 14, h: 12, g: 200, note: '灯具' },
  { re: /(摄像头|camera|监控)/i, l: 14, w: 12, h: 10, g: 180, note: '摄像头' },
  { re: /(手机|平板|tablet|phone)/i, l: 20, w: 12, h: 5, g: 320, note: '手机平板' },
  { re: /(玩具|模型|figure|公仔|玩偶|toy)/i, l: 20, w: 15, h: 10, g: 250, note: '玩具' },
  { re: /(首饰|耳环|项链|戒指|手链|发饰|头绳|发夹)/i, l: 12, w: 8, h: 4, g: 50, note: '饰品' },
  { re: /(钥匙扣|挂件|吊坠)/i, l: 10, w: 8, h: 3, g: 40, note: '挂件' },
  { re: /(笔袋|文具|橡皮|尺子|文具盒|pen|pencil)/i, l: 20, w: 12, h: 4, g: 120, note: '文具' },
  { re: /(贴纸|sticker)/i, l: 18, w: 12, h: 1, g: 30, note: '贴纸' },
  { re: /(工具|螺丝刀|扳手|钳|钻|tool)/i, l: 25, w: 15, h: 5, g: 400, note: '工具' },
  { re: /(杯|水壶|保温|bottle|杯子)/i, l: 25, w: 10, h: 10, g: 400, note: '杯壶' },
  { re: /(背包|收纳|手提包|bag|wallet|钱包)/i, l: 35, w: 25, h: 10, g: 500, note: '包袋' },
  { re: /(t恤|衬衫|卫衣|外套|裤|裙|dress|shirt|pants|衣)/i, l: 30, w: 22, h: 4, g: 350, note: '服饰' },
  { re: /(鞋|sneaker|slipper|拖鞋|shoe)/i, l: 32, w: 20, h: 12, g: 700, note: '鞋' },
  { re: /(帽|hat|cap)/i, l: 25, w: 22, h: 12, g: 200, note: '帽子' },
  { re: /(毛巾|浴巾|towel|毯)/i, l: 28, w: 20, h: 6, g: 350, note: '家纺' },
  { re: /(口红|唇|粉底|眼影|面霜|护肤|面膜|美妆|化妆)/i, l: 12, w: 6, h: 4, g: 90, note: '美妆' },
  { re: /(宠物|猫|狗|pet)/i, l: 20, w: 15, h: 8, g: 250, note: '宠物用品' },
  { re: /(车载|汽车|car)/i, l: 22, w: 15, h: 8, g: 300, note: '车载用品' },
  { re: /(钓|渔具|帐篷|露营|户外|camping)/i, l: 35, w: 20, h: 10, g: 600, note: '户外渔具' },
  { re: /(雨伞|伞|umbrella)/i, l: 30, w: 8, h: 6, g: 350, note: '伞' },
  { re: /(腰带|皮带|belt|手套|围巾|袜)/i, l: 22, w: 16, h: 4, g: 200, note: '配饰' },
];
const DIM_FALLBACK = { l: 20, w: 15, h: 5, g: 150, note: '通用轻小件' };

/** 按净重把规则尺寸放量（小件不放大，大件按体积/重量线性放大） */
function scaleByWeight(d: { l: number; w: number; h: number }, weightG: number | null) {
  const g = Number(weightG) || 0;
  if (g <= 150) return d;
  const k = g <= 400 ? 1.15 : g <= 1000 ? 1.35 : g <= 2500 ? 1.7 : 2.1;
  return { l: +(d.l * k).toFixed(1), w: +(d.w * k).toFixed(1), h: +(d.h * k).toFixed(1) };
}

/** 关键词 → 典型尺寸/净重（标题优先，其次类目面包屑） */
function ruleDims(title: string, breadcrumb?: string, weightG?: number | null) {
  const t = String(title || '');
  const bc = String(breadcrumb || '');
  let hit = DIM_RULES.find((r) => r.re.test(t));
  if (!hit && bc) hit = DIM_RULES.find((r) => r.re.test(bc));
  const base = hit || DIM_FALLBACK;
  const s = scaleByWeight({ l: base.l, w: base.w, h: base.h }, weightG ?? base.g);
  return {
    note: base.note,
    dims: { l: s.l, w: s.w, h: s.h },
    netWeightG: base.g,
    matchedTitle: !!hit,
  };
}

/**
 * 校验 AI 估的尺寸是否可用。
 * 实测免费模型会回负数、单边 1000cm、或干脆把「体积重」当尺寸回 —— 一律拦掉。
 */
function validDimsJson(j: any) {
  if (!j || typeof j !== 'object') return null;
  const raw = [numOf(j.lengthCm ?? j.length), numOf(j.widthCm ?? j.width), numOf(j.heightCm ?? j.height)];
  if (raw.some((v) => v == null)) return null;
  const arr = (raw as number[]).sort((a, b) => b - a);
  const [l, w, h] = arr;
  if (l < 2) return null;                          // 最长边不足 2cm = 明显不是商品尺寸
  if (h < 0.5 || l > 80) return null;              // 单边 0.5~80cm
  if (l * w * h > 150_000) return null;            // 体积上限 150L（再大不是我们卖的轻小件）
  if (l > 900) return null;                        // 明显把 mm 当 cm
  const volKg = (l * w * h) / 5000;
  const g = numOf(j.netWeightG ?? j.weightG ?? j.weight);
  if (g != null && g > 0 && volKg > 0) {
    const ratio = volKg / (g / 1000);
    if (ratio > 12) return null;                   // 体积重超实重 12 倍 = 明显不匹配
  }
  // 明显把毫米当厘米（三边都 ≥ 3 倍常见）→ 倾向判错
  return { l: +l.toFixed(1), w: +w.toFixed(1), h: +h.toFixed(1), netWeightG: g != null && g > 0 ? g : null };
}

const SYS_ESTIMATE_DIMS =
  '你是跨境电商包裹数据估算助手。根据商品标题与类目，估算该商品**未加外包装的本体三边尺寸**（单位 cm）与单件净重（g）。' +
  '要求：1) 参照真实电商同类商品的常见规格，别凭空夸大；2) 三边按 长≥宽≥高 排列，轻小件通常是 5~40cm 量级；' +
  '3) 单位严格用 cm 与 g，不要用 mm/kg，不要输出体积重；4) 若用户已给出净重则原样照抄该净重；' +
  '5) 会给出 referenceDims 作为同类目的典型值 —— **默认沿用该值**，只有当标题里出现明确的尺寸/容量线索（如 60cm、2L、加大号）时才相应调整；' +
  '6) 不要反问、不要解释。严格只输出 JSON：{"lengthCm":21,"widthCm":14,"heightCm":6,"netWeightG":120}';

/**
 * AI 估尺寸（失败返回 null，由规则表兜底）。
 * refDims = 品类规则值，作为锚点写进提示词 —— 实测不给锚点时同一个转接头会给出
 * 5×3×1 / 8×4×2 / 21×14×6 三种答案（方差极大），给了锚点后基本稳定在同类目量级。
 */
function runEstimateDims(
  info: { title: string; breadcrumb?: string; netWeightG?: number | null; refDims?: { l: number; w: number; h: number } },
  pool = DEFAULT_POOL,
  overallMs = 15000
) {
  return raceProviders(
    {
      systemPrompt: SYS_ESTIMATE_DIMS,
      prompt: JSON.stringify({
        title: String(info.title || '').slice(0, 200),
        category: String(info.breadcrumb || '').slice(0, 200),
        knownNetWeightG: info.netWeightG ?? null,
        referenceDims: info.refDims ? { lengthCm: info.refDims.l, widthCm: info.refDims.w, heightCm: info.refDims.h } : null,
      }),
      temperature: 0.2,
      maxTokens: 200,
      jsonMode: true,
    },
    (raw) => !!validDimsJson(parseJson(raw)),
    { pool, overallMs }
  );
}

// ============ 视觉读图：直接从货源图里识别尺寸/重量（最接近真值的一层） ============
// 实测（2026-09-10）：妙手保留的货源图里含「产品参数图」，图上直接印着尺寸标注
//   （type-c 转接头实测读出 0.8cm / 2.5cm / 1.2cm，与人工看图一致）。
// 为什么必须走视觉：1688 官方 AK 接口只回一段 markdown 摘要（无重量尺寸）、
//   1688 网页是反爬壳页（HTTP 200 但只有 4.8KB）、妙手 notesFull 被截断到 200 字、
//   服务器 DB 历史尺寸列全是 null —— 真值渠道全断，但**图我们拿得到**。
// 池内可用视觉模型（沿用服务器已配 key，无需额外配置）：智谱 glm-4.6v、deepseek-v4-flash-vision-exp。
const VISION_MODEL_RE = /(glm-[\d.]+v$|vision|\bvl\b|qwen[\w.-]*vl|gpt-4o|gemini|omni|pixtral|internvl|llava)/i;

/** 视觉平台候选：健康优先（冷却中的排后面） */
function visionProviders(): LlmProvider[] {
  const all = getLlmProviders().filter((p) => VISION_MODEL_RE.test(String(p.model || '').trim()));
  return all.slice().sort((a, b) => (_badUntil.get(pkey(a)) || 0) - (_badUntil.get(pkey(b)) || 0));
}

/** 真正可用的视觉平台：排除冷却中的；若全在冷却里则退回全部（宁可重试也别空手） */
function healthyVisionProviders(): LlmProvider[] {
  const all = visionProviders();
  const now = Date.now();
  const ok = all.filter((p) => (_badUntil.get(pkey(p)) || 0) <= now);
  return ok.length ? ok : all;
}

const SYS_VISION_DIMS =
  '你是电商商品图参数识别助手。看图，把图上标注的「尺寸」「重量」数字识别出来。' +
  '严格只输出一行 JSON，不要思考过程、不要解释、不要 Markdown 代码块：' +
  '{"hasSize":true,"lengthCm":null,"widthCm":null,"heightCm":null,"weightG":null,' +
  '"packLengthCm":null,"packWidthCm":null,"packHeightCm":null,"packWeightG":null,"rawText":""} ' +
  '规则：' +
  '1) 单位一律换算成 cm 与 g（mm→cm 除以10；m→cm 乘100；kg→g 乘1000）；' +
  '2) 三边按 长≥宽≥高 排列填进 lengthCm/widthCm/heightCm（这是**单件本体**尺寸）；' +
  '3) 图上写「包装尺寸/彩盒尺寸/外箱尺寸」的填 packLengthCm/packWidthCm/packHeightCm；' +
  '4) 图上写「带包装重量/毛重」的填 packWeightG，写「净重/裸重」的填 weightG；' +
  '5) 「箱规」（如 44*39*44，400pcs）是整箱数据**不是单件**，只抄进 rawText，绝对不要当单件尺寸/重量；' +
  '6) 图上没有任何尺寸重量信息 → hasSize=false，其余字段全 null；' +
  '7) rawText 原样抄图上的相关文字（便于人工复核）。';

/**
 * 视觉专用的冷却判定。
 * ★ 不能直接复用 cooldownMs：它对 429 也冷却 90s，而池里**只有一个**可用视觉模型
 *   （glm-4.6v），一旦因为并发限流被冷却，整个视觉层就瘫了（实测就是这个原因导致
 *   「同一商品有时能读出尺寸、有时读不出」）。所以视觉只对「确定废掉」的错误冷却：
 *   日额度耗尽 / 余额不足 / 403 / 404 / 模型下架。429 只当次失败，下次照试。
 */
function visionCooldownMs(msg: string): number {
  const m = msg || '';
  if (/per[-_ ]?day|free-models-per-day|daily|insufficient|balance|quota exceeded|今日额度/i.test(m)) return BAD_COOLDOWN_LONG_MS;
  if (/403|404|unavailable|not available|invalid model|no permission|model not found/i.test(m)) return BAD_COOLDOWN_LONG_MS;
  return 0;
}

/**
 * 对单张图问一次视觉模型。
 * 返回 { json } 成功 / { err } 失败。
 */
async function visionReadOnce(prov: LlmProvider, imgUrl: string, timeoutMs: number): Promise<{ json?: any; err?: string }> {
  const base = String(prov.baseUrl || '').replace(/\/+$/, '');
  const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
  const label = pkey(prov);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(4000, timeoutMs));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.apiKey}` },
      body: JSON.stringify({
        model: prov.model,
        messages: [
          { role: 'system', content: '只输出一行 JSON，禁止输出思考过程或解释。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: SYS_VISION_DIMS },
              { type: 'image_url', image_url: { url: imgUrl } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 1200,
        stream: false,
        // ★ 智谱 glm-4.6v 默认会先输出一大段 reasoning_content（思考过程），
        //   取 max_tokens=500 时正文会被截断成空串（finish_reason:"length"）→
        //   表现就是「同一张图有时读得出、有时读不出」。实测关掉思考后：
        //   耗时 18~22s → 2~4s，且答案稳定正确。别删这行。
        ...(/(bigmodel\.cn|zhipu)/i.test(base) ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = `HTTP ${res.status} ${txt.slice(0, 160)}`;
      const cd = visionCooldownMs(err);
      if (cd > 0) _badUntil.set(label, Date.now() + cd);
      return { err };
    }
    const j: any = await res.json();
    const msg = j?.choices?.[0]?.message || {};
    // 正文为空时兜底去 reasoning_content 里捞（万一某平台不支持关闭思考）
    const c = (typeof msg.content === 'string' && msg.content.trim()) ? msg.content : (msg.reasoning_content || '');
    if (!c) return { err: `返回空内容(finish=${j?.choices?.[0]?.finish_reason || '?'})` };
    const parsed = parseJson(c);
    if (!parsed) return { err: '非 JSON 输出' };
    _badUntil.delete(label);
    return { json: parsed };
  } catch (e: any) {
    const err = e?.message || String(e);
    const cd = visionCooldownMs(err);
    if (cd > 0) _badUntil.set(label, Date.now() + cd);
    return { err };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 对单张图并发问**所有**视觉平台，取第一个合格 JSON。
 * ★ 别改成「按平台轮流分配图片」——实测那样 2/3 的并发槽被失效平台（429/余额0）占掉，
 *   12 张图扫完一张合格结果都没有（glm-4.6v 明明 4~6 秒就能给出正确答案）。
 *   并发问的话失效平台 <1s 就返回错误，完全不拖慢。
 */
function visionReadRace(imgUrl: string, timeoutMs: number): Promise<any | null> {
  const provs = healthyVisionProviders();
  if (!provs.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = provs.length;
    let done = false;
    const settle = (j: any | null) => {
      if (done) return;
      if (j) { done = true; resolve(j); return; }
      if (--pending === 0) { done = true; resolve(null); }
    };
    for (const p of provs) {
      visionReadOnce(p, imgUrl, timeoutMs).then((r) => settle(r.json || null)).catch(() => settle(null));
    }
  });
}

/** 视觉结果 → 可用尺寸/重量（含合理性校验，防止把 mm/kg/箱规 当单件） */
function pickVisionDims(j: any) {
  if (!j || typeof j !== 'object') return null;
  const pos = (v: any) => { const n = numOf(v); return n != null && n > 0 ? n : null; };
  const sorted = (a: number, b: number, c: number) => {
    const [l, w, h] = [a, b, c].sort((x, y) => y - x);
    if (l < 1.5 || h < 0.2 || l > 80) return null;    // 单边合理性（cm）
    if (l * w * h > 150_000) return null;             // 体积上限 150L（再大不是我们卖的轻小件）
    return { l: +l.toFixed(1), w: +w.toFixed(1), h: +h.toFixed(1) };
  };
  const L = pos(j.lengthCm ?? j.length), W = pos(j.widthCm ?? j.width), H = pos(j.heightCm ?? j.height);
  const PL = pos(j.packLengthCm), PW = pos(j.packWidthCm), PH = pos(j.packHeightCm);
  const dims = (L && W && H) ? sorted(L, W, H) : null;
  const packDims = (PL && PW && PH) ? sorted(PL, PW, PH) : null;
  const weightG = pos(j.weightG ?? j.netWeightG ?? j.weight);
  const packWeightG = pos(j.packWeightG ?? j.grossWeightG);
  if (!dims && !packDims && !weightG && !packWeightG) return null;
  return { dims, packDims, weightG, packWeightG, raw: String(j.rawText || '').slice(0, 200) };
}

/** 解析 JPEG/PNG 头拿宽高（配合 Range 请求，只下前 8KB） */
function jpegPngSize(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/**
 * 只下前 8KB 探测图片宽高 —— 用来挑「详情图/参数图」。
 * 实测妙手给的 40 张图混合了：主图(800×800/500×500)、分隔条(790×50)、详情长图(790×1200~1750)。
 * 尺寸标注几乎只出现在**竖长图**上，所以按 高/宽 比值排序优先扫，比盲扫前 12 张命中率高得多
 * （实测盲扫前 12 张直接漏掉了排在第 27 位的「产品参数」图）。
 */
async function probeImageSize(url: string, timeoutMs = 6000): Promise<{ w: number; h: number } | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-8191' }, signal: ac.signal });
    if (!r.ok && r.status !== 206) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return jpegPngSize(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 并发扫货源图找尺寸/重量。
 * 选图策略：先探宽高 → 丢掉缩略图(.500x500)与细长分隔条(高<150) → 按「竖长」优先排序 → 扫前 12 张。
 * 并发 6，**首个合格结果即返回**。实测单张视觉推理 ≈6s；只在妙手真值缺项时才调用。
 */
/**
 * 视觉结果缓存（按图片签名）：**正面结果存 24h、负面结果存 30min**。
 * 理由：同一个商品会被反复规划（重跑、多规格、多站点），每次扫图 15~20s 太浪费；
 * 负面结果只短存 —— 可能只是撞上限流，过一会儿重试是值得的。
 */
const _visionCache = new Map<string, { ts: number; val: any }>();
const VISION_POS_TTL_MS = 24 * 60 * 60 * 1000;
const VISION_NEG_TTL_MS = 30 * 60 * 1000;

async function extractDimsFromImages(urls: string[], budgetMs = 22000) {
  const provs = healthyVisionProviders();
  const raw = (urls || []).map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u) && !/\.500x500\./i.test(u));
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const u of raw) {
    const k = u.split('?')[0].toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(u);
  }
  if (!provs.length) return { result: null as any, errors: ['池内无视觉模型（如 glm-4.6v）'] };
  if (!uniq.length) return { result: null as any, errors: ['没有可扫的货源图'] };

  const cacheKey = uniq.slice(0, 4).map((u) => u.split('?')[0]).join('|') + '#' + uniq.length;
  const cached = _visionCache.get(cacheKey);
  if (cached) {
    const ttl = cached.val ? VISION_POS_TTL_MS : VISION_NEG_TTL_MS;
    if (Date.now() - cached.ts < ttl) {
      return { result: cached.val, errors: cached.val ? [] : ['（缓存）此前扫过，参数图里没有尺寸'], cached: true };
    }
  }

  // 探尺寸（并发 8）→ 只留「真正的竖长详情图」
  const probed: { url: string; w: number; h: number }[] = [];
  let pi = 0;
  const probeWorker = async () => {
    while (pi < uniq.length) {
      const u = uniq[pi++];
      const s = await probeImageSize(u);
      if (s && s.w >= 300) probed.push({ url: u, w: s.w, h: s.h });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, uniq.length) }, () => probeWorker()));
  // 详情长图的宽高比普遍 ≥1.35（主图 1:1、分隔条 0.06、横版海报 <1）；
  // 阈值 1.35 能把「产品参数/规格表」这类图圈进来，同时把主图排除掉，候选从 20+ 降到 ~7 张。
  let tall = probed.filter((x) => x.h >= 400 && x.h / x.w >= 1.35);
  if (tall.length < 2) tall = probed.filter((x) => x.h >= 300 && x.h / x.w >= 0.9);
  tall.sort((a, b) => (b.h / b.w) - (a.h / a.w));
  const cand = (tall.length ? tall.map((x) => x.url) : uniq).slice(0, 10);

  const deadline = Date.now() + budgetMs;
  let idx = 0;
  let found: any = null;
  let scanned = 0;
  let okCalls = 0;
  // 并发 4：关掉 glm 的思考后单张只要 2~4s，4 路并发既快又不容易撞限流
  // （曾经 6 路并发被限流 → 结果时好时坏）。
  const concurrency = Math.min(4, cand.length);
  const worker = async () => {
    while (!found && Date.now() < deadline) {
      const i = idx++;
      if (i >= cand.length) return;
      scanned++;
      const j = await visionReadRace(cand[i], deadline - Date.now());
      if (j) okCalls++;
      const pick = pickVisionDims(j);
      if (pick) found = Object.assign(pick, { img: cand[i] });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (found) _visionCache.set(cacheKey, { ts: Date.now(), val: found });
  else if (okCalls > 0) _visionCache.set(cacheKey, { ts: Date.now(), val: null }); // 模型答了但图里没尺寸 → 短存负面
  return {
    result: found,
    errors: found ? [] : [`探了 ${probed.length} 张、扫了 ${scanned} 张竖长图（成功应答 ${okCalls} 次），未发现印着尺寸/重量的参数图`],
  };
}

export interface ShippingResolved {
  /** 单件净重（g）—— 不含外包装 */
  netWeightG: number;
  /** 商品本体三边（cm）—— 不含外包装 */
  dims: { l: number; w: number; h: number };
  /** 体积重（kg，长×宽×高/5000），插件侧计费重要用 */
  volumeWeightKg: number;
  /** 各字段来源：miaoshou(妙手真值) / vision(参数图识别) / vision-pack(参数图识别,含包装) / ai / rule */
  source: { weight: string; dims: string };
  /** 说人话的解释，便于日志排查 */
  note: string;
  aiError?: string;
  visionError?: string;
}

/**
 * 解析一个商品的包裹重量/尺寸：妙手真值 → 视觉读图 → AI 估算 → 类目规则表。
 * wantAi=false 时跳过 AI（快路径，用于 /material?dims=0 或纯列表场景）。
 */
async function resolveShipping(input: {
  title: string;
  breadcrumb?: string;
  weightG?: any;
  dims?: { l?: any; w?: any; h?: any };
  /** 货源图 URL 列表（妙手 sourceImgUrls）—— 视觉读图用 */
  images?: string[];
  wantAi?: boolean;
  budgetMs?: number;
  visionBudgetMs?: number;
}): Promise<ShippingResolved> {
  const title = String(input.title || '');
  const breadcrumb = String(input.breadcrumb || '');

  let mWeight = numOf(input.weightG);
  if (mWeight != null && mWeight <= 0) mWeight = null;
  const mD = [numOf(input.dims?.l), numOf(input.dims?.w), numOf(input.dims?.h)];
  const miaoshouDims = mD.every((v) => v != null && v > 0) ? { l: mD[0]!, w: mD[1]!, h: mD[2]! } : null;

  let netWeightG = mWeight;
  let dims = miaoshouDims ? { l: miaoshouDims.l, w: miaoshouDims.w, h: miaoshouDims.h } : null;
  const source = { weight: mWeight != null ? 'miaoshou' : 'none', dims: miaoshouDims ? 'miaoshou' : 'none' };
  let aiError = '';
  let visionError = '';
  const notes: string[] = [];

  // 规则值先算好：既是兜底，也用作 AI 结果的**保守校验基准**
  const rd = ruleDims(title, breadcrumb, netWeightG);
  const vol = (d: { l: number; w: number; h: number }) => d.l * d.w * d.h;

  // 2) 视觉读图（最接近真值：货源图里的「产品参数图」常直接印着尺寸标注）
  //    —— 比 AI 凭标题猜准得多，也不受「标题没写尺寸」限制。实测单张 ≈6s、并发 5、首个命中即返回。
  if (input.wantAi && Array.isArray(input.images) && input.images.length && (!dims || netWeightG == null)) {
    try {
      const v = await extractDimsFromImages(input.images, input.visionBudgetMs || 22000);
      const vr: any = v.result;
      if (vr) {
        const vd = vr.dims || vr.packDims;
        if (!dims && vd) {
          dims = { l: vd.l, w: vd.w, h: vd.h };
          // 图上写的是「包装尺寸」时标记 vision-pack —— 插件据此**不再叠加包装增量**
          source.dims = vr.dims ? 'vision' : 'vision-pack';
          notes.push(`尺寸由参数图识别(${vr.dims ? '本体' : '包装'} ${vd.l}×${vd.w}×${vd.h})`);
        }
        if (netWeightG == null) {
          const vw = vr.weightG || vr.packWeightG;
          if (vw != null) {
            netWeightG = vw;
            source.weight = 'vision';
            notes.push(`净重由参数图识别(${vw}g)`);
          }
        }
      } else {
        visionError = (v.errors || []).join('； ');
      }
    } catch (e: any) {
      visionError = e?.message || String(e);
    }
  }

  // 3) AI 估算（只在缺项时调用，省时间）
  if (input.wantAi && (!dims || netWeightG == null)) {
    try {
      const r = await runEstimateDims(
        { title, breadcrumb, netWeightG, refDims: rd.dims },
        DEFAULT_POOL,
        input.budgetMs || 15000
      );
      const j = r.text ? validDimsJson(parseJson(r.text)) : null;
      if (j) {
        if (!dims) {
          const aiDims = { l: j.l, w: j.w, h: j.h };
          // ★ 以品类规则值为锚做**双向**限幅（实测 AI 方差极大）：
          //   偏小 → 体积重偏小 → 运费低估 → 净收益虚高（最危险）；
          //   偏大 → 净收益被过度压低 → 好货被误判成不赚钱。
          //   超出 [0.35×, 3×] 区间就退回规则值。
          const rv = vol(rd.dims) || 1;
          const ratio = vol(aiDims) / rv;
          if (ratio >= 0.35 && ratio <= 3) {
            dims = aiDims;
            source.dims = 'ai';
            notes.push('尺寸由 AI 估算');
          } else {
            dims = { ...rd.dims };
            source.dims = 'rule';
            notes.push(
              `AI 估值 ${aiDims.l}×${aiDims.w}×${aiDims.h} 偏离品类规则「${rd.note}」过多(${ratio.toFixed(1)}×)，改用规则值`
            );
          }
        }
        if (netWeightG == null && j.netWeightG != null) { netWeightG = j.netWeightG; source.weight = 'ai'; notes.push('净重由 AI 估算'); }
      } else {
        aiError = r.errors.join('； ') || '所有平台均未返回合格结果';
      }
    } catch (e: any) {
      aiError = e?.message || String(e);
    }
  }

  // 4) 规则兜底（保证绝不留空）
  if (!dims) { dims = { ...rd.dims }; source.dims = 'rule'; notes.push(`尺寸按品类规则「${rd.note}」取值`); }
  if (netWeightG == null) { netWeightG = rd.netWeightG; source.weight = 'rule'; notes.push(`净重按品类规则「${rd.note}」取值`); }

  const volumeWeightKg = +((dims.l * dims.w * dims.h) / 5000).toFixed(3);
  const out: ShippingResolved = {
    netWeightG: +Number(netWeightG).toFixed(1),
    dims,
    volumeWeightKg,
    source,
    note: notes.join('；') || '妙手侧真实值，无需估算',
  };
  if (aiError) out.aiError = aiError;
  if (visionError) out.visionError = visionError;
  return out;
}

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

      // ---------- 6) 估算包裹重量/尺寸（尺寸缺项时给净收益用；规则表兜底） ----------
      case 'estimate-dims': {
        const r = await resolveShipping({
          title: String(body.title || '').slice(0, 200),
          breadcrumb: String(body.breadcrumb || '').slice(0, 200),
          weightG: body.netWeightG,
          dims: { l: body.lengthCm, w: body.widthCm, h: body.heightCm },
          wantAi: body.ai !== false,
          budgetMs: Number(body.budgetMs) || 15000,
        });
        return res.json({ success: true, shipping: r, engine: r.source.dims === 'ai' || r.source.weight === 'ai' ? 'ai' : 'rule' });
      }

      // ---------- 7) 视觉读货源图，直接识别尺寸/重量（参数图上印着的真值） ----------
      case 'vision-dims': {
        const images: string[] = (Array.isArray(body.images) ? body.images : Array.isArray(body.sourceImgUrls) ? body.sourceImgUrls : [])
          .map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, 20);
        if (!images.length) return res.status(400).json({ success: false, message: '请提供 images[]（货源图 URL）' });
        const v = await extractDimsFromImages(images, Math.max(6000, Math.min(Number(body.budgetMs) || 22000, 30000)));
        return res.json({
          success: !!v.result,
          shipping: v.result ? {
            netWeightG: v.result.packWeightG || v.result.weightG || null,
            dims: v.result.dims || v.result.packDims || null,
            isPackDims: !v.result.dims && !!v.result.packDims,
            rawText: v.result.raw,
          } : undefined,
          scannedBy: v.result ? (v.result.model || 'vision') : undefined,
          matchedImg: v.result ? v.result.img : undefined,
          message: v.result ? undefined : v.errors.join('； '),
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

  const ck = [qDetailId || ('t:' + qThumb) || ('n:' + qTitle), wantAi ? 1 : 0, site, maxWords, target, withDesc ? 1 : 0, String(req.query.dims ?? '1'), String(req.query.vision ?? '1')].join(':');
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
    // 妙手列表里**个别商品没有 cid**（实测 839 条里存在）。详情接口接受 cid=0 并正常返回
    // （实测 cid=1 会报 Category not found，cid=0 不校验类目），所以缺 cid 时用 0 兜底，
    // 而不是直接 404 让插件退回 DOM —— 退回 DOM 就拿不到补齐的重量尺寸了。
    const cid = String(item?.cid || req.query.cid || '0');
    if (!shopId) {
      return res.status(404).json({
        success: false,
        message: `列表项缺少 shopId（detailId=${detailId}）`,
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

    // ---- 2.5) 重量/尺寸解析（★ 净收益准不准全看这里） ----
    //   计费重 = max(实重, 长×宽×高/5000)；尺寸为空 → 体积重 0 → 运费低估 → 净收益虚高。
    //   妙手侧三边尺寸时有时无（AK 接口/1688 页面/DB 历史都补不上缺件，已逐一验证），
    //   所以这里按「妙手真值 → AI 估算 → 类目规则表」补齐，保证绝不留空。
    //   ?dims=0 可关掉（快路径，只做规则兜底不调 AI）。
    const wantDims = String(req.query.dims ?? '1') !== '0';
    // ?vision=0 关掉「视觉读参数图」（默认开：只在妙手真值缺项时才真的扫图）
    const wantVision = String(req.query.vision ?? '1') !== '0';
    const shipBase: any = skuRows.find((r: any) => r.weightG != null || r.dims.l != null) || null;
    let shipping: ShippingResolved | null = null;
    try {
      shipping = await resolveShipping({
        title: product.title,
        breadcrumb: product.breadcrumb,
        weightG: shipBase ? shipBase.weightG : null,
        dims: shipBase ? shipBase.dims : { l: null, w: null, h: null },
        images: wantVision ? (product.sourceImgUrls as string[]) : [],
        wantAi: wantAi && wantDims,
        budgetMs: Math.max(4000, Math.min(Number(req.query.dimsBudget) || 15000, 20000)),
        visionBudgetMs: Math.max(6000, Math.min(Number(req.query.visionBudget) || 22000, 30000)),
      });
      // 逐 SKU：自己那一行有真值就用真值，缺项继承整单解析结果
      for (const r of skuRows as any[]) {
        const ownW = r.weightG != null;
        const ownD = r.dims && r.dims.l != null && r.dims.w != null && r.dims.h != null;
        const merged = {
          netWeightG: ownW ? r.weightG : shipping.netWeightG,
          dims: ownD ? { l: r.dims.l, w: r.dims.w, h: r.dims.h } : shipping.dims,
          source: {
            weight: ownW ? 'miaoshou' : shipping.source.weight,
            dims: ownD ? 'miaoshou' : shipping.source.dims,
          },
        };
        r.shipping = Object.assign({}, merged, {
          volumeWeightKg: +((merged.dims.l * merged.dims.w * merged.dims.h) / 5000).toFixed(3),
          note: ownW && ownD ? '妙手 SKU 真值' : shipping.note,
        });
      }
      (product as any).shipping = shipping;
    } catch (e: any) {
      console.error('[publisher/material] 重量尺寸解析失败:', e?.message || e);
    }

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
        shipping: shipping
          ? { netWeightG: shipping.netWeightG, dims: shipping.dims, volumeWeightKg: shipping.volumeWeightKg, source: shipping.source, note: shipping.note }
          : null,
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
