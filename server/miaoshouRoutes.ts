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
  MiaoshouBoxItem,
} from './miaoshou.js';
import { createListing, hasCJK, ListingDraft } from './listing.js';
import { translateToEnglish } from './aiService.js';
import { getStoreRaw, getAllStores } from './stores.js';

export const miaoshouRouter = Router();

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

    // 默认走 5 分钟缓存；传 ?refresh=1 时强制拉取
    let items: MiaoshouBoxItem[] = [];
    let total = 0;
    if (!refresh && getCachedBoxList()) {
      items = getCachedBoxList()!;
      total = items.length;
    } else {
      const result = await searchMercadoCollectBoxAll({ status, filterCidSite: 'CBT', pageSize: 500 });
      items = result.detailList || [];
      total = result.totalRow ?? result.total ?? items.length;
      if (fetchAndCacheBoxList) fetchAndCacheBoxList().catch(() => {});
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
  try {
    const { detailId } = req.params;
    const { shopId, cid } = req.query as { shopId: string; cid: string };

    if (!shopId || !cid) {
      return res.status(400).json({ success: false, message: '缺少 shopId 或 cid 参数' });
    }

    const detail = await getMercadoCollectBoxDetail(detailId, shopId, cid);
    res.json({
      success: true,
      detail: detail.siteCollectItemInfo,
      raw: detail,
    });
  } catch (e: any) {
    console.error(`[Miaoshou Route] 获取商品 ${req.params.detailId} 详情失败:`, e?.message || e);
    res.status(500).json({ success: false, message: e?.message || '获取商品详情失败' });
  }
});

// ============ 2.5 已发布记录（前端标记「已发布」+ 防重复提交） ============

miaoshouRouter.get('/published', (_req, res) => {
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
    // 定价：妙手 globalPrice 是 USD 估算价，但经常异常偏低（如 0.70 USD），会被美客多按
    // 站点费率计算成「净收益为负」（item.net_proceeds），直接拒绝上架。
    const MIN_PRICE_USD = parseFloat(process.env.MIAOSHOU_MIN_PRICE_USD || '3.5');
    // 包装毛重底价：美客多 CBT 要求填「含外箱/填充物的实际发货包装重量」（见 help/22213），
    // 实测 < 62g 一律报 item.dimensions（cause_id 5125）。妙手 skuMap.weight 常是 1688 产品净重
    // （如 Type-C 转接头 30g），不含包装必然被拒。这里按实际毛重下限兜底，可用环境变量覆盖。
    const MIN_PACKAGE_WEIGHT_G = parseFloat(process.env.MIAOSHOU_MIN_PACKAGE_WEIGHT_G || '65');
    const priceFromGlobal = parseFloat(detailInfo.globalPrice) || 0;
    const priceRaw = parseFloat(detailInfo.price) || 0;
    // 规则：优先详情 globalPrice → 列表 globalPrice → 详情 price → 列表 price → 底价
    // （妙手详情与列表的 price 语义不一致：详情 price 常是 0.7 这类异常值，列表 price 更靠谱）
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
    const description = detailInfo.notesFull || detailInfo.notes || title;
    const pictureUrls = (detailInfo.sourceImgUrls || []).slice(0, 9); // 最多 9 张主图

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

    // 3. 逐店铺执行（每个店铺按 CBT 模型发布一个 Listing，挂勾选的站点）
    for (const target of targets) {
      const store = getStoreRaw(target.storeId);
      const storeNick = store?.nickname || target.storeId;

      if (!target.sites || !target.sites.length) continue;

      // 组装 CBT sites_to_sell：逐站点独立 listing_type 与标题（妙手编辑值优先）
      const sitesToSell = target.sites.map((siteId) => ({
        site_id: siteId,
        price: basePriceUsd,
        listing_type_id:
          siteListingTypeFromSku[siteId] || siteListingTypeTop[siteId] || 'gold_special',
        title: siteTitleMap[siteId] || title,
      }));

      // 构造 ListingDraft
      const draft: ListingDraft = {
        site: target.sites[0], // 主站点
        storeId: target.storeId,
        title: title,
        category_id: detailInfo.cid || 'MLM1051', // 回退常用分类
        price: basePriceUsd,
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

      // 0) 本地发布记录命中 → 直接标记「已发布」，不再重复调 ML（CBT 一店一品，重复必报 conflict）
      const existing = recordsCache.records[recKey(target.storeId, itemRef.detailId)];
      if (existing && existing.sites.length > 0) {
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
                ? `https://www.mercadolibre.com/p/${si.item_id}`
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
          });
          console.log(
            `[Miaoshou Publish] 店铺 ${storeNick} 已发布商品 ${itemRef.detailId} -> ${published.itemId}`
          );
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
          });
          console.warn(
            `[Miaoshou Publish] 店铺 ${storeNick} 商品 ${itemRef.detailId} 已存在(listing.conflict)，标记为已发布`
          );
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
          console.error(
            `[Miaoshou Publish] 店铺 ${storeNick} 发布商品 ${itemRef.detailId} 失败:`,
            e.message
          );
          for (const s of target.sites) {
            results.push({
              detailId: itemRef.detailId,
              storeId: target.storeId,
              storeNick,
              site: s,
            success: false,
            error: friendlyMlError(e),
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
