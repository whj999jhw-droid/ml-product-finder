# 部署与启动说明（ML Product Finder）

本说明覆盖：在 Oracle / 任意有公网 IP 的服务器（或本机）上把本项目跑起来，并配置好多店铺授权所需的「公网回调地址」。

> 配套文档：`docs/oracle-auto-grab-guide.md`（如何自动抢 Oracle 免费实例）。

---

## 1. 服务器要求

| 项目 | 建议 |
|---|---|
| 系统 | Ubuntu 22.04 / 24.04（x86_64 或 ARM aarch64 均可） |
| CPU / 内存 | ≥ 1 vCPU / 1 GB（AI 修图 rembg 建议 ≥ 2 GB；Oracle A1 选 2 OCPU / 12 GB 足够） |
| Node.js | ≥ 20（推荐 22，见下文安装） |
| Python | ≥ 3.10（仅 AI 修图需要：rembg + Pillow） |
| 网络 | 出方向可访问 `api.mercadolibre.com`（服务器 IP 不在中国大陆封锁段即可；Oracle 美/墨区域均可用） |

---

## 2. 安装运行环境

```bash
# Node 22（用 nvm 或官方二进制）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Python + AI 修图依赖（不需要 AI 修图可跳过）
sudo apt-get install -y python3 python3-venv python3-pip
python3 -m venv venv
source venv/bin/activate
pip install "rembg[cpu]==2.0.77" Pillow
```

---

## 3. 拉代码 + 构建

```bash
git clone <你的仓库> ml-product-finder && cd ml-product-finder
npm install
npm run build        # 产出前端 dist/，后端会自动 serve 它（只需跑一个进程）
```

---

## 4. 环境变量（全部可选，缺省走本地/隧道默认值）

在启动前通过 `export` 或 systemd / pm2 环境变量注入：

| 变量 | 作用 | 示例 |
|---|---|---|
| `PORT` | 后端端口 | `3000` |
| `ML_APP_ID` | 美客多开发者应用的 Client ID（**多店铺 OAuth 的 client_id，必填**） | `7306xxxxxxxxxx` |
| `ML_SECRET_KEY` | 美客多应用 Secret（必填） | `xxxxxxxxxxxxxxxx` |
| `ML_REDIRECT_URI` | 店铺授权的公网回调地址，**优先级最高**。有固定域名/IP 时直接设它，可**不用隧道** | `https://你的域名/api/ml/oauth/store-callback` |
| `ML_TUNNEL_SUBDOMAIN` | localtunnel 固定子域名。**设成你自己专属的字符串**，保证回调地址稳定（避免每次随机变化要重配 ML 后台） | `yourname-ml-callback` |
| `LLM_BASE_URL` | OpenAI 兼容接口 Base URL（标题/描述 AI 生成用） | `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | 上述接口 Key | `sk-xxxx` |
| `LLM_MODEL` | 模型名 | `deepseek-chat` |
| `ML_SMTP_HOST/PORT/USER/PASS/FROM` | 邮件通知 SMTP（也可在网页「邮件通知」里填） | `smtp.xxx.com` |
| `ML_EMAIL_TO` | 订单/抓取结果收件人 | `you@xx.com` |
| `TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM / TWILIO_TO` | 短信提醒（Twilio） | — |
| `SMS_WEBHOOK_URL` | 短信提醒（通用 webhook，阿里云/腾讯云/自建皆可） | `https://...` |
| `ML_ONEBOUND_KEY / ML_ONEBOUND_SECRET` | 1688 货源搜索（可选） | — |

> 最简启动（本机开发）：只要设 `ML_APP_ID` + `ML_SECRET_KEY` 即可，回调地址用「添加店铺」时自动起的 localtunnel。

---

## 5. 启动

```bash
# 直接前台（调试）
npm run server

# 生产建议用 pm2 守护
npm install -g pm2
pm2 start "npm run server" --name ml-product-finder
pm2 save
```

启动后访问 `http://<服务器IP>:3000`（若用反向代理/域名走 80/443 亦可）。

---

## 6. 多店铺授权（关键一步：配置回调地址）

美客多**不接受 `localhost` 作为 OAuth 回调**，所以「添加店铺」必须有一个公网可达的回调地址。两种方案二选一：

### 方案 A：用公网域名 / 固定 IP（推荐，最稳）
1. 给服务器绑一个域名（或临时用 IP），确保 `https://你的域名/api/ml/oauth/store-callback` 能从公网访问。
2. 设环境变量 `ML_REDIRECT_URI=https://你的域名/api/ml/oauth/store-callback`。
3. 到 **美客多开发者后台 → 你的应用 → 重定向 URI**，把上面这个地址加进去（只需配一次）。
4. 在网页「店铺管理 → 授权回调设置」里确认状态为「已配置」。

#### 本机无公网 IP / 无自有服务器？用 Cloudflare Tunnel（cloudflared）拿固定域名（最推荐）

你有 Cloudflare 上的域名时，用 `cloudflared` 在本机开一条隧道，把 `https://子域.你的域名` 永久映射到 `localhost:3000`，回调地址**永不变**，比 localtunnel 稳定得多。

**前提**：域名已加到 Cloudflare（NS 指向 Cloudflare）。本工具已确认 `w999w.dpdns.org` 在 Cloudflare 上，子域用 `ml`，即回调地址固定为 `https://ml.w999w.dpdns.org/api/ml/oauth/store-callback`。

