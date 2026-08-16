# 手机 APP 新订单推送接口文档

> 适用版本：ml-product-finder 后端（Express + TypeScript）
> 改动提交：`feat: 手机 APP 新订单实时推送接口` 之后
> 目标：服务器检测到美客多新订单后，立即把消息推到手机 APP；APP 打开消息即可看到「电脑端订单详情 + 短信内容」合并的完整详情。

---

## 1. 整体流程

```
美客多产生新订单
      │
      ▼
后端 pollAllStores 轮询检测到新订单
      │  broadcastNewOrder(store, order)
      ├──────────────┬─────────────────────────┐
      ▼              ▼                          ▼
邮件/短信通知     SSE 实时推送            设备推送（后台/被杀唤醒）
（既有）         /api/mobile/stream      经 MOBILE_PUSH_WEBHOOK 网关
                → new_order 事件         → 你的 FCM/APNs 中转服务
      │                                       │
      ▼                                       ▼
   手机 APP（前台常连）                  手机 APP（后台/被杀）
      │                                       │
      └────────── 用户点开通知 ───────────────┘
                      │
                      ▼
        GET /api/mobile/orders/:storeId/:orderId
                      │
                      ▼
        返回 desktopDetail(电脑端详情) + smsContent(短信内容) + summary
```

**两条送达路径（互补）：**
1. **SSE 实时流**（前台）：APP 在前台/刚回到前台时，长连接立即收到 `new_order` 事件，零延迟。
2. **设备推送**（后台/被杀）：APP 上报过推送令牌后，后端经 `MOBILE_PUSH_WEBHOOK` 网关把事件转给你的 FCM/APNs 中转服务，从而唤醒 APP 并弹系统通知。

> 若未配置 `MOBILE_PUSH_WEBHOOK`，则只有 SSE（前台）生效。APP 每次回到前台时通过「离线补推」接口补齐漏收的消息，保证不丢单。

---

