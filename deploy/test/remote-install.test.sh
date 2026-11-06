#!/usr/bin/env bash
# deploy/remote-install.sh 시험.
# PATH 앞에 가짜 aws·systemctl·curl·runuser·id 를 두고 임시 디렉터리를 운영 서버처럼 쓴다.
#   bash deploy/test/remote-install.test.sh
# macOS 기본 bash(3.2)와 리눅스 bash 에서 모두 돈다.
# check 의 조건식은 eval 로 나중에 펼치므로 일부러 작은따옴표로 쓴다.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)

# 원본과, SSM 으로 실제 보내는 형태(deploy/ssm-run.sh --print-payload, 주석 제거본)를 둘 다 시험한다
if [ -z "${ASB_INSTALL_SCRIPT:-}" ]; then
  P=$(mktemp "${TMPDIR:-/tmp}/asb-payload.XXXXXX")
  bash "$HERE/../ssm-run.sh" --print-payload > "$P"
  size=$(gzip -9n < "$P" | base64 | tr -d '\n' | wc -c | tr -d ' ')
  rc=0
  echo "## remote-install.sh (원본)"
  ASB_INSTALL_SCRIPT="$HERE/../remote-install.sh" bash "$0" || rc=1
  echo "## SSM payload (주석 제거본, gzip+base64 ${size}B)"
  ASB_INSTALL_SCRIPT="$P" bash "$0" || rc=1
  if [ "$size" -gt 5408 ]; then echo "FAIL - SSM payload ${size}B > 5408B"; rc=1; else echo "ok   - SSM payload ${size}B <= 5408B"; fi
  rm -f "$P"
  exit "$rc"
fi
SCRIPT=$ASB_INSTALL_SCRIPT
# id shim 은 uid 0 을 돌려주므로 디렉터리 소유자 검사(TRUSTED_OWNER_UID)에 쓸 실제 uid 를 shim 보다 먼저 읽어 둔다
REAL_UID=$(id -u)
T=$(mktemp -d "${TMPDIR:-/tmp}/asb-install.XXXXXX")
trap 'rm -rf "$T"' EXIT
PASSES=0
FAILS=0
RC=0

check() {  # <이름> <조건식>
  if eval "$2"; then
    PASSES=$((PASSES + 1)); echo "ok   - $1"
  else
    FAILS=$((FAILS + 1)); echo "FAIL - $1"; sed 's/^/       | /' "$T/out.log"
  fi
}

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

host_arch() {
  case "$(uname -m)" in aarch64|arm64) echo arm64 ;; x86_64|amd64) echo x64 ;; *) uname -m ;; esac
}

setup_shims() {
  mkdir -p "$T/bin" "$T/s3" "$T/state" "$T/etc" "$T/units"
  : > "$T/calls.log"

  cat > "$T/bin/aws" <<'EOF'
#!/usr/bin/env bash
echo "aws $*" >> "$ASB_T/calls.log"
if [ "$1" = s3 ] && [ "$2" = cp ]; then
  src=${3#s3://}
  cp "$ASB_T/s3/${src#*/}" "$4"
  exit 0
fi
exit 1
EOF

  # 시작 횟수 제한 흉내: current 가 crash-<release> 로 표시한 판이면 restart/start 는 0 을 돌려주지만 곧 죽어
  # inactive 로 남고 제한(limit-hit)에 걸린다. 제한에 걸린 동안 restart/start 는 거부(1)하고 reset-failed 가 푼다.
  cat > "$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$ASB_T/calls.log"
s="$ASB_T/state"
case "$1" in
  is-active)
    if [ -f "$s/active" ]; then [ "${2:-}" = --quiet ] || echo active; exit 0; fi
    [ "${2:-}" = --quiet ] || echo inactive
    exit 3 ;;
  restart|start)
    rm -f "$s/active"
    if [ -f "$s/limit-hit" ]; then echo "Job for ${2:-} failed: start request repeated too quickly" >&2; exit 1; fi
    rel=$(basename "$(readlink "$APP_ROOT/current" 2>/dev/null || echo none)")
    if [ -f "$s/crash-$rel" ]; then touch "$s/limit-hit"; exit 0; fi
    touch "$s/active" ;;
  stop) rm -f "$s/active" ;;
  reset-failed) rm -f "$s/limit-hit" ;;
