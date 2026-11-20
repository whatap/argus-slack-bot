import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { ArgusStreamError } from "./argus-direct.js";
import { ThreadHistory } from "./conversation.js";
import { SqliteInstallationStore } from "./installations.js";
import { OncallOwners } from "./oncall-auto.js";
import { PendingLogins } from "./oauth-http.js";
import { UserTokenStore } from "./user-tokens.js";
import { WhatapLinkStore } from "./whatap-links.js";
import { OAuthError, WhatapOAuthClient, type TokenSet } from "./whatap-oauth.js";

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 자동 대응 타이머용 손으로 돌리는 시계. 콜백이 돌려준 promise 까지 기다린다. */
function fakeClock(start = Date.now()) {
  let now = start;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => unknown; every?: number; ms: number }>();
  const unrefd = new Set<number>();
  const handle = (id: number) => ({ id, unref() { unrefd.add(id); return this; } });
  return {
    now: () => now,
    setTimeout: (fn: () => unknown, ms: number) => { const id = ++seq; due.set(id, { at: now + ms, fn, ms }); return handle(id); },
    clearTimeout: (h: unknown) => { due.delete((h as { id?: number } | undefined)?.id ?? -1); },
    setInterval: (fn: () => unknown, ms: number) => { const id = ++seq; due.set(id, { at: now + ms, fn, every: ms, ms }); return handle(id); },
    clearInterval: (h: unknown) => { due.delete((h as { id?: number } | undefined)?.id ?? -1); },
    /** 걸려 있는 타이머: 반복 여부와 간격, unref 여부. */
    pending: () => [...due].map(([id, t]) => ({ every: t.every, ms: t.ms, unref: unrefd.has(id) })),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => unknown; every?: number }] | undefined;
        for (const e of due) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else due.delete(id);
        await t.fn();
      }
      now = end;
    },
  };
}

type Handler = (ctx: any) => Promise<void>;
const fixtureAnswer = (extra: Record<string, unknown> = {}) => ({ text: "fixture answer", hops: 1, toolCallLog: [],
  newMessages: [{ role: "assistant", content: "fixture answer" }], argusConversationId: "fixture-conv", ...extra });
const tokens: TokenSet = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 600_000 };
// Slack reports one installation that can see the event. In the bot's own DM that is usually the bot.
const BOT_AUTHORIZATION = [{ team_id: "T1", user_id: "UBOT", is_bot: true, is_enterprise_install: false }];
const USER_AUTHORIZATION = [{ team_id: "T1", user_id: "U1", is_bot: false, is_enterprise_install: false }];
const channelNotFound = () => Object.assign(new Error("An API error occurred: channel_not_found"), {
  code: "slack_webapi_platform_error", data: { ok: false, error: "channel_not_found" },
});

// Execute the unchanged entrypoint and its actual bound listeners, replacing only
// boot/transport boundaries. No dotenv, sockets, MCP children, or remote APIs.
async function fixture(t: TestContext, oauth = true, multi = true, opts: { captureErrors?: boolean; env?: Record<string, string> } = {}) {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const modules: Record<string, any> = {};
  for (const match of source.matchAll(/from\s+"(\.\/[^\"]+)"/g)) {
    modules[match[1]] = await import(new URL(match[1], import.meta.url).href);
  }
  const ready = gate();
  const actions: { pattern: RegExp; handler: Handler }[] = [];
  const events = new Map<string, Handler>();
  const privatePosts: any[] = [];
  const publicPosts: any[] = [];
  const updates: any[] = [];
  const fetches: { url: string; init: RequestInit }[] = [];
  let fetchReply: () => Response = () => Response.json({ succeeded: [], failed: [] });
  const warnings: string[] = [];
  const errors: string[] = [];
  // 봇이 남긴 console.log 한 줄씩(자동 대응 기록 확인용).
  const logs: string[] = [];
  // 자동 대응(온콜)의 에스컬레이션·토큰 유지 타이머는 이 시계로 돌린다.
  const oncallClock = fakeClock();
  let oncallOwners: any;
  let errorHandler: Handler | undefined;
  let credsLookups = 0;
  let tokenRequests = 0;
  let argusCalls = 0;
  // What each turn sent to argus (its text and the conversation it continued), and what argus answers.
  const directCalls: { text: string; conversationId?: string }[] = [];
  const alertCalls: { auth: any; pcode?: number; currentUrl?: string }[] = [];
  let directReply: (call: number) => any = () => fixtureAnswer();
  let loginCreates = 0;
  let infoCalls = 0;
  let pending!: PendingLogins;
  let links!: WhatapLinkStore;
  let installations!: SqliteInstallationStore;
  let history!: ThreadHistory;
  let oauthClient!: WhatapOAuthClient;
  let oauthHandler!: http.RequestListener;
  const closers: (() => void)[] = [];
  t.after(() => closers.forEach((close) => close()));
  const client = {
    auth: { test: async () => ({ team_id: "T1", user_id: "UBOT" }) },
    chat: {
      postEphemeral: async (args: any) => { privatePosts.push(args); return {}; },
      postMessage: async (args: any) => { publicPosts.push(args); return { ts: "1.1" }; },
      update: async (args: any) => { updates.push(args); return {}; },
    },
    conversations: {
      // The bot is in D1 (its DM with U1) and in no other DM.
      info: async ({ channel }: { channel: string }): Promise<any> => {
        infoCalls++;
        if (channel === "D1") return { ok: true, channel: { id: "D1", is_im: true, user: "U1" } };
        throw channelNotFound();
      },
    },
  };
  const app = {
    client,
    event: (name: string, handler: Handler) => { events.set(name, handler); },
    action: (pattern: RegExp, handler: Handler) => { actions.push({ pattern, handler }); },
    message: (handler: Handler) => { events.set("message", handler); },
    error: (handler: Handler) => { errorHandler = handler; },
    start: async () => { ready.resolve(); },
  };
  modules["dotenv"] = { config: () => {} };
  modules["@anthropic-ai/sdk"] = { __esModule: true, default: class {} };
  modules["node:http"] = { __esModule: true, default: { createServer: (handler: http.RequestListener) => {
    oauthHandler = handler;
    return { once() {}, listen(_port: number, _host: string, done: () => void) { done(); } };
  } } };
  modules["./slack-app.js"] = { ...modules["./slack-app.js"], createSlackApp: () => app };
  modules["./mcp-pool.js"] = { McpClientPool: class {} };
  modules["./direct-route.js"] = { runDirectToArgus: async (cfg: { argusDirect: any; argusConversationId?: string }, text: string, pcode?: number, currentUrl?: string) => {
    alertCalls.push({ auth: cfg.argusDirect, pcode, currentUrl });
    argusCalls++;
    directCalls.push({ text, conversationId: cfg.argusConversationId });
    return directReply(argusCalls);
  } };
  modules["./user-tokens.js"] = { ...modules["./user-tokens.js"], UserTokenStore: class extends UserTokenStore {
    constructor(...args: ConstructorParameters<typeof UserTokenStore>) { super(...args); closers.push(() => this.close()); }
    override get(user: string) { credsLookups++; return super.get(user); }
  } };
  modules["./installations.js"] = { SqliteInstallationStore: class extends SqliteInstallationStore {
    constructor(...args: ConstructorParameters<typeof SqliteInstallationStore>) { super(...args); installations = this; closers.push(() => this.close()); }
  } };
  modules["./conversation.js"] = { ...modules["./conversation.js"], ThreadHistory: class extends ThreadHistory {
    constructor(...args: ConstructorParameters<typeof ThreadHistory>) { super(...args); history = this; closers.push(() => this.close()); }
  } };
  modules["./whatap-links.js"] = { WhatapLinkStore: class extends WhatapLinkStore {
    constructor(...args: ConstructorParameters<typeof WhatapLinkStore>) { super(...args); links = this; closers.push(() => this.close()); }
  } };
  modules["./oauth-http.js"] = { ...modules["./oauth-http.js"], PendingLogins: class extends PendingLogins {
    constructor(...args: ConstructorParameters<typeof PendingLogins>) { super(...args); pending = this; }
    override create(team: string, user: string) { loginCreates++; return super.create(team, user); }
  } };
  if (modules["./oncall-auto.js"]) {
    const real = modules["./oncall-auto.js"];
    modules["./oncall-auto.js"] = { ...real, systemTimers: oncallClock, OncallOwners: class extends real.OncallOwners {
      constructor(...args: any[]) { super(...args); oncallOwners = this; closers.push(() => this.close()); }
    } };
  }
  modules["./whatap-oauth.js"] = { ...modules["./whatap-oauth.js"],
    WhatapTokenManager: class extends modules["./whatap-oauth.js"].WhatapTokenManager {
      async accessToken(...args: any[]) { tokenRequests++; return super.accessToken(...args); }
    }, WhatapOAuthClient: class extends WhatapOAuthClient {
    constructor(...args: ConstructorParameters<typeof WhatapOAuthClient>) { super(...args); oauthClient = this; }
    override async exchangeCode() { return tokens; }
    override async revoke() { return true; }
    override async authorizationUrl(state: string) { return `https://issuer.invalid/authorize?state=${state}`; }
  } };
  const env = {
    SLACK_TRANSPORT: "http", SLACK_SIGNING_SECRET: "synthetic-signing", SLACK_BOT_TOKEN: "synthetic-bot",
    SLACK_TOKENS_ENCRYPTION_KEY: "synthetic-key", SLACK_USER_TOKENS_DB: ":memory:",
    SLACK_INSTALLATIONS_DB: ":memory:", SLACK_THREAD_HISTORY_DB: ":memory:", WHATAP_OAUTH_PORT: "3011",
    // 와탭 로그인 모드에서 봇은 front 의 /argus 만 부른다(로그인 서버와 같은 origin).
    ARGUS_URL: oauth ? "https://issuer.invalid/argus" : "https://argus.invalid", ARGUS_API_TOKEN: "synthetic-common-token",
    WHATAP_API_TOKEN: "synthetic-common-whatap", ARGUS_COOKIE: "JSESSIONID=synthetic-common-cookie",
    ...(multi ? { SLACK_CLIENT_ID: "synthetic-client", SLACK_CLIENT_SECRET: "synthetic-secret", SLACK_STATE_SECRET: "synthetic-state", SLACK_PUBLIC_URL: "https://bot.example.com" } : {}),
    ...(oauth ? { WHATAP_OAUTH_ISSUER: "https://issuer.invalid", WHATAP_OAUTH_CLIENT_ID: "synthetic-client", WHATAP_OAUTH_CLIENT_SECRET: "synthetic-secret", WHATAP_OAUTH_REDIRECT_URI: "https://bot.example.com/oauth/callback" }
      : { ANTHROPIC_API_KEY: "synthetic-unused", WHATAP_MCP_PATH: "/unused" }),
  };
  Object.assign(env, opts.env);
  const sandbox = {
    exports: {}, require: (id: string) => { assert.ok(id in modules, `unmocked import ${id}`); return modules[id]; },
    process: { env, on() {}, exit(code: number) { throw new Error(`unexpected startup exit ${code}`); } },
    console: {
      log(...args: any[]) { logs.push(args.map(String).join(" ")); },
      warn(...args: any[]) { warnings.push(args.map(String).join(" ")); },
      error(...args: any[]) {
        const line = args.map(String).join(" ");
        if (!opts.captureErrors) throw new Error(line);
        errors.push(line);
      },
    },
    fetch: async (url: string, init: RequestInit) => { fetches.push({ url, init }); return fetchReply(); },
    URL, Date, setTimeout, clearTimeout,
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, sandbox);
  await ready.promise;
  async function install(team = "T1") {
    await installations.storeInstallation({ team: { id: team }, enterprise: undefined, isEnterpriseInstall: false, tokenType: "bot", user: { id: "UINSTALLER", token: undefined, scopes: undefined }, bot: { id: "B1", userId: "UBOT", token: "synthetic-bot", scopes: ["chat:write"] } });
  }
  if (multi) { await install(); await install("T2"); }
  const action = (id: string, ack: () => Promise<void> = async () => {}, team = "T1", extra: { message?: any; value?: string; channel?: string; blockId?: string; user?: string } = {}) => {
    const handler = actions.find((entry) => entry.pattern.test(id))?.handler;
    assert.ok(handler, `actual entrypoint must bind ${id}`);
    return handler({ ack, client, body: { team: { id: team }, user: { id: extra.user ?? "U1" }, channel: { id: extra.channel ?? "C1" }, message: extra.message ?? { ts: "1.0" } },
      action: { action_id: id, value: extra.value ?? "내 프로젝트 보여줘", ...(extra.blockId ? { block_id: extra.blockId } : {}) } });
  };
  const uninstall = (team = "T1", revoked = false) => events.get(revoked ? "tokens_revoked" : "app_uninstalled")!({ body: { team_id: team }, event: revoked ? { type: "tokens_revoked", tokens: { bot: ["UBOT"] } } : { type: "app_uninstalled" } });
  const message = (text: string, where: { channel?: string; authorizations?: unknown[]; ts?: string; thread_ts?: string } = {}) => events.get("message")!({
    body: { type: "event_callback", team_id: "T1", authorizations: where.authorizations ?? BOT_AUTHORIZATION },
    message: { channel_type: "im", channel: where.channel ?? "D1", user: "U1", ts: where.ts ?? "1.0", ...(where.thread_ts ? { thread_ts: where.thread_ts } : {}), text },
    say: client.chat.postMessage, client,
  });
  const request = (url: string) => new Promise<{ status: number; headers: any; body: string }>((resolve) => {
    let status = 0; let headers: any;
    oauthHandler({ method: "GET", url } as http.IncomingMessage, { headersSent: false,
      writeHead(code: number, values: any) { status = code; headers = values; },
      end(body = "") { resolve({ status, headers, body }); },
    } as unknown as http.ServerResponse);
  });
  const incoming = (message: any, body: any = {}) => events.get("message")!({
    message, body: { team_id: "T1", authorizations: BOT_AUTHORIZATION, ...body }, client, say: client.chat.postMessage, context: { botId: "BSELF" },
  });
  const mention = (event: any) => events.get("app_mention")!({ event, body: { team_id: "T1" }, client, say: client.chat.postMessage });
  return { action, message, incoming, mention, uninstall, install, request, client, privatePosts, publicPosts, updates, fetches, pending, links, history, installations, oauthClient,
    warnings, errors, errorHandler: () => errorHandler, directCalls, alertCalls, tokenRequests: () => tokenRequests,
    logs, oncallClock, oncallOwners: () => oncallOwners,
    replyWith: (reply: () => Response) => { fetchReply = reply; },
    answerWith: (reply: (call: number) => any) => { directReply = reply; },
    counts: () => ({ credsLookups, argusCalls, loginCreates, infoCalls }) };
}

// Synthetic values, rendered in the local notihub Korean non-email template shape.
const alertEnv = { SLACK_ALERT_TEAM_ID: "T1", SLACK_ALERT_CHANNEL_ID: "C1", SLACK_ALERT_BOT_IDS: "BFIXTURE,BSECOND,BSELF" };
const rootTs = () => `${Math.floor(Date.now() / 1000) - 120}.000001`;
const alertMessage = (ts = rootTs(), recovered = false) => ({
  channel_type: "group", channel: "C1", subtype: "bot_message", bot_id: "BFIXTURE", ts,
  attachments: [{ pretext: `[${recovered ? "Info" : "Warning"}][Server][test-project][test-target][${recovered ? "RECOVERED: " : ""}test-rule]`,
    text: ["프로젝트 이름 : test-project", "프로젝트 코드 : 42", "서버 이름 : test-target", "이벤트 메시지 : sample",
      "이벤트 시작 시간 : 2025-01-31 09:00:00 +0900", ...(recovered ? ["이벤트 종료 시간 : 2025-01-31 09:05:30 +0900"] : []),
      "바로가기 : <https://fixture.invalid/link/event?pcode=42&amp;archiveId=17>"].join("\n") }],
});

