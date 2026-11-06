#!/usr/bin/env bash
# deploy/backup.sh 시험 — systemd 처럼 current 심볼릭 링크 경로로 실행하고, SQLite 3개는 node + better-sqlite3 로 실제로 만든다.
# PATH 앞에 가짜 aws 를 둔다 (S3 업로드는 호출만 기록한다).
#   bash deploy/test/backup.test.sh
# macOS 기본 bash(3.2)와 리눅스 bash 에서 모두 돈다.
# check 의 조건식은 eval 로 나중에 펼치므로 일부러 작은따옴표로 쓴다.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NODE_MODULES="$(cd "$HERE/../.." && pwd)/node_modules"
NODE=$(command -v node)
T=$(mktemp -d "${TMPDIR:-/tmp}/asb-backup.XXXXXX")
trap 'rm -rf "$T"' EXIT
PASSES=0
FAILS=0
RC=0

check() {  # <이름> <조건식>
  if eval "$2"; then
    PASSES=$((PASSES + 1)); echo "ok   - $1"
  else
    FAILS=$((FAILS + 1)); echo "FAIL - $1 (rc=$RC)"; sed 's/^/       | /' "$T/out.log"
  fi
}

[ -d "$NODE_MODULES/better-sqlite3" ] || { echo "FAIL - $NODE_MODULES/better-sqlite3 없음 (pnpm install 먼저)"; exit 1; }

# APP_ROOT 처럼: releases/r1/{deploy, node/bin/node, node_modules}, current → releases/r1, data/ 에 DB 3개
A="$T/app"
R="$A/releases/r1"
mkdir -p "$R/deploy" "$R/node/bin" "$A/data" "$T/bin"
cp "$HERE/../backup.sh" "$HERE/../backup-db.mjs" "$R/deploy/"
chmod 0755 "$R/deploy/backup.sh"
ln -s "$NODE" "$R/node/bin/node"
ln -s "$NODE_MODULES" "$R/node_modules"
ln -s releases/r1 "$A/current"
(cd "$R" && "$NODE" -e '
const Database = require("better-sqlite3");
for (const p of process.argv.slice(1)) {
  const db = new Database(p);
  db.exec("create table t (k text primary key, v text)");
  db.prepare("insert into t values (?, ?)").run("k", "synthetic");
  db.close();
}' "$A/data/installations.sqlite" "$A/data/user_tokens.sqlite" "$A/data/thread_history.sqlite")

cat > "$T/bin/aws" <<'EOF'
#!/usr/bin/env bash
echo "aws $*" >> "$ASB_T/calls.log"
EOF
chmod +x "$T/bin/aws"

OLD="20200101T000000Z 20200102T000000Z 20200103T000000Z 20200104T000000Z"
reset_backups() {  # 이전 실행이 남긴 서버 백업 4개
  local d
  rm -rf "$A/backups"
  for d in $OLD; do mkdir -p "$A/backups/$d"; echo old > "$A/backups/$d/marker"; done
}
old_untouched() {
  local d
  for d in $OLD; do [ -f "$A/backups/$d/marker" ] || return 1; done
}
newest() { local d n=""; for d in "$A"/backups/*/; do n=$(basename "$d"); done; echo "$n"; }
count() { find "$2" -mindepth 1 -maxdepth 1 -type "$1" | wc -l | tr -d ' '; }

run() {  # [env 인자…] → 출력 $T/out.log, 종료 코드 $RC. 기본 설정은 DB 3개가 다 있고 KEEP_LOCAL_BACKUPS=3
  reset_backups
  : > "$T/calls.log"
  set +e
  (
    export PATH="$T/bin:$PATH" ASB_T="$T" APP_ROOT="$A" KEEP_LOCAL_BACKUPS=3 AWS_REGION=ap-northeast-2 \
      SLACK_INSTALLATIONS_DB="$A/data/installations.sqlite" SLACK_USER_TOKENS_DB="$A/data/user_tokens.sqlite" \
      SLACK_THREAD_HISTORY_DB="$A/data/thread_history.sqlite"
    unset BACKUP_S3_URI
    env "$@" "$A/current/deploy/backup.sh"
  ) > "$T/out.log" 2>&1
  RC=$?
  set -e
}

run
NEW=$(newest)
check "DB 3개 → 종료 코드 0" '[ "$RC" -eq 0 ]'
check "새 백업에 사본 3개" 'case "$NEW" in ""|2020*) false ;; esac && [ "$(count f "$A/backups/$NEW")" = 3 ] && [ -f "$A/backups/$NEW/installations.sqlite" ] && [ -f "$A/backups/$NEW/user_tokens.sqlite" ] && [ -f "$A/backups/$NEW/thread_history.sqlite" ]'
check "서버 백업은 KEEP_LOCAL_BACKUPS(3)개만 남김" '[ "$(count d "$A/backups")" = 3 ] && [ -d "$A/backups/20200104T000000Z" ] && [ -d "$A/backups/20200103T000000Z" ]'
check "BACKUP_S3_URI 가 없으면 올리지 않음" '! grep -q "^aws " "$T/calls.log"'

run SLACK_THREAD_HISTORY_DB="$A/data/missing.sqlite" BACKUP_S3_URI=s3://asb-test-bucket/backups
check "DB 하나가 없으면 → 실패" '[ "$RC" -ne 0 ]'
check "DB 하나가 없으면 → 오래된 백업을 지우지 않음" 'old_untouched'
check "DB 하나가 없으면 → S3 로 올리지 않음" '! grep -q "^aws s3 cp" "$T/calls.log"'

run -u SLACK_USER_TOKENS_DB
check "DB 변수가 없으면 → 실패" '[ "$RC" -ne 0 ] && grep -q "SLACK_USER_TOKENS_DB" "$T/out.log"'
check "DB 변수가 없으면 → 오래된 백업을 지우지 않음" 'old_untouched'

run BACKUP_S3_URI=s3://asb-test-bucket/backups/
NEW=$(newest)
check "BACKUP_S3_URI → 종료 코드 0" '[ "$RC" -eq 0 ]'
check "BACKUP_S3_URI 로 새 백업을 통째로 올림" 'grep -qxF "aws s3 cp --recursive --only-show-errors $A/backups/$NEW s3://asb-test-bucket/backups/$NEW/ --region ap-northeast-2" "$T/calls.log"'

echo "# pass=$PASSES fail=$FAILS"
[ "$FAILS" -eq 0 ]
