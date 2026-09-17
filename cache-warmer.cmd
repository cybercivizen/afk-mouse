@echo off
rem Starts the widget with a console attached, so log lines stay visible.
rem For a clean, console-free start, double-click cache-warmer.vbs instead.
rem Pass --cli for the terminal-only front end.
cd /d "%~dp0"
node cache-warmer.js %*
pause
