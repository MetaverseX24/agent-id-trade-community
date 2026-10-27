@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer LTS from https://nodejs.org/ then try again.
  pause
  exit /b 1
)
node "scripts\setup.mjs" %*
if errorlevel 1 pause
