/**
 * Mercado Libre API 集成模块
 * 获取墨西哥(MLM)和巴西(MLB)站点各品类销量前100且单价不超过15美元的商品
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
// 公网隧道（localtunnel）：固定域名不可达时自动回退用
import { startTunnel, stopTunnel, isTunnelRunning, getTunnelInfo } from './tunnel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 站点配置
export const ML_SITES = {
  MLM: { name: '墨西哥', currency: 'MXN', code: 'MLM', domain: 'mercadolibre.com.mx', productUrlPrefix: 'https://www.mercadolibre.com.mx/p/', country: 'MX' },
  MLB: { name: '巴西', currency: 'BRL', code: 'MLB', domain: 'mercadolivre.com.br', productUrlPrefix: 'https://www.mercadolivre.com.br/p/', country: 'BR' },
  MLC: { name: '智利', currency: 'CLP', code: 'MLC', domain: 'mercadolibre.cl', productUrlPrefix: 'https://www.mercadolibre.cl/p/', country: 'CL' },
  MCO: { name: '哥伦比亚', currency: 'COP', code: 'MCO', domain: 'mercadolibre.com.co', productUrlPrefix: 'https://www.mercadolibre.com.co/p/', country: 'CO' },
} as const;

export type MLSiteCode = keyof typeof ML_SITES;

// 站点所在国家 id（用于判断「跨境 / 本土」）
export const SITE_COUNTRY: Record<string, string> = {
  MLM: 'MX',
  MLB: 'BR',
  MLC: 'CL',
  MCO: 'CO',
};

/** 抓取选项（价格上限 + 筛选 + 扩量） */
export interface FetchOptions {
  priceLimitUsd?: number;     // 单价上限 (USD)，默认 15
  excludeFull?: boolean;      // 排除 ML Full（官方仓 / fulfillment）
  excludeDomestic?: boolean;  // 排除本土卖家（仅保留跨境 / 国际卖家）
  onlyNew?: boolean;          // 仅全新
  includeSubcategories?: boolean; // 展开子分类以获取更多商品（更慢）
  miaoshouPackage?: boolean;  // 导出妙手素材包（ZIP，含商品主图），推荐的妙手导入方式
}

// 最大单价 (USD)
const MAX_PRICE_USD = 15;

// 每个品类获取的商品数量
const TOP_N_PRODUCTS = 100;

// API 基础地址（默认直连，可被 API 代理 URL 覆盖）
const ML_API_HOST = 'https://api.mercadolibre.com';

// API 代理 URL（Cloudflare Worker 等，空则直连）
let mlApiProxyUrl: string = '';

/** 获取当前生效的 API 基础地址 */
function getApiBase(): string {
  return mlApiProxyUrl || ML_API_HOST;
}

// ML Access Token（运行时设置）
let mlAccessToken: string = process.env.ML_ACCESS_TOKEN || '';

// 代理配置
let mlProxyUrl: string = '';
const PROXY_FILE = path.join(__dirname, '..', 'data', 'ml-proxy.json');

/** 获取代理 Agent（如果有配置） */
function getProxyAgent(): https.Agent | undefined {
  if (!mlProxyUrl) return undefined;
  try {
    if (mlProxyUrl.startsWith('socks')) {
      return new SocksProxyAgent(mlProxyUrl) as unknown as https.Agent;
    }
    return new HttpsProxyAgent(mlProxyUrl) as unknown as https.Agent;
  } catch (err) {
    console.error('[ML Proxy] 代理配置无效:', err);
    return undefined;
  }
}

/** 设置代理 URL */
export function setProxyConfig(proxyUrl: string) {
  mlProxyUrl = proxyUrl.trim();
  // 更换/清除代理后，重置 /search 封锁标记，给 search 一次重新尝试的机会
  // （住宅代理可解锁中国 IP 对 /search 的地理封锁）
  searchConfirmedBlocked = false;
  searchBlockedProxy = '';
  persistProxyData();
}

/** 获取代理配置状态（proxyUrl 已打码，仅用于前端展示，切勿用于实际连接） */
export function getProxyConfig() {
  return {
    proxyUrl: mlProxyUrl ? `${mlProxyUrl.replace(/\/\/.*@/, '//***:***@')}` : '',
    hasProxy: !!mlProxyUrl,
  };
}

/** 获取原始代理 URL（未打码，仅供服务端内部实际建连使用，如测试连通 / 抓取） */
export function getRawProxyUrl(): string {
  return mlProxyUrl;
}

/** 持久化代理配置 */
function persistProxyData() {
  try {
    const dir = path.dirname(PROXY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROXY_FILE, JSON.stringify({ proxyUrl: mlProxyUrl, savedAt: new Date().toISOString() }, null, 2));
    console.log(`[ML Proxy] 代理配置已保存`);
  } catch (err) {
    console.error('[ML Proxy] 保存失败:', err);
  }
}

/** 从文件加载代理配置 */
function loadProxyData() {
  try {
    if (!fs.existsSync(PROXY_FILE)) return;
    const raw = fs.readFileSync(PROXY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data.proxyUrl) {
      mlProxyUrl = data.proxyUrl;
      console.log(`[ML Proxy] 代理配置已加载: ${mlProxyUrl.replace(/\/\/.*@/, '//***:***@')}`);
    }
  } catch (err) {
    console.error('[ML Proxy] 加载失败:', err);
  }
}

// 启动时加载代理配置
loadProxyData();

// ===== API 代理 URL 配置（Cloudflare Worker 等反向代理）=====
const API_PROXY_FILE = path.join(__dirname, '..', 'data', 'ml-api-proxy.json');

/** 设置 API 代理 URL */
export function setApiProxyUrl(proxyUrl: string) {
  mlApiProxyUrl = proxyUrl.trim().replace(/\/+$/, ''); // 去掉尾部斜杠
  persistApiProxyData();
  console.log(`[ML API Proxy] API 代理 URL 已设置: ${mlApiProxyUrl || '(已清除，直连模式)'}`);
}

/** 获取 API 代理 URL 状态 */
export function getApiProxyConfig() {
  return {
    apiProxyUrl: mlApiProxyUrl,
    hasApiProxy: !!mlApiProxyUrl,
  };
}

/** 持久化 API 代理 URL */
function persistApiProxyData() {
  try {
    const dir = path.dirname(API_PROXY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(API_PROXY_FILE, JSON.stringify({ apiProxyUrl: mlApiProxyUrl, savedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error('[ML API Proxy] 保存失败:', err);
  }
}

/** 从文件加载 API 代理 URL */
function loadApiProxyData() {
  try {
    if (!fs.existsSync(API_PROXY_FILE)) return;
    const raw = fs.readFileSync(API_PROXY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data.apiProxyUrl) {
      mlApiProxyUrl = data.apiProxyUrl;
      console.log(`[ML API Proxy] API 代理 URL 已加载: ${mlApiProxyUrl}`);
    }
  } catch (err) {
    console.error('[ML API Proxy] 加载失败:', err);
  }
}

// 启动时加载 API 代理 URL
loadApiProxyData();

// Token 持久化文件路径
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'ml-token.json');

interface PersistedTokenData {
  accessToken: string;
  refreshToken: string;
  appId: string;
  secretKey: string;
  redirectUri: string;
  expiry: string | null;
  savedAt: string;
}

/** 将 token 和 OAuth 配置保存到文件 */
function persistTokenData() {
  try {
    const data: PersistedTokenData = {
      accessToken: mlAccessToken,
      refreshToken: mlRefreshToken,
      appId: mlAppId,
      secretKey: mlSecretKey,
      redirectUri: mlRedirectUri,
      expiry: mlTokenExpiry ? mlTokenExpiry.toISOString() : null,
      savedAt: new Date().toISOString(),
    };
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf-8');
    console.log('[ML Token] 凭证已持久化到文件');
  } catch (err) {
    console.error('[ML Token] 持久化失败:', err);
  }
}

/** 从文件加载 token 和 OAuth 配置 */
function loadPersistedTokenData() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return;
    const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
    const data: PersistedTokenData = JSON.parse(raw);
    mlAccessToken = data.accessToken || '';
    mlRefreshToken = data.refreshToken || '';
    mlAppId = data.appId || '';
    mlSecretKey = data.secretKey || '';
    mlRedirectUri = data.redirectUri || 'http://localhost:3000/api/ml/oauth/callback';
    // 环境变量 ML_REDIRECT_URI 优先于持久化值（便于部署时覆盖，避免被旧 localhost 覆盖）
    if (process.env.ML_REDIRECT_URI) mlRedirectUri = process.env.ML_REDIRECT_URI;
    mlTokenExpiry = data.expiry ? new Date(data.expiry) : null;
    console.log('[ML Token] 从文件加载凭证:', {
      hasToken: mlAccessToken.length > 0,
      hasRefreshToken: mlRefreshToken.length > 0,
      hasAppId: mlAppId.length > 0,
      expiry: mlTokenExpiry?.toISOString() || 'none',
    });
  } catch (err) {
    console.error('[ML Token] 加载持久化凭证失败:', err);
  }
}

/** 清除持久化的 token 文件 */
function clearPersistedTokenData() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
      console.log('[ML Token] 持久化文件已删除');
    }
  } catch (err) {
    console.error('[ML Token] 清除持久化文件失败:', err);
  }
}

// 启动时加载持久化的凭证（移到变量声明之后调用，避免 TDZ 错误）

export function setAccessToken(token: string) {
  mlAccessToken = token;
  persistTokenData();
}

export function getAccessToken(): string {
  return mlAccessToken;
}

export function hasAccessToken(): boolean {
  return mlAccessToken.length > 0;
}

/**
 * 验证 access token 是否有效
 */
export async function validateAccessToken(): Promise<{ valid: boolean; message: string; userInfo?: any }> {
  if (!mlAccessToken) {
    return { valid: false, message: '未设置 access token' };
  }
  try {
    const data = await httpsGet(`${getApiBase()}/users/me`);
    if (data && data.id) {
      return { valid: true, message: `Token 有效，用户: ${data.nickname || data.email || data.id}`, userInfo: data };
    }
    return { valid: false, message: 'Token 无效或已过期' };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('401')) {
      return { valid: false, message: 'Token 无效或已过期，请重新获取' };
    }
    if (msg.includes('403')) {
      return { valid: false, message: 'Token 被 PolicyAgent 拦截，可能 IP 被封或 token 无效' };
    }
    return { valid: false, message: `验证失败: ${msg}` };
  }
}

// ============= OAuth2 配置 =============

let mlAppId: string = process.env.ML_APP_ID || '';
let mlSecretKey: string = process.env.ML_SECRET_KEY || '';
let mlRedirectUri: string = process.env.ML_REDIRECT_URI || 'http://localhost:3000/api/ml/oauth/callback';
let tunnelCallbackUrl: string = '';
let mlRefreshToken: string = '';
let mlTokenExpiry: Date | null = null;
// 保存授权时使用的 redirect_uri，确保 token 交换时一致
let pendingRedirectUri: string = '';
// PKCE：授权时生成 code_verifier，token 交换时带上（应用启用 PKCE 时必需）
let pendingCodeVerifier: string = '';

// 启动时加载持久化的凭证（必须在变量声明之后调用）
loadPersistedTokenData();

/** 生成 PKCE code_verifier（43-128 字符的随机串） */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 由 code_verifier 生成 S256 code_challenge */
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export interface OAuthConfig {
  appId: string;
  secretKey: string;
  redirectUri: string;
}

export function setOAuthConfig(config: Partial<OAuthConfig>) {
  if (config.appId !== undefined) mlAppId = config.appId;
  if (config.secretKey !== undefined) mlSecretKey = config.secretKey;
  if (config.redirectUri !== undefined) mlRedirectUri = config.redirectUri;
  persistTokenData();
}

export function getOAuthConfig(): OAuthConfig {
  return {
    appId: mlAppId,
    secretKey: mlSecretKey ? mlSecretKey.slice(0, 4) + '****' : '',
    redirectUri: getEffectiveRedirectUri(),
  };
}

export function setTunnelCallbackUrl(url: string) {
  tunnelCallbackUrl = url;
}

export function getTunnelCallbackUrl(): string {
  return tunnelCallbackUrl;
}

// ============= 默认固定回调域名 + 自动探测 =============
// 项目统一使用 cloudflared 自定义域名，OAuth 回调地址固定不变。
// 启动时自动探测该域名是否可达（cloudflared 是否运行），不可达则自动退回到 localtunnel 临时地址，
// 并提示用户去美客多后台把「重定向 URI」改成临时地址。
export const DEFAULT_FIXED_REDIRECT_URI = 'https://ml.w999w.dpdns.org/api/ml/oauth/store-callback';

export type RedirectMode = 'env' | 'fixed' | 'tunnel';

export interface ResolvedRedirect {
  uri: string;            // 当前生效的回调地址（含 /api/ml/oauth/store-callback 后缀）
  mode: RedirectMode;     // env=手动环境变量 / fixed=固定域名 / tunnel=临时隧道回退
  reachable: boolean;     // 是否为可达状态
  fixedDomain: string;    // 项目固定的回调域名（完整路径）
  notice?: string;        // mode==='tunnel' 时：提示去美客多后台改重定向 URI
  tunnelUrl?: string;     // mode==='tunnel' 时：localtunnel 公网地址
}

let resolvedRedirect: ResolvedRedirect | null = null;
let resolvePromise: Promise<ResolvedRedirect> | null = null;

/**
 * 专用自检路径：cloudflared 把流量转回本机后端时，本机会返回 {ok:true}。
 * 若 cloudflared 已停但隧道仍在 Cloudflare，域名会返回 502 错误页（非 json），此时视为不可达。
 */
