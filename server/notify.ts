/**
 * 新订单通知：邮件（复用 SMTP 配置）+ 短信（Twilio / 通用 Webhook）
 * 是否启用由 notify-config 控制；短信渠道由 sms-config 配置。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import { getEmailConfig } from './email.js';
import { getTunnelInfo } from './tunnel.js';
import { getEffectiveRedirectUri } from './mercadolibre.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SMS_FILE = path.join(__dirname, '..', 'data', 'sms-config.json');
const NOTIFY_FILE = path.join(__dirname, '..', 'data', 'notify-config.json');

export type WebhookType = 'generic' | 'dingtalk' | 'wecom' | 'bark';

export interface SmsConfig {
  provider: 'none' | 'twilio' | 'webhook';
  // twilio
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  toNumber?: string;
  // webhook（任何短信网关都可通过 POST JSON 触发，如阿里云/腾讯云/自建）
  webhookUrl?: string;
  webhookType?: WebhookType;
}

export interface NotifyConfig {
  orderAlertsEnabled: boolean; // 总开关：是否对每 5 分钟拉到的新订单发提醒
  emailEnabled: boolean;
  smsEnabled: boolean;
  pollIntervalMinutes: number; // 订单轮询间隔（默认 30 分钟）
}

let smsConfig: SmsConfig = { provider: 'none' };
let notifyConfig: NotifyConfig = { orderAlertsEnabled: false, emailEnabled: true, smsEnabled: false, pollIntervalMinutes: 30 };

function loadSms() {
  try {
    if (fs.existsSync(SMS_FILE)) smsConfig = { ...smsConfig, ...JSON.parse(fs.readFileSync(SMS_FILE, 'utf-8')) };
  } catch {
    /* ignore */
  }
}
function loadNotify() {
  try {
    if (fs.existsSync(NOTIFY_FILE)) notifyConfig = { ...notifyConfig, ...JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf-8')) };
  } catch {
    /* ignore */
  }
}
loadSms();
loadNotify();

function saveSms() {
  try {
    const dir = path.dirname(SMS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SMS_FILE, JSON.stringify(smsConfig, null, 2));
  } catch {
    /* ignore */
  }
}
function saveNotify() {
  try {
    const dir = path.dirname(NOTIFY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(NOTIFY_FILE, JSON.stringify(notifyConfig, null, 2));
  } catch {
    /* ignore */
  }
}

export function getSmsConfig(): SmsConfig {
  const c = { ...smsConfig };
  if (c.authToken) c.authToken = '****';
  // 旧配置没有 webhookType 时，根据 URL 智能推断
  if (c.provider === 'webhook' && !c.webhookType && c.webhookUrl) {
    if (c.webhookUrl.includes('oapi.dingtalk.com')) c.webhookType = 'dingtalk';
    else if (c.webhookUrl.includes('qyapi.weixin.qq.com')) c.webhookType = 'wecom';
    else if (c.webhookUrl.includes('day.app')) c.webhookType = 'bark';
    else c.webhookType = 'generic';
  }
  return c;
}

export function saveSmsConfig(patch: Partial<SmsConfig>): SmsConfig {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (smsConfig as any)[k] = v;
  }
  saveSms();
  return getSmsConfig();
}

export function getNotifyConfig(): NotifyConfig {
  return { ...notifyConfig };
}

export function saveNotifyConfig(patch: Partial<NotifyConfig>): NotifyConfig {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (notifyConfig as any)[k] = v;
  }
  // 兜底：非法/过小间隔重置为 30 分钟
  if (typeof notifyConfig.pollIntervalMinutes !== 'number' || notifyConfig.pollIntervalMinutes < 1) {
    notifyConfig.pollIntervalMinutes = 30;
  }
  saveNotify();
  return { ...notifyConfig };
}

export function getPollIntervalMs(): number {
  const min = typeof notifyConfig.pollIntervalMinutes === 'number' && notifyConfig.pollIntervalMinutes >= 1
    ? notifyConfig.pollIntervalMinutes
    : 30;
  return min * 60 * 1000;
}

