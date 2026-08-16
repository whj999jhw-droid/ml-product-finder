/**
 * ml-product-finder 推送中转服务（webhook）
 * ===========================================================================
 * 作用：ml-product-finder 后端在「检测到美客多新订单」时，会 POST 一个 JSON 到
 *       环境变量 MOBILE_PUSH_WEBHOOK 指向的地址（也就是本服务）。
 *       本服务再调用 FCM（安卓）/ APNs（苹果）把系统通知发到手机。
 *
 * 后端发来的请求体（固定格式，不要改字段名）：
 *   {
 *     "device": { "deviceId": "...", "platform": "android" | "ios", "token": "推送令牌" },
 *     "event":  { "type": "new_order", "storeId": "...", "storeName": "...", "orderId": "...", "total": "...", "buyer": "...", ... }
 *   }
 *
 * 启动：
 *   1) npm install
 *   2) 配置下方环境变量（至少配一项：安卓配 FCM，苹果配 APNs）
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

// ---------- 1. 初始化 FCM（安卓） ----------
let fcmReady = false;
const SERVICE_ACCOUNT = process.env.FCM_SERVICE_ACCOUNT || path.join(process.cwd(), 'service-account.json');
if (process.env.FCM_PROJECT_ID || fs.existsSync(SERVICE_ACCOUNT)) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(SERVICE_ACCOUNT),
      projectId: process.env.FCM_PROJECT_ID,
    });
    fcmReady = true;
    console.log('[gateway] FCM (Firebase Admin) 已初始化，安卓推送可用');
  } catch (e) {
    console.warn('[gateway] FCM 初始化失败（安卓推送将不可用）：', e.message);
  }
} else {
  console.warn('[gateway] 未找到 FCM 凭证，安卓推送未启用；若只做 iOS 可忽略');
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
    const title = `🔔 新订单 ${event.orderId || ''}`;
    const body = `${event.storeName || ''} | ${event.total || ''} | 买家:${event.buyer || ''}`;

    // 点开通知后跳转订单详情所需的参数（后端详情接口用 storeId + orderId）
    const data = {
      type: 'new_order',
      storeId: String(event.storeId || ''),
      orderId: String(event.orderId || ''),
    };

    let result;
    if (device.platform === 'ios') {
      result = await sendApns(device.token, title, body, data);
    } else {
      result = await sendFcm(device.token, title, body, data);
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
  return { messageId };
}

async function sendApns(token, title, body, data) {
  if (!apnProvider) throw new Error('APNs 未初始化（缺少 AuthKey.p8 / APNS_KEY_ID / APNS_TEAM_ID）');
  const note = new (await import('apn')).Notification();
  note.alert = { title, body };
  note.payload = data;
  note.topic = process.env.APNS_TOPIC; // 通常是 APP 的 bundle id
  note.sound = 'default';
  note.priority = 10;
  const response = await apnProvider.send(note, token);
  const failed = response.failed.length;
  console.log(`[gateway] APNs 发送完成（成功 ${response.sent.length}，失败 ${failed}）`);
  return { sent: response.sent.length, failed };
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n推送中转服务已启动： http://localhost:${PORT}/push`);
  console.log('请把该地址（需为公网 HTTPS）配置到后端的 MOBILE_PUSH_WEBHOOK 环境变量。\n');
});
