#!/bin/bash
# 단순 supervisor — 봇이 크래시하면 2초 후 재시작.
# Socket Mode 의 finity state machine 버그 (server explicit disconnect)
# 같은 transient 이슈에 대비. systemd 로 옮기면 이 스크립트 불필요.
#
# 사용: ./scripts/run-with-supervisor.sh > /tmp/argus-slack-bot.log 2>&1 &

cd "$(dirname "$0")/.."

while true; do
  echo "[supervisor] $(date '+%Y-%m-%d %H:%M:%S') starting bot..."
  node dist/index.js
  EXIT=$?
  echo "[supervisor] $(date '+%Y-%m-%d %H:%M:%S') bot exited code=$EXIT — restart in 2s"
  sleep 2
done
