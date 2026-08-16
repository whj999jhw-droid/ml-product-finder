# MOBILE_PUSH_WEBHOOK 配置保姆级教程（小白版）

> 适用：ml-product-finder 后端「手机 APP 新订单推送」的**后台/被杀唤醒**能力。
> 配套文档：`docs/mobile-order-api.md`（接口与手机端实现）
> 前置提交：`feat: 手机 APP 新订单实时推送接口`（commit 8993b07）

---

## 0. 先搞清楚：这个东西是干嘛的？

你的后端在检测到美客多新订单时，会把消息发给手机 APP。发消息有**两条路**：

| 路径 | 什么时候用 | 需不需要配置 |
|------|-----------|-------------|
| **SSE 实时流** `/api/mobile/stream` | APP 在前台 / 刚回到前台 | ❌ 不用配，开箱即用 |
| **设备推送**（后台/被杀也能弹通知） | APP 在后台、被划掉、手机关屏 | ✅ 需要配 `MOBILE_PUSH_WEBHOOK` |

**只有**你想让「APP 被杀掉以后，来新订单还能弹系统通知」时，才需要本教程。
如果你只在前台用（打开 APP 就能实时收到），**可以完全跳过本教程**，SSE 已经够了。

为什么需要中间这个 `MOBILE_PUSH_WEBHOOK`？因为：
- 苹果(APNs)、谷歌(FCM) 的推送服务，**不能直接从你的后端服务器调用**，必须用一个「拿着推送密钥的中转服务器」去发。
- 所以：你的后端 →（POST 一个 JSON 到）→ **你自己的中转服务(webhook)** →（调用 FCM/APNs）→ 手机收到系统通知。

`MOBILE_PUSH_WEBHOOK` 就是「你自己的中转服务」的网址。

---

## 1. 整体链路图

```
美客多新订单
   │  broadcastNewOrder()
   ▼
你的后端 (ml-product-finder)
   │  POST { device:{platform,token}, event:{...new_order...} }
   ▼
MOBILE_PUSH_WEBHOOK 指向的「中转服务」   ← 你按本教程搭的（一台小服务器/云函数）
   │  根据 platform 调对应推送
   ├─ android → Firebase Cloud Messaging (FCM)
   └─ ios     → Apple Push Notification service (APNs)
   ▼
手机收到系统通知 → 用户点击 → APP 取出 storeId/orderId → 调详情接口看订单
```

---

## 2. 第一步：拿到推送凭证（以 Android + FCM 为例，最简单免费）

> iOS 用户请看第 6 节，思路一样，只是凭证换成 APNs 证书。

### 2.1 创建 Firebase 项目
1. 打开 https://console.firebase.google.com/ ，用谷歌账号登录。
2. 点「添加项目」→ 取个名字（比如 `ml-order-push`）→ 一路下一步创建。
3. 进入项目后，点左侧「**Build → Cloud Messaging**」。
4. 如果你的项目还没关联 Android 应用：点「**注册应用**」，填你的 APP 的**包名**（例如 `com.yourcompany.mlapp`），下载 `google-services.json`（备用，APP 端用）。
5. 点右上角 **⚙ 项目设置 → 服务账号**，找到「**生成新的私钥**」按钮，点它 → 下载一个 `service-account.json` 文件。
   - ⚠️ 这个文件**等同于你的推送密码**，别发到网上、别提交进代码仓库。

### 2.2 记下来你需要的 3 个东西
- `service-account.json` 里的 `project_id`（你的 Firebase 项目 ID）
- `service-account.json` 整个文件（中转服务要用）
- 你的 APP 的「包名」（Android 应用 ID）

---

## 3. 第二步：搭一个超简单的中转服务（webhook）

这个中转服务就是一个很小的 Node.js 程序，它：
- 监听一个网址（比如 `https://你的域名/push`）
- 收到后端发来的 `{ device, event }` 后，调用 FCM 给对应手机发通知。

### 3.1 新建一个文件夹，写下面两个文件

