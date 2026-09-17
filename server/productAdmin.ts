/**
 * server/productAdmin.ts
 * 商品管理后台路由（挂在 /api/ml/product-admin）
 *
 *  - GET  /index                    各店铺索引状态（构建中/已建/统计）
 *  - GET  /:storeId/items           分店铺商品列表（状态/违规风险筛选 + 搜索 + 分页）
 *  - GET  /:storeId/item/:itemId    单件商品全部字段（含描述、本地站点商品、合规化预览）
 *  - POST /:storeId/compliance-fix  一键改为符合规范（dryRun 预览 / 执行）
 *  - POST /:storeId/refresh         强制重建索引
 *
 * ⚠️ 核心事实（2026-09-17 实测，别推翻）：
 *  CBT 商品（CBTxxxx）对本店铺 token 是**只读**的 ——
 *    PUT /items/{CBT}          → 400 `Cannot modify CBT item from this resource`
 *    PUT /marketplace/items/{CBT} → 405
 *    本地站点商品（MLM…/MLB…）→ 403（归属另一个 user_id，本 token 无权）
 *    删除 → 405
 *  所以「一键改为符合规范」对 CBT 商品只能走**克隆清洗重发**：
 *    读原商品 → 洗标题/属性/描述 → POST /global/items 建一条全新的合规链接。
 *  原链接依然无法用 API 暂停/删除，必须到 ML 卖家后台人工处理 —— UI 上已明确提示。
 */

import { Router } from 'express';
import { getAllStores, getStoreRaw, storeApiGet, ensureStoreToken } from './stores.js';
import { getMlApiBase } from './mercadolibre.js';
import {
  buildIndex,
  ensureIndex,
  getIndex,
  listItems,
  getItemFullDetail,
  buildCompliancePreview,
  scanItemRisk,
} from './storeItems.js';
import { sanitizeComplianceText } from './bannedWords.js';

export const productAdminRouter = Router();

/** 授权且启用的店铺 */
function activeStores() {
  return getAllStores().filter((s) => s.authorized !== false && s.enabled !== false);
}

// ============ 索引状态 / 构建 ============

productAdminRouter.get('/index', async (req, res) => {
  const refresh = req.query.refresh === '1';
  const only = (req.query.storeId as string) || '';
  const stores = activeStores().filter((s) => !only || s.id === only);
  const out = stores.map((s) => {
    const idx = getIndex(s.id);
    return {
      storeId: s.id,
      storeNick: s.nickname || s.id.slice(0, 8),
      site: s.site,
      authorized: s.authorized !== false,
      enabled: s.enabled !== false,
      built: !!idx && idx.items.length > 0,
      builtAt: idx?.builtAt || 0,
      building: !!idx?.building,
      progress: idx?.progress || { done: 0, total: 0 },
      counts: idx?.counts || { total: 0, active: 0, paused: 0, risk: 0, riskIp: 0, riskBrand: 0, riskPlatform: 0 },
      error: idx?.error,
    };
  });

  if (refresh) {
    // 后台重建（不阻塞请求），前端轮询 /index 看进度
    for (const s of stores) {
      buildIndex(s.id).catch((e) => console.error(`[ProductAdmin] 重建索引失败 ${s.nickname}: ${e?.message}`));
    }
  } else {
    // 没有索引时自动构建一次（首次进入页面即可看到数据）
    for (const s of stores) {
      const idx = getIndex(s.id);
      if (!idx || (!idx.items.length && !idx.building)) {
        buildIndex(s.id).catch((e) => console.error(`[ProductAdmin] 首次建索引失败 ${s.nickname}: ${e?.message}`));
      }
    }
  }
  res.json({ success: true, stores: out });
});

productAdminRouter.post('/:storeId/refresh', async (req, res) => {
  const store = getStoreRaw(req.params.storeId);
  if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
  buildIndex(store.id).catch((e) => console.error(`[ProductAdmin] 重建失败: ${e?.message}`));
  res.json({ success: true, message: '已开始重建索引' });
});

