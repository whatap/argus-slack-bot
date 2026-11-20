// src/index.ts
//
// argus-slack-bot 진입점.
// Slack Bolt App (Socket / HTTP) + 사용자 OAuth Argus 직접 호출, legacy MCP 경로.
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
import http from "node:http";

import { ArgusStreamError, describeArgusSubTool, type ArgusDirectConfig } from "./argus-direct.js";
import { runClaudeWithMcp, type ToolCallEntry } from "./claude-loop.js";
import { ThreadHistory, dmMainThreadKey, isDmMainThreadKey } from "./conversation.js";
import { runDirectToArgus, type DirectRouteSnap } from "./direct-route.js";
import { authorizationKind, createBotDmGuard, type ConversationsInfoClient } from "./dm-guard.js";
import {
  chipStatus,
  describeApplyResult,
  describeEventRuleOpError,
  missingScope,
  renderRulePreview,
  resolveChipBlocks,
  WRITE_CONSENT_LEAD,
} from "./event-rule-chips.js";
import { AlertThreads, alertSource, alertTimeZone, incidentPrompt, isAlertEnvelope, readAlert } from "./webhook-alerts.js";
import { humanizeError } from "./humanize.js";
import { inferCurrentUrl } from "./screen-infer.js";
import { SqliteInstallationStore } from "./installations.js";
import { landingPageHtml } from "./landing.js";
import { privacyPageHtml, termsPageHtml, supportPageHtml } from "./legal.js";
import { McpClientPool } from "./mcp-pool.js";
import {
  OncallIncidents,
  OncallKeepAlive,
  OncallOwners,
  escalationText,
  loadOncallSettings,
  oncallLog,
  oncallSettingsLines,
  parseOncallCommand,
  pickAutoOpm,
  resolvedAfterApply,
  ruleEligible,
  systemTimers,
  type OncallSettings,
  type OpmPick,
} from "./oncall-auto.js";
import {
  OPM_CHIP_TYPE,
  OPM_CONSENT_LEAD,
  OPM_NO_ANSWER,
  OPM_PENDING,
  OpmChipStore,
  describeOpmError,
  describeOpmOutcome,
  opmChipBlocks,
  opmStamp,
  opmStatusRow,
  opmText,
  postOpmAction,
  renderOpmProposal,
  replaceOpmRow,
  riskOf,
  type OpmOp,
} from "./opm-action-chips.js";
import {
  PendingLogins,
  createOAuthHttpHandler,
  loginStartUrl,
} from "./oauth-http.js";
import { splitForSlack, toSlackMrkdwn } from "./slack-format.js";
import { createSlackApp, loadSlackSettings } from "./slack-app.js";
import { createSlackFailureHandler } from "./slack-failure-log.js";
import { createSlackLifecycleHandlers } from "./slack-lifecycle.js";
import { ACCOUNT_SETUP_GUIDANCE, WHATAP_LOGIN_HELP } from "./onboarding.js";
import { TurnQueue } from "./turn-queue.js";
import { UserTokenStore, maskToken, type UserCreds } from "./user-tokens.js";
import { WhatapLinkStore } from "./whatap-links.js";
import {
  LoginRequiredError,
  WhatapOAuthClient,
  WhatapTokenManager,
  loadWhatapOAuthSettings,
  type WhatapOAuthSettings,
} from "./whatap-oauth.js";

// ── 환경변수 검사 ─────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[argus-slack-bot] ${name} env 미설정 — .env.example 참고.`);
    process.exit(1);
  }
  return v;
}

const SLACK_SETTINGS = loadSlackSettings(process.env);
const IS_MULTI_WORKSPACE = SLACK_SETTINGS.multiWorkspace;

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
const ANTHROPIC_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 8192);
// 외곽 hop 한계. argus 자체가 내부 maxHops=8 으로 도구 루프 돌리니, 외곽은
// ask_whatap_expert 한 번이면 충분 (보통 hop 1~2). 외곽 8 + 내부 8 = 최악 64 hop
// 비용 폭주 방지로 외곽은 3 으로 낮춤. env 로 override 가능.
const MAX_TOOL_HOPS = Number(process.env.MAX_TOOL_HOPS || 3);
const MAX_HISTORY_TURNS = Number(process.env.MAX_HISTORY_TURNS || 10);
/** argus 가 앞 대화를 몰라서 새 대화로 답했을 때 답변 앞에 붙이는 안내. */
const STARTED_OVER_NOTE = "_앞 대화를 이어갈 수 없어서 새 대화로 답했어요. 필요한 내용은 다시 알려 주세요._";
/** 같은 대화의 앞 턴을 기다리는 상한. argus 요청 상한(argus-direct 의 120초)보다 조금 길게 잡는다. */
const TURN_WAIT_MS = 150_000;

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

