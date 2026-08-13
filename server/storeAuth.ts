/**
 * per-store OAuth2 授权码流程（authorization_code + PKCE）
 * 与全局单例的 OAuth 不同，这里为「每个店铺」独立生成授权 URL 并保存 PKCE 状态，
 * 授权回调时用 state 找回对应的 verifier / 昵称 / 站点，再换取该店铺自己的 token。
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMlAppId, getMlSecretKeyRaw, getMlApiBase, getEffectiveRedirectUri } from './mercadolibre.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, '..', 'data', 'oauth-states.json');

interface PendingState {
  verifier: string;
  nickname: string;
  site: string;
  redirectUri: string;
  createdAt: number;
}

const states = new Map<string, PendingState>();
const STATE_TTL = 10 * 60 * 1000; // 10 分钟有效

// 启动时加载未过期的 state
try {
  if (fs.existsSync(STATE_FILE)) {
    const arr = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    for (const s of arr) {
      if (Date.now() - s.createdAt < STATE_TTL) states.set(s.state, s);
    }
  }
} catch {
  /* ignore */
}

function persistStates() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify([...states.values()].filter((s) => Date.now() - s.createdAt < STATE_TTL)));
  } catch {
    /* ignore */
  }
}

function genVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}
function genChallenge(v: string): string {
  return crypto.createHash('sha256').update(v).digest('base64url');
}
function genState(): string {
  return crypto.randomBytes(16).toString('hex');
}

// 各站点授权主机（必须与站点一致，否则 ML 会拒绝）
const AUTH_HOST_BY_SITE: Record<string, string> = {
  MLM: 'https://auth.mercadolibre.com.mx',
  MLB: 'https://auth.mercadolibre.com.br',
  MLC: 'https://auth.mercadolibre.cl',
  MCO: 'https://auth.mercadolibre.com.co',
  // CBT = Global Selling 跨境卖家，使用独立的授权入口
  CBT: 'https://global-selling.mercadolibre.com',
};

/**
 * 为某个店铺生成授权 URL（跳转到美客多授权页）
 * @returns { url, state } —— state 需回传用于换取 token
 */
export function buildStoreAuthUrl(opts: { nickname: string; site: string }): { url: string; state: string } {
  const appId = getMlAppId();
  if (!appId) throw new Error('未配置 ML_APP_ID，无法生成授权链接');

  let redirectUri = getEffectiveRedirectUri();
  if (!redirectUri || redirectUri.includes('localhost')) {
    throw new Error('请先配置公网回调地址（设置 ML_REDIRECT_URI 环境变量，或启动公网隧道），Mercado Libre 不接受 localhost 回调');
  }
  // 统一规整为店铺回调路径：确保以 /api/ml/oauth/store-callback 结尾
  // （兼容三种写法：裸域名、旧的 /oauth/callback、已带完整路径）
  let cb = redirectUri;
  if (!cb.includes('/api/ml/oauth/store-callback')) {
    cb = cb.replace(/\/oauth\/callback\/?$/, ''); // 去掉旧的 /oauth/callback
    cb = cb.replace(/\/+$/, '') + '/api/ml/oauth/store-callback';
  }

  const state = genState();
  const verifier = genVerifier();
  const challenge = genChallenge(verifier);
  states.set(state, {
    verifier,
    nickname: (opts.nickname || '').trim(),
    site: opts.site || 'MLM',
    redirectUri: cb,
    createdAt: Date.now(),
  });
  persistStates();

  const host = AUTH_HOST_BY_SITE[opts.site] || AUTH_HOST_BY_SITE.MLM;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: appId,
    redirect_uri: cb,
    scope: 'read write offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  // 不加 prompt=login：让 ML 直接复用浏览器已有的 session。
  // 如果用户已在美客多卖家中心登录了卖家账号，OAuth 会自动使用该 session，无需重新输入密码。
  // 这样在浏览器同时登录了买家和卖家账号时，只要卖家 session 是最近的活跃 session，就能自动识别到卖家账号。
  return { url: `${host}/authorization?${params.toString()}`, state };
}

/**
 * 用授权码 + state 换取该店铺的 token
 */
export async function exchangeStoreCode(code: string, state: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  nickname: string;
  site: string;
  scope?: string;
}> {
  const pending = states.get(state);
  if (!pending) throw new Error('授权状态已过期或不存在（请重新点击「添加店铺」）');

  const appId = getMlAppId();
  const secret = getMlSecretKeyRaw();
  if (!appId || !secret) throw new Error('未配置 ML_APP_ID / ML_SECRET_KEY');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: appId,
    client_secret: secret,
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  });

  const resp = await fetch(`${getMlApiBase()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`Token 交换失败: ${JSON.stringify(data).slice(0, 300)}`);
  }

  states.delete(state);
  persistStates();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresIn: data.expires_in || 21600,
    nickname: pending.nickname,
    site: pending.site,
    scope: data.scope,
  };
}
