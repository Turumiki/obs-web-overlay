#!/bin/bash
# ダブルクリックで起動。初回は「開発元未確認」が出たら右クリック→「開く」。
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[エラー] Node.js が見つかりません。"
  echo "  https://nodejs.org/ja から LTS版 をインストールしてから、もう一度このファイルを実行してください。"
  echo ""
  read -n 1 -s -r -p "何かキーを押すと閉じます..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "初回セットアップ: 必要なパッケージをインストールします (npm install)..."
  npm install || { echo "[エラー] npm install に失敗しました。"; read -n 1 -s -r -p "何かキーを押すと閉じます..."; exit 1; }
fi

echo ""
echo "カウントダウン オーバーレイ サーバーを起動します..."
echo "(このウィンドウを閉じるか Ctrl+C でサーバーが止まります)"
echo ""
node server.js
