@echo off
chcp 65001 >nul
title UNO 摸鱼模式
cd /d "%~dp0"

:: 检查服务器是否已在运行
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:3000' | Out-Null; exit 0 } catch { exit 1 }"
if not %errorlevel%==0 (
  echo 正在启动 UNO 服务器...
  start "UNO-server" /min cmd /c "node server.js"
  timeout /t 2 /nobreak >nul
)

:: 用 app 模式开一个小窗（无地址栏、无标签页，像个小应用）
where chrome >nul 2>nul
if %errorlevel%==0 (
  start "" chrome --app=http://localhost:3000 --window-size=440,720 --window-position=120,60
) else (
  start "" msedge --app=http://localhost:3000 --window-size=440,720 --window-position=120,60
)
exit
