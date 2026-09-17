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
 * ⚠️ 核心事实（2026-09-18 实测修订，别再用旧结论）：
 *  之前记录的「CBT 商品对本店 token 只读」**是错的** —— 那是因为用错了资源路径。
 *  正确路径是 `/global/items/{CBT_ID}`（Global Selling 专用），实测结果：
 *
 *   ✅ 能改（写后回读确认生效）：
 *      PUT /global/items/{CBT}                 { available_quantity: n }   改库存
 *      PUT /global/items/{CBT}                 { status: 'paused' }        暂停
 *      PUT /items/{CBT}/description            { plain_text: '…' }         改描述
 *   ❌ 返回 200 但**值不变**（ML 对 CBT 开放 API 静默忽略）：
 *      price / title / pictures（顶层与 site_id+logistic_type 作用域都试过）
 *   ❌ 明确拒绝：
 *      PUT /items/{CBT}              → 400 cause_id 446 `Cannot modify CBT item from this resource`
 *      PUT /marketplace/items/{CBT}  → 405
 *      本地站点商品 MLM…              → 403（归属子账号 user_id，本 token 无 station 权限）
 *  所以：
 *    - 库存/描述/暂停 → 直接改原链接（本文件的 /item/:itemId/update）
 *    - 改标题/图片等 → 仍只能**克隆清洗重发**（POST /global/items 建新链接），
 *      原链接需到 ML 后台人工处理 —— UI 上已明确提示。
 *
 *  ⚠️ 站点级真实在售状态：CBT 父商品 status 常年 active，不代表能卖。
 *     必须用 /marketplace/items/{CBT}?attributes=marketplace_items 拿到各站点本地
 *     listing id，再和各子账号的 active/paused 集合比对（见 server/mlSiteStatus.ts）。
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
import { clearStoreSiteCache, getSiteAccounts } from './mlSiteStatus.js';
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
  // force=1：连站点级状态缓存一起清掉重拉（默认只重建商品字段，站点状态走 6h 缓存）
  const force = req.body?.force === true || req.query.force === '1';
  if (force) clearStoreSiteCache(store.id);
  buildIndex(store.id).catch((e) => console.error(`[ProductAdmin] 重建失败: ${e?.message}`));
  res.json({ success: true, message: force ? '已清缓存并开始重建' : '已开始重建索引' });
});

// ============ 商品列表 ============

