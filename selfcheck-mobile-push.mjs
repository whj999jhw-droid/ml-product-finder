#!/usr/bin/env node
/**
 * 手机 APP 订单推送 — 端到端联调自检脚本
 * ---------------------------------------------------------------------------
 * 对应文档《mobile-push-complete-guide.md》第 6 节「联调自检清单」。
 *
 * 可自动验证（无需登录态）：
 *   [1] 服务器可达 + /api/mobile/devices 返回 JSON（部署侧核对项）
 *   [2] SSE 连上后收到 event: connected
 *   [3] POST /api/mobile/devices 注册成功，且 GET /api/mobile/devices 能看到本设备
 *   [4] GET /api/mobile/orders/recent?since= 补推返回 success（含 count 与订单数组）
 *   [5] GET /api/mobile/orders/:storeId/:orderId 详情含 summary + smsContent
 *
 * 可选自动验证（提供 SESSION_COOKIE + STORE_ID 后开启）：
 *   [6] 触发一次真实订单同步，SSE 应实时收到 event: new_order（APP 侧核对项）
 *
 * 需真机/手动验证（脚本无法替代，已打印提示）：
 *   - 杀掉 APP 再产生新订单，手机弹系统通知并跳转详情
 *   - 断网 1 分钟恢复后，回前台 recent 补推把漏的单补回（不重复、不漏）
 *
 * 用法：
 *   node selfcheck-mobile-push.mjs
 *   BASE_URL=https://ml.w999w.dpdns.org SESSION_COOKIE="connect.sid=xxx" STORE_ID=MLxxxx node selfcheck-mobile-push.mjs
 *
 * 环境变量：
 *   BASE_URL        服务器地址，默认 https://ml.w999w.dpdns.org
 *   SESSION_COOKIE  登录会话 cookie（仅 [6] 触发同步需要）
 *   STORE_ID        指定触发同步的店铺 ID（仅 [6] 需要；不填则尝试自动取第一个店铺）
 *   DEVICE_ID       本机设备标识，默认 selfcheck-<时间戳>
 *   PLATFORM        上报平台，默认 other（可选 ios/android/other）
 *   TIMEOUT_MS      SSE 等待事件超时，默认 15000
 */

import process from 'node:process';

const BASE = (process.env.BASE_URL || 'https://ml.w999w.dpdns.org').replace(/\/+$/, '');
const SESSION_COOKIE = process.env.SESSION_COOKIE || '';
const STORE_ID = process.env.STORE_ID || '';
const DEVICE_ID = process.env.DEVICE_ID || 'selfcheck-' + Date.now();
const PLATFORM = process.env.PLATFORM || 'other';
const TOKEN = process.env.TOKEN || DEVICE_ID; // 服务器要求 token 必填，用 deviceId 占位
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);

// ============ 结果收集 ============
const results = [];
const skipped = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  const tag = ok ? '✅' : '❌';
  console.log(`${tag} ${name}${info ? ' — ' + info : ''}`);
}
function skip(name, info = '') {
  skipped.push({ name, info });
  console.log(`⏭️  ${name} — 跳过: ${info}`);
}
function note(msg) {
  console.log(`ℹ️  ${msg}`);
}

async function fetchJson(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (SESSION_COOKIE) headers.cookie = SESSION_COOKIE;
  const res = await fetch(url, { ...opts, headers });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body, ok: res.ok };
}

