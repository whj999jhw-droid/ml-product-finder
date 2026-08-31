/**
 * AI 文本生成服务 — OpenAI 兼容 API
 *
 * 用途：
 *   1. AI 标题生成（西语/葡语，基于 1688 货源信息 + 竞品要素 + ML 热搜词）
 *   2. AI 商品描述生成（西语/葡语，基于 1688 货源信息 + ML 热搜词）
 *
 * 配置：环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（Oracle 部署首选）。
 *       也支持 data/llm-config.json 文件配置（优先级低于环境变量）。
 *
 * 合规红线：绝不原样复制竞品标题/描述；AI 指令明确要求「用自己的表达重组」。
 * 当 AI 不可用时（未配置、网络异常、超时等），调用方应回退到规则引擎/模板。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTrendsKeywords } from './trends.js';
import { ArkRuntimeClient } from '@volcengine/ark-runtime';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const LLM_CONFIG_FILE = path.join(DATA_DIR, 'llm-config.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export type LlmProviderType = 'openai' | 'volcano-rest' | 'volcano-sdk';

export interface LlmProvider {
  /** 平台名称（仅用于展示，如「硅基流动」「DeepSeek」） */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 调用方式，默认 openai */
  type?: LlmProviderType;
}

/** 旧版单配置兼容结构 */
interface LegacyLlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

interface LlmConfigFile {
  providers?: LlmProvider[];
}

function normalizeBaseUrl(url: string): string {
  return (url || '').trim().replace(/\/+$/, '');
}

function isValidProvider(p: Partial<LlmProvider>): p is LlmProvider {
  return !!(p.baseUrl?.trim() && p.apiKey?.trim() && p.model?.trim());
}

function envProvider(): LlmProvider | null {
  const baseUrl = normalizeBaseUrl(process.env.LLM_BASE_URL || '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || '';
  if (!baseUrl || !apiKey || !model) return null;
  return { name: '环境变量 LLM_*', baseUrl, apiKey, model };
}

/** 读取磁盘配置原始内容（不过滤空 KEY；用于前端回填展示）。 */
function loadLlmConfigFileRaw(): LlmConfigFile | null {
  ensureDataDir();
  if (!fs.existsSync(LLM_CONFIG_FILE)) return null;
  try {
    const raw = fs.readFileSync(LLM_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as LegacyLlmConfig & LlmConfigFile;
    // 新版：providers 数组
    if (Array.isArray(parsed.providers) && parsed.providers.length > 0) {
      return {
        providers: parsed.providers.map((p) => ({ ...p, baseUrl: normalizeBaseUrl(p.baseUrl) })),
      };
    }
    // 旧版：单条配置迁移为 providers[0]
    const legacy: LlmProvider = {
      name: '已保存配置',
      baseUrl: normalizeBaseUrl(parsed.baseUrl || parsed.LLM_BASE_URL || ''),
      apiKey: parsed.apiKey || parsed.LLM_API_KEY || '',
      model: parsed.model || parsed.LLM_MODEL || '',
    };
    return { providers: [legacy] };
  } catch {
    return null;
  }
}

/** 读取可用于实际调用的平台（要求 baseUrl+apiKey+model 齐备）。 */
function loadLlmConfigFile(): LlmConfigFile | null {
  const raw = loadLlmConfigFileRaw();
  if (!raw?.providers) return null;
  const providers = raw.providers.filter(isValidProvider);
  return providers.length ? { providers } : null;
}

/**
 * 返回用于前端回填展示的已保存配置：即使 apiKey 为空也返回该平台，
 * 这样用户在「只改 KEY / 只增模型」时不至于把 endpoint/model 也清掉。
 * 出于安全与「留空即复用」语义，apiKey 永不随响应返回明文。
 */
export function getLlmConfigForDisplay(): { providers: { name: string; baseUrl: string; model: string; type?: LlmProviderType }[] } {
  const raw = loadLlmConfigFileRaw();
  if (!raw?.providers) return { providers: [] };
  return {
    providers: raw.providers.map((p) => ({
      name: p.name || '',
      baseUrl: normalizeBaseUrl(p.baseUrl) || p.baseUrl || '',
      model: p.model || '',
      type: p.type || 'openai',
    })),
  };
}

function writeLlmConfigFile(file: LlmConfigFile): void {
  ensureDataDir();
  fs.writeFileSync(LLM_CONFIG_FILE, JSON.stringify(file, null, 2), 'utf-8');
}

/** 返回所有可用平台（按优先级排序：环境变量 > 文件配置）。调用 llmGenerate 会自动依次尝试。 */
export function getLlmProviders(): LlmProvider[] {
  const providers: LlmProvider[] = [];
  const env = envProvider();
  if (env) providers.push(env);
  const file = loadLlmConfigFile();
  if (file?.providers) {
    for (const p of file.providers) {
      // 去重：与环境变量完全相同的配置不再重复加入
      if (env && p.baseUrl === env.baseUrl && p.model === env.model) continue;
      providers.push(p);
    }
  }
  return providers;
}

/** 兼容旧接口：返回第一个可用平台 */
export function getLlmConfig(): LlmProvider | null {
  const providers = getLlmProviders();
  return providers[0] || null;
}

/** 从文件配置里查找已保存的 Api Key（用于测试/保存时「留空=不修改」）。优先按 baseUrl+model，再按 baseUrl。 */
export function findSavedApiKey(baseUrl: string, model?: string): string | undefined {
  const file = loadLlmConfigFile();
  if (!file?.providers) return undefined;
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedModel = (model || '').trim();
  let byBoth: LlmProvider | undefined;
  let byBase: LlmProvider | undefined;
  for (const p of file.providers) {
    const pBase = normalizeBaseUrl(p.baseUrl);
    const pModel = (p.model || '').trim();
    if (pBase !== normalizedBase) continue;
    if (!byBase && p.apiKey) byBase = p;
    if (pModel === normalizedModel && p.apiKey) {
      byBoth = p;
      break;
    }
  }
  return byBoth?.apiKey || byBase?.apiKey;
}

export interface SaveLlmConfigResult {
  success: boolean;
  message?: string;
}

/** 保存多平台配置。支持传入单条对象（兼容旧代码）或完整 {providers}。 */
export function saveLlmConfig(cfg: Partial<LlmProvider> | { providers?: Partial<LlmProvider>[] }): SaveLlmConfigResult {
  ensureDataDir();

  // 统一整理为 providers 数组
  let providers: Partial<LlmProvider>[] = [];
  if (cfg && 'providers' in cfg && Array.isArray(cfg.providers)) {
    providers = cfg.providers;
  } else if (cfg && ('baseUrl' in cfg || 'apiKey' in cfg || 'model' in cfg)) {
    providers = [cfg as Partial<LlmProvider>];
  }

  const existing = loadLlmConfigFile();
  const existingByBase = new Map<string, LlmProvider>();
  const existingByBoth = new Map<string, LlmProvider>();
  for (const p of existing?.providers || []) {
    const b = normalizeBaseUrl(p.baseUrl);
    existingByBase.set(b, p);
    existingByBoth.set(`${b}|${(p.model || '').trim()}`, p);
  }

  // 展开「同一 baseUrl+key 对应多个 model」：每个 model 生成一条独立 provider，
  // 这样运行期 failover 会自动跨平台、跨模型尝试；存储格式与运行期保持不变。
  const expanded: LlmProvider[] = [];
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const baseUrl = normalizeBaseUrl(p.baseUrl || '');
    const apiKey = (p.apiKey || '').trim();
    const rawModels = (p as any).models ?? p.model;
    const modelList = (Array.isArray(rawModels)
      ? rawModels
      : String(rawModels || '').split(/[,，]/)
    )
      .map((m: any) => String(m).trim())
      .filter(Boolean);
    if (!baseUrl || modelList.length === 0) {
      return {
        success: false,
        message: `第 ${i + 1} 个平台必须填写 baseUrl 与至少一个 model（多个 model 用逗号隔开）`,
      };
    }
    const providerType = ((p as any).type || 'openai') as LlmProviderType;
    modelList.forEach((m: string, idx: number) => {
      expanded.push({
        name: modelList.length > 1 ? `${p.name || '平台'} · ${m}` : (p.name || `平台 ${i + 1}`).trim(),
        baseUrl,
        apiKey,
        model: m,
        type: providerType,
      });
    });
  }

  const finalProviders: LlmProvider[] = [];
  for (let i = 0; i < expanded.length; i++) {
    const p = expanded[i];
    const baseUrl = normalizeBaseUrl(p.baseUrl || '');
    const model = (p.model || '').trim();
    let apiKey = (p.apiKey || '').trim();
    // apiKey 为空：优先按 baseUrl+model，再按 baseUrl 复用已有 key（改模型名也不会丢 key）
    if (!apiKey) {
      const oldBoth = existingByBoth.get(`${baseUrl}|${model}`);
      const oldBase = existingByBase.get(baseUrl);
      apiKey = oldBoth?.apiKey || oldBase?.apiKey || '';
    }
    if (baseUrl.includes('...')) {
      return {
        success: false,
        message: `第 ${i + 1} 个平台的 baseUrl 不能包含省略号 "..."，请填写完整地址`,
      };
    }
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { success: false, message: `第 ${i + 1} 个平台的 baseUrl 必须是 http:// 或 https:// 开头` };
      }
    } catch {
      return { success: false, message: `第 ${i + 1} 个平台的 baseUrl 不是合法 URL` };
    }
    // apiKey 最终仍为空且不是已有配置：首次保存必须提供
    if (!apiKey) {
      const old = existingByBoth.get(`${baseUrl}|${model}`);
      if (!old) {
        return { success: false, message: `第 ${i + 1} 个平台首次保存必须提供 apiKey` };
      }
      apiKey = old.apiKey;
    }
    finalProviders.push({
      name: p.name || `平台 ${i + 1}`,
      baseUrl,
      apiKey,
      model,
      type: p.type || 'openai',
    });
  }

  if (finalProviders.length === 0) {
    return { success: false, message: '至少保存一个有效平台' };
  }

  writeLlmConfigFile({ providers: finalProviders });
  return { success: true };
}

