#!/usr/bin/env bash
# 배포 묶음 실행 확인 — 대상 아키텍처의 리눅스(컨테이너)에서 묶음 안의 node 로 돌린다. curl 없이 node fetch 로 확인한다.
#   bash deploy/test/smoke.sh <bundle.tar.gz>        묶음을 풀어서 확인 (CI)
#   NODE_BIN=node bash deploy/test/smoke.sh --dir .  작업 트리의 dist 로 같은 확인 (로컬)
# 1) node 22  2) better-sqlite3 네이티브 로드  3) 진입점을 HTTP 다중 워크스페이스 + 와탭 로그인 설정(가짜 비밀)으로 띄워
#    Slack 포트 `/`·`/privacy` 200, `/slack/install` 302 → slack.com, 서명 없는 POST /slack/events 401, 로그인 포트 `/oauth/callback` 400
#    4) SIGTERM 으로 정상 종료
# 포트: SMOKE_SLACK_PORT(기본 3000) → SLACK_HTTP_PORT, SMOKE_OAUTH_PORT(기본 3901) → WHATAP_OAUTH_PORT.
#   로컬에서 같은 포트를 쓰는 프로세스가 있으면 바꾼다 (CI 는 기본값).
set -euo pipefail

SLACK_PORT=${SMOKE_SLACK_PORT:-3000}
OAUTH_PORT=${SMOKE_OAUTH_PORT:-3901}
W=$(mktemp -d "${TMPDIR:-/tmp}/asb-smoke.XXXXXX")
BOT_PID=""
cleanup() { if [ -n "$BOT_PID" ]; then kill "$BOT_PID" 2>/dev/null || true; fi; rm -rf "$W"; }
trap cleanup EXIT

if [ "${1:-}" = --dir ]; then
  APP=$(cd "${2:?디렉터리}" && pwd)
  NODE=$(command -v "${NODE_BIN:-node}")
else
  mkdir -p "$W/app"
  tar -xzf "${1:?bundle.tar.gz}" -C "$W/app"
  APP="$W/app"
  NODE="$APP/node/bin/node"
  echo "[smoke] $(tr '\n' ' ' < "$APP/BUILD-INFO")"
fi
cd "$APP"
# 봇은 dotenv override 로 작업 디렉터리의 .env 를 우선한다 — 실제 토큰으로 붙지 않게 막는다
[ ! -e .env ] || { echo "[smoke] FAIL $APP/.env 가 있어요" >&2; exit 1; }

v=$("$NODE" --version)
echo "[smoke] node $v"
case "$v" in v22.*) ;; *) echo "[smoke] FAIL node 22 가 아니에요" >&2; exit 1 ;; esac
"$NODE" -e "const D=require('better-sqlite3');console.log('[smoke] sqlite',new D(':memory:').prepare('select sqlite_version() v').get().v)"

mkdir -p "$W/data"
env -i PATH=/usr/bin:/bin HOME="$W" NODE_ENV=production \
  SLACK_TRANSPORT=http SLACK_HTTP_PORT="$SLACK_PORT" SLACK_LISTEN_HOST=127.0.0.1 \
  SLACK_PUBLIC_URL=https://argus-bot.example.invalid SLACK_APP_ID=A000SMOKE \
  SLACK_CLIENT_ID=1111.2222 SLACK_CLIENT_SECRET=smoke-client SLACK_STATE_SECRET=smoke-state \
  SLACK_SIGNING_SECRET=smoke-signing SLACK_TOKENS_ENCRYPTION_KEY=smoke-key \
  SLACK_INSTALLATIONS_DB="$W/data/installations.sqlite" SLACK_USER_TOKENS_DB="$W/data/user_tokens.sqlite" \
  SLACK_THREAD_HISTORY_DB="$W/data/thread_history.sqlite" \
  WHATAP_OAUTH_ISSUER=https://whatap.example.invalid WHATAP_OAUTH_CLIENT_ID=argus-slack-bot \
  WHATAP_OAUTH_CLIENT_SECRET=smoke-whatap WHATAP_OAUTH_REDIRECT_URI=https://argus-bot.example.invalid/oauth/callback \
  WHATAP_OAUTH_PORT="$OAUTH_PORT" WHATAP_OAUTH_LISTEN_HOST=127.0.0.1 ARGUS_URL=http://127.0.0.1:9 \
  "$NODE" dist/index.js > "$W/bot.log" 2>&1 &
BOT_PID=$!

if ! SLACK_PORT="$SLACK_PORT" OAUTH_PORT="$OAUTH_PORT" "$NODE" --input-type=module - <<'EOF'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url, init = {}) => fetch(url, { redirect: "manual", ...init });
const { SLACK_PORT, OAUTH_PORT } = process.env;
const slack = `http://127.0.0.1:${SLACK_PORT}`;
const oauth = `http://127.0.0.1:${OAUTH_PORT}`;
let up = false;
// arm64 는 CI 에서 QEMU 로 돌아 느리다 — 최대 90초 기다린다
for (let i = 0; i < 180 && !up; i++) {
  try { await get(`${slack}/`); await get(`${oauth}/oauth/callback`); up = true; } catch { await sleep(500); }
}
if (!up) { console.error("[smoke] FAIL 리스너가 90초 안에 뜨지 않았어요"); process.exit(1); }
const checks = [
  [`GET ${SLACK_PORT} /`, await get(`${slack}/`), (r) => r.status === 200],
  [`GET ${SLACK_PORT} /privacy`, await get(`${slack}/privacy`), (r) => r.status === 200],
  [`GET ${SLACK_PORT} /slack/install`, await get(`${slack}/slack/install`),
    (r) => r.status === 302 && new URL(r.headers.get("location")).hostname === "slack.com"],
  [`POST ${SLACK_PORT} /slack/events (서명 없음)`, await get(`${slack}/slack/events`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), (r) => r.status === 401],
  [`GET ${OAUTH_PORT} /oauth/callback (state 없음)`, await get(`${oauth}/oauth/callback`), (r) => r.status === 400],
];
let failed = 0;
for (const [name, res, ok] of checks) {
  const pass = ok(res);
  if (!pass) failed++;
  console.log(`[smoke] ${pass ? "ok  " : "FAIL"} ${name} → ${res.status}`);
}
process.exit(failed ? 1 : 0);
EOF
then
  echo "[smoke] bot.log:" >&2
  sed 's/^/  | /' "$W/bot.log" >&2
  exit 1
fi

kill -TERM "$BOT_PID"
rc=0
wait "$BOT_PID" || rc=$?
BOT_PID=""
grep -q "received SIGTERM" "$W/bot.log" || { echo "[smoke] FAIL SIGTERM 처리 로그 없음" >&2; sed 's/^/  | /' "$W/bot.log" >&2; exit 1; }
[ "$rc" -eq 0 ] || { echo "[smoke] FAIL 종료 코드 $rc" >&2; exit 1; }
for f in installations user_tokens thread_history; do
  [ -f "$W/data/$f.sqlite" ] || { echo "[smoke] FAIL $f.sqlite 가 만들어지지 않았어요" >&2; exit 1; }
done
echo "[smoke] OK (SIGTERM 정상 종료, SQLite 3개 생성)"
