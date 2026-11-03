# HTTP 배포 준비 (검토 초안)

이 문서는 기존 앱 `A0AFUKNJ5SS`의 HTTP 전환용 코드와 manifest 초안이다. 새 앱을 생성하거나 현재 앱 설정을 바꾼 작업이 아니다. 배포 도메인·호스팅·Agent 모드·지원 언어·팀 지원 연락처는 공개 반영 전에 확정한다.

## 현재와 목표

- 기본 `SLACK_TRANSPORT=socket`: 기존 Socket Mode 실행 유지. 이 변경만으로 실행 중인 앱이나 Slack 설정은 바뀌지 않는다.
- `SLACK_TRANSPORT=http`: Bolt HTTPReceiver의 `/slack/events`가 Events API와 Interactivity를 받는다. 서명과 요청 시각을 검증하며, 작업 완료를 기다리지 않고 ACK한다.
- 공개 다중 워크스페이스 HTTP 모드는 Slack OAuth 설정, 토큰 암호화 키, HTTPS origin, 와탭 사용자 OAuth 설정이 모두 필요하다. 공용 토큰 경로로 조용히 전환하지 않는다.
- 와탭 로그인 모드에서는 봇 자체 Anthropic API 키, MCP 경로, Slack app-level token이 필요하지 않다. Argus의 LLM 설정은 별도다.
- `slack-manifest.http.json`의 `example.invalid`는 의도적으로 동작하지 않는 자리표시자다. 그대로 업로드하지 않는다.

## 실행 설정

비밀값은 기존 승인된 secret manager/서비스 환경변수로 주입한다. 채팅·명령 인자·Git에 넣지 않는다.

| 변수 | 의미 |
|---|---|
| `SLACK_TRANSPORT=http` | HTTP 수신 선택 |
| `SLACK_HTTP_PORT=3000` | 내부 HTTP 포트. 없으면 `SLACK_OAUTH_PORT`, 이후 3000 |
| `SLACK_LISTEN_HOST=127.0.0.1` | 기본 loopback. 컨테이너 환경은 노출 경계를 확인한 뒤 변경 |
| `SLACK_PUBLIC_URL=https://<승인된 도메인>` | 경로/query/자격증명이 없는 HTTPS origin |
| `SLACK_APP_ID=A0AFUKNJ5SS` | 기존 앱 ID |
| `SLACK_SIGNING_SECRET` | Slack 요청 검증 |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` | 워크스페이스 설치 OAuth |
| `SLACK_TOKENS_ENCRYPTION_KEY` | 설치 토큰과 와탭 연결 암호화. 기존 데이터와 같은 키 보존 |
| `SLACK_INSTALLATIONS_DB`, `SLACK_USER_TOKENS_DB`, `SLACK_THREAD_HISTORY_DB` | 영속 디스크의 DB 경로 |
| `WHATAP_OAUTH_ISSUER`, `WHATAP_OAUTH_CLIENT_ID`, `WHATAP_OAUTH_CLIENT_SECRET` | 해당 환경의 와탭 인가 서버 클라이언트 |
| `WHATAP_OAUTH_REDIRECT_URI=https://<같은 도메인>/oauth/callback` | 와탭 로그인 콜백. Slack 설치 콜백과 다름 |
| `WHATAP_OAUTH_PORT=3901`, `WHATAP_OAUTH_LISTEN_HOST=127.0.0.1` | 와탭 콜백의 내부 리스너 |
| `ARGUS_URL` | 사용자 Bearer를 받는 Argus 주소 |

프로세스는 지속 실행형 Node 서비스와 영속 SQLite를 전제로 한다. 파일 기반 DB·메모리 pending state를 임시 서버리스 인스턴스나 여러 복제본에 그대로 올리지 않는다. 소스 디렉터리의 `.env`는 현재 loader가 환경변수보다 우선하므로, 운영 실행 디렉터리에는 개발 `.env`를 배치하지 않는다.

## 한 도메인에서 두 리스너 연결

역방향 프록시가 TLS를 종료하고 다음 경로를 전달한다. query string과 본문을 그대로 보존한다.

| 외부 경로 | 내부 대상 |
|---|---|
| `/slack/events` | `127.0.0.1:3000` (원본 본문과 Slack 서명 헤더 보존) |
| `/slack/install`, `/slack/oauth_redirect` | `127.0.0.1:3000` |
| `/`, `/privacy`, `/terms`, `/support` | `127.0.0.1:3000` |
| `/oauth/start`, `/oauth/callback` | `127.0.0.1:3901` |

로그에서 OAuth `code`, `state`, 로그인 링크 query 및 Authorization 헤더를 제외한다. SQLite와 백업은 운영 계정만 접근하도록 제한한다.

## 권한·화면 초안

코드와 manifest에 동일한 봇 권한을 사용한다.

- `app_mentions:read`: 멘션 이벤트
- `im:history`: DM 메시지 이벤트
- `chat:write`: 답변 전송·수정·개인용 응답

