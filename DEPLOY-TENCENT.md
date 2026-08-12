# ML Product Finder — 腾讯云 保姆级部署教程

> 目标读者：**完全不懂 Linux、不懂服务器的小白**。
> 你只要会**复制粘贴命令、会点鼠标**，照着下面一步一步做，就能把这套「美客多选品 + 订单提醒」工具装到一台**腾讯云的轻量应用服务器**上，7×24 小时自己跑，手机/电脑浏览器随时打开就能用。
>
> 配套脚本：`deploy-tencent.sh`（一键部署，且**支持中途断网/报错后续跑**——已经做过的步骤会自动跳过，不用从头来）。

---

## 〇、先看这一节：你会得到什么 + 准备清单

### 你会得到什么
- 一台**腾讯云的轻量应用服务器**（新用户通常有低价/免费试用额度，国内访问快、不用翻墙）。
- 一个网站：浏览器打开 `http://服务器IP`（或你的域名）就能用「选品 / 利润测算 / 订单提醒 / 热搜词」全部功能。
- 新订单自动发邮件 / 钉钉 / 企微 / Bark 提醒。
- 所有数据（店铺、订单提醒记录、配置）都存在服务器上，**重启不丢**。

### 准备清单（开始前确认你有这些）
| 东西 | 说明 |
|---|---|
| 一台能上网的电脑（Windows / Mac 都行） | 用来操作 |
| 一个微信或 QQ | 注册 / 登录腾讯云用（推荐微信，扫码最方便） |
| **身份证** | 腾讯云**必须实名认证**才能开通服务器（中国大陆要求，按页面提示上传即可，几分钟过） |
| 美客多开发者账号的 `ML_APP_ID` 和 `ML_SECRET_KEY` | 在美客多开发者后台「你的应用」页面拿。没有的话先去 https://developers.mercadolibre.com/ 注册应用 |
| 本项目代码 | 就在你这台电脑的 `ml-product-finder` 文件夹里（本教程假设你已经有一份） |

> 如果你**已经有自己的域名**（比如 `ml.example.com`），部署时能顺便免费申请 HTTPS 证书、用 `https://你的域名` 访问，更稳更好。没有域名也完全没关系，用服务器 IP 直接访问即可。

---

## 第 1 步：把最新代码弄到服务器（两条路，任选）

> ⚠️ **为什么需要这一步**：部署脚本要么从 GitHub 拉代码，要么你直接把文件夹传到服务器。二选一，**至少要做一件**，否则服务器上没有你的代码。
>
> ⚠️ **提醒**：你这台电脑上的 `ml-product-finder` 里**还有几个文件改过但没保存推送**（删除二次确认、钉钉图片平铺那几次修改 + 刚才修的弹窗关不掉）。如果用 GitHub 方式，必须先把它们 push；如果用 **WinSCP 上传方式，则不需要 GitHub**，直接把文件夹拖上去即可，**今晚急着部署推荐走 WinSCP 这条路**（省掉 GitHub 推送的麻烦）。

### 方式一：推到 GitHub（适合以后长期更新方便）
1. 打开 https://github.com/ ，右上角 **Sign up** 注册（或直接登录）。
2. 右上角 **＋** → **New repository**，名字填 `ml-product-finder`，**Visibility 选 Private**，其它初始化选项**全不勾**，点 Create。
3. 复制仓库地址（HTTPS 旁边复制按钮），类似 `https://github.com/你的用户名/ml-product-finder.git`。
4. 在 `ml-product-finder` 文件夹里**按住 Shift 右键** → 「在终端中打开」，依次执行：
   ```bash
   git init
   git remote add origin https://github.com/你的用户名/ml-product-finder.git
   git add -A
   git commit -m "部署版本"
   git push -u origin main
   ```
   > 如果提示密码登录失败，GitHub 命令行要用 **Personal Access Token**：网页 → 头像 → **Settings** → 最底下 **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**，勾 `repo`，生成后当密码粘贴（屏幕不显示，正常）。

