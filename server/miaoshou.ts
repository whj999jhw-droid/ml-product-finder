/**
 * server/miaoshou.ts
 * 妙手开放平台 API 客户端（Miaoshou Open Platform Client）
 *
 * 认证：HMAC-SHA256（appSecret 做 key，拼接规则 = appSecret + path + timestamp + appKey + bodyJson + appSecret）
 * 域名：https://openapi-erp.91miaoshou.com
 * 所有接口均为 POST + application/json
 *
 * 关键接口（实测 2026-09-04）：
 *  - 列表：/open/v1/product/collect_box/mercadolibre/collect_box/search_collect_box_detailList（小驼峰！不是 snake_case）
 *  - 详情：/open/v1/product/collect_box/mercadolibre/collect_box/get_site_collect_item_info
 *  - 站点映射：/open/v1/product/collect_box/mercadolibre/collect_box/get_auth_sites（需查真实路径）
 */

import crypto from 'crypto';

// ============ 凭证（运行时从环境变量注入）============

const APP_KEY = process.env.MIAOSHOU_APP_KEY || '';
const APP_SECRET = process.env.MIAOSHOU_APP_SECRET || '';

const BASE_URL = 'https://openapi-erp.91miaoshou.com';

if (!APP_KEY || !APP_SECRET) {
  console.warn('[Miaoshou] 警告：MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET 未配置，妙手采集箱功能不可用');
}

// ============ 签名工具============

function hmacSign(path: string, timestamp: string, bodyJson: string): string {
  const message = APP_SECRET + path + timestamp + APP_KEY + bodyJson + APP_SECRET;
  return crypto.createHmac('sha256', APP_SECRET).update(message).digest('hex');
}

// ============ 核心请求函数============

async function msRequest<T = any>(path: string, body: Record<string, any> = {}): Promise<T> {
  if (!APP_KEY || !APP_SECRET) {
    throw new Error('妙手 API 未配置 MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET');
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyJson = JSON.stringify(body);
  const sign = hmacSign(path, timestamp, bodyJson);

  const url = BASE_URL + path;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-app-key': APP_KEY,
      'x-timestamp': timestamp,
      'x-sign': sign,
    },
    body: bodyJson,
  });

  const text = await resp.text();
  const json = JSON.parse(text) as { result: string; code: string; message: string; data: any };

  if (json.result === 'fail') {
    const err: any = new Error(`[Miaoshou] ${path} → ${json.code}: ${json.message}`);
    err.code = json.code;
    throw err;
  }

  return json.data as T;
}

// ============ API 接口层============

/** 妙手美客多采集箱列表 */
export interface MiaoshouBoxItem {
  collectBoxDetailId: string;
  itemNum: string | null;
  breadcrumb: string;         // "手机配件>...>USB"
  cid: string;               // 类目 ID
  globalPrice: string;
  stock: string;
  price: string;             // 来源平台售价（1688 等）
  thumbnail: string;         // 主图 URL
  gmtCreate: string;
  title: string;
  platform: string;
  appAccountId: string;
  /** 店铺配置（含站点列表、定价模式等） */
  collectBoxDetailShop: {
    shopId: string;
    pricingMode: string;
    siteAndMaxPriceMap: Record<string, string>;
    siteAndMinPriceMap: Record<string, string>;
    siteAndPriceMap: Record<string, string>;
    /** 目标站点列表，如 ["MX(Up)","BR(Up)","CL(Up)"] */
    sites: string[];
  };
  sourceList?: Array<{ source: string; sourceItemId: string; sourceItemUrl: string }>;
}

/** 妙手美客多采集箱列表结果 */
export interface MiaoshouBoxListResult {
  detailList: MiaoshouBoxItem[];
  total?: number;
  totalRow?: number;
}

/** filter.status 可选值 */
export type BoxStatusFilter = 'notPublished' | 'timingPublish' | 'published' | '';

export async function searchMercadoCollectBox(opts: {
  pageNo?: number;
  pageSize?: number;
  status?: BoxStatusFilter;
  filterCidSite?: string; // 'CBT' | 'CROSS_BORDER'
  sourceItemIdKeyword?: string;
}): Promise<MiaoshouBoxListResult> {
  return msRequest<MiaoshouBoxListResult>(
    '/open/v1/product/collect_box/mercadolibre/collect_box/search_collect_box_detailList',
    {
      pageNo: opts.pageNo ?? 1,
      pageSize: opts.pageSize ?? 500,
      filter: {
        status: opts.status ?? 'notPublished',
        ...(opts.filterCidSite ? { filterCidSite: opts.filterCidSite } : {}),
        ...(opts.sourceItemIdKeyword ? { sourceItemIdKeyword: opts.sourceItemIdKeyword } : {}),
      },
    }
  );
}

// ============ 详情接口============

export interface MiaoshouBoxDetail {
  title: string;
  itemNum: string | null;
  notesFull: string;          // 完整描述
  notes: string;             // 简短描述
  price: string;             // 货源价
  globalPrice: string;       // 全球净收益
  originPrice: string;
  cid: string;
  cateList: string[];       // 类目路径
  breadcrumb: string;       // 类目面包屑
  sourceImgUrls: string[];   // 所有图片 URL（1688 等货源）
  videoUrl?: string;
  mainImgVideoUrl?: string;
  source: string;            // "1688" 等
  sourceItemId: string;
  sourceItemUrl: string;
  skuMap?: Record<string, any>; // 规格映射
  attributes?: Array<{ name: string; valueType: string; values: string[] }>;
  siteAndListingTypeList?: string[];
  siteAndTitleList?: string[];
  pricingMode: string;
  siteAndPriceMap?: Record<string, string>;
  collectBoxDetailShop: {
    shopId: string;
    pricingMode: string;
    sites: string[];
    siteAndPriceMap: Record<string, string>;
  };
}

export interface MiaoshouBoxDetailResult {
  /** 售卖属性规则 */
  saleAttributeRules: any[];
  /** 商品属性规则 */
  productAttributeRules: any[];
  /** SKU 属性规则 */
  skuAttributeRules: any[];
  /** 实际商品数据 */
  siteCollectItemInfo: MiaoshouBoxDetail;
}

export async function getMercadoCollectBoxDetail(detailId: string, shopId: string, cid: string): Promise<MiaoshouBoxDetailResult> {
  return msRequest<MiaoshouBoxDetailResult>(
    '/open/v1/product/collect_box/mercadolibre/collect_box/get_site_collect_item_info',
    { detailId: Number(detailId), shopId: Number(shopId), cid: Number(cid) }
  );
}

// ============ 缓存层（避免重复拉取）============

let _cachedBoxList: MiaoshouBoxItem[] | null = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟缓存

export function getCachedBoxList() {
  if (_cachedBoxList && Date.now() - _cacheTs < CACHE_TTL_MS) {
    return _cachedBoxList;
  }
  return null;
}

export async function fetchAndCacheBoxList(): Promise<MiaoshouBoxItem[]> {
  const result = await searchMercadoCollectBox({ pageSize: 500, status: 'notPublished', filterCidSite: 'CBT' });
  _cachedBoxList = result.detailList || [];
  _cacheTs = Date.now();
  return _cachedBoxList;
}

export function clearCache() {
  _cachedBoxList = null;
  _cacheTs = 0;
}
