# Oracle 服务器 cloudflared 固定域名隧道 + 开机自启 保姆级教程

> 目标读者：**完全不懂 Linux、不懂服务器的小白**。你只要会**复制粘贴命令**，照着一步一步做就行。
>
> 配套上一篇：[DEPLOY-ORACLE.md](./DEPLOY-ORACLE.md)（服务器基础部署，用 PM2 把项目跑起来）。本教程假设你已经按上一篇部署好，`pm2 status` 能看到 `ml-finder` 是 **online**。
>
> 做完你会得到：
> - 服务器上的项目通过**固定 HTTPS 域名**暴露公网（不再依赖随机地址）
> - `cloudflared` 和项目都**开机自启**，重启服务器不用手动操作
> - 严格保证启动顺序：**先启动 cloudflared，再启动本项目**

---

## 〇、先搞懂 3 件事（不亏，2 分钟）

### 1. 为什么服务器要 cloudflared？
上一篇部署完后，网站其实已经能用 `http://服务器IP` 访问了。但有两个不舒服的点：

| 问题 | 原因 |
|---|---|
| 美客多 OAuth 回调需要固定地址 | 美客多不允许 localhost，且回调地址要提前在开发者后台填好；IP 直连虽然能填，但回调用 HTTPS 更稳、更不容易被拒 |
| IP 直连不够稳 | Oracle 服务器 IP 属于数据中心 IP，被美客多/风控盯上的概率比家庭宽带高；走 Cloudflare 隧道后，请求从 Cloudflare 的 IP 进来，稳定性好很多 |

所以服务器上开一条 cloudflared 隧道，把服务器的 `3000` 端口暴露成一个固定的 `https://你的子域名`。

### 2. 为什么必须「先启动 cloudflared，再启动本项目」？（本教程最重要的知识点）
项目后端有个「智能选择回调地址」逻辑，启动流程是这样的：

```
后端启动 → 探测固定域名 https://你的子域名/api/ml/oauth/ping 是否通
         ├─ 通   → 用固定域名（一切正常 ✅）
         └─ 不通 → 自动回退 localtunnel 临时地址（域名是随机的一段字符 ❌）
```

也就是说：**如果 cloudflared 还没起来，后端一启动就会误判「固定域名不可用」，自动切到临时地址**。临时地址每次重启都会变，美客多后台填的回调地址就对不上，店铺授权就会失效。

所以顺序必须是：
1. 先启动 cloudflared（隧道通）
2. 再启动本项目（后端探测到固定域名通，就用固定域名）

本教程第 9 步专门教你怎么把这条顺序**固化到开机自启里**，服务器重启 100 次都不会乱。

### 3. 两种隧道，先选一个
| | 方式 A：命名隧道（推荐） | 方式 B：快速隧道 |
|---|---|---|
| 需要 | 一个**已托管在 Cloudflare 的域名**（你本机用的 `w999w.dpdns.org` 就是；没有的话教程最后有提示怎么便宜搞一个） | 什么都不需要 |
| 域名固定吗 | ✅ 固定，永久不变 | ❌ 每次重启随机变 |
| 适合 | **长期用、要配 OAuth 回调** | 临时测试、看看效果 |
| 命令复杂度 | 6 步 | 1 行 |

> ⚠️ **本文以方式 A 为主**（因为 OAuth 回调必须固定地址）。方式 B 在第 11 节附赠。
>
> 💡 你本机已经有一条 cloudflared 隧道（`ml-product-finder` → `ml-callback.w999w.dpdns.org`）。本教程在服务器上**新建一条独立隧道、用独立的子域名**（如 `ml-callback-server.w999w.dpdns.org`），这样**服务器和本机互不干扰、可以同时在线**。如果你打算彻底把项目搬到服务器、不再用本机，也可以直接复用本机的隧道名和域名（区别在第 3 步备注里讲）。

---

## 第 1 步：安装 cloudflared

连上服务器（不会连的看上一篇第 5 步），然后**一条一条**复制粘贴：

```bash
# 1. 添加 Cloudflare 官方软件源
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list

# 2. 刷新并安装
sudo apt update -qq
sudo apt install -y cloudflared

# 3. 验证装好了没（能打印出版本号就成功）
cloudflared --version
```

看到类似 `cloudflared version 202x.x.x` 就 OK，继续。