test("webhook start offers analysis in the source thread without doing analysis", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  const start = alertMessage();
  await f.incoming(start);
  assert.equal(f.publicPosts.length, 1);
  const post = f.publicPosts[0];
  assert.equal(post.thread_ts, start.ts);
  assert.match(post.text, /2025-01-31 09:00:00 \+0900/);
  assert.equal(post.blocks.at(-1).elements[0].text.text, "분석");
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.counts().credsLookups, 0);
});

test("webhook click asks as the clicker and answers in the alert thread; only the login link is private", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  linkU1(f);
  const start = alertMessage();
  await f.incoming(start);
  const button = f.publicPosts[0].blocks.at(-1).elements[0];
  const extra = { value: button.value, message: { ts: "1.1", thread_ts: start.ts } };
  await f.action(button.action_id, undefined, "T1", { ...extra, user: "U2" });
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.privatePosts[0]?.user, "U2");
  assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
  assert.equal(f.publicPosts.length, 1, "a click without a WhaTap link leaves nothing in the channel");
  await f.action(button.action_id, undefined, "T1", extra);
  assert.equal(f.alertCalls.length, 1);
  assert.equal(f.alertCalls[0].auth.accessToken, tokens.accessToken);
  assert.equal(f.alertCalls[0].auth.apiToken, "");
  assert.equal(f.alertCalls[0].auth.cookie, undefined);
  assert.equal(f.alertCalls[0].pcode, 42);
  // The request is the incident text the SRE workflow reads, built from the admitted alert's fields only.
  const asked = f.directCalls[0].text.split("\n");
  assert.equal(asked[0], "SRE 사건 분석 요청입니다 (알림 규칙 «test-rule», 서버 1대, 기준 시각 2025-01-31 09:00).");
  assert.ok(asked.includes("- [주의] test-target (oid 0) — 1건, 최근 09:00 «sample»"));
  assert.ok(asked.includes("- 09:00 Warning test-target — sample"));
  assert.doesNotMatch(f.directCalls[0].text, /fixture\.invalid|archiveId/);
  // The answer stays in the alert thread: the placeholder is posted there and then replaced by the answer.
  assert.equal(f.publicPosts.length, 2);
  assert.equal(f.publicPosts[1].channel, "C1");
  assert.equal(f.publicPosts[1].thread_ts, start.ts);
  const answer = f.updates.at(-1);
  assert.equal(answer?.channel, "C1");
  assert.match(answer.text, /fixture answer/);
  assert.equal(f.privatePosts.length, 1, "nothing but U2's login link was private");
  assert.equal(f.counts().credsLookups, 0);
});
test("webhook analysis uses the alert's project and never infers a screen or project from alert wording", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  linkU1(f);
  const start = alertMessage();
  // A rule name that reads like a screen question for another project.
  start.attachments[0].pretext = start.attachments[0].pretext.replace("[test-rule]", "[gpu 트렌드 pcode 3396]");
  await f.incoming(start);
  await f.action("webhook_alert_analyze", undefined, "T1", { value: start.ts, message: { ts: "1.1", thread_ts: start.ts } });
  assert.equal(f.alertCalls.length, 1);
  assert.equal(f.alertCalls[0].pcode, 42);
  assert.equal(f.alertCalls[0].currentUrl, undefined);
  // The same wording typed by a person is still inferred as before.
  await f.message("gpu 트렌드 pcode 3396 보여줘");
  assert.equal(f.alertCalls[1].pcode, 3396);
  assert.match(String(f.alertCalls[1].currentUrl), /3396/);
});
const laterTs = (ts: string, seconds: number) => `${Number(ts.split(".")[0]) + seconds}.000001`;
test("webhook RECOVERED records actual event times and elapsed seconds once on the start", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  const start = alertMessage();
  const off = alertMessage(laterTs(start.ts, 10), true);
  await f.incoming(start);
  await Promise.all([f.incoming(off), f.incoming(off)]);
  assert.equal(f.publicPosts.length, 2, "one offer and one resolution");
  const post = f.publicPosts[1];
  assert.equal(post.thread_ts, start.ts);
  assert.match(post.text, /RECOVERED.*2025-01-31 09:05:30 \+0900/);
  assert.match(post.text, /330초/);
  assert.equal(f.counts().argusCalls, 0);
});
// The server-monitoring template as a deployment without event links sends it: no 바로가기 line.
const linklessAlert = (ts = rootTs(), recovered = false) => ({
  channel_type: "group", channel: "C1", subtype: "bot_message", bot_id: "BFIXTURE", ts,
  attachments: [{ pretext: `[${recovered ? "Info" : "Critical"}][Server][test-project][test-target][${recovered ? "RECOVERED: " : ""}test-rule]`,
    text: ["프로젝트 이름 : test-project", "프로젝트 코드 : 42", "서버 이름 : test-target", `이벤트 메시지 : ${recovered ? "RECOVERED: " : ""}sample`,
      "이벤트 시작 시간 : 2025-01-31 09:00:00 +0900", ...(recovered ? ["이벤트 종료 시간 : 2025-01-31 09:05:30 +0900"] : []),
      `이벤트 경과 시간 : ${recovered ? 5 : 0} 분`, "이벤트 규칙 : test-policy", "해소된 이벤트 알림 : true"].join("\n") }],
});
test("webhook alerts from a deployment without event links still record RECOVERED once on their start", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  const start = linklessAlert();
  await f.incoming(start);
  assert.equal(f.publicPosts.length, 1, "the analysis offer");
  await f.incoming(linklessAlert(laterTs(start.ts, 10), true));
  assert.equal(f.publicPosts.length, 2, "one offer and one resolution");
  assert.equal(f.publicPosts[1].thread_ts, start.ts);
  assert.match(f.publicPosts[1].text, /RECOVERED.*2025-01-31 09:05:30 \+0900.*330초/);
  await f.incoming(linklessAlert(laterTs(start.ts, 20), true));
  assert.equal(f.publicPosts.length, 2, "recorded once");
  assert.equal(f.counts().argusCalls, 0);
});
test("webhook admission requires an original non-shared bot-authorized channel message from the exact source", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  for (const [label, msg, envelope] of [
    ["workspace", {}, { team_id: "T2" }], ["channel", { channel: "C2" }, {}], ["sender", { bot_id: "BOTHER" }, {}],
    ["human", { bot_id: undefined, user: "U1", subtype: undefined }, {}], ["edit", { subtype: "message_changed" }, {}],
    ["reply", { thread_ts: "2.0" }, {}], ["mpim", { channel_type: "mpim" }, {}], ["foreign message", { team: "T2" }, {}],
    ["shared", {}, { is_ext_shared_channel: true }], ["user installation", {}, { authorizations: USER_AUTHORIZATION }],
    ["self", { bot_id: "BSELF" }, {}], ["bad timestamp", { ts: "not-a-ts" }, {}],
  ] as const) {
    await f.incoming({ ...alertMessage(), ...msg }, envelope);
    assert.equal(f.publicPosts.length, 0, label);
  }
  await f.incoming({ ...alertMessage(), subtype: undefined });
  assert.equal(f.publicPosts.length, 1, "bot_id identifies a modern webhook even without subtype");
});

test("webhook mention from a bot must not enter the authenticated human mention path", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  linkU1(f);
  await f.mention({ ...alertMessage(), user: "U1", text: "<@UBOT> analyze" });
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.publicPosts.length, 0);
  await f.mention({ channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> analyze" });
  assert.equal(f.counts().argusCalls, 1);
});
test("webhook repeated start roots quarantine the occurrence, and recovery-first never arms a late start", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  const first = alertMessage();
  await f.incoming(first);
  await f.incoming(first); // Slack redelivery, same message
  await f.incoming(alertMessage(laterTs(first.ts, 2))); // a second parent for the same archive
  await f.incoming(alertMessage(laterTs(first.ts, 3), true));
  assert.equal(f.publicPosts.length, 1, "never choose between two roots");
  linkU1(f);
  await f.action("webhook_alert_analyze", undefined, "T1", { message: { thread_ts: first.ts, ts: "1.1" }, value: first.ts });
  assert.equal(f.counts().argusCalls, 0, "quarantined button");
  const g = await fixture(t, true, true, { env: alertEnv });
  await g.incoming(alertMessage(laterTs(first.ts, 3), true));
  await g.incoming(first);
  await g.incoming(alertMessage(laterTs(first.ts, 4), true));
  assert.equal(g.publicPosts.length, 0, "recovery before start remains inadmissible");
});
test("webhook recovery without an end time labels Slack receipt time and never mixes clock bases", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  const start = alertMessage();
  const off = alertMessage(laterTs(start.ts, 17), true);
  off.attachments[0].text = off.attachments[0].text.replace(/^이벤트 종료 시간.*\n/m, "");
  await f.incoming(start);
  await f.incoming(off);
  assert.equal(f.publicPosts.length, 2);
  assert.match(f.publicPosts[1].text, /Slack 수신 기준/);
  assert.match(f.publicPosts[1].text, /17초/);
  assert.ok(f.publicPosts[1].text.includes(new Date(Number(off.ts) * 1000).toISOString()));
});
test("webhook button is bound to installation, team, channel, original root, reply and value before token lookup", async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  linkU1(f);
  const start = alertMessage();
  await f.incoming(start);
  const id = "webhook_alert_analyze", message = { ts: "1.1", thread_ts: start.ts }, valid = { value: start.ts, message };
  for (const [team, extra] of [
    ["T2", valid], ["T1", { ...valid, channel: "C2" }], ["T1", { ...valid, value: "other" }],
    ["T1", { ...valid, message: { ...message, ts: "1.2" } }], ["T1", { ...valid, message: { ...message, thread_ts: "2.0" } }],
  ] as const) await f.action(id, undefined, team, extra);
  const wait = gate();
  const delayed = f.action(id, () => wait.promise, "T1", valid);
  await f.uninstall(); await f.install(); linkU1(f);
  wait.resolve(); await delayed;
  await f.action(id, undefined, "T1", valid);
  assert.equal(f.tokenRequests(), 0, "not even an attempted token lookup");
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.privatePosts.length, 0);
});

test("webhook disabled on partial configuration and in legacy mode, even when shared credentials work", async (t) => {
  for (const [oauth, env] of [[true, {}], [true, { ...alertEnv, SLACK_ALERT_TEAM_ID: "" }], [false, alertEnv]] as const) {
    const f = await fixture(t, oauth, false, { env });
    await f.incoming(alertMessage());
    assert.equal(f.publicPosts.length, 0);
    assert.equal(f.counts().credsLookups, 0);
    assert.equal(f.counts().argusCalls, 0);
  }
});
test("webhook opt-in leaves existing mention handling outside its channel untouched", async (t) => {
  const event = { channel: "C2", ts: "1.0", bot_id: "BFIXTURE", user: "U1", text: "<@UBOT> help" };
  const f = await fixture(t, true, true, { env: alertEnv });
  await f.mention(event);
  assert.equal(f.publicPosts.length, 1, "ordinary command in another channel");
  const g = await fixture(t);
  await g.mention({ ...event, channel: "C1" });
  assert.equal(g.publicPosts.length, 1, "original mention listener when feature is off");
});
for (const op of ["apply", "cancel"]) {
  test(`OAuth ${op} uses the clicking user's token, never common credentials`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    f.links.save({ teamId: "T1", slackUserId: "U1", subject: "wtid-1", accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken, expiresAt: Date.now() + 600_000, scope: "openid whatap:read whatap:write" });
    await f.action(`${op}_event_rule:fresh-confirm-token`);
    assert.equal(f.counts().credsLookups, 0, "OAuth actions must not consult legacy credentials");
    assert.equal(f.fetches.length, 1);
    assert.equal(f.fetches[0].url, `https://issuer.invalid/argus/v1/event-rules/${op}`);
    const headers = f.fetches[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${tokens.accessToken}`);
    assert.equal(headers.Cookie, undefined, "OAuth actions must not send the common cookie");
    assert.equal(headers["X-Argus-Token"], undefined, "OAuth actions must not send the common argus token");
    assert.equal(JSON.parse(String(f.fetches[0].init.body)).confirmToken, "fresh-confirm-token");
    assert.equal(f.publicPosts.length, 1);
    assert.doesNotMatch(JSON.stringify(f.publicPosts), /synthetic-common|synthetic-access/);
  });
  test(`OAuth ${op} without a WhaTap link sends a private login link and calls nothing`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    await f.action(`${op}_event_rule:fresh-confirm-token`);
    assert.equal(f.counts().credsLookups, 0, "OAuth actions must not consult legacy credentials");
    assert.equal(f.fetches.length, 0);
    assert.equal(f.publicPosts.length, 0);
    assert.equal(f.privatePosts.length, 1);
    assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
    assert.doesNotMatch(f.privatePosts[0].text, /cookie JSESSIONID|synthetic-common/);
  });
  test(`legacy ${op} still uses its configured credentials`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t, false, false);
    await f.action(`${op}_event_rule:historical-confirm-token`);
    assert.equal(f.counts().credsLookups, 1);
    assert.equal(f.fetches.length, 1);
    assert.equal(f.fetches[0].url, `https://argus.invalid/v1/event-rules/${op}`);
    assert.equal((f.fetches[0].init.headers as any).Cookie, "JSESSIONID=synthetic-common-cookie");
    assert.equal((f.fetches[0].init.headers as any)["X-Argus-Token"], "synthetic-common-token");
    assert.equal(f.publicPosts.length, 1);
  });
}

// 실제 사고(17:39): 지어낸 규칙의 [적용]을 눌렀는데 버튼이 그대로 남고 결과가 "1개 생성"뿐이라
// 세 번 눌렀다. 누른 버튼은 바로 상태 줄로 바뀌고, 결과는 무엇을 어디에 했는지 말해야 한다.
const chipMessage = () => ({
  ts: "9.9",
  text: "답변",
  blocks: [
    { type: "section", text: { type: "mrkdwn", text: "답변" } },
    { type: "section", text: { type: "mrkdwn", text: "*:mag: [적용]을 누르면 — 알림 규칙 생성*" } },
    { type: "actions", elements: [
      { type: "button", action_id: "apply_event_rule:ct_live", value: "CPU 80% 초과 알림" },
      { type: "button", action_id: "cancel_event_rule:ct_live", value: "CPU 80% 초과 알림" },
    ] },
  ],
});
const linkU1 = (f: Awaited<ReturnType<typeof fixture>>) => f.links.save({ teamId: "T1", slackUserId: "U1", subject: "wtid-1",
  accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: Date.now() + 600_000, scope: "openid whatap:read whatap:write" });

test("OAuth apply swaps the clicked buttons for a status line and says what changed where", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  linkU1(f);
  f.replyWith(() => Response.json({ action: "create", succeeded: [{ pcode: 3396, eventId: "e1" }], failed: [], elapsedMs: 300 }));
  await f.action("apply_event_rule:ct_live", undefined, "T1", { message: chipMessage(), value: "CPU 80% 초과 알림" });
  assert.equal(f.updates.length, 2, "처리 중 → 결과, 두 번 바꾼다");
  for (const u of f.updates) {
    assert.equal(u.ts, "9.9");
    assert.equal(u.channel, "C1");
    assert.doesNotMatch(JSON.stringify(u.blocks), /apply_event_rule:ct_live/, "누른 버튼은 다시 누를 수 없게 사라진다");
    assert.match(JSON.stringify(u.blocks), /알림 규칙 생성/, "미리보기는 남는다");
  }
  assert.match(JSON.stringify(f.updates[0].blocks), /적용하는 중/);
  assert.match(JSON.stringify(f.updates[1].blocks), /적용함/);
  assert.equal(f.publicPosts.length, 1);
  assert.match(f.publicPosts[0].text, /\*CPU 80% 초과 알림\* — pcode 3396에 생성했어요/);
});

