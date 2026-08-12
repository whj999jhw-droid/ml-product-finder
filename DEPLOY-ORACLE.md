# ML Product Finder — Oracle 免费服务器 保姆级部署教程（合并版）

> 目标读者：**完全不懂 Linux、不懂服务器的小白**。你只要会**复制粘贴命令、会点鼠标**，照着下面一步一步做，就能把这套「美客多选品 + 订单提醒」工具装到一台**永久免费**的云服务器上，7×24 小时自己跑，手机/电脑浏览器随时打开就能用。
>
> 配套脚本：
> - `deploy-oracle.sh` —— 一键基础部署（装环境、拉代码、构建、配 Nginx、PM2 启动）。**支持断点续跑**：做过的步骤自动跳过。
> - `setup-cloudflared.sh` —— 一键配置「固定 HTTPS 域名隧道 + 启动顺序固化」（本文后半部分）。
>
> 本文把「基础部署」和「固定域名隧道」两篇合并成一份，按顺序看即可。

---

# 第一部分：基础部署（让网站先在服务器跑起来）

## 〇、先看这一节：你会得到什么 + 准备清单

### 你会得到什么
- 一台 **永久免费**的云服务器（Oracle 免费套餐：4 核 CPU、24G 内存，够用且永远 0 元）。
- 一个网站：浏览器打开 `http://服务器IP`（或你的域名）就能用「选品 / 利润测算 / 订单提醒 / 热搜词」全部功能。
- 新订单自动发邮件 / 钉钉 / 企微 / Bark 提醒。
- 所有数据（店铺、订单提醒记录、配置）都存在服务器上，**重启不丢**。

### 准备清单（开始前确认你有这些）
| 东西 | 说明 |
|---|---|
| 一台能上网的电脑（Windows / Mac 都行） | 用来操作 |
| 一个邮箱 | 注册 Oracle 和 GitHub 用 |
| 一张信用卡 | **只用于身份验证，不扣费**（免费套餐内永远 0 元）。没有信用卡过不了验证 |
| 美客多开发者账号的 `ML_APP_ID` 和 `ML_SECRET_KEY` | 在美客多开发者后台「你的应用」页面拿。没有的话先去 https://developers.mercadolibre.com/ 注册应用 |
| 本项目代码 | 就在你这台电脑的 `ml-product-finder` 文件夹里（本教程假设你已经有一份） |

> 如果你**已经有自己的域名**（比如 `ml.example.com`），部署时能顺便免费申请 HTTPS 证书、用 `https://你的域名` 访问，更稳更好。没有域名也完全没关系，用服务器 IP 直接访问即可。

---

## 第 1 步：把最新代码推到 GitHub（非常重要，别跳过）

> ⚠️ **为什么必须做这一步**：下面的部署脚本是从 GitHub 把代码拉到服务器上的。如果你不先把代码传到 GitHub，服务器就会拿到一份「旧的 / 空的」代码。
>
> ⚠️ **特别提醒**：你这台电脑上的 `ml-product-finder` 里**可能还有几个文件改过但没保存**。不推送，服务器就跑不到你最新的功能。这一步就是把这些改动安全地存到 GitHub。

### 1.1 注册 GitHub（已有账号可跳过）
1. 打开 https://github.com/ ，点右上角 **Sign up（注册）**。
2. 用邮箱注册、设置密码、验证邮箱，一路下一步即可。

### 1.2 在 GitHub 上新建一个仓库（用来放代码）
1. 登录后，点页面右上角 **＋** → **New repository（新建仓库）**。
2. **Repository name（仓库名）**：填 `ml-product-finder`（随便起也行）。
3. **Visibility（可见性）**：选 **Private（私有）** 最安全（只有你能看）。
4. 其它**不要**勾选任何初始化选项（别勾 README / .gitignore / License），保持空仓库。
5. 点 **Create repository（创建仓库）**。
6. 创建后会跳到一个页面，复制页面上类似下面这行的地址（点 HTTPS 旁边的复制按钮）：
   ```
   https://github.com/你的用户名/ml-product-finder.git
   ```
   把它先记到记事本里，后面要用。

### 1.3 在你电脑上安装 Git
- **Windows**：
  1. 打开 https://git-scm.com/download/win ，下载 64-bit Git for Windows Setup。
  2. 双击安装，**一路点 Next（下一步）**，所有选项保持默认即可，最后点 Install。
  3. 装完后，在 `ml-product-finder` 文件夹的空白处**按住 Shift 右键** → 选 **「在此处打开 PowerShell 窗口」**（或「在终端中打开」）。
