/**
 * 云牛顿（Newton Cloud）AI 货源发现服务
 *
 * 牛顿是一个**交互式多轮 Agent**：向它提自然语言需求（如"在1688找手机壳跨境无货源货源"），
 * 它可能直接搜索并返回含 1688 商品链接/进货价的结果（status=END），
 * 也可能先弹澄清卡（status=WAIT_USER，问预算/材质等），等用户选完再继续。
 *
 * 本模块把 @newton-cloud/server 网关**以内置单例**方式跑在 ml-finder 同一进程里
 * （绑定 127.0.0.1，端口可配 NEWTON_GATEWAY_PORT，默认 4102），对外透出 create/get/resume。
 * 上游契约（服务器实测确认，2026-09-02）：
 *   - 所有 task 端点均为 POST：/api/newton/task/{create,get,resume,fetch,list,kill}
 *   - create body={message} -> {success,data:{taskId,sessionId,status:'INIT'}}
 *   - get    body={taskId,sessionId} -> 轮询 data.status ∈ {INIT,RUNNING,END,WAIT_USER}
 *            data.content=最终正文；data.chunks[]={type:'thinking'|'text'|'tool_call'|'tool_result'|'wait_user',content}
 *   - resume body 顶层放 {taskId,sessionId,toolCallId, userInput|selectedData|skipped}
 *            （网关会把 body 整体作为上游 request 透传，scene 固定 open_api；
 *              因此 userInput/selectedData 必须放顶层，不要套一层 request）
 *   - WAIT_USER 时 wait_user chunk.content 为 JSON：
 *       {toolCallId, expectedReplyId, selectionType:'procurement_clarification', questions:[{question,options[],allowMultiple?}]}
 */
import type { NewtonServerHandle } from '@newton-cloud/server';
import type { Ali1688Product } from './ali1688Skill.js';

const NEWTON_PORT = Number(process.env.NEWTON_GATEWAY_PORT || 4102);
const NEWTON_HOST = process.env.NEWTON_GATEWAY_HOST || '127.0.0.1';
const NEWTON_UPSTREAM_TIMEOUT_MS = Number(process.env.NEWTON_UPSTREAM_TIMEOUT_MS || 30000);

let handle: NewtonServerHandle | null = null;
let listenPromise: Promise<NewtonServerHandle> | null = null;

export function isNewtonConfigured(): boolean {
  return !!process.env.NEWTON_APP_KEY && !!process.env.NEWTON_APP_SECRET && !!process.env.NEWTON_ACCESS_TOKEN;
}

async function ensureGateway(): Promise<NewtonServerHandle> {
  if (handle) return handle;
  if (listenPromise) return listenPromise;
  listenPromise = (async () => {
    const appKey = process.env.NEWTON_APP_KEY;
    const appSecret = process.env.NEWTON_APP_SECRET;
    const accessToken = process.env.NEWTON_ACCESS_TOKEN;
    if (!appKey || !appSecret || !accessToken) {
      throw new Error('牛顿未配置：缺少 NEWTON_APP_KEY / NEWTON_APP_SECRET / NEWTON_ACCESS_TOKEN（请在服务器 .env 配置）');
    }
    // 延迟 import，避免未安装包时影响其它模块启动
    const { createNewtonServer } = await import('@newton-cloud/server');
    const h = createNewtonServer({
      appKey,
      appSecret,
      accessToken,
      port: NEWTON_PORT,
      host: NEWTON_HOST,
      timeoutMs: NEWTON_UPSTREAM_TIMEOUT_MS,
    });
    await h.listen(NEWTON_PORT, NEWTON_HOST);
    handle = h;
    console.log(`[Newton] 网关已启动：http://${NEWTON_HOST}:${NEWTON_PORT}`);
    return h;
  })();
  return listenPromise;
}

function gwBase(): string {
  return `http://${NEWTON_HOST}:${NEWTON_PORT}`;
}

async function gwPost(path: string, body: any): Promise<any> {
  await ensureGateway();
  const r = await fetch(gwBase() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(NEWTON_UPSTREAM_TIMEOUT_MS + 5000),
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, data: { error: text || `牛顿网关返回非 JSON（HTTP ${r.status}）` } };
  }
}

// ============ 对外 API ============

export interface NewtonClarificationQuestion {
  question: string;
  options: string[];
  allowMultiple?: boolean;
}

export interface NewtonClarification {
  toolCallId: string;
  selectionType: string;
  questions: NewtonClarificationQuestion[];
}

