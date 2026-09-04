# Oracle A1 免费实例「自动抢」指南（GitHub Actions 版）

你遇到的问题是：在 Oracle Cloud 控制台点「创建」A1.Flex 实例时提示
**「AD-1 容量不足」**。这是热门区域瞬时没库存，Oracle 会周期性补货。
手动点基本抢不到，正确做法是**写个脚本循环重试，并在 AD-1/2/3 之间轮换**。

因为你的电脑晚上要关机，所以把脚本放到 **GitHub Actions（免费 CI）** 上跑——
它运行在 GitHub 的服务器上，跟你本机开关机无关，半夜抢到了你第二天看一眼就行。

---

## 一、整体流程（一次性准备，之后全自动）

1. 在 Oracle 控制台生成 **API 密钥**（一次性）。
2. 收集 **6 个参数**（下面第四节逐个讲从哪找）。
3. 把本项目推到一个 **GitHub 私有仓库**。
4. 在仓库里填 **6 个 Secrets**。
5. 手动点一次 / 或等定时（每 15 分钟）触发 workflow。
6. 抢到后去控制台看公网 IP，SSH 连上去部署。

---

## 二、第 0 步：生成 Oracle API 密钥（只做一次）

> 最简单的方式：让 Oracle 控制台帮你生成，不用本地装东西。

1. 登录 Oracle Cloud 控制台。
2. 右上角**头像** → **User Settings（用户设置）**（或 "My Profile"）。
3. 左侧 **API Keys** → 点 **Generate API Key（生成 API 密钥）**。
4. 弹出窗口会做三件事：
   - **① 给你一段「配置文本」** —— 复制下来，这就是后面的 **`OCI_CONFIG`**。
   - **② 让你下载 / 复制「私钥」** —— 复制全文，这就是后面的 **`OCI_KEY`**。
   - **③ 自动把配对的「公钥」上传** 到 Oracle（你不用管）。
5. 保存好这两段文本，下面要用。

配置文本长这样（你复制到的就是这种）：
```ini
[DEFAULT]
user=ocid1.user.oc1..aaaaaaaa...
fingerprint=ab:cd:ef:12:34:...
key_file=~/.oci/key.pem
tenancy=ocid1.tenancy.oc1..aaaa...
region=mx-queretaro-1
```
> ⚠️ 其中 `region=mx-queretaro-1` 必须和你选的区域一致（墨西哥城 = `mx-queretaro-1`）。
> 如果你选的是美国区域，会显示 `us-phoenix-1` / `us-sanjose-1` 等，照抄即可。

---

## 三、把项目推到 GitHub

1. 去 GitHub 新建一个 **Private（私有）仓库**，名字随便（如 `ml-product-finder`）。
2. 在本机项目目录：
   ```bash
   cd ml-product-finder
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/你的用户名/你的仓库.git
   git push -u origin main
   ```

---

## 四、6 个 Secrets 逐个说明（重点）

进仓库 **Settings → Secrets and variables → Actions → New repository secret**，
挨个新建下面 6 个。名称必须完全照写（大写 + 下划线）。

### 1. `OCI_CONFIG`
- **是什么**：OCI CLI 的配置文件，告诉工具「用哪个账号、哪个区域、哪个密钥」。
- **内容**：第二节第 4 步复制的那段配置文本（含 `[DEFAULT]` 那一行）。
- **注意**：整段复制，别漏 `[DEFAULT]`；`region` 必须和你选的区域一致。

### 2. `OCI_KEY`
- **是什么**：API **私钥**（配对的公钥已经上传到 Oracle）。
- **内容**：第二节第 4 步下载/复制的私钥全文。
- **注意**：首尾的 `-----BEGIN RSA PRIVATE KEY-----` 和
  `-----END RSA PRIVATE KEY-----` 两行都要，一行不能少。

### 3. `OCI_COMPARTMENT`
- **是什么**：你的「隔间 / 容器（Compartment）」ID，实例建在哪个 compartment 下。
- **从哪找**：
  - 左上角**汉堡菜单** → **Identity & Security（身份与安全）** → **Compartments**。
  - 点开你要用的 compartment → 页面里 **OCID** 那一栏点「复制」。
  - （**root compartment 就是你的 tenancy OCID，两者是同一个**，最简单：
    右上角头像 → **Tenancy** → 复制 **OCID** 即可。后面第 5 步查镜像也要用这个同一个 OCID。）
- **注意**：必须和你的区域对应（同一区域下的 compartment）；**直接用 root/tenancy 这个就行，不要选成某个子 compartment**。

### 4. `OCI_SUBNET`
- **是什么**：虚拟网络里一个**子网**的 ID，实例要挂上去才能分配公网 IP、才能外网访问。
- **从哪找**：
  - 汉堡菜单 → **Networking（网络）** → **Virtual Cloud Networks**。
  - 选你的 VCN → **Subnets** → 点进一个**公共子网（名字通常带 `public`）** → 复制 **OCID**。