- **Mac**：打开「终端」，输入 `git --version`，没装会提示你装 Command Line Tools，点安装即可。

> 后面所有「在文件夹里打开命令行」都指：进到 `ml-product-finder` 目录，右键 → 在此处打开终端。

### 1.4 配置 Git 身份（只做一次）
在打开的命令行里，把下面两行里的名字和邮箱换成你自己的，分别粘贴回车：
```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱@example.com"
```

### 1.5 把代码提交并推送到 GitHub
在 `ml-product-finder` 目录的命令行里，**一条一条**粘贴执行（每粘一行按回车）：

```bash
# 1. 初始化本地仓库（如果已经初始化过会提示已存在，忽略即可）
git init

# 2. 关联远程仓库（把地址换成你 1.2 步复制的那个）
git remote add origin https://github.com/你的用户名/ml-product-finder.git

# 3. 把当前文件夹里所有文件加进暂存区
git add -A

# 4. 提交（说明随便写）
git commit -m "首次部署版本"

# 5. 推送到 GitHub（本仓库默认分支是 master）
git push -u origin master
```

> **关于第 5 步的报错**：
> - 如果提示 `master` 分支不存在，先试 `git branch -M master` 再 `git push -u origin master`。
> - 如果弹出**登录框**：GitHub 现在**不能用账号密码登录命令行**，要用 **Personal Access Token（个人访问令牌）**。做法：去 GitHub 网页 → 右上角头像 → **Settings** → 左侧最底下 **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**。勾选 `repo` 权限，过期选「No expiration」或长一点，点 Generate。把生成的**那一长串令牌复制下来**，回到命令行粘贴当密码用（粘贴时屏幕不显示内容，正常，输完回车）。
> - 如果提示 `remote already exists`，说明之前关联过，跳过第 2 步直接 push 即可。

推送成功后，去 GitHub 网页刷新你的仓库，能看到一堆文件就说明成了。

---

## 第 2 步：注册 Oracle 免费云账号

1. 打开 https://www.oracle.com/cloud/free/ ，点 **「Start for free」**（中文可能显示「免费开始」）。
2. 用邮箱注册，填写姓名、国家/地区（选**你最近的**，比如 Singapore / Japan / Korea，或 Mexico City——本项目抓美客多，只要服务器 IP 不在大陆封锁段就行，Oracle 的美洲和亚洲区域都 OK）。
3. 中间会要求**绑定一张信用卡**做验证。**只验证、不扣费**，免费套餐内永远 0 元。
4. 注册完进入 **Oracle Cloud Console（控制台）**。

> 小白提示：某一步卡住就刷新页面、或换个浏览器（推荐 Chrome）。注册邮件里的验证码及时填写。

---

## 第 3 步：创建免费云服务器（最关键，照着点）

1. 控制台左上角 **☰ 菜单**（三横线）→ **Compute（计算）** → **Instances（实例）** → 点 **「Create instance（创建实例）」**。
2. **Name（名称）**：填 `ml-finder`（随便起）。
3. **Image and shape（映像和形状）** 这里要分两步：
   - 先确认 **Image（映像）** 选的是 **Ubuntu**，版本 **22.04 LTS** 或 **24.04 LTS**（都行）。
   - 点 **Change shape（更改形状）** → **Shape series（形状系列）** 选 **Ampere（ARM）** → 选 **VM.Standard.A1.Flex** → 把 **OCPU** 设为 **4**，**Memory（内存）** 设为 **24 GB**（这是免费套餐上限，完全免费）。
   - ⚠️ **千万不要选** AMD 那档 1GB 内存的小机器，内存太小跑不动。
4. **SSH keys（密钥）**：选 **「Generate a key pair（自动生成密钥对）」** → 点 **Save（保存）**。它会**自动下载一个 `.key` 文件**（文件名类似 `ssh-key-xxxx.key`）到你的「下载」文件夹。**这个文件留着别删**，后面连服务器要用。
5. **Boot volume（启动卷 / 系统盘）**：默认 50–100 GB 即可（免费额度有 200GB，够用）。
6. 其它全部默认，**点「Create（创建）」**。
7. 等 1–2 分钟，状态变成 **Running（运行中）**。在实例详情页找到 **Public IP Address（公网 IP）**，类似 `140.xxx.xxx.xxx`，**把它抄下来**（后面访问网站和连服务器都要用）。

