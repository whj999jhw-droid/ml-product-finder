/**
 * server/miaoshouRoutes.ts
 * 妙手美客多采集箱路由与发布执行器
 */

import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { fileURLToPath } from 'url';
import {
  searchMercadoCollectBoxAll,
  getMercadoCollectBoxDetail,
  getCachedBoxList,
  fetchAndCacheBoxList,
  clearCache,
  setCachedBoxList,
  saveMoveCollectTask,
  MiaoshouBoxItem,
} from './miaoshou.js';
import { createListing, hasCJK, ListingDraft } from './listing.js';
import { translateToEnglish } from './aiService.js';
import { getStoreRaw, getAllStores } from './stores.js';
import {
  BACKUP_DIR,
  processAndUploadVideo,
  fetchClipStatus,
  refreshVideoRecord,
  refreshAllVideoRecords,
  getVideoRecords,
  listVideoRecordsSorted,
  backupFilePath,
  overallReview,
} from './videoClips.js';

export const miaoshouRouter = Router();

// item_id → articulo 子域名（CBT 商品必须按各站点域名访问；www.mercadolibre.com/p/{id} 是死链）
// MLM→com.mx / MLB→com.br / MLC→cl / MCO→co / MLA→com.ar / MPE→com.pe / MPT→com.uy
const ITEM_ID_TLD: Record<string, string> = {
  MLM: 'com.mx', MLB: 'com.br', MLC: 'cl', MCO: 'co',
  MLA: 'com.ar', MPE: 'com.pe', MPT: 'com.uy',
};
const itemSiteTld = (itemId?: string): string => {
  const prefix = (itemId || '').slice(0, 3);
  return ITEM_ID_TLD[prefix] || 'com.mx';
};

// ============ ML CBT 各站点费率（用于 netProceeds → listingPrice 反推） ============
// 妙手 pricingMode=netProceeds 时，globalPrice 是「目标净利润（卖家到手金额）」，
// 但 ML CBT API 的 price 字段是「listing price（买家支付价）」，ML 会自动扣佣金+支付费。
// 若不反推，实际净收益 = globalPrice × (1 - feeRate)，低于用户设定值。
// 正确做法：listingPrice = globalPrice / (1 - feeRate)，使 ML 计算后的 net_proceeds = globalPrice。
// 费率 = commissionRate + pagoFeeRate（来自 profit.ts 内置默认值）。
const ML_FEE_RATES: Record<string, number> = {
  MLM: 0.04 + 0.04,   // 墨西哥：佣金 4% + 支付 4% = 8%
  MLB: 0.125 + 0.045, // 巴西：佣金 12.5% + 支付 4.5% = 17%
  MLC: 0.12 + 0.04,   // 智利：佣金 12% + 支付 4% = 16%
  MCO: 0.12 + 0.04,   // 哥伦比亚：佣金 12% + 支付 4% = 16%
};
/** 用环境变量覆盖费率，方便后续调整 */
for (const site of Object.keys(ML_FEE_RATES)) {
  const env = process.env[`ML_FEE_RATE_${site}`];
  if (env) ML_FEE_RATES[site] = parseFloat(env);
}

// ============ 0. 发布记录持久化（防重复发布 / 已发布标记） ============
// CBT global items 一家店只能有一条同商品 listing，重复 POST 会报 listing.conflict。
// 这里把「店铺 × 妙手 detailId」的成功/冲突结果落盘，下次发布直接识别为「已发布」。

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RECORDS_FILE = path.join(__dirname, '..', 'data', 'publish-records.json');

interface PublishRecord {
  detailId: string;
  shopId: string;
  storeId: string;
  sites: string[];
  itemId?: string;
  permalink?: string;
  title: string;
  publishedAt: number;
  conflict?: boolean; // true = ML 报 listing.conflict（商品已存在，未取到新 itemId）
  /** success=已上架（含 conflict 兜底）；failed=发布失败（用户可在「未发布」tab 看到红色标记） */
  status: 'success' | 'failed';
  /** 失败原因（friendlyMlError 输出），便于用户诊断后修正重试 */
  error?: string;
  /** 失败时 ML 返回的原始错误码（如 item.dimensions / item.net_proceeds / listing.conflict） */
  errorCode?: string;
  /**
   * 上架来源：
   *  - us = 本系统发布（有 itemId/permalink）
   *  - miaoshou = 妙手侧已上传/已发布（仅知 detailId，无 ML itemId）
   *  - conflict = ML 报 listing.conflict（商品已存在）
   * 未设 = 历史记录，按 us 处理
   */
  source?: 'us' | 'miaoshou' | 'conflict';
}
interface PublishRecordsFile {
  version: number;
  records: Record<string, PublishRecord>;
}

const recKey = (storeId: string, detailId: string) => `${storeId}|${detailId}`;

let recordsCache: PublishRecordsFile = { version: 1, records: {} };

function loadRecords(): PublishRecordsFile {
  try {
    if (fs.existsSync(RECORDS_FILE)) {
      const p = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf-8'));
      if (p && typeof p === 'object' && p.records) return p as PublishRecordsFile;
    }
  } catch (e: any) {
    console.error('[Publish Records] 读取失败:', e?.message || e);
  }
  return { version: 1, records: {} };
}

recordsCache = loadRecords();

function saveRecord(rec: PublishRecord): void {
  recordsCache.records[recKey(rec.storeId, rec.detailId)] = rec;
  try {
    if (!fs.existsSync(path.dirname(RECORDS_FILE))) {
      fs.mkdirSync(path.dirname(RECORDS_FILE), { recursive: true });
    }
    fs.writeFileSync(RECORDS_FILE, JSON.stringify(recordsCache, null, 2));
  } catch (e: any) {
    console.error('[Publish Records] 写入失败:', e?.message || e);
  }
}