### 方式二：用 WinSCP 直接上传（今晚推荐，不用 GitHub）
1. 安装 **WinSCP**（免费）：https://winscp.net/ ，一路默认安装。
2. 等你**第 3 步建好服务器拿到 IP 和登录密码**后，用 WinSCP 连上服务器（文件协议 SFTP，主机名=服务器公网 IP，用户名 `ubuntu` 或 `lighthouse`，密码=你设的），把电脑上 `ml-product-finder` 文件夹里的**所有内容**拖到服务器的 `/home/ubuntu/ml-product-finder`（除 `node_modules`、`dist`、`.git` 这几个大文件夹可不上传，能省很多时间；其它全选）。
3. 上传完，后面第 6 步运行脚本时**仓库地址那一步直接回车留空**即可（脚本检测到代码已存在会自动跳过下载）。

---

## 第 2 步：注册腾讯云 + 实名认证

1. 打开 https://cloud.tencent.com/ ，点右上角**免费注册 / 登录**，推荐用**微信扫码**登录。
2. 登录后，右上角头像 → **实名认证**，按提示上传**身份证**完成认证（中国大陆必须，几分钟搞定）。
3. 实名完成后，进入**控制台**（右上角「控制台」）。

> 新用户通常能在「轻量应用服务器」页面看到**免费试用 / 新用户特价**（如 2 核 2G 几十元/年，或首年免费额度）。具体优惠以腾讯云当期活动页为准，选最便宜的 Ubuntu 机型即可。

---

## 第 3 步：创建轻量应用服务器（最关键，照着点）

1. 控制台左上角搜索框搜 **「轻量应用服务器」**，进入该产品页 → 点 **「新建」**（或「创建实例」）。
2. **应用镜像 / 系统镜像**：选 **系统镜像** → **Ubuntu** → **22.04 LTS**（24.04 也行）。
   > 不要选「应用模板」里那些带环境的，选干净的 Ubuntu 系统镜像即可，脚本会自己装。
3. **实例套餐**：新用户选最便宜的（如 2 核 2G / 4 核 8G 的特价档）。本项目后端很轻，2 核 2G 足够跑订单轮询 + 网页。
4. **地域**：选**中国大陆**离你近的（如上海 / 广州）。注意：本项目抓的是美客多（美洲站点），**服务器 IP 在国内不影响抓取**（抓取走的是美客多公开 API + 你的卖家 token）。
5. **登录方式**：
   - 选 **「设置密码」**，自己设一个 root / ubuntu 的登录密码（记下来，连服务器要用）。
   - 也可以选「SSH 密钥」（更安全），但新手建议先用密码，最简单。
6. **实例名**：填 `ml-finder`（随便起）。
7. 确认套餐价格，**勾选同意**，点 **「立即购买 / 开通」**。
8. 等 1 分钟，状态变成 **「运行中」**。在实例详情页找到 **「公网 IP」**，类似 `1xx.xxx.xxx.xxx`，**抄下来**（后面访问网站和连服务器都要用）。
   > 轻量应用服务器**会自动分配一个公网 IP**，不用像 Oracle 那样单独配。

---

## 第 4 步：开放防火墙端口（否则网站打不开）

腾讯云轻量应用服务器有**自己的防火墙**（独立于系统防火墙），默认只开 22/80/443，必须手动放行 3000。

1. 在实例详情页，找到 **「防火墙」** 标签页，点 **「添加规则」**。
2. 一条一条加（每条填完点「确定」再填下一条）：
   | 应用类型 | 协议 | 端口 | 来源 |
   |---|---|---|---|
   | 自定义 | TCP | `22` | 0.0.0.0/0 |
   | 自定义 | TCP | `80` | 0.0.0.0/0 |
   | 自定义 | TCP | `443` | 0.0.0.0/0 |
   | 自定义 | TCP | `3000` | 0.0.0.0/0 |
   > 端口含义：22=SSH 连服务器；80=网站 HTTP；443=有域名时 HTTPS；3000=后端备用直连测试。
3. 4 条都加好后，列表里能看到它们即生效（轻量防火墙是即时生效的，不用重启）。

---

## 第 5 步：连上服务器（两种方式任选）

### 方式 A：腾讯云网页自带终端（最省事，强烈推荐小白）
在实例详情页，点 **「登录」** 按钮 → 选 **「标准登录 / WebShell（OrcaTerm）」**，浏览器里直接弹出一个黑框命令行，**不用装任何软件**。后面的命令直接粘贴进去回车即可。

