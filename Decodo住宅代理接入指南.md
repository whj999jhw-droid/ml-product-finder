# 住宅代理接入 ML Product Finder（傻瓜式指南 · DataImpulse / Proxying.io）

> 目标：用**真住宅代理**解锁 ML 的 `/search` 分页，把每类可抓商品从 ~20 条提升到 ~2000 条，验证 M1（住宅代理扩量）是否跑通，并为后续量产选好供应商。
>
> 适用版本：已含「住宅代理（可选·解锁更多数据）」卡片的 ML Product Finder（前端 `ProductFinderPage.tsx` + 后端 `mercadolibre.ts` 代理感知逻辑）。

---

## 〇、先说结论（重要，省你踩坑）

- **Decodo（原 Smartproxy）已放弃**：100MB 试用需要 KYC 身份验证，且验证入口进去了也无法操作，对个人用户不友好。`user-` 前缀等格式坑也多，**不建议再走这条路**。
- **"免费 + 无 KYC"的真住宅代理，2026 年极少**：Webshare 永久免费的是数据中心（解不开 ML 403）；Bright Data 免卡但强制企业 KYC。
- **当前两条可落地、且无需复杂 KYC 的路：**
  - **路径 B（首选·量产）— DataImpulse $5/5GB**：**无 KYC**（仅邮箱注册）、支持**支付宝**、不自动续费、流量永不过期、单价 $1/GB、90M+ 住宅池。5GB 验证 + 日常量产都够。
  - **路径 C（零成本尝鲜）— Proxying.io 免费 2GB**：注册即送 **2GB 住宅流量**，**无需信用卡、无 KYC**，真住宅、支持墨西哥/巴西等地理定向。额度够验证 M1 是否跑通，但不适合量产。
- 任选其一即可。下面路径 A（Decodo）仅作历史记录保留，不要再走。

---

## 一、为什么需要住宅代理（30 秒看懂）

| 模式 | 数据来源 | 每类条数 | 是否需要代理 | 是否需要 VPN |
|---|---|---|---|---|
| 默认（免 VPN） | `/highlights` → `/products` 兜底 | ~20 条 | 不需要 | 不需要 |
| 代理扩量 | `/search` 分页 | 最多 ~2000 条 | **住宅代理** | 不需要 |

- ML 的 `/search` 接口被 **中国 IP + 数据中心 IP** 双重封锁（返回 403）。
- 要解锁 `/search`，必须用**真住宅 IP**（家庭宽带 IP）。数据中心 / 免费代理都解不开。

---

## 二、可落地路径（Decodo 已放弃）

> ⚠️ **路径 A（Decodo）已废弃**：100MB 试用强制 KYC、且验证入口无法操作，个人用户实测走不通。下面只保留 B / C 两条无需复杂验证的路。

### 路径 A（已废弃·勿用）— Decodo 3 天 / 100MB 试用

- 需信用卡 + KYC 身份验证，且实测验证入口进不去、无法操作。**不建议再走**。

### 路径 B — DataImpulse $5 / 5GB（首选·无 KYC·支持支付宝）

1. 打开 <https://dataimpulse.com> → 注册（**只需邮箱 + 密码，无任何 KYC / 身份验证**）。
2. 购买 **"Intro $5 / 5GB"** 住宅代理入门包（**一次性付费、流量永不过期、不自动续费**）。
3. 支付支持 **支付宝 / 信用卡 / 加密币 / Apple Pay / Google Pay**，国内用支付宝最方便。
4. Dashboard 拿到：**Host `gw.dataimpulse.com`、Port `823`(HTTP)/`824`(SOCKS5)、Username=你的登录名、Password=账户密码**。
5. 地理定向写在用户名里（见第三节 B）。
6. 有 7 天退款保障（支付宝/卡支付、未用超 80% 可退；加密币除外）。

> 适合：想一次搞定验证 + 量产的人。5GB ≈ 抓几万条商品，单价 $1/GB 也是全网最低档之一，90M+ 住宅池覆盖墨西哥/巴西/智利/哥伦比亚。

### 路径 C — Proxying.io 免费小额（零成本尝鲜·无 KYC）

