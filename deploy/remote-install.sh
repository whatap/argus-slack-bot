#!/usr/bin/env bash
# argus-slack-bot 배포 — 인스턴스에서 root 로 실행한다. deploy-prod.yml 이 SSM RunCommand 로 부른다(deploy/ssm-run.sh).
#
#   remote-install.sh status
#   remote-install.sh deploy --bucket B --key K --sha256 S --release R --region REGION
#   remote-install.sh rollback
#
# deploy: S3 묶음을 받아 sha256 을 맞춰 보고 releases/<R> 에 푼 뒤 current 를 바꾸고 재시작한다.
#   헬스체크(3000 `/` 200, 3901 `/oauth/callback` 400)를 못 넘으면 직전 판으로 되돌린다.
#   실패한 판은 직전 판이 헬스체크를 넘었을 때만 지우고, 아니면 둘 다 남긴다.
# rollback: 지금 판 직전에 돌던 판(history 기준)으로 바꾼다. 두 번 하면 원래 판으로 돌아온다.
#   되돌린 판이 헬스체크를 못 넘으면 원래 판으로 돌려놓고 그 판의 헬스 결과(health=ok|fail)를 알린다.
# 묶음의 코드(node)는 root 로 실행하지 않는다. 확인이 필요하면 서비스 계정으로 runuser 한다.
# 결과 표식(워크플로가 읽는다): DEPLOY-OK · DEPLOY-FAILED · FIRST-DEPLOY-FAILED · ROLLBACK-OK · ROLLBACK-FAILED · STATUS-OK
# 사유 표식: CONFIG-MISSING · SHA-MISMATCH · ARCH-MISMATCH · UNSAFE-DIR · UNSAFE-CONFIG · RESTART-FAILED
set -euo pipefail
# SSM 의 umask 와 상관없이 서비스 계정(whatap)이 releases/ 를 읽을 수 있게 한다. 비밀 디렉터리는 따로 0700 으로 만든다.
umask 022

APP_ROOT=${APP_ROOT:-/data/whatap/argus-slack-bot}
# 비밀이 아닌 운영 설정. unit 2개의 EnvironmentFile= 과 같은 곳이어야 한다 (root 소유 conf/, 배포가 바꾸지 않는다)
CONFIG_FILE=${CONFIG_FILE:-$APP_ROOT/conf/config.env}
UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
SERVICE_USER=${SERVICE_USER:-whatap}
KEEP_RELEASES=${KEEP_RELEASES:-5}
HEALTH_TRIES=${HEALTH_TRIES:-20}
HEALTH_INTERVAL=${HEALTH_INTERVAL:-3}
# APP_ROOT 와 그 위·아래 디렉터리, conf/·config.env 의 소유자 uid (시험에서만 바꾼다)
TRUSTED_OWNER_UID=${TRUSTED_OWNER_UID:-0}
SERVICE=argus-slack-bot.service
TIMER=argus-slack-bot-backup.timer
RELEASES="$APP_ROOT/releases"
HISTORY="$APP_ROOT/history"
SLACK_PORT=3000
OAUTH_PORT=3901

say() { echo "[asb] $*"; }
fail() {  # <표식> <사유>
  echo "[asb] $2" >&2
  echo "$1 $2"
  exit 1
}

conf() {  # <KEY> <기본값> — config.env 의 KEY=value (따옴표 없는 형식)
  local v
  # 파일이 없어도 set -e·pipefail 로 멈추지 않고 기본값을 쓴다
  v=$(sed -n "s/^$1=//p" "$CONFIG_FILE" 2>/dev/null | tail -n 1) || v=""
  echo "${v:-$2}"
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

machine_arch() {
  case "$(uname -m)" in aarch64|arm64) echo arm64 ;; x86_64|amd64) echo x64 ;; *) uname -m ;; esac
}

current_release() {
  local t
  t=$(readlink "$APP_ROOT/current" 2>/dev/null) || return 0
  basename "$t"
}

previous_release() {  # <current> — history 에서 current 직전에 돌던 판(연속 중복은 하나로)
  local last="" before="" r
  [ -f "$HISTORY" ] || return 0
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    if [ "$r" != "$last" ]; then before=$last; last=$r; fi
  done < "$HISTORY"
  if [ "$last" = "$1" ] && [ -n "$before" ] && [ -d "$RELEASES/$before" ]; then echo "$before"; fi
}

