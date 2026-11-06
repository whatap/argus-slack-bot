#!/usr/bin/env bash
# systemd argus-slack-bot-backup.service (timer 로 하루 한 번) — SQLite 3개를 온라인 백업하고 S3 로 올린다.
# config.env 에서: SLACK_INSTALLATIONS_DB, SLACK_USER_TOKENS_DB, SLACK_THREAD_HISTORY_DB(셋 다 필수), BACKUP_S3_URI(선택), AWS_REGION
# DB 가 하나라도 없으면 실패로 끝나고 S3 업로드와 서버 백업 정리를 하지 않는다 (이전 백업은 그대로 남는다).
# 사본은 토큰이 암호화된 그대로다. 복구에는 같은 SLACK_TOKENS_ENCRYPTION_KEY 가 필요하다.
set -euo pipefail

: "${SLACK_INSTALLATIONS_DB:?SLACK_INSTALLATIONS_DB 가 /etc/argus-slack-bot/config.env 에 필요해요}"
: "${SLACK_USER_TOKENS_DB:?SLACK_USER_TOKENS_DB 가 /etc/argus-slack-bot/config.env 에 필요해요}"
: "${SLACK_THREAD_HISTORY_DB:?SLACK_THREAD_HISTORY_DB 가 /etc/argus-slack-bot/config.env 에 필요해요}"
APP_ROOT=${APP_ROOT:-/data/whatap/argus-slack-bot}
KEEP_LOCAL=${KEEP_LOCAL_BACKUPS:-7}
REL="$APP_ROOT/current"

umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$APP_ROOT/backups/$stamp"
mkdir -p "$out"
"$REL/node/bin/node" "$REL/deploy/backup-db.mjs" "$out" \
  "$SLACK_INSTALLATIONS_DB" "$SLACK_USER_TOKENS_DB" "$SLACK_THREAD_HISTORY_DB"

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp --recursive --only-show-errors "$out" "${BACKUP_S3_URI%/}/$stamp/" --region "${AWS_REGION:?}"
  echo "[asb-backup] uploaded ${BACKUP_S3_URI%/}/$stamp/"
else
  echo "[asb-backup] BACKUP_S3_URI 미설정 — 서버에만 보관"
fi

# 서버에는 최근 KEEP_LOCAL 개만 남긴다 (glob 은 이름순 = 시각순)
dirs=("$APP_ROOT"/backups/*/)
total=${#dirs[@]}
if [ -d "${dirs[0]}" ] && [ "$total" -gt "$KEEP_LOCAL" ]; then
  i=0
  while [ "$i" -lt $((total - KEEP_LOCAL)) ]; do
    rm -rf "${dirs[$i]}"
    i=$((i + 1))
  done
fi
