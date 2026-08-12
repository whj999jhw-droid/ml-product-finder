@echo off
chcp 65001 >nul
setlocal

REM 一键推送当前项目到 GitHub（双击运行）
REM 如果 GitHub 未登录，会弹出 Windows 凭据管理器/浏览器让你授权。

cd /d "%~dp0"

echo ========================================
echo  当前目录: %CD%
echo  远程仓库:
git remote get-url origin
echo ========================================
echo.

echo [1/3] 检查改动 ...
git status --short

git diff-index --quiet HEAD --
if %errorlevel% == 0 (
    echo.
    echo 没有新的本地改动，直接尝试推送已有提交 ...
) else (
    echo.
    set "MSG=%~1"
    if "%~1"=="" set "MSG=update from local"
    echo [2/3] 提交改动（%MSG%）...
    git add .
    git commit -m "%MSG%"
)

echo.
echo [3/3] 推送到 origin master ...
git push origin master
if %errorlevel% == 0 (
    echo.
    echo ✅ 推送成功
) else (
    echo.
    echo ❌ 推送失败。常见原因：
    echo    - 网络代理没开
    echo    - GitHub 登录过期
    echo    - 远程有更新，需要先 pull 再 push
)

echo.
pause
endlocal
