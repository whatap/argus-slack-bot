// src/index.ts
//
// argus-slack-bot 진입점.
// Slack Bolt App (Socket Mode) + Anthropic + whatap-mcp 셋 와이어링.
//
// 동작 (multi-tenant):
//   1. 부팅 시 SQLite (slack_user_id → WhaTap creds) 오픈.
//   2. Slack 의 app_mention / message.im 이벤트 받으면:
//      a. 텍스트가 명령 (register/cookie/whoami/logout/help) 이면 명령 처리.
//      b. 일반 질의면 user 의 creds 룩업 → MCP per-request spawn → ClaudeLoop.
//   3. 같은 thread 안의 후속 메시지는 ThreadHistory 로 컨텍스트 유지.
//   4. SIGINT/SIGTERM 시 cleanup 후 종료.

// dotenv override:true — shell 에 같은 키가 빈 문자열로 박혀있으면 (예: 부모
// 프로세스 에서 export ANTHROPIC_API_KEY=) dotenv 기본은 안 덮음. override 로
// .env 의 값이 항상 이김. 운영 배포 시엔 systemd 환경변수가 우선이라야 한다면
// 이 줄을 끄거나 ENV 분기 추가.
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

import Anthropic from "@anthropic-ai/sdk";
import bolt from "@slack/bolt";

import { describeArgusSubTool } from "./argus-direct.js";
import { runClaudeWithMcp, type ToolCallEntry } from "./claude-loop.js";
import { ThreadHistory } from "./conversation.js";
import { runDirectToArgus, type DirectRouteSnap } from "./direct-route.js";
import { humanizeError } from "./humanize.js";
import { inferCurrentUrl } from "./screen-infer.js";
import { SqliteInstallationStore } from "./installations.js";
import { landingPageHtml } from "./landing.js";
import { McpClientPool } from "./mcp-pool.js";
import { splitForSlack, toSlackMrkdwn } from "./slack-format.js";
import { UserTokenStore, maskToken, type UserCreds } from "./user-tokens.js";

const { App, LogLevel } = bolt;

// ── 환경변수 검사 ─────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[argus-slack-bot] ${name} env 미설정 — .env.example 참고.`);
    process.exit(1);
  }
  return v;
}

const SLACK_APP_TOKEN = requireEnv("SLACK_APP_TOKEN");
const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
const WHATAP_MCP_PATH = requireEnv("WHATAP_MCP_PATH");

// Multi-workspace OAuth — 셋 다 있으면 multi-workspace 모드. 아니면 single-workspace
// (SLACK_BOT_TOKEN 으로 폴백). 시연/내부용엔 single, 외부 배포엔 multi.
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || "";
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_STATE_SECRET = process.env.SLACK_STATE_SECRET || "";
const SLACK_OAUTH_PORT = Number(process.env.SLACK_OAUTH_PORT || 3000);
const IS_MULTI_WORKSPACE = !!(
  SLACK_CLIENT_ID &&
  SLACK_CLIENT_SECRET &&
  SLACK_SIGNING_SECRET &&
  SLACK_STATE_SECRET
);

// Single-workspace 폴백 토큰. multi-workspace 모드면 미사용.
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
if (!IS_MULTI_WORKSPACE && !SLACK_BOT_TOKEN) {
  console.error(
    "[argus-slack-bot] Slack 인증 미설정.\n" +
      "  • single-workspace: SLACK_BOT_TOKEN 필수\n" +
      "  • multi-workspace : SLACK_CLIENT_ID + SLACK_CLIENT_SECRET + SLACK_SIGNING_SECRET + SLACK_STATE_SECRET",
  );
  process.exit(1);
}

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
const ANTHROPIC_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 8192);
// 외곽 hop 한계. argus 자체가 내부 maxHops=8 으로 도구 루프 돌리니, 외곽은
// ask_whatap_expert 한 번이면 충분 (보통 hop 1~2). 외곽 8 + 내부 8 = 최악 64 hop
// 비용 폭주 방지로 외곽은 3 으로 낮춤. env 로 override 가능.
const MAX_TOOL_HOPS = Number(process.env.MAX_TOOL_HOPS || 3);
const MAX_HISTORY_TURNS = Number(process.env.MAX_HISTORY_TURNS || 10);

// 토큰 DB 경로 — 기본 ./data/user_tokens.sqlite. WAL 모드.
const USER_TOKENS_DB =
  process.env.SLACK_USER_TOKENS_DB || "./data/user_tokens.sqlite";
// 사용자 토큰 암호화 키. 32+ bytes 권장 (`openssl rand -hex 32`).
// 미설정이면 plaintext (legacy / dev). 설정 후 새 row 부터 암호화 — 마이그레이션 X.
const TOKENS_ENCRYPTION_KEY = process.env.SLACK_TOKENS_ENCRYPTION_KEY || "";
// Slack workspace 설치 DB. user_tokens 와 같은 sqlite 파일 공유 OK.
const INSTALLATIONS_DB =
  process.env.SLACK_INSTALLATIONS_DB || "./data/user_tokens.sqlite";
// Thread history DB — user_tokens 와 분리 (gc 사이클이 잦아 vacuuming
// 비용이 사용자 데이터에 영향 안 가게).
const THREAD_HISTORY_DB =
  process.env.SLACK_THREAD_HISTORY_DB || "./data/thread_history.sqlite";

// dev.whatap.io 가 default. customer 배포 시엔 api.whatap.io 로 가야 할 수도 있음.
const DEFAULT_WHATAP_API_URL =
  process.env.DEFAULT_WHATAP_API_URL || "https://dev.whatap.io";

// argus 경로 (ask_whatap_expert) — 봇 운영 측이 들고있는 단일 인스턴스.
// 사용자 cookie 가 있으면 cookie 경로, 없으면 token-only.
const ARGUS_URL = process.env.ARGUS_URL || "";
const ARGUS_API_TOKEN = process.env.ARGUS_API_TOKEN || "";

