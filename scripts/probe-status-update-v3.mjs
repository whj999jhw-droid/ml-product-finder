/**
 * 第三波探测 —— 带参数的 body（之前空 body 导致 404）
 * 
 * 妙手路由可能根据 body 里的 shopId/detailId 等参数路由
 * 用带参数的 body 重新测试
 */
import crypto from 'crypto';
import https from 'https';

const APP_KEY = 'ak_a3860320a2384865be3b53c813695fe0';
const APP_SECRET = '9a1a7d3e05c44228831d099e41b7d3e0ebef0583c64a47a09289e202745101c7';
const SHOP_ID = 12637644;
const DETAIL_ID = 3346334352;
const CID = 10110626;

const candidatePaths = [
  // 验证：带参数的已知好接口
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/search_collect_box_detailList', body: { pageNo: 1, pageSize: 20, filter: { status: 'notPublished' } } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/get_site_collect_item_info', body: { detailId: DETAIL_ID, shopId: SHOP_ID, cid: CID } },

  // 验证：空 body 的已知接口（对比用）
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/search_collect_box_detailList', body: {} },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/get_site_collect_item_info', body: {} },

  // 状态更新候选（带 shopId/detailId 参数）
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/update_collect_box_detail_status', body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/update_status', body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/update_publish_status', body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/update_collect_box_detail', body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/update_site_collect_item_info', body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/edit_site_collect_item_info', body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/publish', body: { detailIds: [DETAIL_ID], shopId: SHOP_ID } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/batch_publish', body: { detailIds: [DETAIL_ID], shopId: SHOP_ID } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/publish_collect_box_detail', body: { detailId: DETAIL_ID, shopId: SHOP_ID } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/publish_site_collect_item', body: { detailId: DETAIL_ID, shopId: SHOP_ID } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/sync_status', body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/report_publish_result', body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' } },
  { path: '/open/v1/product/collect_box/mercadolibre/collect_box/mark_as_published', body: { detailId: DETAIL_ID, shopId: SHOP_ID } },

  // 不同层级 + 带参数
  { path: '/open/v1/product/collect_box/mercadolibre/update_status', body: { detailId: DETAIL_ID, shopId: SHOP_ID, status: 'published' } },
  { path: '/open/v1/product/publish/mercadolibre/publish', body: { detailId: DETAIL_ID, shopId: SHOP_ID } },
  { path: '/open/v1/publish/mercadolibre/publish', body: { detailId: DETAIL_ID, shopId: SHOP_ID } },
];

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
            label = '⚠️ 路由存在-参数错';
            detail = `${j.code}: ${(j.message || '').slice(0, 120)}`;
          }
        } catch {
          label = '?';
          detail = d.slice(0, 150);
        }
        const shortPath = item.path.replace('/open/v1/product/collect_box/mercadolibre/collect_box/', '');
        console.log(`${label.padEnd(20)}  ${shortPath}`);
        if (detail) console.log(`  → ${detail}`);
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
  console.log('=== 第三波探测（带参数 body）===\n');
  const results = [];
  for (const item of candidatePaths) {
    const r = await test(item);
    results.push(r);
    await new Promise((r) => setTimeout(r, 300));
  }
  // 分组显示
  const ok = results.filter(r => r.label.includes('成功'));
  const routeExists = results.filter(r => r.label.includes('路由存在'));
  const notFound = results.filter(r => r.label === '❌ 404');
  
  console.log('\n=== 汇总 ===');
  console.log(`✅ 成功: ${ok.length}`);
  ok.forEach(r => console.log(`   ${r.path}`));
  console.log(`⚠️ 路由存在但参数错: ${routeExists.length}`);
  routeExists.forEach(r => console.log(`   ${r.path} → ${r.detail}`));
  console.log(`❌ 404: ${notFound.length}`);
})();
