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
 *   GET  /api/ml/publisher/health          → { ok, providers, models[] }
 *   POST /api/ml/publisher/ai              → { task, ...payload } 见下
 *     task=clean-title      { title }                      → { text }
 *     task=translate        { text, target?, kind? }       → { text }
 *     task=pick-trends      { title, keywords[], maxWords? } → { picks[] }
 *     task=extract-attrs    { notesFull, existing? }        → { json }
 *     task=decide-variation { skuInfo }                     → { json }
 *
 * 全部走 aiService.llmGenerate 的多平台 failover；失败返回 { success:false, message }，
 * 插件侧再回退到本地规则（永不抛错中断主流程）。
 */
import { Router } from 'express';
import { llmGenerate, getLlmProviders } from './aiService.js';

const router = Router();

/** 去掉模型可能带出来的代码围栏/引号，并滤掉明显是「安全回复」的脏内容 */
function tidy(raw: string): string {
  let t = String(raw || '').trim();
  t = t.replace(/^```(?:json|text)?\s*/i, '').replace(/```\s*$/, '').trim();
  t = t.replace(/^["'「『]+|["'」』]+$/g, '').trim();
  if (!t) return '';
  if (/^user safety/i.test(t)) return '';
  if (/^(i'?m|i am|sorry|as an ai|作为|好的|无法|抱歉)/i.test(t)) return '';
  return t;
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

/** 只允许把候选列表里的词作为结果（防模型编词） */
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

/** 健康检查：插件启动时先探一次，能拿到 providers 就说明 AI 已就绪 */
router.get('/health', (_req, res) => {
  const providers = getLlmProviders();
  res.json({
    success: true,
    ok: providers.length > 0,
    providers: providers.length,
    models: providers.map((p) => `${p.name || '?'}:${p.model}`),
    tip: providers.length ? 'AI 就绪（服务端统一提供）' : '服务端未配置任何 LLM，请到 ml-finder 配置中心填写',
  });
});

router.post('/ai', async (req, res) => {
  const body = req.body || {};
  const task = String(body.task || '').trim();
  try {
    switch (task) {
      // ---------- 1) 净化中文标题（删营销话术/店铺名/乱码，保留核心卖点+规格） ----------
      case 'clean-title': {
        const title = String(body.title || '').slice(0, 500);
        if (!title) return res.status(400).json({ success: false, message: '请提供 title' });
        const raw = await llmGenerate({
          systemPrompt:
            '你是美客多(CBT)跨境刊登标题优化助手。把电商货源的中文/混杂标题清理成可发布的干净中文标题。规则：' +
            '1) 删除营销话术、店铺名、与商品无关的泛词(如"跨境专供""热销""工厂直供""现货批发""一件代发""包邮")、乱码、重复品牌词；' +
            '2) 保留并理顺:核心产品名+关键卖点+规格(型号/接口/适用机型/材质/颜色/尺寸/数量)；' +
            '3) 若含多个无关产品名只保留最主要的；' +
            '4) 只输出清理后的标题本身,不要任何解释、不要加引号、不要JSON。',
          prompt: '原标题: ' + title,
          temperature: 0.2,
          maxTokens: 200,
        });
        const text = tidy(raw);
        return res.json({ success: !!text, text, engine: 'ai' });
      }

      // ---------- 2) 翻译（标题/描述 → 英文；也可指定站点语言） ----------
      case 'translate': {
        const text0 = String(body.text || '').slice(0, 3000);
        if (!text0) return res.status(400).json({ success: false, message: '请提供 text' });
        const target = String(body.target || 'en').toLowerCase();
        const kind = String(body.kind || 'title');
        const langName = target.startsWith('es') ? '西班牙语' : target.startsWith('pt') ? '葡萄牙语' : '英文';
        const sys = kind === 'desc'
          ? `你是跨境电商商品描述翻译助手，把中文商品描述翻译成地道、简洁的${langName}，保留规格与参数，不要臆造信息。只输出译文。`
          : `你是跨境电商商品标题翻译助手，把中文标题翻译成符合 Mercado Libre（拉美）搜索习惯的${langName}标题，自然简洁、保留品牌/型号/规格，不要臆造参数。只输出译文。`;
        const raw = await llmGenerate({
          systemPrompt: sys,
          prompt: text0,
          temperature: 0.2,
          maxTokens: kind === 'desc' ? 2000 : 300,
        });
        const text = tidy(raw);
        return res.json({ success: !!text, text, engine: 'ai' });
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
          '严格只输出 JSON：{"picks":["词1","词2"]}';
        const user = JSON.stringify({ title: String(body.title || '').slice(0, 160), keywords: list });

        let picks: string[] = [];
        let raw = '';
        try {
          raw = await llmGenerate({ systemPrompt: sys, prompt: user, temperature: 0.2, maxTokens: 300, jsonMode: true });
        } catch { /* 便宜模型常不支持 json_object → 下面退纯文本 */ }
        let j = parseJson(raw);
        if (j && Array.isArray(j.picks)) picks = j.picks;
        if (!picks.length) {
          const m = String(raw || '').match(/\[[^\]]*\]/);
          if (m) { try { const a = JSON.parse(m[0]); if (Array.isArray(a)) picks = a; } catch { /* ignore */ } }
        }
        if (!picks.length) {
          const txt = await llmGenerate({
            systemPrompt: sys + ' 不要输出 JSON，直接输出选中的词，用英文逗号分隔；没有相关词就输出 NONE。',
            prompt: user,
            temperature: 0.2,
            maxTokens: 200,
          });
          const allow0 = new Set(list.map((k) => k.toLowerCase()));
          picks = String(txt || '').split(/[,，\n;；]/).map((s) => s.replace(/["'`\[\]{}]/g, '').trim())
            .filter((s) => allow0.has(s.toLowerCase()));
        }
        const out = filterPicks(picks, list, cap);
        return res.json({ success: true, picks: out, engine: 'ai' });
      }

      // ---------- 4) 从货源规格快照抽取类目属性 ----------
      case 'extract-attrs': {
        const raw = await llmGenerate({
          systemPrompt:
            '你是一名跨境电商商品属性抽取助手。根据货源规格文本(可能来自1688商品详情快照)提取对美客多刊登有用的属性键值。' +
            '要求：只输出能作为类目属性填写的键值(如品牌/型号/适用机型/接口/线材长度/颜色/材质等)；丢弃营销废话。' +
            '已有属性请合并去重，别重复。若某信息不存在则不写该键。' +
            '严格只输出 JSON：{"attributes":{"属性名":"值"},"notes":"一句话说明不确定点"}',
          prompt: JSON.stringify({ specText: String(body.notesFull || '').slice(0, 2500), existing: body.existing || {} }),
          temperature: 0.1,
          maxTokens: 800,
          jsonMode: true,
        });
        const json = parseJson(raw);
        return res.json({ success: !!(json && typeof json.attributes === 'object'), json, engine: 'ai' });
      }

      // ---------- 5) 判单品/多规格 + 主属性 ----------
      case 'decide-variation': {
        const raw = await llmGenerate({
          systemPrompt:
            '你是美客多刊登决策助手。给定一个商品当前 SKU 情况与货源描述，判断：' +
            '1) 该上"单品"还是"多规格(有变体)"？若只有1个SKU且无不同颜色/规格变体→单品；多个SKU(不同颜色/容量/尺寸等)→多规格。' +
            '2) 若是多规格，主属性叫什么(颜色/容量/尺寸/套餐...)，值分别是什么。' +
            '3) 若是单品但货源描述里提到颜色，给出建议颜色值。' +
            '严格只输出 JSON：{"type":"single"|"multi","variationName":"","values":[],"notes":""}',
          prompt: JSON.stringify(body.skuInfo || {}),
          temperature: 0.1,
          maxTokens: 400,
          jsonMode: true,
        });
        const json = parseJson(raw);
        return res.json({ success: !!json, json, engine: 'ai' });
      }

      default:
        return res.status(400).json({ success: false, message: '未知 task：' + task });
    }
  } catch (err: any) {
    // AI 全平台失败 → 交给插件侧规则兜底，不算致命错误
    return res.json({ success: false, message: err?.message || String(err), engine: 'ai' });
  }
});

export default router;