## 2. 接口清单

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/mobile/stream` | SSE 实时流，新订单立即推送 |
| POST | `/api/mobile/devices` | 注册/更新设备推送令牌 |
| GET | `/api/mobile/devices` | 调试：查看已注册设备与 SSE 连接数 |
| GET | `/api/mobile/orders/recent?since=<ISO>` | 离线/后台补推，返回 since 之后的新增订单列表 |
| GET | `/api/mobile/orders/:storeId/:orderId` | 移动端订单详情（电脑端详情 + 短信内容） |

> 安全提示：当前这些接口与项目其余接口一样**未做鉴权**（面向本机/内网自托管）。若服务器暴露在公网，请务必在反向代理（nginx/Caddy）上加一层 API Key / Token 校验，或用 VPN/隧道访问。

---

## 3. 接口详解

### 3.1 SSE 实时流 `GET /api/mobile/stream`

手机 APP 在前台时建立一条长连接（EventSource / OkHttp SSE / URLSession）。服务器会：

- 连接建立后先发一条 `connected` 事件（携带 `serverTime`）。
- 每 25 秒发一条 `ping` 心跳（保持连接、防止代理断开）。
- 一旦检测到新订单，立刻发一条 `new_order` 事件。

**事件 payload（`new_order`）：**
```json
{
  "type": "new_order",
  "storeId": "store_abc",
  "storeName": "墨西哥店A",
  "site": "MLM",
  "orderId": "1234567890",
  "dateCreated": "2026-08-16T10:00:00.000Z",
  "status": "paid",
  "total": "MXN 1234.5",
  "buyer": "comprador_xxx",
  "itemCount": 2,
  "itemTitles": ["商品标题1", "商品标题2"],
  "serverTime": "2026-08-16T10:00:01.000Z"
}
```

**断线重连：** APP 应实现 EventSource 自动重连；重连成功后调用 3.4 的 `recent` 接口用上次收到的最新时间补齐。

---

### 3.2 设备注册 `POST /api/mobile/devices`

APP 在拿到 FCM/APNs token 后上报（每次启动或 token 刷新时调用）。

**请求体：**
```json
{
  "deviceId": "设备的唯一标识(建议用 IDFV/Android ID/UUID 持久化)",
  "platform": "ios | android | other",
  "token": "FCM 或 APNs 的推送 token",
  "appVersion": "1.0.0（可选）"
}
```

**响应：**
```json
{ "success": true, "device": { "deviceId": "...", "platform": "ios", "token": "...", "updatedAt": "..." }, "sseActive": 0 }
```

> 后端把设备令牌持久化到 `data/mobile-devices.json`，重启不丢失。

---

### 3.3 调试 `GET /api/mobile/devices`

返回当前 SSE 连接数与已注册设备列表，便于排查。

---

### 3.4 离线补推 `GET /api/mobile/orders/recent?since=<ISO>`

APP 回到前台 / SSE 断线重连后调用，传入「上次收到新订单的最新时间」（`since`），返回该时间之后的所有新增订单（不会重复返回更早的）。

- `since` 省略：返回全部「后台同步新增」订单（首次同步历史用，谨慎使用）。
- 返回 `orders` 数组，字段同 3.1 的 `new_order` 事件（多了 `syncSaved: true`）。

**响应：**
```json
{
  "success": true,
  "since": "2026-08-16T09:00:00.000Z",
  "count": 3,
  "orders": [
    { "storeId": "store_abc", "storeName": "墨西哥店A", "orderId": "111", "total": "MXN 99", "itemTitles": ["..."], "syncSaved": true, ... },
    ...
  ]
}
```

---

### 3.5 订单详情（核心）`GET /api/mobile/orders/:storeId/:orderId`

APP 点开通知/消息时调用，**合并返回两类内容**：

1. **`desktopDetail`** —— 与电脑端订单弹窗完全一致的详情：完整 `order` 对象、物流 `shipments`、带图的商品 `itemsDetail`、分类 `category`、收货地址 `shippingAddress`、物流方式 `shippingMethod`、买家税务证件 `buyerBilling`、费用汇总 `financialSummary`。
2. **`smsContent`** —— 短信/Webhook 渠道实际展示的内容：`text`（纯文本）、`smsText`（markdown 图文）、`html`（邮件 HTML）。
3. **`summary`** —— 专为手机端准备的扁平结构，无需解析嵌套即可直接展示。

**响应（节选）：**
```json
{
  "success": true,
  "storeId": "store_abc",
  "storeName": "墨西哥店A",
  "site": "MLM",
  "desktopDetail": {
    "order": { "id": "1234567890", "status": "paid", "date_created": "...", "buyer": {...}, "order_items": [...] },
    "shipments": [...],
    "itemsDetail": [ { "item": {...}, "itemImages": ["https://..."], "quantity": 1, "unit_price": {...} } ],
    "category": "unshipped",
    "shippingAddress": { "receiver_name": "...", "address_line": "...", "city": {...}, "state": {...}, "country": {...}, "zip_code": "...", "receiver_phone": "..." },
    "shippingMethod": "Standard",
    "buyerBilling": { "docType": "RFC", "docNumber": "...", "name": "..." },
    "financialSummary": { "productTotal": 100, "marketplaceFee": 15, "shippingCost": 5, "netTotal": 90, "currency": "MXN" }
  },
  "smsContent": {
    "text": "【美客多新订单】\n国家：墨西哥\n店铺：墨西哥店A\n订单号：1234567890\n...",
    "smsText": "新订单 1234567890 | 国家:墨西哥 | 店铺:墨西哥店A | 状态:已付款 | 金额:MXN 1234.5 | 买家:...\n![商品图](https://...)",
    "html": "<div>...</div>"
  },
  "summary": {
    "orderId": "1234567890",
    "site": "MLM",
    "storeName": "墨西哥店A",
    "dateCreated": "...",
    "status": "paid",
    "category": "unshipped",
    "total": { "amount": 1234.5, "currency": "MXN" },
    "buyer": { "nickname": "...", "id": "...", "email": "" },
    "shippingAddress": {...},
    "shippingMethod": "Standard",
    "buyerBilling": {...},
    "financialSummary": {...},
    "items": [ { "title": "...", "quantity": 1, "unitPrice": {...}, "sku": "...", "itemId": "...", "images": ["https://..."] } ]
  }
}
```

---

## 4. 手机端实现指南

### 4.0 通用约定
- 所有时间戳用 ISO 8601（UTC）。
- APP 本地持久化：`deviceId`（设备唯一ID）、`lastOrderTime`（最近一次收到新订单的时间，用于 `recent` 补推）。
- 推荐在 APP 内用「消息中心」列表展示收到的订单，点击任一条 → 调 3.5 拉详情 → 展示。

### 4.1 接收消息：两条路径都要接

**(A) 前台实时（SSE）**
```
建立连接：GET <BASE>/api/mobile/stream  (text/event-stream)
监听事件：
  - event=connected  → 记录 serverTime，可清「连接中」态
  - event=ping       → 忽略（保活）
  - event=new_order  → 解析 data 为 NewOrder 对象，写入消息中心，并更新 lastOrderTime
