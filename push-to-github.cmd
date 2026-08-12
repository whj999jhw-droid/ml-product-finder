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

    REM 暂存所有改动（.gitignore 已忽略 .env/node_modules/dist/data/certs 等敏感大文件）
    echo 暂存改动中 ...
    git add .

    echo.
    echo 即将提交以下文件：
    git status --short
    echo.
    echo 注意：如果上面出现不该提交的文件（如 .env、证书、node_modules），请先取消并完善 .gitignore。
    set /p CONFIRM=确认提交以上文件？(y/N):
    if /i not "%CONFIRM%"=="y" (
        echo 已取消提交（改动仍保留在本地，未提交，也未暂存）。
        git reset -q
        goto end
    )

    echo [2/3] 提交改动（%MSG%）...
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
:end
endlocal