export interface NewtonTaskState {
  status: string; // INIT | RUNNING | END | WAIT_USER
  content: string; // 最终/累计正文
  chunks: any[];
  clarification?: NewtonClarification;
}

export async function createNewtonTask(message: string): Promise<{ taskId: string; sessionId: string }> {
  const r = await gwPost('/api/newton/task/create', { message });
  if (!r.success || !r.data?.taskId) {
    throw new Error(r.data?.error || '牛顿创建任务失败');
  }
  return { taskId: r.data.taskId, sessionId: r.data.sessionId };
}

export async function getNewtonTask(taskId: string, sessionId: string): Promise<NewtonTaskState> {
  const r = await gwPost('/api/newton/task/get', { taskId, sessionId });
  const d = r.data || {};
  const state: NewtonTaskState = {
    status: d.status || 'UNKNOWN',
    content: d.content || '',
    chunks: d.chunks || [],
  };
  if (d.status === 'WAIT_USER') {
    const wu = (d.chunks || []).find((x: any) => x.type === 'wait_user');
    if (wu?.content) {
      try {
        const o = typeof wu.content === 'string' ? JSON.parse(wu.content) : wu.content;
        state.clarification = {
          toolCallId: o.toolCallId || o.expectedReplyId,
          selectionType: o.selectionType || o.toolName || '',
          questions: Array.isArray(o.questions) ? o.questions : [],
        };
      } catch {
        /* 解析失败则不带澄清卡 */
      }
    }
  }
  return state;
}

export type NewtonResumeAnswer =
  | { kind: 'userInput'; text: string }
  | { kind: 'selectedData'; values: any }
  | { kind: 'skipped' };

export async function resumeNewtonTask(
  taskId: string,
  sessionId: string,
  toolCallId: string,
  answer: NewtonResumeAnswer
): Promise<void> {
  const body: any = { taskId, sessionId, toolCallId };
  if (answer.kind === 'userInput') body.userInput = answer.text;
  else if (answer.kind === 'selectedData') body.selectedData = answer.values;
  else if (answer.kind === 'skipped') body.skipped = true;
  const r = await gwPost('/api/newton/task/resume', body);
  if (!r.success) {
    throw new Error(r.data?.error || '牛顿续跑失败');
  }
}

// ============ 把牛顿正文解析为 1688 货源候选（best-effort，对齐 Ali1688SearchResult.items）============

export interface NewtonSourcingItem {
  title: string;
  priceCNY: number;
  moq: number;
  supplier: string;
  url: string;
  imageUrl?: string;
}

// 优先匹配 markdown 链接 [标题](url) —— 牛顿返回的商品名就在 [] 里，最准
const MD_LINK_RE = /\[([^\]]{2,80})\]\((https?:\/\/[^\s)]*1688\.com[^\s)]*offer\/\d+[^)\s]*)\)/gi;
// 兜底：裸 1688 offer 链接
const BARE_LINK_RE = /https?:\/\/[^\s)"'<>]*1688\.com[^\s)"'<>]*\/offer\/(\d+)(?:\.html)?/gi;

function extractNewtonLinks(text: string): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text))) {
    const url = m[2].replace(/\.html$/, '') + '.html';
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: m[1].trim(), url });
  }
  if (out.length === 0) {
    BARE_LINK_RE.lastIndex = 0;
    while ((m = BARE_LINK_RE.exec(text))) {
      const url = `https://detail.1688.com/offer/${m[1]}.html`;
      if (seen.has(url)) continue;
      seen.add(url);
      const idx = text.indexOf(m[0]);
      const ctx = text.slice(Math.max(0, idx - 140), idx);
      const line = ctx.split(/\n/).pop() || '';
      const t = (line.replace(/[>*\-]/g, '').match(/[：:]\s*(.{4,40})$/) || [, ''])[1] || ''.trim();
      out.push({ title: t || '1688 商品', url });
    }
  }
  return out;
}

