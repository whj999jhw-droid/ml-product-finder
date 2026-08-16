# 手机 APP 新订单推送 · 完整对接文档

> 适用：ml-product-finder 后端（Express + TypeScript）
> 对象：**手机 APP 开发者**（iOS / Android / React Native / Flutter 均可按本文实现）
> 功能：服务器检测到美客多新订单后，**立即**把消息推到手机 APP；APP 点开消息即可看到
> 「电脑端订单详情 + 短信内容」合并的完整详情。
> 对应后端提交：`feat: 手机 APP 新订单实时推送接口`（commit 8993b07）及后续文档。

---

## 0. 先看这一句（给后端同事）

后端已经把全部接口实现好了，APP 侧**只要按本文对接即可**。所有接口默认可用，无需 APP 开发者做任何服务端改动。
唯一需要后端/运维配合的是「APP 被杀也能弹系统通知」那一项（配置 `MOBILE_PUSH_WEBHOOK`，见第 6 节），不配也能用。

---

## 1. 整体流程

```
美客多产生新订单
      │
      ▼
后端 pollAllStores 轮询检测到新订单
      │  broadcastNewOrder(store, order)
      ├──────────────┬──────────────────────────┐
      ▼              ▼                           ▼
邮件/短信通知      SSE 实时推送               设备推送（后台/被杀唤醒）
（既有）          /api/mobile/stream         经 MOBILE_PUSH_WEBHOOK 网关
                  → new_order 事件           → push-gateway 中转服务
      │                                          │   → FCM(安卓)/APNs(苹果)
      ▼                                          ▼
   手机 APP（前台常连）                     手机 APP（后台/被杀）
      │                                          │
      └──────────── 用户点开通知/消息 ───────────┘
                        │
                        ▼
          GET /api/mobile/orders/:storeId/:orderId
                        │
                        ▼
          返回 desktopDetail(电脑端详情) + smsContent(短信内容) + summary
```

**两条送达路径（互补，建议都接）：**
1. **SSE 实时流**（前台）：APP 在前台/刚回到前台时，长连接立即收到 `new_order` 事件，零延迟。开箱即用，无需任何配置。
2. **设备推送**（后台/被杀）：APP 上报过推送令牌后，后端经 `MOBILE_PUSH_WEBHOOK` 网关把事件转给 FCM/APNs，从而唤醒 APP 并弹系统通知。

> 只接 SSE 也完全能收新订单（前台实时 + 回前台补推），不丢单。设备推送只是「被杀也能弹通知」的增强。

---

## 2. 接口地址清单（★ 直接发给 APP 开发者）

> 把下面每一行的 `BASE` 替换成你们实际部署后端的地址，例如：
> `BASE = https://order.example.com`（生产，走 443）或 `http://192.168.1.10:3000`（内网测试）。
> 后端默认端口是 `3000`，若前面挂了 nginx/域名，按实际域名填即可。

| 方法 | 完整地址 | 说明 | 是否需要鉴权 |
|------|----------|------|--------------|
| GET | `${BASE}/api/mobile/stream` | SSE 实时流，新订单立即推送 | 否（自托管） |
| POST | `${BASE}/api/mobile/devices` | 注册/更新设备推送令牌 | 否 |
| GET | `${BASE}/api/mobile/devices` | 调试：已注册设备 + SSE 连接数 | 否 |
| GET | `${BASE}/api/mobile/orders/recent?since=<ISO时间>` | 离线/后台补推，返回 since 之后的新增订单 | 否 |
| GET | `${BASE}/api/mobile/orders/:storeId/:orderId` | 移动端订单详情（核心） | 否 |

示例（内网测试）：
- `http://192.168.1.10:3000/api/mobile/stream`
- `http://192.168.1.10:3000/api/mobile/devices`
- `http://192.168.1.10:3000/api/mobile/orders/recent?since=2026-08-16T09:00:00.000Z`
- `http://192.168.1.10:3000/api/mobile/orders/store_abc/1234567890`

> ⚠️ **安全提示**：当前这些接口与项目其余接口一样**未做鉴权**，面向本机/内网自托管。
> 若服务器暴露在公网，请在反向代理（nginx/Caddy）上加一层 API Key / Token 校验，或用 VPN/隧道访问。
> 把接口地址交给 APP 开发者时，请一并告知接口是内网还是已加防护的公网地址。

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

**断线重连：** APP 应实现 EventSource 自动重连；重连成功后调用 3.4 的 `recent` 接口用上次最新时间补齐。

### 3.2 设备注册 `POST /api/mobile/devices`

APP 拿到 FCM/APNs token 后上报（每次启动或 token 刷新时调用）。

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

### 3.3 调试 `GET /api/mobile/devices`

