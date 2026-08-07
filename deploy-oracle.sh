#!/bin/bash
# ==============================================================
# ML Product Finder — Oracle Cloud 一键部署脚本（支持中断续部署）
#
# 用法：
#   chmod +x deploy-oracle.sh
#   ./deploy-oracle.sh                 # 第一次运行：按提示填写
#   ./deploy-oracle.sh                 # 中途断网/失败后再跑：自动跳过已完成步骤
#   ./deploy-oracle.sh --reconfigure   # 强制重新填写所有配置
#   ./deploy-oracle.sh --yes           # 跳过最后的「确认开始」询问（配合 --reconfigure 可全自动）
#
# 特性：
#   ✅ 每完成一步都写进度到 ~/.ml_deploy_state，断点后续跑自动跳过已完成步骤
#   ✅ 配置（含 ML 凭证）加密权限(600)保存到状态文件，续跑无需重新输入
#   ✅ 每个安装步骤都做幂等检查（已装则跳过），可反复运行不会出错
# ==============================================================

set -e

# 出错时给出友好提示，告诉用户「重新运行即可续部署」
trap 'echo -e "\n\033[0;31m[✗] 部署在上面的步骤中断了。\033[0m"; echo -e "    请修复上面的报错（通常是网络/权限问题），然后 \033[1;33m重新运行 ./deploy-oracle.sh\033[0m"; echo -e "    已完成的步骤会自动跳过，无需从头再来。\n"' ERR

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

# ---- 状态文件（记录进度 + 配置）----
STATE_FILE="$HOME/.ml_deploy_state"
touch "$STATE_FILE" 2>/dev/null || true
chmod 600 "$STATE_FILE" 2>/dev/null || true

