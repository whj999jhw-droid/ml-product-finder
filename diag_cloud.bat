@echo off
chcp 65001 >nul
echo ==========================================
echo  云端数据源诊断（SiliconFlow）
echo ==========================================
echo.
echo 正在访问 license-server 的 /diag 端点...
echo 注意：必须先在 CloudBase 控制台重传 license-server 云函数，
echo       否则会返回 {"error":"未知路径: /diag"}（404）。
echo.
curl -s -m 25 "https://mercadoprofit-workbuddy-1-d6g4w4y6b99b811b7.webapps.tcloudbase.com/license-server/diag"
echo.
echo.
echo ==========================================
echo  结果怎么看（看返回的 testResult 字段）：
echo.
echo  "ok"            = Key 有效、能连通，AI 板块应该能生成
echo  "no_key"        = 云端没配 SILICONFLOW_KEY 环境变量
echo  "api_error"     = Key 无效/无额度/模型名错 → 看 error 字段
echo                   401 = Key 无效；402 = 账户无额度需充值
echo                   429 = 频率超限；404 = 模型名不对
echo  "network_error" = 云端出口访问不了 SiliconFlow（本机可直连，
echo                   说明是 CloudBase 国内节点网络限制，需加代理中转）
echo  "未知路径" 404   = 还没重传 license-server，先去重传
echo ==========================================
echo.
pause
