#!/usr/bin/env bash
# deploy/ssm-run.sh 시험 — 가짜 aws 가 send-command 의 commands 를 그대로 sh 로 실행해 SSM 을 흉내 낸다.
#   bash deploy/test/ssm-run.test.sh
# 확인: jq 로 만든 명령의 따옴표, 주석 제거본 sha256 대조, mktemp 파일 정리, 인자 전달, 종료 코드.
# check 의 조건식은 eval 로 나중에 펼치므로 일부러 작은따옴표로 쓰고, RC 도 거기서 읽는다.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RUN="$HERE/../ssm-run.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/asb-ssm.XXXXXX")
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

command -v jq >/dev/null || { echo "FAIL - jq 필요"; exit 1; }
mkdir -p "$T/bin" "$T/ssm" "$T/remote-tmp"

cat > "$T/bin/aws" <<'EOF'
#!/usr/bin/env bash
s="$ASB_T/ssm"
op="$1 $2"
shift 2
q=""
params=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --parameters) params=$2; shift 2 ;;
    --query) q=$2; shift 2 ;;
    *) shift ;;
  esac
done
case "$op" in
  "ssm send-command")
    printf '%s' "$params" > "$s/params.json"
    jq -r '.commands[]' "$s/params.json" > "$s/script.sh"
    if TMPDIR="$ASB_T/remote-tmp" sh "$s/script.sh" > "$s/stdout" 2> "$s/stderr"; then
      echo Success > "$s/status"
    else
      echo Failed > "$s/status"
    fi
    echo cmd-0001 ;;
  "ssm get-command-invocation")
    case "$q" in
      Status) cat "$s/status" ;;
      StandardOutputContent) cat "$s/stdout" ;;
      StandardErrorContent) cat "$s/stderr" ;;
    esac ;;
  *) exit 1 ;;
esac
EOF

cat > "$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo inactive
exit 3
EOF

# 원격 쪽 root 판정: ASB_FAKE_UID 로 정한다
cat > "$T/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -eq 1 ] && [ "$1" = -u ]; then echo "${ASB_FAKE_UID:-0}"; exit 0; fi
exit 1
EOF
if ! command -v sha256sum >/dev/null 2>&1; then
  printf '#!/usr/bin/env bash\nexec shasum -a 256 "$@"\n' > "$T/bin/sha256sum"
fi
# 원격 임시 파일 위치를 기록하는 mktemp — 정리 여부를 OS 와 상관없이 확인한다
cat > "$T/bin/mktemp" <<'EOF'
#!/usr/bin/env bash
f="$ASB_T/remote-tmp/tmp.$$.$RANDOM"
if [ "${1:-}" = -d ]; then mkdir "$f"; else : > "$f"; fi
echo "$f" >> "$ASB_T/mktemp.log"
echo "$f"
EOF
chmod +x "$T"/bin/*

tmp_cleaned() {  # 이번 실행에서 만든 원격 임시 파일이 하나 이상 있었고 모두 지워졌다
  [ -s "$T/mktemp.log" ] || return 1
  while IFS= read -r f; do [ ! -e "$f" ] || return 1; done < "$T/mktemp.log"
}

run() {
  : > "$T/mktemp.log"
  set +e
  (
    export PATH="$T/bin:$PATH" ASB_T="$T" AWS_REGION=ap-northeast-2 INSTANCE_ID=i-0123456789abcdef0 \
      SSM_POLL_INTERVAL=0 APP_ROOT="$T/app" CONFIG_FILE="$T/none/config.env"
    bash "$RUN" "$@"
  ) > "$T/out.log" 2>&1
  RC=$?
  set -e
}

run status
check "status → Success, 원격 출력 전달" '[ "$RC" -eq 0 ] && grep -q "^STATUS-OK" "$T/out.log" && grep -q "^CONFIG=missing" "$T/out.log"'
check "원격 임시 파일 정리" 'tmp_cleaned'
check "executionTimeout 900" '[ "$(jq -r ".executionTimeout[0]" "$T/ssm/params.json")" = 900 ]'
check "payload 크기 기록" 'grep -Eq "payload=[0-9]+B" "$T/out.log"'

sha=$(printf '%064d' 0 | tr 0 a)
ASB_FAKE_UID=1000 run deploy --bucket my-bucket.v2 --key argus/x/argus-slack-bot-abc-linux-arm64.tar.gz \
  --sha256 "$sha" --release 20261106000000-abcdef123456 --region ap-northeast-2
check "deploy 인자가 원격까지 전달 (root 검사에서 멈춤)" '[ "$RC" -ne 0 ] && grep -q "^DEPLOY-FAILED root" "$T/out.log" && grep -q "status=Failed" "$T/out.log"'
check "실패해도 원격 임시 파일 정리" 'tmp_cleaned'

: > "$T/ssm/status"
run deploy --bucket 'b;rm -rf /' --key k
check "위험한 인자는 SSM 호출 전에 거부" '[ "$RC" -eq 2 ] && grep -q "허용하지 않는 인자" "$T/out.log" && [ ! -s "$T/ssm/status" ]'

# 원격 스크립트가 바뀌면 sha256 이 맞지 않아 실행하지 않는다 (전송 중 변조 흉내)
cat > "$T/bin/aws-tamper" <<'EOF'
#!/usr/bin/env bash
if [ "$1 $2" = "ssm send-command" ]; then
  args=("$@")
  for i in "${!args[@]}"; do
    if [ "${args[$i]}" = --parameters ]; then
      j=$((i + 1))
      args[j]=$(printf '%s' "${args[$j]}" | jq -c '.commands |= map(sub("gunzip >"; "gunzip | sed s/STATUS-OK/TAMPERED/ >"))')
    fi
  done
  exec "$ASB_T/bin/aws-real" "${args[@]}"
fi
exec "$ASB_T/bin/aws-real" "$@"
EOF
mv "$T/bin/aws" "$T/bin/aws-real"
mv "$T/bin/aws-tamper" "$T/bin/aws"
chmod +x "$T/bin/aws"
run status
check "변조된 스크립트는 sha256 대조에서 멈춤" '[ "$RC" -ne 0 ] && ! grep -q "TAMPERED" "$T/out.log" && ! grep -q "^STATUS-OK" "$T/out.log"'

echo "# pass=$PASSES fail=$FAILS"
[ "$FAILS" -eq 0 ]