productAdminRouter.get('/:storeId/items', async (req, res) => {
  try {
    const store = getStoreRaw(req.params.storeId);
    if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
    const wait = req.query.wait !== '0';
    if (!getIndex(store.id)?.items.length && wait) await ensureIndex(store.id);

    const idx = getIndex(store.id);
    const noSite = req.query.noSite === '1';
    const blocked = (req.query.blocked as any) || 'all';
    const listBase = {
      status: (req.query.status as any) || 'all',
      risk: (req.query.risk as any) || 'all',
      q: (req.query.q as string) || '',
      // 站点级在售过滤：默认隐藏「全部站点未激活」（买家看不到，多为被平台禁止/下架）
      onSale: noSite ? 'all' : ((req.query.onSale as any) || 'yes'),
      blocked,
    } as any;
    const result = listItems(store.id, { ...listBase, page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 50 });
    // 同款重复统计：同一 SKU 被重复上架的条数（同一件 1688 商品换 2-7 个标题反复铺）
    const all = listItems(store.id, { ...listBase, page: 1, pageSize: 20000 }).items;
    const firstByDup = new Map<string, number>();
    for (const r of all) {
      const k = r.dupKey || `id:${r.id}`;
      firstByDup.set(k, (firstByDup.get(k) || 0) + 1);
    }
    const dupOf = (r: any) => firstByDup.get(r.dupKey || `id:${r.id}`) || 1;
    res.json({
      success: true,
      building: !!idx?.building,
      progress: idx?.progress || { done: 0, total: 0 },
      builtAt: idx?.builtAt || 0,
      counts: idx?.counts || null,
      error: idx?.error,
      ...result,
      items: result.items.map((r) => ({ ...r, dupCount: dupOf(r) })),
      dupGroups: [...firstByDup.values()].filter((n) => n > 1).length,
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

// ============ 直接修改商品（2026-09-18 实测可写字段）============
//
// 用户问题：「智赢/妙手都能改商品，咱们怎么就不行？」—— 之前不行是因为路径用错了。
// 正确路径是 Global Selling 的 /global/items/{CBT_ID}，实测可写并在本接口里**写后回读校验**：
//   ✅ 描述           PUT /items/{CBT}/description
//   ✅ 库存           PUT /global/items/{CBT}  { available_quantity }
//   ✅ 暂停           PUT /global/items/{CBT}  { status:'paused' }
//   ❌ 价格/标题/图片  ML 返回 200 但值不变（静默忽略），所以本接口不提供，避免“假成功”
//   ⚠️ 重新激活：ML 返回 200 但实测未生效（原链接多因审核/分类报错被挂起），这里会如实返回 applied:false

interface ItemUpdateFieldResult {
  field: string;
  ok: boolean;
  /** ML 是否真的应用了（写后回读比对，HTTP 200 ≠ 生效） */
  applied: boolean;
  http?: number;
  message: string;
}

productAdminRouter.post('/:storeId/item/:itemId/update', async (req, res) => {
  const store = getStoreRaw(req.params.storeId);
  if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
  const itemId = String(req.params.itemId || '');
  if (!/^CBT/i.test(itemId)) {
    return res.status(400).json({ success: false, message: '只支持 CBT 开头的商品 ID（本地站点商品归属子账号，本 token 无权修改）' });
  }
  const body = (req.body || {}) as { description?: string; availableQuantity?: number; status?: string };
  const results: ItemUpdateFieldResult[] = [];

  const base = getMlApiBase();
  let token = '';
  try {
    token = await ensureStoreToken(store);
  } catch (e: any) {
    return res.status(500).json({ success: false, message: `取 token 失败：${e?.message || e}` });
  }

  const call = async (method: string, path: string, payload: any) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let msg = text.slice(0, 220);
    try {
      const j = JSON.parse(text);
      if (j?.message) msg = `${j.error || ''} ${j.message}`.trim();
    } catch {
      /* 非 JSON 响应原样截断 */
    }
    return { status: r.status, ok: r.ok, msg };
  };

  const readBack = async (): Promise<any | null> => {
    try {
      return await storeApiGet(store, `/items/${itemId}?attributes=id,title,status,sub_status,available_quantity,price`, 2);
    } catch {
      return null;
    }
  };

  const before = await readBack();

  // ---- 描述 ----
  if (typeof body.description === 'string' && body.description.trim()) {
    const r = await call('PUT', `/items/${encodeURIComponent(itemId)}/description`, { plain_text: body.description.trim() });
    let applied = false;
    if (r.ok) {
      try {
        const d: any = await storeApiGet(store, `/items/${encodeURIComponent(itemId)}/description`, 2);
        applied = String(d?.plain_text || '').trim() === body.description.trim();
      } catch {
        applied = false;
      }
    }
    results.push({
      field: '描述',
      ok: r.ok,
      applied,
      http: r.status,
      message: r.ok ? (applied ? '已生效' : 'ML 返回成功但回读内容不一致，请稍后刷新确认') : `失败：${r.msg}`,
    });
    await sleep(300);
  }

  // ---- 库存 ----
  if (typeof body.availableQuantity === 'number' && Number.isFinite(body.availableQuantity)) {
    const q = Math.max(0, Math.floor(body.availableQuantity));
    const r = await call('PUT', `/global/items/${encodeURIComponent(itemId)}`, { available_quantity: q });
    await sleep(1500);
    const after = await readBack();
    const applied = !!after && Number(after.available_quantity) === q;
    results.push({
      field: '库存',
      ok: r.ok,
      applied,
      http: r.status,
      message: r.ok ? (applied ? `已改为 ${q}` : `ML 返回成功但库存仍是 ${after?.available_quantity ?? '未知'}（站点不同步或该链接未生效）`) : `失败：${r.msg}`,
    });
  }

  // ---- 状态（暂停 / 重新激活）----
  if (body.status === 'paused' || body.status === 'active') {
    const want = body.status;
    const r = await call('PUT', `/global/items/${encodeURIComponent(itemId)}`, { status: want });
    await sleep(2500);
    const after = await readBack();
    const applied = !!after && String(after.status) === want;
    results.push({
      field: want === 'paused' ? '暂停' : '重新激活',
      ok: r.ok,
      applied,
      http: r.status,
      message: r.ok
        ? applied
          ? '已生效'
          : `ML 返回成功但状态仍是 ${after?.status ?? '未知'}${
              want === 'active' ? '（多数是被审核/分类报错挂起，需到美客多后台「重新发布」）' : ''
            }`
        : `失败：${r.msg}`,
    });
  }

  // ---- 明确说明不支持 ----
  if (body.description === undefined && body.availableQuantity === undefined && body.status === undefined) {
    return res.status(400).json({ success: false, message: '没有要修改的字段（支持：description / availableQuantity / status）' });
  }

  const after = await readBack();
  res.json({
    success: true,
    itemId,
    before,
    after,
    results,
    /** 站点级同步说明：改的是 CBT 父商品，站点侧可能有延迟或不同步 */
    note: '价格/标题/图片 ML 开放 API 对 CBT 商品不支持（返回 200 但值不变），需要改只能克隆重发或到美客多后台操作。',
  });
});

// ============ 子账号（站点映射，给前端显示站点名用） ============

productAdminRouter.get('/:storeId/accounts', async (req, res) => {
  const store = getStoreRaw(req.params.storeId);
  if (!store) return res.status(404).json({ success: false, message: '店铺不存在' });
  const force = req.query.force === '1';
  const accounts = await getSiteAccounts(store, force);
  res.json({ success: true, accounts });
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
    pageSize: 20000,
    onSale: req.query.onSale === 'all' ? 'all' : 'yes',
  });
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['商品ID', '标题', '站点级在售', '在售站点', '未激活站点', '同款重复', '父状态', '风险等级', '命中词', '品牌', '型号', '价格', '库存', '已售', 'SKU', '链接'];
  const dupN = new Map<string, number>();
  for (const r of result.items) {
    const dk = r.dupKey || ('id:' + r.id);
    dupN.set(dk, (dupN.get(dk) || 0) + 1);
  }
  const lines = [head.map(esc).join(',')];
  for (const r of result.items) {
    lines.push(
      [
        r.id,
        r.title,
        r.onSale === false ? '全部未激活' : r.onSale === true ? '在售' : '未知',
        (r.activeSites || []).join(' '),
        (r.inactiveSites || []).join(' '),
        dupN.get(r.dupKey || ('id:' + r.id)) || 1,
        r.status,
        r.risk.level,
        r.risk.hits.join(' '),
        r.brand,
        r.model,
        r.price,
        r.availableQuantity,
        r.soldQuantity,
        r.sellerSku,
        r.mlPermalink || '',
      ]
        .map(esc)
        .join(','),
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="products-${store.id.slice(0, 8)}.csv"`);
  res.send('\ufeff' + lines.join('\n'));
});
