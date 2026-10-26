@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
"runtime\node.exe" --disable-warning=ExperimentalWarning "app\control.mjs"
if errorlevel 1 pause
endlocal