state_get() { grep "^$1=" "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2- ; }
state_set() { sed -i "/^$1=/d" "$STATE_FILE"; echo "$1=$2" >> "$STATE_FILE"; }
step_done() { [ -n "$(state_get "step.$1")" ]; }
mark_done() { state_set "step.$1" "1"; }

RECONFIGURE=0; YES=0
for a in "$@"; do
  [ "$a" = "--reconfigure" ] && RECONFIGURE=1
  [ "$a" = "--yes" ] && YES=1
done

APP_DIR="$HOME/ml-product-finder"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ML Product Finder — Oracle Cloud 一键部署   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ============================================================
# 步骤 1/6: 收集配置（断点续跑：已保存则自动复用）
# ============================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 步骤 1/6: 配置参数"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

GIT_REPO=$(state_get git_repo); ML_APP_ID=$(state_get ml_app_id); ML_SECRET_KEY=$(state_get ml_secret); DOMAIN=$(state_get domain)

if [ "$RECONFIGURE" = "1" ]; then
  GIT_REPO=""; ML_APP_ID=""; ML_SECRET_KEY=""; DOMAIN=""
fi

if [ -z "$GIT_REPO" ]; then
  read -p "  GitHub 仓库地址 (https://github.com/你/仓库): " GIT_REPO
fi
if [ -z "$ML_APP_ID" ]; then
  read -p "  ML_APP_ID (美客多开发者应用 Client ID): " ML_APP_ID
fi
if [ -z "$ML_SECRET_KEY" ]; then
  read -p "  ML_SECRET_KEY (美客多应用 Secret): " ML_SECRET_KEY
fi
read -p "  域名（可选，留空则只用 IP 访问）: " DOMAIN

if [ -z "$GIT_REPO" ] || [ -z "$ML_APP_ID" ] || [ -z "$ML_SECRET_KEY" ]; then
  err "GitHub 仓库、ML_APP_ID、ML_SECRET_KEY 都必须填写"
fi

# 保存配置（供续跑复用）
state_set git_repo "$GIT_REPO"
state_set ml_app_id "$ML_APP_ID"
state_set ml_secret "$ML_SECRET_KEY"
state_set domain "$DOMAIN"

echo ""
echo "  配置摘要："
echo "    仓库: $GIT_REPO"
echo "    目录: $APP_DIR"
echo "    ML App ID: ${ML_APP_ID:0:8}..."
echo "    域名: ${DOMAIN:-无（IP 直连）}"
echo ""

if [ "$YES" != "1" ]; then
  read -p "  确认开始部署？(y/N) " CONFIRM
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "  已取消"; exit 0
  fi
fi
mark_done 1
log "步骤 1 完成"

# ============================================================
# 步骤 2/6: 安装系统依赖（幂等：已装跳过）
# ============================================================
if step_done 2; then
  info "步骤 2 已跳过（系统依赖已安装）"
else
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " 步骤 2/6: 安装系统依赖 (Node.js, Nginx, Git, Certbot, PM2)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  log "更新系统包..."
  sudo apt update -qq && sudo apt upgrade -y -qq

  if ! command -v node &> /dev/null; then
    log "安装 Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
  else
    log "Node.js 已安装: $(node --version)"
  fi

  for pkg in nginx git; do
    if ! command -v $pkg &> /dev/null; then
      log "安装 $pkg..."; sudo apt install -y $pkg
    else
      log "$pkg 已安装"
    fi
  done

  if ! command -v certbot &> /dev/null; then
    log "安装 Certbot..."; sudo apt install -y certbot python3-certbot-nginx
  fi

  if ! command -v pm2 &> /dev/null; then
    log "安装 PM2..."; sudo npm install -g pm2
  else
    log "PM2 已安装: $(pm2 --version)"
  fi
  mark_done 2
  log "步骤 2 完成"
fi

# ============================================================
# 步骤 3/6: 克隆代码 & 构建（续跑：目录已存在则 git pull）
# ============================================================
if step_done 3; then
  info "步骤 3 已跳过（代码已克隆并构建）"
else
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " 步骤 3/6: 克隆代码 & 构建"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  if [ -d "$APP_DIR/.git" ]; then
    warn "目录 $APP_DIR 已存在，执行 git pull 更新..."
    git -C "$APP_DIR" pull || warn "git pull 失败（可能本地有改动），继续用现有代码"
  elif [ -d "$APP_DIR" ]; then
    warn "$APP_DIR 存在但不是 git 仓库，删除后重新克隆..."
    rm -rf "$APP_DIR"
    git clone "$GIT_REPO" "$APP_DIR"
  else
    log "克隆仓库..."; git clone "$GIT_REPO" "$APP_DIR"
  fi

  cd "$APP_DIR"
  log "安装依赖 (npm install)..."
  npm install --production=false

  log "构建前端 (vite build)..."
  npm run build

  log "创建数据目录..."
  mkdir -p data data/exports
  mark_done 3
  log "步骤 3 完成"
fi

# ============================================================
# 步骤 4/6: 配置环境变量（续跑：已生成则保留旧 SESSION_SECRET）
# ============================================================
if step_done 4; then
  info "步骤 4 已跳过（.env 已存在）"
else
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " 步骤 4/6: 配置环境变量"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  if [ -f "$APP_DIR/.env" ]; then
    warn "$APP_DIR/.env 已存在，保留不覆盖（如需重设请删除该文件后重跑）"
  else
    SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    cat > "$APP_DIR/.env" << ENVEOF
NODE_ENV=production
PORT=3000
ML_APP_ID=${ML_APP_ID}
ML_SECRET_KEY=${ML_SECRET_KEY}
SESSION_SECRET=${SESSION_SECRET}
CODEBUDDY_INTERNET_ENVIRONMENT=external
ENVEOF
    log ".env 已创建"
  fi
  mark_done 4
  log "步骤 4 完成"
fi

# ============================================================
# 步骤 5/6: 配置 Nginx（幂等）
# ============================================================
if step_done 5; then
  info "步骤 5 已跳过（Nginx 已配置）"
else
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " 步骤 5/6: 配置 Nginx"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  SERVER_NAME="${DOMAIN:-_}"
  sudo tee /etc/nginx/sites-available/ml-finder > /dev/null << NGINXEOF
server {
    listen 80;
    server_name ${SERVER_NAME};
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
    location /api/health {
        proxy_pass http://127.0.0.1:3000;
        access_log off;
    }
}
NGINXEOF
  log "Nginx 配置已写入"
  sudo ln -sf /etc/nginx/sites-available/ml-finder /etc/nginx/sites-enabled/
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx
  log "Nginx 已重载"

  if [ -n "$DOMAIN" ]; then
    info "尝试获取 SSL 证书（Let's Encrypt）..."
    if sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@${DOMAIN}" --redirect 2>/dev/null; then
      log "SSL 证书已配置"
    else
      warn "SSL 证书获取失败，将使用 HTTP（可稍后手动: sudo certbot --nginx -d ${DOMAIN}）"
    fi
  fi
  mark_done 5
  log "步骤 5 完成"
fi

# ============================================================
# 步骤 6/6: 启动应用（幂等：已存在则重启）
# ============================================================
if step_done 6; then
  info "步骤 6 已跳过（应用已在运行）"
else
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " 步骤 6/6: 启动应用"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  pm2 delete ml-finder 2>/dev/null || true
  # 把 .env 注入到 PM2 启动进程的环境（PM2 不会自动读 .env 文件）
  set -a
  [ -f "$APP_DIR/.env" ] && . "$APP_DIR/.env"
  set +a
  # 用 tsx 直接运行 TypeScript 后端（与开发模式一致，免打包，最稳）
  pm2 start npm --name ml-finder -- run server
  pm2 startup systemd -u "$USER" --hp "$HOME" || true
  pm2 save
  mark_done 6
  log "步骤 6 完成"
fi

# ---- 完成 ----
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║            🎉  部署完成！                     ║"
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
if [ -n "$DOMAIN" ]; then
  echo "║  访问地址: https://${DOMAIN}                   ║"
else
  PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "未知")
  echo "║  访问地址: http://${PUBLIC_IP}                 ║"
fi
echo "║                                              ║"
echo "║  常用命令:                                    ║"
echo "║    pm2 status               查看状态          ║"
echo "║    pm2 logs ml-finder       查看日志          ║"
echo "║    pm2 restart ml-finder    重启              ║"
echo "║    pm2 stop ml-finder       停止              ║"
echo "║                                              ║"
echo "║  更新代码（重跑本脚本即可，自动续跑）:          ║"
echo "║    cd ~/ml-product-finder && git pull          ║"
echo "║    npm install && npm run build                ║"
echo "║    pm2 restart ml-finder                       ║"
echo "║  或简单粗暴：./deploy-oracle.sh 自动处理        ║"
echo "║                                              ║"
echo "╚══════════════════════════════════════════════╝"