### 方式 B：用自己电脑的终端连（SSH）
- **Windows（PowerShell）**，用密码登录最简单（把 IP 换成你的）：
  ```powershell
  ssh ubuntu@你的公网IP
  ```
  > 如果第 3 步选的是 lighthouse 系统镜像，用户名可能是 `lighthouse`，按你买的镜像来；密码是你第 3 步设的。
  > 如果改用 SSH 密钥登录，私钥权限太开放 ssh 会拒绝，先收紧权限：
  > ```powershell
  > icacls "$env:USERPROFILE\Downloads\你的密钥.pem" /inheritance:r /grant:r "$env:USERNAME:R"
  > ssh -i "$env:USERPROFILE\Downloads\你的密钥.pem" ubuntu@你的公网IP
  > ```

连上后，命令行提示符变成 `ubuntu@ml-finder:~$`（或 `lighthouse@...`），说明你已经在服务器里了。

---

## 第 6 步：一键部署（核心，复制粘贴即可）

> 前提：你的代码已经按**第 1 步**弄到服务器了（GitHub 推了，或 WinSCP 上传了）。

在服务器命令行里（不管是网页终端还是 SSH），**一条一条**执行：

```bash
# 1) 装下载工具和 git
sudo apt update -qq && sudo apt install -y curl git

# 2) 下载一键部署脚本
curl -fsSL -o ~/deploy-tencent.sh https://raw.githubusercontent.com/你的用户名/ml-product-finder/main/deploy-tencent.sh
chmod +x ~/deploy-tencent.sh

# 3) 运行部署
~/deploy-tencent.sh
```

> 如果你的仓库默认分支不是 `main`（比如是 `master`），把第 2 步地址里的 `main` 改成 `master`。
>
> **不走 GitHub 的情况（纯 WinSCP 上传）**：因为你没把仓库推到 GitHub，上面第 2 步的 `curl` 下载脚本会失败。替代做法——直接用 **WinSCP 把 `deploy-tencent.sh` 也拖到服务器的 `~/` 目录**（和代码一起传），然后跳过第 2 步，直接 `chmod +x ~/deploy-tencent.sh && ~/deploy-tencent.sh` 即可。

### 脚本会问你几个问题（照着填）
| 提问 | 填什么 | 在哪找 |
|---|---|---|
| **GitHub 仓库地址** | GitHub 方式就填 `https://github.com/你/仓库.git`；**WinSCP 方式直接回车留空** | 你 GitHub 仓库页面地址栏（末尾带 `.git`） |
| **ML_APP_ID** | 一串数字 | 美客多开发者后台 → 你的应用 → Client ID |
| **ML_SECRET_KEY** | 一串字母数字 | 同一页面的 Secret（点 Show 显示） |
| **域名**（可选） | 没有就**直接回车留空** | 有域名就填，如 `ml.example.com` |

填完它会自动完成：装 Node → 装 Nginx → 拉代码（或沿用已上传的）→ 装依赖 → 构建前端 → 生成配置（含随机密钥 + 自动算好店铺授权回调地址）→ 配 Nginx 反代 → 用 PM2 启动。**全程不用你再操作**，看到 🎉 就成功了。

### ⭐ 中途断了怎么办（断点续部署）
如果某一步因为**网络卡了 / 命令报错**中断，**不用从头来**！直接再跑一次：
```bash
~/deploy-tencent.sh
```
脚本有「进度记忆」：已经装好的（Node、Nginx…）、已经拉好的代码会**自动跳过**，只接着做没完成的部分。凭证也记下来了，不用重新输入。想强制重填配置就加参数：`~/deploy-tencent.sh --reconfigure`。

---

## 第 7 步：验证部署成功

1. 浏览器打开 `http://你的公网IP`（有域名就打开 `https://你的域名`）。
2. 能看到网站首页 = 成功。
3. 在服务器上也能验证：
   ```bash
   curl http://localhost:3000/api/health
   # 返回 {"status":"ok",...} 即后端正常
   pm2 status        # 应看到 ml-finder 状态 online
   ```

---

## 第 8 步：配置美客多店铺授权回调（已自动化，确认一下即可）