test("OAuth apply puts the buttons back when it could not reach argus (login needed)", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const msg = chipMessage();
  await f.action("apply_event_rule:ct_live", undefined, "T1", { message: msg, value: "CPU 80% 초과 알림" });
  assert.equal(f.fetches.length, 0);
  assert.equal(f.privatePosts.length, 1, "로그인 링크만 나에게");
  assert.deepEqual(f.updates.at(-1).blocks, msg.blocks, "로그인 뒤 다시 누를 수 있게 버튼을 되돌린다");
});

test("OAuth apply on an expired confirmation retires the buttons and says why", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  linkU1(f);
  f.replyWith(() => Response.json({ code: "token_not_found", error: "confirmToken not found or expired" }, { status: 404 }));
  await f.action("apply_event_rule:ct_live", undefined, "T1", { message: chipMessage(), value: "CPU 80% 초과 알림" });
  assert.match(JSON.stringify(f.updates.at(-1).blocks), /만료됨/);
  assert.doesNotMatch(JSON.stringify(f.updates.at(-1).blocks), /apply_event_rule:ct_live/);
  assert.match(f.publicPosts[0].text, /시간이 지났어요/);
});

// front 가 쓰기 scope 없는 토큰을 /argus/v1/event-rules/apply 에서 막는다(403 insufficient_scope).
// 아무것도 바뀌지 않았으니 버튼을 되돌리고, 다시 허락받을 링크만 나에게 보낸다.
test("OAuth apply without write consent puts the buttons back and asks for consent privately", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.links.save({ teamId: "T1", slackUserId: "U1", subject: "wtid-1", accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken, expiresAt: Date.now() + 600_000, scope: "openid whatap:read" });
  const msg = chipMessage();
  f.replyWith(() => new Response(JSON.stringify({ status: 403, error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="whatap:write"' },
  }));
  await f.action("apply_event_rule:ct_live", undefined, "T1", { message: msg, value: "CPU 80% 초과 알림" });
  assert.equal(f.fetches.length, 1, "토큰 갱신·재시도 없이 한 번만 부른다");
  assert.equal(f.fetches[0].url, "https://issuer.invalid/argus/v1/event-rules/apply", "Argus 는 front 를 거쳐서만 부른다");
  assert.deepEqual(f.updates.at(-1).blocks, msg.blocks, "허락한 뒤 다시 누를 수 있게 버튼을 되돌린다");
  assert.equal(f.publicPosts.length, 0);
  assert.equal(f.privatePosts.length, 1);
  assert.match(f.privatePosts[0].text, /WhaTap 설정 변경/);
  assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
  assert.doesNotMatch(f.privatePosts[0].text, /synthetic-access/);
});

for (const pause of ["ack", "postMessage"] as const) {
  for (const reinstall of [false, true]) {
    test(`followup paused at ${pause} cannot resume after uninstall (reinstall=${reinstall})`, { timeout: 5000 }, async (t) => {
      const f = await fixture(t);
      const entered = gate();
      const release = gate();
      const delayed = async () => { entered.resolve(); await release.promise; return { ts: "1.1" }; };
      if (pause === "postMessage") f.client.chat.postMessage = delayed;
      const running = f.action("followup_question:0", pause === "ack" ? async () => { await delayed(); } : undefined);
      await entered.promise;
      await f.uninstall("T1", pause === "ack");
      assert.equal(f.installations.getBotIdentity("T1"), null);
      if (reinstall) await f.install();
      release.resolve();
      await running;
      assert.equal(f.counts().loginCreates, 0, "a stale followup must not issue a new login after deletion");
      assert.equal(f.counts().argusCalls, 0);
      assert.equal(f.links.get("T1", "U1"), null);
      assert.equal((f.history as any).db.prepare("SELECT COUNT(*) AS n FROM thread_meta").get().n, 0);
      assert.equal((f.history as any).db.prepare("SELECT COUNT(*) AS n FROM thread_history").get().n, 0);
      assert.equal(f.privatePosts.length, 0);
    });
  }
}

test("installed and reinstalled workspace can issue a private login and complete it", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  for (const reinstall of [false, true]) {
    if (reinstall) { await f.uninstall(); await f.install(); }
    await f.action("followup_question:0");
    const link = f.privatePosts.at(-1).text.match(/<(https:[^|]+)\|/)[1];
    const start = await f.request(new URL(link).pathname + new URL(link).search);
    assert.equal(start.status, 302);
    const state = new URL(start.headers.Location).searchParams.get("state");
    assert.equal((await f.request(`/oauth/callback?state=${state}&code=synthetic`)).status, 200);
    assert.equal(f.links.get("T1", "U1")?.accessToken, tokens.accessToken);
    await f.action("followup_question:0");
    assert.equal(f.counts().argusCalls, reinstall ? 2 : 1);
  }
});

test("new pending issuance is denied after uninstall, without blocking another tenant or reinstall", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.uninstall();
  assert.throws(() => f.pending.create("T1", "U1"), /workspace|installation/i);
  assert.ok(f.pending.create("T2", "U1"));
  await f.install();
  assert.ok(f.pending.create("T1", "U1"));
});

test("a fresh login message after uninstall is stopped before pending issuance", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.uninstall();
  // A second guard in PendingLogins must not mask attempted issuance here.
  await f.message("login").catch(() => {});
  assert.equal(f.counts().loginCreates, 0);
  assert.equal(f.privatePosts.length, 0);
  assert.equal(f.publicPosts.length, 0);
});

test("single-workspace pending issuance trusts only auth.test identity and stops after uninstall", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, true, false);
  assert.throws(() => f.pending.create("T2", "U1"), /workspace|installation/i);
  await f.uninstall("T2");
  assert.ok(f.pending.create("T1", "U1"));
  await f.uninstall();
  assert.throws(() => f.pending.create("T1", "U1"), /workspace|installation/i);
});

test("oauth start consults current installation, independently of pending revocation", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const id = f.pending.create("T1", "U1");
  await f.installations.deleteInstallation({ teamId: "T1", enterpriseId: undefined, isEnterpriseInstall: false });
  assert.equal(f.pending.begin(id) === null, true, "begin itself must reject an inactive installation");
  assert.equal((await f.request(`/oauth/start?login=${id}`)).status, 400);
});

test("callback rejects an inactive installation before exchanging code", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const state = f.pending.begin(f.pending.create("T1", "U1"))!.state;
  let exchanges = 0;
  f.oauthClient.exchangeCode = async () => { exchanges++; return tokens; };
  await f.installations.deleteInstallation({ teamId: "T1", enterpriseId: undefined, isEnterpriseInstall: false });
  assert.equal((await f.request(`/oauth/callback?state=${state}&code=synthetic`)).status, 400);
  assert.equal(exchanges, 0);
  assert.equal(f.links.get("T1", "U1"), null);
});

test("callback rechecks installation after exchange even when pending state was not revoked", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const entered = gate(); const release = gate<TokenSet>();
  let revoked = 0;
  f.oauthClient.exchangeCode = async () => { entered.resolve(); return release.promise; };
  f.oauthClient.revoke = async () => { revoked++; return true; };
  const state = f.pending.begin(f.pending.create("T1", "U1"))!.state;
  const response = f.request(`/oauth/callback?state=${state}&code=synthetic`);
  await entered.promise;
  await f.installations.deleteInstallation({ teamId: "T1", enterpriseId: undefined, isEnterpriseInstall: false });
  release.resolve(tokens);
  assert.equal((await response).status, 400, "late callback must not resurrect the link");
  assert.equal(f.links.get("T1", "U1"), null);
  assert.ok(revoked > 0);
});

test("oauth start cannot redirect after uninstall while discovery is awaiting", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const entered = gate(); const release = gate<string>();
  f.oauthClient.authorizationUrl = async () => { entered.resolve(); return release.promise; };
  const id = f.pending.create("T1", "U1");
  const response = f.request(`/oauth/start?login=${id}`);
  await entered.promise;
  await f.uninstall();
  release.resolve("https://issuer.invalid/authorize");
  assert.equal((await response).status, 400, "start must recheck its captured pending login after discovery");
});

test("old followup cannot query a new link or write history after reinstall", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const entered = gate(); const release = gate();
  f.client.chat.postMessage = async () => { entered.resolve(); await release.promise; return { ts: "1.1" }; };
  const response = f.action("followup_question:0");
  await entered.promise;
  await f.uninstall(); await f.install();
  f.links.save({ ...tokens, teamId: "T1", slackUserId: "U1", subject: "new-login" });
  release.resolve(); await response;
  assert.equal(f.counts().argusCalls, 0);
  assert.equal((f.history as any).db.prepare("SELECT COUNT(*) AS n FROM thread_meta").get().n, 0);
  assert.equal((f.history as any).db.prepare("SELECT COUNT(*) AS n FROM thread_history").get().n, 0);
  assert.equal(f.links.get("T1", "U1")?.subject, "new-login");
});

test("bound uninstall invalidates an exchanging callback even after reinstall", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const entered = gate(); const release = gate<TokenSet>();
  f.oauthClient.exchangeCode = async () => { entered.resolve(); return release.promise; };
  const state = f.pending.begin(f.pending.create("T1", "U1"))!.state;
  const response = f.request(`/oauth/callback?state=${state}&code=synthetic`);
  await entered.promise;
  await f.uninstall(); await f.install();
  release.resolve(tokens);
  assert.equal((await response).status, 400);
  assert.equal(f.links.get("T1", "U1"), null);
});

// A user-token event subscription (user_events message.im) delivers the linked user's DMs with
// other people. Those must never become questions, even when the user has a linked account.
test("a linked user's DM with someone else is ignored before any processing", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.links.save({ ...tokens, teamId: "T1", slackUserId: "U1", subject: "linked" });
  await f.message("private note to a colleague", { channel: "DOTHER", authorizations: USER_AUTHORIZATION });
  assert.equal(f.counts().argusCalls, 0, "another conversation must not be forwarded to Argus");
  assert.equal(f.counts().loginCreates, 0);
  assert.equal(f.publicPosts.length + f.privatePosts.length, 0);
  assert.equal((f.history as any).db.prepare("SELECT COUNT(*) AS n FROM thread_history").get().n, 0);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^\[argus-slack-bot\] ignored DM outside this bot's conversation at=\d{4}-\d{2}-\d{2}T/);
  assert.match(f.warnings[0], / team=T1 channel=DOTHER reason=bot-not-in-conversation auth=user$/);
  assert.doesNotMatch(f.warnings[0], /private note/);
});

test("an unlinked user's DM with someone else does not issue a login link", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.message("lunch?", { channel: "DOTHER", authorizations: USER_AUTHORIZATION });
  assert.equal(f.counts().loginCreates, 0);
  assert.equal(f.publicPosts.length + f.privatePosts.length, 0);
});

test("the bot's own DM is answered when Slack reports the user's authorization", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.message("내 프로젝트 보여줘", { authorizations: USER_AUTHORIZATION });
  await f.message("내 프로젝트 보여줘", { authorizations: USER_AUTHORIZATION });
  assert.equal(f.counts().infoCalls, 1, "membership is checked once per DM");
  assert.equal(f.counts().loginCreates, 2, "both messages reach the normal login flow");
  assert.equal(f.publicPosts.length, 2);
  assert.equal(f.warnings.length, 0);
});

test("the bot's own DM reported with the bot authorization needs no membership check", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.message("내 프로젝트 보여줘");
  assert.equal(f.counts().infoCalls, 0);
  assert.equal(f.counts().loginCreates, 1);
});

test("a DM paused at the membership check cannot resume after uninstall and reinstall", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const entered = gate(); const release = gate();
  f.client.conversations.info = async () => {
    entered.resolve(); await release.promise;
    return { ok: true, channel: { id: "D1", is_im: true, user: "U1" } };
  };
  const running = f.message("내 프로젝트 보여줘", { authorizations: USER_AUTHORIZATION });
  await entered.promise;
  await f.uninstall(); await f.install();
  release.resolve(); await running;
  assert.equal(f.counts().loginCreates, 0, "a DM received before uninstall must not issue a login after reinstall");
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.publicPosts.length + f.privatePosts.length, 0);
});

test("the entrypoint logs Slack failures with time and channel, then rethrows", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, true, true, { captureErrors: true });
  const handler = f.errorHandler();
  assert.ok(handler, "entrypoint must register a Slack error handler");
  const error = channelNotFound();
  await assert.rejects(
    handler({ error, body: { type: "event_callback", team_id: "T1", event: { type: "message", channel: "D9", channel_type: "im", text: "private question" } } }),
    (thrown: unknown) => thrown === error,
  );
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /slack handler failed at=\d{4}-\d{2}-\d{2}T\S+ team=T1 channel=D9 channel_type=im thread=no kind=event:message code=slack_webapi_platform_error slack_error=channel_not_found/);
  assert.doesNotMatch(f.errors[0], /private question/);
});

// ── argus 의 선택지(render_options) ─────────────────────────────────────────
// 실제 사고(2026-11-11 봇 DM): 봇이 "위 버튼에서 프로젝트를 선택해 주세요" 라고 답했는데 그런 버튼이 없었다.
const optionButtons = (blocks: any[] | undefined) => (blocks ?? []).find((b) => b.type === "actions"
  && b.elements.some((e: any) => String(e.action_id).startsWith("choose_option:")));
const followupButtons = (blocks: any[] | undefined) => (blocks ?? []).find((b) => b.type === "actions"
  && b.elements.some((e: any) => String(e.action_id).startsWith("followup_question:")));

test("argus options that came before the answer text are drawn as buttons above it", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  f.answerWith(() => fixtureAnswer({ text: "위 버튼에서 프로젝트를 선택해 주세요.", optionsBeforeText: true,
    options: [{ label: "K8s-GPU (3396)", value: "3396 프로젝트의 [AI] 임시 확인용 알림 삭제해줘" }, { label: "demo (5490)", value: "demo (5490)" }] }));
  await f.message("[AI] 임시 확인용 알림 삭제해줘");
  const blocks = f.updates.at(-1).blocks as any[];
  const buttons = optionButtons(blocks);
  assert.ok(buttons, "the options are rendered as buttons");
  assert.deepEqual(buttons.elements.map((e: any) => [e.type, e.text.text, e.value]), [
    ["button", "K8s-GPU (3396)", "3396 프로젝트의 [AI] 임시 확인용 알림 삭제해줘"],
    ["button", "demo (5490)", "demo (5490)"],
  ]);
  const textAt = blocks.findIndex((b) => b.type === "section" && b.text.text.includes("위 버튼에서"));
  assert.ok(textAt > blocks.indexOf(buttons), "the buttons the text points at sit above it");
});

test("argus options that came after the answer text sit below it, and replace the canned follow-ups", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  f.answerWith(() => fixtureAnswer({ text: "어떤 대시보드를 만들까요?", optionsBeforeText: false, options: [{ label: "성능", value: "성능 대시보드 만들어줘" }] }));
  await f.message("대시보드 만들어줘");
  const blocks = f.updates.at(-1).blocks as any[];
  const textAt = blocks.findIndex((b) => b.type === "section" && b.text.text.includes("어떤 대시보드"));
  assert.ok(textAt >= 0 && textAt < blocks.indexOf(optionButtons(blocks)), "the buttons follow the text that asks");
  assert.equal(followupButtons(blocks), undefined, "canned follow-ups would compete with the choice argus asked for");
});

test("follow-ups argus itself recommended are kept next to its options", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  f.answerWith(() => fixtureAnswer({ optionsBeforeText: true, options: [{ label: "A", value: "A" }], recommendedQuestions: ["프로젝트 목록 보여줘"] }));
  await f.message("알림 삭제해줘");
  const blocks = f.updates.at(-1).blocks as any[];
  assert.ok(optionButtons(blocks));
  assert.deepEqual(followupButtons(blocks)?.elements.map((e: any) => e.value), ["프로젝트 목록 보여줘"]);
});