function parsePriceNear(ctx: string): number {
  // 优先：单价 / 进货价 / 价格 / 报价 后跟的数字
  let m = ctx.match(/(?:单价|进货价|价格|报价)\s*[¥￥]?\s*(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  // 其次：¥ / ￥ 符号后的数字
  m = ctx.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
  if (m) return parseFloat(m[1]);
  // 再次：区间内取最小合理进货价（通常最小）
  const nums = [...ctx.matchAll(/(\d+(?:\.\d+)?)/g)].map((x) => parseFloat(x[1])).filter((n) => n > 0 && n < 100000);
  return nums.length ? Math.min(...nums) : 0;
}

function parseMoqNear(ctx: string): number {
  const m = ctx.match(/(?:起订量|MOQ|最小起订|起订)\s*[:：]?\s*(\d+)|(\d+)\s*件起/i);
  if (m) return parseInt(m[1] || m[2], 10) || 1;
  return 1;
}

export function parseNewtonSourcing(content: string): NewtonSourcingItem[] {
  if (!content) return [];
  const links = extractNewtonLinks(content);
  if (!links.length) return [];
  return links.map(({ title, url }) => {
    const idx = content.indexOf(url.replace(/\.html$/, ''));
    const start = Math.max(0, idx - 200);
    const end = Math.min(content.length, idx + url.length + 200);
    const ctx = content.slice(start, end);
    return {
      title: title || '1688 商品',
      priceCNY: parsePriceNear(ctx),
      moq: parseMoqNear(ctx),
      supplier: '',
      url,
    };
  });
}

// 在 get 轮询结束后由路由调用：返回 {content, items}
export function summarizeNewtonResult(state: NewtonTaskState): { content: string; items: NewtonSourcingItem[] } {
  return { content: state.content, items: parseNewtonSourcing(state.content) };
}

// ============ 自动化 AI 选品寻源：create → poll → (auto-resume WAIT_USER) → parse ============

export interface NewtonAutoSourcingOptions {
  query: string;
  /** 竞品售价（USD），用于自动回答预算类澄清卡 */
  competitorPriceUsd?: number;
  /** ML 站点（MLM/MLB/MLC/MCO），用于构造预算/物流预期 */
  site?: string;
  /** 单条牛顿任务最长等待时间（含轮询），默认 35s */
  timeoutMs?: number;
  /** 轮询间隔，默认 2500ms */
  pollIntervalMs?: number;
  /** 最大返回商品数，默认 5（取解析前 N） */
  maxItems?: number;
  /** 遇到 WAIT_USER 澄清卡是否自动回答（默认 true，自动化流程必须 true） */
  autoAnswerClarification?: boolean;
}

export interface NewtonAutoSourcingResult {
  success: boolean;
  message: string;
  products: Ali1688Product[];
  sourceOrigin: 'newton';
  rawContent?: string;
}

function offerIdFromUrl(url: string): string {
  const m = url.match(/offer\/(\d+)/);
  return m ? m[1] : url;
}

function extractRiskFlags(content: string): string[] {
  const flags: string[] = [];
  const riskPatterns = [
    /(24h|48h|72h)\s*支揽率[：:]?\s*(\d+(?:\.\d+)?%?)/i,
    /(发货时效|物流时效)[：:]?\s*([^\n]+)/i,
    /(评价优|评价一般|评价差)/i,
    /(一件代发|支持代发|不支持代发)/i,
  ];
  for (const p of riskPatterns) {
    const m = content.match(p);
    if (m) flags.push(m[0]);
  }
  return flags;
}

function pickDefaultAnswer(
  q: NewtonClarificationQuestion,
  opts: { competitorPriceUsd?: number; site?: string }
): NewtonResumeAnswer {
  const text = (q.question || '').toLowerCase();
  const options = q.options || [];

  // 1) 找「不限/无特殊要求/跳过/默认」类选项
  const skipWords = ['不限', '无特殊要求', '无要求', '跳过', '默认', 'skip', 'none', 'no preference', '随便', '都可以'];
  const skipIdx = options.findIndex((o) => skipWords.some((w) => o.includes(w)));
  if (skipIdx >= 0) {
    return q.allowMultiple
      ? { kind: 'selectedData', values: [options[skipIdx]] }
      : { kind: 'selectedData', values: options[skipIdx] };
  }

  // 2) 预算/价格类问题：按竞品价估算合理进货预算
  if (/(预算|价格|价位|多少钱|price|budget)/i.test(text) && opts.competitorPriceUsd && opts.competitorPriceUsd > 0) {
    // 粗略：竞品价 USD -> CNY（按 7.2），进货预算取竞品价的 15%~45%（留出物流+利润）
    const cny = opts.competitorPriceUsd * 7.2;
    const min = Math.max(1, Math.floor(cny * 0.15));
    const max = Math.max(min + 1, Math.floor(cny * 0.45));
    const answer = `预算在 ${min} 元到 ${max} 元人民币之间，优先性价比高、评价好的`;
    return { kind: 'userInput', text: answer };
  }

  // 3) 物流/发货时效：偏好快速发货
  if (/(物流|发货|时效|快递|shipping|delivery)/i.test(text)) {
    const fastIdx = options.findIndex((o) => /(24|48|72).*(小时|h)|快速|顺丰|极兔|中通|韵达|圆通/i.test(o));
    if (fastIdx >= 0) {
      return q.allowMultiple
        ? { kind: 'selectedData', values: [options[fastIdx]] }
        : { kind: 'selectedData', values: options[fastIdx] };
    }
  }

  // 4) 材质/颜色/规格类：多选默认选第一个，单选也选第一个（保守）
  if (options.length > 0) {
    if (q.allowMultiple) {
      // 多选默认选前 3 个或不选太多
      return { kind: 'selectedData', values: options.slice(0, Math.min(3, options.length)) };
    }
    return { kind: 'selectedData', values: options[0] };
  }

  // 5) 无选项则跳过
  return { kind: 'skipped' };
}

export async function runNewtonAutoSourcing(opts: NewtonAutoSourcingOptions): Promise<NewtonAutoSourcingResult> {
  if (!isNewtonConfigured()) {
    return { success: false, message: '牛顿未配置，跳过', products: [], sourceOrigin: 'newton' };
  }

  const timeoutMs = opts.timeoutMs ?? 35000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2500;
  const maxItems = opts.maxItems ?? 5;
  const autoAnswer = opts.autoAnswerClarification !== false;

  let taskId = '';
  let sessionId = '';
  try {
    const created = await createNewtonTask(opts.query);
    taskId = created.taskId;
    sessionId = created.sessionId;
  } catch (e: any) {
    return { success: false, message: `牛顿创建任务失败：${e?.message || String(e)}`, products: [], sourceOrigin: 'newton' };
  }

  const startedAt = Date.now();
  let lastState: NewtonTaskState | undefined;
  let autoResumeCount = 0;
  const maxAutoResume = 3;

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const state = await getNewtonTask(taskId, sessionId);
      lastState = state;

      if (state.status === 'END') {
        const items = parseNewtonSourcing(state.content || '').slice(0, maxItems);
        const products: Ali1688Product[] = items.map((it) => ({
          id: offerIdFromUrl(it.url),
          title: it.title,
          price: it.priceCNY || 0,
          url: it.url,
          imageUrl: it.imageUrl,
          stats: {
            categoryListName: it.supplier || '',
          },
        }));
        const risks = extractRiskFlags(state.content || '');
        const msg = products.length
          ? `牛顿找到 ${products.length} 个货源${risks.length ? '（风控：' + risks.join('；') + '）' : ''}`
          : '牛顿未返回可解析货源';
        return { success: products.length > 0, message: msg, products, sourceOrigin: 'newton', rawContent: state.content };
      }

      if (state.status === 'WAIT_USER') {
        if (!autoAnswer || !state.clarification || autoResumeCount >= maxAutoResume) {
          return { success: false, message: '牛顿等待用户澄清但自动回答已关闭或超限', products: [], sourceOrigin: 'newton' };
        }
        try {
          const answers: string[] = [];
          for (const q of state.clarification.questions) {
            const ans = pickDefaultAnswer(q, { competitorPriceUsd: opts.competitorPriceUsd, site: opts.site });
            if (ans.kind === 'userInput') answers.push(ans.text);
            else if (ans.kind === 'selectedData') {
              const v = Array.isArray(ans.values) ? ans.values.join(', ') : String(ans.values);
              answers.push(`${q.question} → ${v}`);
            } else {
              answers.push(`${q.question} → 跳过`);
            }
            await resumeNewtonTask(taskId, sessionId, state.clarification.toolCallId, ans);
          }
          autoResumeCount++;
          console.log(`[NewtonAuto] 自动回答澄清卡：${answers.join(' | ')}`);
        } catch (e: any) {
          return { success: false, message: `牛顿自动回答澄清卡失败：${e?.message || String(e)}`, products: [], sourceOrigin: 'newton' };
        }
      }

      // INIT / RUNNING / UNKNOWN：继续轮询
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return { success: false, message: `牛顿任务超时（>${timeoutMs}ms）`, products: [], sourceOrigin: 'newton' };
  } catch (e: any) {
    return { success: false, message: `牛顿轮询异常：${e?.message || String(e)}`, products: [], sourceOrigin: 'newton' };
  }
}