// 부팅 시 즉시 디버그 로그 — 401 진단용. 토큰 전체 X, prefix + length 만.
console.log(
  `[argus-slack-bot/debug] ARGUS_URL=${ARGUS_URL || "<empty>"} ARGUS_API_TOKEN_set=${!!ARGUS_API_TOKEN} prefix=${ARGUS_API_TOKEN.slice(0, 8)}... length=${ARGUS_API_TOKEN.length}`,
);

// Default fallback creds — 사용자가 register 안 했을 때 대신 사용.
// 시연/PoC 단계에 유용. 운영에선 사용자별 토큰이 정석. 빈 문자열이면 폴백 X (=
// 미등록 사용자에게 register 안내). WHATAP_API_TOKEN / ARGUS_COOKIE env 는
// 옛 single-workspace 봇 코드의 잔재이기도 한데, 다용도 재활용.
const DEFAULT_WHATAP_API_TOKEN = process.env.WHATAP_API_TOKEN || "";
const DEFAULT_ARGUS_COOKIE = process.env.ARGUS_COOKIE || "";

// ── System prompt ────────────────────────────────────────────
const SYSTEM_PROMPT = `당신은 WhaTap 의 도메인 전문가 봇입니다. 사용자가 Slack 에서
모니터링·알림·인프라에 대해 질문하면 ask_whatap_expert 도구로 argus (WhaTap 내부 LLM
에이전트) 에 위임하고, 그 결과를 Slack 메시지로 답하세요.

- 한국어 질문엔 한국어로, 영어엔 영어로 답.
- 답변에 표가 있으면 그대로 둠 (Slack 에선 코드블록으로 자동 변환됨).
- 모호한 질문은 명확화 질문 1개를 우선 던져도 됨.
- argus 가 이미 합성한 답을 받으면 그대로 사용자에게 전달 — 재요약·재해석 금지.

**도구 선택 규칙 (중요 — 무조건 따를 것):**

1. **default = ask_whatap_expert 한 번 호출.** argus 가 내부 풀 카탈로그
   (40+ 도구, screen 카탈로그, 알림 등록 도구 포함) 로 알맞은 sub-tool 자동 선택.
   당신이 보는 MCP 도구 list 는 argus 카탈로그의 일부 wrapper 일 뿐 — 전부가 아님.

2. **알림 / 룰 / 메트릭 / 등록 / 만들어줘 / 분석 요청은 100% ask_whatap_expert.**
   특히 "**알림 만들어줘 / 등록해줘 / 룰 생성**" 같은 동사는 절대 "MCP 도구상
   생성 API 가 없다" 고 답하지 말 것. argus 안에는 whatap_bulk_create_event_rule /
   whatap_bulk_create_flex_event 가 있고, ask_whatap_expert 통해 argus 가 호출함.

3. **MCP 도구 직접 호출은 "단일 메트릭 / 단일 pcode / 단일 파라미터" 명시 케이스만.**
   예: "pcode 3396 의 list_projects 출력 그대로 보여줘" — 이건 직접 호출 OK.
   "알림 / 분석 / 등록 / 만들어줘" — 무조건 ask_whatap_expert.

3a. **ask_whatap_expert 의 query 인자는 사용자 원본 메시지를 그대로 forward.**
   reword / 친절한 풀어쓰기 / "도와주려는 wrap" 절대 금지. 사용자가
   "3396 GPU 전력 알림" 이라고 보내면 query="3396 GPU 전력 알림" 그대로.
   당신이 wrap 하면 argus 의 intent classifier / forced tool 흐름이 약해지고
   argus 의 LLM 이 잘못된 메트릭 (DCGM_FI_DEV_GPU_UTIL 같은) 선택.
   단 pcode 가 명시 안 됐을 때 추가는 OK (예: query="GPU 알림 만들어줘", pcode=3396).

4. **금지 패턴:**
   - "MCP 도구상 X API 가 없습니다" — argus 한테 위임 안 하고 결론 내지 말 것.
     ask_whatap_expert 호출 후 argus 가 안 된다고 답하면 그때 사용자에게 전달.
   - "콘솔에서 직접 등록하세요" — argus 가 등록 도구 가지고 있음. 위임할 것.
   - "조회만 가능합니다" — 마찬가지로 위임 후 argus 답을 따를 것.`;

// ── 명령 파싱 ────────────────────────────────────────────────
interface ParsedCommand {
  kind: "register" | "cookie" | "whoami" | "logout" | "help";
  value?: string;
}

function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  // 첫 단어 + rest. command 는 case-insensitive.
  const firstSpace = trimmed.search(/\s/);
  const head =
    firstSpace < 0 ? trimmed.toLowerCase() : trimmed.slice(0, firstSpace).toLowerCase();
  const rest = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();
  switch (head) {
    case "register":
      return { kind: "register", value: rest };
    case "cookie":
      return { kind: "cookie", value: rest };
    case "whoami":
      return { kind: "whoami" };
    case "logout":
      return { kind: "logout" };
    case "help":
    case "도움말":
      return { kind: "help" };
  }
  return null;
}

const HELP_MESSAGE = [
  "*argus 봇 사용법*",
  "",
  "*등록 (DM 으로만 보내세요 — 채널 노출 금지):*",
  "• `register <whatap-api-token>` — WhaTap Console 에서 발급받은 토큰 등록",
  "• `cookie <argus-session-cookie>` — (옵션) `JSESSIONID=...` 전체 cookie 헤더값. ask_whatap_expert 깊은 답변 활성",
  "",
  "*상태 확인 / 해제:*",
  "• `whoami` — 등록된 토큰/cookie 마스킹 표시",
  "• `logout` — 등록된 creds 삭제",
  "",
  "*질의:*",
  "• 채널에서 `@argus <질문>` 또는 DM 으로 자유 형식",
  "",
  "토큰 발급: WhaTap Console → 계정 설정 → API Token",
].join("\n");