test("an answer without options keeps the canned follow-ups", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  await f.message("내 프로젝트 보여줘");
  const blocks = f.updates.at(-1).blocks as any[];
  assert.equal(optionButtons(blocks), undefined);
  assert.equal(followupButtons(blocks)?.elements.length, 3);
});

test("options are cut to what a Slack button row accepts, and the answer says some are missing", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const options = [
    { label: "L".repeat(100), value: "long label" },
    { label: "unsendable", value: "v".repeat(2001) },
    ...Array.from({ length: 30 }, (_, i) => ({ label: `P${i}`, value: `P${i}` })),
  ];
  f.answerWith(() => fixtureAnswer({ optionsBeforeText: true, options }));
  await f.message("프로젝트 골라줘");
  const blocks = f.updates.at(-1).blocks as any[];
  const buttons = optionButtons(blocks);
  assert.equal(buttons.elements.length, 25, "Slack rejects more than 25 elements in one actions block");
  assert.equal(buttons.elements[0].text.text.length, 75, "Slack rejects button text over 75 characters");
  assert.ok(buttons.elements.every((e: any) => e.value.length <= 2000), "Slack rejects button values over 2000 characters");
  assert.ok(!buttons.elements.some((e: any) => e.text.text === "unsendable"));
  assert.equal(new Set(buttons.elements.map((e: any) => e.action_id)).size, 25, "action ids are unique within the message");
  const header = blocks[blocks.indexOf(buttons) - 1];
  assert.equal(header.type, "context");
  assert.match(header.elements[0].text, /7개/, "the 7 options without a button are mentioned");
});

// ── DM 대화 잇기 ────────────────────────────────────────────────────────────
// 실제 사고(2026-11-11 봇 DM): "어느 프로젝트의 알림을 삭제할까요?" 에 "3396" 이라고 답했더니 봇이 앞 질문을
// 잊고 프로젝트 상태를 답했다. DM 본문의 메시지마다 새 대화를 열었기 때문이다.
test("DM messages outside a thread continue one conversation and are answered in the DM itself", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  await f.message("[AI] 임시 확인용 알림 삭제해줘", { ts: "100.1" });
  await f.message("3396", { ts: "100.2" });
  assert.deepEqual(f.directCalls, [
    { text: "[AI] 임시 확인용 알림 삭제해줘", conversationId: undefined },
    { text: "3396", conversationId: "fixture-conv" },
  ]);
  assert.ok(f.publicPosts.every((p) => p.thread_ts === undefined), "replies stay in the DM, not in a thread");
});

// 답변 아래 버튼(추천 후속 질문·선택지)도 같은 대화여야 한다. 예전엔 DM 답변의 버튼을 누르면 그 답변 밑에
// 스레드가 생기고 새 대화가 열려서, "삭제 진행해줘" 를 눌러도 무엇을 삭제할지 몰랐다.
for (const kind of ["followup_question", "choose_option"] as const) {
  test(`a ${kind} button under a DM answer continues that conversation in the DM itself`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t); linkU1(f);
    f.answerWith(() => fixtureAnswer({ optionsBeforeText: true, options: [{ label: "K8s-GPU (3396)", value: "3396" }], recommendedQuestions: ["삭제 진행해줘"] }));
    await f.message("[AI] 임시 확인용 알림 삭제해줘", { ts: "100.1" });
    const answer = f.updates.at(-1);
    const row = kind === "choose_option" ? optionButtons(answer.blocks) : followupButtons(answer.blocks);
    const button = row.elements[0];
    f.publicPosts.length = 0;
    await f.action(button.action_id, undefined, "T1", { channel: "D1", blockId: row.block_id, value: button.value, message: { ts: "1.1", blocks: answer.blocks } });
    assert.deepEqual(f.directCalls.at(-1), { text: button.value, conversationId: "fixture-conv" });
    assert.ok(f.publicPosts.length >= 2, "the choice is echoed and the answer placeholder is posted");
    assert.ok(f.publicPosts.every((p) => p.channel === undefined || p.channel === "D1"));
    assert.ok(f.publicPosts.every((p) => p.thread_ts === undefined), "nothing moves into a thread under the answer");
    assert.match(f.publicPosts[0].text, new RegExp(button.value));
  });
}

// 실제 사고(2026-11-13 봇 DM): [적용] 뒤 미리보기 답변의 "삭제 대상 다시 확인" 을 눌렀더니 봇이 그 답변의 스레드에서
// 새 대화로 답했다("어떤 삭제 대상을 다시 확인할지 정보가 부족합니다"). 봇이 적용 결과를 미리보기 답변의 스레드에
// 달면 그 답변이 스레드의 첫 글이 되고, Slack 은 그런 메시지의 버튼 클릭에 thread_ts(자기 ts 와 같은 값)를 실어 보낸다.
test("a button under a DM answer that already has thread replies still continues the DM conversation in the DM itself", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  f.answerWith(() => fixtureAnswer({ recommendedQuestions: ["삭제 대상 다시 확인"] }));
  await f.message("[AI] 임시 확인용 알림 삭제해줘", { ts: "100.1" });
  const answer = f.updates.at(-1);
  const row = followupButtons(answer.blocks);
  f.publicPosts.length = 0;
  await f.action(row.elements[0].action_id, undefined, "T1", { channel: "D1", blockId: row.block_id, value: row.elements[0].value,
    message: { ts: "1.1", thread_ts: "1.1", blocks: answer.blocks } });
  assert.deepEqual(f.directCalls.at(-1), { text: "삭제 대상 다시 확인", conversationId: "fixture-conv" });
  assert.ok(f.publicPosts.length >= 2, "the choice is echoed and the answer placeholder is posted");
  assert.ok(f.publicPosts.every((p) => p.thread_ts === undefined), "the answer stays in the DM, not in the thread that holds the apply result");
});

test("a follow-up button in a channel thread still answers in that thread, as its own conversation", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  await f.action("followup_question:0", undefined, "T1", { channel: "C1", value: "프로젝트 상태 확인해줘", message: { ts: "7.1", thread_ts: "7.0" } });
  assert.deepEqual(f.directCalls.at(-1), { text: "프로젝트 상태 확인해줘", conversationId: undefined });
  assert.ok(f.publicPosts.length >= 2 && f.publicPosts.every((p) => p.thread_ts === "7.0"));
});

test("a DM-marked button on a threaded message is treated as that thread, not the DM conversation", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  await f.message("알림 삭제해줘", { ts: "100.1" });
  f.publicPosts.length = 0;
  await f.action("followup_question:0", undefined, "T1", { channel: "D1", blockId: "followup_dm_main", value: "삭제 진행해줘", message: { ts: "8.1", thread_ts: "8.0" } });
  assert.equal(f.directCalls.at(-1)?.conversationId, undefined, "a thread keeps its own conversation");
  assert.ok(f.publicPosts.every((p) => p.thread_ts === "8.0"));
});

// 봇은 적용 결과를 미리보기 메시지의 스레드에 단다. 거기에 "다시 해줘" 라고 답하면 하던 대화여야 한다.
test("the first reply in a thread under a DM message picks up the DM conversation and is answered in that thread", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  await f.message("[AI] 임시 확인용 알림 삭제해줘", { ts: "100.1" });
  f.publicPosts.length = 0;
  await f.message("다시 해줘", { ts: "100.5", thread_ts: "1.1" });
  assert.deepEqual(f.directCalls.at(-1), { text: "다시 해줘", conversationId: "fixture-conv" });
  assert.ok(f.publicPosts.length >= 1 && f.publicPosts.every((p) => p.thread_ts === "1.1"));
});

test("a DM thread that already has its own conversation keeps it", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  f.answerWith((call) => fixtureAnswer({ argusConversationId: ["thread-conv", "main-conv", "thread-conv"][call - 1] }));
  await f.message("스레드에서 시작", { ts: "200.2", thread_ts: "200.1" });
  await f.message("본문에서 다른 얘기", { ts: "200.3" });
  await f.message("스레드에서 이어서", { ts: "200.4", thread_ts: "200.1" });
  assert.deepEqual(f.directCalls.map((c) => c.conversationId), [undefined, undefined, "thread-conv"]);
});

// DM 본문이 한 대화가 되면서, 답이 오기 전에 보낸 다음 메시지가 같은 argus 대화를 동시에 만질 수 있게 됐다.
const settle = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };
const until = async (cond: () => boolean) => { for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r)); assert.ok(cond(), "condition was not reached"); };

test("a DM message sent while the previous answer is still coming waits for it, then continues its conversation", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const firstAnswer = gate();
  f.answerWith(async (call) => { if (call === 1) await firstAnswer.promise; return fixtureAnswer({ argusConversationId: "conv-A" }); });
  const first = f.message("[AI] 임시 확인용 알림 삭제해줘", { ts: "300.1" });
  await until(() => f.directCalls.length === 1);
  const second = f.message("3396", { ts: "300.2" });
  await settle();
  assert.equal(f.directCalls.length, 1, "the second turn does not reach argus while the first is running");
  assert.equal(f.publicPosts.length, 2, "but its placeholder is already up, so the user sees it was received");
  firstAnswer.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.directCalls.map((c) => c.conversationId), [undefined, "conv-A"]);
});

test("a thread reply under a DM message also waits for the DM turn it continues", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const firstAnswer = gate();
  f.answerWith(async (call) => { if (call === 1) await firstAnswer.promise; return fixtureAnswer({ argusConversationId: "conv-A" }); });
  const first = f.message("알림 삭제해줘", { ts: "310.1" });
  await until(() => f.directCalls.length === 1);
  const inThread = f.message("3396", { ts: "310.2", thread_ts: "310.1" });
  await settle();
  assert.equal(f.directCalls.length, 1);
  firstAnswer.resolve();
  await Promise.all([first, inThread]);
  assert.deepEqual(f.directCalls.map((c) => c.conversationId), [undefined, "conv-A"]);
});

test("a turn that fails still lets the next DM message through", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, true, true, { captureErrors: true }); linkU1(f);
  f.answerWith((call) => { if (call === 1) throw new Error("argus down"); return fixtureAnswer(); });
  await f.message("첫 질문", { ts: "320.1" });
  await f.message("다음 질문", { ts: "320.2" });
  assert.equal(f.directCalls.length, 2);
});

test("turns in different DMs do not wait for each other", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const firstAnswer = gate();
  f.answerWith(async (call) => { if (call === 1) await firstAnswer.promise; return fixtureAnswer(); });
  const first = f.message("질문", { ts: "330.1" });
  await until(() => f.directCalls.length === 1);
  await f.action("followup_question:0", undefined, "T1", { channel: "C1", value: "채널 스레드의 질문", message: { ts: "330.9", thread_ts: "330.8" } });
  assert.equal(f.directCalls.length, 2, "the channel thread was answered while the DM turn was still running");
  firstAnswer.resolve();
  await first;
});

// DM 본문은 한 대화로 계속 이어진다. argus 가 그 대화를 더는 모르면(다른 와탭 계정으로 다시 로그인, 대화 삭제)
// 저장한 대화 ID 를 계속 보내는 한 매 메시지가 같은 오류로 끝난다.
const conversationGone = () => new ArgusStreamError("NOT_FOUND", "A temporary error occurred while generating a response.");

test("a conversation argus no longer knows is dropped, and the question is asked again as a new one", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  f.answerWith((call) => {
    if (call === 2) throw conversationGone();
    return fixtureAnswer({ argusConversationId: call === 1 ? "conv-old" : "conv-new" });
  });
  await f.message("[AI] 임시 확인용 알림 삭제해줘", { ts: "400.1" });
  assert.doesNotMatch(f.updates.at(-1).text, /새 대화/);
  await f.message("3396", { ts: "400.2" });
  assert.deepEqual(f.directCalls.slice(1), [{ text: "3396", conversationId: "conv-old" }, { text: "3396", conversationId: undefined }]);
  assert.match(f.updates.at(-1).text, /fixture answer/, "the question is answered");
  assert.match(f.updates.at(-1).text, /새 대화/, "and the answer says the earlier context was not carried over");
  await f.message("그 다음은?", { ts: "400.3" });
  assert.equal(f.directCalls.at(-1)?.conversationId, "conv-new", "the new conversation is the one continued from here on");
  assert.doesNotMatch(f.updates.at(-1).text, /새 대화/, "the note is for the turn that started over only");
});

test("a conversation that is still unknown after starting over is reported, not retried forever", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, true, true, { captureErrors: true }); linkU1(f);
  f.answerWith((call) => {
    if (call >= 2) throw conversationGone();
    return fixtureAnswer({ argusConversationId: "conv-old" });
  });
  await f.message("첫 질문", { ts: "410.1" });
  await f.message("다음 질문", { ts: "410.2" });
  assert.deepEqual(f.directCalls.map((c) => c.conversationId), [undefined, "conv-old", undefined]);
  assert.match(f.updates.at(-1).text, /argus 호출 실패/);
});

test("NOT_FOUND for a question that continued no conversation is not retried", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, true, true, { captureErrors: true }); linkU1(f);
  f.answerWith(() => { throw conversationGone(); });
  await f.message("첫 질문", { ts: "420.1" });
  assert.equal(f.directCalls.length, 1);
  assert.match(f.updates.at(-1).text, /argus 호출 실패/);
});

test("other argus errors keep the conversation", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, true, true, { captureErrors: true }); linkU1(f);
  f.answerWith((call) => {
    if (call === 2) throw new ArgusStreamError("PROCESSING_ERROR", "A temporary error occurred while generating a response.");
    return fixtureAnswer({ argusConversationId: "conv-old" });
  });
  await f.message("첫 질문", { ts: "430.1" });
  await f.message("다음 질문", { ts: "430.2" });
  await f.message("다시 질문", { ts: "430.3" });
  assert.deepEqual(f.directCalls.map((c) => c.conversationId), [undefined, "conv-old", "conv-old"]);
});

test("a DM thread that picked up a conversation argus no longer knows clears it for the DM too", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  f.answerWith((call) => {
    if (call === 2) throw conversationGone();
    return fixtureAnswer({ argusConversationId: ["conv-old", "", "conv-thread", "conv-main"][call - 1] });
  });
  await f.message("알림 삭제해줘", { ts: "440.1" });
  await f.message("다시 해줘", { ts: "440.2", thread_ts: "1.1" });
  await f.message("본문에서 다음 질문", { ts: "440.3" });
  await f.message("스레드에서 다음 질문", { ts: "440.4", thread_ts: "1.1" });
  assert.deepEqual(f.directCalls.map((c) => c.conversationId), [undefined, "conv-old", undefined, undefined, "conv-thread"]);
});


// 오래 안 써서(8시간) 로그인 서버가 refresh 를 거절하는 연결. 질문·whoami·버튼 모두 "만료"라고 알려야
// 한다 — 처음 연결하는 사람과 같은 안내를 받으면 왜 다시 로그인해야 하는지 모른다.
type Fixture = Awaited<ReturnType<typeof fixture>>;
const expiredRefresh = async (): Promise<TokenSet> => {
  throw new OAuthError("whatap oauth token request failed (400 invalid_grant)", 400, "invalid_grant");
};
function saveLink(f: Fixture, expiresAt: number) {
  f.links.save({ teamId: "T1", slackUserId: "U1", subject: "wtid-1", email: "user@example.com", accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken, expiresAt, scope: "openid whatap:read whatap:write" });
}
const repliesOf = (f: Fixture) => [...f.publicPosts, ...f.privatePosts].map((post) => String(post.text));

test("만료된 연결로 질문하면 만료됐다고 알리고 다시 연결할 링크를 준다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  saveLink(f, Date.now() - 1_000);
  f.oauthClient.refresh = expiredRefresh;
  await f.message("pcode 3396 최근 24시간 알림 보여줘");
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.links.get("T1", "U1"), null);
  const replies = repliesOf(f);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /와탭 로그인이 만료됐어요/);
  assert.match(replies[0], /와탭 로그인 열기/);
});

