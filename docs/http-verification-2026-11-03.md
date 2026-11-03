# Slack HTTP / Marketplace 준비 코드 검증 — 2026-11-03

## 판정과 범위

와탭 계정 OAuth 직접 연동과 Slack HTTP 수신·Marketplace 등재 준비 코드의 로컬 검증 기록이다. 실제 Slack 앱 설정 반영, 공개 HTTP 배포 또는 Marketplace 등재 완료를 의미하지 않는다. 기준 커밋은 `f660da83f32623fd3132251c56fdc868fafadc37`이다.

## 최종 실행 검증

마지막 코드 수정 이후 `2026-11-03T16:40:04+09:00`에 각 종료 코드를 따로 확인했다. 이후에는 문서만 바뀌었다.

| 명령 | 결과 |
|---|---|
| `pnpm run test` | 142 passed, 0 failed/cancelled/skipped/todo |
| `pnpm run typecheck` | 통과 |
| `pnpm run build` | 통과 — 후보 `dist/index.js`와 source map 생성 |
| `git diff --check` | 통과 |

최종 독립 리뷰는 이전 P1/P2 차단 결함의 해결을 확인하고 새 차단 결함을 보고하지 않았다. 리뷰어도 관련 33개 테스트, typecheck, diff-check를 별도로 통과했다. 16:45 KST에 검토 대상 30개 파일의 SHA-256이 최종 리뷰 시점과 모두 일치함을 확인했다.

### HTTP receiver와 실제 entrypoint

- 실제 Bolt receiver와 가짜 Slack Web API로 서명된 DM, URL verification, URL-encoded 버튼, 빠른 ACK, 설치 리디렉션을 검사했다.
- 누락/위조/만료 서명 및 서명 뒤 바뀐 본문을 거부하고 handler 부작용이 없는지 검사했다.
- 실제 `src/index.ts`를 합성 환경·임시 DB/포트로 기동해 공개 HTTP의 설정 누락과 legacy fallback을 차단했다.
- 3개 workspace를 fixture로 설치한 뒤 서명된 `tokens_revoked`/`app_uninstalled`를 실제 entrypoint로 전송했다. 대상의 설치·와탭 연결·대화 기록만 삭제되고 다른 workspace는 보존됐다.
- 빌드 산출물 자체도 별도 임시 환경에서 기동했다. `/`, `/privacy`, `/terms`, `/support` 200, `/slack/install` 302, 서명 없는 `/slack/events` 401, state 없는 `/oauth/callback` 400을 확인하고 테스트 프로세스만 종료했다.

### 독립 리뷰에서 찾아 수정한 경로

1. 과거 apply/cancel 버튼: OAuth 모드에서는 legacy 자격증명 조회와 cookie/static-token 호출 전에 거부한다. 공용 fixture 자격증명을 채운 경우에도 조회·외부 요청 0회이며 기존 legacy 모드 대조군은 동작한다.
2. 제거 중 대기하던 후속 질문: 첫 `await ack()` 이전에 삭제 세대를 고정하고 `handle`로 전달한다. ACK/Slack 전송 중 제거·재설치돼도 이전 요청은 새 로그인·Argus 질의·대화 기록을 만들지 않는다.
3. pending 로그인은 실제 활성 설치를 필수로 확인한다. 발급, OAuth 시작, discovery 이후, code 교환 전후를 검사하고 늦은 연결 저장을 차단한다. 정상 재설치와 다른 tenant 대조군을 포함한다.

새 경합 회귀 18개는 실제 entrypoint에 등록되는 핸들러를 VM에서 실행하고 실제 인메모리 저장소와 합성 boot/transport를 사용한다. 이 검증은 공개 Slack HTTP E2E가 아니다. 수정 에이전트는 scratch 사본에서 가드 10개를 각각 무효화해 assertion 실패를 확인했다.

## 실행 환경 반영

- 실제 Slack DM E2E(Socket Mode, 로컬 인가 서버·front·Argus)는 HTTP 리팩터링 이전 버전으로 수행했다. 와탭 로그인, pcode 38 CPU 답변, `whoami`, 서버 Bearer 로그를 확인했다. 세부 경계는 [E2E 기록](e2e-2026-11-03.md).
- 이 변경은 아직 어떤 실행 환경에도 배포하지 않았다. Slack 앱 설정(Socket on, 기존 bot/user scope)은 바꾸지 않았고 `slack-manifest.http.json`의 최소 bot scope 3개 초안은 미적용이다.

## 운영 전제 확인 — 2026-11-03 17:14 KST

| 환경 | `/.well-known/openid-configuration` | `/oauth2/authorize` |
|---|---|---|
| `service.whatap.io` | 404 | 404 |
| `dev.whatap.io` | 404 | 404 |

두 환경 모두 와탭 로그인 프록시가 꺼져 있다. 운영 OAuth 모드는 다음이 선행돼야 한다.

1. 플랫폼: 로그인 서버(`whatap.server.oauth`)와 front 로그인 프록시 활성화, 봇 클라이언트 등록(콜백 `https://<봇 도메인>/oauth/callback`, PKCE S256, `openid profile email whatap:read`), refresh token 수명 정책 확인.
2. Argus: 사용자 Bearer로 front를 조회하는 모드(`OAUTH_FRONT_BEARER`)를 whatap/argus에 반영·배포. 이 변경은 아직 PR 전이다.
3. 고정 HTTPS 도메인, 단일 인스턴스 호스팅, 영속 디스크.

## 남은 외부 단계

고정 HTTPS 도메인·호스팅, 운영 OAuth/front Bearer 지원, 승인된 지원 연락처·지원 언어·개인정보/LLM 보관 정책을 확정해야 한다. 이후 승인된 배포와 실제 HTTP 설치·삭제·재설치 E2E, 파일럿 및 심사 자료 준비가 필요하다. 로그아웃된 브라우저에서 시작하는 로그인도 별도 검증이다.

설정과 안전한 전환 순서는 [HTTP 배포 준비](http-rollout.md)를 따른다. SQLite 단일 프로세스, best-effort 원격 회수, 기존 team 없는 데이터 및 이벤트 시각 경계는 그 문서의 제한 사항을 따른다.
