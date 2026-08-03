# 美客多（Mercado Libre）数据采集方案参考

> 适用对象：国内无货源跨境卖家（非本土店、非 Full 店）
> 痛点：现有 ML Product Finder 走官方 `/highlights`，每类目仅返回销量前 20，且无分页；`/search` 对数据中心 IP 被 Cloudflare 403 封锁 → 抓取量极少。
> 整理日期：2026-07-27

## 一、根因
- `/highlights/{SITE}/category/{CAT}`：每类目最多 20 条 Best Seller，**无 offset 分页**。
- `/search`：支持 `q=` 关键词 + `category=` + `offset/limit` 翻页（理论数千~万条），但对**数据中心/中国 IP 返回 403**（应用层封锁，非 CloudFront PolicyAgent）。
- 结论：当前量小不是 bug，是 highlights 数据源的天花板。

## 二、可行方案对比

| 方案 | 数据量 | 成本 | 合规/风险 | 适配无货源·非本土·非Full |
|------|--------|------|-----------|------|
| A. 官方 API + 住宅代理解锁 /search | ★★★★★ 翻页数千~万 | 住宅代理 $5–15/GB | 用官方 API，合规；仅 IP 走住宅 | 最佳：沿用现有排除 fulfillment/本土逻辑 |
| B. 官方认证选品 SaaS（大麦数据/蓝鲸BI/妙手ERP/极鲸云选品助手） | ★★★★ 市场级日更千万条 | 极鲸云永久免费；其余订阅 | 官方开放 API 授权，零爬虫风险 | 很合适：可筛跨境卖家、联动 1688 货源 |
| C. Apify 爬虫 SaaS（devcake/memo23/viralanalyzer） | ★★★★ 自动解 proof-of-work 网关 | 按结果 $0.001–0.005/条 或 $5–30/月 | 灰区（爬搜索页） | 适合深挖：返回 shipping.type/seller 国家/销量 |
| D. 自建爬虫 + 住宅代理（Bright Data/Oxylabs/IPWO/ProxyRack） | ★★★★★ 完全可控 | 代理 $5–15/GB + 开发 | 灰区，需控频（ML 政策 ≤100 次/分） | 投入最大，除非长期自建管道 |

## 三、关键认知
1. ML 封锁的是「数据中心 IP」而非接口。用**目标国住宅代理**（MX/BR/CL/CO 本地真实 ISP IP）即可解锁 /search 翻页。
2. 住宅代理须**地理匹配**：墨西哥 IP 抓 MLM、巴西 IP 抓 MLB，否则仍封。Apify residential / Bright Data / IPWO 支持按国家定向。
3. 「非本土/非 Full」过滤字段现成：
   - `shipping.logistic_type === 'fulfillment'` → Full 店
   - `seller_address.country.id !== 站点国家` → 跨境卖家
   （现有工具已实现这两个过滤，逻辑正确，仅数据量太小体现不出价值）
4. 纯选品不想写代码：官方认证选品工具（极鲸云免费、蓝鲸BI/大麦数据）专为国内跨境卖家做，可筛跨境卖家 + 联动 1688 找货源，零封号风险。

## 四、推荐路线
- 短期最划算：保留「后端直连 highlights（免 VPN）」做轻量日常抓取；同时加「住宅代理」可选项——填代理后抓取改走 /search 翻页（每类成百上千条），沿用现有排除 Full/本土/扩量逻辑。不花钱也能用，要量时挂代理。
- 只做市场研究不想维护：直接用极鲸云选品助手（免费）或蓝鲸BI。

## 五、参考来源（2026-07-27 检索）
- scrapingproxies.best — Best Mercado Libre Scrapers in 2026（住宅代理推荐 Bright Data/Oxylabs，拉美 IP）
- apify.com/devcake/mercadolibre-scraper — 支持 AR/MX/BR 搜索结果抓取，按结果计费
- apify.com/memo23/mercadolibre-scraper — 7 国，自动解 proof-of-work 网关，关键词/类目/商品 URL 三种入口
- apify.com/viralanalyzer/mercadolibre-multi-country — 6 国（含 CL/CO），住宅代理按国家自动匹配，返回 seller 国家/shipping.type
- xcrawl.com — Mercado Libre Product Details Scraper API（结构化 JSON，旋转代理）
- 10100.com 文章 — 大麦数据/蓝鲸BI/妙手ERP/极鲸云选品助手/店雷达 等官方认证选品工具盘点
- scraperly.com / residentialproxy.io — 住宅代理爬 ML 实战（curl_cffi + 代理轮换 + 解网关）
- 10100.com/IPWO 指南 — 住宅代理对接美客多实操（成功率 61%→93.5%，建议 ≤5 次/秒）

## 六、合规提醒
- ML 开发者政策：API 调用 ≤100 次/分钟（ID: ML-DEV-2023-07），超出临时限流。
- 官方认证 SaaS（蓝鲸BI/大麦数据/极鲸云等）走官方开放 API 授权，最合规；自建爬搜索页属灰色地带，需控制频率与合规边界。
