/**
 * 诊断脚本：打印 ML highlights 兜底的「真实返回结构」+ 1688 配置/搜索状态。
 * 直接复用应用内的真实函数（mercadolibre.ts / ali1688Skill.ts），看到的 JSON 即应用实际拿到的。
 * 运行：npx tsx scripts/diag-sourcing.ts
 */
import { searchWithHighlightsFallback, fetchItemDetails, fetchProductItems } from '../server/mercadolibre.js';
import { check1688Config, search1688ByQuery } from '../server/ali1688Skill.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // 1. 读取店铺 token（与应用 stores.ts 同一来源）
  const storesPath = path.join(__dirname, '..', 'data', 'stores.json');
  let token = '';
  try {
    const stores = JSON.parse(fs.readFileSync(storesPath, 'utf-8'));
    const arr: any[] = Array.isArray(stores) ? stores : (stores.stores || []);
    const s = arr.find((x: any) => x.accessToken) || arr[0];
    token = s?.accessToken || '';
    console.log('[DIAG] 使用店铺:', s?.nickname || s?.site, '| token长度:', token.length, '| 店铺总数:', arr.length);
  } catch (e: any) {
    console.log('[DIAG] 读取 stores.json 失败:', e.message);
  }

  // 2. highlights 兜底扫描（复现应用逻辑）
  console.log('\n=== 2) searchWithHighlightsFallback(MLB, MLB5726) ===');
  const res = await searchWithHighlightsFallback('MLB', 'MLB5726', 5, 0, token);
  console.log('[DIAG] fromHighlights =', res.fromHighlights, '| items 数量 =', res.items.length);
  for (const it of res.items) {
    const priceKeys = Object.keys(it).filter((k) => /price/i.test(k));
    const idVal = it.id || it.item_id;
    console.log(
      `[DIAG] itemId=${idVal} | price=${it.price} | priceUsd字段=${it.priceUsd} | price相关键=[${priceKeys.join(',')}] | sold=${it.sold_quantity} | condition=${it.condition} | _fromHighlights=${it._fromHighlights}`
    );
  }

  // 3. 第一个商品深挖：it / /items/{id} / /products/{id}/items 三者原始结构
  const first = res.items[0];
  const firstId = first?.id || first?.item_id;
  if (firstId) {
    console.log('\n=== 3) 第一个商品 it（来自 /products/{id}/items）原始结构 ===');
    console.log(JSON.stringify(first, null, 2).slice(0, 2500));
    const detail = await fetchItemDetails(String(firstId), token);
    console.log('\n=== 3b) /items/{id} 详情（detail）原始结构 ===');
    console.log(JSON.stringify(detail, null, 2).slice(0, 2500));
    const pitems = await fetchProductItems(String(firstId), 5, token);
    console.log('\n=== 3c) /products/{id}/items 原始结构（前 1 条） ===');
    console.log(JSON.stringify(pitems.slice(0, 1), null, 2).slice(0, 2500));
  } else {
    console.log('[DIAG] 未拿到任何 highlights 商品，无法深挖');
  }

  // 4. 1688 配置 + 一次真实搜索
  console.log('\n=== 4) 1688 配置与搜索 ===');
  const cfg = await check1688Config();
  console.log('[DIAG] 1688 config:', JSON.stringify(cfg));
  if (first?.title) {
    const q = String(first.title).slice(0, 40);
    console.log('[DIAG] 1688 原始标题:', first.title);
    console.log('[DIAG] 1688 搜索词:', q);
    const r = await search1688ByQuery(q);
    console.log('[DIAG] 1688 success =', r.success, '| message =', String(r.message || '').slice(0, 300), '| products =', r.products?.length);
    if (r.raw) {
      console.log('[DIAG] 1688 raw:', JSON.stringify(r.raw).slice(0, 1000));
    }
    if (r.products?.length) {
      console.log('[DIAG] 1688 第一个结果:', JSON.stringify(r.products[0], null, 2).slice(0, 800));
    }
    // 同时用第二个、第三个标题再测一次
    for (let i = 1; i < Math.min(3, res.items.length); i++) {
      const alt = res.items[i];
      const altTitle = alt.title || alt.name || alt.family_name;
      if (altTitle) {
        console.log(`\n[DIAG] 1688 额外测试 #${i + 1} 搜索词:`, String(altTitle).slice(0, 40));
        const r2 = await search1688ByQuery(String(altTitle).slice(0, 40));
        console.log('[DIAG] 1688 success =', r2.success, '| message =', String(r2.message || '').slice(0, 300), '| products =', r2.products?.length);
      }
    }
  }
}

main().catch((e) => {
  console.error('[DIAG] 执行失败:', e);
  process.exit(1);
});