// ── 부팅 ──────────────────────────────────────────────────────
async function main() {
  console.log("[argus-slack-bot] starting...");

  // 1) 토큰 저장소 (사용자 WhaTap creds + Slack workspace 설치 둘 다)
  const tokenStore = new UserTokenStore(
    USER_TOKENS_DB,
    TOKENS_ENCRYPTION_KEY || undefined,
  );
  const installationStore = IS_MULTI_WORKSPACE
    ? new SqliteInstallationStore(INSTALLATIONS_DB)
    : null;
  console.log(
    `[argus-slack-bot] token DB: ${USER_TOKENS_DB} encryption: ${
      tokenStore.isEncrypted() ? "enabled (AES-256-GCM)" : "DISABLED (plaintext)"
    }`,
  );
  if (installationStore) {
    console.log(
      `[argus-slack-bot] mode=multi-workspace installations=${installationStore.count()} oauth-port=${SLACK_OAUTH_PORT}`,
    );
  } else {
    console.log("[argus-slack-bot] mode=single-workspace (SLACK_BOT_TOKEN)");
  }

  // 2) Anthropic + thread history (SQLite-backed, 봇 재시작 후에도 thread 유지)
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const threadHistory = new ThreadHistory(
    MAX_HISTORY_TURNS,
    30 * 60 * 1000,
    THREAD_HISTORY_DB,
  );
  console.log(`[argus-slack-bot] thread history DB: ${THREAD_HISTORY_DB}`);

  // MCP client 풀 — 사용자별 keep-warm child. 매 요청 spawn 오버헤드 (0.5-1s)
  // 제거. 사용자 creds 변경 시 envHash 로 자동 재spawn.
  const mcpPool = new McpClientPool(WHATAP_MCP_PATH);
  console.log("[argus-slack-bot] mcp pool: keep-warm enabled (idle=5min)");

  // 3) Slack Bolt App
  // - single-workspace: token 직접 주입
  // - multi-workspace: installationStore + clientId/secret/signingSecret/stateSecret
  //   Bolt 가 OAuth 콜백용 HTTP server 도 같이 띄움 (port=SLACK_OAUTH_PORT).
  //   Socket Mode 는 그대로 — appToken 으로 모든 워크스페이스 이벤트 수신, 응답 시
  //   installationStore 로 해당 team_id 의 bot_token 을 자동 lookup.
  const SLACK_SCOPES = [
    "app_mentions:read",
    "chat:write",
    "im:history",
    "im:read",
    "im:write",
  ];
  const app = IS_MULTI_WORKSPACE
    ? new App({
        appToken: SLACK_APP_TOKEN,
        socketMode: true,
        clientId: SLACK_CLIENT_ID,
        clientSecret: SLACK_CLIENT_SECRET,
        signingSecret: SLACK_SIGNING_SECRET,
        stateSecret: SLACK_STATE_SECRET,
        scopes: SLACK_SCOPES,
        installationStore: installationStore!,
        installerOptions: {
          port: SLACK_OAUTH_PORT,
          // 기본 path: /slack/install (시작), /slack/oauth_redirect (콜백)
        },
        // root 에 마케팅 랜딩 페이지 — QR / 데모용
        customRoutes: [
          {
            path: "/",
            method: ["GET"],
            handler: (_req, res) => {
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(landingPageHtml());
            },
          },
        ],
        logLevel: LogLevel.INFO,
      })
    : new App({
        token: SLACK_BOT_TOKEN,
        appToken: SLACK_APP_TOKEN,
        socketMode: true,
        logLevel: LogLevel.INFO,
      });

  // 메시지 핸들러 — app_mention / DM 둘 다.
  // client = event 컨텍스트의 워크스페이스별 WebClient (multi-workspace 에선
  // bot_token 이 워크스페이스 마다 다르므로 app.client 가 아니라 이걸 써야 함).
  const handle = async (params: {
    text: string;
    userId: string;
    isDm: boolean;
    threadKey: string;
    say: (args: { text: string; thread_ts?: string; blocks?: unknown[] }) => Promise<unknown>;
    /** Bolt 가 event listener 한테 주는 워크스페이스별 WebClient.
     *  타입은 bolt 가 re-export 안 해서 minimal 인터페이스로 inline. */
    client: {
      chat: {
        update: (args: {
          channel: string;
          ts: string;
          text: string;
          blocks?: unknown[];
        }) => Promise<unknown>;
      };
    };
    threadTs: string;
  }) => {
    const { text, userId, isDm, threadKey, say, client, threadTs } = params;
    if (!text) return;

    // ── 명령 처리 (register/cookie/whoami/logout/help) ─────
    const cmd = parseCommand(text);
    if (cmd) {
      await handleCommand(cmd, {
        userId,
        isDm,
        threadTs,
        say,
        tokenStore,
      });
      return;
    }

    // ── 사용자 creds 룩업 (없으면 default 폴백) ─────────────
    const resolved = resolveUserCreds(userId, tokenStore);
    if (!resolved) {
      await say({
        text:
          ":lock: 등록된 토큰이 없어요. DM 으로 `register <whatap-api-token>` 보내주세요.\n" +
          "사용법: `help`",
        thread_ts: threadTs,
      });
      return;
    }
    const { creds, usingDefault } = resolved;
    if (usingDefault) {
      console.log(`[argus-slack-bot] user=${userId} using default creds`);
    }
    void usingDefault; // 향후 응답 끝에 "데모 토큰 사용 중" 안내 hint 시 사용

    // ── 로딩 placeholder ────────────────────────────────────
    let placeholderTs: string | undefined;
    try {
      const placed = (await say({
        text: "_argus 가 응답 준비 중..._",
        thread_ts: threadTs,
      })) as { ts?: string } | undefined;
      placeholderTs = placed?.ts;
    } catch {
      // placeholder 실패해도 본 응답은 시도.
    }

    // ── argusDirect 설정 — 정상 케이스의 진입점 ─────────────
    // 봇 외곽 Claude tool_use loop 우회 (5-10초 절감, whatap-front 와 같은 흐름).
    // 미설정 (ARGUS_URL/TOKEN 빈) 시에만 legacy MCP+claude-loop fallback.
    const argusDirect =
      ARGUS_URL && ARGUS_API_TOKEN
        ? {
            url: ARGUS_URL,
            apiToken: ARGUS_API_TOKEN,
            cookie: creds.argusCookie,
          }
        : undefined;

    // ── 스트리밍 placeholder 업데이트 ──────────────────────────
    // 800ms throttle — Slack rate limit 회피 + 깜빡임 방지.
    const STREAM_INTERVAL_MS = 800;
    const channel = getChannelFromThreadKey(threadKey);
    let lastUpdateAt = 0;
    let lastSentText = "";
    const flushUpdate = async (display: string) => {
      if (!placeholderTs) return;
      if (display === lastSentText) return;
      lastSentText = display;
      try {
        await client.chat.update({
          channel,
          ts: placeholderTs,
          text: display,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[argus-slack-bot] chat.update failed ts=${placeholderTs}: ${msg}`,
        );
      }
    };

    // ── direct route (정상 경로) vs legacy MCP+claude-loop (폴백) ─
    let result;
    let mcpClient: Awaited<ReturnType<typeof mcpPool.acquire>> | null = null;
    const t0 = Date.now();
    const state = threadHistory.get(threadKey);

    try {
      if (argusDirect) {
        // 정상 경로: 봇 외곽 LLM 우회. argus /v1/chat SSE 직접 소비.
        // 사용자 메시지에서 화면 의도 + pcode 추론 → 가짜 currentUrl 박음.
        // argus 의 screens.Lookup() 이 매칭 → cpm.yaml 의 domain_knowledge /
        // analysis_guides / data_registry inject. whatap-front 패널과 같은 효과.
        const inferred = inferCurrentUrl(text);
        if (inferred) {
          console.log(
            `[argus-slack-bot] screen inferred: ${inferred.currentUrl}`,
          );
        }
        result = await runDirectToArgus(
          {
            argusDirect,
            argusConversationId: state.argusConversationId,
            onProgress: (snap) => {
              const now = Date.now();
              if (now - lastUpdateAt < STREAM_INTERVAL_MS) return;
              lastUpdateAt = now;
              void flushUpdate(composeStepStreamingBody(snap));
            },
          },
          text,
          inferred?.pcode,
          inferred?.currentUrl,
        );
      } else {
        // legacy fallback: argusDirect 미설정 (배포 환경에서만 발생).
        // MCP child 풀에서 acquire + 외곽 LLM tool_use loop.
        const mcpEnv = buildMcpEnv(creds);
        mcpClient = await mcpPool.acquire(userId, mcpEnv);
        result = await runClaudeWithMcp(
          {
            anthropic,
            mcpClient,
            model: ANTHROPIC_MODEL,
            maxTokens: ANTHROPIC_MAX_TOKENS,
            maxHops: MAX_TOOL_HOPS,
            system: SYSTEM_PROMPT,
            argusConversationId: state.argusConversationId,
            onProgress: (snap) => {
              const now = Date.now();
              if (now - lastUpdateAt < STREAM_INTERVAL_MS) return;
              lastUpdateAt = now;
              void flushUpdate(
                composeStreamingBody({
                  text: snap.text,
                  toolInProgress: snap.toolInProgress,
                  toolCallLog: snap.toolCallLog,
                }),
              );
            },
          },
          text,
          state.history,
        );
      }
      const dur = Date.now() - t0;
      console.log(
        `[argus-slack-bot] user=${userId} thread=${threadKey} hops=${result.hops} dur=${dur}ms text_len=${result.text.length}`,
      );

      threadHistory.appendTurn(threadKey, result.newMessages);
      if (result.argusConversationId) {
        threadHistory.setArgusConvId(threadKey, result.argusConversationId);
      }

      const formattedText = toSlackMrkdwn(result.text || "_(빈 응답)_");
      const toolFooter = renderToolFooter(result.toolCallLog);
      const cookieHint = renderCookieGateHint(result.chipActions, creds);
      const formatted = [formattedText, cookieHint, toolFooter]
        .filter(Boolean)
        .join("\n\n");
      const chunks = splitForSlack(formatted);

      // chip actions (event-rule / flex-event 적용 / 취소) 가 있으면 마지막 chunk
      // 에 Block Kit button 으로 동봉. 클릭 시 app.action(action_id) 핸들러가
      // argus /v1/event-rules/apply 또는 /cancel 호출.
      const chipBlocks = chipActionsToBlocks(result.chipActions, creds);
      // 추천 후속 질문 → Block Kit button. 클릭 시 같은 thread 의 새 turn.
      const followupBlocks = recommendedQuestionsToBlocks(
        result.recommendedQuestions ?? [],
      );
      const extraBlocks = [...chipBlocks, ...followupBlocks];
      const lastIdx = chunks.length - 1;

      if (placeholderTs) {
        try {
          await client.chat.update({
            channel: getChannelFromThreadKey(threadKey),
            ts: placeholderTs,
            text: chunks[0],
            blocks:
              lastIdx === 0
                ? withTextSection(chunks[0], extraBlocks)
                : undefined,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[argus-slack-bot] final chat.update failed ts=${placeholderTs} text_len=${chunks[0].length}: ${msg}`,
          );
          await say({
            text: chunks[0],
            thread_ts: threadTs,
            blocks: lastIdx === 0 ? withTextSection(chunks[0], extraBlocks) : undefined,
          });
        }
      } else {
        await say({
          text: chunks[0],
          thread_ts: threadTs,
          blocks: lastIdx === 0 ? withTextSection(chunks[0], extraBlocks) : undefined,
        });
      }
      for (let i = 1; i < chunks.length; i++) {
        await say({
          text: chunks[i],
          thread_ts: threadTs,
          blocks: i === lastIdx ? withTextSection(chunks[i], extraBlocks) : undefined,
        });
      }
    } catch (err) {
      console.error(
        `[argus-slack-bot] error user=${userId} thread=${threadKey}:`,
        err,
      );
      const errText = humanizeError(err);
      if (placeholderTs) {
        try {
          await client.chat.update({
            channel: getChannelFromThreadKey(threadKey),
            ts: placeholderTs,
            text: errText,
          });
        } catch {
          await say({ text: errText, thread_ts: threadTs });
        }
      } else {
        await say({ text: errText, thread_ts: threadTs });
      }
    } finally {
      // legacy MCP fallback 경로만 release. direct route 는 mcpClient null.
      if (mcpClient) {
        mcpPool.release(userId);
      }
    }
  };

  app.event("app_mention", async ({ event, say, client }) => {
    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    const threadKey = `${channel}:${threadTs}`;
    const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    await handle({
      text: cleanText,
      userId: event.user ?? "",
      isDm: false,
      threadKey,
      threadTs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      say: (args) => say(args as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
  });

  app.message(async ({ message, say, client }) => {
    const m = message as unknown as Record<string, unknown>;
    if (m.channel_type !== "im") return;
    if (m.subtype) return;
    const text = String(m.text ?? "").trim();
    if (!text) return;
    const channel = String(m.channel ?? "");
    const ts = String(m.ts ?? "");
    const threadTs = String(m.thread_ts ?? ts);
    const threadKey = `${channel}:${threadTs}`;
    await handle({
      text,
      userId: String(m.user ?? ""),
      isDm: true,
      threadKey,
      threadTs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      say: (args) => say(args as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
  });

  // chip apply/cancel 클릭 핸들러. action_id 가 `apply_event_rule:<token>` 또는
  // `cancel_event_rule:<token>` 형태라 정규식으로 매치.
  app.action(/^(apply|cancel)_event_rule:.+$/, async (ctx) => {
    const { ack, body, client, action } = ctx;
    await ack();

    const userId = (body as { user?: { id?: string } }).user?.id || "";
    const channel =
      (body as { channel?: { id?: string } }).channel?.id ||
      (body as { container?: { channel_id?: string } }).container?.channel_id ||
      "";
    const threadTs =
      (body as { message?: { thread_ts?: string; ts?: string } }).message
        ?.thread_ts ||
      (body as { message?: { ts?: string } }).message?.ts ||
      undefined;

    const actionId = (action as { action_id?: string }).action_id || "";
    const m = actionId.match(/^(apply|cancel)_event_rule:(.+)$/);
    if (!m) return;
    const op = m[1] as "apply" | "cancel";
    const token = m[2];

    if (!ARGUS_URL) {
      await client.chat.postEphemeral({
        channel,
        user: userId,
        text: `:warning: ARGUS_URL 미설정 — chip apply 호출 불가`,
        thread_ts: threadTs,
      });
      return;
    }

    // chipActionsToBlocks 와 동일한 폴백 정책 — default cookie 도 인정.
    // 한 쪽만 default 인지하면 'chip 은 보이는데 클릭하면 미등록 안내' UX 절벽.
    const resolved = resolveUserCreds(userId, tokenStore);
    const creds = resolved?.creds;
    if (!creds || !creds.argusCookie) {
      await client.chat.postEphemeral({
        channel,
        user: userId,
        text: `:warning: argus cookie 미등록 — DM 으로 \`cookie JSESSIONID=...\` 등록 후 다시 시도 (또는 운영자 default cookie 설정 요청)`,
        thread_ts: threadTs,
      });
      return;
    }

    const path = op === "apply" ? "/v1/event-rules/apply" : "/v1/event-rules/cancel";
    let resp: Response;
    try {
      resp = await fetch(`${ARGUS_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: creds.argusCookie,
          ...(ARGUS_API_TOKEN ? { "X-Argus-Token": ARGUS_API_TOKEN } : {}),
        },
        body: JSON.stringify({ confirmToken: token }),
      });
    } catch (err) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: humanizeError(err),
      });
      return;
    }

    let bodyJson: Record<string, unknown> = {};
    try {
      bodyJson = (await resp.json()) as Record<string, unknown>;
    } catch {
      bodyJson = {};
    }

    if (!resp.ok) {
      const errMsg = (bodyJson["error"] as string) || `HTTP ${resp.status}`;
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:x: ${op} 실패: \`${errMsg}\``,
      });
      return;
    }

    if (op === "cancel") {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `:wastebasket: 적용 취소 완료`,
      });
      return;
    }

    // apply 결과 — ApplyResult 의 summary 로 짧게 보고.
    const action2 = (bodyJson["action"] as string) || "";
    const summary = (bodyJson["summary"] as Record<string, number>) || {};
    const elapsed = (bodyJson["elapsedMs"] as number) || 0;
    const succeeded = (bodyJson["succeeded"] as unknown[]) || [];
    const failed = (bodyJson["failed"] as unknown[]) || [];
    const verb =
      action2 === "create" ? "생성" : action2 === "update" ? "수정" : action2 === "delete" ? "삭제" : "적용";
    const succN = succeeded.length;
    const failN = failed.length;
    const skipN = (summary["skipped"] as number) || 0;
    const parts = [`:white_check_mark: ${succN}개 ${verb}`];
    if (skipN > 0) parts.push(`${skipN}개 skip`);
    if (failN > 0) parts.push(`:x: ${failN}개 실패`);
    parts.push(`(${(elapsed / 1000).toFixed(1)}s)`);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: parts.join(" · "),
    });
  });

  // 추천 후속 질문 chip 클릭 핸들러. action_id = `followup_question:<index>`,
  // value = 질문 텍스트 (action_id 길이 제한 우회용 — 인덱스만 박고 value 에 텍스트).
  // 클릭 시 같은 thread 의 새 turn 으로 handle() 재호출 — 사용자가 직접 입력한
  // 것처럼 동작.
  app.action(/^followup_question:.+$/, async (ctx) => {
    const { ack, body, client, action } = ctx;
    await ack();

    const userId = (body as { user?: { id?: string } }).user?.id || "";
    const channel =
      (body as { channel?: { id?: string } }).channel?.id ||
      (body as { container?: { channel_id?: string } }).container?.channel_id ||
      "";
    const message = (body as { message?: { thread_ts?: string; ts?: string } })
      .message;
    const threadTs = message?.thread_ts || message?.ts || "";
    if (!channel || !threadTs || !userId) return;

    const question = (action as { value?: string }).value || "";
    if (!question) return;
    const threadKey = `${channel}:${threadTs}`;

    // 채널에 "<@user> selected: <질문>" 박아 다른 사람들도 맥락 유지.
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `<@${userId}> _후속 질문 선택:_ ${question}`,
    });

    // handle() 재호출 — say 를 client.chat.postMessage 로 래핑.
    await handle({
      text: question,
      userId,
      isDm: false,
      threadKey,
      threadTs,
      say: ((args: { text: string; thread_ts?: string; blocks?: unknown[] }) =>
        client.chat.postMessage({
          channel,
          text: args.text,
          thread_ts: args.thread_ts,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          blocks: args.blocks as any,
        })) as Parameters<typeof handle>[0]["say"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
  });

  await app.start();
  if (IS_MULTI_WORKSPACE) {
    console.log(
      `[argus-slack-bot] OAuth installer at http://localhost:${SLACK_OAUTH_PORT}/slack/install`,
    );
    console.log(
      "[argus-slack-bot] (외부 도달 가능한 redirect URL 을 Slack 앱 설정에 등록해야 OAuth 가 동작)",
    );
  }
  console.log(
    "[argus-slack-bot] connected (Socket Mode). DM me 'help' 또는 채널에서 @argus 멘션.",
  );

  // 4) Graceful shutdown
  const shutdown = async (sig: string) => {
    console.log(`[argus-slack-bot] received ${sig}, shutting down...`);
    try {
      await app.stop();
    } catch {}
    try {
      tokenStore.close();
    } catch {}
    try {
      installationStore?.close();
    } catch {}
    try {
      threadHistory.close();
    } catch {}
    try {
      await mcpPool.closeAll();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** 사용자 creds 룩업 + default 폴백. 미등록 사용자에게도 운영자 default
 *  토큰/쿠키 자동 적용. 등록 사용자는 본인 row 만 사용 (보안 격리).
 *  handle() 의 본 호출 흐름 + chip apply/cancel action handler 둘 다 같은
 *  의미여야 일관성 — 한쪽만 default 폴백 인지하면 'chip 보이는데 클릭하면
 *  cookie 미등록 안내' 같은 불일치 발생. */
function resolveUserCreds(
  userId: string,
  tokenStore: UserTokenStore,
): { creds: UserCreds; usingDefault: boolean } | null {
  const direct = tokenStore.get(userId);
  if (direct) {
    // 모든 사용자가 .env 의 DEFAULT_ARGUS_COOKIE 사용하도록 통일 — db 에
    // 등록된 사용자별 argus_cookie 는 무시. cookie 만료 시 .env 갱신 +
    // 봇 재기동 한 번으로 일괄 정상화 가능. 다른 필드 (whatap_api_token /
    // whatap_api_url) 는 사용자 등록값 유지 — 각자 자기 WhaTap 계정 토큰.
    return {
      creds: {
        ...direct,
        argusCookie: DEFAULT_ARGUS_COOKIE || direct.argusCookie,
      },
      usingDefault: false,
    };
  }
  if (DEFAULT_WHATAP_API_TOKEN) {
    return {
      creds: {
        whatapApiToken: DEFAULT_WHATAP_API_TOKEN,
        argusCookie: DEFAULT_ARGUS_COOKIE || undefined,
      },
      usingDefault: true,
    };
  }
  return null;
}

/** UserCreds + 운영측 ARGUS_URL/TOKEN → MCP child env 빌드.
 *  보안: 사용자가 cookie 미등록이면 빈 문자열로 명시 — 봇 process.env 의
 *  운영자 cookie 가 자식에 inherit 되지 않게.
 */
function buildMcpEnv(creds: UserCreds): Record<string, string> {
  const env: Record<string, string> = {
    WHATAP_API_TOKEN: creds.whatapApiToken,
    WHATAP_API_URL: creds.whatapApiUrl ?? DEFAULT_WHATAP_API_URL,
    ARGUS_COOKIE: creds.argusCookie ?? "",
  };
  if (ARGUS_URL) env.ARGUS_URL = ARGUS_URL;
  if (ARGUS_API_TOKEN) env.ARGUS_API_TOKEN = ARGUS_API_TOKEN;
  return env;
}

async function handleCommand(
  cmd: ParsedCommand,
  ctx: {
    userId: string;
    isDm: boolean;
    threadTs: string;
    say: (args: { text: string; thread_ts?: string; blocks?: unknown[] }) => Promise<unknown>;
    tokenStore: UserTokenStore;
  },
): Promise<void> {
  const { userId, isDm, threadTs, say, tokenStore } = ctx;

  switch (cmd.kind) {
    case "help":
      await say({ text: HELP_MESSAGE, thread_ts: threadTs });
      return;

    case "whoami": {
      const c = tokenStore.get(userId);
      if (!c) {
        if (DEFAULT_WHATAP_API_TOKEN) {
          await say({
            text: [
              ":robot_face: *데모 토큰으로 동작 중*",
              `• whatap-api-token: \`${maskToken(DEFAULT_WHATAP_API_TOKEN)}\` (default 폴백)`,
              `• argus-cookie: ${DEFAULT_ARGUS_COOKIE ? "`" + maskToken(DEFAULT_ARGUS_COOKIE) + "`" : "(없음)"}`,
              "",
              "자기 권한으로 사용하려면 `register <whatap-api-token>` 으로 등록.",
            ].join("\n"),
            thread_ts: threadTs,
          });
        } else {
          await say({
            text: ":no_entry_sign: 미등록 상태. `register <token>` 으로 등록하세요.",
            thread_ts: threadTs,
          });
        }
      } else {
        await say({
          text: [
            ":bust_in_silhouette: *등록 상태*",
            `• whatap-api-token: \`${maskToken(c.whatapApiToken)}\``,
            `• argus-cookie: ${c.argusCookie ? "`" + maskToken(c.argusCookie) + "`" : "(없음)"}`,
            `• whatap-api-url: \`${c.whatapApiUrl ?? "(default: " + DEFAULT_WHATAP_API_URL + ")"}\``,
          ].join("\n"),
          thread_ts: threadTs,
        });
      }
      return;
    }

    case "logout": {
      const removed = tokenStore.delete(userId);
      await say({
        text: removed
          ? ":wave: 등록 정보 삭제됨. 다시 사용하려면 `register <token>`."
          : ":no_entry_sign: 등록된 정보 없음.",
        thread_ts: threadTs,
      });
      return;
    }

    case "register": {
      if (!isDm) {
        await say({
          text:
            ":warning: 보안상 `register` 는 DM 으로만 받습니다. " +
            "@argus 멘션 말고 직접 DM 보내주세요.",
          thread_ts: threadTs,
        });
        return;
      }
      const token = (cmd.value ?? "").trim();
      if (!token) {
        await say({
          text: "사용법: `register <whatap-api-token>`",
          thread_ts: threadTs,
        });
        return;
      }
      const existing = tokenStore.get(userId);
      tokenStore.set(userId, {
        whatapApiToken: token,
        argusCookie: existing?.argusCookie,
        whatapApiUrl: existing?.whatapApiUrl,
      });
      await say({
        text: [
          `:white_check_mark: 토큰 등록됨 (\`${maskToken(token)}\`).`,
          existing?.argusCookie
            ? "기존 cookie 유지."
            : "더 깊은 답변(`ask_whatap_expert`) 원하면 `cookie <JSESSIONID=...>` 도 등록.",
          "이제 `@argus <질문>` 또는 DM 으로 질의 가능.",
        ].join("\n"),
        thread_ts: threadTs,
      });
      return;
    }

    case "cookie": {
      if (!isDm) {
        await say({
          text: ":warning: 보안상 `cookie` 는 DM 으로만 받습니다.",
          thread_ts: threadTs,
        });
        return;
      }
      const cookie = (cmd.value ?? "").trim();
      if (!cookie) {
        await say({
          text:
            "사용법: `cookie JSESSIONID=...` (브라우저 dev tools → Application → Cookies 에서 복사)",
          thread_ts: threadTs,
        });
        return;
      }
      const existing = tokenStore.get(userId);
      if (!existing) {
        await say({
          text: ":no_entry_sign: 먼저 `register <token>` 으로 등록해주세요.",
          thread_ts: threadTs,
        });
        return;
      }
      tokenStore.set(userId, {
        ...existing,
        argusCookie: cookie,
      });
      await say({
        text: `:cookie: cookie 저장됨 (\`${maskToken(cookie)}\`). ask_whatap_expert 활성화.`,
        thread_ts: threadTs,
      });
      return;
    }
  }
}

/** threadKey 는 "<channel>:<ts>" 포맷 — channel 추출. */
function getChannelFromThreadKey(threadKey: string): string {
  const idx = threadKey.indexOf(":");
  return idx > 0 ? threadKey.slice(0, idx) : threadKey;
}

/** 도구 호출 기록 → 답변 끝에 붙일 단일 라인 footer (italic). */
function renderToolFooter(log: ToolCallEntry[]): string {
  if (log.length === 0) return "";
  const items = log.map((t) => {
    const sec = (t.durationMs / 1000).toFixed(1);
    const mark = t.isError ? "❌ " : "";
    return `${mark}\`${t.name}\` (${sec}s)`;
  });
  return `_🔧 호출 도구 (${log.length}): ${items.join(" · ")}_`;
}

/** direct route 의 step list + 누적 text → Slack placeholder mrkdwn.
 *  whatap-front 의 step 가시화 흉내 — 봇 외곽 LLM 우회 시 사용자가 진행 상황
 *  실시간 확인 가능. 각 sub-tool 마다 ☑/⏳ + dur 표기.
 *
 *  argus message_stop 받기 전엔 마지막 step 의 doneAt 이 undefined → "..." 표시. */
function composeStepStreamingBody(snap: DirectRouteSnap): string {
  const parts: string[] = [];
  if (snap.steps.length === 0 && !snap.text) {
    return "_argus 가 답변 준비 중..._";
  }
  if (snap.steps.length > 0) {
    parts.push(":hourglass_flowing_sand: *argus 진행 중*");
    for (const s of snap.steps) {
      const desc = describeArgusSubTool(s.name);
      const mark = s.doneAt ? ":white_check_mark:" : ":hourglass_flowing_sand:";
      const dur = s.doneAt
        ? ` · ${((s.doneAt - s.startedAt) / 1000).toFixed(1)}s`
        : " · ...";
      const labelSuffix = desc !== s.name ? ` (${desc})` : "";
      parts.push(`${mark} \`${s.name}\`${labelSuffix}${dur}`);
    }
  }
  if (snap.text) {
    parts.push("");
    parts.push(toSlackMrkdwn(snap.text));
  }
  return parts.join("\n");
}

/** argus 가 발급한 추천 질문 (최대 5개) → Slack Block Kit button row.
 *  답변 본문에는 안 넣고 (LLM hallucinate 방지) chip 으로만. 사용자가 클릭하면
 *  app.action(`followup_question:.*`) 핸들러가 같은 thread 의 새 turn 으로 처리. */
function recommendedQuestionsToBlocks(questions: string[]): unknown[] {
  if (questions.length === 0) return [];
  // Slack action 블록은 한 row 에 element 최대 25개. 라벨 75자 제한.
  // argus 가 보통 3개라 충분.
  const elements = questions.slice(0, 5).map((q, i) => ({
    type: "button",
    text: {
      type: "plain_text",
      text: q.length > 75 ? q.slice(0, 72) + "..." : q,
    },
    action_id: `followup_question:${i}`,
    value: q,
  }));
  return [
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: ":sparkles: *추천 후속 질문 — 클릭하면 자동 전송:*" },
      ],
    },
    { type: "actions", elements },
  ];
}

/** cookie 미등록 사용자에게 적용 chip 발생 시 답변 본문에 추가할 안내.
 *  chipActionsToBlocks 가 cookie 없으면 chip 자체를 표시 안 하므로 사용자가
 *  "왜 적용 버튼이 없지?" 라고 헷갈리지 않게 명시. apply/cancel event-rule chip
 *  이 한 개라도 있고 cookie 가 없을 때만 표시. */
function renderCookieGateHint(actions: ChipAction[], creds: UserCreds): string {
  if (creds.argusCookie) return "";
  const hasApplyChips = actions.some(
    (a) =>
      a.type === "applyEventRules" || a.type === "cancelEventRules",
  );
  if (!hasApplyChips) return "";
  return (
    "_:lock: 적용 / 취소 버튼은 argus cookie 가 필요해 비활성됨. " +
    "DM 으로 `cookie <JSESSIONID=...>` 등록 후 다시 질문하면 chip 활성화._"
  );
}

/** 스트리밍 중 placeholder 메시지의 본문 합성.
 *  텍스트 + 진행중 도구 indicator + 누적 도구 footer.
 *  ask_whatap_expert 안이면 sub-tool 까지 표시.
 */
function composeStreamingBody(args: {
  text: string;
  toolInProgress?: { name: string; input?: unknown; subTool?: string };
  toolCallLog: ToolCallEntry[];
}): string {
  const parts: string[] = [];
  if (args.text) {
    parts.push(toSlackMrkdwn(args.text));
  } else {
    parts.push("_argus 가 답변 중..._");
  }
  if (args.toolInProgress) {
    if (args.toolInProgress.subTool) {
      const subDesc = describeArgusSubTool(args.toolInProgress.subTool);
      parts.push(
        `_⏳ \`${args.toolInProgress.name}\` → ${subDesc} (\`${args.toolInProgress.subTool}\`)..._`,
      );
    } else {
      parts.push(`_⏳ \`${args.toolInProgress.name}\` 호출 중..._`);
    }
  }
  const footer = renderToolFooter(args.toolCallLog);
  if (footer) parts.push(footer);
  return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────────
// chip → Slack Block Kit button 변환 + apply / cancel 핸들러
// ─────────────────────────────────────────────────────────────

import type { ChipAction } from "./claude-loop.js";

// chipActionsToBlocks — argus 도구 응답에서 추출된 chip actions 를 Slack Block
// Kit `actions` 블록(button row) 으로 변환. action_id 에 confirmToken 박아서
// 클릭 시 추적 가능. action_id 길이 제한 255자라 token 자체가 길면 잘릴 수
// 있는데, argus 의 `ct_<base64url 16bytes>` 는 22자라 안전.
//
// 정식 contract (cross-repo): argus/internal/tools/CLAUDE.md
// "Chip `actions[]` 발급 규약" 섹션. 새 chip type 추가 시 거기 체크리스트 따를 것.
//
// 지원 chip = event-rule / flex-event 의 apply/cancel 만. payload 에
// confirmToken 있는 6 타입 (whatap_bulk_{create,update,delete}_event_rule +
// 동일 flex_event 3종). 봇이 /v1/event-rules/{apply,cancel} 로 호출.
//
// 지원 X chip:
//   - applyDashboard / addWidgets / addFlexboardWidgets — confirmToken 없음
//     (widgets/dashboardPath payload). 브라우저 측 처리용 chip — 봇에선 silently
//     skip 됨. 봇에 표시할 적용 endpoint 가 argus 측에 아직 없음.
//
// 같은 turn 에 여러 chip 쌍이 발급된 경우 (예: Critical + Warning 룰 두 번 등록)
// 각 쌍이 별도 row 로 보임. 한 row 에 너무 많이 쏟으면 Slack UX 떨어짐.
//
// creds.argusCookie 없으면 chip 표시 자체를 안 함 — argus 의
// /v1/event-rules/{apply,cancel} 핸들러가 chat.CookieAuthMiddleware 라 token
// 만으론 401. chip 보여주고 클릭 후 거부하는 것보다 표시 안 하는 게 UX 일관성
// ↑. 호출자가 "cookie 없음" 안내를 답변 본문에 추가 (renderCookieGateHint 참고).
function chipActionsToBlocks(actions: ChipAction[], creds: UserCreds): unknown[] {
  if (actions.length === 0) return [];
  if (!creds.argusCookie) return [];

  // apply / cancel 을 한 row 에 묶어 보기. 같은 confirmToken 끼리.
  const byToken = new Map<string, ChipAction[]>();
  let droppedBrowserChips = 0;
  for (const a of actions) {
    const token = (a.payload?.["confirmToken"] as string) || "";
    if (!token) {
      // 브라우저용 chip (applyDashboard / addWidgets / addFlexboardWidgets)
      droppedBrowserChips++;
      continue;
    }
    const arr = byToken.get(token) || [];
    arr.push(a);
    byToken.set(token, arr);
  }
  if (droppedBrowserChips > 0) {
    console.log(
      `[argus-slack-bot] dropped ${droppedBrowserChips} browser-only chip(s) (dashboard / flexboard)`,
    );
  }

  const blocks: unknown[] = [];
  for (const [token, group] of byToken) {
    const elements = group.map((a) => {
      const isApply = a.type === "applyEventRules";
      return {
        type: "button",
        text: {
          type: "plain_text",
          text: a.label.length > 75 ? a.label.slice(0, 72) + "..." : a.label,
        },
        // action_id 에 type prefix + token 박아서 핸들러가 분기.
        action_id: `${isApply ? "apply" : "cancel"}_event_rule:${token}`,
        style: isApply ? "primary" : undefined,
        value: token,
      };
    });
    blocks.push({ type: "actions", elements });
  }
  return blocks;
}

// withTextSection — text chunk 를 section block 으로 감싸고 chip blocks 를
// 뒤에 붙임. blocks 가 비면 undefined 반환 (fallback to text-only).
function withTextSection(text: string, chipBlocks: unknown[]): unknown[] | undefined {
  if (chipBlocks.length === 0) return undefined;
  // Slack section block text 는 3000자 제한. 그 이상이면 splitForSlack 가 이미
  // 잘랐을 텐데 안전하게 한 번 더 truncate.
  const safeText = text.length > 2900 ? text.slice(0, 2897) + "..." : text;
  return [
    { type: "section", text: { type: "mrkdwn", text: safeText } },
    ...chipBlocks,
  ];
}

main().catch((err) => {
  console.error("[argus-slack-bot] fatal:", err);
  process.exit(1);
});