返回当前 SSE 连接数与已注册设备列表，便于排查（返回示例：`{ sseActive: 1, devices: [...] }`）。

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
    { "storeId": "store_abc", "storeName": "墨西哥店A", "orderId": "111", "total": "MXN 99", "itemTitles": ["..."], "syncSaved": true, "serverTime": "..." },
    ...
  ]
}
```

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

> 没有该订单时返回 HTTP 404 + `{ success:false, message:"..." }`，APP 端按 404 处理即可。

---

## 4. 手机端实现指南

### 4.0 通用约定
- 所有时间戳用 ISO 8601（UTC）。
- APP 本地持久化：`deviceId`（设备唯一ID）、`lastOrderTime`（最近一次收到新订单的时间，用于 `recent` 补推）。
- 推荐在 APP 内用「消息中心」列表展示收到的订单，点击任一条 → 调 3.5 拉详情 → 展示。
- 用 `orderId` 做去重 key（SSE 与系统推送可能重复到达同一条）。

### 4.1 接收消息：两条路径都要接

**(A) 前台实时（SSE）**
```
建立连接：GET ${BASE}/api/mobile/stream  (text/event-stream)
监听事件：
  - event=connected  → 记录 serverTime，可清「连接中」态
  - event=ping       → 忽略（保活）
  - event=new_order  → 解析 data 为 NewOrder 对象，写入消息中心，并更新 lastOrderTime
