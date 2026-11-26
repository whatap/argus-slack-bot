#!/usr/bin/env bash
# Jenkins 잡이 하루 한 번 실행 — 설치·사용자 토큰 SQLite 2개를 온라인 백업하고 S3 로 올린다.
# config.env 에서: SLACK_INSTALLATIONS_DB, SLACK_USER_TOKENS_DB(둘 다 필수), BACKUP_S3_URI(선택), AWS_REGION
# 평문 대화 기록(thread_history)은 백업하지 않는다. 필수 DB 가 없으면 업로드·정리하지 않는다.
# 사본은 토큰이 암호화된 그대로다. 복구에는 같은 SLACK_TOKENS_ENCRYPTION_KEY 가 필요하다.
set -euo pipefail

: "${SLACK_INSTALLATIONS_DB:?SLACK_INSTALLATIONS_DB 가 /data/whatap/plugin/argus-slack-bot/conf/config.env 에 필요해요}"
: "${SLACK_USER_TOKENS_DB:?SLACK_USER_TOKENS_DB 가 /data/whatap/plugin/argus-slack-bot/conf/config.env 에 필요해요}"

APP_ROOT=${APP_ROOT:-/data/whatap/plugin/argus-slack-bot}
KEEP_LOCAL=${KEEP_LOCAL_BACKUPS:-7}
REL="$APP_ROOT/current"

umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$APP_ROOT/backups/$stamp"
mkdir -p "$APP_ROOT/backups"
# 같은 시각의 옛 디렉터리를 재사용하면 제외한 대화 기록까지 업로드할 수 있으므로 실패시킨다.
mkdir "$out"
"$REL/node/bin/node" "$REL/deploy/backup-db.mjs" "$out" \
  "$SLACK_INSTALLATIONS_DB" "$SLACK_USER_TOKENS_DB"

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