// ============ SSE 客户端（原生 fetch 流式解析） ============
function openSSE({ onEvent, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController();
  const got = { connected: false, ping: 0, newOrder: null };
  let eventName = '';
  let dataLines = [];
  let buf = '';

  (async () => {
    try {
      const res = await fetch(`${BASE}/api/mobile/stream`, {
        signal: controller.signal,
        headers: SESSION_COOKIE ? { cookie: SESSION_COOKIE } : {},
      });
      if (!res.ok || !res.body) {
        onEvent('__error__', { status: res.status });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          let payload = null;
          const dataStr = dataLines.join('\n');
          try { payload = dataStr ? JSON.parse(dataStr) : null; } catch { /* 忽略坏 JSON */ }
          if (eventName === 'connected') got.connected = true;
          else if (eventName === 'ping') got.ping++;
          else if (eventName === 'new_order') got.newOrder = payload;
          if (onEvent) onEvent(eventName, payload);
          eventName = '';
          dataLines = [];
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') onEvent && onEvent('__error__', { message: String(e) });
    }
  })();

  // 超时后强制关闭，避免脚本挂起
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    close: () => { clearTimeout(timer); controller.abort(); },
    got,
    waitUntil: (pred, ms = timeoutMs) =>
      new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
          if (pred(got) || Date.now() - start > ms) {
            clearInterval(iv);
            resolve(pred(got));
          }
        }, 200);
      }),
  };
}

