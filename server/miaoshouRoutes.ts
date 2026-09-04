/**
 * server/miaoshouRoutes.ts
 * 妙手美客多采集箱路由与发布执行器
 */

import { Router } from 'express';
import {
  searchMercadoCollectBoxAll,
  getMercadoCollectBoxDetail,
  getCachedBoxList,
  fetchAndCacheBoxList,
  MiaoshouBoxItem,
} from './miaoshou.js';
import { createListing, ListingDraft } from './listing.js';
import { getStoreRaw, getAllStores } from './stores.js';

export const miaoshouRouter = Router();

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
    // 价格处理：妙手 globalPrice 是 USD；如无则 fallback 到原始 price
    const basePriceUsd = parseFloat(detailInfo.globalPrice || detailInfo.price || '9.99') || 9.99;
    const title = detailInfo.title || 'Product';
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
        weight: isNaN(pkgWeight) ? undefined : pkgWeight,
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

      try {
        const published = await createListing(draft);
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
      } catch (e: any) {
        console.error(`[Miaoshou Publish] 店铺 ${storeNick} 发布商品 ${itemRef.detailId} 失败:`, e.message);
        for (const s of target.sites) {
          results.push({
            detailId: itemRef.detailId,
            storeId: target.storeId,
            storeNick,
            site: s,
            success: false,
            error: e.message || '上架失败',
          });
        }
      }

      // 限速节流：每个 Listing 发布间隔 1 秒
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const successCount = results.filter((r) => r.success).length;
  res.json({
    success: successCount > 0,
    total: results.length,
    successCount,
    failCount: results.length - successCount,
    results,
  });
});
