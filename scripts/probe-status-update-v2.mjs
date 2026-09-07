/**
 * 第二波探测 —— 不同命名模式 + 不同 URL 层级
 * 
 * 思路：
 * 1. 妙手 API 可能用 operate/sync/callback/report 等动词
 * 2. 发布接口可能在 /open/v1/product/publish/ 而不是 collect_box 下
 * 3. 可能用 api_ 前缀
 */
import crypto from 'crypto';
import https from 'https';

const APP_KEY = 'ak_a3860320a2384865be3b53c813695fe0';
const APP_SECRET = '9a1a7d3e05c44228831d099e41b7d3e0ebef0583c64a47a09289e202745101c7';

// 验证：先确认已知存在的接口仍然通（排除签名/权限问题）
const KNOWN_GOOD = '/open/v1/product/collect_box/mercadolibre/collect_box/get_auth_sites';

// 候选路径
const candidatePaths = [
  // operate / sync / callback / report 模式
  '/open/v1/product/collect_box/mercadolibre/collect_box/operate_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/sync_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/sync_publish_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/report_publish_result',
  '/open/v1/product/collect_box/mercadolibre/collect_box/notify_published',
  '/open/v1/product/collect_box/mercadolibre/collect_box/update_publish_status',
  '/open/v1/product/collect_box/mercadolibre/collect_box/api_update_status',

  // 不同 URL 层级：发布可能在 product/publish 下
  '/open/v1/product/publish/mercadolibre/publish_collect_box_detail',
  '/open/v1/product/publish/mercadolibre/publish',
  '/open/v1/product/publish/publish',
  '/open/v1/product/publish/mercadolibre/collect_box/publish',
  '/open/v1/product/publish/mercadolibre/batch_publish',
  '/open/v1/product/publish/mercadolibre/publish_item',
  '/open/v1/product/publish/publish_item',
  '/open/v1/product/publish/publish_detail',

  // 不同 URL 层级：publish 可能在更上层
  '/open/v1/publish/mercadolibre/publish',
  '/open/v1/publish/publish',
  '/open/v1/publish/mercadolibre/collect_box/publish',

  // item 级别
  '/open/v1/item/mercadolibre/publish',
  '/open/v1/item/mercadolibre/publish_item',
  '/open/v1/item/publish',

  // 更多 collect_box 下的动词
  '/open/v1/product/collect_box/mercadolibre/collect_box/publish_to_shop',
  '/open/v1/product/collect_box/mercadolibre/collect_box/publish_to_store',
  '/open/v1/product/collect_box/mercadolibre/collect_box/publish_to_site',
  '/open/v1/product/collect_box/mercadolibre/collect_box/sync_to_store',
  '/open/v1/product/collect_box/mercadolibre/collect_box/upload_to_store',
  '/open/v1/product/collect_box/mercadolibre/collect_box/send_to_store',
  '/open/v1/product/collect_box/mercadolibre/collect_box/push_to_store',
  '/open/v1/product/collect_box/mercadolibre/collect_box/listing',
  '/open/v1/product/collect_box/mercadolibre/collect_box/onboard',
  '/open/v1/product/collect_box/mercadolibre/collect_box/launch',

  // 可能用 product 模块而非 collect_box
  '/open/v1/product/mercadolibre/collect_box/publish',
  '/open/v1/product/mercadolibre/collect_box/update_status',
  '/open/v1/product/mercadolibre/update_status',
  '/open/v1/product/mercadolibre/publish',
];

function sign(path, ts, bodyJson) {
  const message = APP_SECRET + path + ts + APP_KEY + bodyJson + APP_SECRET;
  return crypto.createHmac('sha256', APP_SECRET).update(message).digest('hex');
}

function test(path) {
  return new Promise((resolve) => {
    const ts = String(Math.floor(Date.now() / 1000));
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
  // 0. 先验证已知好接口仍然通
  console.log('=== 验证：已知接口是否仍通 ===');
  const sanity = await test(KNOWN_GOOD);
  console.log('');

  console.log('=== 第二波探测 ===\n');
  const results = [];
  for (const p of candidatePaths) {
    const r = await test(p);
    results.push(r);
    await new Promise((r) => setTimeout(r, 250));
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
