#!/usr/bin/env bash
# deploy/load-secrets.sh 시험 — systemd 처럼 current 심볼릭 링크 경로로 실행한다.
# PATH 앞에 가짜 aws 를 두고, 비밀은 시험용 가짜 값만 쓴다.
#   bash deploy/test/load-secrets.test.sh
# macOS 기본 bash(3.2)와 리눅스 bash 에서 모두 돈다.
# check 의 조건식은 eval 로 나중에 펼치므로 일부러 작은따옴표로 쓴다.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node)
REAL_MKTEMP=$(command -v mktemp)
T=$(mktemp -d "${TMPDIR:-/tmp}/asb-load-secrets.XXXXXX")
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

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# releases/r1 에 load-secrets.sh·secrets-to-env.mjs·node 를 두고 current → releases/r1
R="$T/app/releases/r1"
mkdir -p "$R/deploy" "$R/node/bin" "$T/bin"
cp "$HERE/../load-secrets.sh" "$HERE/../secrets-to-env.mjs" "$R/deploy/"
chmod 0755 "$R/deploy/load-secrets.sh"
ln -s "$NODE" "$R/node/bin/node"
ln -s releases/r1 "$T/app/current"

# 가짜 aws — ASB_FAKE_SECRET 을 SecretString 처럼 출력한다. ASB_FAKE_AWS_FAIL=1 이면 실패한다.
cat > "$T/bin/aws" <<'EOF'
#!/usr/bin/env bash
echo "aws $*" >> "$ASB_T/calls.log"
if [ "${ASB_FAKE_AWS_FAIL:-0}" = 1 ]; then echo "An error occurred (AccessDeniedException)" >&2; exit 1; fi
printf '%s\n' "$ASB_FAKE_SECRET"
EOF
# 만든 임시 파일을 기록하는 mktemp — 정리 여부를 위치와 상관없이 확인한다
cat > "$T/bin/mktemp" <<EOF
#!/usr/bin/env bash
f=\$("$REAL_MKTEMP" "\$@") || exit 1
echo "\$f" >> "\$ASB_T/mktemp.log"
echo "\$f"
EOF
chmod +x "$T"/bin/*

KEYS="SLACK_SIGNING_SECRET SLACK_CLIENT_SECRET SLACK_STATE_SECRET SLACK_TOKENS_ENCRYPTION_KEY WHATAP_OAUTH_CLIENT_SECRET"
secret_json() {  # [뺄 키] — 시험용 가짜 값
  local k sep="" out="{"
  for k in $KEYS; do
    [ "$k" != "${1:-}" ] || continue
    out="$out$sep\"$k\":\"asb-synthetic-$k\""
    sep=","
  done
  echo "$out}"
}

run() {  # <비밀 JSON> [aws 실패면 1] → 출력 $T/out.log, 종료 코드 $RC
  rm -rf "$T/run"
  : > "$T/mktemp.log"
  set +e
  (
    export PATH="$T/bin:$PATH" ASB_T="$T" ASB_FAKE_SECRET="$1" ASB_FAKE_AWS_FAIL="${2:-0}" \
      ASB_SECRETS_ID=asb-test-secret AWS_REGION=ap-northeast-2 ASB_RUNTIME_DIR="$T/run"
    "$T/app/current/deploy/load-secrets.sh"
  ) > "$T/out.log" 2>&1
  RC=$?
  set -e
}

tmp_cleaned() {  # 이번 실행에서 임시 파일을 하나 이상 만들었고 모두 지웠다
  [ -s "$T/mktemp.log" ] || return 1
  while IFS= read -r f; do [ ! -e "$f" ] || return 1; done < "$T/mktemp.log"
  [ -z "$(find "$T/run" -name '.secrets.*' 2>/dev/null)" ]
}

run "$(secret_json)"
check "비밀 5개 → 종료 코드 0" '[ "$RC" -eq 0 ]'
check "secrets.env 5줄" '[ -f "$T/run/secrets.env" ] && [ "$(wc -l < "$T/run/secrets.env" | tr -d " ")" = 5 ]'
check "secrets.env 권한 600" '[ "$(mode_of "$T/run/secrets.env")" = 600 ]'
check "임시 파일 남기지 않음" 'tmp_cleaned'
check "비밀값을 출력하지 않음" '! grep -q "asb-synthetic" "$T/out.log"'
check "aws 에 비밀 이름·리전 전달" 'grep -q "aws secretsmanager get-secret-value --secret-id asb-test-secret --region ap-northeast-2" "$T/calls.log"'

run "$(secret_json SLACK_STATE_SECRET)"
check "키가 빠진 비밀 → 실패" '[ "$RC" -ne 0 ]'
check "키가 빠진 비밀 → secrets.env 없음" '[ ! -e "$T/run/secrets.env" ]'
check "키가 빠진 비밀 → 임시 파일 남기지 않음" 'tmp_cleaned'
check "키가 빠진 비밀 → 비밀값을 출력하지 않음" '! grep -q "asb-synthetic" "$T/out.log"'

run "$(secret_json)" 1
check "aws 실패 → 실패" '[ "$RC" -ne 0 ]'
check "aws 실패 → secrets.env 없음" '[ ! -e "$T/run/secrets.env" ]'

# 변환기가 입력을 다 읽고도 아무것도 쓰지 않고 0 으로 끝나도(CLI 본문이 돌지 않는 경우 등) 빈 secrets.env 를 만들지 않는다
echo 'import { readFileSync } from "node:fs"; readFileSync(0);' > "$R/deploy/secrets-to-env.mjs"
run "$(secret_json)"
check "변환 결과가 비면 → 실패" '[ "$RC" -ne 0 ]'
check "변환 결과가 비면 → secrets.env 없음" '[ ! -e "$T/run/secrets.env" ]'
check "변환 결과가 비면 → 임시 파일 남기지 않음" 'tmp_cleaned'

echo "# pass=$PASSES fail=$FAILS"
[ "$FAILS" -eq 0 ]
