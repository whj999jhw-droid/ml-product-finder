# 手机端订单功能改造指南（对接文档 · 给 APP 开发者）

> 本文档可直接交给手机 APP 开发团队，按此改造即可实现：
> **订单页进入即显示全部订单（跨店铺）→ 不同店铺用不同 Tab 展示 → 点刷新按钮与服务器增量同步 → 服务器有、手机没有的订单自动拉到手机本地保存。**
>
> 服务器接口**已经具备全部能力，无需等后端再开发**。已部署地址（生产）：`https://ml.w999w.dpdns.org`
> 域名固定，下文所有 `BASE` 均等于 `https://ml.w999w.dpdns.org`，可直接替换使用。

---

## 0. 核心思路（先读这段）

| 角色 | 说明 |
|------|------|
| **服务器**：单一数据源 | 后端已把每个店铺的订单持久化缓存（`/api/ml/stores/:id/all-orders` 返回的就是某店铺已缓存的全部订单）。 |
| **手机端**：缓存副本 | 手机端本地建一张订单表，把服务器返回的订单 **upsert**（有则更新、无则插入）到本地。手机端展示全部来自本地，体验秒开、可离线看。 |
| **同步**：增量合并 | 进入页面 / 点刷新时，向服务器拉该店铺订单列表，与本机比对，`orderId` 不在本机的就写进本地 —— 这就是「手机没有的拉到手机保存」。 |

> 不需要手机端自己做分页/翻页拉美客多，**服务器已经做好了**。手机端只管「拉列表 → 存本地 → 按店铺分 Tab 显示」。

---

## 1. 接口地址清单（BASE = https://ml.w999w.dpdns.org）

| 方法 | 地址 | 用途 |
|------|------|------|
| GET | `${BASE}/api/ml/stores` | 店铺列表（决定有几个 Tab，只显示 `enabled:true` 的） |
| GET | `${BASE}/api/ml/stores/:storeId/all-orders` | 某店铺**全部**订单（首次阻塞全量，之后读缓存+后台增量） |
| POST | `${BASE}/api/ml/stores/:storeId/sync-orders` | 手动刷新：阻塞做一次增量同步，返回该店铺最新订单列表 |
| GET | `${BASE}/api/mobile/orders/:storeId/:orderId` | 订单详情（电脑端完整详情 + 短信内容 + 扁平摘要） |
| GET | `${BASE}/api/mobile/orders/recent?since=<ISO>` | 离线/断线补推（回到前台补齐漏收的新订单） |
| GET | `${BASE}/api/mobile/stream` | SSE 实时流，新订单立即推送 `new_order` 事件 |
| POST | `${BASE}/api/mobile/devices` | 上报设备推送 token（配合系统通知） |

> ⚠️ 这些接口**当前未鉴权**（与 PC 端一致）。若经公网暴露且订单属敏感数据，需在 nginx 加 API Key 校验或用 VPN/隧道。对接前请与服务端确认鉴权策略。

---

## 2. 返回数据结构

### 2.1 店铺列表 `GET /api/ml/stores`
```json
{
  "success": true,
  "stores": [
    { "id": "store_uuid_1", "nickname": "美国店", "site": "MLM", "enabled": true, "...": "其他字段" },
    { "id": "store_uuid_2", "nickname": "墨西哥店", "site": "MLM", "enabled": true }
  ]
}
```
> 只取 `enabled === true` 的店铺作为 Tab。
> ⚠️ 店铺**显示名**字段是 `nickname`（**不是** `name`）——对接时务必用 `nickname`，否则取不到店铺名。

