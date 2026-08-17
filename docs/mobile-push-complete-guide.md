# 手机 APP 新订单推送 · 部署 + 对接完整手册

> **项目域名（已固定）：`https://ml.w999w.dpdns.org`**
> **后端类型**：ml-product-finder（Express + TypeScript），已接 Cloudflare Tunnel 固定隧道（域名即上面那个）。
> **功能**：服务器检测到美客多新订单后，**立即**把消息推到手机 APP；APP 点开消息即可看到
> 「电脑端订单详情 + 短信内容」合并的完整详情。

---

## 0. 这份文档怎么用（两条阅读路线）

- **你是站长 / 部署者** → 只看 **【第一部分：你（部署侧）要做的】**，按顺序执行即可。
- **你是 APP 开发者** → 直接看 **【第二部分：APP 开发对接（保姆级）】**，照着做就能跑通，**不需要看第一部分**。
- 👉 你把 **第二部分整段** 发给 APP 开发者就行，他不需要懂服务器那套。

---

# 第一部分：你（部署侧）要做的 ★

> 目标：让服务器跑起来、把新订单推到手机。前面几步是「必做」，最后一步「放推送凭证」是「可选增强」。

## 步骤总览（TL;DR）

| 步骤 | 内容 | 必做/可选 |
|------|------|-----------|
| 1 | 把代码 `git push` 到服务器 | 必做 |
| 2 | 服务器跑部署脚本（一键起后端 + 推送中转） | 必做 |
| 3 | 验证两个服务都在线 | 必做 |
| 4 | （可选）放 FCM/APNs 凭证 → 让 APP 被杀也能弹通知 | 可选 |
| 5 | 把「第二部分 + 本域名」发给 APP 开发者 | 必做 |

---

## 步骤 1：把代码推到服务器

你本地的改动已经提交（移动端推送接口、push-gateway 示例、部署脚本集成）。把它们推到服务器：

```bash
# 在你本机（ml-product-finder 目录）
git push
```

然后在**服务器**上拉取最新代码：

```bash
cd /path/to/ml-product-finder      # 换成你服务器上项目实际目录
git pull
npm install                        # 拉到新依赖时执行（通常已装）
```

> ✅ 如果你本地和服务器是同一台机器，跳过 ssh，直接在该目录 `git pull` 即可。

---

## 步骤 2：在服务器跑部署脚本（一键启动）

部署脚本已经把「推送中转服务 push-gateway」接进去了，**跟着后端一起自动启动**，并且默认把
`MOBILE_PUSH_WEBHOOK` 指向**本机**（见步骤 4 说明，不需要公网）。

你当前用的是 Cloudflare Tunnel 固定隧道（域名 `ml.w999w.dpdns.org`），所以跑的是 **`setup-cloudflared.sh`**：

```bash
# 在服务器项目目录
./setup-cloudflared.sh
```

> 如果你是用 Oracle 直连 IP 部署（没走隧道），则跑：
> ```bash
> ./deploy-oracle.sh
> ```
> 两者选一个，取决于你之前怎么部署的。看不懂就问。

脚本会自动做这些（你不用手动做）：
1. 安装 push-gateway 的依赖；
2. 在 `.env` 写入 `MOBILE_PUSH_WEBHOOK=http://localhost:4100/push`；
3. 用 PM2 常驻启动 `ml-finder`（后端）和 `ml-push-gateway`（推送中转）。

> ⚠️ **注意**：脚本可重复运行。如果之前已经部署过，**先停掉旧进程再跑**，避免重复：
> ```bash
> pm2 delete ml-finder ml-push-gateway 2>/dev/null
> ./setup-cloudflared.sh
> ```

---

## 步骤 3：验证两个服务都在线

```bash
pm2 status
```

你应该看到两行 `online`：

```
┌─────┬──────────────────┬─────────┬──────┬─────────┐
│ id  │ name             │ status  │ ...  │          │
├─────┼──────────────────┼─────────┼──────┼─────────┤
│ 0   │ ml-finder        │ online  │ ...  │          │
│ 1   │ ml-push-gateway  │ online  │ ...  │          │
└─────┴──────────────────┴─────────┴──────┴─────────┘
```

