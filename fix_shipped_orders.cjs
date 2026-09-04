// 生产库一次性修复：清掉「已发货/已取消」订单里残留的脏履约剩余时间。
// 用途：手机端显示「已超时」是因 order_json 里 remainingHours 存了负值（如 -2 小时）。
//       本脚本直接把 shipped/cancelled 订单的剩余时间清为 null，手机端立即正确，
//       无需等待重新打包 App 或重新部署后端。
// 运行（在服务器 ml-product-finder 目录下）：
//   node fix_shipped_orders.cjs
// 如需指定其他库路径：ORDERS_DB=/path/to/mlfinder.db node fix_shipped_orders.cjs
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ORDERS_DB || path.join(__dirname, 'data', 'mlfinder.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('未找到数据库文件：', DB_PATH);
  process.exit(1);
}
const db = new Database(DB_PATH);
const rows = db.prepare("SELECT id, store_id, order_json FROM orders WHERE ml_status IN ('shipped','cancelled')").all();
let fixed = 0, skipped = 0;
const upd = db.prepare('UPDATE orders SET order_json = ?, handling_deadline = NULL WHERE id = ? AND store_id = ?');
const tx = db.transaction(() => {
  for (const r of rows) {
    let o;
    try { o = JSON.parse(r.order_json); } catch { skipped++; continue; }
    const dirty = o.remainingHours != null || o.handlingDeadline != null || (o.remainingHoursText && o.remainingHoursText !== '—');
    if (!dirty) { skipped++; continue; }
    o.handlingDeadline = null;
    o.remainingHours = null;
    o.remainingHoursText = '—';
    upd.run(JSON.stringify(o), r.id, r.store_id);
    fixed++;
  }
});
tx();
console.log(`扫描 ${rows.length} 单（已发货/已取消），修复脏数据 ${fixed} 单，跳过 ${skipped} 单。`);
if (fixed > 0) console.log('修复完成。请在 App 订单页点右上角刷新，即可看到已发货订单不再显示「已超时」。');