断线自动重连 → 重连后调用 /recent?since=lastOrderTime 补齐
```

**(B) 后台/被杀（系统推送）**
- iOS：注册 APNs token；Android：注册 FCM token。
- 把 token 上报到 `POST ${BASE}/api/mobile/devices`。
- 后端环境变量 `MOBILE_PUSH_WEBHOOK` 指向**中转服务**（push-gateway，见第 5/6 节）。
- 中转服务收到 `{device, event}` 后调用 FCM/APNs 发送系统通知，通知 payload 带 `storeId` + `orderId`。
- APP 收到系统通知，用户点击 → 取出 `storeId`/`orderId` → 跳订单详情页 → 调 3.5。

### 4.2 处理消息 & 打开看详情（React Native / Expo 示例）

```tsx
// 1) 启动 SSE（前台）
useEffect(() => {
  const es = new EventSource(`${BASE}/api/mobile/stream`);
  es.addEventListener('new_order', (e) => {
    const order = JSON.parse(e.data);
    saveToInbox(order);                 // 写入本地消息中心（用 orderId 去重）
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
  if (!r.ok) { /* 404 等：提示订单不存在 */ return; }
  const { desktopDetail, smsContent, summary } = await r.json();
  // 展示 summary（扁平，直接渲染）
  // 详情页可切换 tab：① 图文详情(summary.items + smsContent.html)
  //                     ② 短信原文(smsContent.text / smsText)
  //                     ③ 费用与买家证件(desktopDetail.financialSummary / buyerBilling)
};
```

**Android（Kotlin，OkHttp SSE）要点：**
```kotlin
val request = Request.Builder().url("$BASE/api/mobile/stream").build()
client.newEventSource(request, object : EventSourceListener() {
  override fun onEvent(ev: EventSource, id: String?, type: String?, data: String) {
    if (type == "new_order") { val order = Gson().fromJson(data, NewOrder::class.java); inbox.add(order) }
  }
})
```

**iOS（Swift，URLSession 流式读取）要点：** 用 `URLSession` 读取 `text/event-stream`，按 `\n\n` 切分事件；`event: new_order` 时解析 data，写入本地消息中心（Core Data / UserDefaults）。

**Flutter 要点：** 用 `eventsource` 包订阅 SSE；系统推送用 `firebase_messaging`（安卓/ iOS 均可用 FCM，省去单独接 APNs）。

### 4.3 详情页建议布局
- 顶部：店铺名 + 订单号 + 状态标签（用 `summary.category` 着色）。
- 金额/买家/收货地址/物流方式：用 `summary` 直接渲染。
- 商品列表：用 `summary.items`（含主图 `images[0]`、标题、数量、单价、SKU）。
- 「短信原文」折叠区：展示 `smsContent.text`（纯文本）或 `smsContent.smsText`（图文）。
- 「完整电脑端详情」：按需展示 `desktopDetail.shipments` / `buyerBilling` / `financialSummary` 或原始 `order` JSON。

---

## 5. 推送中转服务示例（push-gateway，拿来即用）

项目里已附带一个**可直接运行**的中转服务：`push-gateway/` 目录。

后端在检测到新订单时，会向 `MOBILE_PUSH_WEBHOOK` 指向的地址 POST：
```json
{ "device": { "deviceId": "...", "platform": "android", "token": "FCM令牌" },
  "event":  { "type": "new_order", "storeId": "...", "storeName": "...", "orderId": "...", "total": "...", "buyer": "...", "itemTitles": [...], "serverTime": "..." } }
```

`push-gateway/server.js` 会按 `device.platform` 自动路由到 FCM（安卓）或 APNs（苹果），把系统通知发到手机，通知点击 payload 带 `storeId` + `orderId`。

**运行（详见 `push-gateway/README.md`）：**
```bash
cd push-gateway
npm install
# 放好 service-account.json（安卓）和/或 AuthKey.p8（苹果），设好环境变量
npm start
# 控制台显示：推送中转服务已启动： http://localhost:4000/push
```

然后把该地址（生产须为公网 HTTPS）配到后端的 `MOBILE_PUSH_WEBHOOK` 并**重启后端**。

> 凭证缺失时服务不会崩，只会在日志里提示对应平台「未启用」，另一平台照常工作。

---

## 6. MOBILE_PUSH_WEBHOOK 保姆级配置（小白版）

> 只有想让「APP 被杀掉以后，来新订单还能弹系统通知」时才需要本节约。只在前台用可跳过。

### 6.1 为什么需要它
苹果(APNs)、谷歌(FCM) 的推送服务**不能直接从后端调用**，必须用一个「拿着推送密钥的中转服务器」去发。
链路：`后端 → POST JSON → 你的中转服务(push-gateway) → 调 FCM/APNs → 手机`。
`MOBILE_PUSH_WEBHOOK` 就是「你的中转服务」的网址。

### 6.2 安卓（FCM）凭证
1. 打开 https://console.firebase.google.com/ → 建项目。
2. ⚙ 项目设置 → 服务账号 → **生成新的私钥** → 下载 `service-account.json`，放到 `push-gateway/` 目录。
   ⚠️ 此文件等同推送密码，别提交进仓库、别发公网。

### 6.3 苹果（APNs）凭证
1. [Apple Developer](https://developer.apple.com/) 创建 **APNs 鉴权密钥 (.p8)**，记下 `Key ID` 和 `Team ID`，把 `AuthKey_XXXX.p8` 放到 `push-gateway/` 目录。
2. 设环境变量：`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_TOPIC`(Bundle ID)、`APNS_PRODUCTION`(true=线上)。

### 6.4 把 webhook 网址告诉后端（配置环境变量）
`MOBILE_PUSH_WEBHOOK` = 中转服务的 `/push` 完整网址。

- **本地测试：**
  ```bash
  # Windows (PowerShell)
  $env:MOBILE_PUSH_WEBHOOK="http://localhost:4000/push"; npx tsx server/index.ts
  # macOS / Linux
  export MOBILE_PUSH_WEBHOOK="http://localhost:4000/push"; npx tsx server/index.ts
  ```
- **服务器（三种常见方式）：**
  - 直接启动：`export MOBILE_PUSH_WEBHOOK="https://你的域名/push"; npx tsx server/index.ts`（或用 `pm2 start "npx tsx server/index.ts" --name ml-server` 守护）
  - systemd：在 `/etc/systemd/system/ml-server.service` 的 `[Service]` 加 `Environment=MOBILE_PUSH_WEBHOOK=https://你的域名/push`，再 `systemctl daemon-reload && systemctl restart ml-server`。
  - Docker：`docker run -e MOBILE_PUSH_WEBHOOK=https://你的域名/push -e PORT=3000 -p 3000:3000 your-image`。

> 💡 改完环境变量后**必须重启后端**才生效。

### 6.5 手机 APP 配合
1. 拿 token（FCM/APNs）；2. 上报 `POST /api/mobile/devices`；3. 收系统通知，取出 `storeId`/`orderId`；4. 点开调 3.5 看详情。
后端已把设备 token 存到 `data/mobile-devices.json`，可在 `GET /api/mobile/devices` 排错。

### 6.6 自检清单
- [ ] 中转服务能启动，访问 `https://你的域名/push`（GET）返回 405，说明服务在。
- [ ] `POST /api/mobile/devices` 后，`GET /api/mobile/devices` 能看到设备。
- [ ] curl 模拟推一次，手机立刻弹通知：
  ```bash
  curl -X POST https://你的域名/push -H "Content-Type: application/json" -d '{
    "device": {"platform":"android","token":"你的真实FCMtoken"},
    "event": {"type":"new_order","storeId":"s1","storeName":"测试店","orderId":"TEST1","total":"MXN 99","buyer":"x"}
  }'
  ```
- [ ] 真实来新订单时：后端日志出现轮询/新订单相关，中转服务日志出现「FCM/APNs 发送成功」，手机弹通知。

### 6.7 常见问题
- **不配会怎样？** 完全不影响，只是后台/被杀收不到系统通知；前台 SSE + `recent` 补推照样收，不丢单。
- **SSE 和 webhook 会重复？** 可能。APP 端用 `orderId` 去重即可（4.0 已建议）。
- **必须有自己的中转服务吗？** 若已接 OneSignal/极光/个推，把 push-gateway 换成「调那家 REST API」即可，逻辑一样。
- **环境变量改了没生效？** 确认重启后端；变量名拼写为 `MOBILE_PUSH_WEBHOOK`（全大写）。
- **FCM 要 https 没域名？** 本地用 `http://localhost:4000/push` 即可；正式环境用免费证书或云函数（Vercel/腾讯云函数/Railway）。

---

## 7. 部署注意
- 新接口已随后端 `server/index.ts` 提供，无需额外构建。
- SSE 需反向代理**关闭缓冲**：nginx 加 `proxy_set_header X-Accel-Buffering no;`（代码已对响应头设置，配合代理即可）。
- 重启/部署后，订单轮询（默认每 30 分钟）检测到新订单即触发推送。
- 若启用系统推送，记得部署 `push-gateway` 并设置 `MOBILE_PUSH_WEBHOOK` 后重启后端。