再用 curl 探一下接口（在服务器本机）：

```bash
# 后端接口（应返回 200 JSON）
curl -s https://ml.w999w.dpdns.org/api/mobile/devices

# 推送中转服务（GET 应返回 405，说明服务在）
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4100/push
```

> ✅ 后端返回 JSON、中转返回 `405` = 两个都活着，部署成功。

---

## 步骤 4（可选）：让「APP 被杀也能弹系统通知」

> 不配这一步**完全能用**：APP 在前台时通过 SSE 实时收、回到前台用 `recent` 补推，**不会漏单**。
> 这一步只是让「APP 被划掉 / 在后台」时，手机仍弹系统通知（体验更好）。

### 4.1 原理（一句话）
苹果/谷歌的推送（APNs/FCM）不能直接调，必须有个「拿着推送密钥的中转服务」去发。
我们已经内置了 `push-gateway`（步骤 2 已启动），你现在只要把**凭证**放进去。

### 4.2 安卓（FCM）凭证
1. 打开 https://console.firebase.google.com/ → 新建/选你的项目。
2. 点 ⚙ **项目设置** → **服务账号** → **生成新的私钥** → 下载 `service-account.json`。
3. 把这个文件上传到服务器项目的 `push-gateway/` 目录（和 `server.js` 同级）。
4. 重启中转服务：
   ```bash
   pm2 restart ml-push-gateway
   ```

