#!/usr/bin/env bash
# PCが止まっている間も GitHub 側（↻・1日2回の更新）で速報を判定できるように、
# Claude のプランの長期トークンを作って GitHub の Secrets（CLAUDE_CODE_OAUTH_TOKEN）に登録する。
# 使い方: Ubuntu のターミナルで  bash ~/kabu-calendar/scripts/flash/setup_ci_token.sh
set -e
export PATH="$HOME/.npm-global/bin:$PATH"
echo "① ブラウザが開くので、Claude にログインして「Authorize」（許可）を押してください。"
echo "   終わると、このターミナルに sk-ant-oat01- で始まる長い文字が表示されます。"
echo
claude setup-token
echo
echo "② 上に表示された sk-ant-oat01-… の文字をコピーして、ここに貼り付けて Enter（画面には表示されません）:"
read -rs TOKEN
TOKEN="$(echo "$TOKEN" | tr -d '[:space:]')"
case "$TOKEN" in sk-ant-*) ;; *) echo "sk-ant- で始まる文字ではありませんでした。もう一度やり直してください。"; exit 1;; esac
printf '%s' "$TOKEN" | gh secret set CLAUDE_CODE_OAUTH_TOKEN -R pteratakahashi/kabu-calendar
echo
echo "③ 登録できました。このウィンドウは閉じて大丈夫です。"
