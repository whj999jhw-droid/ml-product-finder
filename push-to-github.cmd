@echo off
setlocal

REM One-click push to GitHub. Double-click to run.
REM If GitHub auth expired, it will prompt for credentials.

cd /d "%~dp0"

echo ========================================
echo Current directory: %CD%
echo Remote URL:
git remote get-url origin
echo ========================================
echo.

echo [1/3] Check local changes ...
git status --short

git diff-index --quiet HEAD --
if %errorlevel% == 0 (
    echo.
    echo No new local changes. Push existing commits directly ...
) else (
    echo.
    set "MSG=%~1"
    if "%~1"=="" set "MSG=update from local"

    REM Stage all changes (.gitignore already excludes .env/node_modules/dist/data/certs)
    echo Staging changes ...
    git add .

    echo.
    echo Files to be committed:
    git status --short
    echo.
    echo NOTE: If you see files that should NOT be committed (e.g. .env, certs, node_modules), cancel and update .gitignore first.
    set /p CONFIRM=Confirm commit? (y/N):
    if /i not "%CONFIRM%"=="y" (
        echo Cancelled. Changes remain unstaged/uncommitted.
        git reset -q
        goto end
    )

    echo [2/3] Commit changes ("%MSG%")...
    git commit -m "%MSG%"
)

echo.
echo [3/3] Push to origin master ...
git push origin master
if %errorlevel% == 0 (
    echo.
    echo Push SUCCESS
) else (
    echo.
    echo Push FAILED. Common reasons:
    echo    - Network proxy is off
    echo    - GitHub login expired
    echo    - Remote has new commits, pull first then push
)

echo.
pause
:end
endlocal
