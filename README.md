# argus-slack-bot

Slack 워크스페이스에서 `@argus` 멘션으로 WhaTap 도메인 질의응답.
내부 chain: **Slack → Claude API (claude-opus-4-7) → whatap-open-mcp-aitf MCP → argus `/v1/agent` → dev.whatap.io / api.whatap.io**.

```
Slack workspace
  └─ user @argus 멘션 또는 DM
       ↓ Slack Events API (Socket Mode, websocket — public URL 불필요)
  argus-slack-bot (이 레포)
       ├─ Anthropic SDK (manual tool_use 루프)
       └─ MCP SDK ─stdio─→ whatap-open-mcp-aitf
                                   └─ argus (X-Argus-Token + JSESSIONID)
                                          └─ WhaTap (cookie / token)
```

argus / whatap-mcp 는 변경 0 — 이 봇이 MCP 클라이언트로 spawn 만.

## Quick start

### 1. Slack 앱 등록 (1회)

[https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch.

**Socket Mode** 활성:
- 좌측 메뉴 → Socket Mode → Enable
- App-Level Token 생성 (scope: `connections:write`) → `xapp-...` 토큰 받음

**OAuth & Permissions** → Bot Token Scopes 추가:
- `app_mentions:read` — 채널 멘션 수신
- `chat:write` — 답글
- `im:history`, `im:read`, `im:write` — DM 지원

**Event Subscriptions** → Enable Events → Subscribe to bot events:
- `app_mention`
- `message.im`

**Install App** → 워크스페이스 설치 → Bot User OAuth Token (`xoxb-...`) 받음

### 2. 환경 설정

```bash
cd /Users/jaeyoung/work/argus-slack-bot
cp .env.example .env
# .env 편집:
#   SLACK_BOT_TOKEN=xoxb-...
#   SLACK_APP_TOKEN=xapp-...
#   ANTHROPIC_API_KEY=sk-ant-...
#   WHATAP_MCP_PATH=/Users/jaeyoung/work/whatap-open-mcp-aitf/dist/cli.js
#   ARGUS_URL=http://localhost:8090
#   ARGUS_API_TOKEN=test-mcp-token-abc123
#   ARGUS_COOKIE=JSESSIONID=...
```

### 3. 의존성 + 빌드

```bash
pnpm install
pnpm build
```

### 4. argus + whatap-mcp 사전 준비

- argus 가 `localhost:8090` 에서 동작 중인지 확인 (`curl http://localhost:8090/health`)
- whatap-open-mcp-aitf 가 빌드돼 있어야 함 (`dist/cli.js` 존재)

```bash
ls /Users/jaeyoung/work/whatap-open-mcp-aitf/dist/cli.js
curl -s http://localhost:8090/health
```

### 5. 봇 기동

```bash
pnpm start    # 또는 dev: pnpm dev (watch + tsx)
```

성공 로그:
```
[argus-slack-bot] starting MCP client (whatap-mcp)...
[argus-slack-bot] MCP tools loaded (16): whatap_list_projects, ..., ask_whatap_expert
[argus-slack-bot] connected (Socket Mode). Mention me with @argus in any channel I'm invited to.
```

### 6. Slack 에서 시연

봇을 채널에 초대 → 멘션:
```
@argus pcode 3396 컨테이너맵 화면 설명해줘
@argus 그럼 GPU 사용률은?      ← 같은 thread 안 → 컨텍스트 유지
```

DM 도 가능:
```
(DM) pcode 3396 의 최근 알림 보여줘
```

## 동작 디테일

### 대화 연속성
- Slack thread 단위로 history 보관 (`ThreadHistory`, in-memory Map).
- thread 안의 첫 호출에서 `ask_whatap_expert` 가 argus conversationId 발급 → 같은 thread 의 follow-up 마다 재사용.
- 30분 idle 시 자동 expire (메모리 누수 방지). 봇 재기동 시 history 손실.

### 도구 호출 루프
- Anthropic Messages API 의 manual tool_use loop. `claude-loop.ts` 참고.
- 일반적으로 hop 1~3 (사용자 질문 → ask_whatap_expert → final text).
- `MAX_TOOL_HOPS` (기본 8) 초과 시 강제 종료.

### Slack 메시지 포맷 변환
- argus 가 표준 Markdown 응답 → Slack mrkdwn 으로 변환 (`slack-format.ts`).
- 표는 코드블록으로 자동 감쌈 (Slack 표 미지원).
- 4000 자 초과 시 thread 안 여러 메시지로 분할.
- `[text](url)` → `<url|text>`, `**bold**` → `*bold*`, `## 헤딩` → `*헤딩*`.

### 보안
- Slack Socket Mode → public URL 없이 동작 (서명 검증 SDK 자동).
- secret 들은 `.env` 만 (gitignored). 운영 배포 시 secret manager 사용 권장.

## 알려진 제약 / 후속

- **`ARGUS_COOKIE` 만료**: cookie 기반이라 며칠~수주 단위 만료. 만료시 `.env` 갱신 + 재기동.
- **단일 cookie / 멀티 사용자**: 현재 모든 Slack 사용자가 봇의 `ARGUS_COOKIE` (한 사람 권한) 로 묶임. 사용자별 cookie 분리는 OAuth 설계 필요 (별 작업).
- **차트 미지원**: argus 가 Vega-Lite chart spec 반환해도 Slack 에선 렌더 불가 — 텍스트 요약만 표시.
- **호스팅**: 현재는 로컬 / dev 머신 가정. 운영 hostingm 후보:
  - argus 같은 front01/02 에 systemd 서비스 추가
  - fly.io / Railway / Render — Socket Mode 라 24/7 연결 유지 가능한 환경 필요
  - AWS Lambda — Socket Mode 부적합 (장시간 연결). HTTP Events API 모드로 전환 필요

## 파일 구조

| 파일 | 역할 |
|---|---|
| `src/index.ts` | 진입점 — Bolt App + Anthropic + MCP 와이어링 + 이벤트 핸들러 |
| `src/mcp-client.ts` | whatap-mcp stdio child + listTools/callTool wrapper |
| `src/claude-loop.ts` | Anthropic Messages API + tool_use 수동 루프 |
| `src/conversation.ts` | thread → history Map + idle expire |
| `src/slack-format.ts` | Markdown → Slack mrkdwn + 길이 분할 |
