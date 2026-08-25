# 推送中转服务（push-gateway）

ml-product-finder 后端检测到美客多新订单时，会把 `{ device, event }` POST 到
`MOBILE_PUSH_WEBHOOK` 指向的地址 —— 也就是本服务。本服务再调用 **极光 JPush（安卓）**
或 **APNs（苹果）** 或 **FCM（安卓备选）** 把系统通知发到手机，从而实现「APP 关了 / 被杀掉也能弹通知」。

> 不部署本服务也完全能用：APP 在前台时靠 `GET /api/mobile/stream`(SSE) 实时收，
> 回到前台时靠 `GET /api/mobile/orders/recent` 补齐。本服务只是「后台/被杀唤醒」的增强。

---

## ⚠️ 国内安卓手机的重要说明（务必先看）

安卓系统推送有两条路：

1. **FCM（谷歌推送）**：需要手机装了 Google 服务（GMS）。**国内绝大多数手机没有 GMS**，
   所以 FCM 在国内基本收不到。除非你确定自己的手机有谷歌服务，否则别指望 FCM。
2. **极光 JPush + 厂商通道（推荐）**：极光会自动走「华为/小米/OPPO/VIVO/魅族」等手机厂商的
   **系统级推送通道**，不需要谷歌服务，国内才稳，而且杀后台/重启后也能收到。

→ **国内用户请直接用 JPush（见第二节），FCM 当作备选即可。**
→ iOS 走 APNs（苹果服务器在国内能通），不受影响。

---

## 一、快速开始

```bash
cd push-gateway
npm install
# 配置凭证（见下方二、三、四节），至少配一项
cp .env.example .env   # 然后填好里面的密钥
npm start
```

启动后控制台显示 `推送中转服务已启动： http://127.0.0.1:4100/push`，
并打印已启用的通道。把这个地址（**生产环境必须是公网 HTTPS**）填到后端的：

```
MOBILE_PUSH_WEBHOOK=https://你的域名/push
```

然后**重启后端**（pm2 restart ml-finder）。

---

## 二、安卓（极光 JPush，国内推荐）

1. 打开 https://www.jiguang.cn → 注册 → 创建应用（勾选 Android + iOS 两个平台）→ 拿到 **AppKey** 和 **Master Secret**。
2. 在极光控制台 → 该应用 → **厂商通道**（或「推送设置 → 集成设置」）里，按提示开通并填写：
   - 华为、小米、OPPO、VIVO、魅族 的对应 AppID / AppKey / AppSecret。
   - （这一步是「国内手机系统推送」能送达的关键，不填则只有装了极光 SDK 且 App 存活时才能收到。）
3. 把 AppKey / Master Secret 填到本目录 `.env`：
   ```
   JPUSH_APP_KEY=你的AppKey
   JPUSH_MASTER_SECRET=你的MasterSecret
   ```
4. 安卓 App 端要把 `JPUSH_APPKEY` 写进 `AndroidManifest.xml` 的 meta-data，并初始化 JPush、
   把拿到的 `registrationID` 上报给后端 `POST /api/mobile/devices`（platform=android）。
   具体见 App 工程的集成说明。
5. 重启本服务即自动启用 JPush。

> 同时也在用 FCM？本服务安卓优先走 JPush，JPush 没配时才回退 FCM，两者不冲突。

---

## 三、安卓（FCM，备选，需谷歌服务）

1. 打开 https://console.firebase.google.com/ → 建项目。
2. ⚙ 项目设置 → 服务账号 → **生成新的私钥** → 下载 `service-account.json`，放到本目录。
3. （或）直接用环境变量 `FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT=路径` 指定。

放好 `service-account.json` 后启动即自动启用 FCM（作为 JPush 的备选）。

---

## 四、苹果（APNs）凭证

