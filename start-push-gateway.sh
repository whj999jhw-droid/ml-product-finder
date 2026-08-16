#!/usr/bin/env bash
# ============================================================================
# start-push-gateway.sh —— 安装并启动手机 APP 推送中转服务（push-gateway）
#
# 作用：把 push-gateway 作为 pm2 常驻进程拉起来，供后端经
#       MOBILE_PUSH_WEBHOOK=http://localhost:4000/push 调用，从而实现
#       「APP 在后台/被杀时也能弹系统通知」。
#
# 幂等：可重复运行。缺 node_modules 会自动装；已有进程会先删再起。
# 用法（由 deploy-oracle.sh / setup-cloudflared.sh 自动调用，也可手动跑）：
#   ./start-push-gateway.sh
# ============================================================================
set -e

APP_DIR="${APP_DIR:-$HOME/ml-product-finder}"
GW_DIR="$APP_DIR/push-gateway"

log()  { echo -e "\033[32m[gw]\033[0m $*"; }
warn() { echo -e "\033[33m[gw]\033[0m $*"; }

if [ ! -d "$GW_DIR" ]; then
  warn "未找到 $GW_DIR，跳过推送中转服务启动（也许你不需要手机后台推送）"
  exit 0
fi

cd "$GW_DIR"

# 缺依赖就装（firebase-admin / apn 仅在启用对应平台时需要，装了也不会报错）
if [ ! -d node_modules ]; then
  log "安装 push-gateway 依赖 (firebase-admin / apn / express)..."
  npm install --production=true
fi

# 先删旧的再起，避免重复进程
pm2 delete ml-push-gateway 2>/dev/null || true
pm2 start server.js --name ml-push-gateway
pm2 save 2>/dev/null || true

log "push-gateway 已启动 ✅ (pm2 名称: ml-push-gateway, 监听端口: ${PORT:-4000})"
log "查看日志: pm2 logs ml-push-gateway"
echo ""
echo "  ┌──────────────────────────────────────────────────────────────┐"
echo "  │ 启用安卓/苹果系统推送（二选一或都配）：                        │"
echo "  │   安卓: 把 Firebase 的 service-account.json 放到 $GW_DIR       │"
echo "  │   苹果: 把 AuthKey_XXXX.p8 放到 $GW_DIR，并设 APNS_KEY_ID 等   │"
echo "  │   然后: pm2 restart ml-push-gateway                            │"
echo "  │ 不配也能用：APP 前台 SSE 实时收 + 回前台补推，不丢单。          │"
echo "  └──────────────────────────────────────────────────────────────┘"
