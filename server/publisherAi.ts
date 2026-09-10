/**
 * server/publisherAi.ts
 * 「妙手自动发布助手」插件专用 AI 代跑端点。
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
import { llmGenerate, getLlmProviders, detectProviderType } from './aiService.js';
import type { LlmProvider } from './aiService.js';

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

/** 选一批平台：按「上次失败时间」升序（健康的在前），在健康窗口内轮转起点，把请求摊开 */
function pickProviders(pool: number): LlmProvider[] {
  const all = chatProviders();
  if (!all.length) return [];
  const sorted = all.slice().sort((a, b) => (_badUntil.get(pkey(a)) || 0) - (_badUntil.get(pkey(b)) || 0));
  const win = sorted.slice(0, Math.min(sorted.length, pool * 2)); // 健康窗口
  const start = (_rr++) % win.length;
  return win.slice(start).concat(win.slice(0, start)).slice(0, pool);
}

/** 错误消息 → 冷却时长（0 = 不冷却） */
function cooldownMs(msg: string): number {
  const m = msg || '';
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

function validTitleText(t: string): boolean {
  if (!t || t.length < 4 || t.length > 120) return false;
  if (/[。.]$/.test(t)) return false;
  if (looksLikeChatter(t)) return false;
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

/** 单轮并发抢答：同时打 list 里所有平台，谁先给出合格结果用谁 */
function raceOnce(
  callOpts: LLMOpts,
  accept: (raw: string) => boolean,
  list: LlmProvider[],
  budgetMs: number,
  errors: string[]
): Promise<{ text: string; used: string }> {
  return new Promise((resolve) => {
    let done = false;
    let pending = list.length;
    const timer = setTimeout(() => finish('', ''), budgetMs);
    function finish(text: string, used: string) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ text, used });
    }
    for (const p of list) {
      const label = pkey(p);
      (async () => {
        try {
          const raw = await llmGenerate(callOpts, p);
          if (accept(raw)) { _badUntil.delete(label); finish(raw, label); }
          else {
            errors.push(`${label} 结果不合格`);
            _badUntil.set(label, Date.now() + BAD_COOLDOWN_MS); // 会聊天的模型下次还会聊天，先冷一冷
          }
        } catch (e: any) {
          const msg = e?.message || String(e);
          errors.push(`${label} ${msg}`);
          const cd = cooldownMs(msg);
          if (cd > 0) _badUntil.set(label, Date.now() + cd);
        } finally {
          if (--pending === 0) finish('', '');
        }
      })().catch(() => { /* 兜底：绝不让单平台异常冒成 unhandled rejection 把进程带崩 */ });
    }
  });
}

/**
 * 多平台并发抢答（可多轮）：同时打 pool 个平台，谁先给出**合格**结果就用谁；
 * 一轮全灭（整批免费平台同时限额）就换一批再来一轮。
 */