async function sendEmailAlert(subject: string, textBody: string, htmlBody?: string): Promise<{ success: boolean; message: string }> {
  const cfg = getEmailConfig();
  if (!cfg.enabled || !cfg.host || !cfg.user || !cfg.to) {
    return { success: false, message: '邮件未启用或未配置（需在「邮件通知」中开启并填好 SMTP + 收件人）' };
  }
  try {
    const smtp = { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass, from: cfg.from || cfg.user };
    const transporter = nodemailer.createTransport(smtp);
    await transporter.sendMail({ from: smtp.from, to: cfg.to, subject, text: textBody, html: htmlBody });
    return { success: true, message: '邮件已发送' };
  } catch (e: any) {
    return { success: false, message: e?.message || '发送失败' };
  }
}

/** 外部可调用：仅发送一条测试短信/消息 */
export async function sendTestSms(text: string = 'ML Product Finder 短信测试'): Promise<{ success: boolean; message: string }> {
  return sendSmsAlert(text);
}

/** 测试时使用前端传入的临时配置（未保存也能测） */
export async function sendTestSmsWithConfig(text: string = 'ML Product Finder 短信测试', cfg?: Partial<SmsConfig>): Promise<{ success: boolean; message: string }> {
  return sendSmsAlert(text, cfg);
}