---

## 第 2 步：登录你的 Cloudflare 账号（获取隧道凭证）

```bash
cloudflared tunnel login
```

运行后会打印一个 **http://... 的授权链接**。别关终端，把那个链接复制到**你自己电脑的浏览器**打开：

1. 浏览器里会跳转到 Cloudflare 登录页，登录你那个**托管着 `w999w.dpdns.org` 的账号**（本机隧道用的那个）。
2. 登录后 Cloudflare 会列出你账号下的所有域名，**选中 `w999w.dpdns.org`**（或你自己的域名）。
3. 点 **Authorize（授权）**。
4. 授权成功会提示「You have successfully authenticated cloudflared」，回到终端，自动生成了凭证文件 `~/.cloudflared/cert.pem`。

验证凭证是否就位：

```bash
ls -la ~/.cloudflared/
# 应该能看到 cert.pem（大小几百字节）
```

---

## 第 3 步：创建命名隧道

```bash
cloudflared tunnel create ml-finder-server
```

会输出类似这样的成功信息：

```
Created tunnel ml-finder-server with id 60345d34-xxxx-xxxx-xxxx-xxxxxxxxxxxx
Created credentials file at /home/ubuntu/.cloudflared/60345d34-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json
```

**把那串隧道 ID 复制记下来**，后面第 4、5 步要用。再用 `list` 确认一下：

```bash
cloudflared tunnel list
# 应该能看到 NAME=ml-finder-server 那行，CREDENTIALS 显示文件已生成
```

> **备选：想直接复用本机那套隧道/域名？**
> 如果你决定**不再用本机跑项目**，可以在服务器上直接复用本机的隧道凭证：把本机 `C:\Users\whj87\.cloudflared\` 里的 `*.json`（隧道 ID 文件）和 `cert.pem` 传到服务器的 `~/.cloudflared/`，然后 `cloudflared tunnel run ml-product-finder` 就能用。⚠️ 注意：**同一个隧道不要同时在本机和服务器跑**，否则 Cloudflare 会把请求随机分到两台机器，表现就是「时而通时而 530」。教程推荐在服务器建独立隧道 + 独立子域名，最省心。

---

## 第 4 步：把子域名「绑」到隧道上（DNS 路由）

```bash
cloudflared tunnel route dns ml-finder-server ml-callback-server.w999w.dpdns.org
```

> 如果你用的是自己的域名（比如 `example.com`），把最后那个子域名换成你的，例如：`cloudflared tunnel route dns ml-finder-server ml-callback.example.com`

成功会提示已添加 DNS 记录（类似 `added CNAME ml-callback-server → <隧道ID>.cfargotunnel.com`）。这一步是告诉 Cloudflare：**访问 `ml-callback-server.w999w.dpdns.org` 的流量，全部交给隧道 `ml-finder-server`**。

---

## 第 5 步：写 cloudflared 配置文件（告诉隧道把流量转到哪）

```bash
nano ~/.cloudflared/config.yml
```

把下面内容**原样粘贴**进去（把隧道 ID 换成你第 3 步记下来的那串；域名用你自己定的子域名）：

```yaml
# 隧道名（和 cloudflared tunnel create 时一致）
tunnel: ml-finder-server

# 凭证文件路径（第 3 步生成的 json 文件，路径里的 ID 换成你的）
credentials-file: /home/ubuntu/.cloudflared/60345d34-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json

# 公网入口规则：谁来了、转去哪
ingress:
  # 访问这个子域名的流量 → 转到服务器本机的 3000 端口（你项目后端的端口）
  - hostname: ml-callback-server.w999w.dpdns.org
    service: http://localhost:3000

  # 最后一条必须是 404 兜底（不能删，否则配置报错）
  - service: http_status:404
```

按 `Ctrl+O` 回车保存，再按 `Ctrl+X` 退出。

验证配置没写错：

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
# 看到 Validating rules... OK 就说明配置正确
```

> 顺手也把 `config.yml` 权限收紧一下（里面有凭证路径信息，习惯好点）：
> ```bash
> chmod 600 ~/.cloudflared/config.yml
> ```

---

## 第 6 步：让 cloudflared 开机自启（systemd 服务）

这里用**手写 systemd 服务文件**的方式（比官方一键命令更透明、更容易看懂，而且能精确控制启动顺序）。

