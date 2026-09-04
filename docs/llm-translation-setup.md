# 热搜词中文翻译 —— AI 配置说明

热搜词页面里的「中文翻译」由一个大模型（LLM）生成。本工具通过 **OpenAI 兼容的 `/v1/chat/completions` 接口** 调用任意兼容模型，你只要填 3 个值就能用。

> 不配置也能用：没填 LLM 时，热搜词页面只显示英文原词，点击英文复制英文；配置好后会自动补上中文，点击中文复制中文。AI 标题/描述生成也依赖同样的配置。

---

## 一、需要配置的 3 个参数

| 参数 | 含义 | 去哪找 | 示例 |
|------|------|--------|------|
| `LLM_BASE_URL` | 模型服务的基础地址（不含 `/v1/chat/completions`，代码会自动拼） | 各家供应商的控制台「API 文档 / 接口地址」 | `https://api.siliconflow.cn` |
| `LLM_API_KEY` | 调用密钥（Bearer Token） | 供应商控制台「API Keys」页面创建 | `sk-xxxx` |
| `LLM_MODEL` | 具体模型名（必须供应商支持 chat 且能输出 JSON） | 供应商的「模型列表」 | `Qwen/Qwen2.5-7B-Instruct` |

环境变量名也可以用驼峰写入文件 `data/llm-config.json`（见第四节），二者优先级：**环境变量 > 文件**。

---

## 二、从哪里获取（推荐 4 家，国内可直连）

下列服务都提供 **OpenAI 兼容** 接口，注册后建一个 API Key 即可。下面的 baseUrl/model 为常见取值，以各官网最新文档为准。

### 1) 硅基流动 SiliconFlow（推荐，便宜、国内直连、模型多）
- 控制台：https://cloud.siliconflow.cn
- 拿到 Key：左侧「API 密钥」→ 新建
- 配置：
  - `LLM_BASE_URL=https://api.siliconflow.cn`
  - `LLM_MODEL=Qwen/Qwen2.5-7B-Instruct`（或 `deepseek-ai/DeepSeek-V3` 等，模型页复制「模型ID」）
- 文档：https://docs.siliconflow.cn

### 2) DeepSeek（官方，中文友好）
- 控制台：https://platform.deepseek.com
- 拿到 Key：右上「API Keys」→ 创建
- 配置：
  - `LLM_BASE_URL=https://api.deepseek.com`
  - `LLM_MODEL=deepseek-chat`
- 文档：https://api-docs.deepseek.com

### 3) 智谱 AI 开放平台（GLM 系列）
- 控制台：https://open.bigmodel.cn
- 拿到 Key：右上头像 →「API Keys」→ 新建
- 配置：
  - `LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4`（注意末尾是 `/api/paas/v4`，代码会自动拼 `/chat/completions`）
  - `LLM_MODEL=glm-4-flash`（免费额度可用）
- 文档：https://open.bigmodel.cn/dev/api

### 4) 阿里云百炼（通义千问，有免费额度）
- 控制台：https://bailian.console.aliyun.com
- 拿到 Key：右上「API KEY 管理」→ 创建
- 配置：
  - `LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`
  - `LLM_MODEL=qwen-plus`（或 `qwen-turbo` / `qwen-max`）
- 文档：https://help.aliyun.com/zh/model-studio

> 也支持 **OpenAI 官方**（`LLM_BASE_URL=https://api.openai.com`、`LLM_MODEL=gpt-4o-mini` 等），但国内访问不稳，需自备网络。

---

## 三、填写方式（二选一）

### 方式 A：在工具界面填（最简单）
打开「热搜词」页面 → 顶部「AI 翻译配置」卡片 → 填入上面 3 个值 → 点「保存」→ 点「测试连接」。
测试通过（返回翻译示例）后，刷新热搜词即可看到中文。

### 方式 B：环境变量（适合 Oracle / 服务器部署，优先级最高）
启动后端前设置：

```bash
# Linux / macOS
export LLM_BASE_URL=https://api.siliconflow.cn
export LLM_API_KEY=sk-你的密钥
export LLM_MODEL=Qwen/Qwen2.5-7B-Instruct
node server/index.ts   # 或 npx tsx server/index.ts
```

```powershell
# Windows PowerShell（同一个窗口里启动后端才生效）
$env:LLM_BASE_URL="https://api.siliconflow.cn"
$env:LLM_API_KEY="sk-你的密钥"
$env:LLM_MODEL="Qwen/Qwen2.5-7B-Instruct"
npx tsx server/index.ts
```

### 方式 C：写文件 `data/llm-config.json`（本地免环境变量）
项目根目录下创建 `data/llm-config.json`：

```json
{
  "baseUrl": "https://api.siliconflow.cn",
  "apiKey": "sk-你的密钥",
  "model": "Qwen/Qwen2.5-7B-Instruct"
}
```

保存即生效（无需重启；环境变量存在时以环境变量为准）。

---

## 四、排错

- **测试连接返回「连接失败」**：检查 baseUrl 是否多了 `/v1/chat/completions` 后缀（代码会自动拼，你只填到域名或 `/v1` 即可）；检查 key 是否复制完整、是否欠费。
- **连接成功但不返回翻译**：模型必须能输出 **纯 JSON**。部分推理模型（如带 `thinking` 的）会包裹多余内容，换一个普通 instruct 模型（如 `Qwen2.5-7B-Instruct`、`deepseek-chat`、`glm-4-flash`）即可。
- **热搜词没中文**：确认「测试连接」已通过；翻译结果按站点缓存 7 天，可在热搜词页点「刷新」重新拉取并翻译。
- **想用多个模型**：改 `LLM_MODEL` 即可，翻译只用其中 1 个。

---

## 五、安全提示
- `LLM_API_KEY` 是付费密钥，不要提交到 GitHub / 公开仓库。
- 本工具只在本地/你的服务器调用该接口，不会把你的商品数据外泄给第三方（只发送待翻译的热搜词原文）。