### 4.3 苹果（APNs）凭证
1. 在 [Apple Developer](https://developer.apple.com/) 创建 **APNs 鉴权密钥 (.p8)**，
   记下 `Key ID` 和 `Team ID`，把 `AuthKey_XXXX.p8` 放到服务器 `push-gateway/` 目录。
2. 在中转服务所在环境设置变量（加到 PM2 或 `.env`）：
   ```
   APNS_KEY_ID=你的KeyID      # 替换成 Apple 开发者后台拿到的真实 Key ID
   APNS_TEAM_ID=你的TeamID     # 替换成真实 Team ID
   APNS_TOPIC=你的App Bundle ID
   APNS_PRODUCTION=true          # 线上填 true，测试沙盒填 false
   ```
3. 重启：
   ```bash
   pm2 restart ml-push-gateway
   ```

> ⚠️ **安全**：`service-account.json`、`AuthKey_*.p8` 等同推送密码，绝不提交进 git、绝不发公网。
> 项目 `.gitignore` 已忽略它们，正常 `git add` 不会带上去。

> 💡 凭证缺失时中转服务**不会崩**，只在日志里提示某平台「未启用」，另一平台照常工作。

---

## 步骤 5：把对接文档发给 APP 开发者

把本文档 **【第二部分】** 整段（或把本文件直接发过去）发给 APP 开发者，并告诉他：

- 后端地址（BASE）就是：`https://ml.w999w.dpdns.org`
- 接口都列在第二部分第 1 节，照着接即可
- 不需要他做任何服务端改动

---

## ⚠️ 部署侧 · 重点注意事项

1. **`MOBILE_PUSH_WEBHOOK` 指向本机 `http://localhost:4100/push`，不要用域名、不用 https。**
   后端 → 中转是同机 localhost 调用（HTTP 即可）；中转 → FCM/APNs 由 SDK 内部走 Google/Apple 自己的 HTTPS，
   **不经过你的公网地址**。所以这一步**不需要公网证书**。
   **也不需要开防火墙**：push-gateway 进程只监听本机回环地址 `127.0.0.1:4100`，外网根本连不进来，
   防火墙规则对它无影响（也无需放行 4100 端口）。改这个变量后必须重跑部署脚本或重启后端才生效。

2. **改了 `.env` / 部署脚本，必须重启相关进程**（`pm2 restart ml-finder` 或重跑脚本），否则不生效。

3. **接口当前未鉴权**（与项目其余接口一致）。域名 `ml.w999w.dpdns.org` 经 Cloudflare Tunnel 暴露，
   任何人都能调 `/api/mobile/*`。若担心，在 Tunnel / nginx 层加 API Key 校验，或只对 APP 所需 4 个路径放行。
   这部分需要我加鉴权的话告诉我。

4. **SSE 实时性依赖隧道**。Cloudflare Tunnel 支持流式（SSE 一般能实时到达），但极端网络下可能延迟。
   **APP 端已实现「回前台 / 断线重连后用 `recent` 补推」兜底**，所以即使 SSE 偶尔延迟也**不会漏单**——
   这是设计上的双保险，不用你额外处理。

5. **定时轮询间隔**：后端默认每 30 分钟轮询一次美客多（检测新订单）。也就是说新订单**最多延迟约 30 分钟**
   才会被检测到并推送。这是既有机制，不是接口问题。想更频繁可调小轮询间隔（告诉我我来改）。

---

# 第二部分：APP 开发对接（保姆级，直接照做）★

> 读者：手机 APP 开发者（iOS / Android / React Native / Flutter 均可按本文实现）
> 后端地址已固定：**`https://ml.w999w.dpdns.org`**
> 你只需要调下面 4 个接口，不需要改任何服务端代码。

---

## 1. 接口地址清单（★ 直接照用）

| 方法 | 完整地址 | 说明 | 鉴权 |
|------|----------|------|------|
| GET | `https://ml.w999w.dpdns.org/api/mobile/stream` | SSE 实时流，新订单立即推送 | 无 |
| POST | `https://ml.w999w.dpdns.org/api/mobile/devices` | 上报/更新设备推送令牌 | 无 |
| GET | `https://ml.w999w.dpdns.org/api/mobile/orders/recent?since=<ISO时间>` | 离线/后台补推，返回 since 之后的新增 | 无 |
| GET | `https://ml.w999w.dpdns.org/api/mobile/orders/:storeId/:orderId` | 订单详情（核心，点开消息时调） | 无 |

> `:storeId`、`:orderId` 是路径参数，直接替换。例如：
> `https://ml.w999w.dpdns.org/api/mobile/orders/store_abc/1234567890`
> `storeId` 和 `orderId` 都在收到的新订单事件里（见第 3.1 节），直接用即可。

---

## 2. 整体流程

```
美客多产生新订单
      │
      ▼
后端轮询检测到新订单 → broadcastNewOrder
      ├──────────────┬──────────────────────────┐
      ▼              ▼                           ▼
  邮件/短信通知      SSE 实时推送               系统推送（后台/被杀唤醒）
  （既有）          /api/mobile/stream         经本机 push-gateway 中转
                  → new_order 事件           → FCM(安卓)/APNs(苹果)
      │                                          │
      ▼                                          ▼
   手机 APP（前台常连）                     手机 APP（后台/被杀，弹系统通知）
      └──────────── 用户点开通知/消息 ───────────┘
                        │
                        ▼
          GET /api/mobile/orders/:storeId/:orderId
                        │
                        ▼
          返回 desktopDetail(电脑端详情) + smsContent(短信内容) + summary(手机直接渲染)
```

**两条送达路径（互补，建议都接）：**
1. **SSE 实时流（前台）**：APP 在前台时长连接立即收到 `new_order` 事件，零延迟。开箱即用，无需任何配置。
2. **系统推送（后台/被杀）**：APP 上报过推送令牌后，服务器经中转服务把事件转给 FCM/APNs，唤醒 APP 并弹系统通知。

> 只接 SSE 也能完整收新订单（前台实时 + 回前台补推），不丢单。系统推送只是「被杀也能弹通知」的增强。

---

## 3. 接口详解

### 3.1 SSE 实时流 `GET /api/mobile/stream`

APP 在前台时建立一条长连接（EventSource / OkHttp SSE / URLSession）。服务器会：
- 连接建立后先发一条 `connected` 事件（携带 `serverTime`）；
- 每 25 秒发一条 `ping` 心跳（保持连接、防止代理断开）；
- 一旦检测到新订单，立刻发一条 `new_order` 事件。

**`new_order` 事件 payload：**
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

**断线重连：** 用 EventSource 自动重连；重连成功后调用 3.4 的 `recent` 接口用上次最新时间补齐漏收。

### 3.2 设备注册 `POST /api/mobile/devices`

APP 拿到 FCM/APNs token 后上报（每次启动或 token 刷新时调用一次）。

**请求体（JSON）：**
```json
{
  "deviceId": "设备唯一标识(用 IDFV / Android ID / UUID 持久化)",
  "platform": "ios",
  "token": "FCM 或 APNs 的推送 token",
  "appVersion": "1.0.0"
}
```

**响应：**
```json
{ "success": true, "device": { "deviceId": "...", "platform": "ios", "token": "...", "updatedAt": "..." }, "sseActive": 0 }
```

> 服务器把设备令牌持久化，重启不丢。

### 3.3 离线补推 `GET /api/mobile/orders/recent?since=<ISO>`

APP 回到前台 / SSE 断线重连后调用，传入「上次收到新订单的最新时间」（`since`，ISO 8601 UTC），
返回该时间之后的所有新增订单（不会重复返回更早的）。

- `since` 省略：返回全部「后台同步新增」订单（首次同步用，谨慎）。
- 返回 `orders` 数组，字段同 3.1 的 `new_order`（多个 `syncSaved: true`）。

**响应：**
```json
{
  "success": true,
  "since": "2026-08-16T09:00:00.000Z",
  "count": 3,
  "orders": [
    { "storeId": "store_abc", "storeName": "墨西哥店A", "orderId": "111", "total": "MXN 99", "itemTitles": ["..."], "syncSaved": true, "serverTime": "..." }
  ]
}
```

### 3.4 订单详情（核心）`GET /api/mobile/orders/:storeId/:orderId`

APP 点开通知/消息时调用，**合并返回两类内容**：

1. **`desktopDetail`** —— 与电脑端订单弹窗完全一致的详情：完整 `order` 对象、物流 `shipments`、带图商品 `itemsDetail`、分类 `category`、收货地址 `shippingAddress`、物流方式 `shippingMethod`、买家税务证件 `buyerBilling`、费用汇总 `financialSummary`。
2. **`smsContent`** —— 短信/Webhook 实际展示内容：`text`（纯文本）、`smsText`（markdown 图文）、`html`（邮件 HTML）。
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
    "shippingAddress": { "receiver_name": "...", "address_line": "...", "city": "...", "state": "...", "country": "...", "zip_code": "...", "receiver_phone": "..." },
    "shippingMethod": "Standard",
    "buyerBilling": { "docType": "RFC", "docNumber": "...", "name": "..." },
    "financialSummary": { "productTotal": 100, "marketplaceFee": 15, "shippingCost": 5, "netTotal": 90, "currency": "MXN" },
    "items": [ { "title": "...", "quantity": 1, "unitPrice": { "amount": 100, "currency": "MXN" }, "sku": "...", "itemId": "...", "images": ["https://..."] } ]
  }
}
```

> 没有该订单时返回 **HTTP 404** + `{ "success": false, "message": "..." }`，APP 端按 404 处理（提示订单不存在）。

---

## 4. 手机端实现指南

### 4.0 通用约定
- 所有时间戳用 **ISO 8601（UTC）**。
- APP 本地持久化：`deviceId`（设备唯一 ID）、`lastOrderTime`（最近一次收到新订单的时间，用于 `recent` 补推）。
- 推荐在 APP 内用「**消息中心**」列表展示收到的订单，点任一条 → 调 3.4 拉详情 → 展示。
- 用 `orderId` 做**去重 key**（SSE 与系统推送可能重复到达同一条，见注意事项 7.1）。

### 4.1 接收消息：两条路径都要接

**(A) 前台实时（SSE）**
```
建立连接：GET https://ml.w999w.dpdns.org/api/mobile/stream   (Content-Type: text/event-stream)
监听事件：
  - event=connected  → 记录 serverTime，清「连接中」态
  - event=ping       → 忽略（保活）
  - event=new_order  → 解析 data 为对象，写入消息中心，更新 lastOrderTime
