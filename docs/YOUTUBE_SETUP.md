# YouTube 上传 OAuth 授权指引

本指南用于配置「上架时自动把商品视频上传到 YouTube」所需的 Google OAuth 凭证。
图生视频（Luma/Kling 等）暂不自动生成，需你先在当地生成好视频文件，再填服务器上的绝对路径。

## 一、在 Google Cloud 创建 OAuth 客户端

1. 打开 https://console.cloud.google.com/ ，用你的 Google 账号登录。
2. 新建或选择一个项目（Project）。
3. 启用 **YouTube Data API v3**：
   - 「API 和服务」→「库」→ 搜索 `YouTube Data API v3` → 启用。
4. 进入「API 和服务」→「OAuth 同意屏幕」：
   - 用户类型选 **外部（External）**；
   - 填写应用名称、用户支持邮箱、开发者联系邮箱；
   - 测试用户里把自己的 Google 账号加进去（发布前只能测试用户使用）。
5. 进入「API 和服务」→「凭据」→ 点击「创建凭据」→「OAuth 客户端 ID」：
   - 应用类型选 **桌面应用（Desktop app）**（或 TV/设备，二者都支持 out-of-band 流程）；
   - 创建后复制 **客户端 ID（Client ID）** 和 **客户端密钥（Client Secret）**。

## 二、在本系统录入凭证

1. 打开「AI 选品候选列表」页面，点击右上角 **配置 YouTube**。
2. 把 Client ID / Client Secret 粘贴到对应输入框，点击 **1. 保存 Client 凭证**。
3. 点击 **2. 获取授权链接**，浏览器会打开 Google 授权页。
4. 用你的 Google 账号登录并「允许」。**同意屏幕的 URL 地址栏**里会出现
   `&code=4/0xxxxxxx-xxxx` 这一段（部分浏览器会显示成 code 输入框），复制 `code=` 后面的内容。
5. 把 code 粘贴回弹窗的「3. 粘贴授权 code」，点击 **完成授权**。
6. 页面提示「已授权 ✅」即配置成功，凭证保存在服务器 `app_config` 表，不会明文暴露。

> 注意：同一账号重复授权可能不会再返回 refresh_token，若失败请先在
> Google 账号的「第三方应用访问权」里移除本应用，再重新走一遍流程。

## 三、使用

- 配置完成后，在候选商品的「上架」弹窗里打开
  **上架后上传商品视频到 YouTube** 开关，填写服务器上视频文件的**绝对路径**
  （如 `/data/videos/product_demo.mp4`）。
- 点击「确认上架」：系统先正常上架到 Mercado Libre，再把视频上传到 YouTube
  （默认未公开 unlisted），并把视频链接写进商品描述。
- 上传失败不影响正常上架；默认 YouTube 每日配额约 6 条视频。

## 四、常见问题

- **提示「请先保存 client_id 与 client_secret」**：回到步骤二第 2 步先保存。
- **授权链接打不开 / 提示未验证应用**：在同意屏幕把当前账号加入「测试用户」。
- **code 复制后报无效**：code 有效期很短（约 1 分钟），请重新点「获取授权链接」并立即复制使用。
- **上传报配额超限**：YouTube Data API 默认日配额 10000，单次上传耗 1600，约 6 条/天。