async function raceProviders(
  opts: LLMOpts,
  accept: (raw: string) => boolean,
  opt?: { pool?: number; overallMs?: number; waves?: number }
): Promise<{ text: string; used: string; errors: string[] }> {
  const pool = Math.max(1, Math.min(opt?.pool || DEFAULT_POOL, 10));
  const overallMs = opt?.overallMs || DEFAULT_OVERALL_MS;
  const waves = Math.max(1, Math.min(opt?.waves || DEFAULT_WAVES, 4));
  const errors: string[] = [];
  const tried = new Set<string>();
  const deadline = Date.now() + overallMs;

  const callOpts: LLMOpts = Object.assign({}, opts, {
    timeoutMs: Math.min(opts.timeoutMs || PER_PROVIDER_TIMEOUT_MS, PER_PROVIDER_TIMEOUT_MS),
  });

  for (let w = 0; w < waves; w++) {
    const list = pickProviders(pool).filter((p) => !tried.has(pkey(p)));
    if (!list.length) break;
    list.forEach((p) => tried.add(pkey(p)));
    const remain = deadline - Date.now();
    if (remain < 3000) break;
    const r = await raceOnce(callOpts, accept, list, Math.min(remain, 18000), errors);
    if (r.text) return { text: r.text, used: r.used, errors };
  }
  if (!tried.size) errors.push('无可用 chat 类 LLM 平台');
  return { text: '', used: '', errors };
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
        const r = await raceProviders({
          systemPrompt:
            '你是美客多(CBT)跨境刊登标题优化助手。把电商货源的中文/混杂标题清理成可发布的干净中文标题。规则：' +
            '1) 删除营销话术、店铺名、与商品无关的泛词(如"跨境专供""热销""工厂直供""现货批发""一件代发""包邮")、乱码、重复品牌词；' +
            '2) 保留并理顺:核心产品名+关键卖点+规格(型号/接口/适用机型/材质/颜色/尺寸/数量)；' +
            '3) 若含多个无关产品名只保留最主要的；' +
            '4) 只输出清理后的标题本身,不要任何解释、不要加引号、不要JSON、不要反问用户。',
          prompt: '原标题: ' + title,
          temperature: 0.2,
          maxTokens: 200,
        }, (raw) => validTitleText(tidy(raw)), { pool });
        return respond(res, r, (t) => (validTitleText(tidy(t)) ? tidy(t) : ''), 'text');
      }

      // ---------- 2) 翻译（标题/描述 → 目标语言，默认英文） ----------
      case 'translate': {
        const text0 = String(body.text || '').slice(0, 3000);
        if (!text0) return res.status(400).json({ success: false, message: '请提供 text' });
        const target = String(body.target || 'en').toLowerCase();
        const kind = String(body.kind || 'title');
        const langName = target.startsWith('es') ? '西班牙语' : target.startsWith('pt') ? '葡萄牙语' : '英文';
        const sys = kind === 'desc'
          ? `你是跨境电商商品描述翻译助手，把中文商品描述翻译成地道、简洁的${langName}，保留规格与参数，不要臆造信息。只输出译文，不要解释、不要反问。`
          : `你是跨境电商商品标题翻译助手，把中文标题翻译成符合 Mercado Libre（拉美）搜索习惯的${langName}标题，自然简洁、保留品牌/型号/规格，不要臆造参数。只输出译文，不要解释、不要反问。`;
        const r = await raceProviders({
          systemPrompt: sys,
          prompt: text0,
          temperature: 0.2,
          maxTokens: kind === 'desc' ? 2000 : 300,
          timeoutMs: kind === 'desc' ? 25000 : PER_PROVIDER_TIMEOUT_MS,
        }, (raw) => validTranslatedText(tidy(raw)), { pool, overallMs: kind === 'desc' ? 36000 : DEFAULT_OVERALL_MS });
        return respond(res, r, (t) => (validTranslatedText(tidy(t)) ? tidy(t) : ''), 'text');
      }

      // ---------- 3) 从站点热搜词里挑「真正相关」的（不相关一个都不加） ----------
      case 'pick-trends': {
        const list: string[] = (Array.isArray(body.keywords) ? body.keywords : [])
          .map((k: any) => String(k || '').trim()).filter(Boolean).slice(0, 40);
        if (!list.length) return res.json({ success: true, picks: [], engine: 'ai' });
        const cap = Math.max(1, Math.min(Number(body.maxWords) || 2, 3));
        const sys =
          `你是美客多(Mercado Libre)跨境刊登的 SEO 助手。给定商品标题与目标站点当前热搜词列表，` +
          `从中挑出与该商品**确属同一品类/强相关**的热搜词（最多 ${cap} 个），用于拼进标题提升搜索曝光。` +
          '规则：宁缺勿滥；语义不相关就一个都不要；不得编造列表以外的词；不要挑过于泛而无意义的大词。' +
          '严格只输出 JSON：{"picks":["词1","词2"]}；若一个都不相关就输出 {"picks":[]}。不要反问、不要解释。';
        const user = JSON.stringify({ title: String(body.title || '').slice(0, 160), keywords: list });
        // 「确实没有相关词」也是合法答案 → 只要模型给出结构化 picks 就采纳
        const r = await raceProviders(
          { systemPrompt: sys, prompt: user, temperature: 0.2, maxTokens: 300 },
          (raw) => extractPicks(raw, list, cap).wellFormed,
          { pool }
        );
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
          systemPrompt:
            '你是一名跨境电商商品属性抽取助手。根据货源规格文本(可能来自1688商品详情快照)提取对美客多刊登有用的属性键值。' +
            '要求：只输出能作为类目属性填写的键值(如品牌/型号/适用机型/接口/线材长度/颜色/材质等)；丢弃营销废话。' +
            '已有属性请合并去重，别重复。若某信息不存在则不写该键。不要反问用户。' +
            '严格只输出 JSON：{"attributes":{"属性名":"值"},"notes":"一句话说明不确定点"}',
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
          systemPrompt:
            '你是美客多刊登决策助手。给定一个商品当前 SKU 情况与货源描述，判断：' +
            '1) 该上"单品"还是"多规格(有变体)"？若只有1个SKU且无不同颜色/规格变体→单品；多个SKU(不同颜色/容量/尺寸等)→多规格。' +
            '2) 若是多规格，主属性叫什么(颜色/容量/尺寸/套餐...)，值分别是什么。' +
            '3) 若是单品但货源描述里提到颜色，给出建议颜色值。不要反问用户。' +
            '严格只输出 JSON：{"type":"single"|"multi","variationName":"","values":[],"notes":""}',
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

export default router;
