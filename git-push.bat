@echo off
cd /d "%~dp0"
echo ============================================
echo  将本地提交推送到 GitHub (ml-product-finder)
echo  仓库目录: %~dp0
echo ============================================
echo.
git push
echo.
echo 退出码: %errorlevel%
echo （若弹出 GitHub 登录窗口，登录即可；若已缓存凭据会自动通过）
pause
