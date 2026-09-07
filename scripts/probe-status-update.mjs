/**
 * 探测妙手采集箱「状态更新」接口
 * 基于已知命名模式，批量测试候选路径
 * 
 * 已知存在的接口（已验证）：
 * - search_collect_box_detailList  → 列表
 * - get_site_collect_item_info     → 详情
 * - get_category_attribute_rules   → 类目属性规则
 * - get_auth_sites                 → 授权站点
 */
import crypto from 'crypto';
import https from 'https';

const APP_KEY = 'ak_a3860320a2384865be3b53c813695fe0';
const APP_SECRET = '9a1a7d3e05c44228831d099e41b7d3e0ebef0583c64a47a09289e202745101c7';

// 候选路径 —— 覆盖各种命名组合
const candidatePaths = [
  // 直接 update + status
  '/open/v1/product/collect_box/mercadolibre/collect_box/update_collect_box_detail_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/update_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/update_item_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/update_detail_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/updateCollectBoxDetailStatus',
  '/open/v1/product/collect_box/mercadolibre/collect_box/updateStatus',
  '/open/v1/product/collect_box/mercadolibre/collect_box/updateItemStatus',

  // update + item/detail 信息（可能含 status 字段）
  '/open/v1/product/collect_box/mercadolibre/collect_box/update_site_collect_item_info',
  '/open/v1/product/collect_box/mercadolibre/collect_box/update_collect_box_detail',
  '/open/v1/product/collect_box/mercadolibre/collect_box/update_site_collect_item',
  '/open/v1/product/collect_box/mercadolibre/collect_box/updateCollectBoxDetail',
  '/open/v1/product/collect_box/mercadolibre/collect_box/edit_site_collect_item_info',
  '/open/v1/product/collect_box/mercadolibre/collect_box/edit_collect_box_detail',
  '/open/v1/product/collect_box/mercadolibre/collect_box/editSiteCollectItemInfo',
  '/open/v1/product/collect_box/mercadolibre/collect_box/editCollectBoxDetail',

  // publish / 发布
  '/open/v1/product/collect_box/mercadolibre/collect_box/publish_collect_box_detail',
  '/open/v1/product/collect_box/mercadolibre/collect_box/publish_site_collect_item',
  '/open/v1/product/collect_box/mercadolibre/collect_box/publish_collect_box_detail_list',
  '/open/v1/product/collect_box/mercadolibre/collect_box/publish',
  '/open/v1/product/collect_box/mercadolibre/collect_box/batch_publish',
  '/open/v1/product/collect_box/mercadolibre/collect_box/batchPublish',
  '/open/v1/product/collect_box/mercadolibre/collect_box/publishCollectBoxDetail',
  '/open/v1/product/collect_box/mercadolibre/collect_box/publishSiteCollectItem',

  // mark / set / change
  '/open/v1/product/collect_box/mercadolibre/collect_box/mark_as_published',
  '/open/v1/product/collect_box/mercadolibre/collect_box/set_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/change_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/markPublished',
  '/open/v1/product/collect_box/mercadolibre/collect_box/setStatus',
  '/open/v1/product/collect_box/mercadolibre/collect_box/changeStatus',

  // 不同层级（去掉一层 collect_box）
  '/open/v1/product/collect_box/mercadolibre/update_status',
  '/open/v1/product/collect_box/mercadolibre/publish',
  '/open/v1/product/collect_box/mercadolibre/batch_publish',

  // 不同顶级（product → collect_box）
  '/open/v1/collect_box/mercadolibre/collect_box/update_status',
  '/open/v1/collect_box/mercadolibre/collect_box/publish',
];

function sign(path, ts, bodyJson) {
  const message = APP_SECRET + path + ts + APP_KEY + bodyJson + APP_SECRET;
  return crypto.createHmac('sha256', APP_SECRET).update(message).digest('hex');
}

function test(path) {
  return new Promise((resolve) => {
    const ts = String(Math.floor(Date.now() / 1000));
    // 用空 body 测试路由是否存在（不真的修改数据）
    const body = '{}';
    const sig = sign(path, ts, body);

    const req = https.request({
      hostname: 'openapi-erp.91miaoshou.com',
      port: 443,
      path,
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
            label = '✅ 路由存在';
            detail = JSON.stringify(j).slice(0, 300);
          } else if (j.code === 'routeNotFound' || j.code === '404') {
            label = '❌ 404';
            detail = '';
          } else {
            // 路由存在但参数不对（这是好事，说明路由存在）
            label = '⚠️ 路由存在但参数错';
            detail = `${j.code || '?'}: ${(j.message || '').slice(0, 120)}`;
          }
        } catch {
          label = '?';
          detail = d.slice(0, 150);
        }
        console.log(`${label.padEnd(20)}  ${path}`);
        if (detail) console.log(`  → ${detail}`);
        resolve({ path, label, detail });
      });
    });
    req.on('error', (e) => {
      console.log(`  ERR  ${path}  ${e.message}`);
      resolve({ path, label: 'ERR', detail: e.message });
    });
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('=== 探测妙手采集箱状态更新接口 ===\n');
  const results = [];
  for (const p of candidatePaths) {
    const r = await test(p);
    results.push(r);
    await new Promise((r) => setTimeout(r, 300)); // 限速
  }
  // 汇总
  const found = results.filter((r) => r.label !== '❌ 404' && r.label !== 'ERR');
  console.log('\n=== 汇总 ===');
  console.log(`测试 ${results.length} 个路径，排除 404 和错误后：`);
  if (found.length > 0) {
    found.forEach((r) => console.log(`  ${r.label}: ${r.path}`));
  } else {
    console.log('  无可用路由（全部 404）');
  }
})();
