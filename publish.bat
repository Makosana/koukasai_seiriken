@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo 紅華祭 整理券 - 公開版（GitHub Pages）を更新します
echo.

if not exist ".git" (
  echo このフォルダーはGitリポジトリではありません。
  goto fail
)
where git >nul 2>nul
if errorlevel 1 (
  echo Git が見つかりません。
  goto fail
)

rem このPCにビルド環境（以前のビルドで作った一時フォルダー）があれば、先に online を作り直す
set "NODE_DIR=%TEMP%\seiriken-build\node-v24.22.0-win-x64"
set "BUILD_SRC=%TEMP%\seiriken-build\source"
if not exist "%NODE_DIR%\node.exe" goto nobuild
if not exist "%BUILD_SRC%\node_modules\vite" goto nobuild
if not exist "source\.env.online" goto nobuild

echo [1/4] オンライン版をビルドしています...
robocopy "source" "%BUILD_SRC%" /E /XD node_modules /NFL /NDL /NJH /NJS /NP >nul
set "SEIRIKEN_OUTPUT=%CD%"
"%NODE_DIR%\node.exe" "%BUILD_SRC%\build-online.mjs"
if errorlevel 1 (
  echo ビルドに失敗しました。上に表示された内容を確認してください。
  goto fail
)
goto commit

:nobuild
echo [1/4] このPCにはビルド環境がないため、今ある online フォルダーをそのまま公開します。
echo       （source を書き換えた場合は、先にビルドしてください）

:commit
echo.
echo [2/4] 変更を記録しています...
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"') do set "TODAY=%%i"
for /f "tokens=2" %%i in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"') do set "NOWTIME=%%i"
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -q -m "更新 %TODAY% %NOWTIME%"
  if errorlevel 1 goto fail
) else (
  echo       変更はありません。
)

echo.
echo [3/4] GitHub に送っています（main）...
git push
if errorlevel 1 goto fail

echo.
echo [4/4] 公開ページを更新しています（gh-pages）...
git subtree push --prefix online origin gh-pages
if errorlevel 1 goto fail

echo.
echo 完了しました。1〜2分後に反映されます。
echo   来場者用: https://makosana.github.io/koukasai_seiriken/
echo   運営画面: https://makosana.github.io/koukasai_seiriken/#/admin
echo.
pause
endlocal
exit /b 0

:fail
echo.
echo 更新できませんでした。上に表示された内容を確認してください。
pause
endlocal
exit /b 1