record() { echo "$1" >> "$HISTORY"; }

switch_to() { ln -sfn "releases/$1" "$APP_ROOT/current"; }

http_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$1$2" || true; }

healthy_once() {
  systemctl is-active --quiet "$SERVICE" || return 1
  [ "$(http_code "$SLACK_PORT" /)" = 200 ] || return 1
  [ "$(http_code "$OAUTH_PORT" /oauth/callback)" = 400 ] || return 1
}

wait_healthy() {
  local i=1
  while [ "$i" -le "$HEALTH_TRIES" ]; do
    if healthy_once; then say "HEALTH-OK attempt=$i"; return 0; fi
    sleep "$HEALTH_INTERVAL"
    i=$((i + 1))
  done
  say "HEALTH-FAIL slack=$(http_code "$SLACK_PORT" /) oauth=$(http_code "$OAUTH_PORT" /oauth/callback) active=$(systemctl is-active "$SERVICE" || true)"
  return 1
}

# 시작 횟수 제한에 걸린 unit 은 restart 를 거부하므로 먼저 reset-failed 로 푼다. 성공 여부는 헬스체크가 정한다.
restart() {
  RESTART_AT=$(date +%s)
  systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE" || say "RESTART-FAILED $SERVICE"
}

# 이번 재시작 이후의 서비스 로그만 짧게 (GitHub Actions 로그에 실린다)
journal_tail() { journalctl -u "$SERVICE" --since "@${RESTART_AT:-0}" -n 30 -o cat --no-pager 2>/dev/null || true; }