async function sendSmsAlert(text: string, override?: Partial<SmsConfig>): Promise<{ success: boolean; message: string }> {
  const cfg: SmsConfig = override ? { ...smsConfig, ...override } : smsConfig;
  if (cfg.provider === 'twilio') {
    const { accountSid, authToken, fromNumber, toNumber } = cfg;
    if (!accountSid || !authToken || !fromNumber || !toNumber) {
      return { success: false, message: 'Twilio 未配置完整（需 accountSid/authToken/fromNumber/toNumber）' };
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const body = new URLSearchParams({ From: fromNumber, To: toNumber, Body: text });
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const data = await resp.json();
    if (!resp.ok) return { success: false, message: `Twilio 失败: ${JSON.stringify(data).slice(0, 200)}` };
    return { success: true, message: '短信已发送(Twilio)' };
  }
  if (cfg.provider === 'webhook') {
    if (!cfg.webhookUrl) return { success: false, message: 'Webhook 未配置' };
    let type = cfg.webhookType;
    if (!type) {
      if (cfg.webhookUrl.includes('oapi.dingtalk.com')) type = 'dingtalk';
      else if (cfg.webhookUrl.includes('qyapi.weixin.qq.com')) type = 'wecom';
      else if (cfg.webhookUrl.includes('day.app')) type = 'bark';
      else type = 'generic';
    }
    let body: any;
    if (type === 'dingtalk') {
      // 钉钉机器人支持 markdown，可展示图片链接
      body = { msgtype: 'markdown', markdown: { title: '新订单提醒', text } };
    } else if (type === 'wecom') {
      // 企业微信机器人 markdown
      body = { msgtype: 'markdown', markdown: { content: text } };
    } else if (type === 'bark') {
      // Bark 推送：title + body
      body = { title: '新订单提醒', body: text };
    } else {
      // 通用：兼容阿里云/腾讯云/自建云函数
      body = { text, content: text, message: text };
    }
    const resp = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const respText = await resp.text().catch(() => '');
    if (!resp.ok) return { success: false, message: `Webhook 失败 ${resp.status}: ${respText.slice(0, 200)}` };
    return { success: true, message: `短信已触发(Webhook/${type})` };
  }
  return { success: false, message: '短信未配置（provider=none）' };
}

export interface NotifyResult {
  text: string;      // 邮件正文（纯文本）
  smsText: string;   // 短信/Webhook 正文（markdown，可展示图片）
  html: string;      // 邮件 HTML 正文（含商品图片）
  results: Array<{ channel: string; success: boolean; message: string }>;
}

function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function formatOrderTotal(order: any): { amount?: number; currency?: string; text: string } {
  // 1. 标准 total 对象（普通站点 /orders/{id}）
  if (order.total && typeof order.total === 'object') {
    return {
      amount: order.total.amount,
      currency: order.total.currency_id,
      text: `${order.total.currency_id || ''} ${order.total.amount ?? ''}`.trim(),
    };
  }
  // 2. total 是数字
  if (typeof order.total === 'number') {
    return { amount: order.total, currency: order.currency_id, text: `${order.currency_id || ''} ${order.total}`.trim() };
  }
  // 3. CBT 跨境订单的 total 为 null，金额在 paid_amount 字段
  if (order.paid_amount != null) {
    const amt = typeof order.paid_amount === 'object' ? order.paid_amount.amount : order.paid_amount;
    const cur = order.currency_id || (order.paid_amount?.currency_id || '');
    return { amount: amt, currency: cur, text: `${cur} ${amt ?? ''}`.trim() };
  }
  return { text: '' };
}

function isHttps(u: any): boolean {
  return typeof u === 'string' && u.startsWith('https');
}

/**
 * 提取某订单项的全部商品图片：主图优先、去重、保证 https（钉钉 markdown 只渲染 https 图）。
 * 主图优先用 itemThumbnail（enrich 显式设置的主图）；不同商品图片数量不同，按实际数量返回，最多 max 张。
 */
function extractItemImages(item: any, max = 9): string[] {
  const it = item?.item || item;
  let list: string[] = [];
  if (Array.isArray(it?.itemImages)) list = it.itemImages.slice();
  else if (Array.isArray(it?.pictures)) list = it.pictures.map((p: any) => p?.secure_url || p?.url || p).filter(Boolean);
  else if (it?.thumbnail) list = [it.thumbnail];

  const main = it?.itemThumbnail || it?.thumbnail || null;
  // 主图优先：本身是 https 直接用；否则用第一张 https 图当主图；再退化为任意可用图
  const mainToUse = (main && isHttps(main)) ? main : (list.find(isHttps) || main || list[0] || null);

  const seen = new Set<string>();
  const out: string[] = [];
  if (mainToUse) { out.push(mainToUse); seen.add(mainToUse); }
  for (const u of list) {
    if (u && !seen.has(u)) { out.push(u); seen.add(u); }
  }
  return out.slice(0, max);
}

function formatOrderItems(order: any, maxImages = 3): { title?: string; quantity?: number; price?: string; images: string[] }[] {
  const items = order.order_items || order.items || [];
  return items.map((it: any) => {
    const item = it.item || it;
    const price = it.unit_price || item?.price;
    const priceText = price && typeof price === 'object' ? `${price.currency_id || ''} ${price.amount ?? ''}`.trim() : '';
    return {
      title: item?.title || item?.name || '未知商品',
      quantity: it.quantity || 1,
      price: priceText,
      images: extractItemImages(it, maxImages),
    };
  });
}

export interface NotifyContent {
  text: string;      // 邮件正文（纯文本）
  smsText: string;   // 短信/Webhook 正文（markdown，可展示图片）
  html: string;      // 邮件 HTML 正文（含商品图片）
}

/** 仅拼装订单通知文案（不发送），供真实推送与测试预览共用 */
export function buildOrderNotify(store: { nickname?: string; site: string }, order: any): NotifyContent {
  const storeName = store.nickname || store.site;
  const totalInfo = formatOrderTotal(order);
  const buyer = order.buyer?.nickname || order.buyer?.id || '';
  // 钉钉消息：每商品只放 1 张主图（保持简短），全部图片通过下方「查看全部」链接在网页查看
  const itemsSms = formatOrderItems(order, 1);
  const itemsHtml = formatOrderItems(order, 8); // 邮件无长度限制，仍展示最多 8 张

  // 邮件正文（纯文本，不含图片）
  const itemLines = itemsSms.map((it, idx) => `${idx + 1}. ${it.title}${it.quantity ? ` x${it.quantity}` : ''}${it.price ? ` (${it.price})` : ''}`);
  const text = [
    `【美客多新订单】`,
    `店铺：${storeName}`,
    `订单号：${order.id}`,
    `金额：${totalInfo.text || '未知'}`,
    `买家：${buyer || '未知'}`,
    `下单时间：${order.date_created || ''}`,
    itemsSms.length ? `商品：\n${itemLines.join('\n')}` : '',
  ].filter(Boolean).join('\n');

  // Webhook/短信正文（markdown）：每商品 1 张主图，末尾附「查看全部图片」链接，避免消息过长
  const itemTexts = itemsSms.map((it, idx) => {
    const line = `${idx + 1}. ${it.title}${it.quantity ? ` x${it.quantity}` : ''}${it.price ? ` (${it.price})` : ''}`;
    const imgs = it.images.length ? '\n' + it.images.map((u) => `![商品图](${u})`).join('\n') : '';
    return line + imgs;
  });
  // 记录全量图片到文件缓存（供「查看全部」网页展示），并统计总张数
  const totalImgs = (order.order_items || order.items || []).reduce(
    (sum: number, it: any) => sum + extractItemImages(it, 30).length, 0,
  );
  recordOrderImages(String(order.id), storeName, order);
  const imagesLink = totalImgs > 0
    ? `\n\n[📷 查看全部 ${totalImgs} 张商品图](${getPublicBase()}/api/ml/order-images/${encodeURIComponent(String(order.id))})`
    : '';
  const smsText = [
    `新订单 ${order.id} | 店铺:${storeName} | 金额:${totalInfo.text || '未知'} | 买家:${buyer || '未知'}`,
    itemsSms.length ? `商品：\n${itemTexts.join('\n')}` : '',
    imagesLink,
  ].filter(Boolean).join('\n');

  // 邮件 HTML 正文（每商品展示主图 + 其余图，最多 8 张，可横向排列）
  const itemHtml = itemsHtml.map((it, idx) => {
    const imgs = it.images.length
      ? '<div style="margin-top:6px;">' + it.images.map((u) =>
          `<img src="${escapeHtml(u)}" style="width:90px;height:90px;object-fit:cover;margin-right:6px;border:1px solid #eee;border-radius:4px;" />`,
        ).join('') + '</div>'
      : '';
    return `<div style="margin-bottom:12px;">${idx + 1}. ${escapeHtml(it.title)}${it.quantity ? ` x${it.quantity}` : ''}${it.price ? ` (${escapeHtml(it.price)})` : ''}${imgs}</div>`;
  }).join('');
  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.7;">`,
    `<h3 style="margin:0 0 8px;">【美客多新订单】</h3>`,
    `<p style="margin:0 0 4px;">店铺：${escapeHtml(storeName)}</p>`,
    `<p style="margin:0 0 4px;">订单号：${escapeHtml(String(order.id))}</p>`,
    `<p style="margin:0 0 4px;">金额：${escapeHtml(totalInfo.text || '未知')}</p>`,
    `<p style="margin:0 0 4px;">买家：${escapeHtml(buyer || '未知')}</p>`,
    `<p style="margin:0 0 12px;">下单时间：${escapeHtml(order.date_created || '')}</p>`,
    itemsHtml.length ? `<h4 style="margin:0 0 8px;">商品：</h4>${itemHtml}` : '',
    `</div>`,
  ].filter(Boolean).join('\n');

  return { text, smsText, html };
}

