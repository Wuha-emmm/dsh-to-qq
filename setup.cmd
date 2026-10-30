@echo off
rem One-click prep for DSH-to-QQ: checks Node, packs the plugin, prints the install prompt.
rem The final install step runs inside DSH (its plugin manager), so this window gives you
rem a ready-to-paste instruction instead of touching your profile behind DSH's back.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
echo.
pause