断线自动重连 → 重连后调用 /recent?since=lastOrderTime 补齐
```

**(B) 后台/被杀（系统推送）**
- iOS：注册 APNs token；Android：注册 FCM token。
- 把 token 上报到 `POST /api/mobile/devices`。
- 配置后端环境变量 `MOBILE_PUSH_WEBHOOK` 指向**你自己的推送中转服务**（该服务收到 `{device, event}` 后调用 FCM/APNs 发送系统通知，通知 payload 里带上 `storeId` + `orderId`）。
- 中转服务示例（Node）：
  ```js
  // 收到后端 POST { device, event }
  // device = { platform, token }，event = new_order 事件
  if (device.platform === 'android') {
    // 调用 FCM HTTP v1 发送 data:{ storeId, orderId, title, body }
  } else {
    // 调用 APNs 发送 aps.alert + storeId/orderId 自定义字段
  }
  ```
- APP 收到系统通知，用户点击 → 取出 `storeId`/`orderId` → 跳到订单详情页 → 调 3.5。

> 不接中转服务也能用：靠 SSE（前台实时）+ `recent` 补推（回到前台补齐），覆盖绝大多数使用场景；系统推送仅用于「被杀也能弹通知」的增强体验。

### 4.2 处理消息 & 打开看详情

以 **React Native / Expo** 为例（伪代码，iOS/Android/Flutter 思路相同）：

```tsx
// 1) 启动 SSE（前台）
useEffect(() => {
  const es = new EventSource(`${BASE}/api/mobile/stream`);
  es.addEventListener('new_order', (e) => {
    const order = JSON.parse(e.data);
    saveToInbox(order);                 // 写入本地消息中心
    setLastOrderTime(order.serverTime); // 更新补推游标
    showLocalBadge();                   // 角标 +1
  });
  es.onerror = () => { /* EventSource 会自动重连 */ };
  return () => es.close();
}, []);

// 2) 回到前台补齐漏收
const onForeground = async () => {
  const since = await getLastOrderTime();
  const r = await fetch(`${BASE}/api/mobile/orders/recent?since=${since}`);
  const { orders } = await r.json();
  orders.forEach(saveToInbox);
  if (orders[0]) setLastOrderTime(orders[0].serverTime || orders[0].dateCreated);
};

// 3) 点击消息 → 拉详情 → 展示
const openOrder = async (storeId, orderId) => {
  const r = await fetch(`${BASE}/api/mobile/orders/${storeId}/${orderId}`);
  const { desktopDetail, smsContent, summary } = (await r.json()).data ?? await r.json();
  // 展示 summary（扁平，直接渲染）
  // 详情页可切换 tab：① 图文详情(desktopDetail.itemsDetail + smsContent.html)
  //                     ② 短信原文(smsContent.text / smsText)
  //                     ③ 费用与买家证件(desktopDetail.financialSummary / buyerBilling)
};
```

**Android (Kotlin OkHttp SSE) 要点：**
```kotlin
val request = Request.Builder().url("$BASE/api/mobile/stream").build()
client.newEventSource(request, object : EventSourceListener() {
  override fun onEvent(ev: EventSource, id: String?, type: String?, data: String) {
    if (type == "new_order") { val order = Gson().fromJson(data, NewOrder::class.java); inbox.add(order) }
  }
})
```

**iOS (URLSession / NotificationCenter) 要点：** 用 `URLSession` 流式读取 `text/event-stream`，按 `\n\n` 切分事件；`new_order` 事件写入 Core Data / UserDefaults 消息中心。

### 4.3 详情页建议布局
- 顶部：店铺名 + 订单号 + 状态标签（用 `summary.category` 着色）。
- 金额/买家/收货地址/物流方式：用 `summary` 直接渲染。
- 商品列表：用 `summary.items`（含主图 `images[0]`、标题、数量、单价、SKU）。
- 「短信原文」折叠区：展示 `smsContent.text`（纯文本）或 `smsContent.smsText`（图文）。
- 「完整电脑端详情」：直接渲染 `desktopDetail.order` 原始 JSON 或按需展示 `shipments`/`buyerBilling`/`financialSummary`。

---

## 5. 后端部署注意
- 新接口已随 `server/index.ts` 提供，无需额外构建。
- 若要用系统推送（后台唤醒），设置环境变量：
  ```
  MOBILE_PUSH_WEBHOOK=https://你的推送中转服务/forward
  ```
- SSE 需要反向代理**关闭缓冲**：nginx 加 `proxy_set_header X-Accel-Buffering no;`（代码已对响应头设置该字段，配合代理即可）。
- 重启/部署后，轮询（`startOrderPolling`，默认每 30 分钟）检测到新订单即会触发推送。
