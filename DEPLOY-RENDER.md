# 部署到 Render（自动每日抓取 + 邮件推送）

本项目已支持一键部署到 Render。部署后，程序可在设定时间自动抓取美客多（墨西哥 MLM / 巴西 MLB / 智利 MLC / 哥伦比亚 MCO）各品类商品，并自动把 xlsx 结果发到你配置的邮箱。

> 数据源：后端直连美客多 `/highlights → /products` 接口（从中国及 Render 的 AWS IP 均可访问，无需 VPN、无需任何代理）。搜索接口 (`/search`) 对所有数据中心 IP 返回 403，因此本程序走 highlights 兜底链路，每类最多约 20 条。

---

## 一、前置准备

1. **GitHub 仓库**：把本项目推送到一个 GitHub 仓库（公开或私有均可）。
2. **美客多 API 凭证**：在 [developers.mercadolibre.com](https://developers.mercadolibre.com) 创建应用，拿到 `App ID` 和 `Secret Key`。
3. **SMTP 邮箱**：用于接收抓取结果（如 Gmail 授权码、企业邮箱等）。

---

## 二、在 Render 创建 Web Service

1. 打开 https://dashboard.render.com → **New + → Web Service**。
2. 关联你的 GitHub 仓库，选择分支（默认 `main`）。
3. 配置：
   - **Runtime**: Node
   - **Plan**: Free（或按需选 Starter）
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm run server`
   - **Health Check Path**: `/api/health`
   - **Region**: 建议 `Oregon`（美洲，离美客多站点更近）
4. 在 **Environment** 中添加：
   - `NODE_ENV` = `production`（Render 会自动注入 `PORT`，无需手动设置）
5. 点击 **Create Web Service**，等待构建完成。构建成功后访问分配的 `https://<你的服务>.onrender.com` 即可打开页面。

> 配置已写入仓库根目录的 `render.yaml`，Render 会自动读取；也可在后台手动覆盖。

---

## 三、在页面上完成初始化（一次性）

打开部署后的页面，依次操作：

1. **应用配置**：填入 `App ID` / `Secret Key` → 保存。
2. **获取 Token**：点击「获取应用 Token」（使用 `client_credentials`，无需公网隧道）。
3. **抓取配置**：勾选站点、设置价格上限、筛选条件（排除 ML Full / 本土、仅全新、展开子分类）。
4. **邮件通知**：只需填写**收件邮箱** → 点「发送测试邮件」确认 → 打开「启用邮件通知」→ 保存。SMTP 发件人由环境变量 `ML_SMTP_*` 在服务端配置（见第七节），不在页面填写。
5. **定时自动抓取**：打开「启用定时」，设置每日运行时间（服务器时区，Render 默认 UTC）→ 保存。

---

## 四、解决 Free 套餐「休眠」问题（关键）

Render 免费 Web Service 在 **15 分钟无请求后会休眠**，休眠后内置调度器不会触发。
解决办法：用一个**外部定时器**每天定时“唤醒”并触发抓取。

### 方案：cron-job.org（免费）

1. 打开 https://cron-job.org → 注册 → **Create cronjob**。
2. **URL**: `https://<你的服务>.onrender.com/api/ml/trigger`
3. **Method**: `POST`
4. **Schedule**: 设为比页面里「定时自动抓取」时间**早 1~2 分钟**（例如页面设 09:00，这里设 08:58）。
5. 保存。它会每天定时访问该接口：先把服务唤醒，再触发一次完整的抓取 + 邮件发送。

> `/api/ml/trigger` 会复用页面上一次「开始抓取」使用的**站点与筛选条件**。所以每次改完筛选条件后，记得在页面上点一次「开始抓取」保存最新配置。

---

## 五、重要注意事项（免费套餐限制）

1. **Token 自动续期（已内置）**：程序启动时即用 `client_credentials` 预热 token，并每 30 分钟保活一次。只要配置了 `ML_APP_ID` + `ML_SECRET_KEY` 环境变量，即使磁盘被清空（免费套餐重新部署）也能自动续期，**无需手动重授权**。
   - 强烈建议在 Render 的 Environment 中设置 `ML_APP_ID` 和 `ML_SECRET_KEY`，这样每次唤醒/重启后自动获取新 token，彻底免手动操作。
   - 若未设置这两个变量，则仍需在页面手动「获取应用 Token」（凭证保存在 data/，重新部署会丢失）。
2. **磁盘是临时性的**：每次重新部署会清空 `data/` 目录，已导出的 xlsx 和本地 Token 会丢失。
   - 因此**邮件**才是结果的最终落点——抓取完成后 xlsx 会作为附件发出，不依赖磁盘持久化。
3. **每类最多约 20 条**（highlights 接口上限，无分页）。如需更多，勾选「展开子分类扩量」（遍历子分类，数据更多但更慢）。

---

## 六、本机 / 内网服务器部署（可选）

若你有常驻的服务器或本机（如当前 Windows 机器双击桌面 `MLProductFinder-Launcher.bat`）：
- 内置调度器会按设定时间自动运行，不受休眠限制。
- 只需保持程序运行即可，无需外部 cron。

---

## 七、环境变量速查

| 变量 | 说明 | 必填 |
|------|------|------|
| `NODE_ENV` | 设为 `production` 启用静态托管 | 是 |
| `PORT` | Render 自动注入，勿手动设置 | 自动 |
| `SESSION_SECRET` | 会话密钥，Render 可自动生成 | 建议 |
| `ML_APP_ID` | 美客多应用 App ID，配合 `ML_SECRET_KEY` 实现启动自动续期 token | **建议**（免手动重授权） |
| `ML_SECRET_KEY` | 美客多应用 Secret Key | **建议**（免手动重授权） |
| `ML_SMTP_HOST` | 发件 SMTP 主机（如 `smtp.gmail.com`） | 发邮件时必填 |
| `ML_SMTP_PORT` | SMTP 端口（如 `465`） | 选填（默认 465） |
| `ML_SMTP_USER` | SMTP 登录账号（发件邮箱） | 发邮件时必填 |
| `ML_SMTP_PASS` | SMTP 密码 / 授权码 | 发邮件时必填 |
| `ML_SMTP_FROM` | 发件人显示地址（默认同 `ML_SMTP_USER`） | 选填 |
| `ML_SMTP_SECURE` | `true`/`false`，是否 SSL/TLS（默认 true） | 选填 |
| `ML_EMAIL_TO` | 收件邮箱默认值（页面也可填，环境变量做兜底） | 选填 |

完成后，每天到点你会自动收到一封带 xlsx 附件的邮件。