---

## 第 4 步：开放防火墙端口（否则网站打不开）

Oracle 默认把所有端口都关着，必须手动放行，否则外面访问不了。

### 4.1 在 Oracle 控制台放行（必须做）
1. 在实例详情页，往下找 **Subnet（子网）** 那一行，点它右边的蓝色链接进入子网页。
2. 子网页里点 **Security Lists（安全列表）** → 点里面**唯一的那条**安全列表。
3. 点 **「Add Ingress Rules（添加入站规则）」**。
4. 在弹出的表单里，**一口气加下面 4 条规则**（每条都填，填完点一次「Add Rule」再填下一条，或一次性粘贴多行）：
   - **Source CIDR**：`0.0.0.0/0`（表示所有人可访问）
   - **Destination Port Range（目的端口）**：分别填 `22`、`80`、`443`、`3000`
   - 其它保持默认，**Stateful（有状态）** 打勾
   - ⚠️ **源端口范围不要填数字**（比如 3000），留空选「所有」即可；入站规则只看**目的端口**。
5. 4 条都加好后点 **「Add Ingress Rules」** 保存。

> 端口含义：22=SSH 连服务器用；80=网站 HTTP；443=有域名时 HTTPS 用；3000=后端端口（备用直连测试）。

### 4.2 服务器自身防火墙（脚本会自动配，了解即可）
部署脚本里会执行 `ufw allow` 开放上面这些端口，**你不用手动做**。

---

## 第 5 步：连上服务器（两种方式任选）

### 方式 A：Oracle 网页自带终端（最省事，强烈推荐小白）
在实例详情页，找 **「Launch Cloud Shell（启动 Cloud Shell）」** 或 **Console connection → Launch session**，浏览器里直接出现一个黑框命令行，**不用装任何软件**。后面的命令直接粘贴进去回车即可。

### 方式 B：用自己电脑的终端连（SSH）
适合想在自己电脑上操作的人。

- **Mac / Linux**：终端直接运行（把路径和 IP 换成你自己的）：
  ```bash
  ssh -i ~/Downloads/ssh-key-xxxx.key ubuntu@你的公网IP
  ```
- **Windows（PowerShell / Git Bash）**：
  1. 打开 PowerShell 或 Git Bash。
  2. **先修复私钥权限**（Windows 默认权限太开放，ssh 会拒绝使用，这是最容易卡的一步）：
     ```powershell
     icacls "$env:USERPROFILE\Downloads\ssh-key-xxxx.key" /inheritance:r /grant:r "$env:USERNAME:R"
     ```
     > 如果 `icacls` 报错，换成 Git Bash 最稳：
     > ```bash
     > mkdir -p ~/.ssh
     > cp /c/Users/你的用户名/Downloads/ssh-key-xxxx.key ~/.ssh/oracle-key.key
     > chmod 400 ~/.ssh/oracle-key.key
     > ssh -i ~/.ssh/oracle-key.key ubuntu@你的公网IP
     > ```
  3. 连接（PowerShell）：
     ```powershell
     ssh -i "$env:USERPROFILE\Downloads\ssh-key-xxxx.key" ubuntu@你的公网IP
     ```

连上后，命令行提示符会变成 `ubuntu@ml-finder:~$`，说明你已经在服务器里了。

> 嫌命令行麻烦也可以用 **MobaXterm / WinSCP**：MobaXterm 左上角 Session → SSH → 填公网 IP + 用户名 `ubuntu` → Advanced SSH settings 里选私钥文件，即可连上（左边是 SFTP 文件管理器，能直接拖文件）。下文多处可用它传文件。

---

## 第 6 步：一键部署（核心，复制粘贴即可）

> 前提：你的代码已经按**第 1 步**推到了 GitHub（或者你选择了下面「方式二：不用 GitHub」用 MobaXterm/WinSCP 上传）。

在服务器命令行里（不管是网页终端还是 SSH），**一条一条**执行：

```bash
# 1) 装下载工具和 git
sudo apt update -qq && sudo apt install -y curl git

# 2) 下载一键部署脚本（本仓库默认分支是 master）
curl -fsSL -o ~/deploy-oracle.sh https://raw.githubusercontent.com/你的用户名/ml-product-finder/master/deploy-oracle.sh
chmod +x ~/deploy-oracle.sh

# 3) 运行部署
~/deploy-oracle.sh
```

> 如果你的仓库默认分支不是 `master`（比如是 `main`），把第 2 步地址里的 `master` 改成你的实际分支名。