export interface DeleteLlmProviderResult {
  success: boolean;
  removed?: number;
  message?: string;
}

/**
 * 直接删除已保存的 LLM 配置中的提供商。
 * 匹配规则（未提供的字段不参与匹配）：
 *   - baseUrl：归一化后精确匹配（删除整个平台时只传 baseUrl 即可）
 *   - model：精确匹配（删除单个不通的模型时传 baseUrl+model）
 *   - type：调用方式匹配
 * 命中即从 data/llm-config.json 中移除并落盘，后续 llmGenerate 不再尝试该配置。
 */
export function deleteLlmProvider(filter: { baseUrl?: string; model?: string; type?: LlmProviderType }): DeleteLlmProviderResult {
  const raw = loadLlmConfigFileRaw();
  if (!raw?.providers || raw.providers.length === 0) {
    return { success: false, message: '没有已保存的 LLM 配置' };
  }
  const normBase = (filter.baseUrl || '').trim();
  const normModel = (filter.model || '').trim().toLowerCase();
  const type = filter.type;
  const before = raw.providers.length;
  const after = raw.providers.filter((p) => {
    const baseMatch = !normBase || normalizeBaseUrl(p.baseUrl) === normalizeBaseUrl(normBase);
    const modelMatch = !normModel || (p.model || '').trim().toLowerCase() === normModel;
    const typeMatch = !type || (p.type || 'openai') === type;
    const hit = baseMatch && modelMatch && typeMatch;
    return !hit; // 命中则剔除
  });
  const removed = before - after.length;
  if (removed === 0) {
    return { success: false, removed: 0, message: '没有匹配的提供商可删除（请检查 baseUrl / model 是否一致）' };
  }
  writeLlmConfigFile({ providers: after });
  return { success: true, removed };
}

// ============ 通用 LLM 调用 ============

interface LLMOptions {
  prompt: string;
  systemPrompt: string;
  timeoutMs?: number;
  /** 要求模型返回 JSON（OpenAI 兼容的 response_format）。 */
  jsonMode?: boolean;
  /** 采样温度，默认 0.7。翻译等需要稳定的任务可降到 0.2 以减少退化/重复输出。 */
  temperature?: number;
}

/**
 * 根据 baseUrl 生成 OpenAI /chat/completions 完整 URL。
 * 兼容用户填写时带或不带 `/v1`、`/v2`、`/v3`、`/v4` 等版本路径结尾。
 * 例如：
 *   - https://api.openai.com/v1           → https://api.openai.com/v1/chat/completions
 *   - https://ark.cn-beijing.volces.com/api/v3 → https://ark.cn-beijing.volces.com/api/v3/chat/completions
 */
function chatCompletionsUrl(baseUrl: string): string {
  const normalized = (baseUrl || '').trim().replace(/\/+$/, '');
  // 已经是完整 chat completions 端点
  if (normalized.toLowerCase().endsWith('/chat/completions')) {
    return normalized;
  }
  // 已包含 /v1 /v2 /v3 /v4 等版本路径：直接追加 chat/completions
  if (/\/v\d+$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  // 默认按 OpenAI 规范补 /v1
  return `${normalized}/v1/chat/completions`;
}

interface OpenAICompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
  }>;
  error?: { message?: string };
}

function isImageModel(model: string): boolean {
  const m = (model || '').toLowerCase();
  return m.includes('seedream') || m.includes('seedance') || m.includes('dall-e') || m.includes('image');
}

function isImageEndpoint(baseUrl: string): boolean {
  return (baseUrl || '').toLowerCase().includes('/images/generations');
}

function isImageProvider(provider: LlmProvider): boolean {
  return isImageEndpoint(provider.baseUrl) || isImageModel(provider.model);
}

/** 模型/端点能力类型：用于自动分流，避免把 OCR/视频/图像等专用端点当 chat 测。 */
export type LlmCapability = 'chat' | 'image' | 'video' | 'ocr' | 'embedding' | 'audio' | 'unknown';

/**
 * 根据 baseUrl 路径 + model 名自动识别 provider 能力类型。
 * 用户常在「平台名称」里写「智谱OCR」「七牛云·视频」等，这里以 URL path 为主、model 名为辅。
 */