- **注意**：**必须是 Public Subnet（公共子网）**！否则分不到公网 IP，
  部署后外网访问不了。如果你用「创建实例」向导让 Oracle 自动建了 VCN，
  里面会自带一个 public subnet，用它就行。

### 5. `OCI_IMAGE`
- **是什么**：操作系统镜像 ID。这里用 **Ubuntu 24.04 ARM 版**（因为 A1 是 ARM 芯片）。
- **从哪找（最简单，用 Cloud Shell，零配置）**：
  1. 控制台右上角点 **Cloud Shell（>_ 图标）** 打开浏览器终端（已帮你登录好）。
  2. 先拿到你的 **Root Compartment / Tenancy OCID**（它就是同一个东西）：
     ```bash
     export OCI_TENANCY_ID=$(oci iam tenancy get --query 'data.id' --raw-output)
     echo "Tenancy OCID: $OCI_TENANCY_ID"
     ```
     > ⚠️ 如果上面打印出来是**空的**（你之前报错 `compartmentId is not available` 就是因为这个变量空了），
     > 请直接去控制台拿：右上角**头像 → Tenancy → 复制 OCID**，然后手动执行：
     > `export OCI_TENANCY_ID=ocid1.tenancy.oc1....`（粘贴你复制到的完整 OCID）。
  3. 用这个 OCID 列出 Ubuntu 24.04 ARM 镜像：
     ```bash
     oci compute image list \
       --compartment-id "$OCI_TENANCY_ID" \
       --operating-system "Canonical Ubuntu" \
       --shape VM.Standard.A1.Flex \
       --query 'data[].{"name":"display-name","id":id}'
     ```
  4. 在结果里找 `Canonical Ubuntu 24.04 aarch64` 那一行，复制它的 `id`。

     > 如果提示 `service error` 或没有结果，把命令里的 `--operating-system "Canonical Ubuntu"` 改成 `--operating-system "Ubuntu"` 再试一次；不同区域镜像名可能略有差异。
- **备选**：控制台 → **Compute → Images**，找同名镜像复制 OCID。
- **注意**：**必须是 `aarch64` / ARM 版**；x86 镜像在 A1 上跑不了。

### 6. `OCI_SSH_PUB`
- **是什么**：SSH **公钥**，建好实例后你用对应的私钥连上去部署。
- **从哪找**：你本机 `~/.ssh/id_rsa.pub` 文件的**整行内容**。
  - 如果没有，本地跑 `ssh-keygen -t rsa -b 4096` 生成（一路回车）。
- **注意**：只复制 `.pub` **公钥**那一行，**不要**私钥。

---

## 五、触发 workflow

- **手动**：仓库 **Actions** 标签 → 选 **Grab Oracle A1** → **Run workflow**。
- **自动**：不用管，每 15 分钟 GitHub 会自动跑一次（免费版可能延迟 ≤15 分钟）。
- **看结果**：Actions 页里这次运行是 **绿色 ✅** = 抢到了，日志里会打印实例 OCID；
  **红色 ❌** 且日志是「容量不足」= 这轮没抢到，等下一轮继续；
  如果是「其它错误」= 你的某个 Secret 填错了，按日志改。

> workflow 自带「查重 + 并发锁」：一旦抢到一个 `ml-product-finder` 实例，
> 后续运行会自动跳过，不会重复建多个实例。

---

## 六、抢到之后

1. 控制台 → **Compute → Instances** → 看实例的**公网 IP**。
2. 本地连上去：
   ```bash
   ssh ubuntu@<公网IP> -i ~/.ssh/id_rsa
   ```
3. 按部署步骤装环境（Node 22 + Python + rembg）、设 `LLM_*` 环境变量、
   `npm install && npm run build && npm run server`。

---

## 七、常见坑

| 现象 | 原因 / 解决 |
|---|---|
| 日志报非容量错误（权限/404） | 某个 Secret 填错，重点查 `OCI_CONFIG` 的 `region` 与 `OCI_SUBNET`/`OCI_IMAGE` 是否同一区域 |
| 部署后外网打不开 | `OCI_SUBNET` 用了私有子网，换成 public subnet |
| 镜像启动失败 | `OCI_IMAGE` 不是 aarch64 版，重选 ARM 镜像 |
| 定时没动静 | GitHub 免费版 cron 可能延迟 ≤15 分钟，属正常；可手动 Run workflow 立即试 |
| 单次没抢到 | 单次最多跑 350 分钟，到点自动结束；下一轮 cron 继续，挂着即可 |
| `compartmentId is not available` | `--compartment-id` 传了空值。Cloud Shell 里 `oci iam tenancy get --query` 没取到 OCID，去控制台 头像→Tenancy→复制 OCID 手动 `export` 补上即可（root compartment 与 tenancy OCID 是同一个） |

---

## 附：本地版脚本（人在电脑前时用）

`oracle-grab-a1.sh` 是同样逻辑的本地版，需本机已 `oci setup config` 配好凭证：
```bash
COMP=ocid1.compartment... SUB=ocid1.subnet... IMG=ocid1.image... \
SSH_PUB="ssh-rsa AAAA..." bash oracle-grab-a1.sh
```