### 2.2 某店铺全部订单 `GET /api/ml/stores/:id/all-orders`（或 `POST .../sync-orders`）
```json
{
  "success": true,
  "orders": [
    {
      "id": "1234567890",
      "date_created": "2026-08-15T10:20:30.000Z",
      "mlStatus": "unshipped",            // 后端加工：unshipped / shipped / cancelled / other
      "orderStatus": "paid",              // 美客多原始状态
      "shipStatus": "ready_to_ship",      // 或 shipping.status
      "buyer": { "nickname": "Juan", "email": "juan@x.com" },
      "order_items": [ { "item": { "title": "蓝牙耳机", "id": "MLA123" }, "quantity": 1 } ],
      "total_amount": 399.0,              // 金额（有时在 total.amount，见下方说明）
      "currency_id": "MXN",
      "shipping": { "status": "ready_to_ship", "...": "..." },
      "syncSaved": true,                  // ★ 后台定时同步新增的订单 → 列表里显著标记
      "...": "美客多原始订单其余字段（以实际返回 JSON 为准）"
    }
  ],
  "counts": { "total": 120, "unshipped": 30, "shipped": 80, "cancelled": 10 },
  "fromCache": true,        // true=直接读缓存返回（快）；false=首次阻塞全量拉取（仅第一次慢）
  "newCount": 3,            // 后台定时同步新增、且用户还没查看的条数
  "syncedAt": "2026-08-17T03:00:00.000Z",
  "needsSync": false
}
```

> **字段说明：**
> - `id` 是订单唯一标识，手机端用它做去重/主键。
> - `syncSaved`（布尔）：**后台定时同步新抓到的订单**为 `true`，历史订单为 `false`。手机端列表里对 `syncSaved===true` 的订单加「后台同步」标签（与 PC 端一致）。
> - `counts` 是后端按 `mlStatus` 统计的分类计数，手机端可直接用来显示 Tab 角标 / 全部页的分组统计。
> - 金额兼容：`total_amount` 直接数字；若缺失，则取 `order.total.amount`。建议金额字段本地统一换算存储。
> - `order_items[].item.title` 是商品标题（PC 端列表也用这个）。

### 2.3 订单详情 `GET /api/mobile/orders/:storeId/:orderId`
返回 `{ "success": true, "detail": { "desktopDetail": {...}, "smsContent": {...}, "summary": {...} } }`：
- `desktopDetail`：与电脑端弹窗完全一致的完整详情（物流轨迹、商品图片、买家税务证件、费用汇总等）。
- `smsContent`：短信实际展示的内容（纯文本 / markdown 图文 / 邮件 HTML）。
- `summary`：手机端直接渲染的扁平结构（订单号、买家、金额、状态、商品列表等）。

> 点开任意订单看详情时，调这个接口即可，无需手机端自己拼装。

---

## 3. 手机端本地存储设计

### 3.1 数据表（以 SQLite 为例，Room/Core Data 同理）
```sql
-- 店铺表
CREATE TABLE IF NOT EXISTS stores (
  store_id    TEXT PRIMARY KEY,
  nickname    TEXT,
  site        TEXT,
  enabled     INTEGER,
  updated_at  TEXT
);

-- 订单表（复合主键，按店铺隔离）
CREATE TABLE IF NOT EXISTS local_orders (
  store_id    TEXT NOT NULL,
  order_id    TEXT NOT NULL,
  order_json  TEXT,            -- 整条订单 JSON 原样存，详情页/筛选都从它取
  ml_status   TEXT,            -- unshipped/shipped/cancelled/other（用于分类与 counts 重建）
  sync_saved  INTEGER,         -- 1=后台同步新增
  date_created TEXT,           -- 便于排序
  updated_at  TEXT,
  PRIMARY KEY (store_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_local_orders_date ON local_orders(store_id, date_created);
```

### 3.2 关键操作
- **upsert**：`INSERT ... ON CONFLICT(store_id, order_id) DO UPDATE SET order_json=excluded.order_json, ...`
- **按店铺查**：`SELECT * FROM local_orders WHERE store_id=? ORDER BY date_created DESC`
- **全部查**：`SELECT * FROM local_orders ORDER BY date_created DESC`
- **去重判断**：服务器返回的 `orders` 里，若本地没有该 `(store_id, order_id)` 即插入（「手机没有的拉到手机保存」）。

---

## 4. 页面与 Tab 构建流程（核心）

