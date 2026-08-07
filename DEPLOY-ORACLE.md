# ML Product Finder — Oracle Cloud 傻瓜式部署指南（电脑小白版）

> 本文目标：你只需要**会复制粘贴、会点鼠标**，照着一步一步做，就能把这整套「美客多选品 + 订单提醒」工具装到一台免费云服务器上，7×24 小时自己跑，手机/电脑浏览器随时访问。
>
> 配套脚本：`deploy-oracle.sh`（一键部署 + **支持中途断网/报错后续跑**，已完成的步骤会自动跳过）。

---

## 一、你会得到什么

- 一台 **永久免费**的云服务器（Oracle 免费套餐，4 核 24G 内存，够用）。
- 一个网站：在浏览器打开 `http://服务器IP` 就能用「选品 / 利润测算 / 订单提醒 / 热搜词」全部功能。
- 订单提醒：有新订单时自动发邮件 / 钉钉 / 企微 / Bark。
- 所有数据（店铺、订单提醒记录、配置）都存在服务器上，**重启不丢**。

> 关于「轻量数据库」：本项目数据本身就用最轻量的方式持久化——配置和订单提醒记录存为 `data/*.json` 小文件，会话类数据用 SQLite 单文件数据库。无需安装 MySQL、无需任何额外数据库服务，备份只要复制文件夹即可。

---

## 二、第 1 步：注册 Oracle 免费云账号

1. 打开 https://www.oracle.com/cloud/free/ ，点 **「Start for free」/「免费开始」**。
2. 用邮箱注册，中间会要求**绑定一张信用卡**做验证（**只验证不扣费**，免费套餐内永远 0 元）。
3. 注册完成后进入 **Oracle Cloud Console（控制台）**。

> 小白提示：如果某一步卡住，直接刷新页面或换个浏览器（Chrome 最佳）。注册地区选**你最近的**，比如「日本 / 韩国 / 新加坡」或「墨西哥城」都行（本项目抓美客多，服务器 IP 不在大陆封锁段即可，Oracle 的美洲/亚洲区域都 OK）。

---

## 三、第 2 步：创建免费云服务器（最关键，照着点）

1. 控制台左上角 **☰ 菜单** → **Compute（计算）** → **Instances（实例）** → 点 **「Create instance（创建实例）」**。
2. **Name（名称）**：随便填，如 `ml-finder`。
3. **Image（镜像）**：选 **Ubuntu**，版本 **22.04 LTS** 或 **24.04 LTS**（都行）。
4. **Shape（机型）**：点「Change shape」，选：
   - **ARM**（Ampere A1）
   - **OCPU：4**，**Memory：24 GB**（这是免费套餐上限，完全免费）
   - *不要选 AMD 1GB 那档，内存太小跑不动 AI 修图。*
5. **SSH keys（密钥）**：选 **「Generate a key pair（自动生成密钥对）」** → 点 **Save**（会自动下载一个 `.key` 私钥文件到电脑，**留着别删**，以后连服务器要用）。
6. **Boot volume（系统盘）**：默认 50–100 GB 即可（免费额度 200GB）。
7. 其它全部默认，**点「Create（创建）」**。
8. 等 1–2 分钟，状态变 **Running（运行中）**，记下页面上的 **Public IP Address（公网 IP）**，类似 `140.xxx.xxx.xxx`。

---

## 四、第 3 步：开放防火墙端口（否则网站打不开）

### 4.1 Oracle 云平台的安全列表（必须做）

1. 实例详情页往下拉，找到 **Subnet（子网）** → 点进去 → **Security Lists（安全列表）** → 点唯一那条。
2. 点 **「Add Ingress Rules（添加入站规则）」**，一口气加这 4 条（每条都填，Source CIDR 写 `0.0.0.0/0`，Destination Port 分别填）：
   - `22`（SSH）
   - `80`（HTTP 网站）
   - `443`（HTTPS，有域名时）
   - `3000`（备用直连测试）
