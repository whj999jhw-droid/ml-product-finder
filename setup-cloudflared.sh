#!/usr/bin/env bash
# ============================================================================
# setup-cloudflared.sh —— 一键完成「cloudflared 固定域名隧道 + 启动顺序固化」
# 对应 DEPLOY-ORACLE.md（合并版）「第二部分」的第 1~9 步。幂等：做过的步骤会自动跳过，
# 可以放心重复运行（比如你已经手动做到了第 8 步，直接跑它就能把第 9 步补完）。
#
# 用法：
#   1) 把本文件传到服务器（MobaXterm 拖进去，或 git pull）
#   2) 改下面两个变量，或运行时传环境变量：
#        TUNNEL_NAME=ml-finder-server  DOMAIN=ml.w999w.dpdns.org  bash setup-cloudflared.sh
#   3) 如果提示「缺少 cert.pem」，先手动跑 `cloudflared tunnel login` 授权，
#      回到浏览器点 Authorize，再重新运行本脚本。
#   4) 脚本跑完后，去 Mercado Libre 后台加回调地址（见脚本末尾提示）。
# ============================================================================

set -euo pipefail

# ----------------------------- 可配置项 -----------------------------------
TUNNEL_NAME="${TUNNEL_NAME:-ml-finder-server}"
DOMAIN="${DOMAIN:-ml.w999w.dpdns.org}"
APP_DIR="${APP_DIR:-$HOME/ml-product-finder}"
PM2_NAME="${PM2_NAME:-ml-finder}"
# -------------------------------------------------------------------------

log()  { echo -e "\033[32m[setup]\033[0m $*"; }
warn() { echo -e "\033[33m[warn]\033[0m $*"; }
err()  { echo -e "\033[31m[err ]\033[0m $*" >&2; }

CF_BIN="$(command -v cloudflared || echo /usr/local/bin/cloudflared)"
CERT="$HOME/.cloudflared/cert.pem"

echo "============================================================"
log "隧道名 = $TUNNEL_NAME"
log "域名   = $DOMAIN"
log "项目   = $APP_DIR"
log "PM2名  = $PM2_NAME"
echo "============================================================"

# === 第 1 步：安装 cloudflared ============================================
if command -v cloudflared >/dev/null 2>&1; then
  log "cloudflared 已安装: $(cloudflared --version 2>&1 | head -1)"
else
  log "安装 cloudflared ..."
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt update -qq
  sudo apt install -y cloudflared
fi
CF_BIN="$(command -v cloudflared)"

# === 第 2 步：登录（缺 cert.pem 就先手动登录）==========================
if [ ! -f "$CERT" ]; then
  err "缺少 $CERT —— 请先在服务器上手动运行："
  err "    cloudflared tunnel login"
  err "并在本机浏览器打开它打印的链接，登录 Cloudflare 并授权域名，"
  err "授权完成后重新运行本脚本即可。"
  exit 1
fi
log "Cloudflare 凭证已就位: $CERT"

# === 第 3 步：创建隧道（已存在则跳过）===================================
if cloudflared tunnel list -o json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if any(t['name']=='$TUNNEL_NAME' for t in d) else 1)" 2>/dev/null; then
  log "隧道 $TUNNEL_NAME 已存在，跳过创建"
else
  log "创建隧道 $TUNNEL_NAME ..."
  cloudflared tunnel create "$TUNNEL_NAME"
fi

# 取凭证文件路径（隧道对应的 json）
# cloudflared 不同版本/跨机器创建的隧道可能不输出 credentials_file 字段，此时按 tunnel-id 推导
CRED_FILE="$(cloudflared tunnel list -o json 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
t = next((x for x in d if x.get('name') == '$TUNNEL_NAME'), None)
if not t:
    sys.exit(1)
if 'credentials_file' in t and t['credentials_file']:
    print(t['credentials_file'])
else:
    print(f'$HOME/.cloudflared/{t[\"id\"]}.json')