**`package.json`**
```json
{
  "name": "ml-push-gateway",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "express": "^4.19.0",
    "firebase-admin": "^12.0.0"
  }
}
```

**`server.js`**
```js
import express from 'express';
import admin from 'firebase-admin';

// 1) 用第 2.1 步下载的 service-account.json 初始化（放同目录）
admin.initializeApp({
  credential: admin.credential.cert('./service-account.json'),
});

const app = express();
app.use(express.json());

// 2) 中转接口：后端会 POST 到这里
app.post('/push', async (req, res) => {
  try {
    const { device, event } = req.body;
    if (!device || !event) return res.status(400).json({ ok: false, msg: '缺少 device/event' });

    // 3) 构造通知内容（event 是后端发来的 new_order 事件，字段见接口文档）
    const title = `🔔 新订单 ${event.orderId}`;
    const body = `${event.storeName} | ${event.total || ''} | 买家:${event.buyer || ''}`;

    const message = {
      token: device.token,                 // APP 上报的 FCM token
      notification: { title, body },
      data: {                              // 点开通知后要跳转用的参数
        storeId: event.storeId || '',
        orderId: event.orderId || '',
        type: 'new_order',
      },
      android: { priority: 'high' },       // 高优先级，后台也能及时收到
    };

    const r = await admin.messaging().send(message);
    console.log('FCM 发送成功:', r);
    res.json({ ok: true, messageId: r });
  } catch (e) {
    console.error('FCM 发送失败:', e.message);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`推送中转服务已启动: http://localhost:${PORT}/push`));
```

### 3.2 安装并跑起来
```bash
npm install
node server.js
```
看到 `推送中转服务已启动` 就成功了。这就是你的 `MOBILE_PUSH_WEBHOOK` 背后的服务。

> 生产环境：把这个小服务部署到任意一台能联网的服务器 / 云函数 / 容器，并配一个**公网 HTTPS 域名**（FCM 要求 https）。本地 `localhost` 只能自己测试用。

---

## 4. 第三步：把 webhook 网址告诉后端（配置环境变量）

`MOBILE_PUSH_WEBHOOK` 就是上面中转服务的 `/push` 完整网址。

### 4.1 本地测试
启动后端前，先设置环境变量：
```bash
# Windows (PowerShell)
$env:MOBILE_PUSH_WEBHOOK="http://localhost:4000/push"
npx tsx server/index.ts