```bash
sudo nano /etc/systemd/system/cloudflared.service
```

粘贴下面内容（`ExecStart` 里如果 `which cloudflared` 显示的路径不是 `/usr/local/bin/cloudflared`，换成实际路径）：

```ini
[Unit]
# 描述，随便写
Description=Cloudflare Tunnel (ml-finder-server)

# 关键：等网络就绪后再启动（开机时没有网络隧道起不来）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple

# 用 ubuntu 用户跑（这样能读到 /home/ubuntu/.cloudflared 里的凭证）
User=ubuntu
Group=ubuntu

# 启动隧道（名字和第 3 步一致）
ExecStart=/usr/local/bin/cloudflared tunnel run ml-finder-server

# 崩了自动重启（隧道偶发断开会被自动拉起来）
Restart=always
RestartSec=5

# 放宽文件数限制（隧道并发连接多时防止报错）
LimitNOFILE=65536

[Install]
# 开机自启
WantedBy=multi-user.target
```

保存退出，然后：

```bash
# 重新加载服务配置
sudo systemctl daemon-reload

# 开机自启 + 立即启动
sudo systemctl enable --now cloudflared

# 看运行状态（显示 active (running) 就对了）
systemctl status cloudflared --no-pager
```

如果状态不是 `active (running)`，看日志排查：

```bash
journalctl -u cloudflared -n 30 --no-pager
```

---

## 第 7 步：验证固定域名通了（关键检查点）

```bash
curl -s https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/ping
```

**返回这样** = 隧道完美打通（流量从公网域名 → Cloudflare → 隧道 → 服务器 3000 端口 → 后端自检接口）：

```json
{"ok":true,"ts":"..."}
```

如果返回 `{"ok":false}`、`502/530` 页面、或 html 乱码，**先别往下走**，去看第 13 节「常见问题」对应的条目，把这一步弄通再说。

---

## 第 8 步：让项目使用这个固定域名（二选一，推荐方案 A）

### 方案 A（推荐）：直接写死 `ML_REDIRECT_URI`
在项目配置文件 `.env` 里指定固定回调地址，后端**直接用它，连探测都省了**——最稳，根本不存在「探测时隧道还没通」的窗口期。

```bash
cd ~/ml-product-finder
nano .env
```

找到 `ML_REDIRECT_URI=` 开头的那一行，改成：

```
ML_REDIRECT_URI=https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/store-callback
```

> 如果 `.env` 里**没有**这行，就在文件末尾另起一行粘贴上面这行。改完保存（Ctrl+O → 回车 → Ctrl+X）。

**先不要重启项目**——第 9 步会换启动方式，到时候一起生效。

### 方案 B（不写死，靠自动探测）
不设 `ML_REDIRECT_URI`，让后端每次启动时自己探测固定域名、通了就用。这样「先 cloudflared 后项目」的顺序就成了**唯一保障**，所以本教程第 9 步的顺序控制就是为你准备的。

> 已经按方案 A 写了 `.env` 的，方案 B 可以忽略。

---

## 第 9 步：固化启动顺序 —— 先 cloudflared，再本项目（⭐ 本教程核心）

分两层保险：

- **第 1 层**：改 PM2 的开机服务，让它**排在 cloudflared 之后**启动（systemd 依赖）
- **第 2 层**：给项目套一个「等待隧道就绪」启动脚本，**探测到隧道真的通了才真正启动后端**（因为 cloudflared 进程起来了 ≠ 隧道已经连通，中间有几秒建连时间）

两层都做，万无一失。

### 9.1 第 1 层：PM2 服务声明「cloudflared 之后启动」

找到 PM2 生成的开机服务文件（上一篇部署时 `pm2 startup` 自动生成的，服务名一般是 `pm2-ubuntu`）：

```bash
systemctl cat pm2-ubuntu | head -15
# 文件路径一般在 /etc/systemd/system/pm2-ubuntu.service
```

编辑它：

```bash
sudo nano /etc/systemd/system/pm2-ubuntu.service
```

在文件最顶部 `[Unit]` 段里，把下面两行加进去（放在 `After=` / `Wants=` 现有行旁边即可）：

```ini
# 声明：本服务要在 cloudflared 隧道之后启动
After=cloudflared.service
Wants=cloudflared.service
```

