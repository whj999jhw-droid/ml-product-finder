# ML Product Finder — Oracle Cloud 部署指南

## 一、Oracle Cloud 免费套餐

| 资源 | 免费配额 |
|---|---|
| ARM Ampere VM | 最多 4 OCPU、24 GB 内存（推荐） |
| AMD VM | 2 台（各 1 OCPU、1 GB） |
| 块存储 | 200 GB |
| 出站流量 | 10 TB/月 |
| 公网 IPv4 | 1 个预留 IP |

推荐创建 ARM 实例（4 OCPU + 24 GB），完全免费。

## 二、创建 VM 实例

1. 注册 [Oracle Cloud](https://www.oracle.com/cloud/free/)，需信用卡验证（不扣费）
2. **Compute → Instances → Create instance**
3. 关键配置：
   - **Image**: Ubuntu 22.04 或 24.04
   - **Shape**: `VM.Standard.A1.Flex`（ARM），4 OCPU / 24 GB
   - **SSH key**: 上传公钥（`~/.ssh/id_rsa.pub`）或自动生成
   - **Boot volume**: 50-100 GB
4. 点击 Create

## 三、网络配置

**OCI Security List（实例详情 → Subnet → Security Lists → Add Ingress Rules）**：

| 源 CIDR | 协议 | 端口 | 用途 |
|---|---|---|---|
| 0.0.0.0/0 | TCP | 22 | SSH |
| 0.0.0.0/0 | TCP | 80 | HTTP |
| 0.0.0.0/0 | TCP | 443 | HTTPS |
| 0.0.0.0/0 | TCP | 3000 | 临时测试 |

**VM 内部防火墙**：
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp
sudo ufw enable
```

## 四、安装基础环境

```bash
ssh ubuntu@<VM_IP>

sudo apt update && sudo apt upgrade -y

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx certbot python3-certbot-nginx

node --version   # v22.x
```

## 五、部署项目

```bash
cd ~
git clone <仓库地址> ml-product-finder
cd ml-product-finder
npm install
npm run build          # vite build → dist/
npm run build:server   # esbuild → dist-server/index.mjs
mkdir -p data data/exports
```

## 六、环境变量（.env）

```bash
NODE_ENV=production
PORT=3000
ML_APP_ID=你的值
ML_SECRET_KEY=你的值
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
CODEBUDDY_API_KEY=你的值（可选）
CODEBUDDY_INTERNET_ENVIRONMENT=external
```

## 七、PM2 守护进程

```bash
sudo npm install -g pm2
cd ~/ml-product-finder
pm2 start dist-server/index.mjs --name ml-finder --time
pm2 startup systemd   # 执行输出中的 sudo 命令
pm2 save

pm2 status            # 查看状态
pm2 logs ml-finder    # 日志
pm2 restart ml-finder # 重启
```

## 八、Nginx 反向代理 + SSL

```nginx
# /etc/nginx/sites-available/ml-finder
server {
    listen 80;
    server_name <域名或IP>;
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /api/health {
        proxy_pass http://127.0.0.1:3000;
        access_log off;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ml-finder /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# SSL（有域名时）
sudo certbot --nginx -d 你的域名.com
```

## 九、验证

```bash
curl http://localhost:3000/api/health   # {"status":"ok",...}
pm2 status
```

浏览器访问 `http://<VM_公网IP>`。

## 十、定时抓取

项目内置定时调度器（前端「定时自动抓取」卡片配置）。
或外部 cron 触发：

```bash
crontab -e
# 每天 0:00 UTC（北京时间 8:00）触发
0 0 * * * curl -X POST http://localhost:3000/api/ml/trigger
```

## 备选：从本机直接上传（不经过 GitHub）

```powershell
# 本机打包（排除 node_modules 和构建产物）
cd c:\Users\whj87\WorkBuddy\20260720124310\ml-product-finder
tar -czf ../ml-finder.tar.gz --exclude=node_modules --exclude=release --exclude=release-out --exclude=.git .

# 上传到 VM
scp ../ml-finder.tar.gz ubuntu@<VM_IP>:~/
```

VM 端：
```bash
tar -xzf ~/ml-finder.tar.gz -C ~/ml-product-finder
# 后续同第五章
```

## 故障排查

| 问题 | 排查 |
|---|---|
| 页面打不开 | `sudo ufw status`；检查 OCI Security List |
| 0 条数据 | 检查 `ML_APP_ID`/`ML_SECRET_KEY`；`pm2 logs` |
| 403/blocked | Oracle 数据中心 IP 可能被 ML 封锁，需配住宅代理 |
| PM2 启动失败 | `node dist-server/index.mjs` 直接运行看报错 |
| Nginx 502 | `curl localhost:3000/api/health` |