### 步骤 A：进入订单页（首次 / 冷启动）
```
1. 读本地 stores 表 → 决定 Tab（每个 enabled 店铺一个 Tab，可额外加一个「全部」汇总 Tab）
2. 立刻从本地 local_orders 读数据渲染（秒开、可离线）
3. 后台异步：
   a. GET /api/ml/stores  → 更新本地 stores 表（店铺可能有增删）
   b. 对每个 enabled 店铺并发 GET /api/ml/stores/:id/all-orders
      → 把返回的 orders upsert 进本地 → 刷新 UI（counts/Tab 角标更新）
   （首次若服务器也无缓存，该接口会阻塞做一次全量拉取，稍慢，仅一次）
```

### 步骤 B：Tab 结构
- **「全部」Tab**（可选但推荐）：查询 `local_orders` 全表，按 `date_created` 倒序，展示所有店铺订单；顶部可按 `mlStatus` 分组或显示 `counts` 汇总。
- **「店铺A / 店铺B / …」Tab**：分别查 `WHERE store_id=?`，展示该店铺订单。

### 步骤 C：点「刷新」按钮
```
对每个 enabled 店铺：
  POST /api/ml/stores/:id/sync-orders   （阻塞增量同步，返回该店铺最新全量订单）
  → 与本地比对，本地没有的 (store_id, order_id) 插入；已有的更新 order_json
  → 更新 UI + counts
显示「已同步 · 新增 N 条」提示
```
> 这就是用户要求的「手机端与服务器端同步，手机没有的可以拉到手机保存」。服务端 `sync-orders` 已内置增量（只抓近期新订单），手机端再按 `orderId` 兜底去重，双保险。

### 步骤 D：配合实时推送（新订单立即提醒）
- 启动后连接 SSE `GET /api/mobile/stream`，收到 `new_order` 事件 → 在对应店铺 Tab 上显示红点/角标 + 未读数。
- 回到前台或断线恢复时，调 `GET /api/mobile/orders/recent?since=<上次同步时间>` 补齐漏收。
- 用户点开某个有红点的店铺 Tab 时，自动触发一次 `sync-orders`（或 `all-orders`）拉最新。

---

## 5. 代码示例（React Native + expo-sqlite）

> 仅示意核心逻辑，真实项目按你们的存储框架替换（Room / Core Data / Realm 同理）。

```ts
const BASE = 'https://ml.w999w.dpdns.org';

// ---------- 本地存储 ----------
import * as SQLite from 'expo-sqlite';
const db = await SQLite.openDatabaseAsync('app.db');
await db.execAsync(`
  CREATE TABLE IF NOT EXISTS local_orders (
    store_id TEXT NOT NULL, order_id TEXT NOT NULL, order_json TEXT,
    ml_status TEXT, sync_saved INTEGER, date_created TEXT, updated_at TEXT,
    PRIMARY KEY (store_id, order_id)
  );