### 脚本会问你几个问题（照着填）
| 提问 | 填什么 | 在哪找 |
|---|---|---|
| **GitHub 仓库地址** | `https://github.com/你/仓库.git` | 你 GitHub 仓库页面地址栏（末尾带 `.git`） |
| **ML_APP_ID** | 一串数字 | 美客多开发者后台 → 你的应用 → Client ID |
| **ML_SECRET_KEY** | 一串字母数字 | 同一页面的 Secret（点 Show 显示） |
| **域名**（可选） | 没有就**直接回车留空** | 有域名就填，如 `ml.example.com`（固定域名隧道会单独处理，基础部署这里留空即可） |

填完它会自动完成：装 Node → 装 Nginx → 拉代码 → 装依赖 → 构建前端 → 生成配置（含随机密钥 + 自动算好店铺授权回调地址）→ 配 Nginx 反代 → 用 PM2 启动。**全程不用你再操作**，看到 🎉 就成功了。

### ⭐ 中途断了怎么办（断点续部署）
如果某一步因为**网络卡了 / 命令报错**中断，**不用从头来**！直接再跑一次：
```bash
~/deploy-oracle.sh
```
脚本有「进度记忆」：已经装好的、已经拉好的代码会**自动跳过**，只接着做没完成的部分。凭证也记下来了，不用重新输入。想强制重填配置就加参数：`~/deploy-oracle.sh --reconfigure`。

---

## 第 6 步 · 替代方案：不用 GitHub，直接用 MobaXterm/WinSCP 上传代码

如果你不想折腾 Git，可以把代码文件夹直接传到服务器，再跑部署脚本（脚本已经支持「检测到代码就跳过下载」）。

1. 用 **MobaXterm**（免费，https://mobaxterm.mobatek.net ，下 Home Edition）连上服务器（SSH + 私钥，见第 5 步）。
2. 登录后右边是服务器终端，左边是 SFTP 文件管理器。在右边进入 `ubuntu` 家目录（`/home/ubuntu`）。
3. 在右边新建文件夹 `ml-product-finder`（右键 → 新建 → 目录）。
4. 把你电脑上 `ml-product-finder` 文件夹里的**所有内容**（除了 `node_modules`、`dist`、`.git` 这几个大文件夹可以不上传，能省很多时间；其它全选）从 Windows 资源管理器**拖进左边文件列表**，就上传到服务器了。
5. 上传完，回到服务器命令行，直接运行（**仓库地址那一步留空回车**即可，因为代码已经在服务器上了）：
   ```bash
   curl -fsSL -o ~/deploy-oracle.sh https://raw.githubusercontent.com/你的用户名/ml-product-finder/master/deploy-oracle.sh
   chmod +x ~/deploy-oracle.sh
   ~/deploy-oracle.sh
   ```
   脚本检测到 `~/ml-product-finder` 已有代码，会自动跳过「下载」步骤，只做安装依赖、构建、配置、启动。

> 想用 WinSCP 也行（https://winscp.net/ ），操作类似：SFTP + 私钥登录，拖文件。

---

## 第 7 步：验证基础部署成功

1. 浏览器打开 `http://你的公网IP`（有域名就打开 `https://你的域名`）。
2. 能看到网站首页 = 成功。
3. 在服务器上也能验证：
   ```bash
   curl http://localhost:3000/api/health
   # 返回 {"status":"ok",...} 即后端正常
   pm2 status        # 应看到 ml-finder 状态 online
   ```

---

## 第 8 步：配置美客多店铺授权回调（基础版）

美客多**不接受 localhost 当授权回调**，所以「添加店铺」需要一个公网可达的回调地址。基础部署脚本**已经自动**在 `.env` 里写好了 `ML_REDIRECT_URI`（用你的 IP 或域名拼出来的），一般不用再手动改。

你只需要去 **美客多开发者后台 → 你的应用 → Redirect URIs**，把下面这个地址加进去（只需配一次，把 IP/域名换成你的）：
```
http://你的公网IP/api/ml/oauth/store-callback
```
（有域名就是 `https://你的域名/api/ml/oauth/store-callback`）

> 更稳的做法是走下文的「固定域名隧道」——它会把回调地址换成 `https://你的子域名...`，用 HTTPS 更不容易被美客多拒，且地址固定不变。**如果你要走固定域名隧道，本步先不用管，等隧道建好后再去美客多后台加隧道的回调地址即可。**

---