改完后类似这样：

```ini
[Unit]
Description=PM2 Process Manager
Documentation=https://pm2.keymetrics.io
After=network.target cloudflared.service
Wants=network.target cloudflared.service
...
```

保存退出，然后：

```bash
sudo systemctl daemon-reload
```

### 9.2 第 2 层：写「等待隧道就绪」启动脚本

```bash
cd ~/ml-product-finder
nano wait-tunnel-and-start.sh
```

粘贴下面内容（把 `DOMAIN_BASE` 换成你自己的固定域名基座，**去掉** `/api/...` 后缀）：

```bash
#!/usr/bin/env bash
# 等待 cloudflared 固定域名隧道就绪后，再启动本项目后端。
# 原因：后端启动时会探测固定域名，探测不到就自动回退临时隧道（回调地址会变）。
# 该脚本确保后端真正启动前，隧道一定已经通。

# 保证在项目目录里执行（这样下面的 .env / npx 都找得到）
cd "$(dirname "$0")"

# 注入 .env 环境变量（PM2 不会自动读 .env，由脚本代劳）
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

# 你的固定域名基座（改成你自己的！）
DOMAIN_BASE="https://ml-callback-server.w999w.dpdns.org"

# 最多等 60 秒（30 次 × 2 秒）
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "$DOMAIN_BASE/api/ml/oauth/ping" 2>/dev/null | grep -q '"ok":true'; then
    echo "[wait-tunnel] ✅ 隧道已就绪（第 ${i} 次探测），启动应用"
    break
  fi
  echo "[wait-tunnel] ⏳ 等待隧道就绪... (${i}/30)"
  sleep 2
done

# 60 秒后还没通：打印提醒，但仍启动（后端会自动回退临时隧道，至少网站能用）
echo "[wait-tunnel] ⚠️ 隧道 60 秒未就绪，照常启动（将回退临时地址，回调需重新配置）"

# 真正启动后端（和部署脚本一样用 tsx 直接跑 TypeScript）
exec npx tsx server/index.ts
```

保存退出，然后：

```bash
chmod +x wait-tunnel-and-start.sh
```

### 9.3 换用新脚本启动项目

```bash
cd ~/ml-product-finder
pm2 delete ml-finder 2>/dev/null || true

# 用等待脚本启动（会自动读 .env，不用再手动注入）
pm2 start ./wait-tunnel-and-start.sh --name ml-finder

# 保存进程列表，保证开机自启用的是这套
pm2 save
```

看启动日志，确认顺序正确：

```bash
pm2 logs ml-finder --lines 15 --nostream
# 正常会先看到 [wait-tunnel] ✅ 隧道已就绪，再看到后端启动横幅
```

再验证一次后端确实在用固定域名：

```bash
curl -s http://localhost:3000/api/ml/oauth/tunnel | python3 -c "import sys,json; d=json.load(sys.stdin); print('redirectUri =', d['redirectUri'])"
# 应输出 https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/store-callback
```

---

## 第 10 步：把新回调地址填进美客多开发者后台（别忘！）

1. 打开 https://developers.mercadolibre.com/ ，登录，进入你的应用。
2. 找到 **Redirect URIs**（回调地址）设置。
3. 点 **Add（添加）**，填：
   ```
   https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/store-callback
   ```
4. 保存。

> 老地址（比如之前填的 `http://服务器IP/...` 或临时隧道地址）可以留着也可以删掉，不影响。

---

## 第 11 步：真·验证开机自启（重启服务器实测）

```bash
sudo reboot
```

等 1～2 分钟，重新连上服务器，逐条检查：

```bash
# 1. cloudflared 应该自己起来了
systemctl status cloudflared --no-pager | head -5
#    → active (running)

# 2. 项目应该自己起来了（而且是经过等待脚本启动的）
pm2 status | grep ml-finder
#    → online

# 3. 固定域名从公网通
curl -s https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/ping
#    → {"ok":true,...}

# 4. 项目用的是固定域名不是临时地址
pm2 logs ml-finder --lines 8 --nostream | grep -E "wait-tunnel|回调|redirect"
```

四条全绿 = 大功告成 🎉。从此服务器随便重启，cloudflared 自动先起、隧道自动连通，然后项目才启动，回调地址永远固定。

---

## 第 12 步（附赠）：快速隧道 —— 一行命令的临时方案