export function detectProviderType(baseUrl: string, model?: string): LlmCapability {
  const u = (baseUrl || '').toLowerCase();
  const m = (model || '').toLowerCase();

  // URL path 优先级最高（用户明确把专用 endpoint 填进来）
  if (u.includes('/images/generations')) return 'image';
  if (u.includes('/videos/generations') || u.includes('/video/generations')) return 'video';
  if (u.includes('/layout_parsing') || u.includes('/ocr')) return 'ocr';
  if (u.includes('/embeddings')) return 'embedding';
  if (u.includes('/audio/speech') || u.includes('/audio/transcriptions')) return 'audio';

  // 模型名兜底：用户可能把视频/OCR/图像模型填在通用 chat baseUrl 下
  // kling-image 等带 image 关键字的视频厂商模型，优先识别为图像
  if (m.includes('kling-image') || m.includes('seedream') || m.includes('dall-e') || m.includes('sdxl') || m.includes('flux') || m.includes('kandinsky') || m.includes('glm-image') || m.includes('agnes-image')) return 'image';
  if (m.includes('seedance') || m.includes('cogvideox') || m.includes('kling') || m.includes('luma') || m.includes('hailuo') || m.includes('agnes-video')) return 'video';
  if (m.includes('glm-ocr') || m.includes('qwen-vl-ocr')) return 'ocr';
  if (m.includes('embedding')) return 'embedding';

  // 默认当对话模型处理
  return 'chat';
}

/** 火山方舟 REST 的 chat 端点：baseUrl 通常已带 /api/v3，补 /chat/completions 即可。 */
function volcanoRestChatUrl(baseUrl: string): string {
  const normalized = (baseUrl || '').trim().replace(/\/+$/, '');
  if (normalized.toLowerCase().endsWith('/chat/completions')) return normalized;
  return `${normalized}/chat/completions`;
}

interface ImageGenerationResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string };
}

async function llmGenerateWithProvider(opts: LLMOptions, provider: LlmProvider): Promise<string> {
  const type = provider.type || 'openai';
  const image = isImageProvider(provider);
  if (type === 'volcano-sdk') return volcanoSdkGenerate(opts, provider);
  if (type === 'volcano-rest') return volcanoRestGenerate(opts, provider);
  // type === 'openai'：文本走 OpenAI 兼容 /chat/completions；
  // 但若该平台实为图片生成（/images/generations 端点或 seedream 等模型），
  // 必须用 REST 图片生成接口，否则会拼出错误 URL 导致“连接不上”。
  if (image) return volcanoRestGenerate(opts, provider);
  return openaiCompatibleGenerate(opts, provider);
}

async function openaiCompatibleGenerate(opts: LLMOptions, provider: LlmProvider): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const temperature = opts.temperature ?? 0.7;
  const url = chatCompletionsUrl(provider.baseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardGuard = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => reject(new Error('AI generation hard timeout')), timeoutMs + 10000);
  });

  try {
    const collect = (async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: opts.systemPrompt },
            { role: 'user', content: opts.prompt },
          ],
          temperature,
          max_tokens: 1024,
          stream: false,
          ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = (await res.json()) as OpenAICompletionResponse;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('LLM API returned empty content');
      }
      return content.trim();
    })();

    return await Promise.race([collect, hardGuard]);
  } finally {
    clearTimeout(timer);
    if (hardTimer) clearTimeout(hardTimer);
  }
}

async function volcanoRestGenerate(opts: LLMOptions, provider: LlmProvider): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const isImage = isImageProvider(provider);
  const url = isImage
    ? isImageEndpoint(provider.baseUrl)
      ? normalizeBaseUrl(provider.baseUrl) // 火山等：端点本身就是 /images/generations
      : `${normalizeBaseUrl(provider.baseUrl)}/images/generations` // 通用 OpenAI：补 /images/generations
    : volcanoRestChatUrl(provider.baseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardGuard = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => reject(new Error('AI generation hard timeout')), timeoutMs + 10000);
  });

  try {
    const collect = (async () => {
      const body = isImage
        ? {
            model: provider.model,
            prompt: opts.prompt,
            size: '2K',
            response_format: 'url',
            watermark: false,
            stream: false,
          }
        : {
            model: provider.model,
            messages: [
              { role: 'system', content: opts.systemPrompt },
              { role: 'user', content: opts.prompt },
            ],
            temperature: opts.temperature ?? 0.7,
            max_tokens: 1024,
            stream: false,
            ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
      }

      if (isImage) {
        const data = (await res.json()) as ImageGenerationResponse;
        const imageUrl = data?.data?.[0]?.url || data?.data?.[0]?.b64_json;
        if (!imageUrl) {
          throw new Error('图片生成 API 未返回 url');
        }
        return imageUrl;
      }

      const data = (await res.json()) as OpenAICompletionResponse;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('LLM API returned empty content');
      }
      return content.trim();
    })();

    return await Promise.race([collect, hardGuard]);
  } finally {
    clearTimeout(timer);
    if (hardTimer) clearTimeout(hardTimer);
  }
}

async function volcanoSdkGenerate(opts: LLMOptions, provider: LlmProvider): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const isImage = isImageProvider(provider);
  let baseURL = provider.baseUrl || undefined;
  if (baseURL && isImageEndpoint(baseURL)) {
    // 图片生成 SDK 共用 /api/v3，不需要 /images/generations 后缀
    baseURL = baseURL.toLowerCase().split('/images/generations')[0] || undefined;
  }
  const client = new ArkRuntimeClient({
    apiKey: provider.apiKey,
    baseURL,
  });

  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardGuard = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => reject(new Error('AI generation hard timeout')), timeoutMs + 10000);
  });

  try {
    const collect = (async () => {
      if (isImage) {
        const resp = await client.generateImages({
          model: provider.model,
          prompt: opts.prompt,
          n: 1,
          size: '2K',
          response_format: 'url',
          watermark: false,
        } as any);
        const imageUrl = (resp as any)?.data?.[0]?.url;
        if (!imageUrl) throw new Error('SDK 图片生成未返回 url');
        return imageUrl;
      }
      const resp = await client.createChatCompletion({
        model: provider.model,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.prompt },
        ],
        temperature: opts.temperature ?? 0.7,
        max_tokens: 1024,
      } as any);
      const content = (resp as any)?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('SDK 返回空内容');
      return content.trim();
    })();

    return await Promise.race([collect, hardGuard]);
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }
}

/**
 * 调用 OpenAI 兼容 /v1/chat/completions 生成文本。
 * 多平台自动降级：依次尝试所有已配置平台，一个失败自动换下一个。
 * 如传入 provider，则只使用该平台（用于单平台测试）。
 */
async function llmGenerate(opts: LLMOptions, provider?: LlmProvider): Promise<string> {
  if (provider) {
    const content = await llmGenerateWithProvider(opts, provider);
    if (content) return content;
    throw new Error(`${provider.name || provider.model}: 返回空内容`);
  }

  const providers = getLlmProviders();
  if (!providers.length) throw new Error('LLM 未配置');

  const errors: string[] = [];
  for (const provider of providers) {
    // 文本生成 failover 只应使用 chat 类平台；OCR/视频/图像/嵌入等专用端点不参与文本生成
    const cap = detectProviderType(provider.baseUrl, provider.model);
    if (cap !== 'chat') {
      continue;
    }
    try {
      const content = await llmGenerateWithProvider(opts, provider);
      if (content) return content;
      errors.push(`${provider.name || provider.model}: 返回空内容`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      errors.push(`${provider.name || provider.model}: ${msg}`);
      // 继续尝试下一个平台
    }
  }

  throw new Error(`所有 LLM 平台均失败：${errors.join('； ')}`);
}

// ============ JSON 解析工具 ============

/**
 * 从模型返回文本中尽量提取 JSON 对象。
 * 兼容：纯 JSON、markdown 代码块、前后带说明文字、常见 trailing comma。
 */
function extractJsonObject(raw: string): unknown {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const candidates: string[] = [];

  // 1) 去掉首尾 markdown 代码块标记
  const noFence = trimmed.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
  candidates.push(noFence);

  // 2) 提取第一个 { 到最后一个 } 之间的内容（忽略前后说明文字）
  const firstBrace = noFence.indexOf('{');
  const lastBrace = noFence.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(noFence.slice(firstBrace, lastBrace + 1));
  }

  // 3) 修复 trailing comma 后再试
  const fixed = noFence.replace(/,\s*([}\]])/g, '$1');
  if (fixed !== noFence) candidates.push(fixed);

  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 继续试下一个候选
    }
  }
  return undefined;
}

