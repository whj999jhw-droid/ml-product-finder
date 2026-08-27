# 住宅代理（Residential Proxy）接入指南

> 适用场景：本项目 `ml-product-finder` 部署在 Oracle 云（数据中心 IP），直连 Mercado Libre 的
> `/search`（自由关键词搜索）与 `/items/{id}`（精确销量）会被地理封锁返回 **HTTP 403**。
> 本指南说明何时需要代理、怎么选、怎么获取、以及如何在配置中心接入。

---

## 1. 先搞清楚：到底哪些接口需要代理？

本项目已实测（数据中心 IP，带合法 App token）：

| 接口 | 数据中心 IP | 说明 |
|---|---|---|
| `/oauth/token` | ✅ 200 | 取 token，无需代理 |
| `/trends/{SITE}` | ✅ 200 | 官方热搜 TOP50，**需求侧入口，零代理可用** |
| `/highlights/{SITE}/category/{id}` | ✅ 200 | 类目热销榜，兜底可用 |
| `/sites/{SITE}/categories` | ✅ 200 | 类目树 |
| `/products/{id}` | ✅ 200 | 商品详情（标题/属性/重量） |
| `/products/{id}/items` | ✅ 200 | 含 price / shipping / seller，**利润核对够用** |
| `/search?q=` | ❌ 403 | 自由关键词搜索，**被封** |
| `/items/{itemId}` | ❌ 403 | 商品详情/精确销量，**被封** |

**结论**：官方 API（`/trends`、`/highlights`、`/products`）免费且合法，**无需代理**即可跑通
方案 A（热搜词选品）与利润核对。代理**只在两种场景才必需**：
1. 想要自由文本 `/search` 关键词扫描（而非仅依赖热搜词 + 类目热销榜）；
2. 必须拿 `/items` 的精确销量（`sold_quantity`）。

> 代价：住宅代理按流量计费，且抓公开页面属灰色地带（见第 6 节合规）。先验证 PMF 再按需上量。

---

## 2. 代理类型对比（该选哪种）

| 类型 | 美客多有效性 | 价格区间 | 适用 |
|---|---|---|---|
| **住宅代理 Residential**（推荐） | 98–99.9%，最有效 | $1–15/GB | 通用解锁 /search、/items |
| **移动/4G/5G 代理** | 最稳、反爬识别最低 | $15–40/GB | 高频率、易风控的账号操作 |
| **ISP / 静态住宅** | 较好，适合需保持会话 | $10–25/GB | 多步流程、需固定出口 |
| **数据中心代理 DC**（含 Oracle/AWS） | 被秒封 ❌ | $1–5/GB | **别用** |
| **Cloudflare Tunnel / CDN 反向代理** | 无效 ❌ | — | 改不了出站 IP 地理位置，对地理封锁无用 |

**一句话**：住宅代理是性价比与有效性最平衡的选择。数据中心代理和隧道方案都绕不过地理封锁。

---

## 3. 一个国家要一个链接吗？—— 通常不需要

主流住宅代理供应商（Bright Data、Oxylabs、Smartproxy、ipipgo、LunaProxy、LoongProxy 等）**普遍支持
单一入口 + 国家参数**，无需为每个国家单独申请链接：

- **账号名嵌国家**：`http://brd-customer-XXX-country-mx:password@brd.superproxy.io:22225`
  （把 `mx` 换成 `br`/`cl`/`co` 即切国家）
- **URL 参数嵌国家**：`http://user:pass@proxy.provider:port?country=mx`
- **会话/轮询参数**：`?session=random` 每次换 IP，`?session=abc` 固定 IP

因此本项目的配置中心设计为：
- **默认链接**（一个输入框）+ **总开关**；链接里写 `{cc}` 占位符，
  运行时自动替换为目标站点国家代码（MLM→`mx`、MLB→`br`、MLC→`cl`、MCO→`co`）。
- **按站点单独配置**（高级，可选）：仅当你的供应商要求每国独立出口时才填，会覆盖默认链接。

> 例：Bright Data 给的是 `http://brd-customer-xxx-country-{cc}:pw@brd.superproxy.io:22225`，
> 本项目扫 MLM 时自动变成 `...-country-mx:...`，扫 MLB 时变成 `...-country-br:...`。

---

## 4. 怎么获取（以主流供应商为例）

1. 注册账号（Bright Data / Oxylabs / Smartproxy / ipipgo / LunaProxy 等），完成实名/付费。
2. 创建 **Residential / ISP Proxy** 通道，拿到：
   - 入口 host:port（如 `brd.superproxy.io:22225`）
   - 账号 / 密码（含可在账号名里拼 `-country-xx` 的 customer 名）
3. 把链接填进配置中心「代理配置」：
   - 若入口支持 `{cc}` → 填 `http://<user>-country-{cc}:<pw>@<host>:<port>`
   - 若每国独立 → 在「按站点单独配置」逐国粘贴
4. 打开开关 → 点「测试连接（MLM）」验证该出口能访问美客多 API（返回 200 即通）。

**价格参考（2026 年，波动大，以官网为准）**：
- 住宅：$1–15/GB（按量，流量包更便宜）
- 移动：$15–40/GB
- 静态住宅：$10–25/GB
- 部分国内供应商（ipipgo / LunaProxy / LoongProxy）有更低的学生/小流量档

---

## 5. 本项目如何自动选用代理

代码路径：`server/mercadolibre.ts`

- `getProxyForSite(site)`：启用且配置 → 返回该站点出口（bySite 覆盖优先，否则默认链接替换 `{cc}`）。
- `getProxyAgent(url)`：每个请求自动从 URL 解析 `/sites/{SITE}/` 选对应国家出口；
  非站点请求（如汇率转换）若默认链接含 `{cc}` 无法解析国家，则**不放代理**（走直连）。
- `scanRecent`（recent 模式）在 `isProxyEnabled()` 为真时走 `/search` 真实新上架，
  为假时回退 `/highlights` 兜底——**代理配好后无需改代码即自动升级**。

请求行为建议（在供应商后台或代码层控制）：
- 每 IP 50–100 请求、间隔 ≥1.5s；别用同一 IP 猛刷。
- 对 `/search` 结果做缓存/去重，省流量。
- 代理国家尽量与 App 注册国一致，避免频繁跨国家跳出口触发风控复核。

---

## 6. 合规与风控提醒

- 官方 API（`/trends`、`/highlights`、`/products`）**免费且合法**，继续走官方、不走代理。
- 住宅代理抓取公开页面属**灰色地带**：控制请求量、别碰账号体系，避免影响你的正式店铺。
- 数据中心 IP 的 TLS 指纹（JA3）易被识别；若频繁 403，考虑在代码层用 `curl_cffi` / `httpx`
  的浏览器 impersonation 替代 Node 原生 https（当前 `httpsGet` 为 Node https，按需增强）。
- 代理失效时保留 `searchConfirmedBlocked` 逻辑自动回退 `/highlights`，不让整轮扫描崩掉。

---

## 7. 排障

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 测试连接 407 | 账号/密码错或 `{cc}` 未替换 | 检查链接格式，确认含正确 country |
| 测试连接超时 | 出口不可达 / 防火墙 | 换供应商入口，或本地先 `curl -x` 验证 |
| `/search` 仍 403 | 代理国家与站点不匹配 / IP 被标记 | 确认 `country-mx` 对应 MLM；换 IP |
| 全站变慢 | 代理带宽/并发限制 | 降并发、加间隔、升套餐 |
