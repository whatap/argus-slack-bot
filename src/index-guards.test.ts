import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type http from "node:http";
import { test, type TestContext } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { ThreadHistory } from "./conversation.js";
import { SqliteInstallationStore } from "./installations.js";
import { PendingLogins } from "./oauth-http.js";
import { UserTokenStore } from "./user-tokens.js";
import { WhatapLinkStore } from "./whatap-links.js";
import { WhatapOAuthClient, type TokenSet } from "./whatap-oauth.js";

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Handler = (ctx: any) => Promise<void>;
const tokens: TokenSet = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 600_000 };
// Slack reports one installation that can see the event. In the bot's own DM that is usually the bot.
const BOT_AUTHORIZATION = [{ team_id: "T1", user_id: "UBOT", is_bot: true, is_enterprise_install: false }];
const USER_AUTHORIZATION = [{ team_id: "T1", user_id: "U1", is_bot: false, is_enterprise_install: false }];
const channelNotFound = () => Object.assign(new Error("An API error occurred: channel_not_found"), {
  code: "slack_webapi_platform_error", data: { ok: false, error: "channel_not_found" },
});

// Execute the unchanged entrypoint and its actual bound listeners, replacing only
// boot/transport boundaries. No dotenv, sockets, MCP children, or remote APIs.
async function fixture(t: TestContext, oauth = true, multi = true, opts: { captureErrors?: boolean } = {}) {
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
  const fetches: { url: string; init: RequestInit }[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let errorHandler: Handler | undefined;
  let credsLookups = 0;
  let argusCalls = 0;
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
      update: async (_args: any) => ({}),
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
  modules["./direct-route.js"] = { runDirectToArgus: async () => {
    argusCalls++;
    return { text: "fixture answer", hops: 1, toolCallLog: [], newMessages: [{ role: "assistant", content: "fixture answer" }], argusConversationId: "fixture-conv" };
  } };
  modules["./user-tokens.js"] = { ...modules["./user-tokens.js"], UserTokenStore: class extends UserTokenStore {
    constructor(...args: ConstructorParameters<typeof UserTokenStore>) { super(...args); closers.push(() => this.close()); }
    override get(user: string) { credsLookups++; return super.get(user); }
  } };
  modules["./installations.js"] = { SqliteInstallationStore: class extends SqliteInstallationStore {
    constructor(...args: ConstructorParameters<typeof SqliteInstallationStore>) { super(...args); installations = this; closers.push(() => this.close()); }
  } };
  modules["./conversation.js"] = { ThreadHistory: class extends ThreadHistory {
    constructor(...args: ConstructorParameters<typeof ThreadHistory>) { super(...args); history = this; closers.push(() => this.close()); }
  } };
  modules["./whatap-links.js"] = { WhatapLinkStore: class extends WhatapLinkStore {
    constructor(...args: ConstructorParameters<typeof WhatapLinkStore>) { super(...args); links = this; closers.push(() => this.close()); }
  } };
  modules["./oauth-http.js"] = { ...modules["./oauth-http.js"], PendingLogins: class extends PendingLogins {
    constructor(...args: ConstructorParameters<typeof PendingLogins>) { super(...args); pending = this; }
    override create(team: string, user: string) { loginCreates++; return super.create(team, user); }
  } };
  modules["./whatap-oauth.js"] = { ...modules["./whatap-oauth.js"], WhatapOAuthClient: class extends WhatapOAuthClient {
    constructor(...args: ConstructorParameters<typeof WhatapOAuthClient>) { super(...args); oauthClient = this; }
    override async exchangeCode() { return tokens; }
    override async revoke() { return true; }
    override async authorizationUrl(state: string) { return `https://issuer.invalid/authorize?state=${state}`; }
  } };
  const env = {
    SLACK_TRANSPORT: "http", SLACK_SIGNING_SECRET: "synthetic-signing", SLACK_BOT_TOKEN: "synthetic-bot",
    SLACK_TOKENS_ENCRYPTION_KEY: "synthetic-key", SLACK_USER_TOKENS_DB: ":memory:",
    SLACK_INSTALLATIONS_DB: ":memory:", SLACK_THREAD_HISTORY_DB: ":memory:", WHATAP_OAUTH_PORT: "3011",
    ARGUS_URL: "https://argus.invalid", ARGUS_API_TOKEN: "synthetic-common-token",
    WHATAP_API_TOKEN: "synthetic-common-whatap", ARGUS_COOKIE: "JSESSIONID=synthetic-common-cookie",
    ...(multi ? { SLACK_CLIENT_ID: "synthetic-client", SLACK_CLIENT_SECRET: "synthetic-secret", SLACK_STATE_SECRET: "synthetic-state", SLACK_PUBLIC_URL: "https://bot.example.com" } : {}),
    ...(oauth ? { WHATAP_OAUTH_ISSUER: "https://issuer.invalid", WHATAP_OAUTH_CLIENT_ID: "synthetic-client", WHATAP_OAUTH_CLIENT_SECRET: "synthetic-secret", WHATAP_OAUTH_REDIRECT_URI: "https://bot.example.com/oauth/callback" }
      : { ANTHROPIC_API_KEY: "synthetic-unused", WHATAP_MCP_PATH: "/unused" }),
  };
  const sandbox = {
    exports: {}, require: (id: string) => { assert.ok(id in modules, `unmocked import ${id}`); return modules[id]; },
    process: { env, on() {}, exit(code: number) { throw new Error(`unexpected startup exit ${code}`); } },
    console: {
      log() {},
      warn(...args: any[]) { warnings.push(args.map(String).join(" ")); },
      error(...args: any[]) {
        const line = args.map(String).join(" ");
        if (!opts.captureErrors) throw new Error(line);
        errors.push(line);
      },
    },
    fetch: async (url: string, init: RequestInit) => { fetches.push({ url, init }); return Response.json({ succeeded: [], failed: [] }); },
    URL, Date, setTimeout, clearTimeout,
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, sandbox);
  await ready.promise;
  async function install(team = "T1") {
    await installations.storeInstallation({ team: { id: team }, enterprise: undefined, isEnterpriseInstall: false, tokenType: "bot", user: { id: "UINSTALLER", token: undefined, scopes: undefined }, bot: { id: "B1", userId: "UBOT", token: "synthetic-bot", scopes: ["chat:write"] } });
  }
  if (multi) { await install(); await install("T2"); }
  const action = (id: string, ack: () => Promise<void> = async () => {}, team = "T1") => {
    const handler = actions.find((entry) => entry.pattern.test(id))?.handler;
    assert.ok(handler, `actual entrypoint must bind ${id}`);
    return handler({ ack, client, body: { team: { id: team }, user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "1.0" } }, action: { action_id: id, value: "내 프로젝트 보여줘" } });
  };
  const uninstall = (team = "T1", revoked = false) => events.get(revoked ? "tokens_revoked" : "app_uninstalled")!({ body: { team_id: team }, event: revoked ? { type: "tokens_revoked", tokens: { bot: ["UBOT"] } } : { type: "app_uninstalled" } });
  const message = (text: string, where: { channel?: string; authorizations?: unknown[] } = {}) => events.get("message")!({
    body: { type: "event_callback", team_id: "T1", authorizations: where.authorizations ?? BOT_AUTHORIZATION },
    message: { channel_type: "im", channel: where.channel ?? "D1", user: "U1", ts: "1.0", text },
    say: client.chat.postMessage, client,
  });
  const request = (url: string) => new Promise<{ status: number; headers: any; body: string }>((resolve) => {
    let status = 0; let headers: any;
    oauthHandler({ method: "GET", url } as http.IncomingMessage, { headersSent: false,
      writeHead(code: number, values: any) { status = code; headers = values; },
      end(body = "") { resolve({ status, headers, body }); },
    } as unknown as http.ServerResponse);
  });
  return { action, message, uninstall, install, request, client, privatePosts, publicPosts, fetches, pending, links, history, installations, oauthClient,
    warnings, errors, errorHandler: () => errorHandler,
    counts: () => ({ credsLookups, argusCalls, loginCreates, infoCalls }) };
}

for (const op of ["apply", "cancel"]) {
  test(`OAuth rejects historical ${op} buttons before common credential lookup`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    await f.action(`${op}_event_rule:historical-confirm-token`);
    assert.equal(f.counts().credsLookups, 0, "OAuth actions must not consult legacy credentials");
    assert.equal(f.fetches.length, 0, "OAuth actions must not call cookie event-rule APIs");
    assert.equal(f.privatePosts.length, 1);
    assert.equal(f.publicPosts.length, 0);
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
