#!/bin/bash
# ==============================================================
# ML Product Finder — 从本机直传 Oracle VM 部署脚本
# 用法（在 Oracle VM 上执行）：
#   1. 在本机打包: tar -czf ml-finder.tar.gz --exclude=node_modules ...
#   2. scp ml-finder.tar.gz deploy-upload.sh ubuntu@<VM_IP>:~/
#   3. SSH 到 VM: chmod +x deploy-upload.sh && ./deploy-upload.sh
# ==============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[✓]${NC} $1"; }

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ML Product Finder — 本机上传部署             ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 检查 tar.gz 文件
TARBALL=$(ls -t ~/ml-finder.tar.gz 2>/dev/null | head -1)
if [ -z "$TARBALL" ]; then
  echo "错误: 未找到 ~/ml-finder.tar.gz，请先从本机上传"
  exit 1
fi

echo "找到: $TARBALL ($(du -h "$TARBALL" | cut -f1))"

# 收集配置
echo ""
read -p "  ML_APP_ID: " ML_APP_ID
read -p "  ML_SECRET_KEY: " ML_SECRET_KEY
read -p "  域名（可选，留空用 IP）: " DOMAIN

APP_DIR="$HOME/ml-product-finder"

# 安装依赖
log "更新系统..."
sudo apt update -qq && sudo apt upgrade -y -qq

log "安装 Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx git certbot python3-certbot-nginx

log "安装 PM2..."
sudo npm install -g pm2

# 解压 & 构建
log "解压项目..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
tar -xzf "$TARBALL" -C "$APP_DIR" --strip-components=1
cd "$APP_DIR"

log "安装依赖..."
npm install

log "构建前端..."
npm run build

log "构建后端..."
node build-server.mjs

mkdir -p data data/exports

# 环境变量
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

# Nginx
sudo tee /etc/nginx/sites-available/ml-finder > /dev/null << NGINXEOF
server {
    listen 80;
    server_name ${DOMAIN:-_};
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
}
NGINXEOF

sudo ln -sf /etc/nginx/sites-available/ml-finder /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
log "Nginx 已配置"

# SSL
if [ -n "$DOMAIN" ]; then
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@${DOMAIN}" --redirect 2>/dev/null && \
    log "SSL 已配置" || echo "[!] SSL 失败，跳过"
fi

# 启动
pm2 start dist-server/index.mjs --name ml-finder --time
pm2 startup systemd -u "$USER" --hp "$HOME"
pm2 save

PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "未知")
echo ""
echo "╔══════════════════════════════════════╗"
echo "║  ✅ 部署完成                         ║"
echo "╠══════════════════════════════════════╣"
echo "║  地址: http://${PUBLIC_IP}            ║"
[ -n "$DOMAIN" ] && echo "║  HTTPS: https://${DOMAIN}               ║"
echo "╚══════════════════════════════════════╝"