esac
exit 0
EOF

  # 현재 release 에 bad-<id> 표시가 있으면 연결 실패(000), 아니면 3000 → 200, 3901 /oauth/callback → 400
  cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http://*) url=$a ;; esac; done
rel=$(basename "$(readlink "$APP_ROOT/current" 2>/dev/null || echo none)")
if [ -f "$ASB_T/state/bad-$rel" ]; then printf 000; exit 7; fi
case "$url" in
  *:3000/) printf 200 ;;
  *:3901/oauth/callback) printf 400 ;;
  *) printf 404 ;;
esac
EOF

  # 서비스 계정으로 실행 — runuser 를 거친 명령에만 ASB_RUNUSER=<계정> 표시가 붙는다
  cat > "$T/bin/runuser" <<'EOF'
#!/usr/bin/env bash
u=""
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
  if [ "$1" = -u ]; then u=$2; shift; fi
  shift
done
shift
export ASB_RUNUSER="$u"
exec "$@"
EOF

  cat > "$T/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -eq 1 ] && [ "$1" = -u ]; then echo 0; exit 0; fi
if [ "${1:-}" = -u ] && [ "${2:-}" = whatap ]; then echo 1000; exit 0; fi
exit 1
EOF

  for c in chown journalctl; do
    printf '#!/usr/bin/env bash\necho "%s $*" >> "$ASB_T/calls.log"\n' "$c" > "$T/bin/$c"
  done
  if ! command -v sha256sum >/dev/null 2>&1; then
    printf '#!/usr/bin/env bash\nexec shasum -a 256 "$@"\n' > "$T/bin/sha256sum"
  fi
  chmod +x "$T"/bin/*
}

make_bundle() {  # <release> [ok|env|otherarch|oldnode]
  local name=$1 kind=${2:-ok} b="$T/build/$1" node_version=v22.23.4 arch
  arch=$(host_arch)
  rm -rf "$b"
  mkdir -p "$b/node/bin" "$b/dist" "$b/deploy/systemd"
  [ "$kind" = oldnode ] && node_version=v20.18.0
  [ "$kind" = otherarch ] && arch=riscv64
  # 묶음의 node 는 실행될 때마다 runuser 표시와 함께 node.log 에 남긴다 (root 로 실행되지 않는지 본다)
  cat > "$b/node/bin/node" <<EOF
#!/usr/bin/env bash
echo "node \$* runuser=\${ASB_RUNUSER:-none}" >> "\$ASB_T/node.log"
case "\${1:-}" in
  --version) echo $node_version ;;
  -e) echo SQLITE-OK ;;
esac
EOF
  chmod +x "$b/node/bin/node"
  echo "// $name" > "$b/dist/index.js"
  cp "$HERE/../systemd/"* "$b/deploy/systemd/"
  cp "$SCRIPT" "$b/deploy/remote-install.sh"
  cp "$HERE/../load-secrets.sh" "$HERE/../backup.sh" "$b/deploy/"
  chmod 0755 "$b"/deploy/*.sh
  [ "$kind" = noexec ] && chmod 0644 "$b/deploy/load-secrets.sh"
  printf 'rev=%s\narch=%s\nnode=%s\n' "$name" "$arch" "$node_version" > "$b/BUILD-INFO"
  [ "$kind" = env ] && echo "SLACK_TRANSPORT=socket" > "$b/.env"
  tar -czf "$T/s3/$name.tar.gz" -C "$b" .
}

run() {  # remote-install.sh 인자… → 출력 $T/out.log, 종료 코드 $RC
  set +e
  (
    export PATH="$T/bin:$PATH" ASB_T="$T" APP_ROOT="${ROOT:-$T/app}" CONFIG_FILE="$T/etc/config.env" \
      UNIT_DIR="$T/units" HEALTH_TRIES=2 HEALTH_INTERVAL=0 KEEP_RELEASES="${KEEP:-5}" TRUSTED_OWNER_UID="$REAL_UID"
    bash "$SCRIPT" "$@"
  ) > "$T/out.log" 2>&1
  RC=$?
  set -e
}

deploy() {  # <release> [sha256 덮어쓰기]
  local s
  s=${2:-$(sha "$T/s3/$1.tar.gz")}
  run deploy --bucket b --key "$1.tar.gz" --sha256 "$s" --release "$1" --region ap-northeast-2
}

current() { basename "$(readlink "$T/app/current" 2>/dev/null || echo none)"; }

[ -f "$SCRIPT" ] || { echo "FAIL - $SCRIPT 없음"; exit 1; }
setup_shims

# 설정 파일이 없으면 S3 를 부르기 전에 멈춘다
make_bundle r00
deploy r00
check "config.env 없음 → 실패" '[ "$RC" -ne 0 ] && grep -q "CONFIG-MISSING" "$T/out.log"'
check "config.env 없음 → S3 다운로드 안 함" '! grep -q "aws s3 cp" "$T/calls.log"'
printf 'SLACK_HTTP_PORT=3000\nWHATAP_OAUTH_PORT=3901\n' > "$T/etc/config.env"

# 첫 배포가 헬스체크에 실패하면 되돌릴 곳이 없다
touch "$T/state/bad-r00"
deploy r00
check "첫 배포 실패 → 실패 표식" '[ "$RC" -ne 0 ] && grep -q "^FIRST-DEPLOY-FAILED" "$T/out.log" && grep -q "^DEPLOY-FAILED" "$T/out.log"'
check "첫 배포 실패 → 서비스가 이 판으로 계속 재시도한다고 알림" 'grep -q "^FIRST-DEPLOY-FAILED release=r00 .*재시도" "$T/out.log"'
check "서비스 로그는 이번 재시작 이후 30줄만" 'grep -Eq "^journalctl -u argus-slack-bot.service --since @[1-9][0-9]* -n 30 -o cat --no-pager$" "$T/calls.log"'

# 정상 배포
make_bundle r01
deploy r01
check "배포 성공 표식" '[ "$RC" -eq 0 ] && grep -q "^DEPLOY-OK release=r01" "$T/out.log"'
check "current → r01" '[ "$(current)" = r01 ]'
check "unit 3개 설치" '[ -f "$T/units/argus-slack-bot.service" ] && [ -f "$T/units/argus-slack-bot-backup.service" ] && [ -f "$T/units/argus-slack-bot-backup.timer" ]'
U="$T/units/argus-slack-bot.service"
check "서비스 unit: 시작 횟수 제한 없이 5초마다 재시작" 'grep -qx "StartLimitIntervalSec=0" "$U" && ! grep -q "^StartLimitBurst=" "$U" && grep -qx "RestartSec=5" "$U"'
check "서비스 unit: ExecStartPre 도 서비스 계정으로 (+ 없음)" 'grep -qx "ExecStartPre=/data/whatap/argus-slack-bot/current/deploy/load-secrets.sh" "$U" && ! grep -q "^ExecStartPre=[-@:!+]*+" "$U"'
check "백업 timer 켬" 'grep -q "systemctl enable --now argus-slack-bot-backup.timer" "$T/calls.log"'
check "data·backups 디렉터리" '[ -d "$T/app/data" ] && [ -d "$T/app/backups" ]'

: > "$T/calls.log"
make_bundle r02
deploy r02
check "두 번째 배포 → r02" '[ "$RC" -eq 0 ] && [ "$(current)" = r02 ]'
check "unit 이 같으면 daemon-reload 안 함" '! grep -q "daemon-reload" "$T/calls.log"'
check "재시작" 'grep -q "systemctl restart argus-slack-bot.service" "$T/calls.log"'

# 헬스체크 실패 → 직전 release 로 자동 복귀, 실패한 release 는 지운다
make_bundle r03
touch "$T/state/bad-r03"
deploy r03
check "실패 배포 → 종료 코드 1" '[ "$RC" -ne 0 ] && grep -q "^DEPLOY-FAILED" "$T/out.log"'
check "자동 복귀 표식" 'grep -q "^ROLLBACK-OK release=r02" "$T/out.log"'
check "current → r02 복귀" '[ "$(current)" = r02 ]'
check "실패한 r03 삭제" '[ ! -e "$T/app/releases/r03" ]'

# 시작하자마자 죽는 판: 헬스 대기 중에 시작 횟수 제한에 걸려도 직전 판으로 되돌린다
make_bundle r20
touch "$T/state/crash-r20"
deploy r20
check "크래시 루프 판 배포 → 실패" '[ "$RC" -ne 0 ] && grep -q "^DEPLOY-FAILED release=r20" "$T/out.log"'
check "크래시 루프 판 배포 → 직전 판 r02 로 ROLLBACK-OK" 'grep -q "^ROLLBACK-OK release=r02 failed=r20" "$T/out.log" && [ "$(current)" = r02 ]'
check "크래시 루프 판 배포 → 실패한 r20 삭제" '[ ! -e "$T/app/releases/r20" ]'
rm -f "$T/state/crash-r20" "$T/state/limit-hit"

# 묶음 검사 실패는 current 를 건드리지 않는다
make_bundle r04
deploy r04 0000000000000000000000000000000000000000000000000000000000000000
check "sha256 불일치 거부" '[ "$RC" -ne 0 ] && grep -q "SHA-MISMATCH" "$T/out.log" && [ "$(current)" = r02 ] && [ ! -e "$T/app/releases/r04" ]'
make_bundle r05 env
deploy r05
check ".env 든 묶음 거부" '[ "$RC" -ne 0 ] && [ "$(current)" = r02 ] && [ ! -e "$T/app/releases/r05" ] && [ ! -e "$T/app/releases/r05.partial" ]'
make_bundle r06 otherarch
deploy r06
check "아키텍처 다른 묶음 거부" '[ "$RC" -ne 0 ] && grep -q "ARCH-MISMATCH" "$T/out.log" && [ "$(current)" = r02 ]'
make_bundle r07 oldnode
deploy r07
check "node 22 아닌 묶음 거부" '[ "$RC" -ne 0 ] && [ "$(current)" = r02 ] && [ ! -e "$T/app/releases/r07" ]'
make_bundle r09 noexec
deploy r09
check "systemd 실행 스크립트에 실행 권한 없는 묶음 거부" '[ "$RC" -ne 0 ] && grep -q "실행 권한 없음" "$T/out.log" && [ "$(current)" = r02 ] && [ ! -e "$T/app/releases/r09" ]'
deploy r02
check "이미 있는 release 이름 거부" '[ "$RC" -ne 0 ] && [ "$(current)" = r02 ]'
run deploy --bucket b --key "r08.tar.gz" --sha256 "$(sha "$T/s3/r02.tar.gz")" --release 'r08;rm -rf /' --region ap-northeast-2
check "release 이름 형식 검사" '[ "$RC" -ne 0 ] && [ "$(current)" = r02 ]'

# rollback = 지금 판 직전에 돌던 판으로
run rollback
check "rollback → r01" '[ "$RC" -eq 0 ] && grep -q "^ROLLBACK-OK release=r01" "$T/out.log" && [ "$(current)" = r01 ]'
run rollback
check "rollback 한 번 더 → r02 (직전 판)" '[ "$RC" -eq 0 ] && [ "$(current)" = r02 ]'
touch "$T/state/bad-r01"
run rollback
check "되돌린 판도 실패 → 원래 판 유지" '[ "$RC" -ne 0 ] && grep -q "^ROLLBACK-FAILED" "$T/out.log" && [ "$(current)" = r02 ]'
rm -f "$T/state/bad-r01"
# 되돌릴 판이 시작하자마자 죽어 시작 횟수 제한에 걸려도 원래 판은 다시 띄운다
touch "$T/state/crash-r01"
run rollback
check "rollback 대상이 크래시 루프 → ROLLBACK-FAILED, 원래 판 r02 health=ok" '[ "$RC" -ne 0 ] && grep -q "^ROLLBACK-FAILED release=r01 restored=r02 health=ok" "$T/out.log" && [ "$(current)" = r02 ]'
rm -f "$T/state/crash-r01" "$T/state/limit-hit"
touch "$T/state/bad-r01" "$T/state/bad-r02"
run rollback
check "rollback 대상과 원래 판 모두 실패 → ROLLBACK-FAILED health=fail" '[ "$RC" -ne 0 ] && grep -q "^ROLLBACK-FAILED release=r01 restored=r02 health=fail" "$T/out.log" && [ "$(current)" = r02 ]'
rm -f "$T/state/bad-r01" "$T/state/bad-r02"

# 중단된 실행이 남긴 .partial 은 다음 배포가 지운다
mkdir -p "$T/app/releases/r19.partial/dist"
KEEP=3
make_bundle r10
deploy r10
check "남은 r19.partial 을 다음 배포가 지움" '[ "$RC" -eq 0 ] && [ ! -e "$T/app/releases/r19.partial" ]'
rm -rf "$T/app/releases/r19.partial"  # 남았더라도 뒤의 보관 개수 검사에 번지지 않게 한다

# 보관 개수: current·직전 판은 항상 남긴다
for r in r11 r12 r13 r14; do make_bundle "$r"; deploy "$r"; done
KEEP=5
check "보관 개수 3" '[ "$(find "$T/app/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d " ")" = 3 ]'
check "current·직전 판 보관" '[ "$(current)" = r14 ] && [ -d "$T/app/releases/r14" ] && [ -d "$T/app/releases/r13" ]'

run status
check "status 출력" '[ "$RC" -eq 0 ] && grep -q "^CURRENT=r14" "$T/out.log" && grep -q "^ARCH=" "$T/out.log" && grep -q "^STATUS-OK" "$T/out.log"'
ROOT="$T/nowhere/app"
run status
ROOT=""
check "status: APP_ROOT 의 상위 디렉터리가 없어도 DISK_FREE_KB=unknown, STATUS-OK" '[ "$RC" -eq 0 ] && grep -q "^DISK_FREE_KB=unknown" "$T/out.log" && grep -q "^STATUS-OK" "$T/out.log"'

# group 이 쓸 수 있는 APP_ROOT 에는 설치하지 않는다 (S3 를 부르기 전에 멈춘다)
make_bundle r21
chmod g+w "$T/app"
: > "$T/calls.log"
deploy r21
chmod g-w "$T/app"
check "group 쓰기 가능한 APP_ROOT → UNSAFE-DIR, S3 다운로드 안 함" '[ "$RC" -ne 0 ] && grep -qF "DEPLOY-FAILED UNSAFE-DIR $T/app (" "$T/out.log" && ! grep -q "aws s3 cp" "$T/calls.log"'
check "UNSAFE-DIR → current 그대로" '[ "$(current)" = r14 ] && [ ! -e "$T/app/releases/r21" ]'

# APP_ROOT 의 상위가 다른 디스크로 가는 심볼릭 링크여도 된다: 링크 자체가 아니라 가리키는 디렉터리를 검사한다.
# 리눅스 심볼릭 링크는 늘 777 이라 macOS 에서도 같게 umask 000 으로 만든다.
mkdir -p "$T/real"
chmod 755 "$T/real"  # 부른 쪽 umask(예: 002)와 상관없이 group 쓰기 없는 디렉터리
(umask 000 && ln -s "$T/real" "$T/lnk")
make_bundle r22
ROOT="$T/lnk/app"
deploy r22
ROOT=""
check "APP_ROOT 의 상위가 심볼릭 링크 → 가리키는 디렉터리로 검사해 배포" '[ "$RC" -eq 0 ] && grep -q "^DEPLOY-OK release=r22" "$T/out.log" && ! grep -q "UNSAFE-DIR" "$T/out.log"'

# 묶음의 코드는 root 로 실행하지 않는다
check "묶음의 node 는 늘 runuser 로 서비스 계정이 실행" '[ -s "$T/node.log" ] && ! grep -qv " runuser=whatap$" "$T/node.log"'

echo "# pass=$PASSES fail=$FAILS"
[ "$FAILS" -eq 0 ]
