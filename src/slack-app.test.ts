import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import bolt from "@slack/bolt";

import { createSlackApp, loadSlackSettings, slackAppOptions } from "./slack-app.js";
import { createSlackFailureHandler } from "./slack-failure-log.js";

const SIGNING_SECRET = "test-signing-secret-not-a-real-credential";
const HTTP_ENV = {
  SLACK_TRANSPORT: "http",
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test-only",
};

function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return {
    "Content-Type": "application/json",
    "X-Slack-Request-Timestamp": String(timestamp),
    "X-Slack-Signature": "v0=" + createHmac("sha256", SIGNING_SECRET)
      .update(`v0:${timestamp}:${body}`).digest("hex"),
  };
}

async function fakeSlack() {
  const posts: Record<string, unknown>[] = [];
  let resolvePost!: () => void;
  const posted = new Promise<void>((resolve) => { resolvePost = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/auth.test") {
      res.end(JSON.stringify({ ok: true, team_id: "T1", bot_id: "B1", user_id: "UBOT" }));
    } else if (req.url === "/chat.postMessage") {
      posts.push(req.headers["content-type"]?.includes("application/json")
        ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)));
      res.end(JSON.stringify({ ok: true, channel: "D1", ts: "123.456" }));
      resolvePost();
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "unexpected_test_api" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, posts, posted, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

function dmEvent(id = "Ev1") {
  return {
    type: "event_callback", team_id: "T1", api_app_id: "A1", event_id: id,
    event_time: Math.floor(Date.now() / 1000),
    event: { type: "message", channel_type: "im", channel: "D1", user: "U1", text: "help", ts: "123.000" },
  };
}

test("HTTP: signed Slack DM reaches Bolt and replies through Web API without an app token", { timeout: 5000 }, async (t) => {
  const slack = await fakeSlack();
  t.after(() => { slack.server.closeAllConnections(); slack.server.close(); });
  const settings = loadSlackSettings(HTTP_ENV);
  const app = createSlackApp(settings, { clientOptions: { slackApiUrl: slack.url } });
  app.message(async ({ say }) => { await say("help received"); });
  const server = await app.start({ port: 0, host: "127.0.0.1" });
  t.after(() => app.stop());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/events`;
  const body = JSON.stringify(dmEvent());
  const response = await fetch(url, { method: "POST", headers: signedHeaders(body), body });
  assert.equal(response.status, 200);
  await slack.posted;
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.posts[0].channel, "D1");
  assert.equal(slack.posts[0].text, "help received");
});

test("transport settings reject unknown modes and missing HTTP signing/authentication settings", () => {
  assert.throws(() => loadSlackSettings({ ...HTTP_ENV, SLACK_TRANSPORT: "htpt" }), /SLACK_TRANSPORT/);
  assert.throws(() => loadSlackSettings({ ...HTTP_ENV, SLACK_SIGNING_SECRET: "" }), /SLACK_SIGNING_SECRET/);
  assert.throws(() => loadSlackSettings({ ...HTTP_ENV, SLACK_BOT_TOKEN: "" }), /SLACK_BOT_TOKEN/);
  assert.throws(() => loadSlackSettings({ SLACK_BOT_TOKEN: "test" }), /SLACK_APP_TOKEN/);
  const socket = loadSlackSettings({ SLACK_APP_TOKEN: "test-app", SLACK_BOT_TOKEN: "test-bot" });
  assert.equal(socket.transport, "socket");
});

const MULTI_ENV = {
  SLACK_TRANSPORT: "http", SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_CLIENT_ID: "client-test", SLACK_CLIENT_SECRET: "secret-test", SLACK_STATE_SECRET: "state-test",
  SLACK_PUBLIC_URL: "https://bot.example.com", SLACK_TOKENS_ENCRYPTION_KEY: "test-encryption-key",
};

test("multi-workspace HTTP install uses persisted installation store and the minimum scopes", { timeout: 5000 }, async (t) => {
  const settings = loadSlackSettings(MULTI_ENV);
  assert.equal(settings.multiWorkspace, true);
  assert.throws(() => createSlackApp(settings), /installationStore/);
  const app = createSlackApp(settings, {
    installationStore: {
      storeInstallation: async () => {},
      fetchInstallation: async () => { throw new Error("not installed"); },
      deleteInstallation: async () => {},
    },
    customRoutes: [{ path: "/", method: ["GET"], handler: (_req, res) => { res.end("landing"); } }],
  });
  const server = await app.start({ port: 0, host: "127.0.0.1" });
  t.after(() => app.stop());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${origin}/slack/install`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get("location")!);
  assert.equal(target.origin, "https://slack.com");
  assert.equal(target.pathname, "/oauth/v2/authorize");
  assert.equal(target.searchParams.get("client_id"), "client-test");
  assert.equal(target.searchParams.get("redirect_uri"), "https://bot.example.com/slack/oauth_redirect");
  assert.deepEqual(target.searchParams.get("scope")?.split(",").sort(), ["app_mentions:read", "chat:write", "im:history"]);
  assert.ok(target.searchParams.get("state"));
  assert.ok(response.headers.get("set-cookie"));
  assert.equal(await (await fetch(origin)).text(), "landing");
});

