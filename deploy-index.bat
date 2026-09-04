@echo off
setlocal
set SERVER_USER=ubuntu
set SERVER_HOST=ml.w999w.dpdns.org
set REMOTE_DIR=/home/ubuntu/ml-product-finder
set SSH_KEY=%USERPROFILE%\.ssh\id_rsa

where ssh >nul 2>&1
if errorlevel 1 (
  echo [ERROR] ssh not found. Install OpenSSH Client or run this in Git Bash.
  pause
  exit /b 1
)
if not exist "%SSH_KEY%" (
  echo [ERROR] SSH key not found: %SSH_KEY%
  pause
  exit /b 1
)

echo [1/4] Adding host key to known_hosts...
if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh"
ssh-keyscan -H %SERVER_HOST% >> "%USERPROFILE%\.ssh\known_hosts" 2>nul

echo [2/4] Uploading server/index.ts (order price fix)...
scp -i "%SSH_KEY%" "%~dp0server\index.ts" "%SERVER_USER%@%SERVER_HOST%:%REMOTE_DIR%/server/index.ts"
if errorlevel 1 (
  echo [ERROR] index.ts upload failed.
  pause
  exit /b 1
)

echo [3/4] Restarting pm2 ml-finder...
ssh -i "%SSH_KEY%" "%SERVER_USER%@%SERVER_HOST%" "cd %REMOTE_DIR% && pm2 restart ml-finder"
if errorlevel 1 (
  echo [ERROR] pm2 restart failed.
  pause
  exit /b 1
)

echo [4/4] Verifying ml server is up...
ssh -i "%SSH_KEY%" "%SERVER_USER%@%SERVER_HOST%" "curl -s --max-time 15 'https://ml.w999w.dpdns.org/api/ml/stores' | head -c 80"
echo.
echo Done. Order detail price fix deployed.
pause