1. 打开 <https://proxying.io> → 注册（**无需信用卡、无 KYC**，邮箱即可）。
2. 注册后 **2GB 免费住宅流量自动到账**（这是注册赠送额度，不是 pricing 页里能选的套餐——所以你在价格页看不到"免费"档是正常的；登录后去 Dashboard 看余额即可）。
3. Dashboard 左侧 **Residential Proxies** → 复制 **Username / Password**，端点固定 `proxy.proxying.io:8080`。
4. 地理定向写在用户名里（见第三节 C）。

> 适合：完全不想花钱、只想先验证"代理生效、条数 > 20"的人。额度小，验证完若要做日常量产再转路径 B。

---

## 三、拼出要填进 App 的代理地址（最关键一步）

> ⚠️ **Decodo（路径 A）已放弃**：KYC 验证进不去、且用户名 `user-` 前缀等格式坑多，不要再走。下面只保留 B / C 两条能落地的。

### B. DataImpulse 写法（首选·支持支付宝）

- 国家定向写在登录名后，用 `__cr.国家码`
- HTTP（推荐）：
  ```
  http://你的登录名__cr.mx:你的密码@gw.dataimpulse.com:823
  ```
- SOCKS5：
  ```
  socks5://你的登录名__cr.mx:你的密码@gw.dataimpulse.com:824
  ```
- 例：登录名 `whj87`、密码 `Abc123!`、抓墨西哥 → `http://whj87__cr.mx:Abc123!@gw.dataimpulse.com:823`
- 多国同时：用户名可写 `登录名__cr.mx,br,cl,co`（逗号分隔）；或按站点分别跑、每次改国家码。

### C. Proxying.io 写法（免费 2GB 尝鲜）

- 国家代码：墨西哥 `mx` / 巴西 `br` / 智利 `cl` / 哥伦比亚 `co`
- 端点固定 `proxy.proxying.io:8080`（HTTP / SOCKS5 均同端口）
- 国家定向写在你 **Username** 后面，格式 `-country-xx`
- HTTP（推荐）：
  ```
  http://你的用户名-country-mx:你的密码@proxy.proxying.io:8080
  ```
- SOCKS5：
  ```
  socks5://你的用户名-country-mx:你的密码@proxy.proxying.io:8080
  ```
- 例：Dashboard 给的用户名 `john-xyz123`、密码 `xyz123`、抓墨西哥 → `http://john-xyz123-country-mx:xyz123@proxy.proxying.io:8080`

> ⚠️ **强烈建议让 Dashboard 帮你生成完整用户名，别手拼**：登录 Proxying.io → 进入 **Proxy Setup / 代理设置** 区 → 选国家 = Mexico → 它会直接给出带 `-country-mx` 的完整 Username 字符串，连同密码、端点一起复制即可，避免格式写错又踩 407。

> ⚠️ 密码若含 `@`、`:`、`/` 等特殊字符，需做 URL 编码（如 `@`→`%40`）；建议先用简单密码测试。

---

## 四、填进 ML Product Finder 并抓取

1. 双击桌面 **`MLProductFinder-Launcher.bat`**，等待后端 + 前端启动完成。
2. 浏览器打开 **<http://localhost:5173>**。
3. 找到 **「住宅代理（可选·解锁更多数据）」** 卡片。
4. 把第三节拼好的地址粘贴进输入框（占位符：`http://user:pass@mx.proxy.com:8000 或 socks5://...`）。
5. 点 **「保存代理」** → 卡片应出现「已配置代理」的标签。
6. 点 **「测试连通」**：
   - 成功 → 绿色提示（探测 ML 分类接口走通）。
   - 失败 → 见第六节排查。
7. 勾选站点（MLM / MLB / MLC / MCO），按需设筛选（价格上限 / 排除 Full / 仅跨境 / 仅全新 / 展开子分类）。
8. 点 **「开始抓取（后端直连·免 VPN）」** → 后端检测到代理后，每类页数 **2→40**（≈2000 条/类上限），页间随机延时防限速。

---

## 五、怎么确认代理真的生效了

- **看导出条数**：免代理每类 ~20 条；有代理后单类可能几十到几百条（受筛选限制，不会瞬间到 2000，但明显多于 20）。
- **看测试连通**：第三节的「测试连通」成功即代表代理链路通。
- 更确凿：后端命令行窗口会打印代理已配置、走 `/search` 分页的日志（需看后端控制台）。