> ⚠️ **本项目的 iOS Bundle ID 固定为 `com.mercadoprofit.ios`**（见 `MercadoProfit-iOS/project.yml`），
> 下面 `.env` 里的 `APNS_TOPIC` 必须写成这个值，否则 APNs 会拒收。

1. 在 [Apple Developer](https://developer.apple.com/) 创建 **APNs 鉴权密钥 (.p8)**，
   记下 `Key ID` 和 `Team ID`，把 `AuthKey_XXXX.p8` 放到本目录。
2. 在 `.env` 里设置：

| 变量 | 说明 |
|------|------|
| `APNS_KEY_PATH` | `AuthKey.p8` 路径（默认取本目录 `AuthKey.p8`） |
| `APNS_KEY_ID` | .p8 的 Key ID |
| `APNS_TEAM_ID` | 开发者 Team ID |
| `APNS_TOPIC` | **必须 = `com.mercadoprofit.ios`**（iOS App 的 Bundle ID） |
| `APNS_PRODUCTION` | `false`/`空`=沙盒（Xcode 直接跑、TestFlight 之前）；**上架 App Store 后改成 `true`** |

3. iOS App 端 **代码已就绪**：`AppDelegate.swift` 会在启动时 `registerForRemoteNotifications()`，
   拿到 device token 后经 WebView 注入 `window.__PUSH_TOKEN` 上报后端 `POST /api/mobile/devices`（platform=ios）；
   点开通知会注入 `window.__PUSH_OPEN` 跳订单详情。你**不需要改代码**，但要完成下面第 4 步的 Xcode 配置。

4. ⚠️ **Xcode 必做（否则永远收不到，且 `didFailToRegister…` 报错）**：
   - 用 Xcode 打开 `MercadoProfit-iOS/MercadoProfit.xcodeproj`。
   - 选中 `MercadoProfit` target → **Signing & Capabilities** → 点 `+ Capability` → 添加 **Push Notifications**。
     （这一步会自动生成 `MercadoProfit.entitlements` 并写入 `aps-environment`，缺它 APNs 不通。）
   - 顺便在 **Background Modes** 里勾选 **Remote notifications**（后台也能收到，可选但推荐）。
   - **Signing**：把 `DEVELOPMENT_TEAM`（`project.yml` 里现在是空）填上你的 10 位 Team ID，并确保
     Apple Developer 里的 **Identifiers（App ID）= `com.mercadoprofit.ios`** 已开启 Push Notifications 服务，
     再用对应的 provisioning profile 签名。
   - `registerForRemoteNotifications` 只有在「已签名 + 已开 Push 能力 + 真机/模拟器」下才返回 token；
     模拟器**无法**收到真实 APNs 推送（能拿到 token 但不投递），真机测试才准。

---

## 五、请求格式（后端自动发送，你无需改动）

```json
POST /push
{
  "device": { "deviceId": "设备ID", "platform": "android", "token": "JPush registrationID 或 FCM token" },
  "event":  { "type": "new_order", "storeId": "store_abc", "storeName": "墨西哥店A", "orderId": "123", "total": "MXN 99", "buyer": "x", "itemTitles": ["商品1"], "remainingHoursText": "12 小时", "serverTime": "..." }
}
```

响应：
```json
{ "ok": true, "platform": "android", "provider": "jpush", "msgId": "..." }
```

---

## 六、自检

用 curl 模拟后端推一次，看手机是否立刻弹出系统通知：

```bash
curl -X POST https://你的域名/push -H "Content-Type: application/json" -d '{
  "device": {"platform":"android","token":"你的真实 registrationID"},
  "event": {"type":"new_order","storeId":"s1","storeName":"测试店","orderId":"TEST1","total":"MXN 99","buyer":"x"}
}'
```

手机弹通知 = 链路通 ✅

---

## ⚠️ 安全

`service-account.json`、`AuthKey.p8`、`AuthKey_*.p8`、`.env` 等同于推送密码，
**勿提交进代码仓库、勿发到公网**。本目录已加入 `.gitignore`。