// ============ 热搜词翻译 ============

/**
 * 批量翻译 Mercado Libre 热搜词为中文购物术语。
 * 返回 { 原词: 中文翻译 } 的 map；未翻译到的词不会出现在结果里。
 */
/**
 * 批量翻译 Mercado Libre 热搜词为中文购物术语。
 * 返回 { 原词: 中文翻译 } 的 map；未翻译到的词不会出现在结果里。
 *
 * 健壮性策略（针对 SiliconFlow 7B 模型在 JSON 批量任务上偶发卡顿/退化）：
 *   1) 分批发送，避免整批超时 / 输出截断；
 *   2) 翻译使用低温度（0.2）减少重复退化输出；
 *   3) 多批并发执行，缩短整体耗时；
 *   4) 个别词（如 "tenis hombre"）会让模型退化/卡死，连带整批 JSON 损坏——
 *      因此失败的批次会进入「逐词兜底」第二阶段，好词 0.6s 译出，坏词最多卡
 *      timeoutMs 超时后只丢它自己，不连累同批其他词；
 *   5) 丢弃空值或退化超长输出（模型偶发 "isisis..." 式重复）。
 */
export async function translateTrendsKeywords(
  keywords: string[],
  site: string,
  batchSize = 8,
  timeoutMs = 25000,
  concurrency = 6,
): Promise<Record<string, string>> {
  const cfg = getLlmConfig();
  if (!cfg) {
    console.log('[translateTrendsKeywords] LLM 未配置，跳过翻译');
    return {};
  }
  if (!keywords.length) return {};

  const lang = langOfSite(site);
  const langNameText = langName(lang);

  const buildPrompt = (chunk: string[]) =>
    `将以下 ${langNameText} 电商搜索词翻译成最自然、最简短的中文购物术语（不超过 6 个字）。
如果词本身是品牌名、型号或专有名词，可保留原样或音译。
只返回 JSON，不要解释、不要 markdown 代码块、不要任何额外文字。
格式示例：{"iphone 11 pro max":"iPhone 11 Pro Max","mochila":"背包"}

待翻译词：${JSON.stringify(chunk)}`;

  // 单次请求并抽取有效译词
  const oneShot = async (chunk: string[]): Promise<Record<string, string>> => {
    const raw = await llmGenerate({
      prompt: buildPrompt(chunk),
      systemPrompt: '你是一个跨境电商助手，擅长把电商搜索关键词翻译成中文选品术语。只输出 JSON，不要解释。',
      timeoutMs,
      jsonMode: true,
      temperature: 0.2,
    });
    const map = extractJsonObject(raw) as Record<string, string> | undefined;
    const tmp: Record<string, string> = {};
    if (map) {
      for (const k of chunk) {
        const v = map[k];
        if (typeof v === 'string' && v.trim() && v.trim().length <= 8) tmp[k] = v.trim();
      }
    }
    return tmp;
  };

  // 有限并发执行任务队列（worker 取任务直到耗尽）
  const runConcurrent = async (tasks: (() => Promise<void>)[], limit: number) => {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        await task();
      }
    });
    await Promise.all(workers);
  };

  const result: Record<string, string> = {};

  // 阶段一：分批翻译
  const batches: string[][] = [];
  for (let i = 0; i < keywords.length; i += batchSize) {
    batches.push(keywords.slice(i, i + batchSize));
  }
  const fallback: string[] = [];
  await runConcurrent(
    batches.map((batch) => async () => {
      let got: Record<string, string> = {};
      for (let attempt = 0; attempt < 2 && Object.keys(got).length === 0; attempt++) {
        try {
          got = await oneShot(batch);
        } catch (err: any) {
          console.error('[translateTrendsKeywords] 批次第', attempt + 1, '次失败：', err?.message || err);
        }
      }
      Object.assign(result, got);
      // 本批未译出的词进入逐词兜底
      for (const k of batch) if (!got[k]) fallback.push(k);
    }),
    concurrency,
  );

  // 阶段二：逐词兜底（好词会快速译出，坏词超时后只丢自己）
  await runConcurrent(
    fallback.map((k) => async () => {
      try {
        const r = await oneShot([k]);
        if (r[k]) result[k] = r[k];
      } catch (err: any) {
        console.error('[translateTrendsKeywords] 单条兜底失败，跳过：', k, err?.message || err);
      }
    }),
    concurrency,
  );

  return result;
}

// 1x1 透明 PNG，用于 OCR/layout_parsing 等需要图片输入的接口探测（只看接口是否 200）
const TEST_IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function probeImageProvider(provider: LlmProvider): Promise<{ success: boolean; sample?: Record<string, string>; raw?: string; error?: string }> {
  const isZhipu = provider.baseUrl.toLowerCase().includes('bigmodel.cn') || provider.model.toLowerCase().includes('glm-image');
  if (isZhipu) {
    // 智谱图像生成只接受固定尺寸，不走通用 '2K' 路径
    const url = normalizeBaseUrl(provider.baseUrl);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          prompt: '一只可爱的卡通小猫，白底，高清',
          size: '1024x1024',
          n: 1,
        }),
        signal: AbortSignal.timeout(120000),
      });
      const text = await res.text();
      if (!res.ok) {
        return { success: false, error: `图片生成探测失败 HTTP ${res.status}: ${text.slice(0, 200)}`, raw: text };
      }
      const data = JSON.parse(text) as ImageGenerationResponse & { task_id?: string; id?: string };
      const imageUrl = data?.data?.[0]?.url || data?.data?.[0]?.b64_json;
      const asyncId = data?.task_id || data?.id;
      if (!imageUrl && !asyncId) {
        return { success: false, error: '图片生成接口未返回 url/task_id', raw: text };
      }
      return { success: true, sample: imageUrl ? { imageUrl } : { taskId: asyncId, note: '异步图像任务已创建' }, raw: text };
    } catch (err: any) {
      let error = err?.message || String(err);
      const code = err?.cause?.code || err?.code;
      if (code) error += ` (网络/错误码: ${code})`;
      return { success: false, error };
    }
  }

  try {
    const raw = await llmGenerate(
      {
        prompt: '一只可爱的卡通小猫，白底，高清',
        systemPrompt: '',
        timeoutMs: 120000,
      },
      provider,
    );
    if (!raw || !raw.startsWith('http')) {
      return { success: false, error: `图片生成返回异常：${raw?.slice(0, 200)}` };
    }
    return { success: true, sample: { imageUrl: raw }, raw };
  } catch (err: any) {
    let error = err?.message || String(err);
    const code = err?.cause?.code || err?.code;
    if (code) error += ` (网络/错误码: ${code})`;
    return { success: false, error };
  }
}

