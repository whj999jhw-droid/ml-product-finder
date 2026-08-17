@echo off
chcp 936 >nul
setlocal
set "NODE=C:\Users\whj87\.workbuddy\binaries\node\versions\22.22.2\node.exe"
set "SCRIPT=%~dp0selfcheck-mobile-push.mjs"
if not exist "%NODE%" (
  echo [ERROR] managed node not found: %NODE%
  echo Please install node or edit NODE path in this bat.
  pause
  exit /b 1
)
"%NODE%" "%SCRIPT%" %*
endlocal
