@echo off
chcp 65001 >nul
title 关闭 UNO 服务器

:: 找到占用 3000 端口的进程并结束
set found=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
  taskkill /f /pid %%a >nul 2>nul
  set found=1
)
if %found%==1 (echo UNO 服务器已关闭) else (echo 没有在运行的 UNO 服务器)
timeout /t 2 >nul
exit