async function probeVideoProvider(provider: LlmProvider): Promise<{ success: boolean; sample?: Record<string, string>; raw?: string; error?: string }> {
  const url = normalizeBaseUrl(provider.baseUrl);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        prompt: 'A cat walking on a white background, high quality',
        size: '480x480',
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok && res.status !== 202) {
      return { success: false, error: `视频生成探测失败 HTTP ${res.status}: ${text.slice(0, 200)}`, raw: text };
    }
    return { success: true, sample: { httpStatus: String(res.status), note: '视频生成通常是异步任务，接口已接受请求即视为可用' }, raw: text };
  } catch (err: any) {
    let error = err?.message || String(err);
    const code = err?.cause?.code || err?.code;
    if (code) error += ` (网络/错误码: ${code})`;
    return { success: false, error };
  }
}

async function probeOcrProvider(provider: LlmProvider): Promise<{ success: boolean; sample?: Record<string, string>; raw?: string; error?: string }> {
  const url = normalizeBaseUrl(provider.baseUrl);
  const isZhipu = provider.baseUrl.toLowerCase().includes('bigmodel.cn') || provider.model.toLowerCase().includes('glm-ocr');
  const payloadField = isZhipu ? 'image_url' : 'image';
  const tryField = async (field: 'image' | 'image_url', value: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        [field]: value,
      }),
      signal: AbortSignal.timeout(30000),
    });
    return res;
  };
  try {
    // 先尝试 base64 data URI
    let res = await tryField(payloadField, `data:image/png;base64,${TEST_IMAGE_B64}`);
    let text = await res.text();
    // 智谱 OCR 对 data URI 可能报格式错误，换真实公网图片 URL 再试
    if (!res.ok && isZhipu) {
      res = await tryField('image_url', 'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png');
      text = await res.text();
    }
    // 兜底：换另一个字段再试一次
    if (!res.ok) {
      const otherField = payloadField === 'image_url' ? 'image' : 'image_url';
      res = await tryField(otherField, `data:image/png;base64,${TEST_IMAGE_B64}`);
      text = await res.text();
    }
    if (!res.ok) {
      // 智谱 OCR 等返回 1214 是因为探测用的 data URL/公网 URL 不被接受为「真实图片文件」，
      // 但只要接口有响应，说明 endpoint/key 是通的，属于「探测受限」而非配置错误。
      const isFormatRestriction = text.includes('1214') || text.includes('OCR仅支持') || text.toLowerCase().includes('format');
      if (isFormatRestriction) {
        return { success: true, sample: { httpStatus: String(res.status), note: 'OCR 接口可达（探测图片格式受限，实际请上传真实图片/PDF）' }, raw: text };
      }
      return { success: false, error: `OCR 探测失败 HTTP ${res.status}: ${text.slice(0, 200)}`, raw: text };
    }
    return { success: true, sample: { httpStatus: String(res.status), note: 'OCR/layout_parsing 接口已响应' }, raw: text };
  } catch (err: any) {
    let error = err?.message || String(err);
    const code = err?.cause?.code || err?.code;
    if (code) error += ` (网络/错误码: ${code})`;
    return { success: false, error };
  }
}

async function probeEmbeddingProvider(provider: LlmProvider): Promise<{ success: boolean; sample?: Record<string, string>; raw?: string; error?: string }> {
  const url = normalizeBaseUrl(provider.baseUrl);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        input: 'test',
        encoding_format: 'float',
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { success: false, error: `Embedding 探测失败 HTTP ${res.status}: ${text.slice(0, 200)}`, raw: text };
    }
    return { success: true, sample: { httpStatus: String(res.status), note: 'Embedding 接口已响应' }, raw: text };
  } catch (err: any) {
    let error = err?.message || String(err);
    const code = err?.cause?.code || err?.code;
    if (code) error += ` (网络/错误码: ${code})`;
    return { success: false, error };
  }
}

/**
 * 诊断版翻译测试：返回原始响应，便于排查模型不返回 JSON 等问题。
 * 可传入指定 provider 进行单平台测试；不传则使用当前全部配置（failover 模式）。
 * 已按 provider 能力自动分流：chat 走 /chat/completions，image/video/ocr/embedding 用对应端点探测。
 */
export async function testLlmTranslation(
  site: string = 'MLM',
  provider?: LlmProvider,
): Promise<{
  success: boolean;
  sample?: Record<string, string>;
  raw?: string;
  error?: string;
}> {
  const resolved = provider || getLlmConfig();
  if (!resolved) return { success: false, error: 'LLM 未配置' };

  const capability = detectProviderType(resolved.baseUrl, resolved.model);

  switch (capability) {
    case 'image':
      return probeImageProvider(resolved);
    case 'video':
      return probeVideoProvider(resolved);
    case 'ocr':
      return probeOcrProvider(resolved);
    case 'embedding':
      return probeEmbeddingProvider(resolved);
    case 'audio':
      return { success: false, error: '音频类模型暂不支持在 ml-product-finder 中使用，如需使用请单独配置 chat 或 image 平台' };
    default:
      break;
  }

  const keywords = ['mochila'];
  const lang = langOfSite(site);
  const langNameText = langName(lang);
  const prompt = `将以下 ${langNameText} 电商搜索词翻译成最自然、最简短的中文购物术语（不超过 6 个字）。
如果词本身是品牌名、型号或专有名词，可保留原样或音译。
只返回 JSON，不要解释、不要 markdown 代码块、不要任何额外文字。
格式示例：{"iphone 11 pro max":"iPhone 11 Pro Max","mochila":"背包"}

待翻译词：${JSON.stringify(keywords)}`;

  try {
    const raw = await llmGenerate(
      {
        prompt,
        systemPrompt: '你是一个跨境电商助手，擅长把电商搜索关键词翻译成中文选品术语。只输出 JSON，不要解释。',
        timeoutMs: 30000,
        jsonMode: true,
      },
      resolved,
    );
    const map = extractJsonObject(raw) as Record<string, string> | undefined;
    if (!map) {
      return {
        success: false,
        raw,
        error: `模型有响应，但无法解析为 JSON。请检查 model 名称是否正确，或换用更新/更强的模型。原始响应：${raw.slice(0, 500)}`,
      };
    }
    const result: Record<string, string> = {};
    for (const k of keywords) {
      if (typeof map[k] === 'string' && map[k].trim()) {
        result[k] = map[k].trim();
      }
    }
    if (Object.keys(result).length === 0) {
      return {
        success: false,
        raw,
        map,
        error: 'JSON 已解析，但未找到预期关键词的翻译。可能是 model 返回了错误的键名或空值。',
      };
    }
    return { success: true, sample: result, raw };
  } catch (err: any) {
    let error = err?.message || String(err);
    const code = err?.cause?.code || err?.code;
    if (code) error += ` (网络/错误码: ${code})`;
    return { success: false, error, raw: err?.raw };
  }
}

/**
 * 简单探测后端能否访问到 LLM 服务地址（只看网络通不通，不看鉴权）。
 * 用于给前端更准确的诊断：是网络/代理/DNS 问题，还是 Key/Model 问题。
 */
