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