test("public HTTP configuration fails closed on partial OAuth, missing encryption, invalid origin and port", () => {
  assert.throws(() => loadSlackSettings({ ...HTTP_ENV, SLACK_CLIENT_ID: "only-id" }), /Slack OAuth/);
  assert.throws(() => loadSlackSettings({ ...MULTI_ENV, SLACK_PUBLIC_URL: "" }), /SLACK_PUBLIC_URL/);
  assert.throws(() => loadSlackSettings({ ...MULTI_ENV, SLACK_TOKENS_ENCRYPTION_KEY: "" }), /SLACK_TOKENS_ENCRYPTION_KEY/);
  for (const value of ["http://bot.example.com", "https://user:pass@bot.example.com", "https://bot.example.com/path", "https://bot.example.com/?q=1", "https://bot.example.com/#x"]) {
    assert.throws(() => loadSlackSettings({ ...MULTI_ENV, SLACK_PUBLIC_URL: value }), /SLACK_PUBLIC_URL/);
  }
  for (const value of ["0", "65536", "-1", "NaN", "3.5"]) {
    assert.throws(() => loadSlackSettings({ ...HTTP_ENV, SLACK_HTTP_PORT: value }), /SLACK_HTTP_PORT/);
  }
  const settings = loadSlackSettings({ ...HTTP_ENV, SLACK_HTTP_PORT: "3902" });
  assert.equal(settings.port, 3902);
  assert.equal(settings.listenHost, "127.0.0.1");
});

test("Socket remains the default, including existing local partial installer configuration", () => {
  const settings = loadSlackSettings({
    SLACK_APP_TOKEN: "test-app", SLACK_BOT_TOKEN: "test-bot",
    SLACK_CLIENT_ID: "old-client", SLACK_CLIENT_SECRET: "old-secret", SLACK_STATE_SECRET: "old-state",
    SLACK_SIGNING_SECRET: "", SLACK_OAUTH_PORT: "3010",
  });
  const options = slackAppOptions(settings);
  assert.equal(settings.multiWorkspace, false);
  assert.equal(settings.port, 3010);
  assert.equal(options.socketMode, true);
  assert.equal(options.appToken, "test-app");
  assert.equal(options.token, "test-bot");
});

test("both transports pass the event body to the custom error handler", () => {
  const socket = slackAppOptions(loadSlackSettings({ SLACK_APP_TOKEN: "test-app", SLACK_BOT_TOKEN: "test-bot" }));
  const http = slackAppOptions(loadSlackSettings(HTTP_ENV));
  assert.equal(socket.extendedErrorHandler, true);
  assert.equal(http.extendedErrorHandler, true);
});