## 第 9 步：基础部署的日常维护（抄命令即可）

| 想做啥 | 命令 |
|---|---|
| 看运行状态 | `pm2 status` |
| 看日志（排查问题） | `pm2 logs ml-finder` |
| 重启程序 | `pm2 restart ml-finder` |
| 停止程序 | `pm2 stop ml-finder` |
| 更新代码（GitHub 方式） | `cd ~/ml-product-finder && git pull && npm install && npm run build && pm2 restart ml-finder` |
| 更新代码（上传方式） | 用 MobaXterm 重新传文件 → `cd ~/ml-product-finder && npm run build && pm2 restart ml-finder` |
| 服务器重启后自动运行 | 部署时已用 `pm2 startup` 设好，开机自动起 |

---

# 第二部分：固定 HTTPS 域名隧道（cloudflared）

> 前置：**第一部分基础部署已经完成**，`pm2 status` 能看到 `ml-finder` 是 online、网站能用 `http://服务器IP` 打开。
>
> 做完本部分你会得到：
> - 服务器上的项目通过**固定 HTTPS 域名**暴露公网（不再依赖随机地址、不用自己管证书）
> - `cloudflared` 和项目都**开机自启**，重启服务器不用手动操作
> - **严格保证启动顺序：先 cloudflared，再本项目**（否则回调地址会回退成随机临时地址，美客多授权失效）

## 为什么需要固定域名隧道
| 问题 | 原因 |
|---|---|
| 美客多 OAuth 回调需要固定地址 | 美客多不允许 localhost，且回调地址要提前在开发者后台填好；IP 直连虽然能填，但回调用 HTTPS 更稳、更不容易被拒 |
| IP 直连不够稳 | Oracle 服务器 IP 属于数据中心 IP，走 Cloudflare 隧道后，请求从 Cloudflare 的 IP 进来，稳定性好很多 |
| Oracle 免费实例的公网 IP 会变 | 实例**停止再启动**后 IP 会换。但 cloudflared 是**出站**连接（服务器主动连 Cloudflare），不依赖服务器 IP 被主动访问，所以只要 cloudflared 在跑，域名永远通——这是它最大的好处 |

## 两种隧道，先选一个
| | 方式 A：命名隧道（推荐） | 方式 B：快速隧道 |
|---|---|---|
| 需要 | 一个**已托管在 Cloudflare 的域名**（你本机用的 `w999w.dpdns.org` 就是；没有的话见文末提示） | 什么都不需要 |
| 域名固定吗 | ✅ 固定，永久不变 | ❌ 每次重启随机变 |
| 适合 | **长期用、要配 OAuth 回调** | 临时测试 |
| 命令复杂度 | 一键脚本 1 条 | 1 行 |

> ⚠️ 本文以方式 A 为主（OAuth 回调必须固定地址）。**强烈建议用一键脚本 `setup-cloudflared.sh`（下一节）**，不要手工一条条敲。

---

## ★ 一键脚本方案（setup-cloudflared.sh，推荐小白）

脚本把「手动详细步骤」的第 1~9 步**全部自动化**，且**幂等**——做过的步骤自动跳过，可以放心重复运行（比如你基础部署已做完、想直接用它把隧道和启动顺序补上）。

### 1) 获取脚本（二选一）
- **GitHub 下载**（脚本已随代码进仓库，分支 `master`）：
  ```bash
  curl -fsSL -o ~/setup-cloudflared.sh https://raw.githubusercontent.com/你的用户名/ml-product-finder/master/setup-cloudflared.sh
  chmod +x ~/setup-cloudflared.sh
  ```
- **MobaXterm 上传**：把本机 `ml-product-finder/setup-cloudflared.sh` 拖到服务器 `/home/ubuntu/`。

### 2) 运行
隧道名/域名都用默认值（`ml-finder-server` / `ml-callback-server.w999w.dpdns.org`）：
```bash
cd ~
bash setup-cloudflared.sh
```
如需自定义：
```bash
TUNNEL_NAME=ml-finder-server DOMAIN=ml-callback-server.w999w.dpdns.org bash setup-cloudflared.sh
```

### 3) 它会自动做
1. 装 cloudflared（已装则跳过）
2. 登录检查（缺 `cert.pem` 会提示你先 `cloudflared tunnel login` 授权，再重跑）
3. 创建隧道 + DNS 路由（已存在则跳过/忽略）
4. 写 `config.yml` + 写 systemd 服务并启动 cloudflared
5. 等隧道连通后验证 ping
6. 把 `ML_REDIRECT_URI` 写死进 `.env`
7. 生成 `wait-tunnel-and-start.sh` + 把 PM2 设为 cloudflared 之后启动 + 重启项目