`);

async function upsertOrders(storeId: string, orders: any[]) {
  for (const o of orders) {
    await db.runAsync(
      `INSERT INTO local_orders (store_id, order_id, order_json, ml_status, sync_saved, date_created, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(store_id, order_id) DO UPDATE SET
         order_json=excluded.order_json, ml_status=excluded.ml_status,
         sync_saved=excluded.sync_saved, date_created=excluded.date_created, updated_at=excluded.updated_at`,
      [storeId, String(o.id), JSON.stringify(o), o.mlStatus || 'other',
       o.syncSaved ? 1 : 0, o.date_created || '', new Date().toISOString()]
    );
  }
}

async function getLocalOrders(storeId?: string) {
  const sql = storeId
    ? `SELECT * FROM local_orders WHERE store_id=? ORDER BY date_created DESC`
    : `SELECT * FROM local_orders ORDER BY date_created DESC`;
  return db.getAllAsync(sql, storeId ? [storeId] : []);
}

// ---------- 进入订单页：先本地后远程 ----------
async function loadOrdersPage() {
  // 1) 先渲染本地（秒开）
  const local = await getLocalOrders();   // 或按当前 Tab 的 storeId 查
  render(local);

  // 2) 拉店铺列表
  const storesResp = await fetch(`${BASE}/api/ml/stores`).then(r => r.json());
  const enabledStores = (storesResp.stores || []).filter(s => s.enabled);

  // 3) 并发拉每个店铺全部订单 → upsert 本地 → 刷新
  await Promise.all(enabledStores.map(async (s) => {
    const resp = await fetch(`${BASE}/api/ml/stores/${s.id}/all-orders`).then(r => r.json());
    if (resp.success) {
      await upsertOrders(s.id, resp.orders);
      // 注意后台增量同步继续，无需等待
    }
  }));
  render(await getLocalOrders());   // 重新渲染最新
}

// ---------- 刷新按钮 ----------
async function refreshAll() {
  const storesResp = await fetch(`${BASE}/api/ml/stores`).then(r => r.json());
  const enabledStores = (storesResp.stores || []).filter(s => s.enabled);
  let added = 0;
  await Promise.all(enabledStores.map(async (s) => {
    const resp = await fetch(`${BASE}/api/ml/stores/${s.id}/sync-orders`, { method: 'POST' }).then(r => r.json());
    if (resp.success) {
      const before = await getLocalOrders(s.id);
      const beforeIds = new Set(before.map(x => x.order_id));
      const freshSaved = resp.orders.filter(o => !beforeIds.has(String(o.id)));
      added += freshSaved.length;
      await upsertOrders(s.id, resp.orders);
    }
  }));
  render(await getLocalOrders());
  Toast.show(`已同步，新增 ${added} 条`);
}

// ---------- 点开订单详情 ----------
async function openOrder(storeId: string, orderId: string) {
  const resp = await fetch(`${BASE}/api/mobile/orders/${storeId}/${orderId}`).then(r => r.json());
  navigateToDetail(resp.detail);   // desktopDetail / smsContent / summary 直接渲染
}
```

---

## 6. ⚠️ 重点注意事项（务必遵守）

1. **`orderId` 去重是底线**：SSE 实时推送、`recent` 补推、`sync-orders` 刷新三条路径都可能给你同一条订单，统一以 `(store_id, order_id)` 做 upsert，避免重复。
2. **本地优先渲染**：进入页面先读本地库再请求网络，保证秒开、弱网/离线也能看历史订单。
3. **「全部」Tab 与店铺 Tab 共用一张本地表**：用 `WHERE store_id=?` 区分即可，不要为每个店铺建独立表。
4. **`syncSaved` 标记要展示**：`syncSaved===true` 的订单在列表加「后台同步」标签，与 PC 端保持一致，让用户知道这是后台自动抓到的新单。
5. **金额字段兼容**：优先 `total_amount`，缺失时回退 `order.total.amount`；按 `currency_id` 显示币种。
6. **时间排序**：统一用 `date_created`（ISO 字符串）倒序；本地存 `date_created` 便于索引排序。
7. **刷新不必全量重拉**：`sync-orders` 已是服务端增量，手机端再做 `orderId` 兜底即可，别自己翻页拉美客多。
8. **同步延迟认知**：后端默认每 30 分钟轮询一次美客多，「后台定时新增」的订单最多延迟约 30 分钟才出现（既有机制，非接口问题）。若需更实时，缩短轮询间隔需服务端配合。

---

## 7. 联调自检清单

- [ ] `GET /api/ml/stores` 返回 enabled 店铺，Tab 数量与之匹配
- [ ] 进入订单页：先看到本地旧数据，几秒后远程数据刷新（首店首次稍慢属正常）
- [ ] 「全部」Tab 显示所有店铺订单；切换到店铺 Tab 只显示该店铺
- [ ] 点「刷新」：服务器新增的订单出现在本机；本地已有订单金额/状态被更新
- [ ] `syncSaved===true` 的订单带「后台同步」标签
- [ ] 点开订单：详情接口返回 `desktopDetail/smsContent/summary` 且能渲染
- [ ] 杀掉 APP 再进：上次同步的订单仍在（本地持久化生效）
- [ ] （可选）SSE 收到 `new_order` 后对应 Tab 出现红点；回前台 `recent` 补齐

---

## 8. 与服务端推送文档的关系

本指南只讲「订单列表 / Tab / 刷新同步」。若还要做「新订单系统通知（APP 被杀也能弹）」，请配合阅读 **`docs/mobile-push-complete-guide.md`**（SSE 接收、设备注册、离线补推、中转服务部署）。两者共用同一套 `BASE` 与 `storeId/orderId` 体系，可一起实现。
