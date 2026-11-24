@echo off
chcp 65001 >nul
title UNO 联机
cd /d "%~dp0"

:: 检查服务器是否已在运行
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:3000' | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo 服务器已在运行，直接打开游戏...
) else (
  echo 正在启动 UNO 服务器...
  start "UNO-server" /min cmd /c "node server.js"
  timeout /t 2 /nobreak >nul
)

start "" "http://localhost:3000"
exit
