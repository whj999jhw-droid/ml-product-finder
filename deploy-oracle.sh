#!/bin/bash
# ==============================================================
# ML Product Finder — Oracle Cloud 一键部署脚本
# 用法：
#   chmod +x deploy-oracle.sh
#   ./deploy-oracle.sh
#
# 前置条件：
#   1. Oracle Cloud ARM VM（Ubuntu 22.04/24.04），已开放 22/80/443 端口
#   2. 代码已推到 GitHub（私有仓库）
# ==============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ML Product Finder — Oracle Cloud 一键部署   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ---- 1. 收集配置 ----
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 步骤 1/6: 配置参数"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# GitHub 仓库地址
read -p "  GitHub 仓库地址 (https://github.com/...): " GIT_REPO
if [ -z "$GIT_REPO" ]; then
  err "必须提供 GitHub 仓库地址"
fi

# ML 凭证
echo ""
info "Mercado Libre 应用凭证（必填）"
read -p "  ML_APP_ID: " ML_APP_ID
read -p "  ML_SECRET_KEY: " ML_SECRET_KEY

if [ -z "$ML_APP_ID" ] || [ -z "$ML_SECRET_KEY" ]; then
  err "ML_APP_ID 和 ML_SECRET_KEY 必须填写"
fi

# 域名（可选）
echo ""
read -p "  域名（可选，留空则只用 IP 访问）: " DOMAIN

# 项目目录
APP_DIR="$HOME/ml-product-finder"

echo ""
echo "  配置摘要："
echo "    仓库: $GIT_REPO"
echo "    目录: $APP_DIR"
echo "    ML App ID: ${ML_APP_ID:0:8}..."
echo "    域名: ${DOMAIN:-无（IP 直连）}"
echo ""

read -p "  确认开始部署？(y/N) " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "  已取消"
  exit 0
fi

# ---- 2. 安装系统依赖 ----
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 步骤 2/6: 安装系统依赖 (Node.js, Nginx, Git)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

log "更新系统包..."
sudo apt update -qq && sudo apt upgrade -y -qq

# Node.js 22
if ! command -v node &> /dev/null; then
  log "安装 Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
else
  log "Node.js 已安装: $(node --version)"
fi

# Nginx
if ! command -v nginx &> /dev/null; then
  log "安装 Nginx..."
  sudo apt install -y nginx
else
  log "Nginx 已安装"
fi

# Git
if ! command -v git &> /dev/null; then
  log "安装 Git..."
  sudo apt install -y git
fi

# Certbot
if ! command -v certbot &> /dev/null; then
  log "安装 Certbot..."
  sudo apt install -y certbot python3-certbot-nginx
fi

# PM2
if ! command -v pm2 &> /dev/null; then
  log "安装 PM2..."
  sudo npm install -g pm2
else
  log "PM2 已安装: $(pm2 --version)"
fi

# ---- 3. 克隆 & 构建 ----
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 步骤 3/6: 克隆代码 & 构建"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -d "$APP_DIR" ]; then
  warn "目录 $APP_DIR 已存在，正在删除..."
  pm2 stop ml-finder 2>/dev/null || true
  pm2 delete ml-finder 2>/dev/null || true
  rm -rf "$APP_DIR"
fi

log "克隆仓库..."
git clone "$GIT_REPO" "$APP_DIR"
cd "$APP_DIR"

log "安装依赖 (npm install)..."
npm install --production=false

log "构建前端 (vite build)..."
npm run build

log "构建后端 (esbuild)..."
node build-server.mjs

log "创建数据目录..."
mkdir -p data data/exports

# ---- 4. 环境变量 ----
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 步骤 4/6: 配置环境变量"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

cat > .env << ENVEOF
NODE_ENV=production
PORT=3000
ML_APP_ID=${ML_APP_ID}
ML_SECRET_KEY=${ML_SECRET_KEY}
SESSION_SECRET=${SESSION_SECRET}
CODEBUDDY_INTERNET_ENVIRONMENT=external
ENVEOF

log ".env 已创建"

# ---- 5. Nginx 配置 ----
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

# SSL（有域名时）
if [ -n "$DOMAIN" ]; then
  echo ""
  info "尝试获取 SSL 证书（Let's Encrypt）..."
  if sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@${DOMAIN}" --redirect 2>/dev/null; then
    log "SSL 证书已配置"
  else
    warn "SSL 证书获取失败，将使用 HTTP（可以稍后手动执行: sudo certbot --nginx -d ${DOMAIN}）"
  fi
fi

# ---- 6. 启动应用 ----
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 步骤 6/6: 启动应用"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

pm2 start dist-server/index.mjs \
  --name ml-finder \
  --time \
  --env .env

pm2 startup systemd -u "$USER" --hp "$HOME"
pm2 save

log "应用已启动"

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
echo "║    pm2 status        查看状态                  ║"
echo "║    pm2 logs ml-finder 查看日志                  ║"
echo "║    pm2 restart ml-finder 重启                  ║"
echo "║    pm2 stop ml-finder   停止                  ║"
echo "║                                              ║"
echo "║  如需重新部署（更新代码）:                     ║"
echo "║    cd ~/ml-product-finder                    ║"
echo "║    git pull                                  ║"
echo "║    npm install                               ║"
echo "║    npm run build && node build-server.mjs    ║"
echo "║    pm2 restart ml-finder                     ║"
echo "║                                              ║"
echo "╚══════════════════════════════════════════════╝"