export function getPublishRecords(): Record<string, PublishRecord> {
  return recordsCache.records;
}

// ============ 1. 读取美客多采集箱商品列表 ============

miaoshouRouter.get('/box', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const status = (req.query.status as any) || 'notPublished';

    // 默认走 5 分钟缓存；传 ?refresh=1 时强制拉取并清空旧缓存
    // 加 Cache-Control 头避免浏览器/中间代理缓存导致「已删商品还显示」
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    let items: MiaoshouBoxItem[] = [];
    let total = 0;
    if (!refresh && getCachedBoxList()) {
      items = getCachedBoxList()!;
      total = items.length;
    } else {
      // 刷新时先清缓存，避免 fetchAndCacheBoxList 失败后旧数据残留
      clearCache();
      const result = await searchMercadoCollectBoxAll({ status, filterCidSite: 'CBT', pageSize: 500 });
      items = result.detailList || [];
      total = result.totalRow ?? result.total ?? items.length;
      // 同步更新缓存（不并行）：确保 refresh 后缓存立即反映最新列表
      setCachedBoxList(items);
    }

    res.json({
      success: true,
      total,
      items,
    });
  } catch (e: any) {
    console.error('[Miaoshou Route] 获取采集箱列表失败:', e?.message || e);
    res.status(500).json({ success: false, message: e?.message || '获取妙手采集箱列表失败' });
  }
});

// ============ 2. 获取商品完整详情（预览用） ============

miaoshouRouter.get('/box/:detailId/detail', async (req, res) => {
  // 详情接口必须禁止浏览器缓存：妙手侧改图片/SKU/属性后，
  // 如果浏览器用了旧的磁盘缓存，用户点「预览」看到的还是旧数据
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const { detailId } = req.params;
    const { shopId, cid } = req.query as { shopId: string; cid: string };

    if (!shopId || !cid) {
      return res.status(400).json({ success: false, message: '缺少 shopId 或 cid 参数' });
    }

    const detail = await getMercadoCollectBoxDetail(detailId, shopId, cid);
    // 详情接口不返回 globalPrice（全球净收益），从列表缓存补上
    // 列表接口有 globalPrice 字段（5.83），详情没有——前端需要它来显示净收益
    const cached = getCachedBoxList();
    const listItem = cached?.find((it) => it.collectBoxDetailId === detailId);
    const merged = {
      ...detail.siteCollectItemInfo,
      // 如果详情接口没返回 globalPrice，从列表补
      globalPrice: detail.siteCollectItemInfo.globalPrice || listItem?.globalPrice || '',
    };
    res.json({
      success: true,
      detail: merged,
      raw: detail,
    });
  } catch (e: any) {
    console.error(`[Miaoshou Route] 获取商品 ${req.params.detailId} 详情失败:`, e?.message || e);
    res.status(500).json({ success: false, message: e?.message || '获取商品详情失败' });
  }
});

// ============ 2.5 已发布记录（前端标记「已发布」+ 防重复提交） ============

miaoshouRouter.get('/published', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ success: true, records: getPublishRecords() });
});

miaoshouRouter.post('/published/clear', (req, res) => {
  // 前端「清除已发布标记」按钮：按 storeId+detailId 精确删除
  const { keys } = req.body as { keys?: string[] };
  if (!Array.isArray(keys) || !keys.length) {
    return res.status(400).json({ success: false, message: '缺少 keys' });
  }
  let removed = 0;
  for (const k of keys) {
    if (recordsCache.records[k]) {
      delete recordsCache.records[k];
      removed++;
    }
  }
  try {
    fs.writeFileSync(RECORDS_FILE, JSON.stringify(recordsCache, null, 2));
  } catch (e: any) {
    console.error('[Publish Records] 写入失败:', e?.message || e);
  }
  res.json({ success: true, removed });
});

// ============ 3. 一键发布到选定店铺×站点 ============

export interface PublishTarget {
  storeId: string;
  sites: string[]; // ['MLM', 'MLB', 'MLC', 'MCO']
}

export interface PublishPayload {
  /** 选中的采集箱商品详情 ID 列表 */
  items: Array<{
    detailId: string;
    shopId: string;
    cid: string;
    /** 列表接口返回的价格（美元），作为详情接口缺字段时的兜底 */
    price?: string;
    globalPrice?: string;
  }>;
  /** 目标店铺与站点的映射 */
  targets: PublishTarget[];
}

export interface PublishItemResult {
  detailId: string;
  storeId: string;
  storeNick: string;
  site: string;
  success: boolean;
  itemId?: string;
  permalink?: string;
  error?: string;
  /** 该店已存在此商品：命中本地发布记录或 ML 返回 listing.conflict（视为已发布，非错误） */
  alreadyPublished?: boolean;
}

