/**
 * 第四波 —— 穷举更多命名模式
 * 
 * 已知：
 * - 读接口用 snake_case：search_collect_box_detailList, get_site_collect_item_info
 * - 路由存在但参数错 = 路由存在（如 pageNo 必填）
 * - 404 = 路由不存在（与 body 无关）
 * 
 * 尝试 camelCase 写操作、不同参数结构、不同路径层级
 */
import crypto from 'crypto';
import https from 'https';

const APP_KEY = 'ak_a3860320a2384865be3b53c813695fe0';
const APP_SECRET = '9a1a7d3e05c44228831d099e41b7d3e0ebef0583c64a47a09289e202745101c7';
const SHOP_ID = 12637644;
const DETAIL_ID = 3346334352;

// 所有候选（带 body 参数，避免路由歧义）
const candidates = [
  // camelCase 写操作
  'updateCollectBoxDetailStatus',
  'updateCollectBoxStatus',
  'updateItemStatus',
  'updateCollectItemStatus',
  'editCollectBoxDetail',
  'editSiteCollectItemInfo',
  'saveCollectBoxDetail',
  'saveSiteCollectItem',
  'modifyCollectBoxDetail',
  'modifyCollectBoxStatus',
  'changeCollectBoxStatus',
  'changeItemStatus',
  'setCollectBoxStatus',
  'setPublishStatus',
  'markPublished',
  'markAsPublished',
  'markCollected',
  'submitPublish',
  'submitCollectBoxDetail',
  'publishCollectBox',
  'publishCollectBoxDetail',
  'publishCollectBoxDetailList',
  'publishSiteCollectItem',
  'batchPublishCollectBoxDetail',
  'batchPublish',
  'doPublish',
  'doPublishCollectBoxDetail',
  'pushToStore',
  'pushToShop',
  'uploadToStore',
  'syncToStore',
  'syncToShop',
  'syncPublishStatus',
  'syncStatus',
  'reportPublishResult',
  'notifyPublishResult',
  'callbackPublishResult',
  'updatePublishResult',
  'updateCollectBoxDetailList',
  'refreshCollectBoxDetail',
  'refreshStatus',
  'confirmPublish',
  'confirmPublishResult',
  // 不同参数：collectBoxDetailId 而不是 detailId
  'updateStatusById',
  'updateStatusByCollectBoxDetailId',
];

const prefix = '/open/v1/product/collect_box/mercadolibre/collect_box/';
const items = candidates.map(name => ({
  path: prefix + name,
  body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' },
}));

// 也试不同参数名
items.push({
  path: prefix + 'updateStatus',
  body: { collectBoxDetailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' },
});
items.push({
  path: prefix + 'updateStatus',
  body: { id: DETAIL_ID, shopId: SHOP_ID, status: 'published' },
});

// 不同 URL 层级
items.push({
  path: '/open/v1/product/collect_box/mercadolibre/publish',
  body: { detailId: DETAIL_ID, shopId: SHOP_ID },
});
items.push({
  path: '/open/v1/product/collect_box/mercadolibre/collect_box_detail/update_status',
  body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' },
});
items.push({
  path: '/open/v1/product/collect_box/mercadolibre/collect_box/publish_detail',
  body: { detailId: DETAIL_ID, shopId: SHOP_ID },
});
items.push({
  path: '/open/v1/product/collect_box/mercadolibre/collect_box/list_and_publish',
  body: { detailId: DETAIL_ID, shopId: SHOP_ID },
});
items.push({
  path: '/open/v1/product/collect_box/mercadolibre/collect_box/update',
  body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' },
});
items.push({
  path: '/open/v1/product/collect_box/mercadolibre/collect_box/operate',
  body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' },
});

function sign(path, ts, bodyJson) {
  const message = APP_SECRET + path + ts + APP_KEY + bodyJson + APP_SECRET;
  return crypto.createHmac('sha256', APP_SECRET).update(message).digest('hex');
}

function test(item) {
  return new Promise((resolve) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(item.body);
    const sig = sign(item.path, ts, body);

    const req = https.request({
      hostname: 'openapi-erp.91miaoshou.com',
      port: 443,
      path: item.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-app-key': APP_KEY,
        'x-timestamp': ts,
        'x-sign': sig,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let label, detail;
        try {
          const j = JSON.parse(d);
          if (j.result === 'success') {
            label = '✅ 成功';
            detail = JSON.stringify(j.data || j).slice(0, 200);
          } else if (j.code === 'routeNotFound' || j.code === '404') {
            label = '❌ 404';
            detail = '';
          } else {
            label = '⚠️ 路由存在';
            detail = `${j.code}: ${(j.message || '').slice(0, 120)}`;
          }
        } catch {
          label = '?';
          detail = d.slice(0, 150);
        }
        const shortPath = item.path.replace('/open/v1/product/collect_box/mercadolibre/collect_box/', '');
        console.log(`${label.padEnd(18)}  ${shortPath}`);
        if (detail && !detail.startsWith('')) console.log(`  → ${detail}`);
        resolve({ path: item.path, label, detail });
      });
    });
    req.on('error', (e) => {
      console.log(`  ERR  ${item.path}  ${e.message}`);
      resolve({ path: item.path, label: 'ERR', detail: e.message });
    });
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log(`=== 第四波探测：${candidates.length} 个候选 + 额外 ===\n`);
  const results = [];
  for (const item of items) {
    const r = await test(item);
    results.push(r);
    await new Promise((r) => setTimeout(r, 200));
  }
  // 分组
  const ok = results.filter(r => r.label.includes('成功'));
  const routeExists = results.filter(r => r.label.includes('路由存在'));
  const notFound = results.filter(r => r.label === '❌ 404');
  
  console.log('\n=== 汇总 ===');
  console.log(`✅ 成功: ${ok.length}`);
  ok.forEach(r => console.log(`   ${r.path} → ${r.detail}`));
  console.log(`\n⚠️ 路由存在（但参数错）: ${routeExists.length}`);
  routeExists.forEach(r => console.log(`   ${r.path} → ${r.detail}`));
  console.log(`\n❌ 404: ${notFound.length} / ${results.length}`);
  if (results.length === notFound.length) {
    console.log('   → 所有候选路径都不存在，妙手 API 无写接口');
  }
})();
