# 推送中转服务（push-gateway）

ml-product-finder 后端检测到美客多新订单时，会把 `{ device, event }` POST 到
`MOBILE_PUSH_WEBHOOK` 指向的地址 —— 也就是本服务。本服务再调用 **FCM（安卓）**
或 **APNs（苹果）** 把系统通知发到手机，从而实现「APP 被杀掉也能弹通知」。

> 不部署本服务也完全能用：APP 在前台时靠 `GET /api/mobile/stream`(SSE) 实时收，
> 回到前台时靠 `GET /api/mobile/orders/recent` 补齐。本服务只是「后台/被杀唤醒」的增强。

---

## 一、快速开始

```bash
cd push-gateway
npm install
# 配置凭证（见下方二、三节），至少配一项
npm start
```

启动后控制台显示 `推送中转服务已启动： http://localhost:4000/push`。
把这个地址（**生产环境必须是公网 HTTPS**）填到后端的：

```
MOBILE_PUSH_WEBHOOK=https://你的域名/push
```

然后**重启后端**。

---

## 二、安卓（FCM）凭证

1. 打开 https://console.firebase.google.com/ → 建项目。
2. ⚙ 项目设置 → 服务账号 → **生成新的私钥** → 下载 `service-account.json`，放到本目录。
3. （或）直接用环境变量 `FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT=路径` 指定。

放好 `service-account.json` 后启动即自动启用 FCM。

---

## 三、苹果（APNs）凭证

1. 在 [Apple Developer](https://developer.apple.com/) 创建 **APNs 鉴权密钥 (.p8)**，
   记下 `Key ID` 和 `Team ID`，把 `AuthKey_XXXX.p8` 放到本目录。
2. 设置环境变量（也可写入 `.env` 由你自己的方式注入）：

| 变量 | 说明 |
|------|------|
| `APNS_KEY_PATH` | `AuthKey.p8` 路径（默认取本目录 `AuthKey.p8`） |
| `APNS_KEY_ID` | .p8 的 Key ID |
| `APNS_TEAM_ID` | 开发者 Team ID |
| `APNS_TOPIC` | APP 的 Bundle ID |
| `APNS_PRODUCTION` | `true`=线上环境，`false`/`空`=沙盒 |

---

## 四、请求格式（后端自动发送，你无需改动）

```json
POST /push
{
  "device": { "deviceId": "设备ID", "platform": "android", "token": "FCM令牌" },
  "event":  { "type": "new_order", "storeId": "store_abc", "storeName": "墨西哥店A", "orderId": "123", "total": "MXN 99", "buyer": "x", "itemTitles": ["商品1"], "serverTime": "..." }
}
```

响应：
```json
{ "ok": true, "platform": "android", "messageId": "..." }
```

---

## 五、自检

用 curl 模拟后端推一次，看手机是否立刻弹出系统通知：

```bash
curl -X POST https://你的域名/push -H "Content-Type: application/json" -d '{
  "device": {"platform":"android","token":"你的真实FCMtoken"},
  "event": {"type":"new_order","storeId":"s1","storeName":"测试店","orderId":"TEST1","total":"MXN 99","buyer":"x"}
}'
```

手机弹通知 = 链路通 ✅

---

## ⚠️ 安全

`service-account.json`、`AuthKey.p8` 等同于推送密码，**勿提交进代码仓库、勿发到公网**。
本目录已加入 `.gitignore`。