")"
if [ -z "$CRED_FILE" ] || [ ! -f "$CRED_FILE" ]; then
  err "无法定位隧道 $TUNNEL_NAME 的凭证文件 ($CRED_FILE)。"
  err "请检查："
  err "  1) 该隧道是否是用本机 cert.pem 创建的；"
  err "  2) ~/.cloudflared/ 下是否存在 <隧道ID>.json 文件；"
  err "  3) 若凭证在本机，请将本机 ~/.cloudflared/ 下的 .json 凭证文件上传到服务器对应位置。"
  exit 1
fi
log "凭证文件: $CRED_FILE"

# === 第 4 步：DNS 路由（已存在会报错，忽略）=============================
log "绑定域名 $DOMAIN -> 隧道 ..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" 2>/dev/null || warn "DNS 路由可能已存在（可忽略）"

# === 第 5 步：写 cloudflared 配置 ========================================
mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/config.yml" <<EOF
tunnel: $TUNNEL_NAME
credentials-file: $CRED_FILE
ingress:
  - hostname: $DOMAIN
    service: http://localhost:3000
  - service: http_status:404
EOF
chmod 600 "$HOME/.cloudflared/config.yml"
log "校验配置 ..."
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" ingress validate

# === 第 6 步：cloudflared 开机自启（systemd）============================
log "写 systemd 服务并启停 ..."
sudo tee /etc/systemd/system/cloudflared.service >/dev/null <<EOF
[Unit]
Description=Cloudflare Tunnel ($TUNNEL_NAME)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
ExecStart=$CF_BIN tunnel run $TUNNEL_NAME
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared
systemctl status cloudflared --no-pager | head -3 || true

# === 第 7 步：等待隧道真正连通 ===========================================
log "等待隧道连通 $DOMAIN ..."
OK=0
for i in $(seq 1 10); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/ml/oauth/ping" 2>/dev/null | grep -q '"ok":true'; then
    log "隧道已通 ✅ (第 $i 次)"; OK=1; break
  fi
  warn "  等待中 ($i/10) ..."; sleep 3
done
[ "$OK" = 1 ] || warn "隧道暂未连通，请稍后手动 curl 验证；若长期不通，检查 config.yml 与 journalctl -u cloudflared"

# === 第 8 步：写死 ML_REDIRECT_URI 到 .env ==============================
if [ -f "$APP_DIR/.env" ]; then
  if grep -q '^ML_REDIRECT_URI=' "$APP_DIR/.env"; then
    sed -i "s#^ML_REDIRECT_URI=.*#ML_REDIRECT_URI=https://$DOMAIN/api/ml/oauth/store-callback#" "$APP_DIR/.env"
  else
    echo "ML_REDIRECT_URI=https://$DOMAIN/api/ml/oauth/store-callback" >> "$APP_DIR/.env"
  fi
  log ".env 已设置 ML_REDIRECT_URI=https://$DOMAIN/api/ml/oauth/store-callback"
else
  warn "未找到 $APP_DIR/.env，跳过 ML_REDIRECT_URI 写入（请确认项目已部署）"
fi

# === 第 9 步：等待脚本 + PM2 启动顺序固化 ===============================
WAIT_SCRIPT="$APP_DIR/wait-tunnel-and-start.sh"
log "生成等待脚本 $WAIT_SCRIPT ..."
cat > "$WAIT_SCRIPT" <<'WAITEOF'
#!/usr/bin/env bash
# 等 cloudflared 隧道进程就绪后，再启动后端。
# 说明：后端用 mode=env 取决于 .env 里的 ML_REDIRECT_URI，与隧道是否可达无关；
#       只要 cloudflared 进程在跑，隧道就会把公网请求转发到 localhost:3000。
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

# 先清掉任何仍占用 3000 的残留后端进程，避免 EADDRINUSE 死循环
if command -v fuser >/dev/null 2>&1; then
  fuser -k 3000/tcp 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  lsof -ti :3000 2>/dev/null | xargs -r kill -9 2>/dev/null || true
fi
sleep 1

