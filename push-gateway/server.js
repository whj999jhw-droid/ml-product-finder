/**
 * ml-product-finder 推送中转服务（webhook）
 * ===========================================================================
 * 作用：ml-product-finder 后端在「检测到美客多新订单」时，会 POST 一个 JSON 到
 *       环境变量 MOBILE_PUSH_WEBHOOK 指向的地址（也就是本服务）。
 *       本服务再调用 极光 JPush（安卓，含国内厂商通道）/ APNs（苹果）/
 *       FCM（安卓备选）把系统通知发到手机，实现「APP 被杀掉 / 关了也能弹通知」。
 *
 * 后端发来的请求体（固定格式，不要改字段名）：
 *   {
 *     "device": { "deviceId": "...", "platform": "android" | "ios", "token": "推送令牌" },
 *     "event":  { "type": "new_order", "storeId": "...", "storeName": "...", "orderId": "...", "total": "...", "buyer": "...", ... }
 *   }
 *
 * 启动：
 *   1) npm install
 *   2) 配置下方环境变量（安卓至少配 JPush 或 FCM 之一；苹果配 APNs）
 *   3) npm start
 *   4) 把本服务的公网 HTTPS 地址 + /push 填到后端 MOBILE_PUSH_WEBHOOK
 *
 * 详细配置见同目录 README.md
 */

import express from 'express';
import admin from 'firebase-admin';
import path from 'path';
import fs from 'fs';

const app = express();
app.use(express.json());

// 仅监听本机 loopback：外部无法访问，无需开放防火墙；后端经 MOBILE_PUSH_WEBHOOK 调用
const PORT = process.env.PORT || 4100;
const HOST = '127.0.0.1';

// ---------- 0. 极光 JPush（安卓，含国内厂商通道） ----------
// 注意：极光「一个包名对应一个 AppKey」。本项目安卓有两个包名：
//   v1 = com.mercadoprofit（主应用）
//   v2 = com.mercadoprofit.v2（需去极光单独建一个应用，包名填这个）
// 因此这里支持两套凭证，按设备上报的 pkg 字段路由。
const JPUSH_APP_KEY = process.env.JPUSH_APP_KEY || '';
const JPUSH_MASTER_SECRET = process.env.JPUSH_MASTER_SECRET || '';
const JPUSH_APP_KEY_V2 = process.env.JPUSH_APP_KEY_V2 || '';
const JPUSH_MASTER_SECRET_V2 = process.env.JPUSH_MASTER_SECRET_V2 || '';
const jpushReady = Boolean(JPUSH_APP_KEY && JPUSH_MASTER_SECRET);
const jpushV2Ready = Boolean(JPUSH_APP_KEY_V2 && JPUSH_MASTER_SECRET_V2);
if (jpushReady) {
  console.log('[gateway] JPush（极光）已配置，安卓 v1 推送可用（含华为/小米/OPPO/VIVO/魅族厂商通道）');
} else {
  console.warn('[gateway] 未配置 JPUSH_APP_KEY / JPUSH_MASTER_SECRET，安卓 v1 JPush 未启用（可用 FCM 备选或去极光控制台申请）');
}
if (jpushV2Ready) {
  console.log('[gateway] JPush（极光 v2）已配置，安卓 v2 推送可用');
} else {
  console.warn('[gateway] 未配置 JPUSH_APP_KEY_V2 / JPUSH_MASTER_SECRET_V2，安卓 v2 JPush 未启用（v2 需单独在极光建应用）');
}

// ---------- 1. 初始化 FCM（安卓备选） ----------
let fcmReady = false;
const SERVICE_ACCOUNT = process.env.FCM_SERVICE_ACCOUNT || path.join(process.cwd(), 'service-account.json');
if (process.env.FCM_PROJECT_ID || fs.existsSync(SERVICE_ACCOUNT)) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(SERVICE_ACCOUNT),
      projectId: process.env.FCM_PROJECT_ID,
    });
    fcmReady = true;
    console.log('[gateway] FCM (Firebase Admin) 已初始化，安卓 FCM 备选可用');
  } catch (e) {
    console.warn('[gateway] FCM 初始化失败（安卓 FCM 备选将不可用）：', e.message);
  }
} else {
  console.warn('[gateway] 未找到 FCM 凭证，安卓 FCM 备选未启用；若只做 iOS 可忽略');
}

// ---------- 2. 初始化 APNs（苹果） ----------
let apnProvider = null;
if (process.env.APNS_KEY_PATH || fs.existsSync(path.join(process.cwd(), 'AuthKey.p8'))) {
  try {
    const APN = (await import('apn')).default;
    apnProvider = new APN.Provider({
      token: {
        key: process.env.APNS_KEY_PATH || path.join(process.cwd(), 'AuthKey.p8'),
        keyId: process.env.APNS_KEY_ID,
        teamId: process.env.APNS_TEAM_ID,
      },
      production: process.env.APNS_PRODUCTION === 'true', // true=线上环境 false/默认=沙盒
    });
    console.log('[gateway] APNs 已初始化，苹果推送可用');
  } catch (e) {
    console.warn('[gateway] APNs 初始化失败（苹果推送将不可用）：', e.message);
  }
} else {
  console.warn('[gateway] 未找到 APNs 凭证，苹果推送未启用；若只做安卓可忽略');
}

