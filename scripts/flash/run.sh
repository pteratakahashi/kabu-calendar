#!/usr/bin/env bash
# 速報の見張り役を動かし続ける（落ちたら30秒後に再起動）。Windows のスタートアップから呼ばれる
cd "$(dirname "$0")/../.." || exit 1
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"  # claude コマンド
mkdir -p .flash
exec 9>.flash/run.lock
flock -n 9 || { echo "すでに動いています"; exit 0; }
while true; do
  .venv/bin/python scripts/flash/flash_watch.py >> .flash/stdout.log 2>&1
  echo "$(date '+%m-%d %H:%M:%S') 見張り役が終了（$?）。30秒後に再起動" >> .flash/watch.log
  sleep 30
done