美客多**不接受 localhost 当授权回调**，所以「添加店铺」需要一个公网可达的回调地址。部署脚本**已经自动**在 `.env` 里写好了 `ML_REDIRECT_URI`（用你的 IP 或域名拼出来的），一般不用再手动改。

你只需要去 **美客多开发者后台 → 你的应用 → Redirect URIs**，把下面这个地址加进去（只需配一次，把 IP/域名换成你的）：
```
http://你的公网IP/api/ml/oauth/store-callback
```
（有域名就是 `https://你的域名/api/ml/oauth/store-callback`）

加完回到网站「店铺管理 → 授权回调设置」确认状态为「已配置」即可。

> 更稳的做法是绑一个域名（部署时「域名」那一步填你的域名），脚本会自动申请 HTTPS 证书，回调用 `https` 更不容易被美客多拒。

---

## 第 9 步：日常维护（抄命令即可）

| 想做啥 | 命令 |
|---|---|
| 看运行状态 | `pm2 status` |
| 看日志（排查问题） | `pm2 logs ml-finder` |
| 重启程序 | `pm2 restart ml-finder` |
| 停止程序 | `pm2 stop ml-finder` |
| 更新代码（GitHub 方式出了新版本） | `cd ~/ml-product-finder && git pull && npm install && npm run build && pm2 restart ml-finder` |
| 更新代码（WinSCP 方式） | 用 WinSCP 重新传文件 → `cd ~/ml-product-finder && npm run build && pm2 restart ml-finder` |
| 服务器重启后自动运行 | 部署时已用 `pm2 startup` 设好，开机自动起 |

---

## 第 10 步：常见问题（小白急救）

| 现象 | 怎么办 |
|---|---|
| 浏览器打不开网站 | ① 确认第 4 步防火墙 4 个端口都加了；② `pm2 status` 看是不是 online；③ `curl http://localhost:3000/api/health` 看后端是否活 |
| 提示「部署中断」 | 直接再跑 `~/deploy-tencent.sh`，会自动续上已完成步骤 |
| Windows 连服务器报 `Permissions for ... are too open` | 这是私钥权限问题，按第 5 步方式 B 的 `icacls` 命令收紧权限再连 |
| 抓取 0 条数据 | 检查 `ML_APP_ID`/`ML_SECRET_KEY` 是否正确；`pm2 logs ml-finder` 看报错 |
| 店铺授权后订单是 0 | 多半授权了**非卖家账号**或**非 CBT 跨境账号**。本项目是 CBT 跨境卖家，授权时务必用 CBT/Global Selling 卖家账号 |
| 邮件/钉钉收不到提醒 | 网站「通知设置」里点「发送测试」看报错；钉钉要选对 Webhook 类型，地址别填错 |
| 磁盘快满 | 数据都在 `~/ml-product-finder/data`，可定期清理 `data/exports` 里的旧文件 |
| 更新代码后白屏 | 记得 `npm run build` 重新构建前端，再 `pm2 restart ml-finder` |

---

## 附录：部署脚本到底帮你做了啥

`deploy-tencent.sh` 把下面 6 步自动化，而且每步都做了「已完成就跳过」的断点续跑：
1. 收集配置（仓库 / ML 凭证 / 域名 / 自动算回调地址），写入 `~/.ml_deploy_state`（权限 600，凭证不泄露）
2. 装 Node 22 / Nginx / Git / Certbot / PM2 / 编译工具链（已装则跳过）
3. 克隆（或沿用已上传的）代码 → `npm install`（自动跳过 Electron 下载）→ `npm run build`（前端）
4. 生成 `.env`（含随机 SESSION_SECRET 和自动算好的 ML_REDIRECT_URI）
5. 配置 Nginx 反代（有域名自动申请 HTTPS 证书）
6. 用 PM2 以 `tsx server/index.ts` 启动后端，设开机自启

> 后端用 `tsx` 直接跑 TypeScript（和开发模式一致，免打包，最稳）。数据持久化在 `~/ml-product-finder/data/*.json` + SQLite 单文件数据库，重启不丢。前端 `dist` 静态文件也由后端一起托管，所以 Nginx 只反代到 `:3000` 就能同时服务网页和接口。