### 4) 跑完还需手动（浏览器一步）
去 **美客多开发者后台 → 你的应用 → Redirect URIs** 添加（域名换成你的）：
```
https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/store-callback
```
老地址（IP 或临时隧道）可以留着备用，不影响。

### 5) 验证
```bash
# 公网域名通了
curl -s https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/ping
# → {"ok":true,...}

# 后端用的回调地址确实是固定域名
curl -s http://localhost:3000/api/ml/oauth/tunnel | python3 -c "import sys,json;print(json.load(sys.stdin)['redirectUri'])"
# → https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/store-callback
```

---

## 手动详细步骤（如需排错 / 看懂原理，可对照；推荐直接用上面的脚本）

### 第 1 步：安装 cloudflared
```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update -qq
sudo apt install -y cloudflared
cloudflared --version   # 能打印版本号就 OK
```

### 第 2 步：登录 Cloudflare（获取隧道凭证）
```bash
cloudflared tunnel login
```
运行后会打印一个授权链接。复制到**你自己电脑的浏览器**打开，登录托管着 `w999w.dpdns.org` 的 Cloudflare 账号，选中该域名，点 Authorize。成功后服务器自动生成 `~/.cloudflared/cert.pem`。

### 第 3 步：创建命名隧道
```bash
cloudflared tunnel create ml-finder-server
# 记下输出的隧道 ID；再用下面命令确认凭证 json 已生成
cloudflared tunnel list
```

> **备选：想直接复用本机那套隧道/域名（美客多后台零改动）？**
> 如果你决定**不再用本机跑项目**，可以在服务器上直接复用本机的隧道凭证：把本机 `C:\Users\whj87\.cloudflared\` 里的 `*.json`（隧道 ID 文件）和 `cert.pem` 传到服务器的 `~/.cloudflared/`，然后 `cloudflared tunnel run ml-product-finder` 就能用。**同一个隧道不要同时在本机和服务器跑**，否则请求会被随机分到两台机器（时而通时而 530）。复用模式下，下文所有 `ml-finder-server` / `ml-callback-server` 都要换成 `ml-product-finder` / `ml-callback.w999w.dpdns.org`，且**第 4 步 DNS 路由不用做**（已存在）。

### 第 4 步：把子域名绑到隧道（DNS 路由）
```bash
cloudflared tunnel route dns ml-finder-server ml-callback-server.w999w.dpdns.org
```
成功会提示已添加 CNAME。

### 第 5 步：写 cloudflared 配置
```bash
nano ~/.cloudflared/config.yml
```
粘贴（隧道 ID 换成你第 3 步的）：
```yaml
tunnel: ml-finder-server
credentials-file: /home/ubuntu/.cloudflared/你的隧道ID.json
ingress:
  - hostname: ml-callback-server.w999w.dpdns.org
    service: http://localhost:3000
  - service: http_status:404
```
`Ctrl+O` 回车保存，`Ctrl+X` 退出。验证：
```bash
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
chmod 600 ~/.cloudflared/config.yml
```

### 第 6 步：cloudflared 开机自启（systemd）
```bash
sudo nano /etc/systemd/system/cloudflared.service
```
粘贴（ExecStart 里 `which cloudflared` 的实际路径若不是 `/usr/local/bin/cloudflared` 就换掉）：
```ini
[Unit]
Description=Cloudflare Tunnel (ml-finder-server)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=ubuntu
Group=ubuntu
ExecStart=/usr/local/bin/cloudflared tunnel run ml-finder-server
Restart=always
RestartSec=5
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
```
保存后：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared
systemctl status cloudflared --no-pager   # active (running)
```

### 第 7 步：验证固定域名通了（关键检查点）
```bash
curl -s https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/ping
# → {"ok":true,...}
```
若返回 `{"ok":false}` / `502` / `530` / HTML 乱码，先别往下走，去看文末常见问题。

### 第 8 步：让项目使用固定域名（二选一，推荐方案 A）
**方案 A（推荐）：写死 `ML_REDIRECT_URI`** —— 后端直接用，连探测都省，最稳：
```bash
cd ~/ml-product-finder
nano .env
```
把 `ML_REDIRECT_URI=` 改成（没有就新增一行）：
```
ML_REDIRECT_URI=https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/store-callback
```
保存（`Ctrl+O` → 回车 → `Ctrl+X`）。**先不要重启项目**——第 9 步会换启动方式，一起生效。

