/**
 * server/miaoshouRoutes.ts
 * 妙手美客多采集箱路由与发布执行器
 */

import { Router } from 'express';
import {
  searchMercadoCollectBox,
  getMercadoCollectBoxDetail,
  getCachedBoxList,
  fetchAndCacheBoxList,
  clearCache,
  MiaoshouBoxItem,
} from './miaoshou.js';
import { createListing, ListingDraft } from './listing.js';
import { getStoreRaw, getAllStores } from './stores.js';

export const miaoshouRouter = Router();

// ============ 1. 读取美客多采集箱商品列表 ============

miaoshouRouter.get('/box', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const pageNo = Number(req.query.pageNo || 1);
    const pageSize = Number(req.query.pageSize || 50);
    const status = (req.query.status as any) || 'notPublished';

    // 默认走 5 分钟缓存；传 ?refresh=1 时强制拉取
    let items: MiaoshouBoxItem[] = [];
    if (!refresh && pageNo === 1 && getCachedBoxList()) {
      items = getCachedBoxList()!;
    } else {
      const result = await searchMercadoCollectBox({ pageNo, pageSize, status, filterCidSite: 'CBT' });
      items = result.detailList || [];
      if (pageNo === 1) fetchAndCacheBoxList().catch(() => {});
    }

    res.json({
      success: true,
      total: items.length,
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

    // 3. 逐店铺执行（每个店铺按 CBT 模型发布一个 Listing，挂勾选的站点）
    for (const target of targets) {
      const store = getStoreRaw(target.storeId);
      const storeNick = store?.nickname || target.storeId;

      if (!target.sites || !target.sites.length) continue;

      // 组装 CBT sites_to_sell：针对每个站点配置价格与 listing_type
      const sitesToSell = target.sites.map((siteId) => ({
        site_id: siteId,
        price: basePriceUsd,
        listing_type_id: 'gold_special',
        title: title,
      }));

      // 构造 ListingDraft
      const draft: ListingDraft = {
        site: target.sites[0], // 主站点
        storeId: target.storeId,
        title: title,
        category_id: detailInfo.cid || 'MLM1051', // 回退常用分类
        price: basePriceUsd,
        currency_id: 'USD',
        available_quantity: parseInt(detailInfo.stock || '10', 10) || 10,
        description: description,
        pictureUrls: pictureUrls,
        brand: 'Generic',
        sites_to_sell: sitesToSell,
      };

      try {
        const published = await createListing(draft);
        for (const s of target.sites) {
          results.push({
            detailId: itemRef.detailId,
            storeId: target.storeId,
            storeNick,
            site: s,
            success: true,
            itemId: published.itemId,
            permalink: published.permalink,
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