不想折腾域名、只想先看看效果，用这个：

```bash
cloudflared tunnel --url http://localhost:3000
```

会打印一个 `https://xxxx-xxx.trycloudflare.com` 的地址，浏览器打开就能访问。

⚠️ 两个坑，注意：
- **关掉这个终端/重启后地址就变了**，所以**别拿它配 OAuth 回调**（配了下次就失效）。
- 它不走 systemd，不是常驻服务，纯临时用。
- 想常驻可以 `sudo cloudflared service install` 但它默认用 config.yml；快速隧道更适合手动跑。

---

## 第 13 节：常见问题（小白急救）

| 现象 | 怎么办 |
|---|---|
| `curl ping` 返回 `{"ok":false}` | 后端没把 ping 当自检，或转到了别的实例。先 `curl -s http://localhost:3000/api/ml/oauth/ping` 确认后端本机正常，再看隧道是不是连到了**别的机器**（和本机隧道共用域名会这样，见下一条） |
| `curl ping` 返回 502 / 530 / 一堆 HTML | 隧道没真正连通。① `journalctl -u cloudflared -n 30 --no-pager` 看报错；② 确认 `config.yml` 的 `credentials-file` 路径、`tunnel` 名字没写错；③ 域名解析要等几十秒到几分钟生效，刚配置完稍等再试 |
| 「一会儿通一会儿不通」 | 多半是**同一个域名被两条隧道同时接管**了。检查本机 cloudflared 是否还在跑同一个子域名；服务器要用独立子域名（教程默认就是独立的 `ml-callback-server`） |
| `cloudflared tunnel run` 报 `Your account cannot be authenticated` | 凭证丢了/过期，重跑第 2 步 `cloudflared tunnel login` |
| 项目起来了但回调地址是 `*.loca.lt` 临时地址 | 说明后端启动时探测失败回退了。① 按第 9 步改好等待脚本并 `pm2 restart ml-finder`；② 或按第 8 步方案 A 写死 `ML_REDIRECT_URI` 最省心；③ 改完后 `pm2 logs ml-finder` 确认 |
| `systemctl is-enabled cloudflared` 返回 disabled | 没设开机自启，重跑第 6 步的 `sudo systemctl enable --now cloudflared` |
| 已经配了 Nginx 反代，会不会和 cloudflared 打架 | 不会。cloudflared 直接转发到 `localhost:3000`，绕过 Nginx；Nginx 继续服务 `http://IP` 的访问，两者共存互不影响 |
| 服务器重启后项目没起来 | ① `pm2 status` 看是不是 online；② `systemctl cat pm2-ubuntu` 确认 `After=cloudflared.service` 那两行还在；③ `pm2 save` 是否保存过当前进程列表 |
| 我没有自己的域名 | ① 免费方案：Freenom 之类申请免费域名（不一定随时有）；② 低成本方案：几块钱一年买个 `.xyz`/`.top` 域名再托管到 Cloudflare；③ 本机已用 `w999w.dpdns.org`，说明你已有一个可用域名，直接在它下面加子域名即可，无需新买 |

---

## 附录：部署完成后，日常维护命令速查

| 想干嘛 | 命令 |
|---|---|
| 看 cloudflared 状态 | `systemctl status cloudflared --no-pager` |
| 看 cloudflared 日志 | `journalctl -u cloudflared -n 50 --no-pager -f` |
| 手动重启隧道 | `sudo systemctl restart cloudflared` |
| 手动重启项目 | `pm2 restart ml-finder`（或 `pm2 restart ml-finder --update-env` 带 .env 变化） |
| 看项目日志 | `pm2 logs ml-finder` |
| 更新代码后 | `cd ~/ml-product-finder && git pull && npm install && npm run build && pm2 restart ml-finder` |
| 换固定域名了 | 改 `wait-tunnel-and-start.sh` 里的 `DOMAIN_BASE` + `.env` 的 `ML_REDIRECT_URI` + 美客多后台 Redirect URIs，然后 `pm2 restart ml-finder` |

> 提示：改过 `.env` 后重启项目，建议用 `pm2 restart ml-finder --update-env`（或 `pm2 delete ml-finder && pm2 start ./wait-tunnel-and-start.sh --name ml-finder && pm2 save`），确保新环境变量生效。
