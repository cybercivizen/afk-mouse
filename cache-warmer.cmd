@echo off
rem Starts the widget with a console attached, so log lines stay visible.
rem For a clean, console-free start, double-click cache-warmer.vbs instead.
rem Pass --cli for the terminal-only front end (plain Node, no Electron).
cd /d "%~dp0"
if /i "%~1"=="--cli" (
  node cache-warmer.js %*
) else (
  npx electron . %*
)
pause
