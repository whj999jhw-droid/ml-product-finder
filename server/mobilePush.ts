/**
 * 手机 APP 订单推送模块
 * ---------------------------------------------------------------------------
 * 职责：
 *  1) SSE 实时流：手机 APP 在前台时保持一条 /api/mobile/stream 长连接，
 *     服务器一旦检测到新订单就立刻通过这条连接 push 一条 new_order 事件。
 *  2) 设备注册：APP 上报自己的推送令牌（FCM / APNs token 或自建网关 token），
 *     服务器保存后，APP 在后台/被杀时也能经由外部推送网关唤醒。
 *  3) 统一广播入口 broadcastNewOrder：同时发给「已连接的 SSE 客户端」和
 *     「已注册设备（经 MOBILE_PUSH_WEBHOOK 网关）」。
 *
 * 设计取舍：
 *  - 真正的手机后台唤醒依赖 FCM/APNs，需要密钥与网关，本机无法直连。
 *    因此默认用「SSE（前台实时）+ 可配置推送网关（后台唤醒）」组合：
 *    设置环境变量 MOBILE_PUSH_WEBHOOK 指向你的推送中转服务，该服务再调用
 *    FCM/APNs。未配置时仅 SSE 生效（APP 在前台/刚回到前台时实时收消息）。
 *  - 设备令牌持久化到 data/mobile-devices.json，重启不丢失。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEVICES_FILE = path.join(__dirname, '..', 'data', 'mobile-devices.json');

interface SseClient {
  id: string;
  res: any;
  lastPing: number;
}

interface DeviceRecord {
  deviceId: string;
  platform: 'ios' | 'android' | 'other';
  token: string;
  appVersion?: string;
  // 应用包名：安卓 v1=com.mercadoprofit，v2=com.mercadoprofit.v2
  // 推送网关据此选对应的极光应用凭证（一个包名 = 一个 AppKey）
  pkg?: string;
  updatedAt: string;
}

const sseClients = new Map<string, SseClient>();
const devices = new Map<string, DeviceRecord>();

// 启动时载入已注册设备
try {
  if (fs.existsSync(DEVICES_FILE)) {
    const arr = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf-8'));
    if (Array.isArray(arr)) arr.forEach((d: DeviceRecord) => devices.set(d.deviceId, d));
  }
} catch {
  /* 忽略损坏的设备文件 */
}

function saveDevices(): void {
  try {
    fs.mkdirSync(path.dirname(DEVICES_FILE), { recursive: true });
    fs.writeFileSync(DEVICES_FILE, JSON.stringify([...devices.values()], null, 2));
  } catch {
    /* 忽略写入失败 */
  }
}

// ============ SSE 客户端管理 ============
export function addSseClient(id: string, res: any): void {
  sseClients.set(id, { id, res, lastPing: Date.now() });
}

export function removeSseClient(id: string): void {
  sseClients.delete(id);
}

export function activeSseCount(): number {
  return sseClients.size;
}

export function getDevices(): DeviceRecord[] {
  return [...devices.values()];
}

// ============ 设备注册 ============
export function registerDevice(d: DeviceRecord): DeviceRecord {
  const rec: DeviceRecord = { ...d, updatedAt: new Date().toISOString() };
  devices.set(d.deviceId, rec);
  saveDevices();
  return rec;
}

// ============ 新订单事件构造 ============
/** 构造一条「新订单」事件，供 SSE 与设备推送复用（字段精简，便于通知栏直接展示） */
export function buildNewOrderEvent(store: { id?: string; nickname?: string; site: string }, order: any): any {
  const items = order.order_items || order.items || [];
  const total =
    order.total && typeof order.total === 'object'
      ? `${order.total.currency_id || ''} ${order.total.amount ?? ''}`.trim()
      : order.paid_amount != null
        ? `${order.currency_id || ''} ${typeof order.paid_amount === 'object' ? order.paid_amount.amount : order.paid_amount}`.trim()
        : '';
  return {
    type: 'new_order',
    storeId: store.id || '',
    storeName: store.nickname || store.site,
    site: store.site,
    orderId: String(order.id),
    dateCreated: order.date_created || '',
    status: order.status || '',
    total,
    buyer: order.buyer?.nickname || order.buyer?.id || '',
    itemCount: items.length,
    itemTitles: items.slice(0, 3).map((it: any) => it.item?.title || it.title || ''),
    handlingDeadline: order.handlingDeadline || null,
    remainingHours: order.remainingHours ?? null,
    remainingHoursText: order.remainingHoursText || '—',
    serverTime: new Date().toISOString(),
  };
}

// ============ 广播 ============
function sendSse(client: SseClient, event: string, data: any): void {
  try {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* 连接已断开，下次心跳/close 会清理 */
  }
}

/** 服务器检测到新订单时调用：实时推给前台 SSE 客户端，并推给后台设备 */
export function broadcastNewOrder(store: { id?: string; nickname?: string; site: string }, order: any): void {
  const event = buildNewOrderEvent(store, order);
  // 1) 实时推给已连接的 SSE 客户端（APP 在前台 / 刚回到前台）
  for (const c of sseClients.values()) sendSse(c, 'new_order', event);
  // 2) 推给已注册设备（APP 在后台 / 被杀，走外部推送网关唤醒）
  pushToDevices(event).catch(() => {});
}

async function pushToDevices(event: any): Promise<void> {
  const webhook = process.env.MOBILE_PUSH_WEBHOOK;
  if (!webhook) return; // 未配置推送网关时，仅依赖 SSE（前台实时）
  for (const d of devices.values()) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: d, event }),
      });
    } catch {
      /* 忽略单台设备推送失败 */
    }
  }
}
