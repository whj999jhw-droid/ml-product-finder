@echo off
setlocal
set SERVER_USER=ubuntu
set SERVER_HOST=ml.w999w.dpdns.org
set SSH_KEY=%USERPROFILE%\.ssh\id_rsa

where ssh >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ssh command not found. Install OpenSSH client first:
  echo   Settings - Apps - Optional features - Add a feature - OpenSSH Client
  echo   Or run this script in Git Bash.
  pause
  exit /b 1
)

if not exist "%SSH_KEY%" (
  echo [ERROR] SSH key not found: %SSH_KEY%
  echo Edit line 4 of this script if your key path is different.
  pause
  exit /b 1
)

echo Adding server host key to known_hosts to avoid yes/no prompt...
if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh"
ssh-keyscan -H %SERVER_HOST% >> "%USERPROFILE%\.ssh\known_hosts" 2>nul
echo.

echo ==========================================================
echo  ML Server Health Check
echo  Target: %SERVER_USER%@%SERVER_HOST%
echo ==========================================================
echo.
echo [1/5] Public endpoint check...
curl -s --max-time 10 "https://ml.w999w.dpdns.org/api/ml/stores" -w "HTTP code: %{http_code}\n"
echo.
echo [2/5] pm2 status on server...
ssh -i "%SSH_KEY%" "%SERVER_USER%@%SERVER_HOST%" "pm2 status"
echo.
echo [3/5] Last 30 lines of ml-finder log...
ssh -i "%SSH_KEY%" "%SERVER_USER%@%SERVER_HOST%" "pm2 logs ml-finder --lines 30 --nostream"
echo.
echo [4/5] Local port 3000 response...
ssh -i "%SSH_KEY%" "%SERVER_USER%@%SERVER_HOST%" "curl -s --max-time 5 http://127.0.0.1:3000/api/ml/stores -w 'HTTP %{http_code}' | head -c 300"
echo.
echo.
echo [5/5] cloudflared tunnel status...
ssh -i "%SSH_KEY%" "%SERVER_USER%@%SERVER_HOST%" "sudo systemctl status cloudflared --no-pager | head -25"
echo.
echo ==========================================================
echo  Done. If you see EADDRINUSE / exited / errored / inactive,
echo  please take a screenshot.
echo  If [4/5] is OK but public endpoint returns 502,
echo  cloudflared tunnel is down.
echo ==========================================================
pause