const REDIRECT_PING_PATH = '/api/ml/oauth/ping';

/**
 * 探测固定回调域名是否真的可达（流量确实转回本机后端）：
 * 仅当返回 200 且 JSON 含 ok:true 才算可达；Cloudflare 的错误页（502/html）视为不可达。
 */
async function probeRedirectReachable(baseUrl: string, timeoutMs = 6000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}${REDIRECT_PING_PATH}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return false;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return false; // Cloudflare 错误页是 text/html
    const data = await res.json().catch(() => null);
    return !!data && data.ok === true;
  } catch {
    return false;
  }
}

/**
 * 解析当前生效的 OAuth 回调地址（带自动探测 + 自动回退）：
 * 1. 显式设置 ML_REDIRECT_URI 环境变量 → 直接用（mode='env'，优先级最高）
 * 2. 否则探测默认固定域名 ml.w999w.dpdns.org 是否可达
 *    - 可达 → 用固定域名（mode='fixed'）；若之前起过隧道则顺手关掉
 *    - 不可达 → 自动启动 localtunnel，用临时地址（mode='tunnel'，并附提示）
 */
async function resolveOAuthRedirect(): Promise<ResolvedRedirect> {
  // 1. 环境变量最高优先级
  if (process.env.ML_REDIRECT_URI) {
    return {
      uri: process.env.ML_REDIRECT_URI,
      mode: 'env',
      reachable: true,
      fixedDomain: DEFAULT_FIXED_REDIRECT_URI,
    };
  }
  // 2. 探测固定域名是否可达（用基座地址 + 自检路径，确认流量真的转回本机后端）
  const base = DEFAULT_FIXED_REDIRECT_URI.replace(/\/api\/ml\/oauth\/store-callback\/?$/, '');
  const ok = await probeRedirectReachable(base);
  if (ok) {
    // 已从临时隧道切回固定域名：关掉多余隧道，释放资源
    if (isTunnelRunning()) {
      try { stopTunnel(); setTunnelCallbackUrl(''); } catch { /* ignore */ }
    }
    return {
      uri: DEFAULT_FIXED_REDIRECT_URI,
      mode: 'fixed',
      reachable: true,
      fixedDomain: DEFAULT_FIXED_REDIRECT_URI,
    };
  }
  // 3. 不可达 → 自动回退 localtunnel
  try {
    const t = await startTunnel();
    setTunnelCallbackUrl(t.callbackUrl);
    return {
      uri: t.callbackUrl,
      mode: 'tunnel',
      reachable: true,
      fixedDomain: DEFAULT_FIXED_REDIRECT_URI,
      notice: `固定回调域名 ${DEFAULT_FIXED_REDIRECT_URI} 当前不可达（cloudflared 可能未运行，或域名尚未解析到隧道）。已自动生成临时地址：${t.callbackUrl}\n请到 美客多开发者后台 → 你的应用 → 重定向 URI，把它改成上面这个临时地址后再授权；启动 cloudflared 后点「重新测试回调地址」即可恢复固定域名，无需再改后台。`,
      tunnelUrl: t.url,
    };
  } catch (e: any) {
    // 连隧道都起不来：仍返回固定域名（generateAuthUrl 会拦截并提示），但标记不可达
    return {
      uri: DEFAULT_FIXED_REDIRECT_URI,
      mode: 'fixed',
      reachable: false,
      fixedDomain: DEFAULT_FIXED_REDIRECT_URI,
      notice: `固定域名与公网隧道均不可用：${e?.message || e}。请先启动 cloudflared（或设置环境变量 ML_REDIRECT_URI）后重试。`,
    };
  }
}

/** 首次 / 需要时触发解析，带缓存，避免重复探测；解析中并发请求复用同一 Promise */
export function ensureOAuthRedirectResolved(): Promise<ResolvedRedirect> {
  if (resolvedRedirect) return Promise.resolve(resolvedRedirect);
  if (!resolvePromise) {
    resolvePromise = resolveOAuthRedirect().then((r) => { resolvedRedirect = r; return r; });
  }
  return resolvePromise;
}

/** 强制重新解析（例如用户启动 cloudflared 后手动点「重新测试」） */
export async function reresolveOAuthRedirect(): Promise<ResolvedRedirect> {
  resolvedRedirect = null;
  resolvePromise = null;
  return ensureOAuthRedirectResolved();
}

/** 手动覆盖解析结果（例如前端手动启动/停止隧道时同步） */
export function overrideResolvedRedirect(r: ResolvedRedirect) {
  resolvedRedirect = r;
  resolvePromise = null;
}

/** 读取当前已解析结果（可能为空，调用方应优先用 ensureOAuthRedirectResolved） */
export function getResolvedRedirect(): ResolvedRedirect | null {
  return resolvedRedirect;
}

/** 当前生效的回调地址（同步，供 getOAuthConfig / generateAuthUrl / buildStoreAuthUrl 等使用） */
export function getEffectiveRedirectUri(): string {
  if (resolvedRedirect) return resolvedRedirect.uri;
  if (process.env.ML_REDIRECT_URI) return process.env.ML_REDIRECT_URI;
  // 解析尚未完成时的兜底：默认就是固定域名（公网地址，不会是 localhost）
  return DEFAULT_FIXED_REDIRECT_URI;
}

/** 当前生效回调地址的「域名基座」（去掉 /api/ml/oauth/store-callback 后缀） */
export function getEffectiveRedirectBase(): string {
  return getEffectiveRedirectUri().replace(/\/api\/ml\/oauth\/store-callback\/?$/, '');
}

export function hasOAuthConfig(): boolean {
  return mlAppId.length > 0 && mlSecretKey.length > 0;
}

export function getTokenExpiry(): Date | null {
  return mlTokenExpiry;
}

export function getRefreshToken(): string {
  return mlRefreshToken;
}

/** per-store OAuth / 订单拉取复用：暴露 App ID（未打码） */
export function getMlAppId(): string {
  return mlAppId;
}

/** per-store OAuth / 订单拉取复用：暴露 Secret Key（未打码，仅服务端内部使用） */
export function getMlSecretKeyRaw(): string {
  return mlSecretKey;
}

/** per-store OAuth / 订单拉取复用：暴露当前 API 基础地址 */
export function getMlApiBase(): string {
  return getApiBase();
}

/**
 * 生成 OAuth2 授权 URL
 * @param site 站点；传 'cbt' 或 'CBT' 表示 CBT 跨境卖家，使用 global-selling 授权入口
 */
export function generateAuthUrl(usePkce: boolean = true, site?: string): string {
  if (!mlAppId) {
    throw new Error('请先设置 App ID');
  }
  // 全局单应用授权复用与店铺授权相同的回调路径 /api/ml/oauth/store-callback
  // 美客多要求 redirect_uri 必须与后台登记逐字一致；统一到已登记的 store-callback 路径避免被拒
  const redirectUri = getEffectiveRedirectUri();
  if (!redirectUri || redirectUri.includes('localhost')) {
    throw new Error('Mercado Libre 不接受 localhost 回调地址，请先启动公网隧道或配置固定回调域名');
  }
  // 保存授权时使用的 redirect_uri，token 交换时必须一致
  pendingRedirectUri = redirectUri;
  console.log('[ML OAuth] 授权 URL 使用的 redirect_uri:', redirectUri);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: mlAppId,
    redirect_uri: redirectUri,
    // 显式请求 read / write / offline_access scope（write 用于 M3 合规上架 POST /items）
    scope: 'read write offline_access',
  });

  // PKCE：如果应用启用了 PKCE，授权 URL 必须带 code_challenge，否则会被拒绝
  if (usePkce) {
    pendingCodeVerifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(pendingCodeVerifier);
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
    console.log('[ML OAuth] PKCE 已启用, code_challenge:', challenge.slice(0, 12) + '...');
  } else {
    pendingCodeVerifier = '';
  }

  // CBT 跨境卖家使用独立的 global-selling 授权入口；其余站点用本地站 auth 入口
  const isCbt = (site || '').toUpperCase() === 'CBT';
  const host = isCbt ? 'global-selling.mercadolibre.com' : 'auth.mercadolibre.com.mx';
  console.log(`[ML OAuth] 授权入口: ${host} (site=${site || 'local'})`);
  return `https://${host}/authorization?${params.toString()}`;
}

/**
 * HTTPS POST 请求封装（用于 OAuth2 token 交换）
 */
async function httpsPost(url: string, body: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const postData = new URLSearchParams(body).toString();
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'application/json',
        'User-Agent': getRandomUserAgent(),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`JSON parse error: ${data.slice(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * 用授权码交换 access token
 */
export async function exchangeCodeForToken(code: string, redirectUriOverride?: string): Promise<{
  success: boolean;
  message: string;
  accessToken?: string;
  expiresIn?: number;
}> {
  if (!mlAppId || !mlSecretKey) {
    return { success: false, message: '请先设置 App ID 和 Secret Key' };
  }

  // 优先使用传入的 redirect_uri，其次用授权时保存的，最后用当前生效的
  const redirectUri = redirectUriOverride || pendingRedirectUri || getEffectiveRedirectUri();
  console.log('[ML OAuth] Token 交换参数:');
  console.log('  grant_type: authorization_code');
  console.log('  client_id:', mlAppId);
  console.log('  redirect_uri:', redirectUri);
  console.log('  code:', code.slice(0, 10) + '...');
  console.log('  code_verifier:', pendingCodeVerifier ? '(有, PKCE)' : '(无)');
  console.log('  pendingRedirectUri:', pendingRedirectUri || '(未设置)');
  console.log('  getEffectiveRedirectUri:', getEffectiveRedirectUri());

  try {
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: mlAppId,
      client_secret: mlSecretKey,
      code,
      redirect_uri: redirectUri,
    };
    // PKCE：授权时用了 code_challenge，交换时必须带对应的 code_verifier
    if (pendingCodeVerifier) {
      body.code_verifier = pendingCodeVerifier;
    }

    const data = await httpsPost(`${getApiBase()}/oauth/token`, body);

    if (data.access_token) {
      mlAccessToken = data.access_token;
      mlRefreshToken = data.refresh_token || '';
      mlTokenExpiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
      // 清除 pending 状态
      pendingRedirectUri = '';
      pendingCodeVerifier = '';
      // 持久化
      persistTokenData();

      console.log(`[ML OAuth] Token 获取成功，有效期: ${data.expires_in}s，scope: ${data.scope || 'N/A'}，刷新令牌: ${mlRefreshToken ? '有' : '无'}`);

      return {
        success: true,
        message: `Token 获取成功！有效期 ${Math.floor(data.expires_in / 3600)} 小时，scope: ${data.scope || 'N/A'}`,
        accessToken: data.access_token,
        expiresIn: data.expires_in,
      };
    }

    return { success: false, message: `OAuth 响应异常: ${JSON.stringify(data).slice(0, 300)}` };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[ML OAuth] 交换 token 失败:', msg);
    return { success: false, message: `交换 token 失败: ${msg}` };
  }
}

/**
 * 使用 refresh_token 刷新 access token
 */
export async function refreshAccessToken(): Promise<{
  success: boolean;
  message: string;
  expiresIn?: number;
}> {
  if (!mlRefreshToken) {
    return { success: false, message: '没有 refresh token，请重新授权' };
  }
  if (!mlAppId || !mlSecretKey) {
    return { success: false, message: '请先设置 App ID 和 Secret Key' };
  }

  try {
    const data = await httpsPost(`${getApiBase()}/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: mlAppId,
      client_secret: mlSecretKey,
      refresh_token: mlRefreshToken,
    });

    if (data.access_token) {
      mlAccessToken = data.access_token;
      mlRefreshToken = data.refresh_token || mlRefreshToken;
      mlTokenExpiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
      // 持久化
      persistTokenData();

      console.log(`[ML OAuth] Token 刷新成功，新有效期: ${data.expires_in}s`);

      return {
        success: true,
        message: `Token 刷新成功！新有效期 ${Math.floor(data.expires_in / 3600)} 小时`,
        expiresIn: data.expires_in,
      };
    }

    return { success: false, message: `刷新响应异常: ${JSON.stringify(data).slice(0, 300)}` };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[ML OAuth] 刷新 token 失败:', msg);
    return { success: false, message: `刷新 token 失败: ${msg}` };
  }
}

/**
 * 使用 client_credentials grant type 获取应用级 token（无需用户授权）
 * 适用于访问公开端点（如 /sites/{site_id}/search）时使用
 */
export async function getClientCredentialsToken(): Promise<{
  success: boolean;
  message: string;
  accessToken?: string;
  expiresIn?: number;
  scope?: string;
}> {
  if (!mlAppId || !mlSecretKey) {
    return { success: false, message: '请先设置 App ID 和 Secret Key' };
  }

  try {
    console.log('[ML OAuth] 尝试 client_credentials grant type...');
    const data = await httpsPost(`${getApiBase()}/oauth/token`, {
      grant_type: 'client_credentials',
      client_id: mlAppId,
      client_secret: mlSecretKey,
    });

    if (data.access_token) {
      mlAccessToken = data.access_token;
      // client_credentials 通常不返回 refresh_token
      mlTokenExpiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
      persistTokenData();

      console.log(`[ML OAuth] client_credentials token 获取成功，有效期: ${data.expires_in}s，scope: ${data.scope || 'N/A'}`);

      return {
        success: true,
        message: `应用 Token 获取成功！有效期 ${Math.floor(data.expires_in / 3600)} 小时，scope: ${data.scope || 'N/A'}`,
        accessToken: data.access_token,
        expiresIn: data.expires_in,
        scope: data.scope,
      };
    }

    return { success: false, message: `client_credentials 响应异常: ${JSON.stringify(data).slice(0, 300)}` };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[ML OAuth] client_credentials 获取失败:', msg);
    return { success: false, message: `获取应用 Token 失败: ${msg}` };
  }
}

/**
 * 确保当前有有效 token：过期或缺失时自动续期
 * 1. 若离过期不足 5 分钟且有 refresh_token → 用 refresh_token 刷新
 * 2. 否则用 client_credentials 重新获取（无需用户交互/隧道，经 API 代理即可）
 * 返回 true 表示当前已有可用 token
 */
let tokenRefreshInProgress: Promise<boolean> | null = null;

export async function ensureValidToken(): Promise<boolean> {
  const now = Date.now();
  const SAFETY_MS = 5 * 60 * 1000;
  const hasValid =
    !!mlAccessToken &&
    !!mlTokenExpiry &&
    mlTokenExpiry.getTime() - SAFETY_MS > now;
  if (hasValid) return true;

  // 防止并发重复刷新
  if (tokenRefreshInProgress) return tokenRefreshInProgress;

  tokenRefreshInProgress = (async () => {
    try {
      // 1. 优先 refresh_token（需有 refresh token 且未过期）
      if (mlRefreshToken) {
        const r = await refreshAccessToken();
        if (r.success) {
          console.log('[ML Token] ensureValidToken: refresh_token 续期成功');
          return true;
        }
        console.warn('[ML Token] refresh_token 续期失败，转 client_credentials');
      }
      // 2. client_credentials（应用级，无需用户授权，经 API 代理可达）
      if (mlAppId && mlSecretKey) {
        const r = await getClientCredentialsToken();
        if (r.success) {
          console.log('[ML Token] ensureValidToken: client_credentials 获取成功');
          return true;
        }
        console.error('[ML Token] client_credentials 获取失败:', r.message);
      }
      return false;
    } finally {
      tokenRefreshInProgress = null;
    }
  })();

  return tokenRefreshInProgress;
}

// 防止 HMR / 重复调用导致多个保活定时器
let autoRenewStarted = false;

/**
 * 启动 token 自动续期：
 * - 立即预热一次（若已配置 App ID / Secret Key，会用 client_credentials 自动获取，无需用户授权）
 * - 之后每 30 分钟保活一次，确保常驻进程（如 Render 付费版）token 永不过期
 * - 休眠/重启的场景由 /api/ml/trigger 或 /api/ml/fetch 触发时自动 ensureValidToken 兜底
 * 依赖环境变量 ML_APP_ID / ML_SECRET_KEY 可在磁盘被清空（Render 免费版）后仍自动续期。
 */
export function initAutoRenew() {
  if (autoRenewStarted) return;
  autoRenewStarted = true;

  ensureValidToken()
    .then((ok) => {
      console.log(`[ML Token] 启动预热: ${ok ? '已获取有效 token' : '暂无可用的有效凭证（请配置 App ID / Secret Key，或手动授权）'}`);
    })
    .catch((e) => {
      console.warn('[ML Token] 启动预热异常:', e?.message || e);
    });

  setInterval(() => {
    ensureValidToken()
      .then((ok) => {
        if (!ok) console.warn('[ML Token] 定时保活：未获取到有效 token（需要 App ID / Secret Key）');
      })
      .catch(() => {});
  }, 30 * 60 * 1000);

  console.log('[ML Token] 自动续期已启用（启动预热 + 每 30 分钟保活）');
}

// 启动即探测固定回调域名是否可达（不阻塞启动；store-begin / callback-status 会 await 最终结果）
if (!process.env.ML_REDIRECT_URI) {
  ensureOAuthRedirectResolved()
    .then((r) => console.log(`[ML OAuth] 回调地址解析完成: mode=${r.mode}, uri=${r.uri}`))
    .catch((e) => console.warn('[ML OAuth] 回调地址解析异常:', e?.message || e));
}

// 标记 /search 是否已被确认全局封锁（数据中心 IP 被 ML 封禁）
// 一旦观察到一次 403，后续分类直接跳过 search 各策略、走 highlights 兜底，省去无效重试
let searchConfirmedBlocked = false;
// 触发封锁时所用代理的标识；仅当"当前代理"与该标识一致时才视为仍封锁，
// 这样更换/清除代理后会自动重新尝试 /search（住宅代理可解锁地理封锁）。
let searchBlockedProxy = '';
export interface MLProduct {
  site: string;
  siteName: string;
  categoryId: string;
  categoryName: string;
  rank: number;
  itemId: string;
  title: string;
  price: number;
  currency: string;
  priceUSD: number;
  permalink: string;
  thumbnail: string;
  pictures: string[];        // 商品图片 URL 列表（用于妙手素材包主图）
  soldQuantity: number;
  availableQuantity: number;
  condition: string;
  weight: string;
  height: string;
  width: string;
  length: string;
  sellerName: string;
  sellerLink: string;
  brand: string;
  model: string;
}

// 进度回调
export interface FetchProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
  site?: string;
  category?: string;
  products?: MLProduct[]; // 携带商品数据（phase='product_batch' 时，供前端实时展示表格）
}

type ProgressCallback = (progress: FetchProgress) => void;

// ============ 断点续传 Checkpoint ============
export interface FetchCheckpoint {
  jobId: string;                     // 任务 ID（时间戳）
  startedAt: string;                 // 开始时间 ISO
  sites: MLSiteCode[];               // 用户选择的站点列表
  options: FetchOptions;             // 抓取选项
  completedSites: MLSiteCode[];      // 已完成的站点
  currentSite: MLSiteCode | null;    // 当前正在处理的站点
  completedCategoryIndex: number;    // 当前站点已完成分类索引 (0-based, -1 表示还没开始)
  totalCategories: number;           // 当前站点分类总数
  collectedProducts: MLProduct[];   // 已收集的商品
  siteStats: Record<string, number>; // 各站点统计
  exchangeRates: Record<string, number>; // 汇率缓存
}

const CHECKPOINT_FILE = path.join(__dirname, '..', 'data', 'checkpoint.json');

export function saveCheckpoint(cp: FetchCheckpoint): void {
  try {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Checkpoint] 保存失败:', e);
  }
}

export function loadCheckpoint(): FetchCheckpoint | null {
  try {
    if (!fs.existsSync(CHECKPOINT_FILE)) return null;
    const raw = fs.readFileSync(CHECKPOINT_FILE, 'utf-8');
    return JSON.parse(raw) as FetchCheckpoint;
  } catch {
    return null;
  }
}

export function deleteCheckpoint(): void {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
  } catch { /* 忽略 */ }
}

export { CHECKPOINT_FILE };

// 浏览器风格 User-Agent 列表（轮换使用，避免被限速）
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

let userAgentIndex = 0;

function getRandomUserAgent(): string {
  return USER_AGENTS[userAgentIndex++ % USER_AGENTS.length];
}

/**
 * HTTPS GET 请求封装（带重试和浏览器伪装）
 */
async function httpsGet(url: string, headers: Record<string, string> = {}, maxRetries: number = 3): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7,pt-BR;q=0.6,pt;q=0.5',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site',
            'Referer': 'https://www.mercadolibre.com/',
            'Origin': 'https://www.mercadolibre.com',
            // 如果有 access token，添加认证头
            ...(mlAccessToken ? { 'Authorization': `Bearer ${mlAccessToken}` } : {}),
            ...headers,
          },
          // 如果有代理配置，使用代理
          ...(getProxyAgent() ? { agent: getProxyAgent() } : {}),
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            // 检查 HTTP 状态码
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`JSON parse error: ${data.slice(0, 300)}`));
            }
          });
        });

        req.on('error', reject);
        req.setTimeout(15000, () => {
          req.destroy();
          reject(new Error(`Request timeout: ${url}`));
        });
        req.end();
      });

      return result;
    } catch (err: any) {
      lastError = err;
      const errMsg = err?.message || String(err);

      // 429 错误时增加延迟后重试
      if (errMsg.includes('429')) {
        const delay = (attempt + 1) * 3000 + Math.random() * 1000; // 3s, 6s, 9s + 随机
        console.warn(`[ML HTTP] 429 限速 (尝试 ${attempt + 1}/${maxRetries}): ${errMsg.slice(0, 100)}，${(delay / 1000).toFixed(1)}s 后重试...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // 403: 如果有代理，可能是间歇性封锁，重试一次
      if (errMsg.includes('403') && getProxyAgent() && attempt < 1) {
        console.warn(`[ML HTTP] 403 (代理模式，重试 ${attempt + 1}/${maxRetries}): ${errMsg.slice(0, 100)}，2s 后重试...`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      // 403 无代理或已重试过，直接抛出
      if (errMsg.includes('403')) {
        throw err;
      }

      // 其他错误直接抛出
      throw err;
    }
  }

  throw lastError || new Error('未知请求错误');
}

/**
 * 获取汇率 (本地货币 -> USD)
 */
export async function getExchangeRate(fromCurrency: string): Promise<number> {
  if (fromCurrency === 'USD') return 1;
  try {
    const data = await httpsGet(`${getApiBase()}/currency_conversions/search?from=${fromCurrency}&to=USD`);
    if (data && data.ratio) {
      return parseFloat(data.ratio);
    }
  } catch (err) {
    console.error(`[ML] 获取汇率失败 ${fromCurrency}:`, err);
  }
  // 回退汇率
  const fallback: Record<string, number> = {
    MXN: 0.055,  // 1 MXN ≈ 0.055 USD
    BRL: 0.19,   // 1 BRL ≈ 0.19 USD
    CLP: 0.00105, // 1 CLP ≈ 0.00105 USD
    COP: 0.00026, // 1 COP ≈ 0.00026 USD
    CNY: 0.14,   // 1 CNY ≈ 0.14 USD（约值，仅作回退；实时取汇率时优先走 ML 接口）
  };
  return fallback[fromCurrency] || 1;
}

// 墨西哥(MLM)主要分类（当 API 403 时使用）
const FALLBACK_CATEGORIES_MLM: Array<{ id: string; name: string }> = [
  { id: 'MLM1648', name: 'Celulares y Smartphones' },
  { id: 'MLM1051', name: 'Celulares y Telefonía' },
  { id: 'MLM1039', name: 'Cámaras y Accesorios' },
  { id: 'MLM1649', name: 'Computación' },
  { id: 'MLM1144', name: 'Consolas y Videojuegos' },
  { id: 'MLM1000', name: 'Electrónica, Audio y Video' },
  { id: 'MLM1574', name: 'Hogar, Muebles y Jardín' },
  { id: 'MLM1499', name: 'Industrias y Oficinas' },
  { id: 'MLM1276', name: 'Juegos y Juguetes' },
  { id: 'MLM5726', name: 'Ropa, Bolsas y Calzado' },
  { id: 'MLM1403', name: 'Alimentos y Bebidas' },
  { id: 'MLM1071', name: 'Animales y Mascotas' },
  { id: 'MLM1367', name: 'Antigüedades y Colecciones' },
  { id: 'MLM1368', name: 'Arte, Librería y Mercería' },
  { id: 'MLM1384', name: 'Bebés' },
  { id: 'MLM1246', name: 'Belleza y Cuidado Personal' },
  { id: 'MLM1039', name: 'Cámaras Digitales' },
  { id: 'MLM1182', name: 'Electrodomésticos' },
  { id: 'MLM3937', name: 'Electrónica, Audio y Video' },
  { id: 'MLM1132', name: 'Herramientas' },
  { id: 'MLM3025', name: 'Salud y Equipamiento Médico' },
  { id: 'MLM1540', name: 'Servicios' },
  { id: 'MLM1953', name: 'Otras categorías' },
];

// 巴西(MLB)主要分类
const FALLBACK_CATEGORIES_MLB: Array<{ id: string; name: string }> = [
  { id: 'MLB1051', name: 'Celulares e Telefones' },
  { id: 'MLB1648', name: 'Celulares e Smartphones' },
  { id: 'MLB1649', name: 'Computação' },
  { id: 'MLB1144', name: 'Videogames' },
  { id: 'MLB1000', name: 'Eletrônicos, Áudio e Vídeo' },
  { id: 'MLM1574', name: 'Casa, Móveis e Jardim' },
  { id: 'MLB5726', name: 'Roupas, Bolsas e Calçados' },
  { id: 'MLB1246', name: 'Beleza e Cuidado Pessoal' },
  { id: 'MLB1182', name: 'Eletrodomésticos' },
  { id: 'MLB1276', name: 'Brinquedos e Hobbies' },
  { id: 'MLB1499', name: 'Indústria e Escritório' },
  { id: 'MLB1132', name: 'Ferramentas' },
  { id: 'MLB1367', name: 'Antiguidades e Coleções' },
  { id: 'MLB1368', name: 'Arte, Papelaria e Armarinho' },
  { id: 'MLB1384', name: 'Bebês' },
  { id: 'MLB1403', name: 'Alimentos e Bebidas' },
  { id: 'MLB1071', name: 'Animais e Mascotes' },
  { id: 'MLB3025', name: 'Saúde' },
  { id: 'MLB181763', name: 'Agro' },
  { id: 'MLB1168', name: 'Música' },
  { id: 'MLB1540', name: 'Serviços' },
  { id: 'MLB1953', name: 'Outras Categorias' },
];

// 智利(MLC)主要分类
const FALLBACK_CATEGORIES_MLC: Array<{ id: string; name: string }> = [
  { id: 'MLC1747', name: 'Accesorios para Vehículos' },
  { id: 'MLC1512', name: 'Agro' },
  { id: 'MLC1403', name: 'Alimentos y Bebidas' },
  { id: 'MLC1071', name: 'Animales y Mascotas' },
  { id: 'MLC1367', name: 'Antigüedades y Colecciones' },
  { id: 'MLC1368', name: 'Arte, Librería y Cordonería' },
  { id: 'MLC1384', name: 'Bebés' },
  { id: 'MLC1246', name: 'Belleza y Cuidado Personal' },
  { id: 'MLC1039', name: 'Cámaras y Accesorios' },
  { id: 'MLC1051', name: 'Celulares y Telefonía' },
  { id: 'MLC1648', name: 'Computación' },
  { id: 'MLC1144', name: 'Consolas y Videojuegos' },
  { id: 'MLC1500', name: 'Construcción' },
  { id: 'MLC1276', name: 'Deportes y Fitness' },
  { id: 'MLC5726', name: 'Electrodomésticos' },
  { id: 'MLC1000', name: 'Electrónica, Audio y Video' },
  { id: 'MLC178483', name: 'Herramientas' },
  { id: 'MLC1574', name: 'Hogar y Muebles' },
  { id: 'MLC1499', name: 'Industrias y Oficinas' },
  { id: 'MLC1182', name: 'Instrumentos Musicales' },
  { id: 'MLC1132', name: 'Juegos y Juguetes' },
  { id: 'MLC3025', name: 'Libros, Revistas y Comics' },
  { id: 'MLC1168', name: 'Música y Películas' },
  { id: 'MLC3937', name: 'Relojes y Joyas' },
  { id: 'MLC409431', name: 'Salud y Equipamiento Médico' },
  { id: 'MLC1430', name: 'Vestuario y Calzado' },
];

// 哥伦比亚(MCO)主要分类
const FALLBACK_CATEGORIES_MCO: Array<{ id: string; name: string }> = [
  { id: 'MCO1747', name: 'Accesorios para Vehículos' },
  { id: 'MCO441917', name: 'Agro' },
  { id: 'MCO1403', name: 'Alimentos y Bebidas' },
  { id: 'MCO1071', name: 'Animales y Mascotas' },
  { id: 'MCO1367', name: 'Antigüedades y Colecciones' },
  { id: 'MCO1368', name: 'Arte, Papelería y Mercería' },
  { id: 'MCO1384', name: 'Bebés' },
  { id: 'MCO1246', name: 'Belleza y Cuidado Personal' },
  { id: 'MCO1039', name: 'Cámaras y Accesorios' },
  { id: 'MCO1743', name: 'Carros, Motos y Otros' },
  { id: 'MCO1051', name: 'Celulares y Teléfonos' },
  { id: 'MCO1648', name: 'Computación' },
  { id: 'MCO1144', name: 'Consolas y Videojuegos' },
  { id: 'MCO1276', name: 'Deportes y Fitness' },
  { id: 'MCO5726', name: 'Electrodomésticos' },
  { id: 'MCO1000', name: 'Electrónica, Audio y Video' },
  { id: 'MCO175794', name: 'Herramientas' },
  { id: 'MCO1574', name: 'Hogar y Muebles' },
  { id: 'MCO1499', name: 'Industrias y Oficinas' },
  { id: 'MCO1182', name: 'Instrumentos Musicales' },
  { id: 'MCO1132', name: 'Juegos y Juguetes' },
  { id: 'MCO3025', name: 'Libros, Revistas y Comics' },
  { id: 'MCO1168', name: 'Música, Películas y Series' },
  { id: 'MCO3937', name: 'Relojes y Joyas' },
  { id: 'MCO1430', name: 'Ropa y Accesorios' },
  { id: 'MCO180800', name: 'Salud y Equipamiento Médico' },
];

const FALLBACK_CATEGORIES = {
  MLM: FALLBACK_CATEGORIES_MLM,
  MLB: FALLBACK_CATEGORIES_MLB,
  MLC: FALLBACK_CATEGORIES_MLC,
  MCO: FALLBACK_CATEGORIES_MCO,
};

/**
 * HTTPS GET 请求 — 获取原始文本（用于网页抓取）
 */
async function httpsGetRaw(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7,pt-BR;q=0.6,pt;q=0.5',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        resolve(data);
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error(`Request timeout: ${url}`));
    });
    req.end();
  });
}

/**
 * 从 ML 网站搜索页面提取商品数据（备选方案）
 * 当官方 API 返回 403 时使用
 */
async function searchProductsViaWebsite(
  siteId: string,
  categoryId: string,
  limit: number = 50,
  offset: number = 0
): Promise<any[]> {
  const siteDomain = siteId === 'MLM' ? 'listado.mercadolibre.com.mx' : 'lista.mercadolivre.com.br';
  // ML 网站搜索 URL 格式: https://listado.mercadolibre.com.mx/_CategoryId_categoryId
  // 支持分页: &_Desde_{offset}
  const page = offset > 0 ? `_Desde_${offset}` : '';
  const url = `https://${siteDomain}/${page}#D[C:${categoryId}]`;

  console.log(`[ML Website] 尝试从网站获取: ${url}`);
  const html = await httpsGetRaw(url);

  // 从 HTML 中提取 __PRELOADED_STATE__ JSON
  const stateMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!stateMatch) {
    // 尝试另一种格式: initialState
    const initialMatch = html.match(/"initialState":\s*(\{[\s\S]*?\})\s*,\s*"/);
    if (!initialMatch) {
      throw new Error('无法从网页提取搜索结果数据');
    }
  }

  try {
    const stateJson = stateMatch[1];
    const state = JSON.parse(stateJson);

    // 导航到搜索结果
    const results = state?.initialState?.searchResult?.itemList?.elements ||
                    state?.initialState?.components?.searchResult?.elements ||
                    state?.searchResult?.itemList?.elements ||
                    [];

    return results.slice(0, limit).map((item: any) => ({
      id: item.id || item.item_id || '',
      title: item.title || item.item_title || '',
      price: parseFloat(item.price?.value || item.price?.amount || item.price || 0),
      currency_id: item.price?.currency_id || item.currency_id || (siteId === 'MLM' ? 'MXN' : 'BRL'),
      permalink: item.permalink || item.url || `https://${siteDomain}/item?id=${item.id}`,
      thumbnail: item.picture?.url || item.thumbnail || '',
      sold_quantity: item.sold_quantity || 0,
      available_quantity: item.available_quantity || 0,
      condition: item.condition || '',
      seller: item.seller ? {
        nickname: item.seller.nickname || '',
        permalink: item.seller.permalink || '',
      } : null,
      attributes: item.attributes || [],
    }));
  } catch (parseErr) {
    throw new Error(`解析网页搜索结果失败: ${parseErr}`);
  }
}

/**
 * 获取站点所有分类
 * 策略1: 通过官方 API 获取
 * 策略2: 如果 API 403，使用硬编码的主要分类列表
 */
export async function getCategories(siteId: string): Promise<Array<{ id: string; name: string }>> {
  await ensureValidToken();
  try {
    const url = mlAccessToken
      ? `${getApiBase()}/sites/${siteId}/categories?access_token=${encodeURIComponent(mlAccessToken)}`
      : `${getApiBase()}/sites/${siteId}/categories`;
    const data = await httpsGet(url);
    if (Array.isArray(data) && data.length > 0) {
      return data.map((cat: any) => ({ id: cat.id, name: cat.name }));
    }
    throw new Error('API 返回空数据');
  } catch (err: any) {
    console.warn(`[ML] 官方 API 获取分类失败 (${siteId})，使用硬编码分类: ${err.message?.slice(0, 100)}`);
    // 回退到硬编码的主要分类
    const fallback = FALLBACK_CATEGORIES[siteId as keyof typeof FALLBACK_CATEGORIES];
    if (fallback) {
      console.log(`[ML] 使用 ${fallback.length} 个硬编码分类 (${siteId})`);
      return fallback;
    }
    throw new Error(`获取分类失败且无回退数据: ${err.message}`);
  }
}

/** 类目属性值选项 */
export interface CategoryAttributeValue {
  id: string;
  name: string;
}

/** 类目属性定义 */
export interface CategoryAttribute {
  id: string;
  name: string;
  required: boolean;
  value_type: string;
  values?: CategoryAttributeValue[];
  tags?: Record<string, any>;
  hint?: string;
}

/**
 * 获取类目的属性定义（含必填项）。
 * ML 官方端点：GET /categories/{category_id}/attributes
 */
export async function getCategoryAttributes(categoryId: string): Promise<CategoryAttribute[]> {
  await ensureValidToken();
  try {
    const url = mlAccessToken
      ? `${getApiBase()}/categories/${categoryId}/attributes?access_token=${encodeURIComponent(mlAccessToken)}`
      : `${getApiBase()}/categories/${categoryId}/attributes`;
    const data = await httpsGet(url);
    if (Array.isArray(data)) {
      return data.map((a: any) => ({
        id: a.id,
        name: a.name,
        required: !!a.required,
        value_type: a.value_type || 'string',
        values: (a.values || []).map((v: any) => ({ id: v.id, name: v.name })),
        tags: a.tags || {},
        hint: a.hint || '',
      }));
    }
    throw new Error('API 返回空数据');
  } catch (err: any) {
    console.warn(`[ML] 获取类目属性失败 (${categoryId}): ${err.message?.slice(0, 100)}`);
    return [];
  }
}

/**
 * 获取类目全路径（path_from_root）。
 * 官方端点：GET /categories/{category_id} 返回 { id, name, path_from_root: [{id,name}...] }
 */
export async function getCategory(categoryId: string): Promise<{ id: string; name: string; path_from_root: Array<{ id: string; name: string }> } | null> {
  await ensureValidToken();
  try {
    const data = await httpsGet(`${getApiBase()}/categories/${encodeURIComponent(categoryId)}`);
    if (!data || !data.id) return null;
    return {
      id: data.id,
      name: data.name,
      path_from_root: Array.isArray(data.path_from_root) ? data.path_from_root : [],
    };
  } catch (err: any) {
    console.warn(`[ML] 获取类目全路径失败 (${categoryId}): ${err?.message?.slice(0, 100)}`);
    return null;
  }
}

/**
 * 站点类目森林缓存：顶级类目 + 其直接子类目，按站点缓存 24h。
 * 说明：当前应用凭证下 /sites/{site}/categories/search 与 /category_predictor/* 均返回 404，
 * 因此类目搜索与「类目推荐」改为基于本地类目森林做匹配。
 */
interface CategoryNode {
  id: string;
  name: string;
  children: CategoryNode[];
}
const categoryForestCache = new Map<string, { forest: CategoryNode[]; at: number }>();
const CATEGORY_FOREST_TTL = 24 * 3600 * 1000;

async function getCategoryForest(siteId: string): Promise<CategoryNode[]> {
  const cached = categoryForestCache.get(siteId);
  if (cached && Date.now() - cached.at < CATEGORY_FOREST_TTL) return cached.forest;
  const top: any[] = await httpsGet(`${getApiBase()}/sites/${siteId}/categories`);
  if (!Array.isArray(top) || top.length === 0) return [];
  // 有界并发（6）拉取每个顶级类目的子类目，避免触发 ML 限流
  const CONCURRENCY = 6;
  const forest: CategoryNode[] = [];
  for (let i = 0; i < top.length; i += CONCURRENCY) {
    const batch = top.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (c: any) => {
        try {
          const detail: any = await httpsGet(`${getApiBase()}/categories/${encodeURIComponent(c.id)}`);
          const children = Array.isArray(detail?.children_categories)
            ? detail.children_categories.map((x: any) => ({ id: x.id, name: x.name, children: [] }))
            : [];
          return { id: c.id, name: c.name, children };
        } catch {
          return { id: c.id, name: c.name, children: [] };
        }
      })
    );
    forest.push(...results);
  }
  categoryForestCache.set(siteId, { forest, at: Date.now() });
  return forest;
}

function flattenForest(forest: CategoryNode[]): Array<{ id: string; name: string; parentName?: string }> {
  const out: Array<{ id: string; name: string; parentName?: string }> = [];
  for (const node of forest) {
    out.push({ id: node.id, name: node.name });
    for (const ch of node.children) out.push({ id: ch.id, name: ch.name, parentName: node.name });
  }
  return out;
}

function labelWithParent(name: string, parentName?: string): string {
  return parentName ? `${name}（${parentName}）` : name;
}

/**
 * 关键词搜索类目（类目选择器用的模糊搜索）。基于站点类目森林做名称子串匹配（顶级 + 直接子类目）。
 */
export async function searchCategories(siteId: string, query: string): Promise<Array<{ id: string; name: string }>> {
  await ensureValidToken();
  try {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    const flat = flattenForest(await getCategoryForest(siteId));
    const seen = new Set<string>();
    const result: Array<{ id: string; name: string }> = [];
    for (const c of flat) {
      if (seen.has(c.id)) continue;
      if (c.name.toLowerCase().includes(q)) {
        seen.add(c.id);
        result.push({ id: c.id, name: labelWithParent(c.name, c.parentName) });
      }
    }
    return result.slice(0, 30);
  } catch (err: any) {
    console.warn(`[ML] 类目搜索失败 (${siteId} q=${query}): ${err?.message?.slice(0, 100)}`);
    return [];
  }
}

/**
 * 类目推荐（根据标题预测最合适的类目，类似妙手的类目推荐）。
 * 官方预测接口在当前凭证下不可用，改为基于标题词与类目森林名称做相关性打分。
 */
export async function predictCategory(siteId: string, title: string): Promise<Array<{ id: string; name: string }>> {
  await ensureValidToken();
  try {
    const t = (title || '').toLowerCase();
    if (!t) return [];
    const STOP = new Set(['para', 'con', 'and', 'the', 'for', 'de', 'del', 'los', 'las', 'uno', 'una', 'por', 'en']);
    const tokens = Array.from(
      new Set(t.split(/[^a-z0-9áéíóúñü]+/i).filter((w) => w.length >= 3 && !STOP.has(w)))
    );
    const flat = flattenForest(await getCategoryForest(siteId));
    const scored: Array<{ id: string; name: string; score: number }> = [];
    for (const c of flat) {
      const name = c.name.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (name.includes(tok)) score += tok.length >= 4 ? 2 : 1;
      }
      if (c.parentName && score > 0) score += 0.5; // 子类目更具体，权重略高
      if (score > 0) scored.push({ id: c.id, name: labelWithParent(c.name, c.parentName), score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => ({ id: s.id, name: s.name }));
  } catch (err: any) {
    console.warn(`[ML] 类目推荐失败 (${siteId} title=${title?.slice(0, 30)}): ${err?.message?.slice(0, 100)}`);
    return [];
  }
}

/**
 * 搜索品类下的商品 (按销量排序)
 * 策略1: 官方 API + Bearer token (category only)
 * 策略1b: 如果 403，尝试添加 q 参数（某些 ML 端点要求 q）
 * 策略2: 官方 API + access_token 查询参数
 * 策略3: ML 网站搜索页面抓取
 */
export async function searchProductsByCategory(
  siteId: string,
  categoryId: string,
  limit: number = 50,
  offset: number = 0,
  accessTokenOverride?: string
): Promise<any[]> {
  // 若传入店铺 token，则用它做鉴权（可自动刷新，免去手动维护全局 token）
  const authH = accessTokenOverride ? { Authorization: `Bearer ${accessTokenOverride}` } : {};
  // 有覆盖 token 时，不要因单次 403 就判死整轮 /search（403 更可能是 token/scope 问题，由上层重试）
  const allowBlockFlag = !accessTokenOverride;
  // 若已确认 /search 被封锁，先判断是否因"当前代理"而封锁：
  // 仅当触发封锁时的代理与当前代理一致时，才跳过 search（避免无代理时反复 403）；
  // 一旦更换/清除代理（searchBlockedProxy 不匹配），重置标记，重新尝试 search。
  const curProxy = mlProxyUrl || '';
  if (searchConfirmedBlocked && searchBlockedProxy !== curProxy) {
    searchConfirmedBlocked = false;
    console.log(`[ML Search] 代理已变化（${curProxy ? '已配置' : '已清除'}），重置 /search 封锁标记，重新尝试`);
  }
  if (searchConfirmedBlocked) return [];

  // 策略1: 官方 API + Bearer token (httpsGet 自动添加 Authorization header)
  const apiUrl = `${getApiBase()}/sites/${siteId}/search?category=${categoryId}&limit=${limit}&offset=${offset}`;
  try {
    const data = await httpsGet(apiUrl, authH);
    if (data?.results && data.results.length > 0) {
      return data.results;
    }
    // 200 但无结果，直接返回
    if (data?.results && data.results.length === 0) {
      console.log(`[ML Search] 策略1返回0结果 (${categoryId})`);
      return [];
    }
  } catch (err1: any) {
    const err1Msg = err1.message?.slice(0, 120) || '';
    console.warn(`[ML Search] 策略1失败 (${categoryId}): ${err1Msg}`);

    // 如果是 429 限速，等待更长时间后重试策略1
    if (err1Msg.includes('429')) {
      console.log(`[ML Search] 429 限速，等待 5 秒后重试策略1 (${categoryId})...`);
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const data = await httpsGet(apiUrl, authH);
        if (data?.results && data.results.length > 0) {
          console.log(`[ML Search] 策略1重试成功 (${categoryId})`);
          return data.results;
        }
      } catch (retryErr: any) {
        console.warn(`[ML Search] 策略1重试也失败 (${categoryId}): ${retryErr.message?.slice(0, 80)}`);
        return [];
      }
    }

    // 策略1b: 如果 403，尝试添加 q 参数（某些 ML 端点可能要求 q 参数）
    if (err1Msg.includes('403') && mlAccessToken && allowBlockFlag) {
      // 确认 /search 被全局封锁，后续分类跳过 search 直接走兜底
      searchConfirmedBlocked = true;
      searchBlockedProxy = mlProxyUrl || '';
      console.log(`[ML Search] 403 错误，确认 /search 被全局封锁（代理: ${mlProxyUrl ? '已配置' : '无'}），后续分类将直接走 highlights 兜底 (${categoryId})`);
      console.log(`[ML Search] 尝试策略1b: 添加 q 参数 (${categoryId})...`);
      await new Promise((r) => setTimeout(r, 1000));
      try {
        // 使用通用搜索词 + category 过滤
        const apiUrlWithQ = `${getApiBase()}/sites/${siteId}/search?q=${encodeURIComponent(' ')}&category=${categoryId}&limit=${limit}&offset=${offset}`;
        const data1b = await httpsGet(apiUrlWithQ, authH);
        if (data1b?.results && data1b.results.length > 0) {
          console.log(`[ML Search] 策略1b(q参数)成功 (${categoryId}): ${data1b.results.length} 个结果`);
          return data1b.results;
        }
      } catch (err1b: any) {
        console.warn(`[ML Search] 策略1b失败 (${categoryId}): ${err1b.message?.slice(0, 80)}`);
      }
    }

    // 策略2: 官方 API + access_token 作为查询参数（仅在非 429 错误时尝试）
    const effToken = accessTokenOverride || mlAccessToken;
    if (effToken && !err1Msg.includes('429')) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const urlWithToken = `${apiUrl}&access_token=${encodeURIComponent(effToken)}`;
        const data2 = await httpsGet(urlWithToken, authH);
        if (data2?.results && data2.results.length > 0) {
          console.log(`[ML Search] 策略2成功 (${categoryId})`);
          return data2.results;
        }
      } catch (err2: any) {
        const err2Msg = err2.message?.slice(0, 80) || '';
        console.warn(`[ML Search] 策略2失败 (${categoryId}): ${err2Msg}`);

        // 策略2b: 如果策略2也 403，尝试加 q 参数
        if (err2Msg.includes('403')) {
          console.log(`[ML Search] 策略2也403，尝试策略2b: q+token (${categoryId})...`);
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const urlWithQToken = `${getApiBase()}/sites/${siteId}/search?q=${encodeURIComponent(' ')}&category=${categoryId}&limit=${limit}&offset=${offset}&access_token=${encodeURIComponent(effToken)}`;
            const data2b = await httpsGet(urlWithQToken, authH);
            if (data2b?.results && data2b.results.length > 0) {
              console.log(`[ML Search] 策略2b成功 (${categoryId}): ${data2b.results.length} 个结果`);
              return data2b.results;
            }
          } catch (err2b: any) {
            console.warn(`[ML Search] 策略2b失败 (${categoryId}): ${err2b.message?.slice(0, 80)}`);
          }
        }
      }
    }

    // 策略3: ML 网站搜索页面抓取
    try {
      const webResults = await searchProductsViaWebsite(siteId, categoryId, limit, offset);
      if (webResults.length > 0) {
        console.log(`[ML Search] 策略3(网站)成功 (${categoryId}): ${webResults.length} 个结果`);
        return webResults;
      }
    } catch (err3: any) {
      console.warn(`[ML Search] 策略3失败 (${categoryId}): ${err3.message?.slice(0, 80)}`);
    }

    // 所有策略都失败
    console.error(`[ML Search] 所有策略均失败 (${categoryId})`);
    return [];
  }

  return [];
}

/**
 * 按关键词搜索（趋势词扫描模式用）。
 * 复用 searchProductsByCategory 的底层策略链（官方 API → q 参数 → token → 网站抓取），
 * 仅把 category 过滤换成 q=keyword 自由文本查询。
 */
export async function searchProductsByQuery(
  siteId: string,
  query: string,
  limit: number = 20,
  offset: number = 0,
  accessTokenOverride?: string
): Promise<any[]> {
  const authH = accessTokenOverride ? { Authorization: `Bearer ${accessTokenOverride}` } : {};
  const apiUrl = `${getApiBase()}/sites/${siteId}/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
  try {
    const data = await httpsGet(apiUrl, authH);
    if (data?.results && data.results.length > 0) return data.results;
    // 无结果也尝试策略1b（加 category 空过滤有时能绕过部分 403）
    return [];
  } catch (err1: any) {
    const err1Msg = err1.message?.slice(0, 120) || '';
    console.warn(`[ML Search] 关键词搜索失败 (${query}): ${err1Msg}`);
    if (err1Msg.includes('403') && mlAccessToken) {
      const effToken = accessTokenOverride || mlAccessToken;
      try {
        const urlWithToken = `${getApiBase()}/sites/${siteId}/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&access_token=${encodeURIComponent(effToken)}`;
        const data2 = await httpsGet(urlWithToken, authH);
        if (data2?.results && data2.results.length > 0) return data2.results;
      } catch (e2: any) {
        console.warn(`[ML Search] 关键词搜索(token)失败 (${query}): ${e2.message?.slice(0, 80)}`);
      }
      // 回退网站抓取（按关键词构造 ML 网站搜索 URL）
      try {
        const siteDomain = siteId === 'MLM' ? 'listado.mercadolibre.com.mx' : 'lista.mercadolivre.com.br';
        const webUrl = `https://${siteDomain}/${encodeURIComponent(query)}`;
        const html = await httpsGetRaw(webUrl);
        const stateMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
        if (stateMatch) {
          const state = JSON.parse(stateMatch[1]);
          const results = state?.initialState?.results?.results ?? state?.components?.results?.results ?? [];
          if (Array.isArray(results) && results.length) {
            return results.map((r: any) => ({
              id: r.id,
              title: r.title,
              price: r.price?.offer?.price ?? r.price?.amount ?? 0,
              currency_id: r.price?.currency_id ?? (siteId === 'MLM' ? 'MXN' : 'BRL'),
              sold_quantity: r.sold_quantity ?? 0,
              available_quantity: r.available_quantity ?? 0,
              category_id: r.category_id ?? '',
              permalink: r.permalink ?? '',
              thumbnail: r.thumbnail ?? '',
              seller: r.seller ?? {},
              condition: r.condition ?? 'new',
              start_time: r.start_time ?? new Date(Date.now() - 7 * 864e5).toISOString(),
            }));
          }
        }
      } catch (e3: any) {
        console.warn(`[ML Search] 关键词搜索(网站)失败 (${query}): ${e3.message?.slice(0, 80)}`);
      }
    }
    return [];
  }
}

/**
 * 带 highlights 兜底的搜索。
 * 当官方 /search 被云服务器 IP 封锁（403）时，回退到 /highlights 品类 Best Sellers
 * （服务器 IP 可访问），返回与 /search results 同构的 item 数组，并在每条上标记
 * `_fromHighlights`，供上层选品 scanner 放宽「近30天新品」时间门槛（热门≠新品）。
 */
export async function searchWithHighlightsFallback(
  siteId: string,
  categoryId: string,
  limit: number = 50,
  offset: number = 0,
  accessTokenOverride?: string
): Promise<{ items: any[]; fromHighlights: boolean }> {
  const search = await searchProductsByCategory(siteId, categoryId, limit, offset, accessTokenOverride);
  if (search.length) return { items: search, fromHighlights: false };

  // /search 被封锁 → 用 Best Sellers 兜底（热门商品，服务器 IP 可访问 /highlights）
  console.log(`[ML Search] /search 无结果(${categoryId})，回退 highlights 兜底`);
  try {
    const highlights = await fetchHighlightsByCategory(siteId, categoryId);
    const productIds = highlights
      .filter((h: any) => h.type === 'PRODUCT' || h.type === 'ITEM')
      .slice(0, Math.min(limit, 15))
      .map((h: any) => h.id);
    const items: any[] = [];
    const baseDelay = 300;
    for (let i = 0; i < productIds.length; i++) {
      const productId = productIds[i];
      try {
        // /products/{id}/items 常缺失 title/thumbnail/pictures，先取 product 详情兜底。
        const productDetail = await fetchProductDetails(productId, accessTokenOverride);
        const productItems = await fetchProductItems(productId, 5, accessTokenOverride);
        for (const it of productItems) {
          // /products/{id}/items 返回的 item 字段名与 /search results 不完全一致：
          // 常见有 item_id 无 id、name 无 title、无 sold_quantity 等。先做同构映射。
          if (!it.id && it.item_id) it.id = it.item_id;
          if (!it.title && it.name) it.title = it.name;
          if (!it.title && it.family_name) it.title = it.family_name;
          // 用 product 详情补标题/图片（highlights 场景下 item 自身常缺）
          if (!it.title && productDetail?.name) it.title = productDetail.name;
          if (!it.title && productDetail?.family_name) it.title = productDetail.family_name;
          if (!it.thumbnail && productDetail?.pictures?.[0]) {
            it.thumbnail = productDetail.pictures[0].url || productDetail.pictures[0].secure_url;
          }
          if (!it.pictures && productDetail?.pictures) it.pictures = productDetail.pictures;
          if (!it.sold_quantity && it.sold_quantity === undefined && it.sold) it.sold_quantity = it.sold;
          // highlights 货源缺上架时间则近似为近 7 天（热门≈近期热销），避免被时间过滤清掉
          if (!it.start_time && !it.date_created) {
            it.start_time = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          }
          // 补上 category_id，否则 normalizeItem 无法识别分类
          if (!it.category_id) it.category_id = categoryId;
          // price/sold 直接来自 /products/{id}/items（数据中心 IP 可访问，返回 price/shipping/seller），
          // 不再回退 /items/{id}（云服务器 IP 下 403 被封，且 productItems 已含所需字段）。
          const enriched = it;
          items.push({ ...enriched, _fromHighlights: true });
        }
      } catch {
        /* 单个 product 失败忽略 */
      }
      if (i < productIds.length - 1) await new Promise((r) => setTimeout(r, baseDelay));
    }
    return { items, fromHighlights: true };
  } catch (e: any) {
    console.warn(`[ML Search] highlights 兜底失败 (${categoryId}): ${e?.message?.slice(0, 80)}`);
    return { items: [], fromHighlights: true };
  }
}

/**
 * 通过 /items/{id} 公开端点获取 marketplace item 详情（含价格、卖家、物流等）。
 * /products/{id}/items 返回的 item 常常缺失 price 字段，用此端点补充。
 */
export async function fetchItemDetails(itemId: string, accessTokenOverride?: string): Promise<any | null> {
  if (!itemId) return null;
  const authH = accessTokenOverride ? { Authorization: `Bearer ${accessTokenOverride}` } : {};
  try {
    return await httpsGet(`${getApiBase()}/items/${itemId}`, authH);
  } catch (err: any) {
    console.warn(`[ML Items] 获取 item 详情失败 ${itemId}: ${err?.message?.slice(0, 80)}`);
    return null;
  }
}

/**
 * 获取站点 web 域名
 */
function getSiteDomain(siteId: string): string {
  return siteId === 'MLM' ? 'mercadolibre.com.mx' : 'mercadolivre.com.br';
}

/**
 * 构造 catalog product 的固定链接
 */
function getProductPermalink(siteId: string, productId: string): string {
  const prefix = siteId === 'MLM' ? 'https://www.mercadolibre.com.mx/p/' : 'https://www.mercadolivre.com.br/p/';
  return `${prefix}${productId}`;
}

/**
 * 获取品类 Best Sellers（销量排行）产品 ID 列表
 * 这是 /search 被封锁时的主要替代数据源
 */
export async function fetchHighlightsByCategory(siteId: string, categoryId: string): Promise<Array<{ id: string; position: number; type: string }>> {
  const url = `${getApiBase()}/highlights/${siteId}/category/${categoryId}`;
  console.log(`[ML Highlights] 获取品类 Best Sellers: ${siteId}/${categoryId}`);
  const data = await httpsGet(url);
  if (!data?.content || !Array.isArray(data.content)) {
    throw new Error('Highlights 返回数据格式异常');
  }
  return data.content.map((item: any) => ({
    id: item.id || '',
    position: item.position || 0,
    type: item.type || '',
  })).filter((item: any) => item.id);
}

/**
 * 获取 catalog product 详情（标题、图片、属性含重量/尺寸）
 * 对瞬时 403 做有限重试，避免个别请求抖动导致整行缺失
 */
export async function fetchProductDetails(productId: string, accessTokenOverride?: string): Promise<any> {
  const authH = accessTokenOverride ? { Authorization: `Bearer ${accessTokenOverride}` } : {};
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await httpsGet(`${getApiBase()}/products/${productId}`, authH);
    } catch (err: any) {
      lastErr = err;
      const msg = err?.message || String(err);
      // 仅对瞬时 403/429 重试，持续 403（如 USER_PRODUCT）直接放弃
      if (msg.includes('403')) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  if (lastErr) console.warn(`[ML Products] 获取 product 详情失败 ${productId}: ${lastErr.message?.slice(0, 80)}`);
  return null;
}

/**
 * 获取 catalog product 下的 marketplace items（价格、卖家、物流等）
 */
export async function fetchProductItems(productId: string, limit: number = 10, accessTokenOverride?: string): Promise<any[]> {
  const authH = accessTokenOverride ? { Authorization: `Bearer ${accessTokenOverride}` } : {};
  try {
    const data = await httpsGet(`${getApiBase()}/products/${productId}/items?limit=${limit}`, authH);
    return data?.results || [];
  } catch (err: any) {
    console.warn(`[ML Products] 获取 product items 失败 ${productId}: ${err.message?.slice(0, 80)}`);
    return [];
  }
}

/**
 * 获取卖家信息（昵称 + 国家 id，用于跨境/本土判定）
 * best-effort，失败不影响主流程
 */
interface SellerInfo { nickname: string; countryId: string; }
async function fetchSellerInfo(sellerId: string | number): Promise<SellerInfo> {
  try {
    const data = await httpsGet(`${getApiBase()}/users/${sellerId}`);
    return { nickname: data?.nickname || String(sellerId), countryId: data?.country_id || '' };
  } catch {
    return { nickname: String(sellerId), countryId: '' };
  }
}

/**
 * 使用 Best Sellers（/highlights）作为 /search 被封锁时的兜底方案
 * 每个分类返回官方销量前 20 的 catalog products
 */
export async function fetchBestSellersByCategory(
  siteId: string,
  siteName: string,
  category: { id: string; name: string },
  exchangeRate: number,
  options: FetchOptions = {}
): Promise<MLProduct[]> {
  const products: MLProduct[] = [];
  const priceLimit = options.priceLimitUsd && options.priceLimitUsd > 0 ? options.priceLimitUsd : MAX_PRICE_USD;
  const siteCountry = SITE_COUNTRY[siteId] || '';
  const allHighlights = await fetchHighlightsByCategory(siteId, category.id);
  // 仅保留真实商品条目：PRODUCT（catalog 商品）与 ITEM（marketplace 在售 listing）。
  // 丢弃 USER / USER_PRODUCT（店铺/品牌目录页，/products 取不到详情）以及无 type / 异常的条目，
  // 避免把店铺/品牌链接当成商品导出。ITEM 与 PRODUCT 一样能拿到标题/价格/物流，纳入可显著增量。
  const highlights = allHighlights.filter((h) => h.type === 'PRODUCT' || h.type === 'ITEM');
  const skipped = allHighlights.length - highlights.length;
  if (skipped > 0) {
    console.log(`[ML Highlights] ${siteName} - ${category.name}: 跳过 ${skipped} 个非商品条目（USER/USER_PRODUCT 等店铺/品牌页），保留 ${highlights.length} 个商品`);
  }
  console.log(`[ML Highlights] ${siteName} - ${category.name}: 获得 ${highlights.length} 个可用 Best Seller 产品`);

  // 顺序处理每个 Best Seller，避免触发 429 限速 / TLS 断开
  const baseDelay = getProxyAgent() ? 1200 : 400;
  for (let i = 0; i < highlights.length; i++) {
    const hl = highlights[i];
    try {
      // 获取产品详情
      const product = await fetchProductDetails(hl.id);
      await new Promise((r) => setTimeout(r, baseDelay));

      // 获取该 product 下的 marketplace items
      const items = await fetchProductItems(hl.id, 5);
      if (i < highlights.length - 1) {
        await new Promise((r) => setTimeout(r, baseDelay));
      }

      if (!product && items.length === 0) continue;

      // 在所有 offers 中筛选 + 取最低价
      const validItems = items.filter((it: any) => it && typeof it.price === 'number');
      if (validItems.length === 0) continue;

      // 预筛选：排除 ML Full（fulfillment）、仅全新
      const screened = validItems.filter((it: any) => {
        if (options.excludeFull && it.shipping?.logistic_type === 'fulfillment') return false;
        if (options.onlyNew && it.condition && it.condition !== 'new') return false;
        return true;
      });
      screened.sort((a: any, b: any) => a.price - b.price);
      if (screened.length === 0) continue;

      const cheapest = screened[0];

      const priceLocal = parseFloat(cheapest.price) || 0;
      const priceUSD = priceLocal * exchangeRate;
      if (priceUSD > priceLimit) continue;

      const attrs = product?.attributes || [];
      const weightAttr = getAttrValue(attrs, 'WEIGHT');
      const heightAttr = getAttrValue(attrs, 'HEIGHT');
      const widthAttr = getAttrValue(attrs, 'WIDTH');
      const lengthAttr = getAttrValue(attrs, 'LENGTH') || getAttrValue(attrs, 'DEPTH');
      const brandAttr = getAttribute(attrs, 'BRAND');
      const modelAttr = getAttribute(attrs, 'MODEL');

      const pictures = product?.pictures || [];
      const thumbnail = pictures[0]?.url || pictures[0]?.secure_url || '';

      // seller 信息（昵称 + 国家，用于跨境/本土判定）
      let sellerName = '';
      let sellerLink = '';
      let sellerCountry = '';
      if (cheapest.seller_id) {
        const info = await fetchSellerInfo(cheapest.seller_id);
        sellerName = info.nickname;
        sellerCountry = info.countryId;
        sellerLink = `https://www.${getSiteDomain(siteId)}/perfil/${encodeURIComponent(sellerName)}`;
      }
      // 排除本土卖家（仅保留跨境）：seller 国家与站点国家一致 → 跳过
      if (options.excludeDomestic && sellerCountry && sellerCountry === siteCountry) continue;

      products.push({
        site: siteId,
        siteName,
        categoryId: category.id,
        categoryName: category.name,
        rank: products.length + 1,
        itemId: cheapest.item_id || hl.id,
        title: product?.name || product?.family_name || '',
        price: priceLocal,
        currency: cheapest.currency_id || '',
        priceUSD: parseFloat(priceUSD.toFixed(2)),
        permalink: getProductPermalink(siteId, hl.id),
        thumbnail,
        pictures: pictures.map((p: any) => p.url || p.secure_url).filter(Boolean),
        soldQuantity: 0,
        availableQuantity: 0,
        condition: cheapest.condition || '',
        weight: weightAttr.value ? `${weightAttr.value} ${weightAttr.unit}`.trim() : '',
        height: heightAttr.value ? `${heightAttr.value} ${heightAttr.unit}`.trim() : '',
        width: widthAttr.value ? `${widthAttr.value} ${widthAttr.unit}`.trim() : '',
        length: lengthAttr.value ? `${lengthAttr.value} ${lengthAttr.unit}`.trim() : '',
        sellerName,
        sellerLink,
        brand: brandAttr,
        model: modelAttr,
      });
    } catch (err: any) {
      console.warn(`[ML Highlights] 处理产品 ${hl.id} 失败: ${err.message?.slice(0, 80)}`);
    }
  }

  console.log(`[ML Highlights] ${siteName} - ${category.name}: 筛选出 ${products.length} 个 ≤$${priceLimit}`);
  return products;
}

/**
 * 获取商品详情 (重量、尺寸等)
 */
async function getItemDetails(itemId: string): Promise<any> {
  try {
    return await httpsGet(`${getApiBase()}/items/${itemId}`);
  } catch (err) {
    console.error(`[ML] 获取商品详情失败 ${itemId}:`, err);
    return null;
  }
}

/**
 * 从搜索结果属性中提取特定属性
 */
function getAttribute(attributes: any[], attributeId: string): string {
  if (!Array.isArray(attributes)) return '';
  const attr = attributes.find((a) => a.id === attributeId);
  return attr ? `${attr.value_name || ''}${attr.value_id && attr.value_id.includes('cm') ? '' : (attr.unit || '')}`.trim() : '';
}

/**
 * 从搜索结果属性中提取数值型属性
 * 优先使用 value_name（通常已含单位，如 "192 g"）；
 * 若 value_name 为空则回退到 value_struct（{ number, unit }）
 */
function getAttrValue(attributes: any[], attributeId: string): { value: string; unit: string } {
  if (!Array.isArray(attributes)) return { value: '', unit: '' };
  const attr = attributes.find((a) => a.id === attributeId);
  if (!attr) return { value: '', unit: '' };
  // 优先 value_name
  let value = attr.value_name || '';
  let unit = attr.unit || '';
  // 回退 value_struct
  if (!value && attr.value_struct) {
    const num = attr.value_struct.number;
    value = num !== undefined && num !== null ? String(num) : '';
    unit = attr.value_struct.unit || '';
  }
  return { value, unit };
}

/**
 * 获取单个品类的 Top 100 商品 (价格 ≤ $15 USD)
 */
async function fetchTopProductsForCategory(
  siteId: string,
  siteName: string,
  category: { id: string; name: string },
  exchangeRate: number,
  options: FetchOptions = {},
  onProgress?: ProgressCallback
): Promise<MLProduct[]> {
  const products: MLProduct[] = [];
  const priceLimit = options.priceLimitUsd && options.priceLimitUsd > 0 ? options.priceLimitUsd : MAX_PRICE_USD;

  // 翻页拉取商品：无代理时仅 2 页（highlights 兜底前的小量预检）；
  // 配置住宅代理后翻到 40 页（每页 50 = 最多 2000 条/类目），靠 results.length<50 自然终止。
  const maxPages = getProxyAgent() ? 40 : 2;
  let allResults: any[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    try {
      const results = await searchProductsByCategory(siteId, category.id, 50, offset);
      if (!results || results.length === 0) break;
      allResults = allResults.concat(results);
      // 该页未拉满 50 条，说明已是最后一页
      if (results.length < 50) break;
      offset += 50;
      // 页间间隔（代理模式下更长，避免 429 限速）
      if (getProxyAgent()) {
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 400));
      }
    } catch (err) {
      console.error(`[ML] 搜索失败 ${category.id} page ${page}:`, err);
      break;
    }
  }

  // 如果官方 search 完全不可用， fallback 到 Best Sellers (/highlights)
  if (allResults.length === 0) {
    console.log(`[ML] ${siteName} - ${category.name} search 无结果，尝试 Best Sellers fallback`);
    try {
      const bestProducts = await fetchBestSellersByCategory(siteId, siteName, category, exchangeRate, options);
      if (onProgress) {
        onProgress({
          phase: 'category_done',
          current: 0,
          total: 0,
          message: `${siteName} - ${category.name}: 筛选出 ${bestProducts.length} 个商品 (Best Sellers)`,
          site: siteId,
          category: category.name,
        });
        if (bestProducts.length > 0) {
          onProgress({
            phase: 'product_batch',
            current: 0,
            total: 0,
            message: '',
            site: siteId,
            category: category.name,
            products: bestProducts,
          });
        }
      }
      return bestProducts;
    } catch (fallbackErr: any) {
      console.warn(`[ML] Best Sellers fallback 也失败 ${category.id}: ${fallbackErr.message?.slice(0, 100)}`);
    }
  }

  // 按销量排序
  allResults.sort((a, b) => (b.sold_quantity || 0) - (a.sold_quantity || 0));

  // 应用筛选条件（价格 / 排除 ML Full / 排除本土 / 仅全新），取前 TOP_N 个
  // search 结果自带 shipping.logistic_type 与 seller_address.country.id，可直接过滤，
  // 无需逐个 getItemDetails，保证翻页拉来大量数据时仍高效。
  const siteCountry = SITE_COUNTRY[siteId];
  const filtered: any[] = [];
  for (const item of allResults) {
    const priceLocal = parseFloat(item.price) || 0;
    const priceUSD = priceLocal * exchangeRate;
    if (priceUSD > priceLimit) continue;
    if (options.excludeFull && item.shipping?.logistic_type === 'fulfillment') continue;
    const sellerCountry = item.seller_address?.country?.id;
    if (options.excludeDomestic && sellerCountry && siteCountry && sellerCountry === siteCountry) continue;
    if (options.onlyNew && item.condition && item.condition !== 'new') continue;
    filtered.push(item);
    if (filtered.length >= TOP_N_PRODUCTS) break;
  }
  const topResults = filtered;

  // 过滤价格 ≤ $15 USD
  let rank = 0;
  for (const item of topResults) {
    const priceLocal = parseFloat(item.price) || 0;
    const priceUSD = priceLocal * exchangeRate;

    if (priceUSD > priceLimit) continue;

    rank++;
    const weightAttr = getAttrValue(item.attributes, 'WEIGHT');
    const heightAttr = getAttrValue(item.attributes, 'HEIGHT');
    const widthAttr = getAttrValue(item.attributes, 'WIDTH');
    const lengthAttr = getAttrValue(item.attributes, 'LENGTH');
    const brandAttr = getAttribute(item.attributes, 'BRAND');
    const modelAttr = getAttribute(item.attributes, 'MODEL');

    // 如果搜索结果中没有重量/尺寸，尝试获取详情
    let weight = weightAttr.value ? `${weightAttr.value} ${weightAttr.unit}`.trim() : '';
    let height = heightAttr.value ? `${heightAttr.value} ${heightAttr.unit}`.trim() : '';
    let width = widthAttr.value ? `${widthAttr.value} ${widthAttr.unit}`.trim() : '';
    let length = lengthAttr.value ? `${lengthAttr.value} ${lengthAttr.unit}`.trim() : '';

    // 如果缺少重量信息，尝试获取商品详情
    if (!weight) {
      try {
        const details = await getItemDetails(item.id);
        if (details) {
          if (details.weight) weight = `${details.weight} g`;
          if (details.height) height = height || `${details.height} cm`;
          if (details.width) width = width || `${details.width} cm`;
          if (details.length) length = length || `${details.length} cm`;
        }
        // 详情请求间隔（代理模式下避免限速）
        if (getProxyAgent()) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch {
        // 忽略错误
      }
    }

    const sellerName = item.seller?.nickname || '';
    const sellerLink = item.seller?.permalink || '';

    products.push({
      site: siteId,
      siteName,
      categoryId: category.id,
      categoryName: category.name,
      rank,
      itemId: item.id,
      title: item.title || '',
      price: priceLocal,
      currency: item.currency_id || '',
      priceUSD: parseFloat(priceUSD.toFixed(2)),
      permalink: item.permalink || `https://www.${getSiteDomain(siteId)}/jm/item?id=${item.id}`,
      thumbnail: item.thumbnail || '',
      pictures: (item.pictures || []).map((p: any) => p.url || p.secure_url).filter(Boolean),
      soldQuantity: item.sold_quantity || 0,
      availableQuantity: item.available_quantity || 0,
      condition: item.condition || '',
      weight,
      height,
      width,
      length,
      sellerName,
      sellerLink,
      brand: brandAttr,
      model: modelAttr,
    });
  }

  if (onProgress) {
    onProgress({
      phase: 'category_done',
      current: 0,
      total: 0,
      message: `${siteName} - ${category.name}: 筛选出 ${products.length} 个商品 (≤$${MAX_PRICE_USD})`,
      site: siteId,
      category: category.name,
    });
    // 将商品数据推送给前端，供实时表格展示
    if (products.length > 0) {
      onProgress({
        phase: 'product_batch',
        current: 0,
        total: 0,
        message: '',
        site: siteId,
        category: category.name,
        products,
      });
    }
  }

  return products;
}

/**
 * 获取指定站点的所有品类 Top 商品。
 * @param startFromCategoryIndex 断点续传：从第几个分类开始（0-based），默认 0
 * @param onCheckpoint 每完成一个分类后调用的 checkpoint 保存回调
 */
async function fetchSiteProducts(
  siteCode: MLSiteCode,
  options: FetchOptions = {},
  onProgress?: ProgressCallback,
  startFromCategoryIndex = 0,
  onCheckpoint?: (siteCode: MLSiteCode, completedIndex: number, total: number, siteProducts?: MLProduct[]) => void
): Promise<MLProduct[]> {
  const site = ML_SITES[siteCode];
  const allProducts: MLProduct[] = [];

  // 获取汇率
  onProgress?.({
    phase: 'exchange_rate',
    current: 0,
    total: 1,
    message: `正在获取 ${site.currency} -> USD 汇率...`,
    site: siteCode,
  });

  const exchangeRate = await getExchangeRate(site.currency);
  onProgress?.({
    phase: 'exchange_rate_done',
    current: 1,
    total: 1,
    message: `${site.currency} -> USD 汇率: ${exchangeRate.toFixed(4)}`,
    site: siteCode,
  });

  // 获取分类
  onProgress?.({
    phase: 'categories',
    current: 0,
    total: 1,
    message: `正在获取 ${site.name} 分类列表...`,
    site: siteCode,
  });

  let categories = await getCategories(siteCode);

  // 展开子分类以获取更多商品（highlights 每类上限20，逐子分类可扩量）
  if (options.includeSubcategories) {
    const expanded: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    for (const cat of categories) {
      expanded.push(cat);
      seen.add(cat.id);
      try {
        const detail = await httpsGet(`${getApiBase()}/categories/${cat.id}`);
        const children = detail?.children_categories || [];
        for (const ch of children) {
          if (!seen.has(ch.id)) {
            expanded.push({ id: ch.id, name: `${cat.name} › ${ch.name}` });
            seen.add(ch.id);
          }
        }
      } catch {
        /* 忽略单个分类的子分类获取失败 */
      }
    }
    categories = expanded;
  }

  onProgress?.({
    phase: 'categories_done',
    current: categories.length,
    total: categories.length,
    message: `${site.name} 共 ${categories.length} 个分类${options.includeSubcategories ? '（含子分类）' : ''}`,
    site: siteCode,
  });

  // 逐个分类获取商品
  const startIdx = Math.max(0, startFromCategoryIndex);
  for (let i = startIdx; i < categories.length; i++) {
    const cat = categories[i];
    onProgress?.({
      phase: 'fetching',
      current: i + 1,
      total: categories.length,
      message: `[${site.name}] 正在获取: ${cat.name} (${i + 1}/${categories.length})`,
      site: siteCode,
      category: cat.name,
    });

    try {
      const products = await fetchTopProductsForCategory(siteCode, site.name, cat, exchangeRate, options, onProgress);
      allProducts.push(...products);
    } catch (err) {
      console.error(`[ML] 获取分类商品失败 ${cat.id}:`, err);
    }

    // 每完成一个分类，保存 checkpoint（传入站点内已累积商品，供断点续传）
    onCheckpoint?.(siteCode, i, categories.length, allProducts);

    // 请求间隔，避免被限速（代理模式下需要更长间隔）
    const delayMs = getProxyAgent() ? 2000 : 200;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return allProducts;
}

/**
 * 主函数：获取所有站点商品并导出 xlsx。
 * @param resumeFromCheckpoint 传入已有的 checkpoint 则从断点续传，否则全新开始。
 */
export async function fetchAllProductsAndExport(
  sites: MLSiteCode[],
  options: FetchOptions = {},
  onProgress?: ProgressCallback,
  resumeFromCheckpoint?: FetchCheckpoint | null
): Promise<{ filePath: string; fileName: string; zipPath?: string; zipName?: string; totalCount: number; siteStats: Record<string, number> }> {
  await ensureValidToken();
  let allProducts: MLProduct[] = [];
  let siteStats: Record<string, number> = {};

  // 断点续传：恢复已收集的商品
  const cp = resumeFromCheckpoint || null;
  if (cp) {
    allProducts = [...(cp.collectedProducts || [])];
    siteStats = { ...(cp.siteStats || {}) };
    onProgress?.({
      phase: 'site_start',
      current: 0,
      total: 0,
      message: `📌 断点续传：从 ${cp.currentSite || cp.completedSites[cp.completedSites.length - 1] || '上次'} 恢复，已有 ${allProducts.length} 个商品`,
    });
  }

  // 站点循环计数（用于 checkpoint 中追踪）
  let siteIndex = 0;

  for (const siteCode of sites) {
    // 断点续传：跳过已完成的站点
    if (cp && cp.completedSites.includes(siteCode)) {
      siteIndex++;
      onProgress?.({
        phase: 'site_done',
        current: 0,
        total: 0,
        message: `⏭️ 跳过已完成: ${ML_SITES[siteCode].name} (${siteStats[siteCode] || 0} 个商品)`,
        site: siteCode,
      });
      continue;
    }

    onProgress?.({
      phase: 'site_start',
      current: 0,
      total: 0,
      message: `开始处理站点: ${ML_SITES[siteCode].name} (${siteCode})`,
      site: siteCode,
    });

    // 断点续传：当前站点从哪个分类继续
    const resumeCategoryIndex = (cp && cp.currentSite === siteCode)
      ? cp.completedCategoryIndex + 1
      : 0;

    const products = await fetchSiteProducts(
      siteCode,
      options,
      onProgress,
      resumeCategoryIndex,
      // checkpoint 回调：每完成一个分类保存一次
      (completedSiteCode, completedIdx, totalCats, siteProducts = []) => {
        const cpNow: FetchCheckpoint = {
          jobId: cp?.jobId || String(Date.now()),
          startedAt: cp?.startedAt || new Date().toISOString(),
          sites,
          options,
          completedSites: cp ? [...cp.completedSites] : [],
          currentSite: completedSiteCode,
          completedCategoryIndex: completedIdx,
          totalCategories: totalCats,
          collectedProducts: [...allProducts, ...siteProducts],
          siteStats: { ...siteStats },
          exchangeRates: {},
        };
        saveCheckpoint(cpNow);
      }
    );

    // 断点续传：把本次累积的加到已有商品中
    if (cp && cp.currentSite === siteCode && allProducts.length > 0) {
      allProducts.push(...products);
    } else {
      allProducts.push(...products);
    }
    siteStats[siteCode] = (siteStats[siteCode] || 0) + products.length;

    onProgress?.({
      phase: 'site_done',
      current: 0,
      total: 0,
      message: `${ML_SITES[siteCode].name} 完成, 共 ${products.length} 个商品`,
      site: siteCode,
    });

    // 每完成一个站点，更新 checkpoint（标记该站点已完成）
    const cpAfterSite: FetchCheckpoint = {
      jobId: cp?.jobId || String(Date.now()),
      startedAt: cp?.startedAt || new Date().toISOString(),
      sites,
      options,
      completedSites: [...(cp?.completedSites || []), siteCode],
      currentSite: null,
      completedCategoryIndex: -1,
      totalCategories: 0,
      collectedProducts: [...allProducts],
      siteStats: { ...siteStats },
      exchangeRates: {},
    };
    saveCheckpoint(cpAfterSite);

    siteIndex++;
  }

  // 全部完成：清除 checkpoint
  deleteCheckpoint();

  // 导出 xlsx
  onProgress?.({
    phase: 'exporting',
    current: 0,
    total: 1,
    message: `正在生成 Excel 文件, 共 ${allProducts.length} 个商品...`,
  });

  const result = await exportToXlsx(allProducts, siteStats);

  // 导出妙手素材包（ZIP，含商品主图）— 推荐的妙手导入方式
  let zipPath: string | undefined;
  let zipName: string | undefined;
  if (options.miaoshouPackage) {
    onProgress?.({
      phase: 'exporting',
      current: 0,
      total: 1,
      message: `正在生成妙手素材包（含商品图片 ZIP）, 共 ${allProducts.length} 个商品...`,
    });
    const pkg = await exportToMiaoshouPackage(allProducts, siteStats);
    if (pkg) { zipPath = pkg.zipPath; zipName = pkg.zipName; }
  }

  onProgress?.({
    phase: 'done',
    current: 1,
    total: 1,
    message: `导出完成! 文件: ${result.fileName}, 共 ${allProducts.length} 个商品`,
  });

  // 持久化完整商品数据供 M2（货源匹配 / 利润测算）消费
  await dumpLatestProducts(allProducts);

  return { ...result, zipPath, zipName, totalCount: allProducts.length, siteStats };
}

/**
 * 持久化最近一次抓取的完整商品数据到 data/exports/latest_products.json（供 M2 使用）。
 * 与「妙手产品导入」Sheet 解耦：妙手 Sheet 只保留上架必需字段；
 * 这里保留 M2 需要的全部字段（permalink / 重量 / 品牌 / 成色 / 销量 / 图片等），并预计算 priceUSD。
 */
export async function dumpLatestProducts(products: MLProduct[]): Promise<void> {
  try {
    const exportDir = path.join(__dirname, '..', 'data', 'exports');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    const rateCache: Record<string, number> = {};
    const rateFor = async (cur: string): Promise<number> => {
      const key = cur || 'USD';
      if (!(key in rateCache)) rateCache[key] = await getExchangeRate(key);
      return rateCache[key];
    };
    const out: any[] = [];
    for (const p of products) {
      const rate = await rateFor(p.currency);
      const priceUSD = p.price > 0 && rate > 0 ? Number((p.price * rate).toFixed(2)) : 0;
      out.push({
        site: p.site,
        siteName: ML_SITES[p.site as MLSiteCode]?.name || p.site,
        categoryId: p.categoryId,
        categoryName: p.categoryName,
        itemId: p.itemId,
        title: p.title,
        price: p.price,
        currency: p.currency,
        priceUSD,
        soldQuantity: p.soldQuantity,
        condition: p.condition,
        brand: p.brand,
        weight: p.weight,
        permalink: p.permalink,
        thumbnail: p.thumbnail,
        pictures: p.pictures,
        availableQuantity: p.availableQuantity,
        shippingType: p.shippingType,
        logisticType: p.logisticType,
        sellerCountry: p.sellerCountry,
      });
    }
    fs.writeFileSync(path.join(exportDir, 'latest_products.json'), JSON.stringify(out, null, 2));
    console.log(`[ML Export] 已持久化 ${out.length} 个商品到 latest_products.json（供 M2 货源匹配/利润测算）`);
  } catch (err: any) {
    console.error('[ML Export] 持久化 latest_products.json 失败:', err?.message || err);
  }
}

/**
 * 构建妙手「产品导入表格」工作簿（含 产品导入表格 + 汇总 两张 Sheet）。
 * 列对齐妙手官方格式2模板（本地素材包导入），包含 产品导入表格.xlsx + 产品图片/货号目录树（见 exportToMiaoshouPackage）。
 * 货源链接/详情描述/属性/规格由后续 1688 图搜与定价引擎补全；物流方式默认 remote（自发货）。
 */
function createMiaoshouWorkbook(
  products: MLProduct[],
  siteStats: Record<string, number>
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ML Product Finder';
  workbook.created = new Date();

  // === 妙手「产品导入表格」（第一张，对齐官方格式2模板-本地素材包导入）===
  const dataSheet = workbook.addWorksheet('产品导入表格', {
    properties: { tabColor: '00A859' },
  });

  // 列对齐妙手官方模板：*货号|*产品名称|货币类型|货源链接|货源平台|详情描述|属性|规格1|SKU规格2|*SKU售价|SKU库存|SKU重量(KG)|SKU尺寸(CM)
  // 额外增加 类目ID/站点/物流方式 列（妙手会忽略不识别列，不影响导入）
  dataSheet.columns = [
    { header: '* 货号', key: 'sku', width: 24 },
    { header: '* 产品名称', key: 'title', width: 50 },
    { header: '货币类型', key: 'currency', width: 8 },
    { header: '货源链接', key: 'sourceUrl', width: 40 },
    { header: '货源平台', key: 'platform', width: 10 },
    { header: '详情描述', key: 'description', width: 40 },
    { header: '属性', key: 'attrs', width: 30 },
    { header: '规格1', key: 'spec1', width: 14 },
    { header: 'SKU规格2', key: 'spec2', width: 14 },
    { header: '* SKU售价', key: 'price', width: 12 },
    { header: 'SKU库存', key: 'stock', width: 10 },
    { header: 'SKU重量(KG)', key: 'weight', width: 12 },
    { header: 'SKU尺寸(CM)', key: 'dimensions', width: 14 },
    { header: '类目ID', key: 'categoryId', width: 18 },
    { header: '站点', key: 'site', width: 10 },
    { header: '物流方式', key: 'shippingType', width: 10 },
  ];

  // 添加数据
  for (const product of products) {
    dataSheet.addRow({
      sku: `${product.site}-${product.itemId}`,
      title: product.title || '',
      currency: product.currency || '',
      sourceUrl: '',
      platform: '1688',
      description: '',
      attrs: '',
      spec1: '',
      spec2: '',
      price: product.price || 0,
      stock: product.availableQuantity > 0 ? product.availableQuantity : 100,
      weight: product.weight || '',
      dimensions: '',
      categoryId: product.categoryId || '',
      site: product.site || '',
      shippingType: 'remote',
    });
  }

  // 样式
  styleHeaderRow(dataSheet);
  styleDataRows(dataSheet, products.length);
  dataSheet.views = [{ state: 'frozen', ySplit: 1 }];
  dataSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: products.length + 1, column: 16 },
  };

  // === 汇总 Sheet（第二张，供用户概览；妙手会忽略此表）===
  const summarySheet = workbook.addWorksheet('汇总', {
    properties: { tabColor: '3b82f6' },
  });

  summarySheet.columns = [
    { header: '站点', key: 'siteName', width: 12 },
    { header: '站点代码', key: 'site', width: 10 },
    { header: '商品数量', key: 'count', width: 12 },
    { header: '生成日期', key: 'date', width: 20 },
  ];

  for (const [siteCode, count] of Object.entries(siteStats)) {
    summarySheet.addRow({
      siteName: ML_SITES[siteCode as MLSiteCode].name,
      site: siteCode,
      count,
      date: new Date().toISOString().slice(0, 10),
    });
  }

  // 合计行
  summarySheet.addRow({
    siteName: '合计',
    site: '-',
    count: products.length,
    date: new Date().toISOString().slice(0, 10),
  });

  // 样式
  styleHeaderRow(summarySheet);
  styleSummaryRow(summarySheet, siteStats);

  return workbook;
}

