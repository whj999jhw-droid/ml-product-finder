@echo off
chcp 65001 >nul
echo ==========================================
echo  本地直测 SiliconFlow（绕过云端，仅验证 Key）
echo ==========================================
echo.
echo 这个脚本只用你的 Key 在本机直接调用 SiliconFlow，
echo Key 不会保存到任何文件、也不会上传给第三方，命令结束后即消失。
echo.
set /p "KEY=请粘贴你的 SiliconFlow API Key（形如 sk-xxxx）: "
if "%KEY%"=="" (
  echo [错误] 未输入 Key。
  pause
  exit /b 1
)
echo.
echo 正在用你的 Key 请求 SiliconFlow...
echo.
curl -s -m 25 -w "{""_http_status"":%{http_code}}" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer %KEY%" ^
  -d "{\"model\":\"Qwen/Qwen2.5-14B-Instruct\",\"messages\":[{\"role\":\"user\",\"content\":\"用中文只回复两个字：测试\"}],\"max_tokens\":20}" ^
  "https://api.siliconflow.cn/v1/chat/completions"
echo.
echo.
echo ==========================================
echo  怎么看：
echo   HTTP 200 + 有 choices 内容 = Key 有效可用（问题在云端，跑 diag_cloud.bat）
echo   HTTP 401 = Key 无效 / 拼错 / 已失效
echo   HTTP 402 = 账户余额不足，去 siliconflow.cn 充值或领额度
echo   HTTP 429 = 频率超限，稍后再试
echo   HTTP 404 = 模型名不对（当前用 Qwen/Qwen2.5-14B-Instruct）
echo   超时/连不上 = 本机网络问题（你这台电脑可能要走代理）
echo ==========================================
echo.
pause