export async function probeLlmReachability(baseUrl: string, timeoutMs = 8000, model?: string): Promise<{
  ok: boolean;
  url: string;
  capability?: LlmCapability;
  status?: number;
  error?: string;
}> {
  const capability = detectProviderType(baseUrl, model);
  // 专用端点（图片/视频/OCR/嵌入等）直接以其真实 URL 探测，不要拼 /chat/completions
  const url = capability === 'chat' ? chatCompletionsUrl(baseUrl) : normalizeBaseUrl(baseUrl);
  try {
    // 用 OPTIONS 探测端点：网络层可达即可，不需要鉴权。
    // 大多数厂商会返回 401/404，但 DNS/TCP 通了；若返回 2xx 也视为可达。
    const res = await fetch(url, {
      method: 'OPTIONS',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, url, capability, status: res.status };
  } catch (err: any) {
    const code = err?.cause?.code || err?.code;
    let msg = err?.message || String(err);
    if (code) msg += ` (code: ${code})`;
    return { ok: false, url, capability, error: msg };
  }
}

// ============ 语言/站点工具 ============

export type Lang = 'es' | 'pt';

function langOfSite(site: string): Lang {
  return (site || '').toUpperCase() === 'MLB' ? 'pt' : 'es';
}

function langName(lang: Lang): string {
  return lang === 'pt' ? 'Portuguese (Brazilian)' : 'Spanish (Latin American)';
}

// ============ AI 标题生成 ============

export interface AITitleInput {
  /** 竞品标题（参考要素用，不复制） */
  competitorTitle: string;
  /** 站点 MLM/MLB/MLC/MCO */
  site: string;
  /** 1688 货源标题（中文，提供产品信息） */
  sourceTitle?: string;
  /** 1688 货源价格（CNY） */
  sourcePriceCNY?: number;
  /** 自有品牌 */
  brand?: string;
  /** 生成几个候选 */
  count?: number;
  /** 强制使用的热搜词（可选；默认自动按 site 拉取 ML Trends） */
  trendKeywords?: string[];
}

export interface AITitleResult {
  titles: string[];
  /** 与 titles 一一对应的中文翻译（可能为空） */
  translations?: string[];
  used: 'ai' | 'fallback';
  error?: string;
}

/**
 * AI 生成标题：基于 1688 货源信息 + 竞品要素 + ML 站点热搜词，用目标语言生成多个候选标题。
 * 同时为每个标题提供中文翻译，方便国内运营人员理解。
 * 合规：指令明确禁止复制竞品标题，要求用自有表达重组。
 */
export async function aiGenerateTitles(input: AITitleInput): Promise<AITitleResult> {
  const lang = langOfSite(input.site);
  const count = input.count ?? 3;
  const brandPart = input.brand && input.brand.toLowerCase() !== 'generic' ? input.brand : '';

  // 自动获取站点热搜词；失败则继续，不阻断生成
  let trendWords: string[] = [];
  try {
    trendWords = (input.trendKeywords?.length ? input.trendKeywords : await getTrendsKeywords(input.site, 10));
  } catch {
    trendWords = [];
  }
  const trendText = trendWords.length ? trendWords.join(', ') : 'N/A';

  const systemPrompt = `You are a cross-border e-commerce listing expert specializing in Mercado Libre (${input.site}).
You write product titles in ${langName(lang)} that are:
1. Optimized for ML search algorithm (include relevant keywords)
2. Based on the 1688 source product information (Chinese title, specs)
3. NOT copying the competitor's title — use your own expression
4. Maximum 60 characters
5. Professional, clear, and compelling
6. Include key specifications (size, color, material, quantity) when available
7. Naturally incorporate 1-2 current hot-search keywords if they fit the product; do NOT force irrelevant keywords

Output format: Return exactly ${count} title candidates. For EACH title, output two consecutive lines:
1) <title in ${langName(lang)}>
ZH: <concise Chinese translation>
2) <title in ${langName(lang)}>
ZH: <concise Chinese translation>
...
Do not include any other text, explanation, or markdown.`;

  const prompt = `Generate ${count} product titles in ${langName(lang)} for Mercado Libre ${input.site}.

1688 source product (Chinese): ${input.sourceTitle || 'N/A'}
Source price (CNY): ${input.sourcePriceCNY || 'N/A'}
Competitor reference title (for extracting product attributes ONLY, do NOT copy): ${input.competitorTitle}
Brand: ${brandPart || 'Generic (do not include brand name)'}
Current hot search keywords on Mercado Libre ${input.site} (use 1-2 naturally if relevant): ${trendText}

Requirements:
- Extract the PRODUCT TYPE, MATERIAL, COLOR, SIZE, QUANTITY from both the 1688 title and competitor title
- Write entirely new titles in ${langName(lang)} — do NOT translate or rearrange the competitor title
- Each title must be ≤ 60 characters
- Prioritize the most important keywords first (product type, key spec)
- Include 1-2 selling point words (e.g. durable, portable, multifunctional)
- If a hot keyword strongly matches the product, include it; otherwise ignore it
- IMPORTANT: Provide a concise Chinese translation immediately below each title, prefixed with "ZH: "`;

  try {
    const raw = await llmGenerate({ prompt, systemPrompt, timeoutMs: 25000 });
    const parsed = parseTitleList(raw, count);
    if (parsed.titles.length === 0) {
      return { titles: [], translations: [], used: 'fallback', error: 'AI returned no parseable titles' };
    }
    return { titles: parsed.titles, translations: parsed.translations, used: 'ai' };
  } catch (err: any) {
    return { titles: [], translations: [], used: 'fallback', error: err?.message || 'AI generation failed' };
  }
}

interface ParsedTitleList {
  titles: string[];
  translations: string[];
}

function parseTitleList(raw: string, max: number): ParsedTitleList {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const titles: string[] = [];
  const translations: string[] = [];
  const zhPrefixes = ['ZH:', '中文：', '中文:', '中文翻译：', '中文翻译:', '翻译：', '翻译:'];

  // 去掉标题两侧的 markdown 噪音（**、引号、列表符 -）
  const clean = (s: string) =>
    s
      .replace(/^\d+[\)\.\:]\s*/, '')
      .replace(/^[*`_~\-\s]+|[*`_~\-\s]+$/g, '')
      .replace(/^["'「」『』]+|["'「」『』]+$/g, '')
      .trim();

  for (let i = 0; i < lines.length && titles.length < max; i++) {
    const line = lines[i];
    // 编号标题行：以数字 + )/.:/) 开头，且不是 ZH 行
    const isTitleLine = /^\d+[\)\.\:]\s*/.test(line) && !zhPrefixes.some((pre) => line.toUpperCase().startsWith(pre.toUpperCase()));
    if (!isTitleLine) continue;

    const cleaned = clean(line);
    if (!cleaned || cleaned.length < 5 || cleaned.length > 80) continue;

    titles.push(cleaned);
    const nextLine = lines[i + 1] || '';
    let zh = '';
    for (const pre of zhPrefixes) {
      if (nextLine.toUpperCase().startsWith(pre.toUpperCase())) {
        zh = nextLine.slice(pre.length).trim();
        break;
      }
    }
    translations.push(zh);
  }

  // 兜底：编号解析未命中时，直接把「非 ZH、非说明性」的行当作标题取前 max 条。
  // 模型常不遵守编号格式，但仍能产出可用标题。
  if (titles.length === 0) {
    const junk = /^(sure|here|ok|note|title|título|los|las|el|la|the|este|esta)\b/i;
    for (let i = 0; i < lines.length && titles.length < max; i++) {
      const line = lines[i];
      if (zhPrefixes.some((pre) => line.toUpperCase().startsWith(pre.toUpperCase()))) continue;
      const cleaned = clean(line);
      if (!cleaned || cleaned.length < 5 || cleaned.length > 80) continue;
      if (junk.test(cleaned)) continue;
      titles.push(cleaned);
      translations.push('');
    }
  }

  return { titles, translations };
}

// ============ AI 描述生成 ============

export interface AIDescriptionInput {
  /** 你的上架标题 */
  title: string;
  /** 站点 */
  site: string;
  /** 1688 货源标题（中文） */
  sourceTitle?: string;
  /** 1688 货源价格（CNY） */
  sourcePriceCNY?: number;
  /** 竞品描述（参考用，不复制） */
  competitorDescription?: string;
  /** 商品分类名 */
  categoryName?: string;
  /** 品牌 */
  brand?: string;
  /** 强制使用的热搜词（可选；默认自动按 site 拉取 ML Trends） */
  trendKeywords?: string[];
}

export interface AIDescriptionResult {
  description: string;
  used: 'ai' | 'fallback';
  error?: string;
}

/**
 * AI 生成商品描述：基于 1688 货源信息 + ML 站点热搜词生成目标语言描述。
 * 如果提供了竞品描述，会参考其结构但用自己的表达重写。
 */
export async function aiGenerateDescription(input: AIDescriptionInput): Promise<AIDescriptionResult> {
  const lang = langOfSite(input.site);
  const brandPart = input.brand && input.brand.toLowerCase() !== 'generic' ? input.brand : '';

  // 自动获取站点热搜词；失败则继续
  let trendWords: string[] = [];
  try {
    trendWords = (input.trendKeywords?.length ? input.trendKeywords : await getTrendsKeywords(input.site, 10));
  } catch {
    trendWords = [];
  }
  const trendText = trendWords.length ? trendWords.join(', ') : 'N/A';

  const systemPrompt = `You are a cross-border e-commerce listing expert specializing in Mercado Libre (${input.site}).
You write product descriptions in ${langName(lang)} that are:
1. Professional, persuasive, and well-structured
2. Based on the 1688 source product information
3. NOT copying the competitor's description — use your own words
4. Include: product overview, key features (3-5 bullet points), specifications, and a closing call-to-action
5. Plain text format (no HTML, no markdown)
6. 300-500 characters total (concise but informative)
7. Naturally weave in 1-2 relevant hot-search keywords if they fit the product; do NOT keyword-stuff

Output format: Return ONLY the description text. No preamble, no explanation.`;

  let prompt = `Generate a product description in ${langName(lang)} for Mercado Libre ${input.site}.

Product title: ${input.title}
1688 source product (Chinese): ${input.sourceTitle || 'N/A'}
Source price (CNY): ${input.sourcePriceCNY || 'N/A'}
Category: ${input.categoryName || 'N/A'}
Brand: ${brandPart || 'Generic'}
Current hot search keywords on Mercado Libre ${input.site} (use 1-2 naturally if relevant): ${trendText}`;

  if (input.competitorDescription && input.competitorDescription.trim().length > 10) {
    prompt += `

Competitor description (for reference ONLY — understand what info buyers need, but do NOT copy or translate it):
${input.competitorDescription.slice(0, 500)}

Important: Write an entirely NEW description. You may cover similar information points but must use your own expression and structure.`;
  } else {
    prompt += `

Write a compelling description covering:
- What the product is
- Key features and benefits (3-5 points)
- Material / size / specifications
- Why the buyer should choose this product`;
  }

  try {
    const raw = await llmGenerate({ prompt, systemPrompt, timeoutMs: 75000 });
    const desc = raw.replace(/^["'\s]+|["'\s]+$/g, '').trim();
    if (desc.length < 20) {
      return { description: '', used: 'fallback', error: 'AI description too short' };
    }
    return { description: desc, used: 'ai' };
  } catch (err: any) {
    return { description: '', used: 'fallback', error: err?.message || 'AI generation failed' };
  }
}

// ============ 批量生成 ============

export interface BatchAITitleItem {
  competitorTitle: string;
  site: string;
  sourceTitle?: string;
  sourcePriceCNY?: number;
  brand?: string;
  trendKeywords?: string[];
}

/**
 * 批量 AI 标题生成（串行调用，避免并发过多触发限速）。
 * 失败的条目返回空字符串，调用方可用规则引擎补全。
 */
export async function aiGenerateTitlesBatch(
  items: BatchAITitleItem[],
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const r = await aiGenerateTitles({
        competitorTitle: item.competitorTitle,
        site: item.site,
        sourceTitle: item.sourceTitle,
        sourcePriceCNY: item.sourcePriceCNY,
        brand: item.brand,
        count: 1,
        trendKeywords: item.trendKeywords,
      });
      results.push(r.titles[0] || '');
    } catch {
      results.push('');
    }
    onProgress?.(i + 1, items.length);
  }
  return results;
}

/**
 * 批量 AI 描述生成。
 */
export async function aiGenerateDescriptionsBatch(
  items: AIDescriptionInput[],
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const r = await aiGenerateDescription(items[i]);
      results.push(r.description || '');
    } catch {
      results.push('');
    }
    onProgress?.(i + 1, items.length);
  }
  return results;
}