// 와탭 로그인(OAuth) 모드. WHATAP_OAUTH_ISSUER·CLIENT_ID·CLIENT_SECRET·REDIRECT_URI 가
// 모두 있으면 켠다. 사용자는 Slack 에서 login 으로 와탭 계정을 연결하고, 질문은 그 사용자
// 토큰으로 front 의 /argus/v1/chat 에 간다 (cookie·X-Argus-Token·기본 토큰 폴백 없음).
// 일부만 있으면 조용히 기존 방식으로 떨어지지 않게 시작하지 않는다.
let WHATAP_LOGIN: WhatapOAuthSettings | null = null;
// Webhook JSON 알림의 epoch 시각을 보일 시간대(IANA 이름). 없으면 그런 알림은 읽지 않는다(지금과 같다).
let ALERT_TIME_ZONE: string | undefined;
// 자동 대응(온콜, ONCALL_AUTO=1). 꺼져 있으면(기본) null 이고 지금과 똑같이 동작한다(oncall-auto.ts).
let ONCALL: OncallSettings | null = null;
try {
  WHATAP_LOGIN = loadWhatapOAuthSettings(process.env);
  if (SLACK_SETTINGS.transport === "http" && IS_MULTI_WORKSPACE && !WHATAP_LOGIN) {
    throw new Error("공개 HTTP 다중 워크스페이스 모드에는 와탭 OAuth 설정이 필요해요");
  }
  ALERT_TIME_ZONE = alertTimeZone(process.env);
  ONCALL = loadOncallSettings(process.env, { whatapLogin: !!WHATAP_LOGIN, alertChannel: !!alertSource(process.env) });
} catch (err) {
  console.error(`[argus-slack-bot] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Slack App ID — OAuth 콜백 성공 시 사용자를 자기 Slack workspace 로 다시
// 보내는 deep link 에 박힘 (slack.com/app_redirect?app=<id>&team=<team>).
// App Directory 등재 검증 요구사항 — Redirect URL 이 200 HTML 페이지가 아니라
// slack.com 으로 302 해야 함. App ID 는 api.slack.com/apps/<ID> 의 ID 부분.
const SLACK_APP_ID = SLACK_SETTINGS.appId;
// 사용자 OAuth 직접 경로에는 외곽 LLM/MCP 자격증명이 필요 없다.
const ANTHROPIC_API_KEY = WHATAP_LOGIN ? "" : requireEnv("ANTHROPIC_API_KEY");
const WHATAP_MCP_PATH = WHATAP_LOGIN ? "" : requireEnv("WHATAP_MCP_PATH");

// 설정 유무만 기록한다. 토큰 prefix 도 로그에 남기지 않는다.
console.log(
  `[argus-slack-bot/debug] ARGUS_URL=${ARGUS_URL || "<empty>"} ARGUS_API_TOKEN_set=${!!ARGUS_API_TOKEN}`,
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
  kind: "register" | "cookie" | "whoami" | "logout" | "help" | "login";
  value?: string;
}

function parseCommand(text: string, whatapLogin = false): ParsedCommand | null {
  const trimmed = text.trim();
  // login 은 와탭 로그인 모드에서, 메시지 전체가 login 일 때만 명령으로 본다
  // ("login 실패율 보여줘" 같은 질문을 가로채지 않게).
  if (whatapLogin && /^(login|로그인)$/i.test(trimmed)) {
    return { kind: "login" };
  }
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
    ? new SqliteInstallationStore(INSTALLATIONS_DB, TOKENS_ENCRYPTION_KEY || undefined)
    : null;
  // OPM 조치안의 확인 토큰 — 버튼에는 손잡이만 싣고 토큰은 여기(메모리)에만 둔다.
  const opmChips = new OpmChipStore();
  console.log(
    `[argus-slack-bot] token DB: ${USER_TOKENS_DB} encryption: ${
      tokenStore.isEncrypted() ? "enabled (AES-256-GCM)" : "DISABLED (plaintext)"
    }`,
  );
  if (installationStore) {
    console.log(
      `[argus-slack-bot] mode=multi-workspace installations=${installationStore.count()} oauth-port=${SLACK_SETTINGS.port}`,
    );
  } else {
    console.log("[argus-slack-bot] mode=single-workspace (SLACK_BOT_TOKEN)");
  }

  // 2) Anthropic + thread history (SQLite-backed, 봇 재시작 후에도 thread 유지)
  const anthropic = WHATAP_LOGIN ? undefined : new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const threadHistory = new ThreadHistory(
    MAX_HISTORY_TURNS,
    30 * 60 * 1000,
    THREAD_HISTORY_DB,
  );
  console.log(`[argus-slack-bot] thread history DB: ${THREAD_HISTORY_DB}`);
  const turns = new TurnQueue(TURN_WAIT_MS);

  // MCP client 풀 — 사용자별 keep-warm child. 매 요청 spawn 오버헤드 (0.5-1s)
  // 제거. 사용자 creds 변경 시 envHash 로 자동 재spawn.
  const mcpPool = new McpClientPool(WHATAP_MCP_PATH);
  console.log("[argus-slack-bot] mcp pool: keep-warm enabled (idle=5min)");

  // 와탭 로그인 모드 — 연결 저장소(암호화 필수) + /oauth/start·/oauth/callback 리스너.
  let whatapLogin: WhatapLoginRuntime | null = null;
  let oauthServer: http.Server | null = null;
  // Single-workspace admission stays closed until auth.test verifies identity.
  let singleWorkspace: { teamId: string; botUserId: string } | undefined;
  const isWorkspaceActive = (teamId: string): boolean => installationStore
    ? installationStore.getBotIdentity(teamId) !== null
    : singleWorkspace?.teamId === teamId;
  if (WHATAP_LOGIN) {
    const store = new WhatapLinkStore(USER_TOKENS_DB, TOKENS_ENCRYPTION_KEY);
    const oauthClient = new WhatapOAuthClient(WHATAP_LOGIN.oauth);
    const pending = new PendingLogins({ isWorkspaceActive });
    whatapLogin = {
      settings: WHATAP_LOGIN,
      store,
      pending,
      manager: new WhatapTokenManager(store, oauthClient),
    };
    oauthServer = http.createServer(
      createOAuthHttpHandler({ client: oauthClient, store, pending, slackAppId: SLACK_APP_ID }),
    );
    const { listenHost, listenPort } = WHATAP_LOGIN;
    await new Promise<void>((resolve, reject) => {
      oauthServer!.once("error", reject);
      oauthServer!.listen(listenPort, listenHost, () => resolve());
    });
    console.log(
      `[argus-slack-bot] whatap login enabled: issuer=${WHATAP_LOGIN.oauth.issuer} client=${WHATAP_LOGIN.oauth.clientId} callback=${WHATAP_LOGIN.oauth.redirectUri} listen=${listenHost}:${listenPort} argus=${ARGUS_URL}/v1/chat`,
    );
  }

  // 3) 같은 핸들러를 Socket 또는 서명 검증 HTTP receiver 에 연결한다.
  const app = createSlackApp(SLACK_SETTINGS, {
    installationStore: installationStore ?? undefined,
    customRoutes: [
      { path: "/", render: landingPageHtml },
      { path: "/privacy", render: privacyPageHtml },
      { path: "/terms", render: termsPageHtml },
      { path: "/support", render: supportPageHtml },
    ].map(({ path, render }) => ({
      path,
      method: ["GET"],
      handler: (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(render());
      },
    })),
  });
  // 실패한 Slack 처리마다 시각·workspace·채널을 남긴다(본문·토큰 제외).
  app.error(createSlackFailureHandler((...args) => console.error(...args)));
  const isBotDm = createBotDmGuard();
  const source = whatapLogin ? alertSource(process.env) : undefined;

  const entries = new AlertThreads();
  // 자동 대응(온콜). 꺼져 있으면(기본) 아무것도 만들지 않는다 — 지금과 똑같이 [분석] 버튼만 붙인다.
  // 당번은 와탭 연결과 같은 DB 파일에 둔다(봇이 다시 시작해도 남는다). 사건 상태·타이머는 메모리에만 둔다.
  const oncall = ONCALL && whatapLogin && source
    ? { settings: ONCALL, login: whatapLogin, source, owners: new OncallOwners(USER_TOKENS_DB), incidents: new OncallIncidents(systemTimers) }
    : undefined;
  const oncallLine = (fields: { root?: string; owner: string; step: string; [key: string]: string | number | undefined }) =>
    oncall && console.log(oncallLog({ ...fields, team: oncall.source.team, channel: oncall.source.channel }, systemTimers.now()));

  /** 알림 채널에서 받은 자동 대응 명령. 켜기는 와탭 토큰이 살아 있는 사람만, 끄기는 누구나(멈춤 스위치)다. */
  const runOncallCommand = async (command: "on" | "off" | "status", ctx: { userId: string; threadTs?: string; client: OncallSlack }) => {
    if (!oncall) return;
    const { team, channel } = oncall.source;
    if (!/^U[A-Z0-9]+$/.test(ctx.userId) || !isWorkspaceActive(team)) return;
    const post = (text: string) => ctx.client.chat.postMessage({ channel, thread_ts: ctx.threadTs, text });
    const privateCtx: PrivateReplyContext = { teamId: team, userId: ctx.userId, isDm: false, channel, threadTs: ctx.threadTs, say: (args) => post(args.text), client: ctx.client };
    if (command === "on") {
      // 당번의 와탭 권한으로 분석·조치하므로, 지금 쓸 수 있는 토큰이 있어야 켠다.
      try {
        await oncall.login.manager.withAccessToken(team, ctx.userId, async () => undefined);
      } catch (err) {
        if (err instanceof LoginRequiredError) {
          await sendWhatapLoginLink(oncall.login, privateCtx, ONCALL_LOGIN_LEAD);
          return;
        }
        console.warn(`[argus-slack-bot] oncall arm token check failed user=${ctx.userId}: ${String(err)}`);
        await replyPrivately(privateCtx, ":warning: 와탭 로그인 서버에 닿지 않아 자동 대응을 켜지 못했어요. 잠시 뒤 다시 보내 주세요.");
        return;
      }
      oncall.owners.set(team, channel, ctx.userId);
      oncallLine({ owner: ctx.userId, step: "armed" });
      await post([`:robot_face: 자동 대응을 켰어요. 당번: <@${ctx.userId}>`, ...oncallSettingsLines(oncall.settings)].join("\n"));
      return;
    }
    if (command === "off") {
      // 멈춤 스위치 — 채널의 누구나 끌 수 있다. 다음 알림부터 다시 [분석] 버튼을 붙인다.
      const owner = oncall.owners.get(team, channel);
      if (!oncall.owners.clear(team, channel)) {
        await post("자동 대응은 이미 꺼져 있어요. 새 알림에는 [분석] 버튼을 붙여요.");
        return;
      }
      oncallLine({ owner: owner ?? "-", step: "disarmed", by: ctx.userId });
      await post(`:octagonal_sign: <@${ctx.userId}> 님이 자동 대응을 껐어요. 새 알림에는 다시 [분석] 버튼을 붙여요.`);
      return;
    }
    const owner = oncall.owners.get(team, channel);
    await post(owner
      ? [`:robot_face: 자동 대응이 켜져 있어요. 당번: <@${owner}>`, ...oncallSettingsLines(oncall.settings)].join("\n")
      : "자동 대응은 꺼져 있어요. 새 알림에는 [분석] 버튼을 붙여요. 켜려면 `자동 대응 켜기` 를 보내 주세요(보낸 사람이 당번이 돼요).");
  };

  /** 이벤트 밖(타이머)에서 알림 채널에 글을 쓸 client — 그 워크스페이스의 봇 토큰(멀티는 설치 기록, 단일은 SLACK_BOT_TOKEN). */
  const slackFor = async (teamId: string): Promise<OncallSlack> => {
    const token = installationStore
      ? (await installationStore.fetchInstallation({ teamId, enterpriseId: undefined, isEnterpriseInstall: false })).bot?.token
      : SLACK_SETTINGS.botToken;
    if (!token) throw new Error(`bot token missing team=${teamId}`);
    return { chat: {
      postMessage: (args) => app.client.chat.postMessage({ ...args, token } as never),
      postEphemeral: (args) => app.client.chat.postEphemeral({ ...args, token } as never),
    } };
  };

  // 당번 토큰 유지(keep-alive). 와탭 갱신 토큰은 8시간이면 끝나고 갱신할 때마다 새로 받는다 — 알림이 오래 없어도
  // 끊기지 않게 정해 둔 주기마다 한 번씩 쓴다. 갱신이 거절되면(로그인 만료) 채널에 한 번만 알리고 당번은 그대로 둔다.
  if (oncall) {
    new OncallKeepAlive({
      timers: systemTimers,
      everyMs: oncall.settings.keepAliveMin * 60_000,
      owners: () => oncall.owners.list().filter((o) =>
        o.teamId === oncall.source.team && o.channelId === oncall.source.channel && isWorkspaceActive(o.teamId)),
      refresh: (teamId, ownerId) => oncall.login.manager.withAccessToken(teamId, ownerId, async () => undefined),
      notifyExpired: async (o) => {
        const slack = await slackFor(o.teamId);
        await slack.chat.postMessage({ channel: o.channelId,
          text: `:lock: <@${o.ownerId}> 와탭 로그인이 만료돼 자동 대응을 멈췄어요. 다시 로그인하면 이어서 해요. 그동안 새 알림에는 [분석] 버튼을 붙여요.` });
        await sendWhatapLoginLink(oncall.login, {
          teamId: o.teamId, userId: o.ownerId, isDm: false, channel: o.channelId,
          say: (args) => slack.chat.postMessage({ channel: o.channelId, text: args.text }), client: slack,
        }, ONCALL_EXPIRED_LEAD);
      },
      log: (line) => console.log(line),
    }).start();
  }

  // 삭제 이벤트는 Bolt authorize 를 건너뛴다. 단일 workspace 의 신원은 미리 검증한다.
  if (!IS_MULTI_WORKSPACE) {
    const identity = await app.client.auth.test({ token: SLACK_SETTINGS.botToken });
    if (!identity.team_id || !identity.user_id) throw new Error("Slack bot workspace identity is missing");
    singleWorkspace = { teamId: identity.team_id, botUserId: identity.user_id };
  }
  const lifecycle = createSlackLifecycleHandlers({
    installationStore,
    whatap: whatapLogin,
    singleWorkspace,
    onWorkspaceDeleted: (teamId) => {
      if (singleWorkspace?.teamId === teamId) singleWorkspace = undefined;
      if (teamId === source?.team) entries.clear();
      // 지운 워크스페이스의 당번은 남기지 않는다(다시 설치해도 예전 당번으로 자동 대응하지 않게).
      if (oncall && oncall.owners.deleteTeam(teamId) > 0) oncallLine({ owner: "-", step: "disarmed", by: "uninstall" });
      threadHistory.deleteWorkspace(teamId);
    },
  });
  app.event("app_uninstalled", lifecycle.appUninstalled);
  app.event("tokens_revoked", lifecycle.tokensRevoked);

  // 메시지 핸들러 — app_mention / DM 둘 다.
  // client = event 컨텍스트의 워크스페이스별 WebClient (multi-workspace 에선
  // bot_token 이 워크스페이스 마다 다르므로 app.client 가 아니라 이걸 써야 함).
  const handle = async (params: {
    text: string;
    userId: string;
    /** Slack workspace(team) id. 와탭 로그인 연결은 team + user 로 구분한다. */
    teamId: string;
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
        postEphemeral: (args: {
          channel: string;
          user: string;
          text: string;
          thread_ts?: string;
        }) => Promise<unknown>;
      };
    };
    // undefined 면 main DM 흐름에 답함 (새 DM 메시지). string 이면 그 thread 안 reply
    // (채널 멘션 또는 사용자가 명시적으로 thread 안에서 보낸 케이스).
    threadTs?: string;
    /** A followup captures this before ACK, not after its asynchronous notice. */
    history?: ReturnType<ThreadHistory["forWorkspace"]>;
    /**
     * 이 대화가 처음이면 이어받을 대화의 threadKey. DM 본문 메시지 밑에 스레드를 열어 답한 경우
     * (봇이 적용 결과를 스레드에 단다) 본문에서 하던 대화를 잇는다.
     */
    inheritFrom?: string;
    /**
     * 질문이 가리키는 프로젝트를 봇이 이미 알 때(알림의 프로젝트 코드). 이 값이 있으면 글의 낱말로
     * 화면·프로젝트를 추론하지 않는다 — 알림 규칙 이름이 다른 프로젝트의 화면 질문처럼 읽힐 수 있다.
     */
    pcode?: number;
    /**
     * 자동 대응(온콜)으로 연 분석일 때만. 답의 OPM 조치안 가운데 자동으로 실행할 하나를 버튼에서 빼고(pick),
     * 답을 올린 뒤(대화 차례를 넘긴 다음) 그 조치를 실행한다(answered). 나머지는 지금처럼 버튼이다.
     */
    opmAuto?: {
      pick: (chips: ChipAction[]) => OpmPick;
      answered: (pick: OpmPick) => Promise<void>;
    };
  }) => {
    const { text, userId, teamId, isDm, threadKey, say, client, threadTs } = params;
    if (!text) return;
    if (!/^T[A-Z0-9]+$/.test(teamId) || !userId) {
      console.warn("[argus-slack-bot] ignored event without workspace/user identity");
      return;
    }
    const history = params.history ?? threadHistory.forWorkspace(teamId);
    if (!history.isActive() || !isWorkspaceActive(teamId)) return;
    // 로그인 링크·계정 정보처럼 본인만 봐야 하는 답을 보낼 곳 (DM 이면 DM, 채널이면 ephemeral).
    const privateCtx: PrivateReplyContext = {
      teamId,
      userId,
      isDm,
      channel: getChannelFromThreadKey(threadKey),
      threadTs,
      say,
      client,
    };

    // ── 명령 처리 (register/cookie/whoami/logout/help, 와탭 로그인 모드는 login 포함) ─
    // 자동 대응 명령은 알림 채널의 멘션에서만 받는다(app_mention 이 먼저 가로챈다). 그 밖에서 온 것은 켜거나 끄지 않고
    // Argus 에도 묻지 않는다 — 보낸 사람에게만 어디서 쓰는지 알린다.
    if (oncall && parseOncallCommand(text)) {
      await replyPrivately(privateCtx, ":information_source: 자동 대응 명령은 알림 채널에서 저를 멘션해 보내 주세요.");
      return;
    }
    const cmd = parseCommand(text, !!whatapLogin);
    if (cmd) {
      if (whatapLogin) {
        await handleWhatapLoginCommand(cmd, whatapLogin, privateCtx);
        return;
      }
      await handleCommand(cmd, {
        userId,
        isDm,
        threadTs,
        say,
        tokenStore,
      });
      return;
    }

    // ── 자격 확인 ───────────────────────────────────────────
    // 와탭 로그인 모드: 연결된 와탭 계정이 있어야 한다 (기본 토큰 폴백 없음). 토큰이 곧
    // 만료되면 여기서 미리 갱신된다.
    // 기존 모드: 사용자 creds 룩업 (없으면 default 폴백).
    let creds: UserCreds | undefined;
    if (whatapLogin) {
      try {
        await whatapLogin.manager.accessToken(teamId, userId);
      } catch (err) {
        if (!history.isActive()) return;
        if (err instanceof LoginRequiredError) {
          await sendWhatapLoginLink(whatapLogin, privateCtx, loginLinkLead(err));
          return;
        }
        console.error(`[argus-slack-bot] whatap token refresh failed user=${userId}:`, err);
        await say({
          text: ":warning: 와탭 로그인 서버에 닿지 않아 토큰을 갱신하지 못했어요. 잠시 후 다시 질문하세요.",
          thread_ts: threadTs,
        });
        return;
      }
    } else {
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
      creds = resolved.creds;
      if (resolved.usingDefault) {
        console.log(`[argus-slack-bot] user=${userId} using default creds`);
      }
    }

    if (!history.isActive()) return;
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
    // 와탭 로그인 모드는 항상 direct — access token 은 호출 직전에 manager 가 채운다.
    const argusDirect: ArgusDirectConfig | undefined = whatapLogin
      ? { url: ARGUS_URL, apiToken: "" }
      : ARGUS_URL && ARGUS_API_TOKEN
        ? {
            url: ARGUS_URL,
            apiToken: ARGUS_API_TOKEN,
            cookie: creds?.argusCookie,
          }
        : undefined;

    // ── 스트리밍 placeholder 업데이트 ──────────────────────────
    // 800ms throttle — Slack rate limit 회피 + 깜빡임 방지.
    const STREAM_INTERVAL_MS = 800;
    const channel = getChannelFromThreadKey(threadKey);
    let lastUpdateAt = 0;
    let lastSentText = "";
    const flushUpdate = async (display: string) => {
      if (!history.isActive()) return;
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
    // 와탭 로그인 모드에선 argus 대화가 사용자 소유라(다른 사용자의 conversationId 는
    // argus 가 NOT_FOUND 로 거절) 채널 thread 안에서도 사용자별로 이어 간다.
    const convKeyOf = (key: string) => (whatapLogin ? `${key}#${userId}` : key);
    const convKey = convKeyOf(threadKey);
    // 같은 대화의 앞 턴이 끝난 뒤에 시작한다 — 앞 턴이 저장한 대화 ID 를 이어받고, argus 의 한 대화를
    // 두 턴이 동시에 만지지 않게(turn-queue.ts). DM 스레드는 이어받을 본문 대화와 같은 줄에 선다.
    const leaveTurn = await turns.enter(convKeyOf(params.inheritFrom ?? threadKey));
    const t0 = Date.now();
    // argus 가 모르는 대화라 새 대화로 다시 물었는지. 앞 내용이 빠진 답이라는 것을 답변에 알린다.
    let startedOver = false;
    // 자동 대응: 버튼에서 뺀 자동 실행 조치안과 나머지. 답을 다 올렸을 때만(answered) 그 조치를 실행한다.
    let opmPick: OpmPick | undefined;
    let answered = false;

    try {
      if (!history.isActive()) return;
      // state 를 읽어 온 키. DM 스레드가 본문 대화를 이어받았으면 본문 대화의 키다.
      let stateKey = convKey;
      let state = history.get(convKey);
      if (params.inheritFrom && !state.argusConversationId && state.history.length === 0) {
        stateKey = convKeyOf(params.inheritFrom);
        state = history.get(stateKey);
      }
      if (argusDirect) {
        // 정상 경로: 봇 외곽 LLM 우회. argus /v1/chat SSE 직접 소비.
        // 사용자 메시지에서 화면 의도 + pcode 추론 → 가짜 currentUrl 박음.
        // argus 의 screens.Lookup() 이 매칭 → cpm.yaml 의 domain_knowledge /
        // analysis_guides / data_registry inject. whatap-front 패널과 같은 효과.
        // (와탭 로그인 모드에서도 같은 본문이 front 의 /argus/v1/chat 으로 간다.)
        const inferred = params.pcode === undefined ? inferCurrentUrl(text) : undefined;
        if (inferred) {
          console.log(
            `[argus-slack-bot] screen inferred: ${inferred.currentUrl}`,
          );
        }
        let conversationId = state.argusConversationId;
        const askArgus = (cfg: ArgusDirectConfig) =>
          runDirectToArgus(
            {
              argusDirect: cfg,
              argusConversationId: conversationId,
              onProgress: (snap) => {
                const now = Date.now();
                if (now - lastUpdateAt < STREAM_INTERVAL_MS) return;
                lastUpdateAt = now;
                void flushUpdate(composeStepStreamingBody(snap));
              },
            },
            text,
            params.pcode ?? inferred?.pcode,
            inferred?.currentUrl,
          );
        // 와탭 로그인 모드: argus 가 401 이면 토큰을 한 번 갱신해 다시 묻는다.
        const ask = () =>
          whatapLogin
            ? whatapLogin.manager.withAccessToken(teamId, userId, (accessToken) =>
                askArgus({ ...argusDirect, accessToken }),
              )
            : askArgus(argusDirect);
        try {
          result = await ask();
        } catch (err) {
          // argus 가 이 대화를 모른다 — 다른 와탭 계정으로 다시 로그인했거나 대화가 지워졌다. DM 본문은 한
          // 대화로 계속 이어지므로, 그대로 두면 매 메시지가 같은 오류로 끝난다. argus 는 대화를 읽기 전에
          // 거절하므로 실행된 것이 없다 — 저장한 대화를 버리고 새 대화로 한 번만 다시 묻는다.
          if (!conversationId || !(err instanceof ArgusStreamError) || err.code !== "NOT_FOUND") throw err;
          console.warn(
            `[argus-slack-bot] argus does not know the stored conversation, starting a new one user=${userId} thread=${threadKey}`,
          );
          history.reset(stateKey);
          conversationId = undefined;
          startedOver = true;
          result = await ask();
        }
      } else {
        // legacy fallback: argusDirect 미설정 (배포 환경에서만 발생).
        // MCP child 풀에서 acquire + 외곽 LLM tool_use loop.
        // (와탭 로그인 모드는 argusDirect 가 항상 있어 여기 오지 않는다.)
        if (!creds || !anthropic) throw new Error("legacy MCP route requires user creds and LLM configuration");
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
      if (!history.isActive()) return;
      const dur = Date.now() - t0;
      console.log(
        `[argus-slack-bot] user=${userId} thread=${threadKey} hops=${result.hops} dur=${dur}ms text_len=${result.text.length}`,
      );

      history.appendTurn(convKey, result.newMessages);
      if (result.argusConversationId) {
        history.setArgusConvId(convKey, result.argusConversationId);
      }

      // 인사 trigger 면 chip fallback — argus 가 첫 인사에 recommendedQuestions
      // 발급 안 하는 케이스 보강 (정적 5개 generic 쿼리). 자기소개 prefix 는
      // argus 응답이 이미 "WhaTap AI 어시스턴트입니다" 시작이라 중복 회피.
      const isGreeting = isGreetingTrigger(text);
      const formattedText = stripArgusBranding(toSlackMrkdwn(result.text || "_(빈 응답)_"));
      const toolFooter = renderToolFooter(result.toolCallLog);
      // 적용/취소 chip: 와탭 로그인 모드에선 그 사용자의 토큰으로 적용하므로 cookie 없이 띄운다.
      // 레거시 모드는 argus cookie 가 있어야 띄운다(없으면 본문에 안내).
      const cookieHint = creds ? renderCookieGateHint(result.chipActions, creds) : "";
      const formatted = [startedOver ? STARTED_OVER_NOTE : "", formattedText, cookieHint, toolFooter]
        .filter(Boolean)
        .join("\n\n");
      const chunks = splitForSlack(formatted);

      // chip actions (event-rule / flex-event 적용 / 취소) 가 있으면 마지막 chunk
      // 에 Block Kit button 으로 동봉. 클릭 시 app.action(action_id) 핸들러가
      // argus /v1/event-rules/apply 또는 /cancel 호출.
      // 자동 대응이면 자동으로 실행할 조치안 하나를 버튼에서 뺀다(나머지 버튼은 당번만 누를 수 있다).
      opmPick = params.opmAuto?.pick(result.chipActions ?? []);
      const chipBlocks = [
        ...(whatapLogin || creds?.argusCookie ? chipActionsToBlocks(result.chipActions) : []),
        // OPM 조치는 와탭 로그인 모드에서만 — 누른 사람의 토큰으로 front 를 거쳐 실행한다.
        ...(whatapLogin ? opmChipBlocks(opmPick?.manual ?? result.chipActions ?? [], { teamId, userId }, opmChips) : []),
      ];
      // DM 본문 답변의 버튼 줄에는 표시를 남긴다 — 누르면 DM 본문 대화를 잇고 본문에 답하게.
      const dmMain = isDmMainThreadKey(threadKey);
      // argus 가 고르라고 준 선택지(render_options). 답변이 "버튼에서 고르세요" 라고 말하므로 버튼으로 그린다.
      // 답변이 가리키는 쪽에 둔다: 글보다 먼저 왔으면("위 버튼에서…") 첫 조각의 글 위, 아니면 마지막 조각의 글 아래.
      const optionBlocks = optionsToBlocks(result.options ?? [], dmMain);
      // 추천 후속 질문 → Block Kit button. 클릭 시 같은 대화의 새 turn.
      // argus 가 발급 안 한 경우 항상 fallback (연우 피드백: 매 응답 chip 3개).
      // greeting 일 때는 더 풍부한 5개, 일반 turn 은 3개.
      // 선택지가 있으면 고르는 게 다음 행동이라, argus 가 따로 준 후속 질문만 붙이고 고정 폴백은 붙이지 않는다.
      const argusFollowups = result.recommendedQuestions ?? [];
      const followupQueries =
        argusFollowups.length > 0
          ? argusFollowups
          : optionBlocks.length > 0
            ? []
            : isGreeting
              ? STATIC_GREETING_CHIPS
              : STATIC_FOLLOWUP_FALLBACK;
      const followupBlocks = recommendedQuestionsToBlocks(followupQueries, dmMain);
      const optionsOnTop = optionBlocks.length > 0 && result.optionsBeforeText === true;
      const lastIdx = chunks.length - 1;
      const blocksFor = (i: number) =>
        withTextSection(
          chunks[i],
          i === lastIdx ? [...(optionsOnTop ? [] : optionBlocks), ...chipBlocks, ...followupBlocks] : [],
          i === 0 && optionsOnTop ? optionBlocks : [],
        );

      if (placeholderTs) {
        try {
          await client.chat.update({
            channel: getChannelFromThreadKey(threadKey),
            ts: placeholderTs,
            text: chunks[0],
            blocks: blocksFor(0),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[argus-slack-bot] final chat.update failed ts=${placeholderTs} text_len=${chunks[0].length}: ${msg}`,
          );
          await say({
            text: chunks[0],
            thread_ts: threadTs,
            blocks: blocksFor(0),
          });
        }
      } else {
        await say({
          text: chunks[0],
          thread_ts: threadTs,
          blocks: blocksFor(0),
        });
      }
      for (let i = 1; i < chunks.length; i++) {
        await say({
          text: chunks[i],
          thread_ts: threadTs,
          blocks: blocksFor(i),
        });
      }
      answered = true;
    } catch (err) {
      if (!history.isActive()) return;
      console.error(
        `[argus-slack-bot] error user=${userId} thread=${threadKey}:`,
        err,
      );
      let errText = humanizeError(err, { whatapLogin: !!whatapLogin });
      if (whatapLogin && err instanceof LoginRequiredError) {
        // 질문 도중 refresh 가 거절된 경우 (연결된 앱에서 끊음 등).
        errText = ":lock: 와탭 로그인이 만료됐어요. 다시 연결할 링크를 나에게만 보이게 보냈어요.";
        await sendWhatapLoginLink(whatapLogin, privateCtx).catch((e) =>
          console.warn(`[argus-slack-bot] login link send failed: ${String(e)}`),
        );
      }
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
      leaveTurn();
      // legacy MCP fallback 경로만 release. direct route 는 mcpClient null.
      if (mcpClient) {
        mcpPool.release(userId);
      }
    }
    // 자동 대응: 답을 다 올리고 대화 차례도 넘긴 뒤에 조치를 실행한다(실행은 1분 넘게 걸릴 수 있다).
    if (answered && opmPick && params.opmAuto && history.isActive()) await params.opmAuto.answered(opmPick);
    return answered;
  };

  /**
   * 자동 대응 — 새 알림을 [분석] 버튼을 누른 것처럼 당번의 와탭 권한으로 분석한다(handle 의 같은 흐름).
   * 분석을 시작했으면 true, 사람이 이어받아야 하면(버튼을 붙여야 하면) false.
   */
  const autoRespond = async (run: { alert: AlertRead; root: string; owner: string; client: OncallSlack }): Promise<boolean> => {
    if (!oncall) return false;
    const { team, channel } = oncall.source;
    const { alert, root, owner, client } = run;
    // 당번 토큰을 먼저 확인한다. 쓸 수 없으면 스레드에 당번을 불러 알리고, 사람이 이어받게 [분석] 버튼을 그대로 붙인다.
    try {
      await oncall.login.manager.withAccessToken(team, owner, async () => undefined);
    } catch (err) {
      const login = err instanceof LoginRequiredError;
      oncallLine({ root, owner, step: "skipped", reason: login ? "login-required" : "token-error" });
      await client.chat.postMessage({ channel, thread_ts: root, text: login
        ? `<@${owner}> 와탭 로그인이 필요해 자동 대응을 하지 못했어요. 로그인 링크를 보냈어요. 아래 [분석] 버튼으로 누구든 이어서 분석할 수 있어요.`
        : `<@${owner}> 와탭 로그인 서버에 닿지 않아 자동 대응을 하지 못했어요. 아래 [분석] 버튼으로 누구든 이어서 분석할 수 있어요.` });
      if (login) {
        await sendWhatapLoginLink(oncall.login, {
          teamId: team, userId: owner, isDm: false, channel, threadTs: root,
          say: (args) => client.chat.postMessage({ channel, text: args.text, thread_ts: args.thread_ts }), client,
        }, ONCALL_EXPIRED_LEAD);
      }
      return false;
    }
    await client.chat.postMessage({ channel, thread_ts: root,
      text: `이벤트 시작: ${alert.start} (이벤트 시각)\n:robot_face: 자동 대응을 시작해요. 당번 <@${owner}> 권한으로 분석해요.` });
    oncallLine({ root, owner, step: "start" });
    const answered = await handle({
      text: incidentPrompt(alert),
      pcode: Number(alert.project),
      userId: owner,
      teamId: team,
      isDm: false,
      threadKey: `${channel}:${root}`,
      threadTs: root,
      say: (args) => client.chat.postMessage({ channel, text: args.text, thread_ts: args.thread_ts, blocks: args.blocks }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      opmAuto: {
        // 사람 확인 없이 실행하는 것은 허용한 위험도이고 이 알림의 서버를 겨냥한 첫 조치안 하나뿐이다.
        pick: (chips) => pickAutoOpm(chips, { project: alert.project, oid: alert.oid }, oncall.settings.risks),
        answered: async (pick) => {
          // 사람이 확인해야 하는 조치안(위험도·대상이 자동 범위 밖이거나 두 번째 것)이 버튼으로 남았으면 당번을 부른다.
          // 답은 자리표시 글을 고친 것이라 멘션해도 알림이 가지 않는다 — 새 글로 부른다.
          const waiting = pick.manual.filter((c) => c.type === OPM_CHIP_TYPE && typeof c.payload["confirmToken"] === "string" && c.payload["confirmToken"]).length;
          oncallLine({ root, owner, step: "answered", auto: pick.auto ? 1 : 0, manual: waiting });
          if (waiting > 0) {
            await client.chat.postMessage({ channel, thread_ts: root,
              text: `<@${owner}> 사람이 확인해야 하는 조치안이 ${waiting}개 있어요. 위 답의 [조치 실행] 버튼은 당번만 누를 수 있어요.` });
          }
          const token = pick.auto?.payload["confirmToken"];
          if (pick.auto && typeof token === "string" && oncall.incidents.tryApply(root, token)) {
            await autoApply({ root, owner, client, chip: pick.auto, token });
          }
        },
      },
    });
    if (answered || !isWorkspaceActive(team)) return true;
    // 분석을 끝내지 못했다(Argus 오류 등 — 오류 문장은 handle 이 남겼다). 당번을 부르고, 누구든 다시 분석할 [분석] 버튼을 붙인다.
    oncallLine({ root, owner, step: "answered", result: "failed" });
    await client.chat.postMessage({ channel, thread_ts: root,
      text: `<@${owner}> 자동 분석을 끝내지 못했어요. 아래 [분석] 버튼으로 다시 분석할 수 있어요.` });
    return false;
  };

  /** 자동 대응의 조치 실행 — [조치 실행] 버튼과 같은 호출(callOpm)·같은 결과 문장을 당번 권한으로 쓴다. */
  const autoApply = async (run: { root: string; owner: string; client: OncallSlack; chip: ChipAction; token: string }) => {
    if (!oncall) return;
    const { team, channel } = oncall.source;
    const { root, owner, client, chip, token } = run;
    const title = String(chip.payload["title"] ?? chip.label);
    const post = (text: string, blocks?: unknown[]) => client.chat.postMessage({ channel, thread_ts: root, text, blocks });
    const announce = `:robot_face: 자동 조치를 실행해요: ${opmText(title, 120)} (${opmText(chip.payload["oname"] ?? `pcode ${String(chip.payload["pcode"] ?? "")}`, 100)}, 위험도 ${riskOf(chip.payload)})`;
    await post(announce, [
      { type: "section", text: { type: "mrkdwn", text: announce } },
      { type: "section", text: { type: "mrkdwn", text: renderOpmProposal(chip.payload) } },
    ]);
    // 실패하면 바로 당번을 부른다. 실행하지 않은 것이 확실하거나 답을 못 받은 경우는 당번만 누를 수 있는
    // [조치 실행] 버튼을 같이 둔다 — argus 는 같은 조치안을 두 번 실행하지 않고 지금 상태를 돌려준다.
    const callOwner = async (result: string, text: string, retry: boolean) => {
      oncallLine({ root, owner, step: "auto-apply", result });
      const lead = `<@${owner}> ${text}`;
      await post(lead, retry ? [{ type: "section", text: { type: "mrkdwn", text: lead } }, ...opmChipBlocks([chip], { teamId: team, userId: owner }, opmChips)] : undefined);
    };
    let resp: Response;
    let body: Record<string, unknown>;
    try {
      ({ resp, body } = await callOpm(oncall.login, team, owner, "apply", token));
    } catch (err) {
      if (err instanceof LoginRequiredError) {
        await callOwner("login-required", "와탭 로그인이 필요해 자동 조치를 실행하지 못했어요. 로그인 링크를 보냈어요 — 다시 연결한 뒤 아래 버튼으로 실행할 수 있어요.", true);
        await sendWhatapLoginLink(oncall.login, {
          teamId: team, userId: owner, isDm: false, channel, threadTs: root,
          say: (args) => client.chat.postMessage({ channel, text: args.text, thread_ts: args.thread_ts }), client,
        }, ONCALL_EXPIRED_LEAD);
        return;
      }
      console.warn(`[argus-slack-bot] oncall auto-apply failed root=${root}: ${String(err)}`);
      await callOwner("no-answer", `자동 조치의 ${OPM_NO_ANSWER.replace(/^:warning: /, "")}`, true);
      return;
    }
    if (!resp.ok) {
      // front 가 쓰기 허락이 없는 토큰을 막았다(실행하지 않았다). 허락받을 링크는 당번에게만 보낸다.
      if (missingScope(resp.status, resp.headers.get("www-authenticate")) !== null) {
        await callOwner("insufficient-scope", "와탭 쓰기 허락이 없어 자동 조치를 실행하지 못했어요. 허락할 링크를 보냈어요 — 허락한 뒤 아래 버튼으로 실행할 수 있어요.", true);
        await sendWhatapLoginLink(oncall.login, {
          teamId: team, userId: owner, isDm: false, channel, threadTs: root,
          say: (args) => client.chat.postMessage({ channel, text: args.text, thread_ts: args.thread_ts }), client,
        }, OPM_CONSENT_LEAD);
        return;
      }
      const view = describeOpmError("apply", resp.status, body, title);
      oncallLine({ root, owner, step: "auto-apply", result: "rejected", http: resp.status, code: String(body["code"] ?? "") || undefined });
      const lead = `<@${owner}> 자동 조치를 실행하지 못했어요.\n${view.text}`;
      await post(lead, view.row === "restore"
        ? [{ type: "section", text: { type: "mrkdwn", text: lead } }, ...opmChipBlocks([chip], { teamId: team, userId: owner }, opmChips)]
        : undefined);
      return;
    }
    const outcome = describeOpmOutcome("apply", body, title);
    const status = String((body["proposal"] as { status?: unknown } | undefined)?.status ?? "");
    if (status !== "executed") {
      // 결재 대기·실패·확인 불가 등 — 끝나지 않았거나 실패했다. 바로 당번을 부른다. 결재 대기면 [상태 확인]을 둔다.
      oncallLine({ root, owner, step: "auto-apply", result: status || "unknown" });
      const lead = `<@${owner}> ${outcome.text}`;
      await post(lead, outcome.check
        ? [{ type: "section", text: { type: "mrkdwn", text: lead } },
           ...opmStatusRow(opmChips.put(token, { teamId: team, userId: owner }, title), `${outcome.status} · 자동 조치`, true)]
        : undefined);
      return;
    }
    await post(outcome.text);
    oncallLine({ root, owner, step: "auto-apply", result: "ok", status });
    // 실행됐다. 정해 둔 시간 안에 해소(RECOVERED)되지 않으면 당번을 부른다(해소 글이 오면 resolve 가 멈춘다).
    const minutes = oncall.settings.escalateMin;
    oncall.incidents.applied(root, minutes * 60_000, async () => {
      if (!isWorkspaceActive(team)) return;
      oncallLine({ root, owner, step: "escalated", after: `${minutes}m` });
      await post(escalationText(owner, minutes)).catch((err) =>
        console.warn(`[argus-slack-bot] oncall escalation post failed root=${root}: ${String(err)}`));
    });
  };

  app.event("app_mention", async ({ event, say, client, body }) => {
    if (source && body.team_id === source.team && event.channel === source.channel &&
        ("bot_id" in event || ("subtype" in event && event.subtype === "bot_message"))) return;
    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    const threadKey = `${channel}:${threadTs}`;
    const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    // 자동 대응 명령은 알림 채널에서만 받는다. Argus 에 묻지 않는다.
    const oncallCommand = oncall ? parseOncallCommand(cleanText) : undefined;
    if (oncall && oncallCommand && body.team_id === oncall.source.team && channel === oncall.source.channel) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runOncallCommand(oncallCommand, { userId: event.user ?? "", threadTs: event.thread_ts, client: client as any });
      return;
    }
    await handle({
      text: cleanText,
      userId: event.user ?? "",
      teamId: (body as { team_id?: string }).team_id ?? "",
      isDm: false,
      threadKey,
      threadTs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      say: (args) => say(args as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
  });

  app.message(async ({ message, say, client, body, context }) => {
    const m = message as unknown as Record<string, unknown>;
    if (m.channel_type !== "im") {
      if (!source || !isAlertEnvelope(source, m, body, context.botId) || !isWorkspaceActive(source.team)) return;
      const alert = readAlert(m.attachments, ALERT_TIME_ZONE);
      if (!alert || typeof m.ts !== "string") return;
      const notice = entries.observe(alert, m.ts, m.bot_id as string);
      if (!notice) return;
      if (notice.kind === "resolved") {
        // 자동 대응한 사건이면 에스컬레이션을 멈춘다. 회복이면 자동 조치 뒤 걸린 시간을 붙인다(닫힘(DISABLED)은 해소가 아니다).
        const auto = oncall?.incidents.resolve(notice.root);
        const after = auto?.appliedAgoMs !== undefined && !alert.cancelled ? resolvedAfterApply(auto.appliedAgoMs) : "";
        if (auto) oncallLine({ root: notice.root, owner: auto.owner, step: alert.cancelled ? "closed" : "resolved", afterApplyMs: auto.appliedAgoMs });
        await client.chat.postMessage({ channel: source.channel, thread_ts: notice.root, text: notice.text + after });
        return;
      }
      // 자동 대응: 당번이 있고 대상 규칙이면 [분석] 버튼을 기다리지 않고 당번 권한으로 바로 분석한다. 원본 글마다 한 번이다.
      const owner = oncall && ruleEligible(oncall.settings.rules, alert.rule) ? oncall.owners.get(source.team, source.channel) : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (oncall && owner && oncall.incidents.claim(m.ts, owner) && await autoRespond({ alert, root: m.ts, owner, client: client as any })) return;
      const text = `이벤트 시작: ${alert.start} (이벤트 시각)`;
      const posted = await client.chat.postMessage({ channel: source.channel, thread_ts: m.ts, text, blocks: [
        { type: "section", text: { type: "plain_text", text } },
        { type: "actions", elements: [{ type: "button", action_id: "webhook_alert_analyze", text: { type: "plain_text", text: "분석" }, value: m.ts }] },
      ] });
      notice.thread.buttonTs = posted.ts;
      return;
    }
    if (m.subtype) return;
    const text = String(m.text ?? "").trim();
    if (!text) return;
    const channel = String(m.channel ?? "");
    // DM 에서 사용자가 명시적으로 thread 안에 있을 때만 thread reply. 새 DM
    // 메시지 (m.thread_ts 없음) 는 threadTs=undefined 로 두어 main 흐름에 답함.
    // 이전엔 자기 ts 를 parent 로 강제 thread 화 → 사용자가 채팅 탭 main 에서
    // 봇 응답을 thread 댓글로만 보던 회귀.
    const replyThreadTs = m.thread_ts ? String(m.thread_ts) : undefined;
    // 스레드 밖 DM 메시지는 메시지마다가 아니라 DM 하나로 대화를 잇는다 — 봇의 되물음에 "3396" 처럼
    // 짧게 답해도 앞 질문을 안다. 30분 쉬면 새 대화다(ThreadHistory idle 만료).
    const threadKey = replyThreadTs ? `${channel}:${replyThreadTs}` : dmMainThreadKey(channel);
    const teamId = (body as { team_id?: string }).team_id ?? "";
    // 삭제 세대는 첫 await(봇 DM 확인) 전에 고정한다. 그 사이 삭제·재설치돼도 이 메시지는 버린다.
    const history = /^T[A-Z0-9]+$/.test(teamId) ? threadHistory.forWorkspace(teamId) : undefined;
    // 사용자 토큰 이벤트(user_events message.im)로 들어온, 봇이 없는 DM 은 처리하지 않는다.
    const authorizations = (body as { authorizations?: unknown }).authorizations;
    const verdict = await isBotDm({
      teamId,
      channel,
      authorizations,
      client: client as unknown as ConversationsInfoClient,
    });
    if (!verdict.ok) {
      console.warn(
        `[argus-slack-bot] ignored DM outside this bot's conversation at=${new Date().toISOString()} team=${teamId || "-"} channel=${channel || "-"} reason=${verdict.reason} auth=${authorizationKind(authorizations)}`,
      );
      return;
    }
    if (verdict.via === "membership") {
      console.log(`[argus-slack-bot] verified bot DM via conversations.info team=${teamId} channel=${channel}`);
    }
    await handle({
      text,
      userId: String(m.user ?? ""),
      teamId,
      history,
      isDm: true,
      threadKey,
      threadTs: replyThreadTs,
      inheritFrom: replyThreadTs ? dmMainThreadKey(channel) : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      say: (args) => say(args as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
  });

  // Only the admitted root and this bot's actual button reply identify the alert. Ignore client-supplied prose.
  app.action(/^webhook_alert_analyze$/, async ({ ack, body, client, action }) => {
    const b = body as { team?: { id?: string }; user: { id: string; team_id?: string }; channel?: { id?: string }; message?: { ts?: string; thread_ts?: string } };
    const team = b.team?.id, channel = b.channel?.id, userId = b.user.id, root = b.message?.thread_ts;
    const entry = root ? entries.get(root) : undefined;
    await ack();
    if (!whatapLogin || !source || team !== source.team || channel !== source.channel ||
        !/^U[A-Z0-9]+$/.test(userId) || (b.user.team_id && b.user.team_id !== team) ||
        !root || !entry || !entry.buttonTs || b.message?.ts !== entry.buttonTs ||
        (action as { value?: string }).value !== root) return;
    if (entries.get(root) !== entry || !isWorkspaceActive(team)) return;
    // 누른 사람이 그 스레드에서 물은 것으로 본 흐름(handle)에 태운다 — 그 사람의 와탭 토큰으로 묻고, 답은 알림
    // 스레드에 남고, 로그인 링크만 본인에게 보인다. 조치안이 오면 [조치 실행] 버튼도 그 사람에게 묶인다.
    // 질문은 받아들인 알림의 칸으로만 만든 사건 글이다(SRE Argus 가 코드로 읽는 모양, webhook-alerts.ts).
    await handle({
      text: incidentPrompt(entry.alert),
      pcode: Number(entry.alert.project),
      userId,
      teamId: team,
      isDm: false,
      threadKey: `${channel}:${root}`,
      threadTs: root,
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

    // 누른 버튼 줄을 바로 "처리 중"으로 바꿔 두 번 누르지 않게 하고, 끝나면 결과 상태를 남긴다.
    // 원래 메시지 blocks 가 없으면(이벤트에 안 실려 온 경우) 건너뛴다. null 은 버튼 되돌리기.
    const message = (body as { message?: { ts?: string; text?: string; blocks?: unknown[] } }).message;
    const value = String((action as { value?: string }).value ?? "");
    const chipLabel = value && value !== token ? value : "";
    let chipTouched = false;
    const setChipState = async (status: string | null) => {
      const original = message?.blocks;
      if (!message?.ts || !Array.isArray(original)) return;
      if (status === null && !chipTouched) return;
      const blocks = status === null ? original : resolveChipBlocks(original, token, status);
      if (!blocks) return;
      chipTouched = status !== null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await client.chat.update({ channel, ts: message.ts, blocks: blocks as any, text: message.text || " " });
      } catch (err) {
        console.warn(`[argus-slack-bot] chip state update failed: ${(err as Error).message}`);
      }
    };
    const pendingStatus = op === "apply" ? ":hourglass_flowing_sand: 적용하는 중…" : ":hourglass_flowing_sand: 취소하는 중…";
    const stamp = () => {
      const now = new Date();
      return `<@${userId}> · <!date^${Math.floor(now.getTime() / 1000)}^{time}|${now.toISOString().slice(11, 16)} UTC>`;
    };

    if (!ARGUS_URL) {
      await client.chat.postEphemeral({
        channel,
        user: userId,
        text: `:warning: ARGUS_URL 미설정 — chip apply 호출 불가`,
        thread_ts: threadTs,
      });
      return;
    }

    const path = op === "apply" ? "/v1/event-rules/apply" : "/v1/event-rules/cancel";
    const post = (headers: Record<string, string>) =>
      fetch(`${ARGUS_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ confirmToken: token }),
      });

    let resp: Response;
    let loginCtx: PrivateReplyContext | undefined;
    if (whatapLogin) {
      // 와탭 로그인 모드: 미리보기를 낸 그 사용자의 토큰으로 적용한다. cookie·공용 자격증명은
      // 보지도 보내지도 않는다. argus 가 401 이면 토큰을 한 번 갱신해 다시 보낸다.
      const login = whatapLogin;
      const teamId =
        (body as { team?: { id?: string } }).team?.id ||
        (body as { user?: { team_id?: string } }).user?.team_id || "";
      if (!/^T[A-Z0-9]+$/.test(teamId) || !userId || !isWorkspaceActive(teamId)) return;
      loginCtx = {
        teamId,
        userId,
        isDm: false,
        channel,
        threadTs,
        // isDm=false 라 로그인 링크는 언제나 ephemeral 로 간다. say 는 쓰이지 않지만 형식상 둔다.
        say: (args) => client.chat.postEphemeral({ channel, user: userId, text: args.text, thread_ts: args.thread_ts }),
        client,
      };
      await setChipState(pendingStatus);
      try {
        resp = await login.manager.withAccessToken(teamId, userId, async (accessToken) => {
          const r = await post({ Authorization: `Bearer ${accessToken}` });
          if (r.status === 401) throw Object.assign(new Error("argus rejected the access token"), { status: 401 });
          return r;
        });
      } catch (err) {
        // 적용 전에 막혔으니 버튼을 되돌려 둔다(로그인·재시도 뒤 다시 누를 수 있게).
        await setChipState(null);
        if (err instanceof LoginRequiredError) {
          await sendWhatapLoginLink(login, loginCtx, loginLinkLead(err));
          return;
        }
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: humanizeError(err, { whatapLogin: true }) });
        return;
      }
    } else {
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
      await setChipState(pendingStatus);
      try {
        resp = await post({
          Cookie: creds.argusCookie,
          ...(ARGUS_API_TOKEN ? { "X-Argus-Token": ARGUS_API_TOKEN } : {}),
        });
      } catch (err) {
        await setChipState(null);
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: humanizeError(err),
        });
        return;
      }
    }

    let bodyJson: Record<string, unknown> = {};
    try {
      bodyJson = (await resp.json()) as Record<string, unknown>;
    } catch {
      bodyJson = {};
    }

    if (!resp.ok) {
      // front 가 쓰기 허락이 없는 토큰을 막았다(403 insufficient_scope). 아무것도 바뀌지 않았으니
      // 버튼을 되돌리고, 다시 허락받을 링크를 나에게만 보낸다. 허락한 뒤 같은 버튼을 다시 누르면 된다.
      if (whatapLogin && loginCtx && missingScope(resp.status, resp.headers.get("www-authenticate")) !== null) {
        await setChipState(null);
        await sendWhatapLoginLink(whatapLogin, loginCtx, WRITE_CONSENT_LEAD);
        return;
      }
      const code = bodyJson["code"];
      const errMsg = (bodyJson["error"] as string) || `HTTP ${resp.status}`;
      const friendly = whatapLogin ? describeEventRuleOpError(code) : "";
      // 만료된 확인은 다시 눌러도 소용없으니 버튼을 거둔다. 그 밖의 거절은 버튼을 되돌려 둔다.
      if (code === "token_not_found") await setChipState(`:hourglass: 만료됨 — 확인 버튼은 5분 동안만 유효해요`);
      else await setChipState(null);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: friendly || `:x: ${op} 실패: \`${errMsg}\``,
      });
      return;
    }

    // 결과 — 무엇이(버튼의 대상 이름) 어느 프로젝트에 어떻게 됐는지. 버튼 자리는 결과 상태로 바꾼다.
    const result = describeApplyResult(op, bodyJson, chipLabel);
    await setChipState(`${chipStatus(op, bodyJson)} · ${stamp()}`);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: result.text,
    });
    // 와탭 로그인 모드에서 허락이 빠져 실패했으면 다시 허락받을 링크를 나에게만 보낸다.
    if (result.needsConsent && whatapLogin && loginCtx) {
      await sendWhatapLoginLink(whatapLogin, loginCtx, WRITE_CONSENT_LEAD);
    }
  });

  // OPM 조치안 버튼 — [조치 실행]·[취소]·[상태 확인]. action_id 는 `opm_action:<op>:<손잡이>` 이고,
  // 확인 토큰은 손잡이로 봇 메모리(opmChips)에서 꺼낸다. 와탭 로그인 모드에서만 그리고 처리한다.
  app.action(/^opm_action:(apply|cancel|check):[\w-]+$/, async (ctx) => {
    const { ack, body, client, action } = ctx;
    await ack();
    const login = whatapLogin;
    if (!login) return;
    const userId = (body as { user?: { id?: string } }).user?.id || "";
    const teamId =
      (body as { team?: { id?: string } }).team?.id ||
      (body as { user?: { team_id?: string } }).user?.team_id || "";
    if (!/^T[A-Z0-9]+$/.test(teamId) || !userId || !isWorkspaceActive(teamId)) return;
    const m = ((action as { action_id?: string }).action_id || "").match(/^opm_action:(apply|cancel|check):([\w-]+)$/);
    if (!m) return;
    const op = m[1] as OpmOp;
    const handle = m[2];
    const channel =
      (body as { channel?: { id?: string } }).channel?.id ||
      (body as { container?: { channel_id?: string } }).container?.channel_id || "";
    const message = (body as { message?: { ts?: string; thread_ts?: string; text?: string; blocks?: unknown[] } }).message;
    const threadTs = message?.thread_ts || message?.ts || undefined;
    const tellClicker = (text: string) => client.chat.postEphemeral({ channel, user: userId, text, thread_ts: threadTs });
    const entry = opmChips.get(handle);
    if (!entry) {
      // 봇이 다시 시작됐거나 오래돼 토큰을 잊었다. 눌러도 소용없는 버튼은 거두고, 누른 사람에게만 알린다.
      const retired = Array.isArray(message?.blocks)
        ? replaceOpmRow(message.blocks, handle, opmStatusRow(handle, ":hourglass: 더 쓸 수 없는 버튼이에요"))
        : undefined;
      if (retired && message?.ts) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await client.chat.update({ channel, ts: message.ts, blocks: retired as any, text: message.text || " " });
        } catch (err) {
          console.warn(`[argus-slack-bot] opm chip state update failed: ${(err as Error).message}`);
        }
      }
      await tellClicker(":hourglass: 이 조치안 버튼은 더 쓸 수 없어요(봇이 다시 시작됐거나 시간이 많이 지났어요). 같은 내용을 다시 물어봐 주세요.");
      return;
    }
    if (entry.teamId !== teamId || entry.userId !== userId) {
      // argus 도 토큰을 받은 사람에 묶지만, 남의 확인 토큰을 내 와탭 토큰에 실어 보내는 일 자체를 하지 않는다.
      await tellClicker(":lock: 다른 사람의 질문에서 나온 조치안이에요. 본인 질문의 버튼만 누를 수 있어요.");
      return;
    }

    // 누른 버튼 줄을 바로 상태 줄로 바꿔 두 번 누르지 않게 하고, 끝나면 결과 상태를 남긴다. null 은 버튼 되돌리기.
    let touched = false;
    const setRow = async (replacement: unknown[] | null) => {
      const original = message?.blocks;
      if (!message?.ts || !Array.isArray(original)) return;
      if (replacement === null && !touched) return;
      const blocks = replacement === null ? original : replaceOpmRow(original, handle, replacement);
      if (!blocks) return;
      touched = replacement !== null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await client.chat.update({ channel, ts: message.ts, blocks: blocks as any, text: message.text || " " });
      } catch (err) {
        console.warn(`[argus-slack-bot] opm chip state update failed: ${(err as Error).message}`);
      }
    };
    const loginCtx: PrivateReplyContext = {
      teamId,
      userId,
      isDm: false,
      channel,
      threadTs,
      say: (args) => client.chat.postEphemeral({ channel, user: userId, text: args.text, thread_ts: args.thread_ts }),
      client,
    };

    await setRow(opmStatusRow(handle, OPM_PENDING[op]));
    let resp: Response;
    let bodyJson: Record<string, unknown>;
    try {
      ({ resp, body: bodyJson } = await callOpm(login, teamId, userId, op, entry.token));
    } catch (err) {
      await setRow(null);
      if (err instanceof LoginRequiredError) {
        await sendWhatapLoginLink(login, loginCtx, loginLinkLead(err));
        return;
      }
      // 보낸 뒤 끊겼을 수 있다. argus 는 같은 조치안을 두 번 실행하지 않으니 다시 눌러 확인하게 한다.
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: op === "apply" ? OPM_NO_ANSWER : humanizeError(err, { whatapLogin: true }),
      });
      return;
    }
    if (!resp.ok) {
      // front 가 쓰기 허락이 없는 토큰을 막았다(403 insufficient_scope). 실행하지 않았으니 버튼을 되돌리고,
      // 다시 허락받을 링크를 나에게만 보낸다. 허락한 뒤 같은 버튼을 다시 누르면 된다.
      if (missingScope(resp.status, resp.headers.get("www-authenticate")) !== null) {
        await setRow(null);
        await sendWhatapLoginLink(login, loginCtx, OPM_CONSENT_LEAD);
        return;
      }
      const view = describeOpmError(op, resp.status, bodyJson, entry.title);
      if (view.row === "restore") await setRow(null);
      else await setRow(opmStatusRow(handle, `${view.status} · ${opmStamp(userId)}`, view.check));
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: view.text });
      return;
    }
    const outcome = describeOpmOutcome(op, bodyJson, entry.title);
    await setRow(opmStatusRow(handle, `${outcome.status} · ${opmStamp(userId)}`, outcome.check));
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: outcome.text });
  });

  // 답변 아래 버튼 클릭 핸들러 — 추천 후속 질문(`followup_question:<index>`)과 argus 선택지
  // (`choose_option:<index>`). value = 보낼 텍스트 (action_id 길이 제한 우회용 — 인덱스만 박고
  // value 에 텍스트). 클릭 시 같은 대화의 새 turn 으로 handle() 재호출 — 사용자가 직접 입력한
  // 것처럼 동작.
  app.action(/^(followup_question|choose_option):.+$/, async (ctx) => {
    const { ack, body, client, action } = ctx;
    const teamId =
      (body as { team?: { id?: string } }).team?.id ||
      (body as { user?: { team_id?: string } }).user?.team_id || "";
    // Capture deletion generation before the FIRST await, including ACK.
    const history = /^T[A-Z0-9]+$/.test(teamId) && isWorkspaceActive(teamId)
      ? threadHistory.forWorkspace(teamId) : undefined;
    await ack();
    if (!history?.isActive() || !isWorkspaceActive(teamId)) return;

    const userId = (body as { user?: { id?: string } }).user?.id || "";
    const channel =
      (body as { channel?: { id?: string } }).channel?.id ||
      (body as { container?: { channel_id?: string } }).container?.channel_id ||
      "";
    const message = (body as { message?: { thread_ts?: string; ts?: string } })
      .message;
    // DM 본문 답변의 버튼(block_id 에 표시)은 DM 본문 대화를 잇고 본문에 답한다. 그 밖(채널 스레드,
    // 스레드 안 답변, 표시 없는 예전 메시지)은 그 메시지의 스레드가 대화다.
    // 답글이 달린 본문 메시지는 스레드의 첫 글이라 thread_ts 가 자기 ts 와 같다 — 봇이 적용 결과를 미리보기
    // 답변의 스레드에 달면 그렇게 된다. 스레드 "안" 의 메시지만 thread_ts 가 ts 와 다르다.
    const blockId = String((action as { block_id?: string }).block_id ?? "");
    const insideThread = !!message?.thread_ts && message.thread_ts !== message.ts;
    const dmMain = !insideThread && blockId.endsWith(DM_MAIN_BLOCK_SUFFIX);
    const threadTs = dmMain ? undefined : message?.thread_ts || message?.ts || "";
    if (!channel || !userId || (!dmMain && !threadTs)) return;

    const question = (action as { value?: string }).value || "";
    if (!question) return;
    const threadKey = dmMain ? dmMainThreadKey(channel) : `${channel}:${threadTs}`;
    const chosen = String((action as { action_id?: string }).action_id ?? "").startsWith("choose_option:");

    // 채널에 "<@user> selected: <질문>" 박아 다른 사람들도 맥락 유지.
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `<@${userId}> ${chosen ? "_선택:_" : "_후속 질문 선택:_"} ${question}`,
    });

    // handle() 재호출 — say 를 client.chat.postMessage 로 래핑.
    await handle({
      text: question,
      userId,
      teamId,
      history,
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

  if (SLACK_SETTINGS.transport === "http") {
    await app.start({ port: SLACK_SETTINGS.port, host: SLACK_SETTINGS.listenHost });
    console.log(`[argus-slack-bot] listening (HTTP) http://${SLACK_SETTINGS.listenHost}:${SLACK_SETTINGS.port}/slack/events`);
  } else {
    await app.start();
    console.log("[argus-slack-bot] connected (Socket Mode). DM me 'help' 또는 채널에서 @argus 멘션.");
  }
  if (IS_MULTI_WORKSPACE) {
    console.log(
      `[argus-slack-bot] OAuth installer at ${SLACK_SETTINGS.publicUrl || `http://localhost:${SLACK_SETTINGS.port}`}/slack/install`,
    );
    console.log(
      "[argus-slack-bot] (외부 도달 가능한 redirect URL 을 Slack 앱 설정에 등록해야 OAuth 가 동작)",
    );
  }

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
    try {
      oauthServer?.closeAllConnections();
      oauthServer?.close();
    } catch {}
    try {
      whatapLogin?.store.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ── 와탭 로그인 모드 ─────────────────────────────────────────

interface WhatapLoginRuntime {
  settings: WhatapOAuthSettings;
  store: WhatapLinkStore;
  pending: PendingLogins;
  manager: WhatapTokenManager;
}

/** 자동 대응이 쓰는 Slack 호출(이벤트의 워크스페이스 client, 또는 타이머가 설치 토큰으로 만든 client). */
interface OncallSlack {
  chat: {
    postMessage: (args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }) => Promise<unknown>;
    postEphemeral: (args: { channel: string; user: string; text: string; thread_ts?: string }) => Promise<unknown>;
  };
}
/** 받아들인 알림(webhook-alerts.ts readAlert). */
type AlertRead = NonNullable<ReturnType<typeof readAlert>>;

/** 본인만 봐야 하는 답(로그인 링크, 연결 계정)을 보낼 곳. DM 이면 DM, 채널이면 ephemeral. */
interface PrivateReplyContext {
  teamId: string;
  userId: string;
  isDm: boolean;
  channel: string;
  threadTs?: string;
  say: (args: { text: string; thread_ts?: string; blocks?: unknown[] }) => Promise<unknown>;
  client: {
    chat: {
      postEphemeral: (args: {
        channel: string;
        user: string;
        text: string;
        thread_ts?: string;
      }) => Promise<unknown>;
    };
  };
}

async function replyPrivately(ctx: PrivateReplyContext, text: string): Promise<void> {
  if (ctx.isDm) {
    await ctx.say({ text, thread_ts: ctx.threadTs });
    return;
  }
  await ctx.client.chat.postEphemeral({
    channel: ctx.channel,
    user: ctx.userId,
    text,
    thread_ts: ctx.threadTs,
  });
}

/** 쓰던 연결이 만료됐을 때(오래 안 써서 refresh 가 거절됨 등) 링크 앞에 붙이는 안내.
 *  처음 연결하는 사람과 같은 안내를 받으면 왜 다시 로그인해야 하는지 알 수 없다. */
const LOGIN_EXPIRED_LEAD = ":lock: 와탭 로그인이 만료됐어요. 아래 링크로 다시 연결해 주세요.";
/** 자동 대응을 켜려는데 쓸 수 있는 와탭 연결이 없을 때. */
const ONCALL_LOGIN_LEAD = ":lock: 자동 대응은 당번의 와탭 권한으로 분석하고 조치해요. 아래 링크로 와탭 계정을 연결한 뒤 `자동 대응 켜기` 를 다시 보내 주세요.";
/** 당번의 와탭 로그인을 쓸 수 없어 자동 대응이 멈췄을 때 당번에게만 보내는 링크 안내. */
const ONCALL_EXPIRED_LEAD = ":lock: 와탭 로그인이 필요해 자동 대응이 멈췄어요. 아래 링크로 다시 연결하면 다음 알림부터 이어서 해요.";

function loginLinkLead(err: LoginRequiredError): string | undefined {
  return err.expired ? LOGIN_EXPIRED_LEAD : undefined;
}

/**
 * OPM 조치 API(argus /v1/opm/actions/{op})를 그 사용자의 와탭 토큰으로 부른다. [조치 실행] 버튼과 자동 대응이 같이 쓴다.
 * argus 가 401 이면 토큰을 한 번 갱신해 다시 보낸다(withAccessToken). 본문은 JSON 이 아니면 빈 객체다.
 */
async function callOpm(login: WhatapLoginRuntime, teamId: string, userId: string, op: OpmOp, confirmToken: string) {
  const resp = await login.manager.withAccessToken(teamId, userId, async (accessToken) => {
    const r = await postOpmAction(fetch, ARGUS_URL, op, accessToken, confirmToken);
    if (r.status === 401) throw Object.assign(new Error("argus rejected the access token"), { status: 401 });
    return r;
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { resp, body };
}

/** 로그인 링크는 그 Slack 사용자에게 묶여 있어 채널에 공개하면 다른 사람이 자기 와탭
 *  계정을 그 사용자에게 연결할 수 있다. 그래서 항상 본인에게만 보낸다. */
async function sendWhatapLoginLink(
  rt: WhatapLoginRuntime,
  ctx: PrivateReplyContext,
  /** 로그인 대신 허락을 다시 받을 때처럼 이유가 따로 있으면 첫 줄을 바꾼다. */
  lead?: string,
): Promise<void> {
  const url = loginStartUrl(
    rt.settings.oauth.redirectUri,
    rt.pending.create(ctx.teamId, ctx.userId),
  );
  const link = `<${url}|와탭 로그인 열기> 링크는 10분 동안 쓸 수 있고 나에게만 보여요.`;
  await replyPrivately(
    ctx,
    (lead
      ? [lead, link]
      : [":key: 와탭 계정을 연결하면 내 권한으로 조회한 답을 받을 수 있어요.", link, ACCOUNT_SETUP_GUIDANCE]
    ).join("\n"),
  );
}

async function handleWhatapLoginCommand(
  cmd: ParsedCommand,
  rt: WhatapLoginRuntime,
  ctx: PrivateReplyContext,
): Promise<void> {
  switch (cmd.kind) {
    case "help":
      await ctx.say({ text: WHATAP_LOGIN_HELP, thread_ts: ctx.threadTs });
      return;
    case "login":
      await sendWhatapLoginLink(rt, ctx);
      return;
    case "whoami": {
      const link = rt.store.get(ctx.teamId, ctx.userId);
      if (!link) {
        await replyPrivately(ctx, "연결된 와탭 계정이 없어요. `login` 을 보내 연결하세요.");
        return;
      }
      // 저장된 연결이 있어도 로그인 서버가 refresh 를 거절하면(오래 안 씀 등) 쓸 수 없다. 실제로 확인한다.
      try {
        await rt.manager.accessToken(ctx.teamId, ctx.userId);
      } catch (err) {
        if (err instanceof LoginRequiredError) {
          await replyPrivately(
            ctx,
            err.expired
              ? ":lock: 와탭 로그인이 만료됐어요. `login` 을 보내 다시 연결하세요."
              : "연결된 와탭 계정이 없어요. `login` 을 보내 연결하세요.",
          );
          return;
        }
        console.warn(`[argus-slack-bot] whoami token check failed user=${ctx.userId}: ${String(err)}`);
        await replyPrivately(
          ctx,
          `:bust_in_silhouette: 와탭 계정이 연결돼 있어요: ${link.email ?? link.subject} (로그인 서버에 닿지 않아 지금 쓸 수 있는지는 확인하지 못했어요)`,
        );
        return;
      }
      await replyPrivately(ctx, `:bust_in_silhouette: 와탭 계정이 연결돼 있어요: ${link.email ?? link.subject}`);
      return;
    }
    case "logout": {
      const removed = await rt.manager.unlink(ctx.teamId, ctx.userId);
      await replyPrivately(
        ctx,
        removed
          ? ":wave: 와탭 계정 연결을 끊었어요. 다시 쓰려면 `login` 을 보내세요."
          : "연결된 와탭 계정이 없어요.",
      );
      return;
    }
    case "register":
    case "cookie":
      await replyPrivately(
        ctx,
        ":warning: 이 봇은 와탭 로그인으로 연결해요. 토큰이나 cookie 는 보내지 말고 `login` 을 보내세요.",
      );
      return;
  }
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
  if (direct) return { creds: direct, usingDefault: false };
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
    // undefined 면 main 흐름에 답함 (DM). string 이면 thread reply.
    threadTs?: string;
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
// argus 의 system prompt 가 자기 자신을 "Argus" 라고 소개하는 경향이 있는데
// 사용자에게는 "WhaTap AI 어시스턴트" 로 통일 노출. 봇 layer 에서 단순 string
// replace 로 sanitize — 시연용 임시 패치 (정답은 argus system_prompt.md 수정).
// case-sensitive + word boundary 로 도구 결과의 일반 영어 단어 영향 회피.
function stripArgusBranding(text: string): string {
  let out = text;
  // "WhaTap AI 어시스턴트 *Argus*입니다" / "Argus 입니다" → 자기소개 단어 cleanup
  out = out.replace(/\s*\*?Argus\*?(?=\s*(?:입니다|이에요|예요|이야|이라고|라고))/g, "");
  // bold/italic 형 "*Argus*" → 제거
  out = out.replace(/\*Argus\*/g, "");
  // 단독 "Argus" 단어 (대문자, word boundary) → "WhaTap AI 어시스턴트"
  out = out.replace(/\bArgus\b/g, "WhaTap AI 어시스턴트");
  // 자기소개 wording 통일 — argus 가 "WhaTap 관찰 도구", "WhaTap 봇" 등으로
  // 자기를 소개하는 경향. 사용자 요청: "WhaTap AI 어시스턴트" 로 통일.
  out = out.replace(/WhaTap\s*(?:관찰\s*도구|관찰\s*도우미|모니터링\s*도구|모니터링\s*봇|봇|에이전트|어시스턴트(?!\s*입니다))/g, "WhaTap AI 어시스턴트");
  // 중복 공백 정리
  out = out.replace(/ {2,}/g, " ");
  return out;
}

// 인사 trigger — 사용자가 "ㅎㅇ", "안녕", "help" 같은 짧은 인사 / 도움말
// 요청을 보냈는지 lowercase + trim 정확 일치로 판별. handle() 의 후처리에서
// argus 응답에 자기소개 prefix 와 추천 후속 질문 chip fallback 을 붙이는 데 사용.
// onboardingBlocks (4-block 풍부 안내) 분기를 다시 박지는 않는다 — 그게 "내역"
// 알림 회귀의 원인이었음. argus 가 발급한 형식과 100% 동일한 recommendedQuestions
// chip (context + actions 2 block) 만 fallback.
function isGreetingTrigger(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t === "help" || t === "도움" || t === "도움말" ||
    t === "hi" || t === "hello" || t === "hey" || t === "yo" ||
    t === "안녕" || t === "안녕하세요" ||
    t === "ㅎㅇ" || t === "ㅎ2" || t === "ㅎㅎ" ||
    t === "하이" || t === "안뇽" ||
    t === "start" || t === "시작" ||
    t === "menu" || t === "메뉴" ||
    t === "?" || t === "??"
  );
}

// argus 가 첫 인사 응답에 recommended_questions 발급 안 할 때 정적 fallback.
// 너무 구체적 (GPU 비용 최적화 등) 가정 박힌 단어는 회피 — 사용자가 자기
// 프로젝트 / 데이터 모르는 첫 진입자도 자연스럽게 시작 가능한 generic 5개.
const STATIC_GREETING_CHIPS = [
  "내 프로젝트 보여줘",
  "지금 어디 문제 있어?",
  "최근 24시간 알림 현황",
  "이상 징후 있는 프로젝트 찾아줘",
  "알림 설정 도와줘",
];

// argus 가 일반 turn 에 recommended_questions 발급 안 했을 때 기본 fallback.
// 사용자 피드백 (연우): 매 응답마다 chip 3개 보이는 게 좋다. 컨텍스트 부정합
// 위험 있지만 chip 부재보다 낫다. greeting 보다 짧게 3개.
const STATIC_FOLLOWUP_FALLBACK = [
  "프로젝트 상태 확인해줘",
  "최근 알림 현황",
  "이상 징후 찾아줘",
];

/**
 * DM 본문 답변의 버튼 줄 block_id 끝에 붙이는 표시. 클릭 핸들러가 이걸 보고 DM 본문 대화를 잇는다.
 * block_id 를 주지 않은 줄에는 Slack 이 짧은 임의 문자열을 붙이므로 이 표시와 겹치지 않는다.
 */
const DM_MAIN_BLOCK_SUFFIX = "_dm_main";

function recommendedQuestionsToBlocks(questions: string[], dmMain = false): unknown[] {
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
    { type: "actions", ...(dmMain ? { block_id: `followup${DM_MAIN_BLOCK_SUFFIX}` } : {}), elements },
  ];
}

/** argus 선택지(render_options) → Block Kit button. 누르면 value 가 같은 대화의 다음 메시지로 간다. */
function optionsToBlocks(options: Array<{ label: string; value: string }>, dmMain = false): unknown[] {
  // Slack 한도: actions 블록 하나에 element 25개, 버튼 글자 75자, value 2000자. 넘으면 메시지 전체가 거절된다.
  const shown = options.filter((o) => o.value.length <= 2000).slice(0, 25);
  if (shown.length === 0) return [];
  const elements = shown.map((o, i) => ({
    type: "button",
    text: { type: "plain_text", text: o.label.length > 75 ? o.label.slice(0, 72) + "..." : o.label },
    action_id: `choose_option:${i}`,
    value: o.value,
  }));
  const hidden = options.length - shown.length;
  const note = hidden > 0 ? ` _(${hidden}개는 버튼에 담지 못했어요. 직접 입력해 주세요.)_` : "";
  return [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `:point_right: *선택지 — 클릭하면 자동 전송:*${note}` }],
    },
    { type: "actions", ...(dmMain ? { block_id: `options${DM_MAIN_BLOCK_SUFFIX}` } : {}), elements },
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

/** 봇이 /v1/event-rules/{apply,cancel} 로 처리하는 chip type (기본·복합 메트릭스 이벤트 모두 이 두 type). */
const EVENT_RULE_CHIP_TYPES = new Set(["applyEventRules", "cancelEventRules"]);

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
// 레거시 모드에서 creds.argusCookie 없으면 호출자가 chip 을 붙이지 않는다 — argus 의
// /v1/event-rules/{apply,cancel} 가 cookie 인증이라 token 만으론 401. chip 보여주고
// 클릭 후 거부하는 것보다 표시 안 하는 게 UX 일관성 ↑ (renderCookieGateHint 참고).
// 와탭 로그인 모드에선 argus 가 같은 경로에서 사용자 토큰을 받으므로 항상 붙인다.
function chipActionsToBlocks(actions: ChipAction[] | undefined): unknown[] {
  if (!actions || actions.length === 0) return [];

  // apply / cancel 을 한 row 에 묶어 보기. 같은 confirmToken 끼리.
  const byToken = new Map<string, ChipAction[]>();
  let droppedBrowserChips = 0;
  for (const a of actions) {
    // 확인 토큰이 있어도 알림 규칙 chip 이 아니면 여기서 그리지 않는다 — 누르면 알림 규칙 API 를 부르기 때문이다.
    // OPM 조치안은 opmChipBlocks 가 따로 그린다.
    if (!EVENT_RULE_CHIP_TYPES.has(a.type)) {
      if (a.type !== OPM_CHIP_TYPE && a.payload?.["confirmToken"]) {
        console.log(`[argus-slack-bot] dropped chip with unknown type=${a.type}`);
      }
      if (!a.payload?.["confirmToken"]) droppedBrowserChips++;
      continue;
    }
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
    // 버튼 위에 미리보기 — 답변 문장과 상관없이 무엇이 어떻게 바뀌는지 보여 준다.
    const preview = renderRulePreview(group.find((a) => a.type === "applyEventRules")?.payload);
    if (preview) blocks.push({ type: "section", text: { type: "mrkdwn", text: preview } });
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
        // value 는 결과 문장에 쓸 대상 이름. 토큰은 action_id 에 있다.
        value: String(a.payload?.["targetLabel"] ?? "").slice(0, 150) || token,
      };
    });
    blocks.push({ type: "actions", elements });
  }
  return blocks;
}

// withTextSection — text chunk 를 section block 으로 감싸고 chip blocks 를
// 뒤에(before 는 앞에) 붙임. blocks 가 비면 undefined 반환 (fallback to text-only).
function withTextSection(text: string, chipBlocks: unknown[], before: unknown[] = []): unknown[] | undefined {
  if (chipBlocks.length === 0 && before.length === 0) return undefined;
  // Slack section block text 는 3000자 제한. 그 이상이면 splitForSlack 가 이미
  // 잘랐을 텐데 안전하게 한 번 더 truncate.
  const safeText = text.length > 2900 ? text.slice(0, 2897) + "..." : text;
  return [
    ...before,
    { type: "section", text: { type: "mrkdwn", text: safeText } },
    ...chipBlocks,
  ];
}

main().catch((err) => {
  console.error("[argus-slack-bot] fatal:", err);
  process.exit(1);
});