**方案 B（不写死，靠自动探测）**：不设 `ML_REDIRECT_URI`，让后端每次启动自己探测固定域名、通了就用。这样「先 cloudflared 后项目」的顺序就成了唯一保障（即第 9 步）。已按 A 写的，B 可忽略。

### 第 9 步：固化启动顺序 —— 先 cloudflared，再本项目（⭐ 核心）
分两层保险：① 改 PM2 开机服务，让它排在 cloudflared 之后；② 给项目套一个「等待隧道就绪」启动脚本。

**9.1 第一层：PM2 服务声明 cloudflared 之后启动**
```bash
sudo nano /etc/systemd/system/pm2-ubuntu.service   # 路径以 systemctl cat pm2-ubuntu 为准
```
在 `[Unit]` 段加：
```ini
After=cloudflared.service
Wants=cloudflared.service
```
保存后 `sudo systemctl daemon-reload`。

**9.2 第二层：写等待脚本**
```bash
cd ~/ml-product-finder
nano wait-tunnel-and-start.sh
```
粘贴（DOMAIN_BASE 改成你的域名基座）：
```bash
#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DOMAIN_BASE="https://ml-callback-server.w999w.dpdns.org"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "$DOMAIN_BASE/api/ml/oauth/ping" 2>/dev/null | grep -q '"ok":true'; then
    echo "[wait-tunnel] 隧道已就绪 ($i)"; break
  fi
  echo "[wait-tunnel] 等待隧道... ($i/30)"; sleep 2
done
exec npx tsx server/index.ts
```
`chmod +x wait-tunnel-and-start.sh`。

**9.3 换用新脚本启动项目**
```bash
cd ~/ml-product-finder
pm2 delete ml-finder 2>/dev/null || true
pm2 start ./wait-tunnel-and-start.sh --name ml-finder
pm2 save
pm2 logs ml-finder --lines 15 --nostream   # 应先看到 [wait-tunnel] ✅，再看到后端启动
```

### 第 10 步：把新回调地址填进美客多后台（别忘！）
1. 打开 https://developers.mercadolibre.com/ ，登录，进入你的应用。
2. 找到 **Redirect URIs**，点 **Add**，填：
   ```
   https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/store-callback
   ```
3. 保存。（老地址可留可删）

### 第 11 步：真·验证开机自启（重启服务器实测）
```bash
sudo reboot
```
等 1~2 分钟重连，逐条检查：
```bash
systemctl status cloudflared --no-pager | head -5     # active (running)
pm2 status | grep ml-finder                            # online
curl -s https://ml-callback-server.w999w.dpdns.org/api/ml/oauth/ping   # {"ok":true,...}
pm2 logs ml-finder --lines 8 --nostream | grep -E "wait-tunnel|redirect"
```
四条全绿 = 大功告成。

### 第 12 步（附赠）：快速隧道（临时测试一行命令）
```bash
cloudflared tunnel --url http://localhost:3000
```
会打印 `https://xxxx.trycloudflare.com` 临时地址。**关掉终端/重启后地址变**，别拿它配 OAuth 回调。

---

## 第二部分常见问题（小白急救）
| 现象 | 怎么办 |
|---|---|
| `curl ping` 返回 `{"ok":false}` | 先 `curl -s http://localhost:3000/api/ml/oauth/ping` 确认后端本机正常，再看隧道是否连到别的机器 |
| `curl ping` 返回 502 / 530 / HTML | ① `journalctl -u cloudflared -n 30 --no-pager` 看报错；② 确认 `config.yml` 的 `credentials-file` / `tunnel` 没写错；③ DNS 刚配置要等几十秒到几分钟 |
| 「一会儿通一会儿不通」 | 同一域名被两条隧道同时接管。检查本机 cloudflared 是否还在跑同一个子域名；服务器用独立子域名 |
| `cloudflared tunnel run` 报认证失败 | 凭证丢了/过期，重跑第 2 步 `cloudflared tunnel login` |
| 项目起来了但回调是 `*.loca.lt` 临时地址 | 后端启动时探测失败回退了。按第 8 步方案 A 写死 `ML_REDIRECT_URI`，或按第 9 步改好等待脚本后 `pm2 restart ml-finder` |
| `systemctl is-enabled cloudflared` 返回 disabled | 没设开机自启，重跑第 6 步 `sudo systemctl enable --now cloudflared` |
| 已经配了 Nginx 反代，和 cloudflared 打架？ | 不会。cloudflared 直接转发到 `localhost:3000`，绕过 Nginx；Nginx 继续服务 `http://IP`，两者共存 |
| 服务器重启后项目没起来 | ① `pm2 status` 看 online；② `systemctl cat pm2-ubuntu` 确认 `After=cloudflared.service` 还在；③ `pm2 save` 是否保存过 |
| 我没有自己的域名 | 你本机已用 `w999w.dpdns.org`，直接在它下面加子域名即可，无需新买 |