/** 上架重试：429 与 5xx（含 users-api 瞬时熔断）指数退避；4xx 业务错误立即抛出 */
async function createListingWithRetry(draft: ListingDraft, maxAttempts = 3): Promise<any> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await createListing(draft);
    } catch (e: any) {
      const status = e?.status;
      const retriable = status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
      if (!retriable || attempt >= maxAttempts) throw e;
      const backoffMs = Math.pow(2, attempt) * 2500 + Math.random() * 1000;
      console.warn(
        `[Miaoshou Publish] 瞬时错误(${status})，${Math.round(backoffMs / 1000)}s 后重试 ${attempt}/${maxAttempts - 1}`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw new Error('上架失败');
}

/** 把 ML 常见错误码翻译成中文提示，让前端弹窗能直接看懂「错在哪、怎么办」 */
const ML_ERROR_HINTS: Record<string, string> = {
  'item.net_proceeds':
    '定价过低：美客多按站点费率计算后净收益为负。请提高售价（建议 ≥ 3.5 USD）后重试',
  'item.dimensions':
    '包装毛重过低：美客多要求填「含外箱/填充物的实际发货包装重量」，实测 < 62g 会被拒（cause_id 5125）。' +
    '请在妙手把该商品的重量改成实际包装毛重（建议 ≥ 65g）后重试',
  'item.not_allowed':
    '该类目在所选站点不可售（美客多限制该类目）。请换一个站点，或在美客多后台手动改类目',
  'listing.conflict': '该店已有此商品，已跳过重复上架',
  'body.invalid_fields': '请求参数校验失败（通常是类目或字段值不合法），详情见服务端日志',
  'body.required_fields': '请求缺少必填字段，详情见服务端日志',
  'integration.circuit_open.users-api': '美客多服务端瞬时不可用，稍后重试即可',
};

function friendlyMlError(e: any): string {
  const code = e?.code || e?.mlError?.cause?.[0]?.code;
  const raw = e?.message || '上架失败';
  // 命中已知错误码 → 给「原因 + 怎么办」；否则原样返回（message 已含 cause.message 细节）
  return code && ML_ERROR_HINTS[code] ? ML_ERROR_HINTS[code] : raw;
}

miaoshouRouter.post('/publish', async (req, res) => {
  const { items, targets } = req.body as PublishPayload;

  if (!items || !items.length) {
    return res.status(400).json({ success: false, message: '请选择要发布的商品' });
  }
  if (!targets || !targets.length) {
    return res.status(400).json({ success: false, message: '请选择发布的目标店铺和站点' });
  }

  const results: PublishItemResult[] = [];
  const stores = getAllStores();

  for (const itemRef of items) {
    // 1. 拿商品完整详情
    let detailInfo: any = null;
    try {
      const full = await getMercadoCollectBoxDetail(itemRef.detailId, itemRef.shopId, itemRef.cid);
      detailInfo = full.siteCollectItemInfo;
    } catch (e: any) {
      for (const t of targets) {
        for (const s of t.sites) {
          results.push({
            detailId: itemRef.detailId,
            storeId: t.storeId,
            storeNick: stores.find((st) => st.id === t.storeId)?.nickname || t.storeId,
            site: s,
            success: false,
            error: `拉取妙手详情失败: ${e.message}`,
          });
        }
      }
      continue;
    }

    // 2. 转为 ListingDraft 骨架
    // 定价：妙手 pricingMode=netProceeds 时，globalPrice 是「目标净利润」（卖家实际到手 USD），
    // 不是 listing price。后续会按各站点费率反推 listing price（见下方 netProceeds 转换段）。
    // 妙手 globalPrice 偶尔异常偏低（如 0.70 USD），低于 MIN_PRICE_USD 时按底价兜底上架。
    const MIN_PRICE_USD = parseFloat(process.env.MIAOSHOU_MIN_PRICE_USD || '3.5');
    // 包装毛重底价：美客多 CBT 要求填「含外箱/填充物的实际发货包装重量」（见 help/22213），
    // 实测 < 62g 一律报 item.dimensions（cause_id 5125）。妙手 skuMap.weight 常是 1688 产品净重
    // （如 Type-C 转接头 30g），不含包装必然被拒。这里按实际毛重下限兜底，可用环境变量覆盖。
    const MIN_PACKAGE_WEIGHT_G = parseFloat(process.env.MIAOSHOU_MIN_PACKAGE_WEIGHT_G || '65');
    // 妙手详情 API 的 price 字段实际返回的是 globalPrice（目标净利润），globalPrice 字段本身不返回。
    // 列表 API 的 price 是货源价（1688），globalPrice 才是目标净利润。两者语义不一致，需按优先级取值。
    const priceFromGlobal = parseFloat(detailInfo.globalPrice) || 0;
    const priceRaw = parseFloat(detailInfo.price) || 0;
    // 规则：优先详情 globalPrice → 列表 globalPrice → 详情 price（= globalPrice）→ 列表 price（= 货源价）→ 底价
    let basePriceUsd =
      priceFromGlobal ||
      parseFloat(itemRef.globalPrice) ||
      priceRaw ||
      parseFloat(itemRef.price) ||
      MIN_PRICE_USD;
    if (basePriceUsd < MIN_PRICE_USD) {
      console.log(
        `[Miaoshou Publish] 定价过低 ${basePriceUsd.toFixed(2)} USD，按底价 ${MIN_PRICE_USD} USD 上架` +
          `（商品 ${itemRef.detailId}，妙手 globalPrice=${detailInfo.globalPrice} / price=${detailInfo.price}，` +
          `如定价有误请在妙手修正后清除已发布标记重试）`
      );
      basePriceUsd = MIN_PRICE_USD;
    }
    // 中文标题必须翻译成英文：CBT 全局标题要求英文，且类目预测(domain_discovery)只认英文关键词，
    // 中文标题会导致 category_id invalid（见 listing.ts 的类目解析链路）
    let title = detailInfo.title || 'Product';
    if (hasCJK(title)) {
      const en = await translateToEnglish(title);
      if (en) {
        console.log(`[Miaoshou Publish] 标题已翻译为英文: ${en.slice(0, 60)}`);
        title = en;
      } else {
        console.warn(
          `[Miaoshou Publish] 标题翻译失败，类目预测可能不准: ${title.slice(0, 40)}`
        );
      }
    }
    // 描述优先用 notes（用户在妙手编辑后的英文描述），notesFull 是 1688 货源原始中文快照
    const description = detailInfo.notes || detailInfo.notesFull || title;

    // 图片优先用 SKU 编辑后的 imgUrls（用户在妙手选的图），回退到 sourceImgUrls（1688 货源全部图）
    // sourceImgUrls 是货源快照，用户在妙手删图不影响这个字段；SKU imgUrls 才是用户选择后的
    const skuImgUrls: string[] = [];
    for (const v of Object.values(detailInfo.skuMap || {})) {
      const sv = v as any;
      if (sv.isDelete) continue;
      for (const u of sv.imgUrls || []) {
        if (!skuImgUrls.includes(u)) skuImgUrls.push(u);
      }
    }
    const pictureUrls = (skuImgUrls.length > 0 ? skuImgUrls : detailInfo.sourceImgUrls || []).slice(0, 9);

    // ---- 从 skuMap 提取重量/尺寸/SKU 信息（妙手编辑过的数据都在这里）----
    const skuMap: Record<string, any> = detailInfo.skuMap || {};
    const skuList = Object.entries(skuMap)
      .filter(([, v]: any) => !v.isDelete)
      .map(([k, v]: any) => ({ key: k, ...v }));

    // 取第一个有效 SKU 的包裹尺寸/重量作为整条 Listing 的 PACKAGE_* 属性
    // （CBT global items 单 Listing 只有一套包裹属性，多 SKU 变体共享）
    const firstSku = skuList[0];
    const pkgWeight = firstSku ? parseFloat(firstSku.weight) : NaN;
    const pkgLength = firstSku ? parseFloat(firstSku.length) : NaN;
    const pkgWidth = firstSku ? parseFloat(firstSku.width) : NaN;
    const pkgHeight = firstSku ? parseFloat(firstSku.height) : NaN;

    // 多 SKU：传给 createListing，会追加到描述并补充 SKU 图片
    const skusForDraft = skuList.map((s: any) => ({
      title: s.itemNum || s.goodsSkuId || s.skuKey || 'SKU',
      imageUrl: (s.imgUrls && s.imgUrls[0]) || '',
    }));

    // 总库存 = 各 SKU 库存之和；无 SKU 时用 detailInfo.stock
    const totalStock =
      skuList.length > 0
        ? skuList.reduce((sum: number, s: any) => sum + (parseInt(s.stock, 10) || 0), 0)
        : parseInt(detailInfo.stock || '10', 10) || 10;

    // UPC/GTIN：所有 SKU 都有相同 upc 时才作为属性传（美客多变体 UPC 需逐变体，暂不拆变体）
    const upcSet = new Set(skuList.map((s: any) => (s.upc || '').trim()).filter(Boolean));
    const commonUpc = upcSet.size === 1 ? [...upcSet][0] : '';

    // 每站点 listing 类型映射：妙手 "MX(Up)" → ML "MLM"；优先 SKU 级 siteAndListingTypeInfoMap，
    // 回退顶层 siteAndListingTypeList
    const msSiteToMl: Record<string, string> = {
      'MX(Up)': 'MLM',
      'BR(Up)': 'MLB',
      'CL(Up)': 'MLC',
      'CO(Up)': 'MCO',
    };
    const siteListingTypeFromSku: Record<string, string> = {};
    if (firstSku?.siteAndListingTypeInfoMap) {
      for (const [msSite, info] of Object.entries(firstSku.siteAndListingTypeInfoMap as any)) {
        const ml = msSiteToMl[msSite];
        if (ml && (info as any)?.listingType) siteListingTypeFromSku[ml] = (info as any).listingType;
      }
    }
    const siteListingTypeTop: Record<string, string> = {};
    for (const entry of detailInfo.siteAndListingTypeList || []) {
      const ml = msSiteToMl[entry.site];
      if (ml && entry.listingType) siteListingTypeTop[ml] = entry.listingType;
    }

    // 每站点自定义标题（用户在妙手按站点编辑的英文标题，非空才用）
    const siteTitleMap: Record<string, string> = {};
    for (const entry of detailInfo.siteAndTitleList || []) {
      const ml = msSiteToMl[entry.site];
      if (ml && entry.title && entry.title.trim()) siteTitleMap[ml] = entry.title.trim();
    }
    // 站点标题若是中文，同样翻译成英文（妙手 siteAndTitleList 多为空，这里只是兜底）
    for (const [ml, st] of Object.entries(siteTitleMap)) {
      if (hasCJK(st)) {
        const en = await translateToEnglish(st);
        if (en) siteTitleMap[ml] = en;
      }
    }

    // 各站点独立定价：妙手 siteAndPriceMap 非空时按站点定价，否则用 globalPrice
    // 妙手 siteAndPriceMap key 格式 "MX(Up)"，值是 USD 字符串（如 "5.83"），空串表示未设置
    const sitePriceMap: Record<string, number> = {};
    for (const [msSite, priceStr] of Object.entries(detailInfo.siteAndPriceMap || {})) {
      const ml = msSiteToMl[msSite];
      const price = parseFloat(priceStr as string);
      if (ml && price > 0) sitePriceMap[ml] = price;
    }
    // 列表接口的 siteAndPriceMap 在 collectBoxDetailShop 里，也合并进来
    const cached2 = getCachedBoxList();
    const listItem2 = cached2?.find((it) => it.collectBoxDetailId === itemRef.detailId);
    if (listItem2?.collectBoxDetailShop?.siteAndPriceMap) {
      for (const [msSite, priceStr] of Object.entries(listItem2.collectBoxDetailShop.siteAndPriceMap)) {
        const ml = msSiteToMl[msSite];
        const price = parseFloat(priceStr);
        if (ml && price > 0 && !sitePriceMap[ml]) sitePriceMap[ml] = price;
      }
    }

    // ============ netProceeds → listingPrice 反推 ============
    // 妙手 pricingMode=netProceeds 时，globalPrice / siteAndPriceMap 的值是「目标净利润」，
    // 但 ML CBT API 的 price 字段是「listing price（买家支付价）」，ML 会自动扣佣金+支付费。
    // 直接发送 globalPrice 会导致实际净收益 = globalPrice × (1 - feeRate)，低于用户设定值。
    // 修复：listingPrice = netProfitTarget / (1 - feeRate)，使 ML 计算后的 net_proceeds = 目标净利润。
    const pricingMode = detailInfo.pricingMode || '';
    const isNetProceeds = pricingMode === 'netProceeds';

    // 3. 逐店铺执行（每个店铺按 CBT 模型发布一个 Listing，挂勾选的站点）
    for (const target of targets) {
      const store = getStoreRaw(target.storeId);
      const storeNick = store?.nickname || target.storeId;

      if (!target.sites || !target.sites.length) continue;

      // 组装 CBT sites_to_sell：逐站点独立 price / listing_type / title（妙手编辑值优先）
      // netProceeds 模式下按各站点费率反推 listing price，确保 ML 计算后的净收益 = 目标净利润
      const sitesToSell = target.sites.map((siteId) => {
        const feeRate = ML_FEE_RATES[siteId] || 0;
        const rawPrice = sitePriceMap[siteId] || basePriceUsd;
        const listingPrice = isNetProceeds
          ? rawPrice / Math.max(1 - feeRate, 0.01)
          : rawPrice;
        const rounded = Math.round(listingPrice * 100) / 100;
        if (isNetProceeds) {
          console.log(
            `[Miaoshou Publish] ${itemRef.detailId} ${siteId}: 目标净利润 ${rawPrice.toFixed(2)} USD` +
              ` × 费率 ${feeRate} → listing price ${rounded.toFixed(2)} USD`
          );
        }
        return {
          site_id: siteId,
          price: rounded,
          listing_type_id:
            siteListingTypeFromSku[siteId] || siteListingTypeTop[siteId] || 'gold_special',
          title: siteTitleMap[siteId] || title,
        };
      });

      // 主站点 listing price（draft.price 用于单站点回退）
      const mainSiteId = target.sites[0];
      const mainFeeRate = ML_FEE_RATES[mainSiteId] || 0;
      const draftListingPrice = isNetProceeds
        ? basePriceUsd / Math.max(1 - mainFeeRate, 0.01)
        : basePriceUsd;
      const draftPriceRounded = Math.round(draftListingPrice * 100) / 100;

      // 构造 ListingDraft
      const draft: ListingDraft = {
        site: target.sites[0], // 主站点
        storeId: target.storeId,
        title: title,
        category_id: detailInfo.cid || 'MLM1051', // 回退常用分类
        price: draftPriceRounded,
        currency_id: 'USD',
        available_quantity: totalStock,
        description: description,
        pictureUrls: pictureUrls,
        brand: 'Generic',
        // 包装毛重兜底：低于美客多实测下限（约 62g）会被 item.dimensions 拒绝，按下限值上架
        weight: pkgWeight > 0 && pkgWeight < MIN_PACKAGE_WEIGHT_G
          ? (console.log(
              `[Miaoshou Publish] ${itemRef.detailId} 包装毛重 ${pkgWeight}g 低于美客多实测下限，` +
                `按 ${MIN_PACKAGE_WEIGHT_G}g 上架（建议在妙手改成真实包装毛重）`,
            ), MIN_PACKAGE_WEIGHT_G)
          : isNaN(pkgWeight)
            ? undefined
            : pkgWeight,
        length: isNaN(pkgLength) ? undefined : pkgLength,
        width: isNaN(pkgWidth) ? undefined : pkgWidth,
        height: isNaN(pkgHeight) ? undefined : pkgHeight,
        skus: skusForDraft.length > 1 ? skusForDraft : undefined,
        seller_custom_field: detailInfo.itemNum || undefined,
        ...(commonUpc
          ? {
              attributes: [{ id: 'UPC', value_name: commonUpc }],
            }
          : {}),
        sites_to_sell: sitesToSell,
      };

      // 0) 本地发布记录命中 → 仅在 status=success 时跳过（已上架）；failed 记录允许重试
      const existing = recordsCache.records[recKey(target.storeId, itemRef.detailId)];
      if (existing && existing.sites.length > 0 && existing.status !== 'failed') {
        for (const s of target.sites) {
          results.push({
            detailId: itemRef.detailId,
            storeId: target.storeId,
            storeNick,
            site: s,
            success: false,
            alreadyPublished: true,
            itemId: existing.itemId,
            permalink: existing.permalink,
            error: `该店已发布（${existing.sites.join('/')}），已跳过重复上架`,
          });
        }
        continue;
      }

      try {
        const published = await createListingWithRetry(draft);
        // CBT 返回 site_items[]，每站点有独立 item_id，按站点回填
        const siteItems = published.siteItems || [];
        const bySite = new Map(siteItems.map((si: any) => [String(si?.site_id), si]));
        for (const s of target.sites) {
          const si = bySite.get(s);
          results.push({
            detailId: itemRef.detailId,
            storeId: target.storeId,
            storeNick,
            site: s,
            success: true,
            itemId: si?.item_id || published.itemId,
            permalink:
              si?.item_id
                ? `https://articulo.mercadolibre.${itemSiteTld(si?.item_id)}/p/${si.item_id}`
                : published.permalink,
          });
        }
        // 只有真正拿到 item_id 才记为已发布，避免把「ML 返回 200 但没上架」当成成功
        if (published.itemId) {
          saveRecord({
            detailId: itemRef.detailId,
            shopId: itemRef.shopId,
            storeId: target.storeId,
            sites: target.sites,
            itemId: published.itemId,
            permalink: published.permalink,
            title,
            publishedAt: Date.now(),
            status: 'success',
          });
          console.log(
            `[Miaoshou Publish] 店铺 ${storeNick} 已发布商品 ${itemRef.detailId} -> ${published.itemId}`
          );
          // 同步妙手状态：发布成功后调用 save_move_collect_task 将商品从采集箱移除
          // （best effort：失败不影响发布结果，仅打日志）
          try {
            const msSync = await saveMoveCollectTask([Number(itemRef.detailId)]);
            console.log(
              `[Miaoshou Publish] 妙手状态同步: detailId=${itemRef.detailId} → ${msSync.result} ${msSync.message}`
            );
          } catch (syncErr: any) {
            console.warn(
              `[Miaoshou Publish] 妙手状态同步失败（不影响发布）: ${syncErr.message}`
            );
          }

          // 视频处理：如果商品有 1688 视频，自动下载→转换为 ML Clips 格式→上传
          const videoUrl = detailInfo.mainImgVideoUrl || detailInfo.videoUrl;
          if (videoUrl && published.itemId) {
            const clipSites = target.sites.filter((s) => ['MLM', 'MLB', 'MLC', 'MCO'].includes(s));
            if (clipSites.length > 0) {
              try {
                const vidResult = await processAndUploadVideo({
                  detailId: itemRef.detailId,
                  mainImgVideoUrl: videoUrl,
                  cbtItemId: published.itemId,
                  siteIds: clipSites,
                  storeId: target.storeId,
                });
                if (vidResult.success) {
                  console.log(`[Miaoshou Publish] ${itemRef.detailId} 视频已上传至 ML Clips`);
                } else {
                  console.warn(
                    `[Miaoshou Publish] ${itemRef.detailId} 视频处理失败(${vidResult.stage}): ${vidResult.error}`
                  );
                }
              } catch (vidErr: any) {
                console.warn(`[Miaoshou Publish] ${itemRef.detailId} 视频处理异常: ${vidErr.message}`);
              }
            }
          }
        }
      } catch (e: any) {
        const code = e?.mlError?.cause?.[0]?.code;
        if (code === 'listing.conflict' || /listing\.conflict|already exists/i.test(e?.message || '')) {
          // CBT 一店一品：商品已存在（可能由其他渠道或历史发布上架）→ 标记为已发布，不再报错
          saveRecord({
            detailId: itemRef.detailId,
            shopId: itemRef.shopId,
            storeId: target.storeId,
            sites: target.sites,
            title,
            publishedAt: Date.now(),
            conflict: true,
            status: 'success',
          });
          console.warn(
            `[Miaoshou Publish] 店铺 ${storeNick} 商品 ${itemRef.detailId} 已存在(listing.conflict)，标记为已发布`
          );
          // 冲突场景也同步妙手状态
          try {
            const msSync = await saveMoveCollectTask([Number(itemRef.detailId)]);
            console.log(
              `[Miaoshou Publish] 妙手状态同步(conflict): detailId=${itemRef.detailId} → ${msSync.result}`
            );
          } catch (syncErr: any) {
            console.warn(
              `[Miaoshou Publish] 妙手状态同步失败(conflict): ${syncErr.message}`
            );
          }
          for (const s of target.sites) {
            results.push({
              detailId: itemRef.detailId,
              storeId: target.storeId,
              storeNick,
              site: s,
              success: false,
              alreadyPublished: true,
              error: '该店已有此商品(listing.conflict)，未重复上架',
            });
          }
        } else {
          const errorCode = e?.mlError?.cause?.[0]?.code || e?.code || '';
          const errorMsg = friendlyMlError(e);
          console.error(
            `[Miaoshou Publish] 店铺 ${storeNick} 发布商品 ${itemRef.detailId} 失败 [${errorCode}]:`,
            e.message
          );
          // 保存失败记录：前端「未发布」tab 据此标注「发布失败」红色标签，便于用户诊断修正
          // 覆盖语义：若同一 storeId|detailId 之前是 failed，本次重试成功会覆盖为 success；反之亦然
          saveRecord({
            detailId: itemRef.detailId,
            shopId: itemRef.shopId,
            storeId: target.storeId,
            sites: target.sites,
            title,
            publishedAt: Date.now(),
            status: 'failed',
            error: errorMsg,
            errorCode,
          });
          for (const s of target.sites) {
            results.push({
              detailId: itemRef.detailId,
              storeId: target.storeId,
              storeNick,
              site: s,
              success: false,
              error: errorMsg,
            });
          }
        }
      }

      // 限速节流：每个 Listing 发布间隔 1 秒
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const alreadyCount = results.filter((r) => r.alreadyPublished).length;
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount - alreadyCount;
  res.json({
    success: successCount > 0 || alreadyCount > 0,
    total: results.length,
    successCount,
    alreadyPublishedCount: alreadyCount,
    failCount,
    results,
  });
});

// ============ 视频处理 API（上传 / 刷新 / 记录 / 播放） ============

/** 妙手站点标记 → ML 站点码 */
const MS_SITE_TO_ML: Record<string, string> = {
  'MX(Up)': 'MLM', 'BR(Up)': 'MLB', 'CL(Up)': 'MLC', 'CO(Up)': 'MCO',
};
const msSitesToMl = (sites: string[]) =>
  sites.map((s) => MS_SITE_TO_ML[s] || s).filter((s) => ['MLM', 'MLB', 'MLC', 'MCO'].includes(s));

/**
 * POST /video/upload
 * 为已上架商品自动生成合规视频并上传 ML Clips
 *
 * body: {
 *   detailId: string,           // 妙手采集箱 detailId
 *   itemId: string,             // ML CBT item_id（如 CBT5169919624）
 *   storeId: string,            // 店铺 UUID
 *   sites?: string[],           // 目标站点，默认 ['MLM']
 *   shopId?: string,            // 妙手 shopId，默认 12637644
 *   mainImgVideoUrl?: string,   // 直接给视频 URL 可跳过详情查询
 *   title?: string,
 *   force?: boolean             // 强制重新上传（忽略 ML 已有 clip）
 * }
 *
 * 上传成功后同步妙手状态（save_move_collect_task），妙手侧也标记为已上传。
 */
miaoshouRouter.post('/video/upload', async (req, res) => {
  const { detailId, itemId, storeId, sites, shopId, mainImgVideoUrl, title, force } = req.body as {
    detailId: string; itemId: string; storeId: string;
    sites?: string[]; shopId?: string; mainImgVideoUrl?: string; title?: string; force?: boolean;
  };
  if (!detailId || !itemId || !storeId) {
    return res.status(400).json({ success: false, error: '缺少 detailId/itemId/storeId' });
  }
  try {
    let videoUrl = mainImgVideoUrl;
    let finalTitle = title;
    if (!videoUrl) {
      const detail = await getMercadoCollectBoxDetail(String(detailId), shopId || '12637644', '0');
      const info = detail?.siteCollectItemInfo || {};
      videoUrl = info.mainImgVideoUrl || info.videoUrl;
      finalTitle = finalTitle || info.title;
    }
    if (!videoUrl) {
      return res.json({ success: false, error: '该商品无 1688 视频', stage: 'check' });
    }
    const clipSites = msSitesToMl(sites || []).length > 0 ? msSitesToMl(sites!) : ['MLM'];
    const result = await processAndUploadVideo({
      detailId: String(detailId),
      mainImgVideoUrl: videoUrl,
      cbtItemId: String(itemId),
      siteIds: clipSites,
      storeId,
      title: finalTitle,
      force: !!force,
    });
    // 上传成功 → 同步妙手采集箱状态（best effort，失败不影响结果）
    if (result.success) {
      try {
        const msSync = await saveMoveCollectTask([Number(detailId)]);
        console.log(`[Video] 妙手状态同步: detailId=${detailId} → ${msSync.result} ${msSync.message}`);
      } catch (syncErr: any) {
        console.warn(`[Video] 妙手状态同步失败（不影响视频上传）: ${syncErr.message}`);
      }
    }
    res.json(result);
  } catch (e: any) {
    console.error(`[Video] upload 异常: ${e.message}`);
    res.json({ success: false, error: e.message, stage: 'error' });
  }
});

/**
 * POST /video/refresh
 * 刷新 ML Clips 上传 / 审核状态
 *
 * - 有 clip → 同步各站点审核状态（UNDER_REVIEW → AVAILABLE / REJECTED）
 * - 无 clip（被拒/被删/从未上传）→ 按失败原因自动重传（优先复用服务器备份）
 *
 * body:
 *   {}                        → 刷新全部记录
 *   { key: "storeId|detailId" } → 刷新单条
 *   { storeId, detailId }     → 刷新单条
 *   { forceReupload: true }   → 强制重新上传（即使 ML 已有 clip）
 */
miaoshouRouter.post('/video/refresh', async (req, res) => {
  const { key, storeId, detailId, forceReupload } = req.body as {
    key?: string; storeId?: string; detailId?: string; forceReupload?: boolean;
  };
  const force = !!forceReupload;
  try {
    const all = getVideoRecords();

    if (key || (storeId && detailId)) {
      const k = key || recKey(String(storeId), String(detailId));
      const rec = all[k];
      if (!rec) {
        return res.json({ success: false, error: `无视频记录：${k}` });
      }
      const updated = await refreshVideoRecord(rec, { forceReupload: force });
      return res.json({ success: true, record: updated });
    }

    // 批量：串行处理，避免同时打爆 ML Clips API
    const stats = await refreshAllVideoRecords(force);
    res.json({ success: true, ...stats, records: listVideoRecordsSorted() });
  } catch (e: any) {
    console.error(`[Video] refresh 异常: ${e.message}`);
    res.json({ success: false, error: e.message });
  }
});

/**
 * GET /video/status/:itemId
 * 查询指定 ML 商品的 Clips 状态，并同步到视频记录
 * query: ?storeId=<UUID>&detailId=<妙手detailId>
 */
miaoshouRouter.get('/video/status/:itemId', async (req, res) => {
  const { itemId } = req.params;
  const storeId = req.query.storeId as string;
  const detailId = req.query.detailId as string | undefined;
  if (!storeId) return res.status(400).json({ success: false, error: '缺少 storeId' });
  const store = getStoreRaw(storeId);
  if (!store?.accessToken) return res.json({ success: false, error: '店铺无 token' });
  try {
    // 有对应记录则走完整刷新（查状态 + 无 clip 时自动重传），保证前端看到最新审核状态
    const k = detailId ? recKey(storeId, detailId) : '';
    const cur = k ? getVideoRecords()[k] : undefined;
    if (cur) {
      const updated = await refreshVideoRecord(cur, {});
      const st = updated.siteStatuses;
      return res.json({
        success: true,
        itemId,
        siteCount: Object.values(st).filter(Boolean).length,
        siteStatuses: st,
        review: overallReview(st),
        record: updated,
      });
    }
    const st = await fetchClipStatus(itemId, storeId);
    res.json({
      success: true,
      itemId,
      clipCount: st.clipCount,
      clipUuids: st.clipUuids,
      siteStatuses: st.siteStatuses,
      review: overallReview(st.siteStatuses),
      error: st.error,
    });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

/**
 * GET /video/records
 * 全部视频处理记录（按上传时间倒序），含备份路径与综合审核结论
 */
miaoshouRouter.get('/video/records', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  // 同一个 detailId 可能有多个店铺的记录（每个店铺一条），但备份视频是按
  // detailId 全局共享一份的（BACKUP_DIR/<detailId>.mp4）。所以 hasBackup 必须
  // 按 detailId 判定：只要任一店铺的记录里有可用备份，该 detailId 就算有备份。
  // 否则「查看视频」按钮会因落在没有 backupFile 的那条记录上而隐藏。
  const recsByDetail = new Map<string, any[]>();
  for (const r of Object.values(getVideoRecords())) {
    const arr = recsByDetail.get(r.detailId);
    if (arr) arr.push(r); else recsByDetail.set(r.detailId, [r]);
  }
  const hasBackupFor = (d: string): boolean => {
    const direct = path.join(BACKUP_DIR, `${d}.mp4`);
    if (fs.existsSync(direct) && fs.statSync(direct).size >= 1000) return true;
    return (recsByDetail.get(d) || []).some((r) => r.backupFile && fs.existsSync(backupFilePath(r)));
  };
  const items = listVideoRecordsSorted().map((r) => ({
    ...r,
    hasBackup: hasBackupFor(r.detailId),
    review: overallReview(r.siteStatuses),
  }));
  res.json({ success: true, total: items.length, items, records: getVideoRecords() });
});

/**
 * GET /video/file/:detailId
 * 播放服务器备份的合规视频（用于「查看视频」）
 * 同一 detailId 可能有多条店铺记录，只有实际做过转换的那条才有 backupFile，
 * 因此必须挑有 backupFile 的记录，并回退到 BACKUP_DIR/<detailId>.mp4。
 */
miaoshouRouter.get('/video/file/:detailId', (req, res) => {
  const { detailId } = req.params;
  const all = Object.values(getVideoRecords()).filter((r) => r.detailId === String(detailId));
  const rec = all.find((r) => r.backupFile) || all[0];
  const p = (rec && rec.backupFile && fs.existsSync(backupFilePath(rec)))
    ? backupFilePath(rec)
    : path.join(BACKUP_DIR, `${detailId}.mp4`);
  if (!p || !fs.existsSync(p) || fs.statSync(p).size < 1000) {
    return res.status(404).json({ success: false, error: '无服务器备份视频' });
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'video/mp4');
  return res.sendFile(p);
});

// ============ 妙手侧已发布同步（妙手 ERP 已上传 → 本系统也显示已上传） ============

/** 妙手虚拟店铺 key：无 ML 店铺归属时归到这里，不会阻断其它店铺上架 */
export const MIAOSHOU_VIRTUAL_STORE = 'miaoshou-erp';

/**
 * POST /published/sync-miaoshou
 * 拉取妙手采集箱「已发布」商品，合并进本系统发布记录（source=miaoshou）。
 * 用途：妙手侧有上传限流对策会自己上架；这些商品会从妙手「未发布」列表消失，
 * 不同步就看不到。同步后在「已发布」tab 显示，并按上传时间倒序。
 */
miaoshouRouter.post('/published/sync-miaoshou', async (_req, res) => {
  try {
    const result = await searchMercadoCollectBoxAll({ status: 'published', filterCidSite: 'CBT', pageSize: 500 });
    const msList = result.detailList || [];
    // 尝试用 妙手 appAccountId 匹配本系统的 mlUserId，能对上就归到真实店铺
    const stores = getAllStores().filter((s) => s.authorized && s.enabled);
    let added = 0;
    let skipped = 0;
    for (const it of msList) {
      const detailId = String(it.collectBoxDetailId);
      const msSites = msSitesToMl(it.collectBoxDetailShop?.sites || []);
      const accId = String(it.appAccountId || '');
      const matched = stores.find((s) => s.mlUserId && String(s.mlUserId) === accId);
      const targetStoreId = matched ? matched.id : MIAOSHOU_VIRTUAL_STORE;
      const key = recKey(targetStoreId, detailId);
      if (recordsCache.records[key]) {
        skipped++;
        continue;
      }
      const msTs = Date.parse(it.gmtCreate);
      saveRecord({
        detailId,
        shopId: String(it.collectBoxDetailShop?.shopId || '12637644'),
        storeId: targetStoreId,
        sites: msSites,
        title: it.title,
        publishedAt: Number.isFinite(msTs) && msTs > 0 ? msTs : Date.now(),
        status: 'success',
        source: 'miaoshou',
        conflict: true,
      });
      added++;
    }
    res.json({
      success: true,
      miaoshouPublished: msList.length,
      added,
      skipped,
      records: getPublishRecords(),
    });
  } catch (e: any) {
    console.error('[Miaoshou Sync] 同步妙手已发布失败:', e?.message || e);
    res.json({ success: false, error: e?.message || '同步失败' });
  }
});