# 있으면 TRUSTED_OWNER_UID 소유이고 group·other 쓰기 권한이 없어야 한다.
# 심볼릭 링크는 링크 자체(리눅스는 늘 777)가 아니라 가리키는 곳을 본다 (/data/whatap 이 다른 디스크로 가는 링크일 수 있다).
secure_path() {  # <실패 표식> <경로> <사유 표식>
  local s
  [ -e "$2" ] || return 0
  s=$(stat -L -c '%u %a' "$2" 2>/dev/null || stat -L -f '%u %Lp' "$2") || s=""
  [ "${s% *}" = "$TRUSTED_OWNER_UID" ] && [ $((8#${s#* } & 8#022)) = 0 ] || fail "$1" "$3 $2 ($s)"
}

preflight() {  # <실패 표식>
  local d
  [ "$(id -u)" = 0 ] || fail "$1" "root 로 실행해야 해요"
  [ -f "$CONFIG_FILE" ] || fail "$1" "CONFIG-MISSING $CONFIG_FILE (deploy/config.env.example 참고)"
  id -u "$SERVICE_USER" >/dev/null 2>&1 || fail "$1" "USER-MISSING $SERVICE_USER"
  # root 가 쓰고 실행하는 경로와 서비스 설정을 다른 계정(앱이 침해된 서비스 계정 포함)이 바꿀 수 없어야 한다
  for d in "$(dirname "$APP_ROOT")" "$APP_ROOT" "$RELEASES" "$(dirname "$CONFIG_FILE")"; do secure_path "$1" "$d" UNSAFE-DIR; done
  secure_path "$1" "$CONFIG_FILE" UNSAFE-CONFIG
  SLACK_PORT=$(conf SLACK_HTTP_PORT 3000)
  OAUTH_PORT=$(conf WHATAP_OAUTH_PORT 3901)
}

ensure_layout() {
  mkdir -p "$RELEASES" "$APP_ROOT/data" "$APP_ROOT/backups"
  chown "$SERVICE_USER:$SERVICE_USER" "$APP_ROOT/data" "$APP_ROOT/backups"
  chmod 0700 "$APP_ROOT/data" "$APP_ROOT/backups"
}

install_units() {  # <release 디렉터리> — 묶음의 systemd 파일이 다르면 바꾼다
  local f name changed=0
  for f in "$1"/deploy/systemd/*.service "$1"/deploy/systemd/*.timer; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if ! cmp -s "$f" "$UNIT_DIR/$name"; then
      install -m 0644 "$f" "$UNIT_DIR/$name"
      say "unit updated: $name"
      changed=1
    fi
  done
  if [ "$changed" = 1 ]; then systemctl daemon-reload; fi
  systemctl enable "$SERVICE" >/dev/null
  systemctl enable --now "$TIMER" >/dev/null
}

check_bundle() {  # <풀어 놓은 디렉터리>
  local d=$1 a
  [ -x "$d/node/bin/node" ] || { say "node/bin/node 없음"; return 1; }
  [ -f "$d/dist/index.js" ] || { say "dist/index.js 없음"; return 1; }
  [ -f "$d/BUILD-INFO" ] || { say "BUILD-INFO 없음"; return 1; }
  # systemd 가 바로 실행하는 파일 (ExecStartPre, 백업 ExecStart)
  [ -x "$d/deploy/load-secrets.sh" ] && [ -x "$d/deploy/backup.sh" ] || { say "deploy/*.sh 실행 권한 없음"; return 1; }
  # 봇은 dotenv override 로 작업 디렉터리의 .env 를 환경변수보다 우선한다 — 운영 설정을 덮지 않게 막는다
  if [ -e "$d/.env" ]; then say "묶음에 .env 가 있어요"; return 1; fi
  a=$(sed -n 's/^arch=//p' "$d/BUILD-INFO")
  [ "$a" = "$(machine_arch)" ] || { say "ARCH-MISMATCH bundle=$a machine=$(machine_arch)"; return 1; }
}

smoke_release() {  # <release 디렉터리> — 서비스 계정으로 node 22 와 better-sqlite3 네이티브 로드 확인
  local v
  v=$(cd "$1" && runuser -u "$SERVICE_USER" -- ./node/bin/node --version) || return 1
  case "$v" in v22.*) ;; *) say "node 22 가 아니에요: $v"; return 1 ;; esac
  (cd "$1" && runuser -u "$SERVICE_USER" -- ./node/bin/node -e \
    "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get();console.log('SQLITE-OK')") | grep -q SQLITE-OK
}

prune_releases() {  # <current> <previous> — 둘은 항상 남기고 나머지는 최신 순으로 KEEP_RELEASES 까지
  local d r count=2 names=""
  for d in "$RELEASES"/*/; do
    [ -d "$d" ] || continue
    names="$(basename "$d") $names"   # 이름(=시각) 역순
  done
  for r in $names; do
    case "$r" in "$1"|"$2"|*.partial) continue ;; esac
    count=$((count + 1))
    if [ "$count" -gt "$KEEP_RELEASES" ]; then rm -rf "${RELEASES:?}/$r"; say "pruned $r"; fi
  done
}

cmd_deploy() {
  local bucket="" key="" sha="" release="" region="" tmp dest stage prev actual
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --bucket) bucket=$2 ;;
      --key) key=$2 ;;
      --sha256) sha=$2 ;;
      --release) release=$2 ;;
      --region) region=$2 ;;
      *) fail DEPLOY-FAILED "모르는 인자: $1" ;;
    esac
    shift 2
  done
  [ -n "$bucket" ] && [ -n "$key" ] && [ -n "$region" ] || fail DEPLOY-FAILED "--bucket --key --region 이 필요해요"
  echo "$release" | grep -Eq '^[A-Za-z0-9._-]+$' || fail DEPLOY-FAILED "release 이름 형식: $release"
  echo "$sha" | grep -Eq '^[0-9a-f]{64}$' || fail DEPLOY-FAILED "sha256 형식"
  preflight DEPLOY-FAILED
  # 중단된 실행이 남긴 풀다 만 디렉터리
  rm -rf "${RELEASES:?}"/*.partial
  dest="$RELEASES/$release"
  [ ! -e "$dest" ] || fail DEPLOY-FAILED "이미 있는 release: $release"

  # 함수가 끝난 뒤 EXIT trap 이 돌므로 local 이 아닌 전역 변수에 둔다 (set -u 에서 unbound 로 실패 처리되지 않게)
  ASB_TMP=$(mktemp -d)
  trap 'rm -rf "${ASB_TMP:-}"' EXIT
  tmp=$ASB_TMP
  aws s3 cp "s3://$bucket/$key" "$tmp/bundle.tar.gz" --region "$region" --only-show-errors \
    || fail DEPLOY-FAILED "S3 다운로드 실패: s3://$bucket/$key"
  actual=$(sha256_of "$tmp/bundle.tar.gz")
  [ "$actual" = "$sha" ] || fail DEPLOY-FAILED "SHA-MISMATCH expected=$sha actual=$actual"

  mkdir -p "$RELEASES"
  stage="$dest.partial"
  mkdir "$stage"
  if ! tar --no-same-owner -xzf "$tmp/bundle.tar.gz" -C "$stage" || ! check_bundle "$stage"; then
    rm -rf "$stage"
    fail DEPLOY-FAILED "묶음 검사 실패: $release"
  fi
  chmod -R a+rX,go-w "$stage"
  mv "$stage" "$dest"
  if ! smoke_release "$dest"; then
    rm -rf "$dest"
    fail DEPLOY-FAILED "SMOKE-FAIL $release"
  fi

  ensure_layout
  prev=$(current_release)
  install_units "$dest"
  switch_to "$release"
  say "current: ${prev:-none} -> $release"
  restart
  if wait_healthy; then
    record "$release"
    prune_releases "$release" "${prev:-}"
    echo "DEPLOY-OK release=$release previous=${prev:-none} node=$(sed -n 's/^node=//p' "$dest/BUILD-INFO")"
    return 0
  fi

  journal_tail
  if [ -n "$prev" ] && [ -d "$RELEASES/$prev" ]; then
    install_units "$RELEASES/$prev"
    switch_to "$prev"
    restart
    if wait_healthy; then
      record "$prev"
      rm -rf "${RELEASES:?}/$release"
      echo "ROLLBACK-OK release=$prev failed=$release"
    else
      journal_tail
      echo "ROLLBACK-FAILED release=$prev failed=$release"
    fi
  else
    echo "FIRST-DEPLOY-FAILED release=$release (이전 판 없음. 서비스는 이 판으로 계속 재시도하므로 설정·비밀을 고치면 뜬다. status 로 확인)"
  fi
  echo "DEPLOY-FAILED release=$release"
  return 1
}

cmd_rollback() {
  local cur prev h=ok
  preflight ROLLBACK-FAILED
  cur=$(current_release)
  [ -n "$cur" ] || fail ROLLBACK-FAILED "current 가 없어요"
  prev=$(previous_release "$cur")
  [ -n "$prev" ] || fail ROLLBACK-FAILED "되돌릴 직전 판이 없어요 (current=$cur)"
  install_units "$RELEASES/$prev"
  switch_to "$prev"
  say "current: $cur -> $prev"
  restart
  if wait_healthy; then
    record "$prev"
    echo "ROLLBACK-OK release=$prev from=$cur"
    return 0
  fi
  journal_tail
  # 원래 판으로 돌려놓고 그 판이 다시 뜨는지 본다
  install_units "$RELEASES/$cur"
  switch_to "$cur"
  restart
  wait_healthy || { h=fail; journal_tail; }
  echo "ROLLBACK-FAILED release=$prev restored=$cur health=$h"
  return 1
}

cmd_status() {
  local free
  echo "MACHINE=$(uname -m)"
  echo "ARCH=$(machine_arch)"
  echo "CURRENT=$(current_release)"
  echo "CONFIG=$([ -f "$CONFIG_FILE" ] && echo present || echo missing)"
  echo "SERVICE_USER=$(id -u "$SERVICE_USER" >/dev/null 2>&1 && echo present || echo missing)"
  echo "SERVICE=$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
  echo "AWS_CLI=$(command -v aws || echo missing)"
  # APP_ROOT 의 상위 디렉터리가 없어도 나머지 상태는 보여 준다
  free=$(df -Pk "$(dirname "$APP_ROOT")" 2>/dev/null | awk 'NR==2{print $4}') || free=""
  echo "DISK_FREE_KB=${free:-unknown}"
  if [ -f "$CONFIG_FILE" ]; then
    SLACK_PORT=$(conf SLACK_HTTP_PORT 3000)
    OAUTH_PORT=$(conf WHATAP_OAUTH_PORT 3901)
    echo "HEALTH slack=$(http_code "$SLACK_PORT" /) oauth=$(http_code "$OAUTH_PORT" /oauth/callback)"
  fi
  if [ -f "$HISTORY" ]; then echo "HISTORY=$(tail -n 5 "$HISTORY" | tr '\n' ' ')"; fi
  echo "STATUS-OK"
}

case "${1:-}" in
  status) cmd_status ;;
  deploy) shift; cmd_deploy "$@" ;;
  rollback) cmd_rollback ;;
  *) echo "usage: $0 status | deploy --bucket B --key K --sha256 S --release R --region REGION | rollback" >&2; exit 2 ;;
esac