---

## 六、连不通 / 抓取仍为 20 条的排查

| 现象 | 可能原因 | 解决 |
|---|---|---|
| 测试连通报 `Access denied. We couldn't log you in...` | 用户名缺 `user-` 前缀 | Decodo 必须写 `user-你的用户名-country-mx`，不能只写 `你的用户名-country-mx` |
| 测试连通报 `Access denied...` | 试用账号需身份验证 | Dashboard 顶部「身份验证」横幅 → 点「开始验证」完成 KYC 后再测 |
| 测试连通失败 | 用户名/国家码格式错 | Decodo 确认带 `user-用户名-country-mx`；DataImpulse 确认带 `登录名__cr.mx` |
| 测试连通失败 | 密码复制不全 / 首尾空格 | 重新复制，粘贴后检查无空格；特殊字符做 URL 编码 |
| 测试连通失败 | 端口错 | Decodo 通用 `7000` 或 dashboard 给的 `10001`；DataImpulse HTTP `823` / SOCKS5 `824` |
| 测试连通失败 | 协议头错 | 用 `http://` 或 `socks5://`，别混用 |
| 抓取仍只有 20 条 | 代理没保存成功 | 确认卡片显示「已配置代理」标签，再点一次保存 |
| 某站点返回 403 | 站点国家与代理国家不匹配 | 把国家码改成该站点国家（如抓 MLB 用 `-country-br` 或 `__cr.br`），单独重跑 |
| 抓取慢 / 限速 | 住宅 IP 被临时限速 | 正常，等待重试；Decodo 可加 `session-随机串` 做粘性会话 |
| DataImpulse 报认证失败 | 登录名/密码错或特殊字符未编码 | 从 Dashboard 重抄；密码改简单后再试 |

> Decodo 粘性会话（可选）：`user-xxxxxxxx-country-mx-session-abc123`（IP 保持 10 分钟，`sessionduration-30` 可改 30 分钟）。

---

## 七、用量与量产选型

- **Decodo 100MB 试用**：≈ 抓几千条，验证够、量产不够。
- **DataImpulse 5GB（$5）**：≈ 抓几万条，验证 + 量产都够；用尽可再买，不自动续费。
- **长期量产推荐（按量付费，单位 GB）：**
  - **DataImpulse $1/GB**（最便宜，地理定向 `__cr.mx/br/cl/co`）— **首选**。
  - Decodo 付费 $2/GB 起（你已注册，续费方便）。
  - 其他：Bright Data $4–8/GB、SOAX $1.99 起、IPRoyal、NetNut。
- **成本估算**：四站全量、每天几十~两百 MB → 月费几美元（DataImpulse 量级）。

---

## 八、合规红线（必读，别踩）

本工具用于**选品参考**（采集公开爆款的标题 / 价格 / 销量 / 链接等公开信息）。跟卖时务必：

- ✅ 自己撰写商品标题、主图、详情、定价。
- ✅ 仅把竞品数据当"选品情报"，不照搬。
- ❌ 不复制竞品的**销量数字、评论内容、图片、品牌**。
- ❌ 不碰侵权品牌 / 假货。

违反以上会造成 **ML 封店 + 侵权索赔**，责任在使用方式。

---

## 附：一键复制模板

> ⚠️ Decodo 已废弃，下面只给能落地的两条。

```text
# —— 路径 B：DataImpulse（首选，$5/5GB 无 KYC，支持支付宝，流量永不过期）——
# HTTP：
http://你的登录名__cr.mx:你的密码@gw.dataimpulse.com:823
# SOCKS5：
socks5://你的登录名__cr.mx:你的密码@gw.dataimpulse.com:824

# —— 路径 C：Proxying.io（免费小额尝鲜，无信用卡/无 KYC）——
# HTTP（用户名后加 -country-mx；端点固定 8080）：
http://你的用户名-country-mx:你的密码@proxy.proxying.io:8080
# SOCKS5：
socks5://你的用户名-country-mx:你的密码@proxy.proxying.io:8080
```

> 国家代码：墨西哥 mx / 巴西 br / 智利 cl / 哥伦比亚 co
> DataImpulse 用双下划线 `__cr.mx`；Proxying.io 用单横线 `-country-mx`。