test("HTTP: a failed Slack reply reaches the error handler with its channel, not its text", { timeout: 5000 }, async (t) => {
  const slack = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/auth.test"
      ? { ok: true, team_id: "T1", bot_id: "B1", user_id: "UBOT" }
      : { ok: false, error: "channel_not_found" }));
  });
  await new Promise<void>((resolve) => slack.listen(0, "127.0.0.1", resolve));
  t.after(() => { slack.closeAllConnections(); slack.close(); });
  const app = createSlackApp(loadSlackSettings(HTTP_ENV), {
    clientOptions: { slackApiUrl: `http://127.0.0.1:${(slack.address() as AddressInfo).port}/` },
    logLevel: bolt.LogLevel.ERROR,
  });
  const lines: string[] = [];
  let logged!: () => void;
  const done = new Promise<void>((resolve) => { logged = resolve; });
  app.error(createSlackFailureHandler((...args) => { lines.push(args.map(String).join(" ")); logged(); }));
  app.message(async ({ say }) => { await say("reply"); });
  const server = await app.start({ port: 0, host: "127.0.0.1" });
  t.after(() => app.stop());
  const event = dmEvent();
  event.event.text = "private-question-text";
  const body = JSON.stringify(event);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/events`;
  const response = await fetch(url, { method: "POST", headers: signedHeaders(body), body });
  assert.equal(response.status, 200);
  await done;
  assert.equal(lines.length, 1);
  assert.match(lines[0], /team=T1 channel=D1 channel_type=im thread=no kind=event:message code=slack_webapi_platform_error slack_error=channel_not_found/);
  assert.doesNotMatch(lines[0], /private-question-text/);
});

test("HTTP signature guard rejects missing, forged, expired and changed bodies before dispatch", { timeout: 5000 }, async (t) => {
  const slack = await fakeSlack();
  t.after(() => { slack.server.closeAllConnections(); slack.server.close(); });
  const app = createSlackApp(loadSlackSettings(HTTP_ENV), {
    clientOptions: { slackApiUrl: slack.url }, logLevel: bolt.LogLevel.ERROR,
  });
  let dispatched = 0;
  app.message(async () => { dispatched += 1; });
  const server = await app.start({ port: 0, host: "127.0.0.1" });
  t.after(() => app.stop());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/events`;
  const body = JSON.stringify(dmEvent());
  const cases = [
    { headers: { "Content-Type": "application/json" }, body },
    { headers: { ...signedHeaders(body), "X-Slack-Signature": "v0=" + "0".repeat(64) }, body },
    { headers: signedHeaders(body, Math.floor(Date.now() / 1000) - 600), body },
    { headers: signedHeaders(body), body: body.replace("help", "changed") },
  ];
  for (const request of cases) {
    assert.equal((await fetch(url, { method: "POST", ...request })).status, 401);
  }
  assert.equal(dispatched, 0);
  const challenge = JSON.stringify({ type: "url_verification", challenge: "test-challenge" });
  const response = await fetch(url, { method: "POST", headers: signedHeaders(challenge), body: challenge });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { challenge: string }).challenge, "test-challenge");
});

test("HTTP interactivity verifies the URL-encoded payload, ACKs and posts the action reply", { timeout: 5000 }, async (t) => {
  const slack = await fakeSlack();
  t.after(() => { slack.server.closeAllConnections(); slack.server.close(); });
  const app = createSlackApp(loadSlackSettings(HTTP_ENV), { clientOptions: { slackApiUrl: slack.url } });
  app.action("followup_question:0", async ({ ack, say }) => { await ack(); assert.ok(say); await say("follow-up accepted"); });
  const server = await app.start({ port: 0, host: "127.0.0.1" });
  t.after(() => app.stop());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/events`;
  const body = new URLSearchParams({ payload: JSON.stringify({
    type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "D1" },
    container: { type: "message", channel_id: "D1", message_ts: "123.000" },
    actions: [{ type: "button", action_id: "followup_question:0", value: "question", action_ts: "123.100" }],
  }) }).toString();
  const response = await fetch(url, { method: "POST", body,
    headers: { ...signedHeaders(body), "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(response.status, 200);
  await slack.posted;
  assert.equal(slack.posts[0].text, "follow-up accepted");
});

test("HTTP ACK does not wait for a long-running Argus-style message handler", { timeout: 5000 }, async (t) => {
  const slack = await fakeSlack();
  t.after(() => { slack.server.closeAllConnections(); slack.server.close(); });
  const app = createSlackApp(loadSlackSettings(HTTP_ENV), { clientOptions: { slackApiUrl: slack.url } });
  let release!: () => void;
  let entered!: () => void;
  let completed!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const done = new Promise<void>((resolve) => { completed = resolve; });
  let finished = false;
  app.message(async () => { entered(); await gate; finished = true; completed(); });
  const server = await app.start({ port: 0, host: "127.0.0.1" });
  t.after(async () => { release(); await app.stop(); });
  const body = JSON.stringify(dmEvent());
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/events`, {
    method: "POST", body, headers: signedHeaders(body), signal: AbortSignal.timeout(1000),
  });
  await started;
  assert.equal(response.status, 200);
  assert.equal(finished, false);
  release();
  await done;
});
