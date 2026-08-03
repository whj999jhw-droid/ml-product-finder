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

export function getEffectiveRedirectUri(): string {
  return tunnelCallbackUrl || mlRedirectUri;
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

/**
 * 生成 OAuth2 授权 URL
 */
export function generateAuthUrl(usePkce: boolean = true): string {
  if (!mlAppId) {
    throw new Error('请先设置 App ID');
  }
  const redirectUri = getEffectiveRedirectUri();
  if (!redirectUri || redirectUri.includes('localhost')) {
    throw new Error('Mercado Libre 不接受 localhost 回调地址，请先启动公网隧道');
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

  return `https://auth.mercadolibre.com.mx/authorization?${params.toString()}`;
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
}

type ProgressCallback = (progress: FetchProgress) => void;

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

/**
 * 搜索品类下的商品 (按销量排序)
 * 策略1: 官方 API + Bearer token (category only)
 * 策略1b: 如果 403，尝试添加 q 参数（某些 ML 端点要求 q）
 * 策略2: 官方 API + access_token 查询参数
 * 策略3: ML 网站搜索页面抓取
 */
async function searchProductsByCategory(
  siteId: string,
  categoryId: string,
  limit: number = 50,
  offset: number = 0
): Promise<any[]> {
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
    const data = await httpsGet(apiUrl);
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
        const data = await httpsGet(apiUrl);
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
    if (err1Msg.includes('403') && mlAccessToken) {
      // 确认 /search 被全局封锁，后续分类跳过 search 直接走兜底
      searchConfirmedBlocked = true;
      searchBlockedProxy = mlProxyUrl || '';
      console.log(`[ML Search] 403 错误，确认 /search 被全局封锁（代理: ${mlProxyUrl ? '已配置' : '无'}），后续分类将直接走 highlights 兜底 (${categoryId})`);
      console.log(`[ML Search] 尝试策略1b: 添加 q 参数 (${categoryId})...`);
      await new Promise((r) => setTimeout(r, 1000));
      try {
        // 使用通用搜索词 + category 过滤
        const apiUrlWithQ = `${getApiBase()}/sites/${siteId}/search?q=${encodeURIComponent(' ')}&category=${categoryId}&limit=${limit}&offset=${offset}`;
        const data1b = await httpsGet(apiUrlWithQ);
        if (data1b?.results && data1b.results.length > 0) {
          console.log(`[ML Search] 策略1b(q参数)成功 (${categoryId}): ${data1b.results.length} 个结果`);
          return data1b.results;
        }
      } catch (err1b: any) {
        console.warn(`[ML Search] 策略1b失败 (${categoryId}): ${err1b.message?.slice(0, 80)}`);
      }
    }

    // 策略2: 官方 API + access_token 作为查询参数（仅在非 429 错误时尝试）
    if (mlAccessToken && !err1Msg.includes('429')) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const urlWithToken = `${apiUrl}&access_token=${encodeURIComponent(mlAccessToken)}`;
        const data2 = await httpsGet(urlWithToken);
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
            const urlWithQToken = `${getApiBase()}/sites/${siteId}/search?q=${encodeURIComponent(' ')}&category=${categoryId}&limit=${limit}&offset=${offset}&access_token=${encodeURIComponent(mlAccessToken)}`;
            const data2b = await httpsGet(urlWithQToken);
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
async function fetchHighlightsByCategory(siteId: string, categoryId: string): Promise<Array<{ id: string; position: number; type: string }>> {
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
async function fetchProductDetails(productId: string): Promise<any> {
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await httpsGet(`${getApiBase()}/products/${productId}`);
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
async function fetchProductItems(productId: string, limit: number = 10): Promise<any[]> {
  try {
    const data = await httpsGet(`${getApiBase()}/products/${productId}/items?limit=${limit}`);
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
      return await fetchBestSellersByCategory(siteId, siteName, category, exchangeRate, options);
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
  }

  return products;
}

/**
 * 获取指定站点的所有品类 Top 商品
 */
async function fetchSiteProducts(
  siteCode: MLSiteCode,
  options: FetchOptions = {},
  onProgress?: ProgressCallback
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
  for (let i = 0; i < categories.length; i++) {
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

    // 请求间隔，避免被限速（代理模式下需要更长间隔）
    const delayMs = getProxyAgent() ? 2000 : 200;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return allProducts;
}

/**
 * 主函数：获取所有站点商品并导出 xlsx
 */
export async function fetchAllProductsAndExport(
  sites: MLSiteCode[],
  options: FetchOptions = {},
  onProgress?: ProgressCallback
): Promise<{ filePath: string; fileName: string; zipPath?: string; zipName?: string; totalCount: number; siteStats: Record<string, number> }> {
  await ensureValidToken();
  const allProducts: MLProduct[] = [];
  const siteStats: Record<string, number> = {};

  for (const siteCode of sites) {
    onProgress?.({
      phase: 'site_start',
      current: 0,
      total: 0,
      message: `开始处理站点: ${ML_SITES[siteCode].name} (${siteCode})`,
      site: siteCode,
    });

    const products = await fetchSiteProducts(siteCode, options, onProgress);
    allProducts.push(...products);
    siteStats[siteCode] = products.length;

    onProgress?.({
      phase: 'site_done',
      current: 0,
      total: 0,
      message: `${ML_SITES[siteCode].name} 完成, 共 ${products.length} 个商品`,
      site: siteCode,
    });
  }

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
 * 构建妙手「产品导入」工作簿（含 产品导入 + 汇总 两张 Sheet）。
 * 字段严格对齐妙手「产品导入表格」（见《官方API抓取与妙手导入上架方案.pdf》2.3/2.4）。
 * 货源链接/采购价/净收益/颜色/尺码/描述由后续 1688 图搜与定价引擎补全；物流方式固定 remote（自发货）。
 */
function createMiaoshouWorkbook(
  products: MLProduct[],
  siteStats: Record<string, number>
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ML Product Finder';
  workbook.created = new Date();

  // === 妙手导入数据 Sheet（第一张，供妙手 ERP 直接导入）===
  const dataSheet = workbook.addWorksheet('产品导入', {
    properties: { tabColor: '00A859' },
  });

  dataSheet.columns = [
    { header: '货号', key: 'sku', width: 24 },
    { header: '产品标题', key: 'title', width: 50 },
    { header: '币种', key: 'currency', width: 8 },
    { header: '货源链接', key: 'sourceUrl', width: 40 },
    { header: '采购价(¥)', key: 'purchasePrice', width: 12 },
    { header: '售价', key: 'price', width: 12 },
    { header: '净收益(希望利润)', key: 'netProfit', width: 16 },
    { header: '颜色规格', key: 'colors', width: 18 },
    { header: '尺码规格', key: 'sizes', width: 18 },
    { header: '库存', key: 'stock', width: 10 },
    { header: '类目ID', key: 'categoryId', width: 18 },
    { header: '站点', key: 'site', width: 10 },
    { header: '物流方式', key: 'shippingType', width: 10 },
    { header: '描述', key: 'description', width: 40 },
  ];

  // 添加数据（映射为妙手字段）
  for (const product of products) {
    dataSheet.addRow({
      sku: `${product.site}-${product.itemId}`,
      title: product.title || '',
      currency: product.currency || '',
      sourceUrl: '',
      purchasePrice: '',
      price: product.price || 0,
      netProfit: '',
      colors: '',
      sizes: '',
      stock: product.availableQuantity > 0 ? product.availableQuantity : 100,
      categoryId: product.categoryId || '',
      site: product.site || '',
      shippingType: 'remote', // 自发货
      description: '',
    });
  }

  // 样式
  styleHeaderRow(dataSheet);
  styleDataRows(dataSheet, products.length);
  dataSheet.views = [{ state: 'frozen', ySplit: 1 }];
  dataSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: products.length + 1, column: 14 },
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
 * 导出妙手「素材包」（推荐导入方式）：产品导入表格.xlsx + 每个货号的主图文件夹，打包成 ZIP。
 * 素材包结构（见《官方API抓取与妙手导入上架方案.pdf》2.2）：
 *   <ZIP>/
 *     ├── 产品导入表格.xlsx
 *     └── <货号>/
 *         └── 产品主图/主图_1.jpg ...
 * 图片下载失败（404/超时）时跳过该图，不影响 ZIP 生成。
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

    const CONCURRENCY = 6;
    const appendImages = async (product: MLProduct) => {
      const imgs = (product.pictures && product.pictures.length ? product.pictures : [product.thumbnail]).filter(Boolean);
      if (!imgs.length) return;
      const sku = sanitizeSku(`${product.site}-${product.itemId}`);
      for (let i = 0; i < imgs.length; i++) {
        try {
          const buf = await downloadImageToBuffer(imgs[i], 8000);
          archive.append(buf, { name: `${sku}/产品主图/主图_${i + 1}.jpg` });
        } catch {
          /* 单张失败跳过，不影响整体 */
        }
      }
    };
    for (let i = 0; i < products.length; i += CONCURRENCY) {
      const batch = products.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(appendImages));
    }

    await archive.finalize();
    await zipDone;

    console.log(`[ML Export] 妙手素材包已生成: ${zipName} (${products.length} 个商品)`);
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
