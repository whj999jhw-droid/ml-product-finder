/**
 * 多店铺管理：每个店铺独立的 access/refresh token 存储与续期
 * 店铺通过「添加店铺」→ 美客多授权 → authorization_code 换取 write+offline token 后入库。
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMlAppId, getMlSecretKeyRaw, getMlApiBase } from './mercadolibre.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORES_FILE = path.join(__dirname, '..', 'data', 'stores.json');

export interface Store {
  id: string;
  nickname: string; // 店铺备注简称
  site: string; // MLM / MLB / MLC / MCO
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  mlUserId?: string;
  mlUserNick?: string;
  mlUserEmail?: string; // 授权时登录的美客多账号邮箱，便于区分「授权错账号」
  mlSeller?: boolean; // 根据 /users/me 的 seller_reputation/status 判断是否为卖家账号
  lastOrderCheck?: string; // ISO，订单轮询游标
  enabled: boolean;
  createdAt: string;
}

let stores: Store[] = load();

function load(): Store[] {
  try {
    if (fs.existsSync(STORES_FILE)) {
      return JSON.parse(fs.readFileSync(STORES_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[Stores] 加载失败:', err);
  }
  return [];
}

function save() {
  try {
    const dir = path.dirname(STORES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORES_FILE, JSON.stringify(stores, null, 2));
  } catch (err) {
    console.error('[Stores] 保存失败:', err);
  }
}

/** 对外列表：掩码 token，避免泄露；附 authorized 标记便于前端判断是否可上架 */
export function listStores(): (Store & { authorized: boolean })[] {
  return stores.map((s) => ({ ...s, accessToken: '', refreshToken: '', authorized: !!s.accessToken }));
}

/** 内部使用：返回含 token 的原始数组 */
export function getAllStores(): Store[] {
  return stores;
}

export function getStoreRaw(id: string): Store | undefined {
  return stores.find((s) => s.id === id);
}

export function addStore(s: Omit<Store, 'id' | 'createdAt'> & { id?: string }): Store {
  const store: Store = {
    id: s.id || crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...s,
  } as Store;
  store.accessToken = s.accessToken;
  store.refreshToken = s.refreshToken;
  store.expiresAt = s.expiresAt;
  stores.push(store);
  save();
  return store;
}

export function updateStore(id: string, patch: Partial<Store>): Store | undefined {
  const st = stores.find((s) => s.id === id);
  if (!st) return undefined;
  // token 字段不允许通过普通 patch 直接覆盖（安全），但 expiresAt/enabled/nickname/lastOrderCheck 允许
  if (patch.nickname !== undefined) st.nickname = patch.nickname;
  if (patch.site !== undefined) st.site = patch.site;
  if (patch.enabled !== undefined) st.enabled = patch.enabled;
  if (patch.lastOrderCheck !== undefined) st.lastOrderCheck = patch.lastOrderCheck;
  if (patch.mlUserId !== undefined) st.mlUserId = patch.mlUserId;
  if (patch.mlUserNick !== undefined) st.mlUserNick = patch.mlUserNick;
  if (patch.mlSeller !== undefined) st.mlSeller = patch.mlSeller;
  if (patch.accessToken !== undefined) st.accessToken = patch.accessToken;
  if (patch.refreshToken !== undefined) st.refreshToken = patch.refreshToken;
  if (patch.expiresAt !== undefined) st.expiresAt = patch.expiresAt;
  save();
  return st;
}

export function deleteStore(id: string): boolean {
  const before = stores.length;
  stores = stores.filter((s) => s.id !== id);
  if (stores.length !== before) {
    save();
    return true;
  }
  return false;
}

/** 确保 token 有效，过期则用 refresh_token 续期 */
export async function ensureStoreToken(store: Store): Promise<string> {
  if (store.accessToken && store.expiresAt && store.expiresAt > Date.now() + 5 * 60 * 1000) {
    return store.accessToken;
  }
  if (!store.refreshToken) throw new Error('店铺无 refresh token，请重新授权');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: getMlAppId(),
    client_secret: getMlSecretKeyRaw(),
    refresh_token: store.refreshToken,
  });
  const resp = await fetch(`${getMlApiBase()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`Token 刷新失败: ${JSON.stringify(data).slice(0, 200)}`);
  }
  store.accessToken = data.access_token;
  store.refreshToken = data.refresh_token || store.refreshToken;
  store.expiresAt = Date.now() + (data.expires_in || 21600) * 1000;
  save();
  return store.accessToken;
}

/** 以该店铺身份调用 ML API（GET），带 429/5xx 自动退避重试 */
export async function storeApiGet(store: Store, apiPath: string, retries = 3): Promise<any> {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const token = await ensureStoreToken(store);
      const resp = await fetch(`${getMlApiBase()}${apiPath}`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const t = await resp.text();
        const err = new Error(`ML API ${resp.status}: ${t.slice(0, 400)}`);
        // 429 或 5xx 服务器错误时指数退避重试；其它错误立即抛
        if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
          lastErr = err;
          const delay = Math.min(800 * Math.pow(2, attempt) + Math.random() * 300, 8000);
          await new Promise((r) => setTimeout(r, Math.round(delay)));
          continue;
        }
        throw err;
      }
      return resp.json();
    } catch (e: any) {
      lastErr = e;
      if (e?.message?.includes('429') && attempt < retries) {
        const delay = Math.min(800 * Math.pow(2, attempt) + Math.random() * 300, 8000);
        await new Promise((r) => setTimeout(r, Math.round(delay)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** 获取该店铺的卖家信息（/users/me），并判断该账号是否具备卖家资质 */
export async function getStoreSellerInfo(
  store: Store,
): Promise<{ id: string; nickname?: string; site_id?: string; email?: string; isSeller?: boolean; sellerLevel?: string | null }> {
  const data = await storeApiGet(store, '/users/me');
  const sr = data?.seller_reputation || {};
  const st = data?.status || {};
  // 综合判断：允许销售 + 有卖家声誉对象，且至少具备 level_id/交易记录/卖家经验/卖家标签之一
  const isSeller = !!(
    st?.sell?.allow &&
    st?.list?.allow &&
    (sr?.level_id || sr?.transactions?.total || data?.seller_experience || data?.tags?.includes('messages_as_seller'))
  );
  return {
    id: String(data?.id || ''),
    nickname: data?.nickname,
    site_id: data?.site_id,
    email: data?.email,
    isSeller,
    sellerLevel: sr?.level_id || null,
  };
}
