@echo off
echo ==========================================================
echo  ML orders overdue fix
echo ==========================================================
echo.
echo This script will: upload fix script + server code,
echo run DB cleanup, restart ml-finder, and verify.
echo.

set SERVER_USER=ubuntu
set SERVER_HOST=ml.w999w.dpdns.org
set REMOTE_DIR=/home/ubuntu/ml-product-finder
set SSH_KEY=%USERPROFILE%\.ssh\id_rsa

if not exist "%SSH_KEY%" (
  echo [ERROR] SSH key not found: %SSH_KEY%
  echo If you use PuTTY .ppk, convert it to OpenSSH format first,
  echo or edit SSH_KEY line in this script.
  pause
  exit /b 1
)

echo [1/6] Adding server host key to known_hosts...
if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh"
ssh-keyscan -H %SERVER_HOST% >> "%USERPROFILE%\.ssh\known_hosts" 2>nul
if errorlevel 1 (
  echo [WARN] ssh-keyscan failed. If scp fails with Host key verification failed,
  echo        run in Git Bash: ssh-keyscan -H %SERVER_HOST% ^>^> ~/.ssh/known_hosts
  echo        then rerun this script.
  pause
)

echo [2/6] Uploading fix_shipped_orders.cjs...
scp -i "%SSH_KEY%" "%~dp0fix_shipped_orders.cjs" "%SERVER_USER%@%SERVER_HOST%:%REMOTE_DIR%/fix_shipped_orders.cjs"
if errorlevel 1 (
  echo [ERROR] Upload fix_shipped_orders.cjs failed. Check server/user/path.
  echo        If your key has a passphrase, this window cannot type it.
  echo        Use Pageant or run ssh-add in Git Bash first.
  pause
  exit /b 1
)

echo [3/6] Uploading server/db.ts...
scp -i "%SSH_KEY%" "%~dp0server\db.ts" "%SERVER_USER%@%SERVER_HOST%:%REMOTE_DIR%/server/db.ts"
if errorlevel 1 (
  echo [ERROR] Upload server/db.ts failed.
  pause
  exit /b 1
)

echo [3/6] Uploading server/index.ts...
scp -i "%SSH_KEY%" "%~dp0server\index.ts" "%SERVER_USER%@%SERVER_HOST%:%REMOTE_DIR%/server/index.ts"
if errorlevel 1 (
  echo [ERROR] Upload server/index.ts failed.
  pause
  exit /b 1
)

echo [4/6] Running DB cleanup on server...
ssh -i "%SSH_KEY%" "%SERVER_USER%@%SERVER_HOST%" "cd %REMOTE_DIR% && node fix_shipped_orders.cjs"
if errorlevel 1 (
  echo [ERROR] DB cleanup failed. Common causes:
  echo        - node not found on server
  echo        - data/mlfinder.db not at %REMOTE_DIR%/data
  echo        Screenshot the error above and send it.
  pause
  exit /b 1
)

echo [5/6] Restarting pm2 service ml-finder...
ssh -i "%SSH_KEY%" "%SERVER_USER%@%SERVER_HOST%" "cd %REMOTE_DIR% && pm2 restart ml-finder"
if errorlevel 1 (
  echo [ERROR] pm2 restart failed. Login manually and run:
  echo        cd %REMOTE_DIR% ^&^& pm2 restart ml-finder
  pause
  exit /b 1
)

echo [6/6] Verifying shipped orders no longer have remaining hours...
ssh -i "%SSH_KEY%" "%SERVER_USER%@%SERVER_HOST%" "cd %REMOTE_DIR% && curl -s 'https://ml.w999w.dpdns.org/api/ml/stores/3260d5ed-7bf8-47ec-82c3-07daf496c827/all-orders' | node -e \"const d=JSON.parse(require('fs').readFileSync(0));const bad=d.orders.filter(o=>o.mlStatus==='shipped'&&o.remainingHours!=null);console.log('bad shipped orders:',bad.length);console.log('total orders:',d.orders.length);\""
if errorlevel 1 (
  echo [WARN] Verification command failed, but fix may already be done.
  echo        Pull-to-refresh in App orders page to confirm.
  pause
)

echo.
echo ==========================================================
echo  Done.
echo  Pull-to-refresh in App - Orders to verify.
echo ==========================================================
pause