// ============ 主流程 ============
async function main() {
  console.log(`\n🔍 订单推送联调自检 @ ${BASE}`);
  console.log(`   设备: ${DEVICE_ID} | 平台: ${PLATFORM} | 触发同步: ${SESSION_COOKIE ? '已开启' : '未开启(需 SESSION_COOKIE+STORE_ID)'}\n`);

  // [1] 服务器可达 + /api/mobile/devices 返回 JSON
  try {
    const r = await fetchJson(`${BASE}/api/mobile/devices`);
    if (r.ok && r.body && r.body.success === true && Array.isArray(r.body.devices)) {
      check('[1] 服务器可达 /api/mobile/devices 返回 JSON', true, `sseActive=${r.body.sseActive}, 已注册设备=${r.body.devices.length}`);
    } else {
      check('[1] 服务器可达 /api/mobile/devices 返回 JSON', false, `HTTP ${r.status} / ${JSON.stringify(r.body).slice(0, 120)}`);
    }
  } catch (e) {
    check('[1] 服务器可达 /api/mobile/devices 返回 JSON', false, '网络不可达: ' + String(e));
    return finish(false);
  }

  // 启动 SSE（贯穿后续检查）
  let sse;
  try {
    sse = openSSE({ onEvent: () => {} });
  } catch (e) {
    check('[2] SSE 连接', false, String(e));
    return finish(false);
  }

  // [2] 收到 event: connected
  const connected = await sse.waitUntil((g) => g.connected);
  check('[2] SSE 连上后收到 event: connected', !!connected, connected ? 'OK' : `超时 ${TIMEOUT_MS}ms 未收到`);

  // [3] 设备注册 + 列表可见
  try {
    const reg = await fetchJson(`${BASE}/api/mobile/devices`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DEVICE_ID, platform: PLATFORM, token: TOKEN, appVersion: 'selfcheck' }),
    });
    if (reg.ok && reg.body && reg.body.success) {
      const list = await fetchJson(`${BASE}/api/mobile/devices`);
      const found = list.body && list.body.devices.some((d) => d.deviceId === DEVICE_ID);
      check('[3] POST 设备注册成功', true, `store=${JSON.stringify(reg.body.device?.platform)}`);
      check('[3b] GET 设备列表可见本设备', !!found, found ? '已出现' : '未出现在列表');
    } else {
      check('[3] POST 设备注册成功', false, `HTTP ${reg.status} / ${JSON.stringify(reg.body).slice(0, 120)}`);
    }
  } catch (e) {
    check('[3] POST 设备注册成功', false, String(e));
  }

  // [4] recent 补推
  let sampleOrder = null;
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const r = await fetchJson(`${BASE}/api/mobile/orders/recent?since=${encodeURIComponent(since)}`);
    if (r.ok && r.body && r.body.success) {
      const cnt = r.body.count ?? (r.body.orders || []).length;
      check('[4] recent 补推返回 success', true, `since=${since.slice(0, 19)}Z, count=${cnt}`);
      const orders = r.body.orders || [];
      if (orders.length) sampleOrder = orders[0];
    } else {
      check('[4] recent 补推返回 success', false, `HTTP ${r.status} / ${JSON.stringify(r.body).slice(0, 120)}`);
    }
  } catch (e) {
    check('[4] recent 补推返回 success', false, String(e));
  }

  // [6] 可选：触发真实同步，SSE 应实时收到 new_order
  let triggeredOrder = null;
  if (SESSION_COOKIE) {
    let targetStore = STORE_ID;
    if (!targetStore) {
      const sl = await fetchJson(`${BASE}/api/ml/stores`);
      if (sl.ok && Array.isArray(sl.body?.stores) && sl.body.stores.length) targetStore = sl.body.stores[0].id;
    }
    if (targetStore) {
      note(`触发同步店铺 ${targetStore} ...`);
      // 清空之前的 new_order，便于判断本次是否触发
      sse.got.newOrder = null;
      const sr = await fetchJson(`${BASE}/api/ml/stores/${targetStore}/sync-orders`, { method: 'POST' });
      if (sr.ok) {
        const gotNew = await sse.waitUntil((g) => !!g.newOrder, TIMEOUT_MS);
        if (gotNew) {
          triggeredOrder = sse.got.newOrder;
          check('[6] 触发同步后 SSE 实时收到 new_order', true, `orderId=${triggeredOrder.orderId}, store=${triggeredOrder.storeName}`);
        } else {
          check('[6] 触发同步后 SSE 实时收到 new_order', false, '同步成功但未检测到 new_order（可能该店铺无新增订单）');
        }
      } else {
        check('[6] 触发同步后 SSE 实时收到 new_order', false, `同步请求失败 HTTP ${sr.status}`);
      }
    } else {
      note('[6] 未取到店铺 ID，跳过实时触发（可手动设置 STORE_ID）');
    }
  } else {
    note('[6] 未提供 SESSION_COOKIE，跳过实时 new_order 触发（手动验证：在桌面端产生/同步新订单，观察 APP 消息中心）');
  }

  // [5] 详情拉取（优先用触发的 new_order，其次用 recent 样本）
  const detTarget = triggeredOrder || sampleOrder;
  if (detTarget && detTarget.storeId && detTarget.orderId) {
    try {
      const r = await fetchJson(`${BASE}/api/mobile/orders/${encodeURIComponent(detTarget.storeId)}/${encodeURIComponent(detTarget.orderId)}`);
      if (r.ok && r.body && r.body.success) {
        const hasSummary = !!r.body.summary;
        const hasSms = !!(r.body.smsContent && (r.body.smsContent.text || r.body.smsContent.markdown || r.body.smsContent.emailHtml));
        const itemsOk = Array.isArray(r.body.summary?.items);
        check('[5] 详情含 summary', hasSummary, hasSummary ? `orderId=${r.body.summary.orderId}` : '缺失');
        check('[5b] 详情含 smsContent（短信原文）', hasSms);
        check('[5c] summary.items 可渲染', itemsOk, itemsOk ? `商品数=${r.body.summary.items.length}` : '非数组');
      } else {
        check('[5] 详情拉取', false, `HTTP ${r.status} / ${JSON.stringify(r.body).slice(0, 120)}`);
      }
    } catch (e) {
      check('[5] 详情拉取', false, String(e));
    }
  } else {
    skip('[5] 详情拉取', '无可用 storeId/orderId（系统当前无订单样本；有订单或设置 SESSION_COOKIE+STORE_ID 触发同步后再跑即可验证）');
  }

  // 收尾
  sse.close();

  // 手动验证提示
  console.log('\n🧪 需真机手动验证（脚本无法替代）：');
  console.log('   - 杀掉 APP 再产生新订单 → 手机弹系统通知，点通知跳详情正常');
  console.log('   - 断网 1 分钟恢复 → 回前台 recent 补推把漏的单补回（不重复、不漏）');
  console.log('   - 通知栏点击/App 内「订单」Tab 角标与 NEW 红标、已读褪色');

  const failed = results.filter((r) => !r.ok);
  return finish(failed.length === 0);
}

function finish(allOk) {
  console.log(`\n${allOk ? '🎉 全部自动检查通过' : '⚠️  存在失败项，详见上方 ❌'}`);
  console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length} | 跳过 ${skipped.length}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