断线自动重连 → 重连后调用 /recent?since=lastOrderTime 补齐
```

**(B) 后台/被杀（系统推送）**
- iOS：注册 APNs token；Android：注册 FCM token。
- 把 token 上报 `POST https://ml.w999w.dpdns.org/api/mobile/devices`。
- 服务端已配好中转服务（部署侧第 4 步），收到 `{device, event}` 后调用 FCM/APNs 发系统通知，
  **通知 payload 带 `storeId` + `orderId`**。
- APP 收到系统通知、用户点击 → 取出 `storeId`/`orderId` → 跳订单详情页 → 调 3.4。

### 4.2 React Native / Expo 示例

```tsx
const BASE = 'https://ml.w999w.dpdns.org';

// 1) 启动 SSE（前台）
useEffect(() => {
  const es = new EventSource(`${BASE}/api/mobile/stream`);
  es.addEventListener('new_order', (e) => {
    const order = JSON.parse((e as MessageEvent).data);
    saveToInbox(order);                  // 写入本地消息中心（用 orderId 去重）
    setLastOrderTime(order.serverTime);  // 更新补推游标
    showLocalBadge();                    // 角标 +1
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
  return () => es.close();
}, []);

// 2) 回到前台补齐漏收
const onForeground = async () => {
  const since = await getLastOrderTime();
  const r = await fetch(`${BASE}/api/mobile/orders/recent?since=${encodeURIComponent(since)}`);
  const { orders } = await r.json();
  orders.forEach(saveToInbox);
  if (orders[0]) setLastOrderTime(orders[0].serverTime || orders[0].dateCreated);
};

// 3) 点击消息 → 拉详情 → 展示
const openOrder = async (storeId: string, orderId: string) => {
  const r = await fetch(`${BASE}/api/mobile/orders/${storeId}/${orderId}`);
  if (!r.ok) { /* 404 等：提示订单不存在 */ return; }
  const { desktopDetail, smsContent, summary } = await r.json();
  // 展示 summary（扁平，直接渲染）
  // 详情页可切 tab：① 图文详情(summary.items + smsContent.html)
  //                   ② 短信原文(smsContent.text / smsContent.smsText)
  //                   ③ 费用与买家证件(desktopDetail.financialSummary / buyerBilling)
};

// 4) 上报推送 token（拿到 FCM/APNs token 后）
await fetch(`${BASE}/api/mobile/devices`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: myDeviceId, platform: 'android', token: fcmToken, appVersion: '1.0.0' }),
});
```