---

## 综合常见问题（小白急救）

| 现象 | 怎么办 |
|---|---|
| 浏览器打不开网站 | ① 确认第 4 步防火墙 4 个端口都加了；② `pm2 status` 看是不是 online；③ `curl http://localhost:3000/api/health` 看后端是否活 |
| 提示「部署中断」 | 直接再跑 `~/deploy-oracle.sh`，会自动续上已完成步骤 |
| Windows 连服务器报 `Permissions for ... are too open` | 私钥权限问题，按第 5 步方式 B 的 `icacls` / Git Bash `chmod 400` 收紧权限再连 |
| 抓取 0 条数据 | 检查 `ML_APP_ID`/`ML_SECRET_KEY` 是否正确；`pm2 logs ml-finder` 看报错；Oracle IP 若被美客多封，需在网站「代理设置」里填住宅代理 |
| 店铺授权后订单是 0 | 多半授权了**非卖家账号**或**非 CBT 跨境账号**。本项目是 CBT 跨境卖家，授权时务必用 CBT/Global Selling 卖家账号 |
| 邮件/钉钉收不到提醒 | 网站「通知设置」里点「发送测试」看报错；钉钉要选对 Webhook 类型，地址别填错 |
| 磁盘快满 | 数据都在 `~/ml-product-finder/data`，可定期清理 `data/exports` 里的旧文件 |
| 更新代码后白屏 | 记得 `npm run build` 重新构建前端，再 `pm2 restart ml-finder` |

---

## 附录：两个脚本到底帮你做了啥

### deploy-oracle.sh（基础部署）
把下面 6 步自动化，每步都做了「已完成就跳过」的断点续跑：
1. 收集配置（仓库 / ML 凭证 / 域名 / 自动算回调地址），写入 `~/.ml_deploy_state`（权限 600）
2. 装 Node 22 / Nginx / Git / Certbot / PM2 / 编译工具链（已装则跳过）
3. 克隆（或沿用已上传的）代码 → `npm install`（自动跳过 Electron 下载）→ `npm run build`（前端）
4. 生成 `.env`（含随机 SESSION_SECRET 和自动算好的 ML_REDIRECT_URI）
5. 配置 Nginx 反代（有域名自动申请 HTTPS 证书）
6. 用 PM2 以 `tsx server/index.ts` 启动后端，设开机自启

> 后端用 `tsx` 直接跑 TypeScript（和开发模式一致，免打包，最稳）。数据持久化在 `~/ml-product-finder/data/*.json` + SQLite 单文件数据库，重启不丢。前端 `dist` 静态文件也由后端一起托管，所以 Nginx 只反代到 `:3000` 就能同时服务网页和接口。

### setup-cloudflared.sh（固定域名隧道）
把「第二部分」第 1~9 步自动化，幂等：
1. 装 cloudflared（已装则跳过）
2. 检查 `cert.pem`，缺失则提示先 `cloudflared tunnel login`
3. 创建命名隧道（已存在则跳过）+ DNS 路由（已存在则忽略）
4. 写 `config.yml` + systemd 服务并启动 cloudflared
5. 等待隧道连通并验证 ping
6. 写死 `.env` 的 `ML_REDIRECT_URI`
7. 生成 `wait-tunnel-and-start.sh` + 把 PM2 设为 cloudflared 之后启动 + 重启项目（`pm2 delete` 旧的避免端口冲突）

> 两个脚本都支持重复运行。基础部署与隧道部署相互独立：先跑 `deploy-oracle.sh` 把网站跑起来，再跑 `setup-cloudflared.sh` 把固定域名和启动顺序固化。后续更新代码统一用 `git pull && npm run build && pm2 restart ml-finder`（隧道模式用 `pm2 delete ml-finder && pm2 start ./wait-tunnel-and-start.sh --name ml-finder && pm2 save`）。
