/**
 * M3：合规上架到美客多（POST /items）
 * 合规红线：只用你自己的标题/描述/图片/品牌；绝不复制竞品销量、评论、原图。
 * 非 Full 店：shipping.mode='custom'（自选物流，不经 fulfillment）。
 */
import { getAccessToken, ML_SITES } from './mercadolibre.js';
import { checkBannedWords } from './bannedWords.js';

export interface ListingDraft {
  site: string; // MLM / MLB / MLC / MCO
  storeId?: string; // 多店铺：指定用哪个店铺的 write token 上架（不传则回退全局 token）
  title: string;
  category_id: string;
  price: number;
  currency_id?: string; // 不传则按站点自动取
  available_quantity: number;
  description: string;
  pictureUrls: string[]; // 公网可访问的图片 URL（必须是你自有/已授权的图）
  brand: string; // 你的品牌或 Generic
  weight?: number;
  height?: number;
  width?: number;
  length?: number;
  listing_type_id?: string; // gold_pro / silver / bronze
}

export interface PrecheckResult {
  ok: boolean;
  hits: string[];
  message: string;
}

export function precheckCompliance(draft: Partial<ListingDraft>): PrecheckResult {
  const hits: string[] = [];
  const text = `${draft.title || ''} ${draft.brand || ''} ${draft.description || ''}`;
  const banned = checkBannedWords(text, draft.site);
  for (const b of banned.brandHits) hits.push(`品牌侵权词: ${b}`);
  for (const w of banned.wordHits) hits.push(`平台违禁词: ${w}`);
  if (!draft.title || draft.title.trim().length < 5) hits.push('标题过短或为空（须为你自己撰写）');
  if (!draft.pictureUrls || draft.pictureUrls.length === 0) hits.push('未提供商品图片（须为你自有/已授权图，禁止盗用竞品原图）');
  if (!draft.description || draft.description.trim().length < 5) hits.push('描述过短或为空');
  return {
    ok: hits.length === 0,
    hits,
    message: hits.length ? `命中 ${hits.length} 项需确认：${hits.join(', ')}` : '合规预检通过',
  };
}

export async function createListing(draft: ListingDraft, tokenOverride?: string): Promise<{ itemId: string; permalink: string }> {
  // 多店铺：优先用传入的店铺 token；否则回退全局 token
  const token = tokenOverride || getAccessToken();
  if (!token) {
    throw new Error('未获取到卖家 write token，请先在「店铺管理」中添加并授权店铺（需含 write scope），或先在设置页完成全局授权');
  }

  const siteInfo = ML_SITES[draft.site as keyof typeof ML_SITES];
  const currency_id = draft.currency_id || siteInfo?.currency || 'MXN';

  const payload: any = {
    title: draft.title,
    category_id: draft.category_id,
    price: draft.price,
    currency_id,
    available_quantity: draft.available_quantity,
    buying_mode: 'buy_it_now',
    listing_type_id: draft.listing_type_id || 'bronze',
    description: { plain_text: draft.description },
    pictures: (draft.pictureUrls || []).map((u) => ({ source: u })),
    // 非 Full 店：自选物流
    shipping: {
      mode: 'custom',
      local_pick_up: false,
      free_shipping: false,
      dimensions: {
        weight: draft.weight || 0.5,
        height: draft.height || 10,
        width: draft.width || 10,
        length: draft.length || 10,
      },
    },
    attributes: [{ id: 'BRAND', value_name: draft.brand || 'Generic' }],
  };

  const resp = await fetch('https://api.mercadolibre.com/items', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const msg = data?.message || data?.error || '上架失败';
    const err: any = new Error(`上架失败：${msg}`);
    err.status = resp.status;
    throw err;
  }
  return { itemId: data.id, permalink: data.permalink };
}

// ============ 批量上架发布器（参考文档 listingPublisher 设计）============
export interface BatchPublishItemResult {
  index: number;
  title: string;
  site: string;
  success: boolean;
  itemId?: string;
  permalink?: string;
  error?: string;
  attempts: number;
  precheckHits?: string[];
  skipped?: boolean; // 因站点与所选店铺不符被跳过
  storeId?: string;
}