// ============ 订单文本翻译 ============

/**
 * 翻译订单中的西/葡语文本（商品标题、买家留言、地址备注等）为中文。
 * 返回 { 原文: 中文 } map；未译出的原文不会出现。
 */
export async function translateOrderTexts(
  texts: string[],
  site: string,
): Promise<Record<string, string>> {
  const cfg = getLlmConfig();
  if (!cfg) {
    console.log('[translateOrderTexts] LLM 未配置，跳过翻译');
    return {};
  }
  const unique = [...new Set(texts.filter((t) => typeof t === 'string' && t.trim()))];
  if (!unique.length) return {};

  const lang = langOfSite(site);
  const langNameText = langName(lang);
  const prompt = `将以下 ${langNameText} 文本翻译成中文。保留品牌名、型号、人名。只返回 JSON，不要解释、不要 markdown 代码块。
格式示例：{"Cuaderno":"笔记本","mochila":"背包"}

待翻译：${JSON.stringify(unique)}`;

  try {
    const raw = await llmGenerate({
      prompt,
      systemPrompt: '你是一个跨境电商助手，擅长把订单中的西/葡语文本翻译成中文。只输出 JSON，不要解释。',
      timeoutMs: 30000,
      jsonMode: true,
      temperature: 0.2,
    });
    const map = extractJsonObject(raw) as Record<string, string> | undefined;
    const result: Record<string, string> = {};
    if (map) {
      for (const k of unique) {
        const v = map[k];
        if (typeof v === 'string' && v.trim()) result[k] = v.trim();
      }
    }
    return result;
  } catch (err: any) {
    console.error('[translateOrderTexts] 翻译失败：', err?.message || err);
    return {};
  }
}

// ============ AI 选品研判 ============

export interface AIEvaluationInput {
  site: string;
  title: string;
  categoryName?: string;
  priceUsd: number;
  soldQuantity: number;
  dailySales: number;
  sourceTitle?: string;
  sourcePriceCny?: number;
  listingPriceUsd?: number;
  netProfitRate?: number;
  scoreTotal?: number;
  scoreDemand?: number;
  scoreCompetition?: number;
  scoreProfit?: number;
  scoreLogistics?: number;
  scoreCompliance?: number;
  trendKeywords?: string[];
}

export interface AIEvaluationResult {
  pass: boolean;
  score: number;
  reason: string;
  risks: string[];
  suggestions: string[];
  used: 'ai' | 'fallback';
  error?: string;
}

/**
 * 让 LLM 对候选商品做一次「值不值得做」的研判。
 * 输入包含 ML 竞品信息、1688 货源、利润、五维评分和站点热搜词。
 * 输出 JSON：{ pass, score, reason, risks, suggestions }。
 * LLM 失败时返回 fallback 结果（按规则评分通过即 pass），不阻断流水线。
 */