3. 每条 **Stateful（有状态）** 保持默认，保存。

### 4.2 服务器内部防火墙（脚本会自动配，这里了解即可）

部署脚本里会执行 `ufw allow` 开放上述端口，你**不用手动做**。

---

## 五、第 4 步：连上服务器（两种方式任选）

### 方式 A：Oracle 网页自带终端（最省事，推荐小白）

在实例详情页，点 **「Launch Cloud Shell（启动 Cloud Shell）」** 或 **「Console connection → Launch session」**，直接在浏览器里出现一个黑框命令行，**不用装任何软件**。

> 用网页终端时，下面的命令直接粘贴进黑框回车即可。

### 方式 B：自己电脑的终端（SSH）

- **Windows**：装一个 **PuTTY** 或 **PowerShell**；用第 2 步下载的 `.key` 连接：
  ```
  ssh -i 下载的私钥.key ubuntu@你的公网IP
  ```
- **Mac / Linux**：终端直接 `ssh -i xxx.key ubuntu@IP`。

连上后，命令行提示符会变成 `ubuntu@ml-finder:~$`，说明你已经在服务器里了。

---

## 六、第 5 步：一键部署（核心，复制粘贴即可）

在服务器命令行里，**一条一条**执行下面这些命令（每粘贴一行按回车）：

```bash
# 1) 装个下载工具（用于拉取部署脚本）
sudo apt update -qq && sudo apt install -y curl git

# 2) 下载一键部署脚本
curl -fsSL -o ~/deploy-oracle.sh https://你的仓库/raw/main/deploy-oracle.sh
chmod +x ~/deploy-oracle.sh

# 3) 运行部署（之后按提示填 仓库地址 / ML_APP_ID / ML_SECRET_KEY，域名可留空）
~/deploy-oracle.sh
```

> 如果你是把代码已经推到自己的 GitHub 私有仓库，把第 2 步的地址换成你的：
> `curl -fsSL -o ~/deploy-oracle.sh https://raw.githubusercontent.com/你的用户名/仓库名/main/deploy-oracle.sh`
>
> 也可以不用下载，直接把 `deploy-oracle.sh` 的内容用 `nano` 粘进去——但对小白来说，上面 3 行最简单。

### 脚本会问你 3 个问题（照着填）

| 提问 | 填什么 | 在哪找 |
|---|---|---|
| **GitHub 仓库地址** | `https://github.com/你/仓库` | 你的 GitHub 仓库页面地址栏 |
| **ML_APP_ID** | 一串数字 | 美客多开发者后台 → 你的应用 → Client ID |
| **ML_SECRET_KEY** | 一串字母数字 | 同一页面的 Secret（点「Show」显示） |
| **域名**（可选） | 留空直接回车 | 没有域名就先不填，用 IP 访问 |

填完它会自动：装 Node、装 Nginx、拉代码、构建、配 Nginx、启动。**全程不用你再操作**，看到 🎉 就成功了。

### ⭐ 中途断了怎么办（断点续部署）

如果某一步因为**网络卡了 / 命令报错**中断，**不用从头来**！直接再跑一次：

```bash
~/deploy-oracle.sh
```

脚本有「进度记忆」：已经装好的（Node、Nginx…）、已经拉好的代码，会**自动跳过**，只接着做没完成的部分。配置（含 ML 凭证）也记下来了，不用重新输入。想强制重填配置就加参数：`~/deploy-oracle.sh --reconfigure`。

---

## 七、第 6 步：验证部署成功

1. 浏览器打开 `http://你的公网IP`（有域名就打开域名）。
2. 能看到网站首页 = 成功。
3. 服务器上也可验证：
   ```bash
   curl http://localhost:3000/api/health
   # 返回 {"status":"ok",...} 即正常
   pm2 status        # 应看到 ml-finder 状态 online
   ```

---

