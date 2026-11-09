#!/usr/bin/env bash
# systemd ExecStartPre(서비스 계정, unit 의 샌드박스 안) — Secrets Manager 의 JSON 비밀을 /run/argus-slack-bot/secrets.env 로 쓴다.
# 서비스 unit 의 EnvironmentFile=-/run/argus-slack-bot/secrets.env 가 ExecStart 직전에 이 파일을 읽는다.
# 비밀값은 출력하지 않는다. 키 검사는 deploy/secrets-to-env.mjs (허용 키 5개, 하나라도 없으면 시작을 멈춘다).
# aws 는 IMDS 로 인스턴스 역할을 쓴다. 쓰는 곳은 RuntimeDirectory(/run/argus-slack-bot) 하나다.
# config.env 에서: ASB_SECRETS_ID(비밀 이름 또는 ARN), AWS_REGION
set -euo pipefail

: "${ASB_SECRETS_ID:?ASB_SECRETS_ID 가 /data/whatap/argus-slack-bot/conf/config.env 에 필요해요}"
: "${AWS_REGION:?AWS_REGION 이 /data/whatap/argus-slack-bot/conf/config.env 에 필요해요}"
OUT_DIR=${ASB_RUNTIME_DIR:-/run/argus-slack-bot}
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)

umask 077
mkdir -p "$OUT_DIR"
ASB_SECRETS_TMP=$(mktemp "$OUT_DIR/.secrets.XXXXXX")
trap 'rm -f "${ASB_SECRETS_TMP:-}"' EXIT
aws secretsmanager get-secret-value --secret-id "$ASB_SECRETS_ID" --region "$AWS_REGION" \
    --query SecretString --output text \
  | "$APP_DIR/node/bin/node" "$APP_DIR/deploy/secrets-to-env.mjs" > "$ASB_SECRETS_TMP"
# 변환기가 아무것도 쓰지 않고 끝나면 빈 파일로 서비스를 띄우지 않는다 (임시 파일은 EXIT trap 이 지운다)
[ -s "$ASB_SECRETS_TMP" ] || { echo "[asb] secrets-to-env.mjs 가 아무것도 쓰지 않았어요" >&2; exit 1; }
mv -f "$ASB_SECRETS_TMP" "$OUT_DIR/secrets.env"
echo "[asb] secrets loaded: $(wc -l < "$OUT_DIR/secrets.env" | tr -d ' ') keys from Secrets Manager"
