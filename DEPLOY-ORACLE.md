# ML Product Finder — Oracle 免费服务器 保姆级部署教程

> 目标读者：**完全不懂 Linux、不懂服务器的小白**。
> 你只要会**复制粘贴命令、会点鼠标**，照着下面一步一步做，就能把这套「美客多选品 + 订单提醒」工具装到一台**永久免费**的云服务器上，7×24 小时自己跑，手机/电脑浏览器随时打开就能用。
>
> 配套脚本：`deploy-oracle.sh`（一键部署，且**支持中途断网/报错后续跑**——已经做过的步骤会自动跳过，不用从头来）。

---

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
> ⚠️ **特别提醒**：你这台电脑上的 `ml-product-finder` 里**还有几个文件改过但没保存**（比如删除二次确认、钉钉图片平铺那几次修改）。**不推送，服务器就跑不到你最新的功能。** 这一步就是把这些改动安全地存到 GitHub。

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

# 5. 推送到 GitHub
git push -u origin main
```

> **关于第 5 步的报错**：
> - 如果提示 `main` 分支不存在，先试 `git branch -M main` 再 `git push -u origin main`。
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
- **Windows（PowerShell）**：
  1. 打开 PowerShell（开始菜单搜 PowerShell）。
  2. **先修复私钥权限**（Windows 默认权限太开放，ssh 会拒绝使用，这是最容易卡的一步）：
     ```powershell
     icacls "$env:USERPROFILE\Downloads\ssh-key-xxxx.key" /inheritance:r /grant:r "$env:USERNAME:R"
     ```
     > 把文件名换成你实际下载的 `.key` 文件名。这条命令把私钥权限收紧到「只有你本人可读」，ssh 才肯用。
  3. 连接：
     ```powershell
     ssh -i "$env:USERPROFILE\Downloads\ssh-key-xxxx.key" ubuntu@你的公网IP
     ```

连上后，命令行提示符会变成 `ubuntu@ml-finder:~$`，说明你已经在服务器里了。

---

## 第 6 步：一键部署（核心，复制粘贴即可）

> 前提：你的代码已经按**第 1 步**推到了 GitHub（或者你选择了下面「方式二：不用 GitHub」用 WinSCP 上传）。

在服务器命令行里（不管是网页终端还是 SSH），**一条一条**执行：

```bash
# 1) 装下载工具和 git（如果用了 WinSCP 上传方式，git 也可以不装，但装上无害）
sudo apt update -qq && sudo apt install -y curl git

# 2) 下载一键部署脚本
curl -fsSL -o ~/deploy-oracle.sh https://raw.githubusercontent.com/你的用户名/ml-product-finder/main/deploy-oracle.sh
chmod +x ~/deploy-oracle.sh

# 3) 运行部署
~/deploy-oracle.sh
```

> 如果你的仓库默认分支不是 `main`（比如是 `master`），把第 2 步地址里的 `main` 改成 `master`。
> 也可以不下载，直接用 `nano ~/deploy-oracle.sh` 把脚本内容粘进去——但对小白来说上面 3 行最简单。

### 脚本会问你几个问题（照着填）
| 提问 | 填什么 | 在哪找 |
|---|---|---|
| **GitHub 仓库地址** | `https://github.com/你/仓库.git` | 你 GitHub 仓库页面地址栏（末尾带 `.git`） |
| **ML_APP_ID** | 一串数字 | 美客多开发者后台 → 你的应用 → Client ID |
| **ML_SECRET_KEY** | 一串字母数字 | 同一页面的 Secret（点 Show 显示） |
| **域名**（可选） | 没有就**直接回车留空** | 有域名就填，如 `ml.example.com` |

填完它会自动完成：装 Node → 装 Nginx → 拉代码 → 装依赖 → 构建前端 → 生成配置（含随机密钥 + 自动算好店铺授权回调地址）→ 配 Nginx 反代 → 用 PM2 启动。**全程不用你再操作**，看到 🎉 就成功了。

### ⭐ 中途断了怎么办（断点续部署，小白救命功能）
如果某一步因为**网络卡了 / 命令报错**中断，**不用从头来**！直接再跑一次：
```bash
~/deploy-oracle.sh
```
脚本有「进度记忆」：已经装好的（Node、Nginx…）、已经拉好的代码会**自动跳过**，只接着做没完成的部分。凭证也记下来了，不用重新输入。想强制重填配置就加参数：`~/deploy-oracle.sh --reconfigure`。

