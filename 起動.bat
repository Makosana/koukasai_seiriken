@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo 実行環境が見つかりません。ZIPをすべて展開してから起動してください。
  pause
  exit /b 1
)
"runtime\node.exe" --disable-warning=ExperimentalWarning "app\server.mjs" --open
if errorlevel 1 (
  echo.
  echo 起動できませんでした。上に表示された内容を確認してください。
  pause
)
endlocal