test("처음 연결하는 사람에게는 만료라고 하지 않는다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.message("pcode 3396 최근 24시간 알림 보여줘");
  const replies = repliesOf(f);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /와탭 계정을 연결하면/);
  assert.doesNotMatch(replies[0], /만료/);
});

test("whoami 는 만료된 연결을 연결돼 있다고 하지 않는다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  saveLink(f, Date.now() - 1_000);
  f.oauthClient.refresh = expiredRefresh;
  await f.message("whoami");
  const replies = repliesOf(f);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /와탭 로그인이 만료됐어요/);
  assert.doesNotMatch(replies[0], /연결돼 있어요/);
  assert.equal(f.links.get("T1", "U1"), null);
});

test("whoami 는 쓸 수 있는 연결이면 로그인 서버를 부르지 않고 계정을 알려 준다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  saveLink(f, Date.now() + 600_000);
  let refreshes = 0;
  f.oauthClient.refresh = async () => { refreshes++; return tokens; };
  await f.message("whoami");
  assert.deepEqual(repliesOf(f), [":bust_in_silhouette: 와탭 계정이 연결돼 있어요: user@example.com"]);
  assert.equal(refreshes, 0);
});

test("whoami 는 로그인 서버에 닿지 않으면 연결을 지우지 않고 확인하지 못했다고 말한다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  saveLink(f, Date.now() - 1_000);
  f.oauthClient.refresh = async () => { throw new TypeError("fetch failed"); };
  await f.message("whoami");
  const replies = repliesOf(f);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /user@example\.com/);
  assert.match(replies[0], /확인하지 못했어요/);
  assert.doesNotMatch(replies[0], /만료/);
  assert.ok(f.links.get("T1", "U1"), "일시 오류로 연결을 지우면 안 된다");
});

test("만료된 연결로 [적용]을 누르면 만료됐다고 알리고 링크를 준다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  saveLink(f, Date.now() - 1_000);
  f.oauthClient.refresh = expiredRefresh;
  await f.action("apply_event_rule:fresh-confirm-token");
  assert.equal(f.fetches.length, 0);
  assert.equal(f.publicPosts.length, 0);
  assert.equal(f.privatePosts.length, 1);
  assert.match(f.privatePosts[0].text, /와탭 로그인이 만료됐어요/);
  assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
});

// ── OPM 조치안 chip (argus#1066 applyOpmAction) ──────────────────────────────
// argus 는 확인 토큰을 실행 권한 그 자체로 보고 대화 기록·로그에 남기지 않는다. Slack 메시지도 기록이라
// 토큰은 봇 안에만 두고, 버튼에는 그 토큰을 가리키는 짧은 손잡이만 싣는다.
const OPM_TOKEN = "oa_synthetic-confirm-token";
const opmChip = (payload: Record<string, unknown> = {}) => ({
  type: "applyOpmAction",
  label: "디스크 정리: /app/logs 의 7일 지난 로그 삭제",
  payload: {
    confirmToken: OPM_TOKEN, proposalId: "p-1", tool: "operant_action", risk: "warning",
    pcode: 3396, oid: 1234, oname: "demo-was-01", title: "디스크 정리: /app/logs 의 7일 지난 로그 삭제",
    rationale: "/app/logs 사용률 92%", expiresAt: Date.now() + 30 * 60_000,
    arguments: { function: "disk_cleanup", pcode: 3396, oid: 1234, params: { path: "/app/logs", days: "7" } },
    ...payload,
  },
});
// 봇 코드는 vm 안에서 돌아 배열의 prototype 이 다르다 — 펼쳐서 이 쪽 배열로 비교한다.
const opmButtons = (blocks: any[]) => [...blocks].filter((b) => b.type === "actions").flatMap((b) => [...b.elements])
  .filter((e: any) => String(e.action_id).startsWith("opm_action:"));

test("OPM 조치안은 알림 규칙 버튼이 아니라 조치 버튼으로 그리고, 확인 토큰은 Slack 에 싣지 않는다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [opmChip()] }));
  await f.message("demo-was-01 디스크가 가득 찼어");
  const blocks = f.updates.at(-1).blocks as any[];
  assert.doesNotMatch(JSON.stringify(blocks), /_event_rule:/, "알림 규칙 [적용]/[취소] 로 그리면 누를 때 엉뚱한 API 를 부른다");
  assert.deepEqual(opmButtons(blocks).map((b: any) => b.action_id.split(":").slice(0, 2).join(":")), ["opm_action:apply", "opm_action:cancel"]);
  const shown = JSON.stringify(blocks);
  assert.match(shown, /demo-was-01/, "어느 서버에서 도는지 보여 준다");
  assert.match(shown, /disk_cleanup/, "무엇을 실행하는지 보여 준다");
  assert.doesNotMatch(JSON.stringify([f.updates, f.publicPosts, f.privatePosts]), new RegExp(OPM_TOKEN), "확인 토큰은 Slack 에 남기지 않는다");
});

test("와탭 로그인 모드가 아니면(공용 cookie) OPM 조치 버튼을 그리지 않는다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, false, false);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [opmChip()] }));
  await f.message("demo-was-01 디스크가 가득 찼어");
  const shown = JSON.stringify([f.updates, f.publicPosts]);
  assert.doesNotMatch(shown, /opm_action:|_event_rule:/, "공용 자격증명으로 서버 조치를 실행하지 않는다");
  assert.doesNotMatch(shown, new RegExp(OPM_TOKEN));
});

/** 조치안 답을 받아 두고, 그 메시지와 버튼 action_id 를 돌려준다. 이후 기록만 보도록 지금까지의 기록은 비운다. */
async function opmAnswered(f: Awaited<ReturnType<typeof fixture>>, chip = opmChip()) {
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [chip] }));
  await f.message("demo-was-01 디스크가 가득 찼어");
  const final = f.updates.at(-1);
  const [apply, cancel] = opmButtons(final.blocks);
  f.updates.length = 0; f.publicPosts.length = 0; f.privatePosts.length = 0; f.fetches.length = 0;
  return { message: { ts: "9.9", text: final.text, blocks: final.blocks }, apply: apply.action_id as string, cancel: cancel.action_id as string };
}
const proposal = (status: string, extra: Record<string, unknown> = {}) => ({ id: "p-1", status, tool: "operant_action", risk: "warning",
  pcode: 3396, oid: 1234, oname: "demo-was-01", title: "디스크 정리: /app/logs 의 7일 지난 로그 삭제", ...extra });

test("webhook 분석 답의 OPM 조치안은 누른 사람에게 묶인 [조치 실행] 버튼으로 알림 스레드에 붙고, 실행 결과도 그 스레드에 남는다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, true, true, { env: alertEnv });
  linkU1(f);
  f.links.save({ teamId: "T1", slackUserId: "U2", subject: "wtid-2", accessToken: "synthetic-access-2", refreshToken: "synthetic-refresh-2",
    expiresAt: Date.now() + 600_000, scope: "openid whatap:read whatap:write" });
  const start = alertMessage();
  await f.incoming(start);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [opmChip()] }));
  await f.action("webhook_alert_analyze", undefined, "T1", { value: start.ts, message: { ts: "1.1", thread_ts: start.ts } });
  const answer = f.updates.at(-1);
  assert.ok(answer, "분석 답이 스레드의 글로 남아야 버튼 줄을 상태로 바꿀 수 있다");
  const [apply, cancel] = opmButtons(answer.blocks);
  assert.deepEqual([apply, cancel].map((b: any) => String(b?.action_id).split(":").slice(0, 2).join(":")), ["opm_action:apply", "opm_action:cancel"]);
  assert.match(JSON.stringify(answer.blocks), /demo-was-01/, "어느 서버에서 도는지 보여 준다");
  assert.doesNotMatch(JSON.stringify([f.updates, f.publicPosts, f.privatePosts]), new RegExp(OPM_TOKEN), "확인 토큰은 Slack 에 남기지 않는다");
  const message = { ts: "9.9", thread_ts: start.ts, text: answer.text, blocks: answer.blocks };
  f.updates.length = 0; f.publicPosts.length = 0; f.privatePosts.length = 0; f.fetches.length = 0;
  await f.action(apply.action_id, undefined, "T1", { message, user: "U2" });
  assert.equal(f.fetches.length, 0, "분석을 누르지 않은 사람은 그 조치안을 실행할 수 없다");
  assert.equal(f.privatePosts.at(-1)?.user, "U2");
  f.replyWith(() => Response.json({ proposal: proposal("executed", { result: "ok" }), replayed: false }));
  await f.action(apply.action_id, undefined, "T1", { message });
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0].url, "https://issuer.invalid/argus/v1/opm/actions/apply");
  assert.equal((f.fetches[0].init.headers as Record<string, string>).Authorization, `Bearer ${tokens.accessToken}`);
  assert.equal(f.publicPosts.at(-1)?.thread_ts, start.ts, "실행 결과는 알림 스레드에 남는다");
  assert.match(f.publicPosts.at(-1).text, /demo-was-01에서 실행했어요/);
});

