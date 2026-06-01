@echo off
chcp 65001 >nul
setlocal enableextensions
title カウントダウン オーバーレイ サーバー
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [エラー] Node.js が見つかりません。
  echo   https://nodejs.org/ja から LTS 版をインストールしてから、もう一度このファイルを実行してください。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo 初回セットアップ: 必要なパッケージをインストールします (npm install)...
  call npm install
  if errorlevel 1 (
    echo [エラー] npm install に失敗しました。
    pause
    exit /b 1
  )
)

echo.
echo カウントダウン オーバーレイ サーバーを起動します...
echo (このウィンドウを閉じるとサーバーが止まります)
echo.
node server.js

echo.
echo サーバーが終了しました。
pause