/**
 * 导出商品数据到 xlsx（妙手「产品导入」单表模式，可直接导入妙手）
 */
async function exportToXlsx(
  products: MLProduct[],
  siteStats: Record<string, number>
): Promise<{ filePath: string; fileName: string }> {
  const dateStr = new Date().toISOString().slice(0, 10);
  const fileName = `ML_Products_${dateStr}.xlsx`;

  const workbook = createMiaoshouWorkbook(products, siteStats);

  // === 保存文件 ===
  const outputDir = path.join(__dirname, '..', 'data', 'exports');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filePath = path.join(outputDir, fileName);
  await workbook.xlsx.writeFile(filePath);

  return { filePath, fileName };
}

/**
 * 导出妙手「素材包」（推荐导入方式）：对齐官方格式2模板（本地素材包导入）。
 * ZIP 结构（与官方「产品素材包模版(格式2)」一致）：
 *   <ZIP>/
 *     ├── 产品导入表格.xlsx
 *     └── 产品图片/
 *         └── <货号>/
 *             ├── 产品主图/主图_1.jpg ...
 *             ├── SKU图/          （空，待用户从1688图搜后补入）
 *             ├── 产品证书/        （空）
 *             ├── 尺寸图表/        （空）
 *             ├── 详情图/          （空，待用户自行添加）
 *             └── 产品视频/        （空）
 * 图片下载失败（404/超时）时跳过该图，不影响 ZIP 生成。空文件夹通过占位 .gitkeep 确保 JSON 中有条目。
 */
export async function exportToMiaoshouPackage(
  products: MLProduct[],
  siteStats: Record<string, number>
): Promise<{ zipPath: string; zipName: string } | null> {
  try {
    const archiver = (await import('archiver')).default;
    const dateStr = new Date().toISOString().slice(0, 10);
    const zipName = `ML_Products_${dateStr}_妙手素材包.zip`;

    const outputDir = path.join(__dirname, '..', 'data', 'exports');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const zipPath = path.join(outputDir, zipName);

    // 1) 生成 Excel 到内存
    const workbook = createMiaoshouWorkbook(products, siteStats);
    const xlsxBuf = await workbook.xlsx.writeBuffer();

    // 2) 边下载图片边写入 ZIP（不落临时目录，避免大批量文件清理）
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const zipDone = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      archive.on('error', reject);
    });
    archive.pipe(output);

    // Excel 作为素材包根文件
    archive.append(xlsxBuf as Buffer, { name: '产品导入表格.xlsx' });

    // 空文件夹占位子目录列表（妙手素材包需要的目录结构）
    const placeholderDirs = ['SKU图', '产品证书', '尺寸图表', '详情图', '产品视频'];

    const CONCURRENCY = 6;
    const appendImages = async (product: MLProduct) => {
      const imgs = (product.pictures && product.pictures.length ? product.pictures : [product.thumbnail]).filter(Boolean);
      const sku = sanitizeSku(`${product.site}-${product.itemId}`);
      // 产品主图（妙手识别 "主图_N.jpg" 命名）
      for (let i = 0; i < imgs.length; i++) {
        try {
          const buf = await downloadImageToBuffer(imgs[i], 8000);
          archive.append(buf, { name: `产品图片/${sku}/产品主图/主图_${i + 1}.jpg` });
        } catch {
          /* 单张失败跳过，不影响整体 */
        }
      }
      // 空文件夹占位（确保目录结构在 ZIP 中存在，妙手可识别）
      for (const dir of placeholderDirs) {
        archive.append('', { name: `产品图片/${sku}/${dir}/.gitkeep`, store: true });
      }
    };
    for (let i = 0; i < products.length; i += CONCURRENCY) {
      const batch = products.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(appendImages));
    }

    await archive.finalize();
    await zipDone;

    console.log(`[ML Export] 妙手素材包已生成: ${zipName} (${products.length} 个商品，含产品图片/)`);
    return { zipPath, zipName };
  } catch (err: any) {
    console.error('[ML Export] 妙手素材包生成失败:', err?.message || err);
    return null;
  }
}

/** 货号中的非法文件名字符处理 */
function sanitizeSku(sku: string): string {
  return sku.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

/** 下载图片为 Buffer（带超时 + 单次重定向跟随），失败抛错由调用方跳过 */
async function downloadImageToBuffer(url: string, timeoutMs = 8000): Promise<Buffer> {
  const https = await import('https');
  const http = await import('http');
  const { URL } = await import('url');
  return new Promise((resolve, reject) => {
    let u: any;
    try { u = new URL(url); } catch { return reject(new Error('bad url')); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res: any) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImageToBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (!res.statusCode || res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (e: any) => reject(e));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e: any) => reject(e));
  });
}

/**
 * 表头样式
 */
function styleHeaderRow(sheet: ExcelJS.Worksheet) {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF3B82F6' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  headerRow.height = 30;
  headerRow.border = {
    bottom: { style: 'medium', color: { argb: 'FF2563EB' } },
  };
}

/**
 * 数据行样式
 */
function styleDataRows(sheet: ExcelJS.Worksheet, rowCount: number) {
  for (let i = 2; i <= rowCount + 1; i++) {
    const row = sheet.getRow(i);
    row.alignment = { vertical: 'middle', wrapText: true };

    // 隔行变色
    if (i % 2 === 0) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF0F7FF' },
      };
    }

    // 价格列格式
    const priceCell = row.getCell(6);
    priceCell.numFmt = '#,##0.00';

    const usdCell = row.getCell(8);
    usdCell.numFmt = '$#,##0.00';

    // 链接列设为超链接样式
    const linkCell = row.getCell(18);
    if (linkCell.value) {
      linkCell.font = { color: { argb: 'FF3B82F6' }, underline: true };
    }
  }
}

/**
 * 汇总行样式
 */
function styleSummaryRow(sheet: ExcelJS.Worksheet, siteStats: Record<string, number>) {
  const rowCount = Object.keys(siteStats).length + 1; // 数据行 + 合计行
  const totalRow = sheet.getRow(rowCount + 1);
  totalRow.font = { bold: true, size: 12 };
  totalRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFF3CD' },
  };
}

/**
 * 获取已导出的文件列表
 */
export function getExportedFiles(): Array<{ fileName: string; filePath: string; size: number; createdAt: Date }> {
  const exportDir = path.join(__dirname, '..', 'data', 'exports');
  if (!fs.existsSync(exportDir)) return [];

  const files = fs.readdirSync(exportDir)
    .filter((f) => f.endsWith('.xlsx'))
    .map((fileName) => {
      const filePath = path.join(exportDir, fileName);
      const stat = fs.statSync(filePath);
      return {
        fileName,
        filePath,
        size: stat.size,
        createdAt: stat.mtime,
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return files;
}

/**
 * 公开的 xlsx 导出函数（供前端数据导出使用）
 */
export async function exportProductsToXlsx(
  products: MLProduct[],
  siteStats: Record<string, number>
): Promise<{ filePath: string; fileName: string }> {
  return exportToXlsx(products, siteStats);
}

/**
 * 获取回退分类列表（不调用 API）
 */
export function getFallbackCategories(siteId: string): Array<{ id: string; name: string }> {
  return FALLBACK_CATEGORIES[siteId as keyof typeof FALLBACK_CATEGORIES] || [];
}

/**
 * 获取完整的 access token（供前端直接调用 ML API 使用）
 */
export function getFullAccessToken(): string {
  return mlAccessToken;
}