export async function aiEvaluateCandidate(input: AIEvaluationInput): Promise<AIEvaluationResult> {
  const cfg = getLlmConfig();
  if (!cfg) {
    return fallbackEvaluation(input);
  }

  const lang = langOfSite(input.site);
  const langNameText = langName(lang);
  const trendText = (input.trendKeywords || []).slice(0, 10).join(', ') || 'N/A';

  const systemPrompt = `You are a cross-border e-commerce product selection expert for Mercado Libre.
Evaluate whether the following candidate product is worth sourcing and selling.
Respond ONLY in JSON format, no explanation, no markdown code block.

JSON schema:
{
  "pass": boolean,        // true if recommended, false if too risky or low value
  "score": number,        // 0.0~1.0 overall confidence
  "reason": string,       // concise Chinese reason for the decision (≤80 chars)
  "risks": string[],      // 0-3 main risks in Chinese
  "suggestions": string[] // 0-3 actionable suggestions in Chinese
}

Rules:
- Prefer products with daily sales ≥1, net profit rate ≥15%, and clear logistics data.
- Be cautious with heavy/bulky items, extremely low margins, or generic titles lacking product specifics.
- If the title is only a broad category name (e.g. "Hogar, Muebles y Jardín"), score low and explain "标题过大类，缺具体商品信息".`;

  const prompt = `请研判以下 Mercado Libre ${input.site} 候选商品是否值得做：

站点：${input.site}
商品标题（${langNameText}）：${input.title}
类目：${input.categoryName || 'N/A'}
竞品售价：$${input.priceUsd?.toFixed(2) || 'N/A'}
累计销量：${input.soldQuantity || 'N/A'}
日均销量：${input.dailySales?.toFixed(2) || 'N/A'}
1688 货源标题：${input.sourceTitle || 'N/A'}
1688 采购价（CNY）：${input.sourcePriceCny?.toFixed(2) || 'N/A'}
建议售价：$${input.listingPriceUsd?.toFixed(2) || 'N/A'}
净利率：${input.netProfitRate !== undefined ? `${(input.netProfitRate * 100).toFixed(1)}%` : 'N/A'}
五维评分：总分 ${input.scoreTotal ?? 'N/A'}（需求 ${input.scoreDemand ?? 'N/A'} / 竞争 ${input.scoreCompetition ?? 'N/A'} / 利润 ${input.scoreProfit ?? 'N/A'} / 物流 ${input.scoreLogistics ?? 'N/A'} / 合规 ${input.scoreCompliance ?? 'N/A'}）
站点热搜词参考：${trendText}

请按 systemPrompt 要求只返回 JSON。`;

  try {
    const raw = await llmGenerate({
      prompt,
      systemPrompt,
      timeoutMs: 20000,
      jsonMode: true,
      temperature: 0.3,
    });
    const parsed = extractJsonObject(raw) as Partial<AIEvaluationResult> | undefined;
    if (!parsed || typeof parsed.pass !== 'boolean' || typeof parsed.score !== 'number') {
      return { ...fallbackEvaluation(input), used: 'fallback', error: `LLM 返回格式异常: ${raw.slice(0, 200)}` };
    }
    return {
      pass: parsed.pass,
      score: Math.max(0, Math.min(1, parsed.score)),
      reason: String(parsed.reason || '').slice(0, 120) || (parsed.pass ? 'AI 研判通过' : 'AI 研判不通过'),
      risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3).map(String) : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3).map(String) : [],
      used: 'ai',
    };
  } catch (err: any) {
    console.error('[aiEvaluateCandidate] LLM 研判失败：', err?.message || err);
    return { ...fallbackEvaluation(input), used: 'fallback', error: err?.message || String(err) };
  }
}

function fallbackEvaluation(input: AIEvaluationInput): AIEvaluationResult {
  const pass = (input.scoreTotal ?? 0) >= 0.6 && (input.scoreCompliance ?? 1) > 0;
  return {
    pass,
    score: input.scoreTotal ?? 0,
    reason: pass ? '规则评分通过（LLM 未配置或失败）' : '规则评分未通过（LLM 未配置或失败）',
    risks: [],
    suggestions: [],
    used: 'fallback',
  };
}

// ============ 1688 货源相关性校验 ============

export interface SourceRelevanceResult {
  relevant: boolean;
  score: number;
  reason: string;
  /** true 表示 LLM 未配置/调用失败，结果不可信，调用方应退回兜底逻辑而非据此拦截 */
  unavailable?: boolean;
}

/**
 * 判断 1688 货源与 Mercado Libre 竞品是否属于同类/同功能商品。
 * 用于拦截「照片纸匹配到挂钩」这类明显错配。
 *
 * 注意：
 * - 不需要同品牌，接受同款/同类/可替代 generic 货源。
 * - LLM 未配置或失败时保守返回 relevant=true，避免阻断流水线。
 */
export async function assessSourceRelevance(
  mlTitle: string,
  mlCategory: string,
  source: { title: string; stats?: { categoryListName?: string } }
): Promise<SourceRelevanceResult> {
  const cfg = getLlmConfig();
  if (!cfg) {
    return { relevant: true, score: 0.5, reason: 'LLM 未配置，跳过相关性校验', unavailable: true };
  }

  const systemPrompt = `You are a cross-border e-commerce product matching expert.
Given a Mercado Libre competitor product (title + category) and a 1688 source product (Chinese title + category), determine if the 1688 product is a relevant source for selling a similar product on Mercado Libre.
Respond ONLY in JSON format, no explanation, no markdown code block.

JSON schema:
{
  "relevant": boolean,  // true if the 1688 product matches the ML product type/function
  "score": number,      // 0.0~1.0 relevance confidence
  "reason": string      // concise Chinese reason (≤60 chars)
}

Rules:
- The 1688 product does NOT need to be the same brand. Generic alternatives are fine.
- It MUST be the same product type / function / use case (e.g., photo paper ≠ wall hooks).
- Beauty/makeup products in the same subcategory are usually relevant.
- Be strict: reject obvious category mismatches.`;

  const prompt = `Mercado Libre 竞品标题：${mlTitle}
Mercado Libre 类目：${mlCategory || 'N/A'}
1688 货源标题：${source.title}
1688 货源类目：${source.stats?.categoryListName || 'N/A'}

请判断该 1688 货源是否与 Mercado Libre 竞品属于同类/同功能商品，并按 systemPrompt 要求只返回 JSON。`;

  try {
    const raw = await llmGenerate({
      prompt,
      systemPrompt,
      timeoutMs: 15000,
      jsonMode: true,
      temperature: 0.2,
    });
    const parsed = extractJsonObject(raw) as Partial<SourceRelevanceResult> | undefined;
    if (!parsed || typeof parsed.relevant !== 'boolean' || typeof parsed.score !== 'number') {
      return { relevant: true, score: 0.5, reason: 'LLM 相关性格式异常，按通过处理', unavailable: true };
    }
    return {
      relevant: parsed.relevant,
      score: Math.max(0, Math.min(1, parsed.score)),
      reason: String(parsed.reason || '').slice(0, 80) || (parsed.relevant ? 'AI 判断匹配' : 'AI 判断不匹配'),
    };
  } catch (err: any) {
    console.error('[assessSourceRelevance] LLM 相关性判断失败：', err?.message || err);
    return { relevant: true, score: 0.5, reason: 'LLM 相关性判断失败，按通过处理', unavailable: true };
  }
}