---

## 第 6 步 · 替代方案：不用 GitHub，直接用 WinSCP 上传代码

如果你不想折腾 Git，可以把代码文件夹直接传到服务器，再跑部署脚本（脚本已经支持「检测到代码就跳过下载」）。

1. 在电脑上安装 **WinSCP**（免费）：https://winscp.net/ ，一路默认安装。
2. 打开 WinSCP，新建站点：
   - **文件协议**：SFTP
   - **主机名**：你的服务器公网 IP
   - **端口号**：22
   - **用户名**：`ubuntu`
   - **密码**：先留空，点左侧「高级」→「SSH」→「验证」→ 选你下载的 `.key` 文件 → 确定
   - 点「登录」，首次连接会弹「继续连接？」点是。
3. 登录后，左边是你电脑、右边是服务器。在右边进入 `ubuntu` 的家目录（通常是 `/home/ubuntu`）。
4. **重要**：在右边新建文件夹 `ml-product-finder`（右键 → 新建 → 目录）。
5. 把你电脑上 `ml-product-finder` 文件夹里的**所有内容**（除了 `node_modules`、`dist`、`.git` 这几个大文件夹可以不上传，能省很多时间；其它全选）拖到右边刚建的 `ml-product-finder` 里。
   > 如果嫌麻烦，全选一起拖也行，就是慢一点。
6. 上传完，回到服务器命令行，直接运行（**仓库地址那一步留空回车**即可，因为代码已经在服务器上了）：
   ```bash
   curl -fsSL -o ~/deploy-oracle.sh https://raw.githubusercontent.com/你的用户名/ml-product-finder/main/deploy-oracle.sh
   chmod +x ~/deploy-oracle.sh
   ~/deploy-oracle.sh
   ```
   脚本检测到 `~/ml-product-finder` 已有代码，会自动跳过「下载」步骤，只做安装依赖、构建、配置、启动。

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
| 提示「部署中断」 | 直接再跑 `~/deploy-oracle.sh`，会自动续上已完成步骤 |
| Windows 连服务器报 `Permissions for ... are too open` | 这是私钥权限问题，按第 5 步方式 B 的 `icacls` 命令收紧权限再连 |
| 抓取 0 条数据 | 检查 `ML_APP_ID`/`ML_SECRET_KEY` 是否正确；`pm2 logs ml-finder` 看报错；Oracle IP 若被美客多封，需在网站「代理设置」里填住宅代理 |
| 店铺授权后订单是 0 | 多半授权了**非卖家账号**或**非 CBT 跨境账号**。本项目是 CBT 跨境卖家，授权时务必用 CBT/Global Selling 卖家账号 |
| 邮件/钉钉收不到提醒 | 网站「通知设置」里点「发送测试」看报错；钉钉要选对 Webhook 类型，地址别填错 |
| 磁盘快满 | 数据都在 `~/ml-product-finder/data`，可定期清理 `data/exports` 里的旧文件 |
| 更新代码后白屏 | 记得 `npm run build` 重新构建前端，再 `pm2 restart ml-finder` |

---

## 附录：部署脚本到底帮你做了啥

`deploy-oracle.sh` 把下面 6 步自动化，而且每步都做了「已完成就跳过」的断点续跑：
1. 收集配置（仓库 / ML 凭证 / 域名 / 自动算回调地址），写入 `~/.ml_deploy_state`（权限 600，凭证不泄露）
2. 装 Node 22 / Nginx / Git / Certbot / PM2 / 编译工具链（已装则跳过）
3. 克隆（或沿用已上传的）代码 → `npm install`（自动跳过 Electron 下载）→ `npm run build`（前端）
4. 生成 `.env`（含随机 SESSION_SECRET 和自动算好的 ML_REDIRECT_URI）
5. 配置 Nginx 反代（有域名自动申请 HTTPS 证书）
6. 用 PM2 以 `tsx server/index.ts` 启动后端，设开机自启

> 后端用 `tsx` 直接跑 TypeScript（和开发模式一致，免打包，最稳）。数据持久化在 `~/ml-product-finder/data/*.json` + SQLite 单文件数据库，重启不丢。前端 `dist` 静态文件也由后端一起托管，所以 Nginx 只反代到 `:3000` 就能同时服务网页和接口。