// ---------- 3. 中转接口：后端会 POST 到这里 ----------
app.post('/push', async (req, res) => {
  try {
    const { device, event } = req.body || {};
    if (!device || !event) {
      return res.status(400).json({ ok: false, msg: '缺少 device / event' });
    }
    if (!device.token) {
      return res.status(400).json({ ok: false, msg: 'device.token 为空' });
    }

    // 通知栏标题/正文（直接用后端 new_order 事件的字段）
    const title = '🔔 新订单 ' + (event.orderId || '');
    // 未发货订单把「履约剩余」带进通知正文，强调发货紧迫感
    const fulfillSuffix =
      event.remainingHoursText && event.remainingHoursText !== '—'
        ? ' | ⏰ 履约剩余 ' + event.remainingHoursText
        : '';
    const body = (event.storeName || '') + ' | ' + (event.total || '') + ' | 买家:' + (event.buyer || '') + fulfillSuffix;

    // 点开通知后跳转订单详情所需的参数（后端详情接口用 storeId + orderId）
    const data = {
      type: 'new_order',
      storeId: String(event.storeId || ''),
      orderId: String(event.orderId || ''),
    };

    let result;
    if (device.platform === 'ios') {
      if (!apnProvider) throw new Error('APNs 未初始化（缺少 AuthKey.p8 / APNS_KEY_ID / APNS_TEAM_ID）');
      result = await sendApns(device.token, title, body, data);
    } else {
      // 安卓：根据设备 pkg 选对应极光应用凭证（v2 包名 com.mercadoprofit.v2 用 v2 凭证）
      const pkg = String(device.pkg || '').toLowerCase();
      if (pkg === 'com.mercadoprofit.v2' && jpushV2Ready) {
        result = await sendJpush(device.token, title, body, data, JPUSH_APP_KEY_V2, JPUSH_MASTER_SECRET_V2);
      } else if (jpushReady) {
        result = await sendJpush(device.token, title, body, data, JPUSH_APP_KEY, JPUSH_MASTER_SECRET);
      } else if (jpushV2Ready) {
        // v2 凭证就绪但 pkg 不是 v2（理论不会到这），兜底也用 v2 凭证
        result = await sendJpush(device.token, title, body, data, JPUSH_APP_KEY_V2, JPUSH_MASTER_SECRET_V2);
      } else if (fcmReady) {
        result = await sendFcm(device.token, title, body, data);
      } else {
        throw new Error('安卓推送未配置：请配置 JPUSH_APP_KEY/JPUSH_MASTER_SECRET（或 v2 凭证），或 FCM 凭证');
      }
    }
    res.json({ ok: true, platform: device.platform, ...result });
  } catch (e) {
    console.error('[gateway] 推送失败:', e.message);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// GET /push 用于自检（返回 405 说明服务在跑）
app.get('/push', (_req, res) => res.status(405).json({ ok: false, msg: '请用 POST' }));

// ---------- 4. 具体推送实现 ----------

// 极光 JPush v3 Push API（纯 fetch，无需额外依赖）
// appKey / masterSecret 可指定（用于 v2 等独立包名的应用）；缺省用主凭证
async function sendJpush(registrationId, title, body, data, appKey, masterSecret) {
  const ak = appKey || JPUSH_APP_KEY;
  const ms = masterSecret || JPUSH_MASTER_SECRET;
  const basic = Buffer.from(ak + ':' + ms).toString('base64');
  const payload = {
    platform: 'android',
    audience: { registration_id: [String(registrationId)] },
    notification: {
      android: {
        alert: body,
        title,
        extras: data, // 自定义字段：点击通知时 App 读取，用于跳订单详情
      },
    },
    message: {
      msg_content: body,
      title,
      extras: data,
    },
    options: {
      apns_production: false,
    },
  };
  const resp = await fetch('https://api.jpush.cn/v3/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + basic,
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* 保留原始文本 */ }
  if (!resp.ok) {
    const msg = (json && json.error && json.error.message) || text || ('HTTP ' + resp.status);
    throw new Error('JPush 返回错误：' + msg);
  }
  console.log('[gateway] JPush 发送成功:', JSON.stringify(json));
  return { provider: 'jpush', msgId: json.msg_id || '', sendno: json.sendno || '' };
}

async function sendFcm(token, title, body, data) {
  if (!fcmReady) throw new Error('FCM 未初始化（缺少 service-account.json 或 FCM_PROJECT_ID）');
  const message = {
    token,
    notification: { title, body },
    data, // FCM data 字段值必须是 string
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } }, // 若 iOS 也用 FCM，这里让它响铃
  };
  const messageId = await admin.messaging().send(message);
  console.log('[gateway] FCM 发送成功:', messageId);
  return { provider: 'fcm', messageId };
}

async function sendApns(token, title, body, data) {
  if (!apnProvider) throw new Error('APNs 未初始化（缺少 AuthKey.p8 / APNS_KEY_ID / APNS_TEAM_ID）');
  const note = new (await import('apn')).Notification();
  note.alert = { title, body };
  note.payload = data;
  note.topic = process.env.APNS_TOPIC; // 必须是 APP 的 bundle id（本项目 com.mercadoprofit.ios）
  note.sound = 'default';
  note.badge = 1; // App 被杀时也能在图标上显示未读角标
  note.priority = 10;
  const response = await apnProvider.send(note, token);
  const failed = response.failed.length;
  console.log('[gateway] APNs 发送完成（成功 ' + response.sent.length + '，失败 ' + failed + '）');
  return { provider: 'apns', sent: response.sent.length, failed };
}

app.listen(PORT, HOST, () => {
  console.log('推送中转服务已启动： http://' + HOST + ':' + PORT + '/push');
  console.log('该地址仅本机可访问（后端经 MOBILE_PUSH_WEBHOOK 调用），无需公网 HTTPS、无需开放防火墙。');
  console.log('已启用的推送通道：',
    'JPush(安卓)=' + jpushReady, '| FCM(安卓备选)=' + fcmReady, '| APNs(苹果)=' + Boolean(apnProvider));
});