export interface BatchPublishResult {
  total: number;
  succeeded: number;
  failed: number;
  blocked: number; // 预检拦截数
  skipped: number; // 站点与所选店铺不符被跳过数
  results: BatchPublishItemResult[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 批量上架：每站点并发 3、429/5xx 指数退避 + 抖动、maxRetries=3。
 * 每条先跑合规预检，命中即拦截（不消耗 API 配额）。
 */
export async function publishBatch(
  drafts: ListingDraft[],
  opts?: {
    concurrency?: number;
    maxRetries?: number;
    onProgress?: (done: number, total: number, last?: BatchPublishItemResult) => void;
    token?: string; // 多店铺：该批统一使用的店铺 write token
    storeSite?: string; // 多店铺：所选店铺站点，草稿站点与之不符则跳过
    storeId?: string;
  }
): Promise<BatchPublishResult> {
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 3, 5));
  const maxRetries = opts?.maxRetries ?? 3;
  const results: BatchPublishItemResult[] = [];
  let done = 0;

  // 按站点分组，各站点内部串行分片、组间并发（对单站点限速最友好）
  const queue = drafts.map((d, i) => ({ d, i }));

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      const { d, i } = job;
      const item: BatchPublishItemResult = {
        index: i,
        title: d.title || '',
        site: d.site || '',
        success: false,
        attempts: 0,
        skipped: false,
        storeId: opts?.storeId,
      };

      // 0) 站点校验：多店铺模式下，草稿站点必须与所选店铺站点一致
      if (opts?.storeSite && d.site && d.site !== opts.storeSite) {
        item.skipped = true;
        item.success = false;
        item.attempts = 0;
        item.error = `站点与所选店铺不符（草稿站点 ${d.site}，店铺站点 ${opts.storeSite}），已跳过`;
        results.push(item);
        done++;
        opts?.onProgress?.(done, drafts.length, item);
        continue;
      }

      // 1) 合规预检（本地，不耗配额）
      const pre = precheckCompliance(d);
      if (!pre.ok) {
        item.error = `合规预检未通过：${pre.message}`;
        item.precheckHits = pre.hits;
        results.push(item);
        done++;
        opts?.onProgress?.(done, drafts.length, item);
        continue;
      }

      // 2) 带退避的上架重试
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        item.attempts = attempt;
        try {
          const r = await createListing(d, opts?.token);
          item.success = true;
          item.itemId = r.itemId;
          item.permalink = r.permalink;
          break;
        } catch (err: any) {
          const status = err?.status;
          const retriable = status === 429 || (status >= 500 && status < 600);
          item.error = err?.message || '未知错误';
          if (!retriable || attempt > maxRetries) break;
          // 指数退避 + 抖动：2^attempt 秒 + 0~1s 随机
          const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          await sleep(backoffMs);
        }
      }
      results.push(item);
      done++;
      opts?.onProgress?.(done, drafts.length, item);
      // 温和限速：条间固定间隔 500ms
      await sleep(500);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  results.sort((a, b) => a.index - b.index);
  const succeeded = results.filter((r) => r.success).length;
  const blocked = results.filter((r) => !r.success && r.precheckHits?.length).length;
  const skipped = results.filter((r) => r.skipped).length;
  return {
    total: drafts.length,
    succeeded,
    failed: results.length - succeeded - blocked - skipped,
    blocked,
    skipped,
    results,
  };
}

/** 查询卖家剩余可上架配额（best-effort，接口不可用时返回 null） */
export async function getListingQuota(): Promise<{ available: boolean; detail: any } | null> {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const meResp = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meResp.ok) return null;
    const me: any = await meResp.json();
    const capResp = await fetch(`https://api.mercadolibre.com/marketplace/users/${me.id}/cap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!capResp.ok) {
      return { available: false, detail: { status: capResp.status, sellerId: me.id, nickname: me.nickname } };
    }
    const cap = await capResp.json();
    return { available: true, detail: cap };
  } catch {
    return null;
  }
}
