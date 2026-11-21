@echo off
chcp 65001 >nul
REM 文字コード: このファイルは UTF-8・改行 CRLF。chcp 65001 で UTF-8 として読ませる（日本語の Windows の既定 932 のままだと、行がつながって壊れる）
REM 捨てラン run_aab99529a1 の Bot（p_1evt）用 pilot 起動スクリプト（V4-1f）。
REM 使い方: この .bat と token.txt と respond-v41f.ts を、先輩のPCの MuseDungeon リポジトリの
REM ルート（一番上のフォルダ、package.json がある場所）に置いて、この .bat をダブルクリック。
REM サーバー（MuseDungeon server、7777番）が起動していることが前提。
setlocal
cd /d "%~dp0"
if not exist token.txt (
  echo token.txt がありません。この .bat と同じフォルダに token.txt を置いてください。
  pause
  exit /b 1
)
set /p TOKEN=<token.txt
if "%TOKEN%"=="" (
  echo token.txt が空です。
  pause
  exit /b 1
)
if not exist respond-v41f.ts (
  echo respond-v41f.ts がありません。この .bat と同じフォルダに置いてください。
  pause
  exit /b 1
)
mkdir bot-test-pilot 2>nul
echo Bot（pilot）を起動します。止めるときはこの窓を閉じるか Ctrl+C。
call npm run pilot -- --token %TOKEN% --dir bot-test-pilot --wake-cmd "npx tsx respond-v41f.ts" --mode coop --server http://127.0.0.1:7777 --max-actions 1500 --max-minutes 30 --max-errors 5
echo.
echo pilot が終了しました。
pause