# 等待 cloudflared 隧道进程就绪（最多 30 次，每次 2 秒）
for i in $(seq 1 30); do
  if pgrep -x cloudflared >/dev/null 2>&1 || systemctl is-active --quiet cloudflared 2>/dev/null; then
    echo "[wait-tunnel] 隧道进程就绪 ($i)"; break
  fi
  echo "[wait-tunnel] 等待隧道进程... ($i/30)"; sleep 2
done

echo "[wait-tunnel] 启动后端"
exec npx tsx server/index.ts
WAITEOF
chmod +x "$WAIT_SCRIPT"

# 9.1 确保 PM2 开机服务存在（没有就自动创建）
PM2_SVC="$(systemctl list-unit-files 2>/dev/null | awk '$1 ~ /^pm2/ {print $1; exit}')"
if [ -z "$PM2_SVC" ] || [ ! -f "/etc/systemd/system/$PM2_SVC" ]; then
  log "未找到 PM2 systemd 服务，自动执行 pm2 startup ..."
  # pm2 startup 只是打印真正要执行的命令，下面把它揪出来执行
  STARTUP_CMD="$(pm2 startup systemd -u "$USER" --hp "$HOME" 2>&1 | grep -E '^sudo env PATH=' || true)"
  if [ -n "$STARTUP_CMD" ]; then
    eval "$STARTUP_CMD"
    log "PM2 开机服务已创建"
  else
    warn "自动创建 PM2 开机服务失败；项目仍可运行，但重启后不会自动启动"
  fi
  PM2_SVC="$(systemctl list-unit-files 2>/dev/null | awk '$1 ~ /^pm2/ {print $1; exit}')"
fi

if [ -n "$PM2_SVC" ] && [ -f "/etc/systemd/system/$PM2_SVC" ]; then
  if ! grep -q 'After=.*cloudflared.service' "/etc/systemd/system/$PM2_SVC"; then
    sed -i '/^After=/ s/$/ cloudflared.service/' "/etc/systemd/system/$PM2_SVC"
    sed -i '/^Wants=/ s/$/ cloudflared.service/' "/etc/systemd/system/$PM2_SVC"
    sudo systemctl daemon-reload
    log "已把 $PM2_SVC 设为 cloudflared 之后启动"
  else
    log "PM2 启动顺序已配置，跳过"
  fi
fi

# 9.3 用等待脚本重启项目
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR"
  # 如果 node_modules 不存在，先兜底装依赖（基础部署没跑时会用到）
  if [ ! -d "node_modules" ]; then
    warn "未找到 node_modules，先执行 npm install ..."
    npm install --production=false
  fi
  pm2 delete "$PM2_NAME" 2>/dev/null || true
  # 兜底：清掉任何仍在跑的旧 server 进程，避免端口冲突
  pm2 list 2>/dev/null | grep -E "index.ts|wait-tunnel" | awk '{print $2}' | while read n; do pm2 delete "$n" 2>/dev/null || true; done
  pm2 start ./wait-tunnel-and-start.sh --name "$PM2_NAME"
  sleep 3
  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
    pm2 save
    log "项目已用等待脚本启动 ($PM2_NAME)"
    pm2 status
  else
    err "项目启动失败，最近 30 行日志："
    pm2 logs "$PM2_NAME" --lines 30 --nostream 2>&1 || true
    exit 1
  fi
else
  warn "未找到 $APP_DIR，跳过项目重启"
fi

# === 收尾提示 ============================================================
echo ""
echo "============================================================"
log "脚本执行完毕 ✅"
echo "下一步（需手动，浏览器操作）："
echo "  1) 去 Mercado Libre 开发者后台 -> 应用 -> Redirect URIs 添加："
echo "       https://$DOMAIN/api/ml/oauth/store-callback"
echo "  2) 验证公网域名："
echo "       curl -s https://$DOMAIN/api/ml/oauth/ping"
echo "  3) 验证后端用的回调地址："
echo "       curl -s http://localhost:3000/api/ml/oauth/tunnel | python3 -c \"import sys,json;print(json.load(sys.stdin)['redirectUri'])\""
echo "  4) （可选）sudo reboot 实测开机自启"
echo "============================================================"