// ============ 商品列表 ============

productAdminRouter.get('/:storeId/items', async (req, res) => {
  try {
    const store = getStoreRaw(req.params.storeId);
    if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
    const wait = req.query.wait !== '0';
    if (!getIndex(store.id)?.items.length && wait) await ensureIndex(store.id);

    const idx = getIndex(store.id);
    const result = listItems(store.id, {
      status: (req.query.status as any) || 'all',
      risk: (req.query.risk as any) || 'all',
      q: (req.query.q as string) || '',
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 50,
    });
    res.json({
      success: true,
      building: !!idx?.building,
      progress: idx?.progress || { done: 0, total: 0 },
      builtAt: idx?.builtAt || 0,
      counts: idx?.counts || null,
      error: idx?.error,
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// ============ 单件详情（全字段） ============

productAdminRouter.get('/:storeId/item/:itemId', async (req, res) => {
  try {
    const store = getStoreRaw(req.params.storeId);
    if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
    const detail = await getItemFullDetail(store.id, req.params.itemId);
    res.json({ success: true, ...detail });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// ============ 一键改为符合规范 ============

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FixResult {
  itemId: string;
  title?: string;
  ok: boolean;
  skipped?: boolean;
  dry?: boolean;
  newId?: string;
  mode?: 'clone' | 'update' | 'none';
  changes?: string[];
  preview?: { title: string; attributeChanges: Array<{ id?: string; name?: string; from: string; to: string }> };
  newSites?: string[];
  siteErrors?: Array<{ site: string; msg: string }>;
  error?: string;
}

/** 读原商品（CBT 的属性和本地站点只在 /marketplace/items 里返回，响应 206） */
async function readSourceItem(store: any, itemId: string): Promise<{ it: any; desc: string; error?: string }> {
  let it: any = null;
  let err = '';
  try {
    const mp: any = await storeApiGet(store, `/marketplace/items/${encodeURIComponent(itemId)}`, 2);
    it = mp;
  } catch (e: any) {
    err = `/marketplace/items: ${e?.message?.slice(0, 160)}`;
  }
  if (!it) {
    try {
      it = await storeApiGet(store, `/items/${encodeURIComponent(itemId)}`, 2);
    } catch (e: any) {
      return { it: null, desc: '', error: `${err}${err ? '; ' : ''}/items: ${e?.message?.slice(0, 160)}` };
    }
  }
  let desc = '';
  try {
    const d: any = await storeApiGet(store, `/items/${encodeURIComponent(itemId)}/description`, 2);
    desc = d?.plain_text || '';
  } catch {
    /* 描述取不到不阻断 */
  }
  return { it, desc };
}

/**
 * 是否是「标识类字段」（SKU / GTIN / UPC / EAN / MPN / 零件号 / ISBN / 封条 / 税号）。
 * 这类字段 ML 视为商品标识，改名会引起对不上账，所以清洗时一律不动。
 */
function isIdField(idOrName?: string, name?: string): boolean {
  return /sku|gtin|upc|ean|mpn|part ?number|isbn|seal|fiscal/i.test(`${idOrName || ''} ${name || ''}`);
}

/**
 * 克隆清洗重发：CBT 商品唯一可行的合规化路径。
 * 关键坑（已实测）：
 *  - 属性清洗必须同步改 values[]，只改 value_name 会被 ML 忽略
 *  - 站点与价格取自 /marketplace/items 的 marketplace_items（/items 不返回）
 *  - HTTP 200 ≠ 成功，必须检查 site_items[].error
 *  - 新建的 CBT 商品同样删不掉，务必先 dryRun
 */
async function cloneCompliant(
  store: any,
  itemId: string,
  it: any,
  desc: string,
  dryRun: boolean,
  risk?: any,
): Promise<FixResult> {
  const newTitle = sanitizeComplianceText(it?.title || '').slice(0, 60) || 'Producto generico';
  const attrs = (it?.attributes || []).map((a: any) => {
    const v = a?.value_name;
    if (typeof v !== 'string' || !v) return a;
    if (isIdField(a.id, a.name)) return a;
    const nv = sanitizeComplianceText(v) || 'Generic';
    if (nv === v) return a;
    const out: any = { ...a, value_name: nv, value_id: null };
    // ⚠️ ML 只认 values[].name，不同步改等于没改
    if (Array.isArray(a.values) && a.values.length) {
      out.values = a.values.map((x: any, i: number) => (i === 0 ? { ...x, name: nv, id: null } : x));
    }
    return out;
  });

  const mk = (it?.marketplace_items || []).filter((m: any) => m?.site_id || m?.site);
  const cleanDesc = sanitizeComplianceText(desc) || newTitle;
  const changes: string[] = [];
  if (newTitle !== (it?.title || '')) changes.push(`标题：${String(it?.title || '').slice(0, 50)} → ${newTitle.slice(0, 50)}`);
  (it?.attributes || []).forEach((a: any) => {
    const na = attrs.find((x: any) => x.id === a.id);
    if (na && na.value_name !== a.value_name) changes.push(`${a.name || a.id}：${a.value_name} → ${na.value_name}`);
  });
  if (cleanDesc !== desc && desc) changes.push('描述已清洗');

  const preview = buildCompliancePreview(it?.title || '', it?.attributes || []);

  // ⚠️ 若风险词只出现在 SKU 等**标识类字段**（ML 不允许改名），克隆一份新链接也降低不了风险，
  // 只会白白多出一条重复 listing。这种情况直接跳过并说明，让运营去后台人工判断。
  if (risk) {
    const titleHit = (risk.titleHits || []).length > 0;
    const attrRewritableHit = (risk.attrHits || []).some(
      (a: any) => !isIdField(a.id, a.name) && (a.hits || []).length > 0,
    );
    if (!titleHit && !attrRewritableHit) {
      const where = (risk.attrHits || [])
        .map((a: any) => `${a.name || a.id}="${a.value}"`)
        .join('；');
      return {
        itemId,
        ok: true,
        skipped: true,
        mode: 'none',
        title: it?.title,
        preview,
        error: `违规风险仅出现在标识类字段（${where || 'SKU'}），这类字段 ML 不允许改名，改为合规无法降低风险 —— 请到美客多后台人工确认是否需要下架`,
      };
    }
  }

  if (!changes.length) {
    return { itemId, ok: true, skipped: true, mode: 'none', title: it?.title, preview, error: '该商品标题与属性均已合规，无需修改' };
  }
  if (dryRun) {
    return { itemId, ok: true, dry: true, mode: 'clone', title: it?.title, changes, preview };
  }

  const payload: any = {
    title: newTitle,
    currency_id: 'USD',
    catalog_listing: false,
    category_id: it?.category_id,
    available_quantity: Math.max(1, Number(it?.available_quantity) || 1),
    description: { plain_text: cleanDesc },
    pictures: (it?.pictures || []).map((p: any) => ({ id: p?.id })).filter((p: any) => p.id),
    seller_custom_field: `${String(it?.seller_custom_field || itemId.replace('CBT', ''))}-CLN`.slice(0, 40),
    attributes: attrs,
    sale_terms: (it?.sale_terms || [])
      .map((s: any) => (s?.value_id ? { id: s.id, value_id: s.value_id } : s?.value_name ? { id: s.id, value_name: s.value_name } : null))
      .filter(Boolean),
    sites_to_sell: mk.length
      ? mk.map((m: any) => ({
          site_id: m.site_id || m.site,
          logistic_type: 'remote',
          title: newTitle,
          price: Number(it?.price) || 5,
          listing_type_id: it?.listing_type_id || 'gold_special',
        }))
      : [{ site_id: 'MLM', logistic_type: 'remote', title: newTitle, price: Number(it?.price) || 5, listing_type_id: 'gold_special' }],
  };

  const token = await ensureStoreToken(store);
  const resp = await fetch(`${getMlApiBase()}/global/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { itemId, ok: false, mode: 'clone', changes, title: it?.title, error: `HTTP ${resp.status} ${JSON.stringify(body).slice(0, 300)}` };
  }
  const siteErrors = (body?.site_items || [])
    .filter((s: any) => s?.error)
    .map((s: any) => ({ site: String(s.site_id), msg: String(s?.error?.message || JSON.stringify(s.error)).slice(0, 200) }));
  return {
    itemId,
    ok: siteErrors.length === 0,
    mode: 'clone',
    title: it?.title,
    changes,
    newId: body?.item_id || body?.id,
    newSites: (body?.site_items || []).map((s: any) => s?.site_id).filter(Boolean),
    siteErrors,
    error: siteErrors.length ? `部分站点失败：${siteErrors.map((s) => `${s.site}: ${s.msg}`).join('；')}` : undefined,
  };
}

productAdminRouter.post('/:storeId/compliance-fix', async (req, res) => {
  const store = getStoreRaw(req.params.storeId);
  if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
  const { itemIds, dryRun } = req.body as { itemIds?: string[]; dryRun?: boolean };
  const ids = (itemIds || []).filter(Boolean).slice(0, 200);
  if (!ids.length) return res.status(400).json({ success: false, message: 'itemIds 不能为空' });

  const idx = getIndex(store.id);
  const results: FixResult[] = [];
  try {
    for (const id of ids) {
      const row = idx?.items.find((r) => r.id === id);
      const risk = row?.risk || scanItemRisk('', [], store.site);
      // IP / 体育词：卖的就是 IP 本身，洗标题也侵权 → 拒绝执行，只能下架
      if (risk.level === 'ip') {
        results.push({
          itemId: id,
          ok: false,
          mode: 'none',
          title: row?.title,
          error: `不可洗：${risk.message}。这类商品卖的就是 IP/赛事本身，改标题也构成侵权，请到美客多后台下架。`,
        });
        continue;
      }
      const { it, desc, error } = await readSourceItem(store, id);
      if (!it) {
        results.push({ itemId: id, ok: false, mode: 'none', error: `读取原商品失败：${error || '未知错误'}` });
        continue;
      }
      const r = await cloneCompliant(store, id, it, desc, dryRun !== false, risk);
      results.push(r);
      await sleep(400); // 节流，避免触发 ML 限流
    }
    res.json({
      success: true,
      dryRun: dryRun !== false,
      total: ids.length,
      ok: results.filter((r) => r.ok && !r.skipped && !r.dry).length,
      preview: results.filter((r) => r.dry).length,
      skipped: results.filter((r) => r.skipped).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || String(err), results });
  }
});

// ============ 导出：把筛选结果导成 CSV（给运营手动跟进） ============

productAdminRouter.get('/:storeId/export', (req, res) => {
  const store = getStoreRaw(req.params.storeId);
  if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
  const result = listItems(store.id, {
    status: (req.query.status as any) || 'all',
    risk: (req.query.risk as any) || 'all',
    q: (req.query.q as string) || '',
    page: 1,
    pageSize: 5000,
  });
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['商品ID', '标题', '状态', '风险等级', '命中词', '品牌', '型号', '价格', '库存', '已售', 'SKU'];
  const lines = [head.map(esc).join(',')];
  for (const r of result.items) {
    lines.push(
      [r.id, r.title, r.status, r.risk.level, r.risk.hits.join(' '), r.brand, r.model, r.price, r.availableQuantity, r.soldQuantity, r.sellerSku]
        .map(esc)
        .join(','),
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="products-${store.id.slice(0, 8)}.csv"`);
  res.send('\ufeff' + lines.join('\n'));
});
