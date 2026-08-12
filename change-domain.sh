#!/usr/bin/env bash
# ============================================================
# 一键改 cloudflared 隧道域名（缩短子域名用）
# 用法：
#   bash change-domain.sh                      # 默认改成 ml.w999w.dpdns.org
#   NEW_DOMAIN=xxx.w999w.dpdns.org bash change-domain.sh
# 说明：本脚本只动【服务器侧】。美客多开发者后台的重定向 URI 仍需你手动改（见末尾）。
# ============================================================
set -euo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-ml-finder-server}"
NEW_DOMAIN="${NEW_DOMAIN:-ml.w999w.dpdns.org}"
APP_DIR="${APP_DIR:-$HOME/ml-product-finder}"
CF_BIN="$(command -v cloudflared || echo /usr/local/bin/cloudflared)"
CONFIG="$HOME/.cloudflared/config.yml"
REDIR="https://$NEW_DOMAIN/api/ml/oauth/store-callback"

echo "============================================"
echo " 隧道名      : $TUNNEL_NAME"
echo " 新域名      : $NEW_DOMAIN"
echo " 新回调地址  : $REDIR"
echo " 项目目录    : $APP_DIR"
echo "============================================"
read -r -p "确认要切换域名吗？[y/N] " ANS
[ "${ANS:-N}" = "y" ] || { echo "已取消。"; exit 0; }

# 1) 自动建 DNS（cloudflared 在 Cloudflare zone 上自动加 CNAME；已存在会报错可忽略）
echo "[1/5] 自动创建 DNS 路由 $NEW_DOMAIN -> 隧道 ..."
"$CF_BIN" tunnel route dns "$TUNNEL_NAME" "$NEW_DOMAIN" 2>/dev/null \
  && echo "      DNS 路由已创建" \
  || echo "      (DNS 路由可能已存在，可忽略)"

# 2) 改 cloudflared config.yml 的 hostname
echo "[2/5] 更新 $CONFIG 的 hostname ..."
if [ -f "$CONFIG" ]; then
  sed -i "s#^  - hostname:.*#  - hostname: $NEW_DOMAIN#" "$CONFIG"
  grep -n "hostname:" "$CONFIG"
else
  echo "!! 未找到 $CONFIG，请确认 cloudflared 已安装配置；中止。"
  exit 1
fi

# 3) 改项目 .env 的 ML_REDIRECT_URI
echo "[3/5] 更新 $APP_DIR/.env 的 ML_REDIRECT_URI ..."
if [ -f "$APP_DIR/.env" ]; then
  if grep -q '^ML_REDIRECT_URI=' "$APP_DIR/.env"; then
    sed -i "s#^ML_REDIRECT_URI=.*#ML_REDIRECT_URI=$REDIR#" "$APP_DIR/.env"
  else
    echo "ML_REDIRECT_URI=$REDIR" >> "$APP_DIR/.env"
  fi
  grep '^ML_REDIRECT_URI=' "$APP_DIR/.env"
else
  echo "!! 未找到 $APP_DIR/.env，跳过（请确认项目已部署）"
fi

# 4) 重启 cloudflared + PM2（.env 改动需后端重启才生效）
echo "[4/5] 重启 cloudflared 与 ml-finder ..."
sudo systemctl restart cloudflared
pm2 restart ml-finder || pm2 start ./wait-tunnel-and-start.sh --name ml-finder
sleep 5

# 5) 自检
echo "[5/5] 自检新域名 ..."
for i in $(seq 1 10); do
  if curl -fsS --max-time 5 "https://$NEW_DOMAIN/api/ml/oauth/ping" 2>/dev/null | grep -q '"ok":true'; then
    echo "✅ 新域名已通: https://$NEW_DOMAIN/api/ml/oauth/ping -> {\"ok\":true}"
    OK=1; break
  fi
  echo "   等待隧道握手 ($i/10) ..."; sleep 3
done
[ "${OK:-0}" = 1 ] || echo "⚠️ 新域名暂未连通，稍后手动 curl 验证；若长期不通查 journalctl -u cloudflared"

echo
echo "============================================"
echo " 服务器侧已全部改完并重启。"
echo " 你还需手动做 1 件事（无法自动化，需你登录）："
echo "   1) 打开美客多开发者后台 -> 你的应用 -> 重定向 URI"
echo "      把旧地址换成： $REDIR"
echo "      （美客多对 redirect_uri 逐字匹配，不改这里授权回调会被拒）"
echo "   2) 访问前端： https://$NEW_DOMAIN/stores"
echo " 旧地址 https://ml-callback-server.w999w.dpdns.org 改完即刻失效（隧道只认新 hostname）。"
echo "============================================"