### 4.3 Android（Kotlin，OkHttp SSE）要点

```kotlin
val BASE = "https://ml.w999w.dpdns.org"
val client = OkHttpClient()
val request = Request.Builder().url("$BASE/api/mobile/stream").build()
client.newEventSource(request, object : EventSourceListener() {
  override fun onEvent(ev: EventSource, id: String?, type: String?, data: String) {
    when (type) {
      "new_order" -> { val order = Gson().fromJson(data, NewOrder::class.java); inbox.add(order) }
      "connected", "ping" -> { /* 忽略 */ }
    }
  }
  override fun onFailure(ev: EventSource, t: Throwable?, r: Response?) { /* 自动重连 */ }
})
```
> 依赖：`implementation("com.squareup.okhttp3:okhttp-sse:4.x")` 和 `okhttp:4.x`。

### 4.4 iOS（Swift，URLSession 流式读取）要点

iOS 原生 `URLSession` 不自带 SSE 重连，推荐用社区库 **[EventSource](https://github.com/inseven/event-source)](https://github.com/inseven/event-source)** 或 `URLSession` 手动按 `\n\n` 切分事件：

```swift
let url = URL(string: "https://ml.w999w.dpdns.org/api/mobile/stream")!
let task = URLSession.shared.dataTask(with: url) { data, resp, err in
  // 流式数据需自行按 "event: xxx\n\ndata: yyy\n\n" 解析（建议直接用 EventSource 库）
}
```
收到 `event: new_order` 时解析 data → 写入本地消息中心（Core Data / UserDefaults）。

> Flutter：用 `eventsource` 包订阅 SSE；系统推送用 `firebase_messaging`（安卓/iOS 均可走 FCM，省去单独接 APNs）。

### 4.5 详情页建议布局
- 顶部：店铺名 + 订单号 + 状态标签（用 `summary.category` 着色：unshipped=待发货 等）。
- 金额/买家/收货地址/物流方式：用 `summary` 直接渲染。
- 商品列表：用 `summary.items`（含主图 `images[0]`、标题、数量、单价、SKU）。
- 「短信原文」折叠区：展示 `smsContent.text`（纯文本）或 `smsContent.smsText`（图文）。
- 「完整电脑端详情」：按需展示 `desktopDetail.shipments` / `buyerBilling` / `financialSummary` 或原始 `order` JSON。

---

## 5. ⚠️ APP 开发侧 · 重点注意事项

1. **必须用 `orderId` 去重！** 同一条新订单可能同时通过 SSE 和系统推送到达（路径 A 和 B 都触发）。
   写入消息中心前用 `orderId` 判重，避免显示两条一样的。

2. **必须实现「回前台 / 断线后用 `recent` 补推」**。即便 SSE 实时到达，网络抖动断线期间可能漏单；
   回前台调 `GET /api/mobile/orders/recent?since=<上次最新时间>` 补齐，保证**不漏单**。这是兜底，务必做。

3. **`since` 要用你本地保存的「最近一次收到订单的 serverTime」**，不是当前时间。
   首次没有就省略 `since`（会返回历史同步订单，量大时慎用）。

4. **详情接口可能返回 404**。订单可能因同步延迟/已删除而不存在，点开时按 404 优雅提示，不要崩。

5. **`storeId` 从事件 payload 里取**，不要自己拼。点开详情时路径是
   `/api/mobile/orders/{storeId}/{orderId}`，两个值都来自 `new_order` 事件或 `recent` 返回的同一对象。

6. **接口无鉴权、走公网域名**。APP 直接 HTTPS 调用即可，不需要带 token。
   但也意味着任何人都能调——不要在 URL/body 里放任何敏感业务密钥。

7. **SSE 走 Cloudflare Tunnel（`ml.w999w.dpdns.org`）**。隧道支持流式，一般能实时；
   个别网络下首屏握手稍慢属正常。只要做了第 2 条的补推兜底，体验不受影响。

8. **推送令牌上报时机**：APP 启动时 + token 刷新回调里都调一次 `POST /api/mobile/devices`，
   保证服务端拿到最新 token（否则系统推送可能发不到）。

---

## 6. 联调自检清单

**部署侧（站长）先确认：**
- [ ] `pm2 status` 里 `ml-finder` 与 `ml-push-gateway` 都 `online`
- [ ] `curl https://ml.w999w.dpdns.org/api/mobile/devices` 返回 JSON
- [ ] `curl -o /dev/null -w "%{http_code}" http://localhost:4100/push` 返回 `405`
- [ ] （要系统推送）`push-gateway/` 放了 `service-account.json` 或 `AuthKey_*.p8` 且已 `pm2 restart ml-push-gateway`

**APP 侧（开发者）逐项验证：**
- [ ] 连上 `https://ml.w999w.dpdns.org/api/mobile/stream` 后收到 `event: connected`
- [ ] 调用 `POST /api/mobile/devices` 后，`GET /api/mobile/devices` 能看到本设备
- [ ] 模拟新订单（让后台产生/或部署侧用 curl 打中转服务一次），APP 消息中心出现一条
- [ ] 杀掉 APP 再产生新订单，手机弹系统通知；点通知跳到详情页正常显示
- [ ] 断网 1 分钟再恢复，回前台后 `recent` 补推把漏的单补回来（不重复、不漏）
- [ ] 点开详情，`summary` 渲染正常，`smsContent.text` 能看到短信原文

---

> 文档版本对应后端提交：`feat: 手机 APP 新订单实时推送接口`（8993b07）及后续文档/部署集成。
> 中转服务代码见项目 `push-gateway/` 目录；部署细节见 `DEPLOY-ORACLE.md` 末尾附录。