/** 拼装并实际发送新订单通知（邮件 + 短信/Webhook），供真实订单轮询调用 */
export async function notifyNewOrder(store: { nickname?: string; site: string }, order: any): Promise<NotifyResult> {
  const content = buildOrderNotify(store, order);
  const results: Array<{ channel: string; success: boolean; message: string }> = [];
  if (notifyConfig.orderAlertsEnabled && notifyConfig.emailEnabled) {
    results.push({ channel: 'email', ...(await sendEmailAlert(`[ML] 新订单 ${order.id} - ${store.nickname || store.site}`, content.text, content.html)) });
  }
  if (notifyConfig.orderAlertsEnabled && notifyConfig.smsEnabled) {
    results.push({ channel: 'sms', ...(await sendSmsAlert(content.smsText)) });
  }
  return { ...content, results };
}

/**
 * 订单商品图片「查看全部」网页：钉钉消息只放主图（简短），点击链接在浏览器看该订单所有商品图。
 * 图片数据持久化到 data/order-images/<orderId>.json，重启不丢。
 */
const ORDER_IMAGES_DIR = path.join(__dirname, '..', 'data', 'order-images');

/** 获取对外可访问的根地址：优先公网隧道，其次固定回调域名，最后回退 localhost */
function getPublicBase(): string {
  const tunnel = getTunnelInfo();
  if (tunnel?.url) return tunnel.url.replace(/\/$/, '');
  const eff = getEffectiveRedirectUri();
  const root = (eff || '').replace(/\/api\/ml\/oauth\/store-callback\/?$/, '').replace(/\/api\/.*$/, '');
  if (root && /^https?:\/\//.test(root)) return root.replace(/\/$/, '');
  return 'http://localhost:3000';
}

/** 记录订单全部商品图片到文件缓存（供网页展示） */
export function recordOrderImages(orderId: string, storeName: string, order: any): void {
  try {
    if (!fs.existsSync(ORDER_IMAGES_DIR)) fs.mkdirSync(ORDER_IMAGES_DIR, { recursive: true });
    const items = (order.order_items || order.items || []).map((it: any) => {
      const item = it.item || it;
      return { title: item?.title || item?.name || '未知商品', images: extractItemImages(it, 30) };
    }).filter((i: any) => i.images.length > 0);
    const payload = { orderId: String(orderId), storeName, created: order.date_created || '', items };
    fs.writeFileSync(path.join(ORDER_IMAGES_DIR, `${String(orderId)}.json`), JSON.stringify(payload));
  } catch (e) {
    console.error('[Notify] 记录订单图片失败:', (e as any)?.message || e);
  }
}

/** 读取订单图片缓存，生成包含所有商品全部图片的 HTML 页面；无数据返回 null */
export function getOrderImagesHtml(orderId: string): string | null {
  try {
    const fp = path.join(ORDER_IMAGES_DIR, `${String(orderId)}.json`);
    if (!fs.existsSync(fp)) return null;
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const total = (data.items || []).reduce((s: number, i: any) => s + (i.images?.length || 0), 0);
    const blocks = (data.items || []).map((it: any, idx: number) => `
      <div class="item">
        <h3>${idx + 1}. ${escapeHtml(it.title)} <span class="cnt">(${(it.images || []).length} 张)</span></h3>
        <div class="imgs">${(it.images || []).map((u: string) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener"><img src="${escapeHtml(u)}" loading="lazy" alt="商品图"/></a>`).join('')}</div>
      </div>`).join('');
    return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>订单商品图 - ${escapeHtml(String(orderId))}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;background:#f5f5f5;color:#222;}
  h2{margin:0 0 4px;font-size:18px;} .meta{color:#888;font-size:13px;margin-bottom:16px;}
  .item{background:#fff;border-radius:8px;padding:12px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
  .item h3{margin:0 0 8px;font-size:15px;} .cnt{color:#999;font-weight:normal;font-size:13px;}
  .imgs{display:flex;flex-wrap:wrap;gap:8px;}
  .imgs img{width:120px;height:120px;object-fit:cover;border-radius:6px;border:1px solid #eee;cursor:pointer;}
</style></head>
<body>
  <h2>订单 ${escapeHtml(String(orderId))} 商品图</h2>
  <div class="meta">店铺：${escapeHtml(data.storeName || '')} ｜ 共 ${total} 张 ｜ 下单时间：${escapeHtml(data.created || '')}</div>
  ${blocks || '<p>无图片</p>'}
</body></html>`;
  } catch (e) {
    console.error('[Notify] 生成订单图片页失败:', (e as any)?.message || e);
    return null;
  }
}