# macOS / Linux
export MOBILE_PUSH_WEBHOOK="http://localhost:4000/push"
npx tsx server/index.ts
```

### 4.2 部署到服务器（三种常见方式）

**方式 A：直接 `node` 启动（简单）**
```bash
# 在服务器上，写入环境变量再启动
export MOBILE_PUSH_WEBHOOK="https://你的域名/push"
npx tsx server/index.ts
# 或用 pm2 守护：pm2 start "npx tsx server/index.ts" --name ml-server
```

**方式 B：systemd 服务文件**（Linux 服务器推荐）
在 `/etc/systemd/system/ml-server.service` 里加一行 `Environment=`：
```ini
[Service]
Environment=MOBILE_PUSH_WEBHOOK=https://你的域名/push
Environment=PORT=3000
ExecStart=/usr/bin/npx tsx /opt/ml-product-finder/server/index.ts
...
```
然后 `systemctl daemon-reload && systemctl restart ml-server`。

**方式 C：Docker**
在 `Dockerfile` 或 `docker run` 里加：
```bash
docker run -e MOBILE_PUSH_WEBHOOK=https://你的域名/push -e PORT=3000 -p 3000:3000 your-image
```

> 💡 改完环境变量后，**必须重启后端**才会生效。

---

## 5. 第四步：手机 APP 要做什么（和后端配合）

1. **拿 token**：APP 启动后向 FCM/APNs 申请推送 token。
2. **上报 token**：调后端 `POST /api/mobile/devices`，body：
   ```json
   { "deviceId": "设备唯一ID", "platform": "android", "token": "FCM返回的token" }
   ```
3. **收通知**：系统通知到达时，取出 `data.storeId` + `data.orderId`。
4. **点开看详情**：调 `GET /api/mobile/orders/{storeId}/{orderId}` 拉完整详情展示。
   （详细代码见 `docs/mobile-order-api.md` 第 4 节）

> 后端已经把设备 token 存到 `data/mobile-devices.json`，重启不丢。你也可以在后端 `GET /api/mobile/devices` 看到已注册的设备列表，用来排错。

---

## 6. iOS（APNs）怎么做？

思路和 Android 一样，只是中转服务里把「调 FCM」换成「调 APNs」：

1. 在 [Apple Developer](https://developer.apple.com/) 创建 **APNs 鉴权密钥 (.p8)** 或推送证书。
2. 中转服务用 `apn` 这个 npm 包发送：
   ```js
   import { APN } from 'apn';
   const provider = new APN.Provider({ token: { key: './AuthKey.p8', keyId: 'ABC123', teamId: 'TEAMID' } });
   await provider.send(new APN.Notification({ alert: { title, body }, payload: { storeId, orderId } }), device.token);
   ```
3. 其余步骤（webhook 网址、环境变量、APP 上报 token）完全一样，`platform` 填 `ios` 即可。

> 想省事：iOS 也可以直接用 **FCM**（Firebase 同样支持 iOS），这样就和 Android 用同一套中转代码，不用单独接 APNs。

---

## 7. 自检清单（配完以后怎么确认成功了）

- [ ] 中转服务能独立启动，访问 `https://你的域名/push` 返回 405（POST 才对，说明服务在）。
- [ ] 后端启动时**无需**特意打印 webhook，但调用 `POST /api/mobile/devices` 后，用 `GET /api/mobile/devices` 能看到设备。
- [ ] 手动用 curl 模拟后端推一次，看中转服务日志是否「FCM 发送成功」：
  ```bash
  curl -X POST https://你的域名/push -H "Content-Type: application/json" -d '{
    "device": {"platform":"android","token":"你的真实FCMtoken"},
    "event": {"type":"new_order","storeId":"s1","storeName":"测试店","orderId":"TEST1","total":"MXN 99","buyer":"x"}
  }'
  ```
  如果手机**立刻弹出系统通知**，说明链路通了 ✅
- [ ] 真实来新订单时：后端日志会出现 `[Orders] 轮询完成` / 新订单相关，中转服务日志出现「FCM 发送成功」，手机弹通知。

---

## 8. 常见问题

**Q：不配 MOBILE_PUSH_WEBHOOK 会怎样？**
A：完全不影响。只是 APP 在后台/被杀时收不到系统通知；只要 APP 在前台或刚回到前台，SSE 实时流 + `recent` 补推照样能收到新订单，不丢单。

**Q：SSE 和 webhook 会重复推送吗？**
A：可能。SSE 在前台推一次，webhook 在后台也推一次。手机端用 `orderId` 去重（消息中心按 orderId 做 key）即可，文档里已建议这么做。

**Q：中转服务必须自己写吗？有没有现成的？**
A：如果你的 APP 已经接入了 OneSignal / 极光 / 个推 等第三方推送平台，可以把中转服务换成「调用那家的 REST API」，逻辑一样：收到 `{device,event}` → 调第三方发推送。本教程用 FCM 是因为它免费、标准、不用注册额外平台。

**Q：环境变量改了没生效？**
A：确认重启了后端进程；确认变量名拼写是 `MOBILE_PUSH_WEBHOOK`（全大写，下划线）；本地测试确认是在**启动后端那个终端**里 export 的。

**Q：FCM 要求 https，我没有域名怎么办？**
A：本地测试用 `http://localhost:4000/push` 即可；正式环境随便弄个免费证书（Let's Encrypt / Cloudflare）或放到支持 https 的云函数（Vercel / 腾讯云函数 / Railway）上。
