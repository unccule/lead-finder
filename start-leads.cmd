@echo off
rem Lead Finder: start by double-click.
chcp 65001 >nul
rem Go to the folder of this file (important for double-click).
cd /d "%~dp0"
title Lead Finder

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установи Node.js 22 с https://nodejs.org и запусти этот файл снова.
  pause
  exit /b 1
)

rem In the background: wait 2 seconds while the server starts, then open the page.
rem (ping -n 3 = pause of about 2 seconds; works even without a keyboard, unlike timeout)
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:3001"

rem The server works while this window is open.
node --disable-warning=ExperimentalWarning src\main.js

echo.
echo Сервер остановлен. Нажми любую клавишу, чтобы закрыть окно.
pause >nul