**① 安装 cloudflared**（Windows，用已装好的 node 环境旁的管理终端 / PowerShell）：
```powershell
winget install Cloudflare.cloudflared
# 或去 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载 exe，放到 PATH
cloudflared --version
```

**② 登录 Cloudflare（只需一次，会弹浏览器，用你的 Cloudflare 账号授权）**：
```powershell
cloudflared login
```
登录成功后会在 `~/.cloudflared/cert.pem` 生成证书。

**③ 创建一条隧道（只需一次）**：
```powershell
cloudflared tunnel create ml-product-finder
```
记下输出的 Tunnel ID（也会存到 `~/.cloudflared/<id>.json`）。

**④ 把子域 `ml-callback.你的域名` 指向这条隧道（只需一次，自动建 DNS CNAME）**：
```powershell
cloudflared tunnel route dns ml-product-finder ml.w999w.dpdns.org
```

**⑤ 写一份配置文件 `~\cloudflared\config.yml`**（让隧道指向本机 3000）：
```yaml
tunnel: ml-product-finder
credentials-file: C:\Users\whj87\.cloudflared\<上一步的id>.json
ingress:
  - hostname: ml.w999w.dpdns.org
    service: http://localhost:3000
  - service: http_status:404
```

**⑥ 启动隧道（以后每次开机跑这一条即可）**：
```powershell
cloudflared tunnel run ml-product-finder
```
保持窗口开着；或注册为 Windows 服务：`cloudflared tunnel run ml-product-finder --name ml-product-finder`。

**⑦ 设环境变量并重启后端**：
```
ML_REDIRECT_URI=https://ml.w999w.dpdns.org/api/ml/oauth/store-callback
```
重启 `tsx server/index.ts` 后，网页「授权回调设置」会显示「固定回调域名模式」，回调地址即为上面这个、永久不变。

> **为什么重启后还是 loca.lt？** 99% 是 `ML_REDIRECT_URI` 没真正传进后端进程。Windows PowerShell 必须在**启动后端的同一个窗口**里设：`$env:ML_REDIRECT_URI="https://ml.w999w.dpdns.org/api/ml/oauth/store-callback"`，然后再跑 `npx tsx server/index.ts`。换窗口、只改文件不重启、拼写错误，都会让旧值继续生效。重启后刷新页面，如果仍显示 loca.lt，请打开浏览器 F12 → Network → 看 `/api/ml/oauth/tunnel` 返回里的 `fixedRedirect` 字段是否为 `true`。

**快速验证隧道是否通**（不用走完整授权）：
- 浏览器打开 `https://ml.w999w.dpdns.org/api/ml/oauth/store-callback`
  - 看到「缺少授权码或状态参数」→ 隧道和回调路由都通了，去美客多后台把上面地址加进「重定向 URI」即可。
  - 看到无法连接/超时 → 隧道没在跑（回去执行 ⑥）或 DNS 未生效（等几分钟）。
- 建议先 `npx vite build` 一次，让 `dist/` 是最新代码；这样用域名访问时整站都能正常加载。

> 注意：`cloudflared` 只负责把**回调请求**从公网转到你本机，不涉及 ML 商品抓取（抓取走后端代理，与隧道无关）。若部署在 Oracle 等已具公网 IP 的服务器上，直接在服务器跑 `cloudflared` 或反向代理即可，逻辑相同。

### 方案 B：localtunnel 自动隧道（本机/无域名时用）
1. 在网页点「添加店铺」时，服务端会**自动**起 localtunnel 并把回调地址设为 `https://<子域>.loca.lt/api/ml/oauth/store-callback`。
2. **首次**需要把弹窗里显示的回调地址粘到美客多后台「重定向 URI」（只需一次）。
3. 为避免固定子域被占用导致地址每次变化，启动时设 `ML_TUNNEL_SUBDOMAIN=你专属的字符串`（如 `yourname-ml-callback`），让隧道地址稳定。

> 无论哪种方案，回调地址都必须是 `.../api/ml/oauth/store-callback`（店铺授权端点），不是 `/oauth/callback`。

---

## 7. 定时任务

- **每 5 分钟拉取各店新订单并提醒**：后端启动后自动开始（无需额外配置）。
- **抓取爆款（M1）**：在网页「美客多商品抓取」手动触发，或用 `/api/ml/trigger` 外部 cron 唤醒。

---

## 8. 热搜词页面

左侧菜单「热搜词」调用 Mercado Libre 官方 `/trends/{site_id}` 接口，展示墨西哥/巴西/智利/哥伦比亚四站每周最热搜索词。

- 数据每周更新一次，本地缓存 1 小时；点击「刷新」可强制重新拉取。
- 50 个词按官方口径分为三类：前 10 个「增长最快」、接下来 20 个「用户最想要」、最后 20 个「最受欢迎」。
- 每个词显示为「英文 / 中文」双语；**点击英文复制英文，点击中文复制中文**（复制后对应文字会变淡，仍可再次点击复制）。
- 中文翻译由 LLM 自动生成并本地缓存 7 天；需已配置 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`。未配置 LLM 时仍显示英文，不影响使用。
- 该接口需要有效 ML access token：后端会自动用 `ML_APP_ID`/`ML_SECRET_KEY` 走 `client_credentials` 获取；若已添加店铺，也会复用店铺 token。

---

## 9. 防火墙 / 安全组

放行：`22`（SSH）、`3000`（应用，或 80/443 若用反代）。SMTP/短信凭据、ML Secret 请用环境变量或网页填写，**不要**写进仓库。
