#!/usr/bin/env bash
# deploy/remote-install.sh 를 SSM RunCommand 로 인스턴스에서 root 로 실행하고 결과를 출력한다 (deploy-prod.yml 이 쓴다).
#   deploy/ssm-run.sh <status|deploy|rollback> [remote-install.sh 인자...]
#   deploy/ssm-run.sh --print-payload      실제로 보내는 스크립트(주석 제거본)를 출력 — 시험용
# 환경: AWS_REGION, INSTANCE_ID, OIDC 로 받은 AWS 자격. 필요: aws cli v2, jq, gzip, base64, sha256sum
# 스크립트는 주석 줄을 빼고 gzip+base64 로 명령에 실어 보내고, 인스턴스에서 sha256 을 맞춘 뒤 실행한다 (S3 를 거치지 않는다).
# 종료 코드: SSM 상태가 Success 면 0.
set -euo pipefail

# SendCommand 파라미터 한도는 문서로 확인되지 않는다. Argus 운영 배포가 실어 본 크기(gzip+base64 5,408바이트)를 넘기지 않는다.
MAX_PAYLOAD=5408
script="$(cd "$(dirname "$0")" && pwd)/remote-install.sh"

# 첫 줄(shebang)은 두고 빈 줄과 주석만 있는 줄을 뺀다. heredoc 안의 줄까지 지울 수 있어 remote-install.sh 에는 heredoc 을 쓰지 않는다.
payload() { awk 'NR == 1 || !/^[[:space:]]*(#|$)/' "$script"; }

if [ "${1:-}" = --print-payload ]; then payload; exit 0; fi
: "${AWS_REGION:?}" "${INSTANCE_ID:?}"
[ "$#" -ge 1 ] || { echo "usage: $0 <status|deploy|rollback> [args...]" >&2; exit 2; }
for a in "$@"; do
  # 원격 셸 명령줄에 그대로 들어가므로 안전한 문자만 허용한다
  case "$a" in *[!A-Za-z0-9._/:=-]*|'') echo "허용하지 않는 인자: $a" >&2; exit 2 ;; esac
done
if grep -q '<<' "$script"; then echo "remote-install.sh 에 heredoc 이 있으면 주석 제거가 안전하지 않아요" >&2; exit 1; fi

sha=$(payload | sha256sum | cut -d' ' -f1)
b64=$(payload | gzip -9n | base64 | tr -d '\n')
if [ "${#b64}" -gt "$MAX_PAYLOAD" ]; then
  echo "SSM 으로 보낼 스크립트가 커요: ${#b64} > $MAX_PAYLOAD 바이트 (remote-install.sh 를 줄이거나 S3 경유로 바꿔야 해요)" >&2
  exit 1
fi
params=$(jq -nc --arg b64 "$b64" --arg sha "$sha" --arg args "$*" '{
  commands: [
    "set -eu",
    "f=$(mktemp)",
    "trap \"rm -f $f\" EXIT",
    ("echo " + $b64 + " | base64 -d | gunzip > \"$f\""),
    ("echo \"" + $sha + "  $f\" | sha256sum -c --quiet -"),
    ("bash \"$f\" " + $args)
  ],
  executionTimeout: ["900"]
}')

cid=$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --comment "argus-slack-bot $1 run=${GITHUB_RUN_ID:-manual}" \
  --parameters "$params" --query Command.CommandId --output text)
echo "[ssm] $1 command=$cid instance=$INSTANCE_ID payload=${#b64}B" >&2

status=Pending
for _ in $(seq 1 200); do
  sleep "${SSM_POLL_INTERVAL:-5}"
  status=$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$cid" --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)
  case "$status" in Success|Failed|Cancelled|TimedOut) break ;; esac
done

aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$cid" --instance-id "$INSTANCE_ID" \
  --query StandardOutputContent --output text
err=$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$cid" --instance-id "$INSTANCE_ID" \
  --query StandardErrorContent --output text)
if [ -n "$err" ] && [ "$err" != None ]; then printf '%s\n' "$err" | sed 's/^/[stderr] /' >&2; fi
echo "[ssm] status=$status" >&2
[ "$status" = Success ]