test("[조치 실행]은 물어본 사람의 와탭 토큰과 봇에 둔 확인 토큰으로 front 의 argus 경로를 부르고 결과를 남긴다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const chip = await opmAnswered(f);
  f.replyWith(() => Response.json({ proposal: proposal("executed", { result: "deleted 12 files; /app/logs 92% -> 41%" }), replayed: false }));
  await f.action(chip.apply, undefined, "T1", { message: chip.message });
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0].url, "https://issuer.invalid/argus/v1/opm/actions/apply", "Argus 는 front 를 거쳐서만 부른다");
  const headers = f.fetches[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${tokens.accessToken}`);
  assert.equal(headers.Cookie, undefined);
  assert.equal(headers["X-Argus-Token"], undefined);
  assert.equal(JSON.parse(String(f.fetches[0].init.body)).confirmToken, OPM_TOKEN, "토큰은 요청 본문으로만 보낸다");
  assert.equal(f.updates.length, 2, "실행 요청 중 → 결과, 두 번 바꾼다");
  assert.match(JSON.stringify(f.updates[0].blocks), /실행 요청 중/);
  assert.match(JSON.stringify(f.updates[1].blocks), /실행함/);
  assert.equal(opmButtons(f.updates[1].blocks).length, 0, "실행한 조치는 다시 누를 수 없다");
  assert.match(JSON.stringify(f.updates[1].blocks), /disk_cleanup/, "무엇을 실행했는지는 남는다");
  assert.equal(f.publicPosts.length, 1);
  assert.match(f.publicPosts[0].text, /demo-was-01에서 실행했어요/);
  assert.match(f.publicPosts[0].text, /deleted 12 files; \/app\/logs 92% -&gt; 41%/, "OPM 이 돌려준 결과를 보여 준다(Slack 이 &gt; 를 > 로 그린다)");
  assert.doesNotMatch(JSON.stringify([f.updates, f.publicPosts, f.privatePosts]), new RegExp(OPM_TOKEN));
});

test("다른 사람이 받은 조치안 버튼은 누를 수 없다 — 아무것도 부르지 않고 누른 사람에게만 알린다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  f.links.save({ teamId: "T1", slackUserId: "U2", subject: "wtid-2", accessToken: "synthetic-access-2", refreshToken: "synthetic-refresh-2",
    expiresAt: Date.now() + 600_000, scope: "openid whatap:read whatap:write" });
  const chip = await opmAnswered(f);
  for (const id of [chip.apply, chip.cancel]) await f.action(id, undefined, "T1", { message: chip.message, user: "U2" });
  assert.equal(f.fetches.length, 0, "남이 받은 확인 토큰을 내 와탭 토큰에 실어 보내지 않는다");
  assert.equal(f.updates.length, 0, "버튼은 그대로 둔다 — 받은 사람이 눌러야 한다");
  assert.equal(f.publicPosts.length, 0);
  assert.deepEqual(f.privatePosts.map((p) => p.user), ["U2", "U2"]);
  assert.match(f.privatePosts[0].text, /본인/);
});

test("봇이 기억하지 못하는 조치안 버튼(봇 재시작 등)은 아무것도 부르지 않고 거둔 뒤 다시 물어보라고 한다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const chip = await opmAnswered(f);
  const restarted = await fixture(t); linkU1(restarted);
  await restarted.action(chip.apply, undefined, "T1", { message: chip.message });
  assert.equal(restarted.fetches.length, 0);
  assert.equal(restarted.updates.length, 1);
  assert.equal(opmButtons(restarted.updates[0].blocks).length, 0, "눌러도 소용없는 버튼은 거둔다");
  assert.match(JSON.stringify(restarted.updates[0].blocks), /더 쓸 수 없/);
  assert.equal(restarted.publicPosts.length, 0);
  assert.equal(restarted.privatePosts.length, 1);
  assert.match(restarted.privatePosts[0].text, /다시 물어봐/);
});

test("결재가 필요한 조치는 결재 대기와 [상태 확인]을 남기고, 확인하면 지금 상태로 바꾼다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const chip = await opmAnswered(f);
  f.replyWith(() => Response.json({ proposal: proposal("pending_approval", { approvalId: 42 }), replayed: false }));
  await f.action(chip.apply, undefined, "T1", { message: chip.message });
  const waiting = f.updates.at(-1).blocks;
  assert.match(JSON.stringify(waiting), /결재 대기/);
  const [check, ...others] = opmButtons(waiting);
  assert.ok(check, "결재 대기 자리에 [상태 확인] 버튼이 있다");
  assert.match(check.action_id, /^opm_action:check:/);
  assert.equal(others.length, 0, "[조치 실행]은 다시 나오지 않는다");
  assert.match(f.publicPosts.at(-1).text, /결재/);
  assert.match(f.publicPosts.at(-1).text, /42/, "어느 결재인지 알려 준다");

  f.replyWith(() => Response.json({ proposal: proposal("executed", { approvalId: 42, result: "done" }) }));
  await f.action(check.action_id, undefined, "T1", { message: { ...chip.message, blocks: waiting } });
  assert.equal(f.fetches.at(-1)!.url, "https://issuer.invalid/argus/v1/opm/actions/check");
  assert.equal(JSON.parse(String(f.fetches.at(-1)!.init.body)).confirmToken, OPM_TOKEN);
  const done = f.updates.at(-1).blocks;
  assert.match(JSON.stringify(done), /실행함/);
  assert.doesNotMatch(JSON.stringify(done), /결재 대기/, "지난 상태 줄은 지금 상태로 바뀐다");
  assert.equal(opmButtons(done).length, 0);
  assert.match(f.publicPosts.at(-1).text, /실행했어요/);
});

test("[취소]는 실행 전 조치안만 거두고, 실행된 건 없다고 말한다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const chip = await opmAnswered(f);
  f.replyWith(() => Response.json({ cancelled: true, proposal: proposal("cancelled") }));
  await f.action(chip.cancel, undefined, "T1", { message: chip.message });
  assert.equal(f.fetches[0].url, "https://issuer.invalid/argus/v1/opm/actions/cancel");
  assert.match(JSON.stringify(f.updates.at(-1).blocks), /취소함/);
  assert.equal(opmButtons(f.updates.at(-1).blocks).length, 0);
  assert.match(f.publicPosts[0].text, /실행된 건 없어요/);
});

// argus#1066 handler.go 의 오류 code 표. restore = 버튼을 되돌려 다시 누를 수 있게, retire = 다시 눌러도 소용없어 거둔다.
const opmErrorCases: [string, number, Record<string, unknown>, "restore" | "retire", RegExp][] = [
  ["확인 시간이 지난 조치안", 410, { code: "token_expired", error: "Gone", proposal: proposal("expired") }, "retire", /확인 시간이 지나/],
  ["argus 가 모르는 확인 토큰", 404, { code: "token_not_found", error: "Not Found" }, "retire", /다시 물어봐/],
  ["지금 볼 수 없는 프로젝트", 403, { code: "project_forbidden", error: "Forbidden" }, "restore", /프로젝트 권한/],
  ["다른 와탭 계정으로 받은 조치안", 403, { code: "token_forbidden", error: "Forbidden" }, "restore", /다른 와탭 계정/],
  ["꺼진 Job 조치", 403, { code: "job_actions_disabled", error: "Forbidden" }, "retire", /Job.*꺼져 있어/],
  ["확인한 뒤 바뀐 Job", 409, { code: "job_changed", error: "Conflict", proposal: proposal("expired") }, "retire", /Job 정의가 바뀌어/],
  ["실행 전에 확인할 수 없는 대상", 422, { code: "action_unverifiable", error: "Unprocessable Entity" }, "retire", /확인할 수 없어/],
  ["꺼진 조치 실행", 503, { code: "apply_disabled", error: "OPM actions are temporarily disabled" }, "restore", /조치 실행이 꺼져/],
  ["권한 확인 일시 장애", 503, { code: "verification_unavailable", error: "Service Unavailable" }, "restore", /잠시 뒤 다시/],
  ["front 가 argus 의 답을 받지 못함", 504, {}, "restore", /두 번 실행하지 않고/],
];
for (const [name, status, reply, row, textRe] of opmErrorCases) {
  test(`[조치 실행] 오류 — ${name}`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t); linkU1(f);
    const chip = await opmAnswered(f);
    f.replyWith(() => Response.json(reply, { status }));
    await f.action(chip.apply, undefined, "T1", { message: chip.message });
    const last = f.updates.at(-1).blocks;
    if (row === "restore") assert.deepEqual(last, chip.message.blocks, "다시 누를 수 있게 버튼을 되돌린다");
    else {
      assert.equal(opmButtons(last).length, 0, "눌러도 소용없는 버튼은 거둔다");
      assert.match(JSON.stringify(last), /disk_cleanup/, "조치안 설명은 남는다");
    }
    assert.equal(f.publicPosts.length, 1);
    assert.match(f.publicPosts[0].text, textRe);
    assert.doesNotMatch(f.publicPosts[0].text, /issuer\.invalid|https?:\/\//, "내부 주소를 싣지 않는다");
  });
}

test("[조치 실행]이 이미 실행 중인 조치안과 겹치면 지금 상태와 [상태 확인]을 보여 준다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const chip = await opmAnswered(f);
  f.replyWith(() => Response.json({ code: "action_conflict", error: "Conflict", proposal: proposal("executing") }, { status: 409 }));
  await f.action(chip.apply, undefined, "T1", { message: chip.message });
  const last = f.updates.at(-1).blocks;
  assert.match(JSON.stringify(last), /실행 중/);
  assert.deepEqual(opmButtons(last).map((b: any) => b.action_id.split(":")[1]), ["check"]);
  assert.match(f.publicPosts[0].text, /이미/);
});

test("[조치 실행] 응답을 받지 못하면(연결 끊김) 버튼을 되돌리고 다시 눌러도 두 번 실행되지 않는다고 알린다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); linkU1(f);
  const chip = await opmAnswered(f);
  f.replyWith(() => { throw new TypeError("fetch failed"); });
  await f.action(chip.apply, undefined, "T1", { message: chip.message });
  assert.deepEqual(f.updates.at(-1).blocks, chip.message.blocks);
  assert.match(f.publicPosts[0].text, /두 번 실행하지 않고/);
});

test("쓰기 허락이 없는 토큰이면(front 403 insufficient_scope) 버튼을 되돌리고 허락받을 링크를 본인에게만 보낸다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.links.save({ teamId: "T1", slackUserId: "U1", subject: "wtid-1", accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken, expiresAt: Date.now() + 600_000, scope: "openid whatap:read" });
  const chip = await opmAnswered(f);
  f.replyWith(() => new Response(JSON.stringify({ status: 403, error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="whatap:write"' },
  }));
  await f.action(chip.apply, undefined, "T1", { message: chip.message });
  assert.equal(f.fetches.length, 1, "토큰 갱신·재시도 없이 한 번만 부른다");
  assert.deepEqual(f.updates.at(-1).blocks, chip.message.blocks);
  assert.equal(f.publicPosts.length, 0);
  assert.equal(f.privatePosts.length, 1);
  assert.match(f.privatePosts[0].text, /조치/);
  assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
});

test("whoami 를 처리하는 사이 연결이 지워졌으면(logout 등) 만료가 아니라 연결이 없다고 말한다", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const original = f.links.get.bind(f.links);
  let lookups = 0;
  // whoami 가 처음 볼 때만 연결이 있고, 토큰을 확인할 때는 이미 지워진 상태.
  f.links.get = (team: string, user: string) => (++lookups === 1
    ? { teamId: team, slackUserId: user, subject: "wtid-1", email: "user@example.com", accessToken: tokens.accessToken, expiresAt: Date.now() + 600_000 }
    : original(team, user));
  await f.message("whoami");
  assert.deepEqual(repliesOf(f), ["연결된 와탭 계정이 없어요. `login` 을 보내 연결하세요."]);
});

// ── Webhook JSON 알림의 시간대 (ALERT_TIME_ZONE) ─────────────────────────────
// Webhook JSON 본문은 시각을 epoch ms 로 준다. 운영자가 정한 시간대로만 보이고, 없으면 그런 알림은 읽지 않는다(예전과 같다).
const webhookJson = (ts = rootTs(), over: { status?: string; title?: string; level?: string; oid?: string; message?: string } = {}) => ({
  channel_type: "group", channel: "C1", subtype: "bot_message", bot_id: "BFIXTURE", ts,
  attachments: [{ pretext: `[${over.level ?? "Warning"}][Server][test-project][test-target][${over.title ?? "test-rule"}]`,
    text: ["프로젝트 이름 : test-project", "프로젝트 코드 : 42", "서버 이름 : test-target", `이벤트 메시지 : ${over.message ?? "cpu 0.8511"}`,
      `이벤트 상태 : ${over.status ?? "on"}`, "이벤트 시각(ms) : 1795003326611", "해소 시각(ms) : ", `서버 oid : ${over.oid ?? "1234"}`,
      "이벤트 ID : 0123456789abcdef0123456789abcdef"].join("\n") }],
});
test("Webhook JSON alerts are read in the configured ALERT_TIME_ZONE; without one they stay unread; a bad name stops startup", async (t) => {
  const f = await fixture(t, true, true, { env: { ...alertEnv, ALERT_TIME_ZONE: "Asia/Seoul" } });
  await f.incoming(webhookJson());
  assert.equal(f.publicPosts.length, 1);
  assert.match(f.publicPosts[0].text, /2026-11-18 21:02:06 \+0900/);
  const g = await fixture(t, true, true, { env: alertEnv });
  await g.incoming(webhookJson());
  assert.equal(g.publicPosts.length, 0, "no zone, no reading (as before)");
  await assert.rejects(fixture(t, true, true, { env: { ...alertEnv, ALERT_TIME_ZONE: "Asia/Nowhere" } }), /ALERT_TIME_ZONE/);
});

// ── 자동 대응(온콜) ─────────────────────────────────────────────────────────
// 알림 채널에서 누군가 '자동 대응 켜기'를 하면 그 사람이 당번이 된다. 새 알림이 오면 [분석] 버튼을 기다리지 않고 당번의
// 와탭 권한으로 분석하고, 정해 둔 위험도 안의 OPM 조치안 하나를 실행한다. 기본은 꺼짐이고, 꺼져 있으면 지금과 똑같다.
const oncallEnv = { ...alertEnv, ONCALL_AUTO: "1", ONCALL_AUTO_RULES: "test-rule" };

test("ONCALL_AUTO=1 인데 알림 채널이나 와탭 로그인 설정이 없거나 값이 틀리면 봇이 시작하지 않는다", async (t) => {
  await assert.rejects(fixture(t, true, true, { env: { ONCALL_AUTO: "1" } }), /SLACK_ALERT_CHANNEL_ID/);
  await assert.rejects(fixture(t, false, false, { env: { ...alertEnv, ONCALL_AUTO: "1" } }), /와탭 로그인/);
  await assert.rejects(fixture(t, true, true, { env: { ...oncallEnv, ONCALL_AUTO_RISKS: "low" } }), /ONCALL_AUTO_RISKS/);
});

/** 알림 채널(또는 다른 채널)에서 봇을 멘션해 보낸 글. */
const say = (f: Fixture, text: string, where: { channel?: string; user?: string; thread_ts?: string } = {}) =>
  f.mention({ channel: where.channel ?? "C1", ts: `${Math.floor(Date.now() / 1000)}.000009`, user: where.user ?? "U1", text: `<@UBOT> ${text}`,
    ...(where.thread_ts ? { thread_ts: where.thread_ts } : {}) });

test("알림 채널에서 '자동 대응 켜기'를 보낸 사람이 당번이 되고, 채널에 당번·대상 규칙·자동 실행 위험도·에스컬레이션이 남는다", async (t) => {
  const f = await fixture(t, true, true, { env: oncallEnv });
  linkU1(f);
  await say(f, "자동 대응 켜기");
  assert.equal(f.counts().argusCalls, 0, "명령은 Argus 에 묻지 않는다");
  assert.equal(f.oncallOwners().get("T1", "C1"), "U1");
  assert.equal(f.publicPosts.length, 1);
  const post = f.publicPosts[0];
  assert.equal(post.channel, "C1");
  assert.equal(post.thread_ts, undefined, "채널에 남긴다");
  assert.match(post.text, /<@U1>/);
  assert.match(post.text, /test-rule/);
  assert.match(post.text, /normal/);
  assert.match(post.text, /warning/);
  assert.doesNotMatch(post.text, /critical/);
  assert.match(post.text, /10분/);
  assert.equal(f.privatePosts.length, 0);
});

test("와탭 계정이 연결되지 않은 사람의 '자동 대응 켜기'는 켜지 않고 로그인 링크만 본인에게 보낸다", async (t) => {
  const f = await fixture(t, true, true, { env: oncallEnv });
  await say(f, "자동 대응 켜기", { user: "U2" });
  assert.equal(f.oncallOwners().get("T1", "C1"), null);
  assert.equal(f.publicPosts.length, 0);
  assert.equal(f.privatePosts.length, 1);
  assert.equal(f.privatePosts[0].user, "U2");
  assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
  assert.match(f.privatePosts[0].text, /자동 대응/);
  assert.equal(f.counts().argusCalls, 0);
});

test("로그인 서버에 닿지 않아 토큰을 확인하지 못하면 자동 대응을 켜지 않고 본인에게만 알린다", async (t) => {
  const f = await fixture(t, true, true, { env: oncallEnv, captureErrors: true });
  saveLink(f, Date.now() - 1_000);
  f.oauthClient.refresh = async () => { throw new TypeError("fetch failed"); };
  await say(f, "자동 대응 켜기");
  assert.equal(f.oncallOwners().get("T1", "C1"), null);
  assert.equal(f.publicPosts.length, 0);
  assert.deepEqual(f.privatePosts.map((p) => [p.user, /닿지 않아/.test(p.text)]), [["U1", true]]);
});

test("'자동 대응 끄기'는 와탭 계정이 없는 사람도 누구나 할 수 있고(멈춤 스위치), 채널에 끈 사람이 남는다", async (t) => {
  const f = await fixture(t, true, true, { env: oncallEnv });
  linkU1(f);
  await say(f, "자동 대응 켜기");
  await say(f, "자동 대응 끄기", { user: "U2" });
  assert.equal(f.oncallOwners().get("T1", "C1"), null);
  assert.equal(f.publicPosts.length, 2);
  assert.match(f.publicPosts[1].text, /껐어요/);
  assert.match(f.publicPosts[1].text, /<@U2>/);
  await say(f, "자동 대응 끄기", { user: "U2" });
  assert.match(f.publicPosts[2].text, /이미 꺼져/);
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.privatePosts.length, 0);
});

test("'자동 대응 상태'는 지금 당번과 설정을, 꺼져 있으면 꺼져 있다고 채널에 보여 준다", async (t) => {
  const f = await fixture(t, true, true, { env: { ...oncallEnv, ONCALL_ESCALATE_MIN: "15" } });
  await say(f, "자동 대응 상태", { user: "U2" });
  assert.match(f.publicPosts[0].text, /꺼져/);
  linkU1(f);
  await say(f, "자동 대응 켜기");
  await say(f, "자동 대응 상태", { user: "U2" });
  const text = f.publicPosts.at(-1).text;
  assert.match(text, /켜져/);
  assert.match(text, /<@U1>/);
  assert.match(text, /test-rule/);
  assert.match(text, /15분/);
  assert.equal(f.counts().argusCalls, 0);
});

test("알림 채널 밖(다른 채널·DM)의 자동 대응 명령은 아무것도 켜거나 끄지 않고, Argus 에도 묻지 않는다", async (t) => {
  const f = await fixture(t, true, true, { env: oncallEnv });
  linkU1(f);
  await say(f, "자동 대응 켜기", { channel: "C2" });
  await f.message("자동 대응 켜기");
  assert.equal(f.oncallOwners().get("T1", "C1"), null, "다른 곳에서 알림 채널의 당번을 정할 수 없다");
  assert.equal(f.oncallOwners().get("T1", "C2"), null);
  assert.equal(f.counts().argusCalls, 0, "명령 글을 질문으로 보내지 않는다");
  assert.equal(f.publicPosts.length, 1, "DM 에서는 DM 으로만 답한다");
  assert.equal(f.publicPosts[0].channel, undefined);
  assert.equal(f.privatePosts.length, 1, "다른 채널에서는 보낸 사람에게만 알린다");
  assert.equal(f.privatePosts[0].user, "U1");
  for (const reply of [f.publicPosts[0].text, f.privatePosts[0].text]) assert.match(reply, /알림 채널/);
  linkU1(f);
  await say(f, "자동 대응 켜기");
  await say(f, "자동 대응 끄기", { channel: "C2", user: "U2" });
  assert.equal(f.oncallOwners().get("T1", "C1"), "U1", "다른 채널의 끄기도 알림 채널을 끄지 않는다");
});

/** U1 이 당번인 알림 채널. 켜기 때 남은 글·기록은 비운다. */
async function armed(t: TestContext, env: Record<string, string> = oncallEnv, opts: { captureErrors?: boolean } = {}) {
  const f = await fixture(t, true, true, { env, ...opts });
  linkU1(f);
  await say(f, "자동 대응 켜기");
  assert.equal(f.oncallOwners().get("T1", "C1"), "U1");
  f.publicPosts.length = 0; f.privatePosts.length = 0; f.logs.length = 0;
  return f;
}
const analyzeButtons = (f: Fixture) => f.publicPosts.flatMap((p) => [...(p.blocks ?? [])]).filter((b: any) => b.type === "actions")
  .flatMap((b: any) => [...b.elements]).filter((e: any) => e.action_id === "webhook_alert_analyze");

test("당번이 있고 대상 규칙인 새 알림은 [분석] 버튼 대신 당번 권한으로 바로 분석하고, 모든 글을 알림 스레드에 남긴다", async (t) => {
  const f = await armed(t);
  const start = alertMessage();
  await f.incoming(start);
  assert.equal(f.alertCalls.length, 1, "누르지 않아도 분석한다");
  assert.equal(f.alertCalls[0].auth.accessToken, tokens.accessToken, "당번의 와탭 토큰으로");
  assert.equal(f.alertCalls[0].pcode, 42, "알림의 프로젝트로");
  assert.match(f.directCalls[0].text, /^SRE 사건 분석 요청입니다 \(알림 규칙 «test-rule»/, "[분석] 버튼과 같은 사건 글로");
  assert.equal(analyzeButtons(f).length, 0, "[분석] 버튼은 붙이지 않는다");
  assert.match(f.publicPosts[0].text, /자동 대응을 시작해요/);
  assert.match(f.publicPosts[0].text, /<@U1>/);
  assert.match(f.publicPosts[0].text, /2025-01-31 09:00:00 \+0900/, "이벤트 시작 시각도 남긴다");
  assert.ok(f.publicPosts.every((p) => p.channel === "C1" && p.thread_ts === start.ts), "모두 알림 스레드에");
  assert.match(f.updates.at(-1).text, /fixture answer/);
});

test("ONCALL_AUTO 가 꺼져 있으면 저장된 당번과 대상 규칙이 있어도 지금처럼 [분석] 버튼만 붙이고, 명령도 질문으로 간다", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-off-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "user_tokens.sqlite");
  // 켜 두었던 때 남은 당번(봇 재시작 뒤에도 DB 에 남아 있다).
  const before = new OncallOwners(db);
  before.set("T1", "C1", "U1");
  before.close();
  const f = await fixture(t, true, true, { env: { ...alertEnv, ONCALL_AUTO_RULES: "test-rule", SLACK_USER_TOKENS_DB: db } });
  linkU1(f);
  await f.incoming(alertMessage());
  assert.equal(analyzeButtons(f).length, 1, "[분석] 버튼");
  assert.equal(f.counts().argusCalls, 0, "분석하지 않는다");
  assert.equal(f.tokenRequests(), 0, "당번 토큰을 꺼내 보지도 않는다");
  assert.equal(f.fetches.length, 0, "아무것도 실행하지 않는다");
  await say(f, "자동 대응 켜기");
  assert.equal(f.counts().argusCalls, 1, "꺼져 있으면 명령이 아니라 지금처럼 질문이다");
});

test("대상 규칙이 아닌 알림은 당번이 있어도 지금처럼 [분석] 버튼만 붙인다", async (t) => {
  const f = await armed(t, { ...oncallEnv, ONCALL_AUTO_RULES: "disk,cpu" });
  await f.incoming(alertMessage());
  assert.equal(analyzeButtons(f).length, 1);
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.tokenRequests(), 1, "켜기 때 한 번뿐 — 알림에서는 당번 토큰을 꺼내지 않는다");
});

test("당번이 없으면(아무도 켜지 않았으면) 대상 규칙이어도 지금처럼 [분석] 버튼만 붙인다", async (t) => {
  const f = await fixture(t, true, true, { env: oncallEnv });
  linkU1(f);
  await f.incoming(alertMessage());
  assert.equal(analyzeButtons(f).length, 1);
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.tokenRequests(), 0);
});

test("당번의 와탭 로그인을 쓸 수 없으면 스레드에 당번을 불러 알리고, [분석] 버튼을 그대로 붙이고, 로그인 링크는 당번에게만 보낸다", async (t) => {
  const f = await armed(t);
  f.links.delete("T1", "U1");
  const start = alertMessage();
  await f.incoming(start);
  assert.equal(f.counts().argusCalls, 0, "당번 권한 없이 분석하지 않는다");
  const notice = f.publicPosts.find((p) => /<@U1>/.test(p.text));
  assert.ok(notice, "당번을 부른다");
  assert.equal(notice.thread_ts, start.ts);
  assert.match(notice.text, /로그인/);
  assert.match(notice.text, /자동 대응/);
  assert.equal(analyzeButtons(f).length, 1, "사람이 이어받을 [분석] 버튼");
  assert.deepEqual(f.privatePosts.map((p) => [p.user, p.thread_ts]), [["U1", start.ts]]);
  assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
  // 버튼은 지금처럼 누른 사람의 권한으로 분석한다.
  f.links.save({ teamId: "T1", slackUserId: "U2", subject: "wtid-2", accessToken: "synthetic-access-2", refreshToken: "synthetic-refresh-2",
    expiresAt: Date.now() + 600_000, scope: "openid whatap:read whatap:write" });
  const posted = f.publicPosts.find((p) => p.blocks?.some((b: any) => b.type === "actions"));
  await f.action("webhook_alert_analyze", undefined, "T1", { user: "U2", value: start.ts, message: { ts: "1.1", thread_ts: start.ts } });
  assert.ok(posted);
  assert.equal(f.alertCalls.length, 1);
  assert.equal(f.alertCalls[0].auth.accessToken, "synthetic-access-2");
});

test("로그인 서버에 닿지 않아 당번 토큰을 확인하지 못해도 자동 대응 대신 [분석] 버튼을 붙이고 당번을 부른다(링크는 보내지 않는다)", async (t) => {
  const f = await armed(t);
  saveLink(f, Date.now() - 1_000);
  f.oauthClient.refresh = async () => { throw new TypeError("fetch failed"); };
  await f.incoming(alertMessage());
  assert.equal(f.counts().argusCalls, 0);
  assert.match(f.publicPosts[0].text, /<@U1> 와탭 로그인 서버에 닿지 않아/);
  assert.equal(analyzeButtons(f).length, 1);
  assert.equal(f.privatePosts.length, 0);
});

/** 이벤트 메시지에 서버 oid 를 적은 알림(규칙의 메시지에 oid 변수를 넣은 경우). 대상은 프로젝트 42 의 oid 1234. */
const oidAlert = (ts = rootTs()) => {
  const m = alertMessage(ts);
  m.attachments[0].text = m.attachments[0].text.replace("이벤트 메시지 : sample", "이벤트 메시지 : disk 92% (oid 1234)");
  return m;
};
/** 그 서버를 겨냥한 OPM 조치안(기본 위험도 warning). */
const serverChip = (payload: Record<string, unknown> = {}) => opmChip({ pcode: 42, ...payload });

test("자동 대응 답에서 허용한 위험도이고 알림의 서버를 겨냥한 조치안은 당번 권한으로 바로 실행하고, 무엇을 실행했는지와 결과를 스레드에 남긴다", async (t) => {
  const f = await armed(t);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip()] }));
  f.replyWith(() => Response.json({ proposal: proposal("executed", { pcode: 42, result: "deleted 12 files" }), replayed: false }));
  const start = oidAlert();
  await f.incoming(start);
  assert.equal(f.fetches.length, 1, "사람이 누르지 않아도 한 번 실행한다");
  assert.equal(f.fetches[0].url, "https://issuer.invalid/argus/v1/opm/actions/apply", "front 의 argus 경로로만");
  assert.equal((f.fetches[0].init.headers as Record<string, string>).Authorization, `Bearer ${tokens.accessToken}`, "당번의 와탭 토큰으로");
  assert.equal(JSON.parse(String(f.fetches[0].init.body)).confirmToken, OPM_TOKEN);
  assert.equal(opmButtons(f.updates.at(-1).blocks ?? []).length, 0, "자동으로 실행할 조치안은 버튼으로 그리지 않는다");
  const texts = f.publicPosts.map((p) => String(p.text));
  const announced = texts.findIndex((x) => /자동 조치를 실행해요: 디스크 정리: \/app\/logs 의 7일 지난 로그 삭제 \(demo-was-01, 위험도 warning\)/.test(x));
  assert.ok(announced >= 0, "무엇을 어디서 실행하는지 먼저 알린다");
  assert.match(JSON.stringify(f.publicPosts[announced].blocks), /disk_cleanup/, "실행할 함수와 인자도 남긴다");
  const result = texts.findIndex((x) => /demo-was-01에서 실행했어요/.test(x));
  assert.ok(result > announced, "그다음 결과");
  assert.match(texts[result], /deleted 12 files/);
  assert.ok(f.publicPosts.every((p) => p.channel === "C1" && p.thread_ts === start.ts), "모두 알림 스레드에");
  assert.doesNotMatch(JSON.stringify([f.updates, f.publicPosts, f.privatePosts, f.logs]), new RegExp(`${OPM_TOKEN}|${tokens.accessToken}`),
    "확인 토큰·와탭 토큰은 Slack 에도 기록에도 남기지 않는다");
});

const linkU2 = (f: Fixture) => f.links.save({ teamId: "T1", slackUserId: "U2", subject: "wtid-2", accessToken: "synthetic-access-2",
  refreshToken: "synthetic-refresh-2", expiresAt: Date.now() + 600_000, scope: "openid whatap:read whatap:write" });

test("위험도가 높은(critical) 조치안은 자동으로 실행하지 않고 당번만 누를 수 있는 버튼으로 남기며, 확인할 조치안이 있다고 당번을 부른다", async (t) => {
  const f = await armed(t);
  linkU2(f);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip({ risk: "critical" })] }));
  const start = oidAlert();
  await f.incoming(start);
  assert.equal(f.fetches.length, 0, "critical 은 사람 확인 없이 실행하지 않는다");
  const answer = f.updates.at(-1);
  const [apply] = opmButtons(answer.blocks);
  assert.ok(apply, "[조치 실행] 버튼으로 남는다");
  const waiting = f.publicPosts.filter((p) => /^<@U1> .*확인해야 하는 조치안이 1개/.test(p.text));
  assert.equal(waiting.length, 1, "당번을 부른다(답 수정이 아니라 새 글이라 알림이 간다)");
  assert.equal(waiting[0].thread_ts, start.ts);
  const message = { ts: "9.9", thread_ts: start.ts, text: answer.text, blocks: answer.blocks };
  await f.action(apply.action_id, undefined, "T1", { message, user: "U2" });
  assert.equal(f.fetches.length, 0, "당번이 아닌 사람은 누를 수 없다");
  f.replyWith(() => Response.json({ proposal: proposal("executed", { pcode: 42 }), replayed: false }));
  await f.action(apply.action_id, undefined, "T1", { message });
  assert.equal(f.fetches.length, 1, "당번이 누르면 실행한다");
  assert.equal((f.fetches[0].init.headers as Record<string, string>).Authorization, `Bearer ${tokens.accessToken}`);
});

/** 자동 대응 답의 실패 글: 당번을 부르는 새 글(스레드). */
const ownerCalls = (f: Fixture, re: RegExp) => f.publicPosts.filter((p) => /^<@U1> /.test(String(p.text)) && re.test(String(p.text)));
const escalations = (f: Fixture) => f.oncallClock.pending().filter((p) => !p.every);

test("자동 조치 요청의 답을 받지 못하면(연결 끊김) 바로 당번을 부르고, 당번만 누를 수 있는 [조치 실행]으로 지금 상태를 확인하게 한다", async (t) => {
  const f = await armed(t);
  linkU2(f);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip()] }));
  f.replyWith(() => { throw new TypeError("fetch failed"); });
  const start = oidAlert();
  await f.incoming(start);
  assert.equal(f.fetches.length, 1);
  const [failed] = ownerCalls(f, /실행 결과를 받지 못했어요/);
  assert.ok(failed, "당번을 바로 부른다");
  assert.equal(failed.thread_ts, start.ts);
  const [retry] = opmButtons(failed.blocks ?? []);
  assert.ok(retry, "지금 상태를 확인할 버튼");
  assert.equal(escalations(f).length, 0, "이미 불렀으니 에스컬레이션은 걸지 않는다");
  assert.ok(f.logs.some((l) => / root=\S+ owner=U1 step=auto-apply result=no-answer/.test(l)));
  const message = { ts: "9.9", thread_ts: start.ts, text: failed.text, blocks: failed.blocks };
  await f.action(retry.action_id, undefined, "T1", { message, user: "U2" });
  assert.equal(f.fetches.length, 1, "당번만 누를 수 있다");
  f.replyWith(() => Response.json({ proposal: proposal("executed", { pcode: 42 }), replayed: true }));
  await f.action(retry.action_id, undefined, "T1", { message });
  assert.equal(f.fetches.length, 2);
  assert.equal(JSON.parse(String(f.fetches[1].init.body)).confirmToken, OPM_TOKEN, "같은 조치안을 다시 물으면 argus 는 두 번 실행하지 않고 상태를 준다");
});

test("자동 조치 직전에 당번의 와탭 로그인이 끊겼으면 실행하지 않고 당번을 불러 로그인 링크를 본인에게만 보낸다", async (t) => {
  const f = await armed(t);
  // 분석하는 사이 당번이 와탭 연결을 끊었다.
  f.answerWith(() => { f.links.delete("T1", "U1"); return fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip()] }); });
  const start = oidAlert();
  await f.incoming(start);
  assert.equal(f.fetches.length, 0, "토큰 없이 실행하지 않는다");
  const [failed] = ownerCalls(f, /로그인/);
  assert.ok(failed, "당번을 바로 부른다");
  assert.match(failed.text, /자동 조치/);
  assert.equal(failed.thread_ts, start.ts);
  assert.deepEqual(f.privatePosts.map((p) => [p.user, p.thread_ts]), [["U1", start.ts]]);
  assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
  assert.equal(escalations(f).length, 0);
  assert.ok(f.logs.some((l) => / owner=U1 step=auto-apply result=login-required/.test(l)));
});

test("자동 조치가 거절되면(2xx 가 아니면) 오류 문장과 함께 바로 당번을 부르고, 다시 눌러도 소용없는 거절에는 버튼을 두지 않는다", async (t) => {
  const f = await armed(t);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip()] }));
  f.replyWith(() => Response.json({ code: "token_not_found", error: "Not Found" }, { status: 404 }));
  await f.incoming(oidAlert());
  assert.equal(f.fetches.length, 1);
  const [failed] = ownerCalls(f, /다시 물어봐/);
  assert.ok(failed, "describeOpmError 의 문장으로 당번을 부른다");
  assert.equal(opmButtons(failed.blocks ?? []).length, 0, "retire — 버튼 없음");
  assert.equal(escalations(f).length, 0);
  assert.ok(f.logs.some((l) => / owner=U1 step=auto-apply result=rejected http=404/.test(l)));
  assert.ok(!f.logs.some((l) => / step=auto-apply result=ok/.test(l)));
});

test("쓰기 허락이 없는 당번 토큰이면(403 insufficient_scope) 당번을 부르고 허락받을 링크를 본인에게만 보낸다", async (t) => {
  const f = await armed(t);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip()] }));
  f.replyWith(() => new Response(JSON.stringify({ status: 403, error: "Forbidden" }), { status: 403,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="whatap:write"' } }));
  const start = oidAlert();
  await f.incoming(start);
  const [failed] = ownerCalls(f, /허락/);
  assert.ok(failed, "당번을 바로 부른다");
  assert.ok(opmButtons(failed.blocks ?? []).some((b: any) => b.action_id.startsWith("opm_action:apply:")), "허락한 뒤 누를 버튼");
  assert.deepEqual(f.privatePosts.map((p) => p.user), ["U1"]);
  assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
  assert.ok(f.logs.some((l) => / owner=U1 step=auto-apply result=insufficient-scope/.test(l)));
});

/** 자동 대응 답의 조치안 하나를 실행(executed)까지 마친 알림 스레드. */
async function autoApplied(f: Fixture) {
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip()] }));
  f.replyWith(() => Response.json({ proposal: proposal("executed", { pcode: 42 }), replayed: false }));
  const start = oidAlert();
  await f.incoming(start);
  assert.equal(f.fetches.length, 1);
  return start;
}

test("자동 조치 뒤 ONCALL_ESCALATE_MIN 분 안에 해소되지 않으면 알림 스레드에서 당번을 한 번 부른다", async (t) => {
  const f = await armed(t, { ...oncallEnv, ONCALL_ESCALATE_MIN: "15" });
  const start = await autoApplied(f);
  assert.deepEqual(escalations(f).map((p) => [p.ms, p.unref]), [[15 * 60_000, true]], "봇 종료를 막지 않는 타이머 하나");
  const before = f.publicPosts.length;
  await f.oncallClock.advance(15 * 60_000 - 1);
  assert.equal(f.publicPosts.length, before, "아직 부르지 않는다");
  await f.oncallClock.advance(1);
  assert.deepEqual(f.publicPosts.slice(before).map((p) => [p.channel, p.thread_ts, p.text]),
    [["C1", start.ts, "<@U1> 자동 조치 후 15분이 지났는데 아직 해소되지 않았어요. 확인이 필요해요."]]);
  await f.oncallClock.advance(3 * 60 * 60_000);
  assert.equal(f.publicPosts.length, before + 1, "한 번만 부른다");
  assert.ok(f.logs.some((l) => new RegExp(` root=${start.ts} owner=U1 step=escalated`).test(l)));
});

test("자동 조치한 사건이 그 전에 해소되면 에스컬레이션을 멈추고, 해소 글에 지금처럼 걸린 시간과 자동 조치 뒤 걸린 시간을 남긴다", async (t) => {
  const f = await armed(t);
  const start = await autoApplied(f);
  await f.oncallClock.advance(3 * 60_000);
  const before = f.publicPosts.length;
  await f.incoming(alertMessage(laterTs(start.ts, 100), true));
  const [resolved] = f.publicPosts.slice(before);
  assert.equal(resolved.thread_ts, start.ts);
  assert.match(resolved.text, /^RECOVERED: 2025-01-31 09:05:30 \+0900 \(이벤트 시각\) · 시작 2025-01-31 09:00:00 \+0900 · 소요 330초/, "지금의 해소 문장 그대로");
  assert.match(resolved.text, /자동 조치 후 3분 만에 해소/);
  assert.equal(escalations(f).length, 0, "에스컬레이션 타이머를 거둔다");
  await f.oncallClock.advance(60 * 60_000);
  assert.equal(f.publicPosts.length, before + 1, "부르지 않는다");
  assert.ok(f.logs.some((l) => new RegExp(` root=${start.ts} owner=U1 step=resolved`).test(l)));
  assert.equal(f.counts().argusCalls, 1, "해소 글은 분석하지 않는다");
});

test("자동 조치가 결재 대기로 끝나면 결과 문장으로 바로 당번을 부르고, 당번만 누를 수 있는 [상태 확인]을 둔다(에스컬레이션은 걸지 않는다)", async (t) => {
  const f = await armed(t);
  linkU2(f);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip()] }));
  f.replyWith(() => Response.json({ proposal: proposal("pending_approval", { pcode: 42, approvalId: 42 }), replayed: false }));
  const start = oidAlert();
  await f.incoming(start);
  const [waiting] = ownerCalls(f, /결재가 필요해 OPM 결재함에 올렸어요 \(결재 #42\)/);
  assert.ok(waiting, "당번을 부른다");
  assert.equal(waiting.thread_ts, start.ts);
  const [check] = opmButtons(waiting.blocks ?? []);
  assert.match(check?.action_id ?? "", /^opm_action:check:/);
  assert.equal(escalations(f).length, 0);
  assert.ok(f.logs.some((l) => / owner=U1 step=auto-apply result=pending_approval/.test(l)));
  const message = { ts: "9.9", thread_ts: start.ts, text: waiting.text, blocks: waiting.blocks };
  await f.action(check.action_id, undefined, "T1", { message, user: "U2" });
  assert.equal(f.fetches.length, 1, "당번만 누를 수 있다");
  f.replyWith(() => Response.json({ proposal: proposal("executed", { pcode: 42, approvalId: 42 }) }));
  await f.action(check.action_id, undefined, "T1", { message });
  assert.equal(f.fetches.at(-1)!.url, "https://issuer.invalid/argus/v1/opm/actions/check");
});

test("자동 조치가 실패(failed)로 끝나면 결과 문장으로 바로 당번을 부른다", async (t) => {
  const f = await armed(t);
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip()] }));
  f.replyWith(() => Response.json({ proposal: proposal("failed", { pcode: 42, result: "permission denied" }), replayed: false }));
  await f.incoming(oidAlert());
  const [failed] = ownerCalls(f, /실행하지 못했어요/);
  assert.ok(failed, "당번을 부른다");
  assert.match(failed.text, /permission denied/);
  assert.equal(escalations(f).length, 0);
  assert.ok(f.logs.some((l) => / owner=U1 step=auto-apply result=failed/.test(l)));
});

test("알림에 서버 oid 가 없거나 조치안의 oid 가 다르면 자동으로 실행하지 않고 당번만 누를 수 있는 버튼으로 남긴다", async (t) => {
  for (const [name, alert, chip] of [
    ["알림에 oid 없음", alertMessage(), serverChip()],
    ["다른 서버의 조치안", oidAlert(), serverChip({ oid: 999, oname: "other-was" })],
  ] as const) {
    const f = await armed(t);
    f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [chip] }));
    await f.incoming(alert);
    assert.equal(f.counts().argusCalls, 1, name);
    assert.equal(f.fetches.length, 0, `${name}: 실행하지 않는다`);
    assert.ok(opmButtons(f.updates.at(-1).blocks ?? []).length > 0, `${name}: 버튼으로 남긴다`);
    assert.equal(ownerCalls(f, /확인해야 하는 조치안이 1개/).length, 1, `${name}: 당번을 부른다`);
  }
});

test("한 사건에서 자동으로 실행하는 조치안은 하나뿐이고, 같은 확인 토큰은 다른 사건에서도 다시 자동 실행하지 않는다", async (t) => {
  const f = await armed(t);
  const second = serverChip({ confirmToken: "oa_synthetic-second", title: "캐시 비우기" });
  f.answerWith(() => fixtureAnswer({ text: "디스크 사용률이 높아요.", chipActions: [serverChip(), second] }));
  f.replyWith(() => Response.json({ proposal: proposal("executed", { pcode: 42 }), replayed: false }));
  const start = oidAlert();
  await f.incoming(start);
  assert.deepEqual(f.fetches.map((x) => JSON.parse(String(x.init.body)).confirmToken), [OPM_TOKEN], "첫 조치안 하나만");
  assert.equal(opmButtons(f.updates.at(-1).blocks ?? []).filter((b: any) => b.action_id.startsWith("opm_action:apply:")).length, 1, "나머지는 버튼");
  assert.equal(ownerCalls(f, /확인해야 하는 조치안이 1개/).length, 1);
  // 다른 사건(다른 원본 글)의 답이 같은 확인 토큰을 다시 내놓아도 두 번 실행하지 않는다.
  const other = oidAlert(laterTs(start.ts, 30));
  other.attachments[0].text = other.attachments[0].text.replace("archiveId=17", "archiveId=18");
  f.answerWith(() => fixtureAnswer({ text: "또 높아요.", chipActions: [serverChip()] }));
  await f.incoming(other);
  assert.equal(f.counts().argusCalls, 2, "다른 사건이라 분석은 한다");
  assert.equal(f.fetches.length, 1, "같은 확인 토큰은 다시 자동 실행하지 않는다");
});

test("같은 알림이 다시 오거나(Slack 재전송) 같은 사건의 시작 글이 또 와도 자동 대응은 한 번뿐이다", async (t) => {
  const f = await armed(t);
  const start = alertMessage();
  await f.incoming(start);
  await f.incoming(start);
  await f.incoming(alertMessage(laterTs(start.ts, 2)));
  assert.equal(f.counts().argusCalls, 1);
  assert.equal(f.publicPosts.filter((p) => /자동 대응을 시작해요/.test(p.text)).length, 1);
});

test("해소·닫힘(DISABLED) 알림은 분석하지 않고, 자동 조치한 사건이 닫히면 에스컬레이션만 멈춘다(해소 시간은 붙이지 않는다)", async (t) => {
  const f = await armed(t, { ...oncallEnv, ALERT_TIME_ZONE: "Asia/Seoul" });
  f.answerWith(() => fixtureAnswer({ text: "CPU 가 높아요.", chipActions: [serverChip()] }));
  f.replyWith(() => Response.json({ proposal: proposal("executed", { pcode: 42 }), replayed: false }));
  const start = webhookJson();
  await f.incoming(start);
  assert.equal(f.fetches.length, 1, "Webhook JSON 의 서버 oid 로 자동 조치했다");
  assert.equal(escalations(f).length, 1);
  const before = f.publicPosts.length;
  // 규칙을 끄면 같은 사건이 DISABLED 로 닫힌다(Webhook JSON 은 status=cancel).
  await f.incoming(webhookJson(laterTs(start.ts, 40), { status: "cancel", title: "DISABLED: test-rule" }));
  const closed = f.publicPosts.slice(before);
  assert.equal(closed.length, 1);
  assert.match(closed[0].text, /^DISABLED: /);
  assert.equal(closed[0].thread_ts, start.ts);
  assert.doesNotMatch(closed[0].text, /자동 조치 후/, "닫힘은 해소가 아니다");
  assert.equal(f.counts().argusCalls, 1, "닫힘 글은 분석하지 않는다");
  assert.equal(escalations(f).length, 0, "에스컬레이션을 멈춘다");
  assert.ok(f.logs.some((l) => new RegExp(` root=${start.ts} owner=U1 step=closed`).test(l)));
  await f.oncallClock.advance(60 * 60_000);
  assert.ok(!f.publicPosts.some((p) => /확인이 필요해요/.test(p.text)));
});

test("'자동 대응 끄기'(멈춤 스위치) 뒤의 새 알림은 자동 대응하지 않고 [분석] 버튼만 붙인다", async (t) => {
  const f = await armed(t);
  await say(f, "자동 대응 끄기", { user: "U2" });
  f.publicPosts.length = 0;
  await f.incoming(oidAlert());
  assert.equal(analyzeButtons(f).length, 1);
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.fetches.length, 0);
});

const keepAliveTimers = (f: Fixture) => f.oncallClock.pending().filter((p) => p.every);
const expiryNotices = (f: Fixture) => f.publicPosts.filter((p) => /^:lock: <@U1> 와탭 로그인이 만료돼 자동 대응을 멈췄어요/.test(String(p.text)));

test("ONCALL_AUTO 가 꺼져 있으면 저장된 당번이 있어도 토큰 유지(keep-alive) 타이머를 걸지 않고 토큰을 건드리지 않는다", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oncall-keepalive-off-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "user_tokens.sqlite");
  const before = new OncallOwners(db);
  before.set("T1", "C1", "U1");
  before.close();
  const f = await fixture(t, true, true, { env: { ...alertEnv, SLACK_USER_TOKENS_DB: db } });
  linkU1(f);
  assert.equal(keepAliveTimers(f).length, 0, "타이머가 없다");
  await f.oncallClock.advance(24 * 60 * 60_000);
  assert.equal(f.tokenRequests(), 0);
  assert.equal(f.publicPosts.length + f.privatePosts.length, 0);
  assert.ok(!f.logs.some((l) => /step=keepalive/.test(l)));
});

test("자동 대응이 켜져 있으면 ONCALL_KEEPALIVE_MIN 마다 당번 토큰을 갱신해 둔다(봇 종료를 막지 않는 타이머)", async (t) => {
  const f = await armed(t, { ...oncallEnv, ONCALL_KEEPALIVE_MIN: "30" });
  assert.deepEqual(keepAliveTimers(f).map((p) => [p.every, p.unref]), [[30 * 60_000, true]]);
  let refreshes = 0;
  saveLink(f, Date.now() - 1_000); // 접근 토큰(5분)은 이미 끝났다 — 갱신 토큰으로 이어 간다.
  f.oauthClient.refresh = async () => { refreshes++; return tokens; };
  await f.oncallClock.advance(30 * 60_000 - 1);
  assert.equal(refreshes, 0);
  await f.oncallClock.advance(1);
  assert.equal(refreshes, 1, "주기마다 갱신한다(갱신 토큰도 새로 받는다)");
  assert.equal(f.publicPosts.length + f.privatePosts.length, 0, "조용히");
  assert.ok(f.logs.some((l) => /oncall at=\S+ team=T1 channel=C1 root=- owner=U1 step=keepalive result=ok$/.test(l)));
  assert.doesNotMatch(f.logs.join("\n"), /synthetic-(access|refresh)/, "토큰은 기록하지 않는다");
});

test("당번의 와탭 로그인이 만료되면 알림 채널에 한 번만 알리고 링크는 본인에게만 보내며, 당번은 지우지 않는다", async (t) => {
  const f = await armed(t);
  saveLink(f, Date.now() - 1_000);
  f.oauthClient.refresh = expiredRefresh;
  await f.oncallClock.advance(60 * 60_000);
  const [notice] = expiryNotices(f);
  assert.ok(notice, "당번을 부르는 알림");
  assert.equal(notice.channel, "C1");
  assert.equal(notice.thread_ts, undefined, "채널에(알림 스레드가 아니라)");
  assert.match(notice.text, /다시 로그인하면 이어서/);
  assert.deepEqual(f.privatePosts.map((p) => [p.channel, p.user]), [["C1", "U1"]]);
  assert.match(f.privatePosts[0].text, /와탭 로그인 열기/);
  await f.oncallClock.advance(3 * 60 * 60_000);
  assert.equal(expiryNotices(f).length, 1, "주기마다 다시 알리지 않는다");
  assert.equal(f.privatePosts.length, 1);
  assert.equal(f.oncallOwners().get("T1", "C1"), "U1", "당번은 그대로 — 다시 로그인하면 이어 간다");
  assert.equal(f.logs.filter((l) => / owner=U1 step=keepalive result=login-required$/.test(l)).length, 4);
});

test("만료를 알린 뒤 다시 로그인하면 조용히 이어 가고, 그 뒤 또 만료되면 다시 한 번 알린다", async (t) => {
  const f = await armed(t);
  saveLink(f, Date.now() - 1_000);
  f.oauthClient.refresh = expiredRefresh;
  await f.oncallClock.advance(60 * 60_000);
  assert.equal(expiryNotices(f).length, 1);
  linkU1(f); // 당번이 다시 로그인했다.
  await f.oncallClock.advance(60 * 60_000);
  assert.equal(expiryNotices(f).length, 1, "다시 로그인하면 조용히 이어 간다");
  assert.ok(f.logs.at(-1)!.endsWith("owner=U1 step=keepalive result=ok"));
  // 다시 로그인한 뒤의 새 알림은 자동 대응한다.
  await f.incoming(alertMessage());
  assert.equal(f.counts().argusCalls, 1);
  saveLink(f, Date.now() - 1_000);
  await f.oncallClock.advance(60 * 60_000);
  assert.equal(expiryNotices(f).length, 2, "또 멈추면 다시 알린다");
});

test("워크스페이스에서 앱을 지우면 그 워크스페이스의 당번도 지운다(다시 설치해도 예전 당번으로 자동 대응하지 않는다)", async (t) => {
  const f = await armed(t);
  await f.uninstall("T1");
  assert.equal(f.oncallOwners().get("T1", "C1"), null);
  await f.install("T1");
  await f.incoming(alertMessage());
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(analyzeButtons(f).length, 1);
  assert.equal(f.publicPosts.filter((p) => /<@U1>/.test(String(p.text))).length, 0, "예전 당번을 부르지 않는다");
});

test("자동 분석이 실패하면(Argus 오류) 당번을 부르고 사람이 다시 분석할 [분석] 버튼을 붙인다", async (t) => {
  const f = await armed(t, oncallEnv, { captureErrors: true });
  f.answerWith(() => { throw new Error("argus down"); });
  const start = alertMessage();
  await f.incoming(start);
  assert.equal(f.counts().argusCalls, 1);
  const [failed] = ownerCalls(f, /자동 분석을 끝내지 못했어요/);
  assert.ok(failed, "당번을 부른다");
  assert.equal(failed.thread_ts, start.ts);
  assert.equal(analyzeButtons(f).length, 1, "사람이 다시 분석할 버튼");
  assert.ok(f.logs.some((l) => / owner=U1 step=answered result=failed/.test(l)));
  assert.equal(f.fetches.length, 0);
});

test("자동 대응이 켜져 있어도 허용하지 않은 발신자나 다른 채널의 알림 모양 글로는 아무것도 하지 않는다", async (t) => {
  const f = await armed(t);
  await f.incoming({ ...oidAlert(), bot_id: "BOTHER" });
  await f.incoming({ ...oidAlert(laterTs(rootTs(), 1)), channel: "C2" });
  assert.equal(f.counts().argusCalls, 0);
  assert.equal(f.publicPosts.length + f.privatePosts.length, 0);
  assert.equal(f.tokenRequests(), 1, "켜기 때 한 번뿐 — 당번 토큰을 꺼내지 않는다");
  assert.equal(f.fetches.length, 0);
});