## 八、第 7 步：配置美客多店铺授权回调（重要！）

美客多**不接受 localhost 作为授权回调**，所以「添加店铺」需要一个公网可达的回调地址。两种方式：

### 最简单（服务器有公网 IP，推荐）

部署脚本没自动设域名，但你可以用 IP 直接当回调：

在服务器上编辑环境变量，加入（把 IP 换成你的）：
```bash
echo 'ML_REDIRECT_URI=http://你的公网IP/api/ml/oauth/store-callback' >> ~/ml-product-finder/.env
pm2 restart ml-finder
```

然后到 **美客多开发者后台 → 你的应用 → Redirect URIs**，把上面这个地址加进去（只需配一次）。回到网站「店铺管理 → 授权回调设置」确认状态为「已配置」。

> 更稳的做法是绑一个域名 + 让脚本的 SSL 步骤自动申请 HTTPS 证书（部署时「域名」那一步填你的域名即可）。

### 没有固定 IP / 想最省事

什么都不用配——点「添加店铺」时，程序会**自动起一个临时公网隧道**并把回调地址填好。唯一麻烦：隧道地址偶尔会变，变了就在美客多后台重新加一次新的回调地址（网站里点「授权回调设置 → 重新测试」能看到最新地址）。

---

## 九、日常维护（抄命令即可）

| 想做啥 | 命令 |
|---|---|
| 看运行状态 | `pm2 status` |
| 看日志（排查问题） | `pm2 logs ml-finder` |
| 重启程序 | `pm2 restart ml-finder` |
| 停止程序 | `pm2 stop ml-finder` |
| 更新代码（出了新版本） | `cd ~/ml-product-finder && git pull && npm install && npm run build && pm2 restart ml-finder` |
| 服务器重启后自动运行 | 部署时已用 `pm2 startup` 设好，开机自动起 |

---

## 十、常见问题（小白急救）

| 现象 | 怎么办 |
|---|---|
| 浏览器打不开网站 | ① 确认第 3 步防火墙端口加了；② `pm2 status` 看是不是 online；③ `curl http://localhost:3000/api/health` 看后端是否活 |
| 提示「部署中断」 | 直接再跑 `~/deploy-oracle.sh`，会自动续上 |
| 抓取 0 条数据 | 检查 `ML_APP_ID`/`ML_SECRET_KEY` 是否正确；`pm2 logs ml-finder` 看报错；Oracle IP 若被美客多封，需在网站「代理设置」里填住宅代理 |
| 店铺授权后订单是 0 | 多半是授权了**非卖家账号**或**非 CBT 跨境账号**。本项目是 CBT 跨境卖家，授权时务必用 CBT/Global Selling 卖家账号 |
| 邮件/钉钉收不到提醒 | 网站「通知设置」里点「发送测试」看报错；钉钉要选对 Webhook 类型，地址别填错 |
| 磁盘快满 | 本项目数据都在 `~/ml-product-finder/data`，可定期清理 `data/exports` 旧文件 |

---

## 附：部署脚本做了啥（给想了解的人）

`deploy-oracle.sh` 把下面 6 步自动化，且每步都做了「已完成就跳过」的断点续跑：
1. 收集配置（仓库 / ML 凭证 / 域名），写入 `~/.ml_deploy_state`（权限 600，凭证不泄露）
2. 装 Node 22 / Nginx / Git / Certbot / PM2（已装则跳过）
3. 克隆/更新代码 → `npm install` → `npm run build`（前端）
4. 生成 `.env`（含随机 SESSION_SECRET）
5. 配置 Nginx 反代（有域名自动申请 HTTPS 证书）
6. 用 PM2 以 `tsx server/index.ts` 启动后端，设开机自启

> 后端用 `tsx` 直接跑 TypeScript（与开发模式一致），避免打包环节出错，最稳。数据持久化在 `~/ml-product-finder/data/*.json` + SQLite，重启不丢。