코드는 별도 DM 개설·대화 목록 읽기·사용자 대신 메시지 쓰기를 하지 않으므로 `im:read`, `im:write`, 사용자 토큰 권한과 검색 권한을 요청하지 않는다.

초안은 일반 봇 모드: Home off, Messages on, MCP off, 사용자 이벤트 제거. 기존 Agent/Assistant 설정은 manifest 외 화면에서도 확인해야 하며, 이번에는 실제로 끄지 않았다. 한국어 고정 문구 기준 초안이고, 공개 지원 언어 확정은 별도다.

`app_uninstalled`, `tokens_revoked`를 구독한다. 실제 봇 사용자 ID와 일치하는 봇 토큰 회수 또는 앱 삭제 시 해당 workspace의 설치 정보·와탭 연결·pending 로그인·워크스페이스별 히스토리를 정리한다. 사용자 OAuth 토큰만 회수됐다는 이벤트로 다른 봇 설치 전체를 지우지 않는다.

원격 와탭 토큰 회수는 로컬 삭제 뒤의 best-effort 요청이며 영속 재시도 큐는 아니다. 재설치보다 오래된 이벤트를 무시하지만, 이벤트 시각이 없거나 같은 초에 삭제·재설치된 경우는 완전히 구분할 수 없다. 이런 경계와 다중 프로세스 동시 쓰기를 지원하는 것처럼 운영 약속을 하지 않는다.

새 히스토리는 team ID를 포함한다. 이전 버전의 team 없는 히스토리와 legacy `user_tokens`는 workspace 소유자를 안전하게 추정할 수 없으므로 자동으로 타 workspace 데이터까지 지우지 않는다. 운영 전환 시 새 전용 DB를 사용하거나 기존 레거시 DB의 보관/정리 범위를 따로 승인받는다. 원격 Argus 대화·로그와 백업 삭제는 별도 정책이다.

## 안전한 전환 순서

1. 운영 도메인·호스팅·지원 연락처·LLM 처리/보관 정책 확정. `/privacy`와 `/support`의 초안 고지와 개인 연락처는 승인된 운영 내용으로 교체한다. 이 페이지들을 현재 그대로 심사 자료로 제출하지 않는다.
2. 승인된 와탭 인가 서버에 봇 클라이언트와 `/oauth/callback` 등록. Argus/front 사용자 Bearer 경로의 운영 지원을 담당자와 확인한다.
3. 기존 Socket 봇을 유지한 채 HTTP 서비스·TLS·공개 URL과 서명 검증을 먼저 검증한다. 라이브 전환 시 두 서비스가 같은 DB를 동시에 갱신하지 않도록 배치/중단 계획을 정한다.
4. 배포 승인 후 manifest의 세 주소를 실제 도메인으로 바꾸고 앱 설정에 적용한다. HTTP 수신 확인 전에 Socket Mode부터 끄지 않는다. 이 전환은 앱 전체에 영향을 준다.
5. 별도 테스트 워크스페이스에서 설치 → 계정 없는 사용자 안내 → 와탭 로그인 → DM/멘션/버튼 → logout → 제거 → 재설치를 실제로 확인한다. 권한 변경에 따른 재동의도 확인한다.
   - 이전 메시지의 적용/취소 버튼도 검사한다. OAuth 모드에서는 새 버튼을 숨기는 것뿐 아니라, 기존 버튼에서 공용 토큰·쿠키 경로로 진입하지 않아야 한다.
   - 후속 질문의 ACK/메시지 전송을 지연한 상태에서 앱을 제거해도 새 로그인·토큰·대화 기록이 만들어지지 않는지 검사한다. 제거된 설치에서 pending 발급 및 늦은 OAuth 콜백 저장이 차단돼야 한다.
6. 파일럿, 설명·지원 언어·협업자·Security & Compliance·테스트 계정·시연 영상과 최신 제출 요건을 확인한 뒤 심사 제출을 별도로 승인받는다.

## 로컬 검증

```sh
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
pnpm run test
pnpm run typecheck
pnpm run build
```

새 HTTP 테스트는 가짜 Slack Web API와 실제 loopback HTTP/Bolt receiver를 사용한다. 실제 entrypoint도 비밀값 없는 별도 디렉터리와 임시 포트에서 기동/종료한다. 이는 공개 Slack HTTP 전환·실제 워크스페이스 설치 검증과 구분한다. 실제 Socket Mode 사용자 E2E 기록은 `docs/e2e-2026-11-03.md`에 있다.

개발 중 실행한 build는 작업 트리의 `dist/`를 바꾼다. 실행 중인 서비스는 작업 트리의 `dist/`가 아니라 검증한 커밋으로 만든 고정 산출물로 기동한다.

2026-11-03 확인 시 `service.whatap.io`, `dev.whatap.io` 모두 와탭 로그인 프록시가 404였다. 운영 전제와 확인 결과는 [검증 기록](http-verification-2026-11-03.md)을 따른다.

참고: https://docs.slack.dev/apis/events-api/using-socket-mode
https://docs.slack.dev/slack-marketplace/slack-marketplace-review-guide
https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements
