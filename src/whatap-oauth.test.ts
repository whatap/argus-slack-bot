// src/whatap-oauth.test.ts
//
// 와탭 로그인(OAuth) 연결 흐름 테스트. 가짜 인가 서버와 가짜 argus 를 실제 HTTP 로
// 띄우고, 봇의 /oauth/start → authorize → /oauth/callback → 토큰 저장 → argus
// /v1/agent Bearer 호출까지 한 번에 지나간다.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { ArgusHttpError, askWhatapExpertDirect } from "./argus-direct.js";
import {
  PendingLogins,
  createOAuthHttpHandler,
  loginStartUrl,
} from "./oauth-http.js";
import { WhatapLinkStore } from "./whatap-links.js";
import {
  LoginRequiredError,
  OAuthError,
  WhatapOAuthClient,
  WhatapTokenManager,
} from "./whatap-oauth.js";

const CLIENT_ID = "argus-slack-bot-test";
const CLIENT_SECRET = "test-client-secret";
const SCOPE = "openid profile email whatap:read";

// ── 공통 helper ─────────────────────────────────────────────────

async function listen(
  handler?: http.RequestListener,
): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function b64url(v: string | Buffer): string {
  return Buffer.from(v).toString("base64url");
}

function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64url(JSON.stringify(claims))}.c2ln`;
}

/** 리다이렉트를 따라가지 않는 GET — Location 을 직접 확인한다. */
function httpGet(
  url: string,
): Promise<{ status: number; location?: string; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      })
      .on("error", reject);
  });
}

// ── 가짜 와탭 로그인 서버 (front 가 대리하는 whatap.server.oauth 흉내) ──────

interface TokenRequest {
  basic: string;
  form: Record<string, string>;
}

async function startFakeAuthServer() {
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const validRefresh = new Set<string>();
  const validAccess = new Set<string>();
  const tokenRequests: TokenRequest[] = [];
  const authorizeRequests: URLSearchParams[] = [];
  const revoked: string[] = [];
  const behavior = { denyConsent: false, rejectCode: false };
  let seq = 0;
  let base = "";

  const issue = () => {
    seq += 1;
    const accessToken = `at-${seq}`;
    const refreshToken = `rt-${seq}`;
    validAccess.add(accessToken);
    validRefresh.add(refreshToken);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 300,
      scope: SCOPE,
      id_token: fakeJwt({
        iss: base,
        aud: CLIENT_ID,
        sub: "whatap-user-1",
        email: "dev@example.com",
      }),
    };
  };

  const srv = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth2/authorize`,
        token_endpoint: `${base}/oauth2/token`,
        revocation_endpoint: `${base}/oauth2/revoke`,
      });
    }
    if (req.method === "GET" && url.pathname === "/oauth2/authorize") {
      // 이미 로그인한 사용자가 동의했다고 보고 곧장 code 를 돌려준다.
      const q = url.searchParams;
      authorizeRequests.push(q);
      seq += 1;
      const code = `code-${seq}`;
      codes.set(code, {
        challenge: q.get("code_challenge") ?? "",
        redirectUri: q.get("redirect_uri") ?? "",
      });
      const back = new URL(q.get("redirect_uri") ?? "");
      if (behavior.denyConsent) {
        back.searchParams.set("error", "access_denied");
      } else {
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/oauth2/token") {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      const basic = req.headers.authorization ?? "";
      tokenRequests.push({ basic, form });
      const expected =
        "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
      if (basic !== expected) return json(401, { error: "invalid_client" });
      if (form.grant_type === "authorization_code") {
        const entry = codes.get(form.code);
        codes.delete(form.code);
        const challenge = createHash("sha256")
          .update(form.code_verifier ?? "")
          .digest("base64url");
        if (
          behavior.rejectCode ||
          !entry ||
          entry.redirectUri !== form.redirect_uri ||
          entry.challenge !== challenge
        ) {
          return json(400, { error: "invalid_grant" });
        }
        return json(200, issue());
      }
      if (form.grant_type === "refresh_token") {
        if (!validRefresh.has(form.refresh_token)) return json(400, { error: "invalid_grant" });
        validRefresh.delete(form.refresh_token); // rotation
        return json(200, issue());
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (req.method === "POST" && url.pathname === "/oauth2/revoke") {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      revoked.push(form.token);
      validRefresh.delete(form.token);
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  base = srv.url;
  return {
    ...srv,
    behavior,
    tokenRequests,
    authorizeRequests,
    revoked,
    validAccess,
    validRefresh,
  };
}

// ── 가짜 argus /v1/agent (JWKS 검증 대신 인가 서버가 발급한 access token 인지 본다) ──

async function startFakeArgus(isValidToken: (token: string) => boolean) {
  const requests: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const srv = await listen(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/agent") {
      res.writeHead(404);
      return res.end();
    }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    requests.push({ headers: req.headers, body });
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!isValidToken(token)) {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("conversation_start", { type: "conversation_start", conversationId: "conv-1" });
    send("content_block_start", {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "whatap_list_projects" },
    });
    send("content_block_delta", {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "볼 수 있는 프로젝트는 2개예요." },
    });
    send("message_stop", { type: "message_stop", conversationId: "conv-1" });
    res.end();
  });
  return { ...srv, requests };
}

// ── 봇 쪽 구성 ──────────────────────────────────────────────────

async function startBot(issuer: string, opts: { now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "whatap-oauth-test-"));
  const dbPath = join(dir, "tokens.sqlite");
  const store = new WhatapLinkStore(dbPath, "test-encryption-secret");
  const bot = await listen();
  const client = new WhatapOAuthClient({
    issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: `${bot.url}/oauth/callback`,
    scope: SCOPE,
  });
  const pending = new PendingLogins({ isWorkspaceActive: () => true, now: opts.now });
  bot.server.on("request", createOAuthHttpHandler({ client, store, pending }));
  const manager = new WhatapTokenManager(store, client);
  return {
    ...bot,
    dbPath,
    store,
    client,
    pending,
    manager,
    cleanup: async () => {
      await bot.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Slack 의 `login` 링크를 브라우저가 따라가는 과정을 그대로 밟는다. */
async function completeLogin(
  bot: Awaited<ReturnType<typeof startBot>>,
  teamId: string,
  slackUserId: string,
) {
  const startUrl = loginStartUrl(
    bot.client.config.redirectUri,
    bot.pending.create(teamId, slackUserId),
  );
  const start = await httpGet(startUrl);
  assert.equal(start.status, 302, `/oauth/start 는 인가 서버로 보내야 한다: ${start.body}`);
  const authorize = await httpGet(start.location ?? "");
  assert.equal(authorize.status, 302);
  const callback = await httpGet(authorize.location ?? "");
  return { startUrl, start, authorize, callback };
}

// ── 테스트 ──────────────────────────────────────────────────────

test("login 링크 → 와탭 로그인 → 콜백 → 암호화 저장 → argus /v1/agent 를 그 사용자 Bearer 로 호출", async () => {
  const as = await startFakeAuthServer();
  const argus = await startFakeArgus((t) => as.validAccess.has(t));
  const bot = await startBot(as.url);
  try {
    const { start, callback } = await completeLogin(bot, "T1", "U1");

    // 1) /oauth/start 는 PKCE(S256) + state 를 실은 authorize 로 보낸다.
    const authUrl = new URL(start.location ?? "");
    assert.equal(`${authUrl.origin}${authUrl.pathname}`, `${as.url}/oauth2/authorize`);
    assert.equal(authUrl.searchParams.get("response_type"), "code");
    assert.equal(authUrl.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(authUrl.searchParams.get("redirect_uri"), `${bot.url}/oauth/callback`);
    assert.equal(authUrl.searchParams.get("scope"), SCOPE);
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok((authUrl.searchParams.get("state") ?? "").length >= 32);
    assert.ok((authUrl.searchParams.get("code_challenge") ?? "").length >= 43);

    // 2) 콜백은 client_secret_basic + code_verifier 로 교환하고 성공 화면을 준다.
    assert.equal(callback.status, 200, callback.body);
    assert.match(callback.body, /연결했어요/);
    assert.equal(callback.headers["cache-control"], "no-store");
    const exchange = as.tokenRequests.find((r) => r.form.grant_type === "authorization_code");
    assert.ok(exchange, "code 교환 요청이 있어야 한다");
    assert.equal(exchange.form.redirect_uri, `${bot.url}/oauth/callback`);
    assert.ok(exchange.form.code_verifier);

    // 3) Slack 사용자와 와탭 사용자가 연결되고, 토큰은 DB 에 평문으로 남지 않는다.
    const link = bot.store.get("T1", "U1");
    assert.ok(link);
    assert.equal(link.subject, "whatap-user-1");
    assert.equal(link.email, "dev@example.com");
    assert.equal(link.accessToken, "at-2");
    assert.equal(link.refreshToken, "rt-2");
    const raw = JSON.stringify(
      new Database(bot.dbPath, { readonly: true }).prepare("SELECT * FROM whatap_oauth_links").all(),
    );
    assert.ok(!raw.includes("at-2") && !raw.includes("rt-2"), "토큰은 암호화돼야 한다");
    assert.ok(!raw.includes("dev@example.com"), "이메일도 암호화돼야 한다");

    // 4) 질문은 그 사용자 access token 으로 argus /v1/agent 에 간다 (cookie·X-Argus-Token 없음).
    const token = await bot.manager.accessToken("T1", "U1");
    const steps: string[] = [];
    const answer = await askWhatapExpertDirect(
      { url: argus.url, apiToken: "", accessToken: token },
      { query: "내 프로젝트 보여줘", pcode: 38 },
      (p) => {
        if (p.subTool) steps.push(p.subTool);
      },
    );
    assert.equal(answer.text, "볼 수 있는 프로젝트는 2개예요.");
    assert.equal(answer.conversationId, "conv-1");
    assert.deepEqual(steps, ["whatap_list_projects"]);
    assert.equal(argus.requests.length, 1);
    const sent = argus.requests[0];
    assert.equal(sent.headers.authorization, "Bearer at-2");
    assert.equal(sent.headers.cookie, undefined);
    assert.equal(sent.headers["x-argus-token"], undefined);
    assert.deepEqual(sent.body, {
      query: "내 프로젝트 보여줘",
      pcode: 38,
      context: { source: "slack-bot" },
    });
  } finally {
    await bot.cleanup();
    await argus.close();
    await as.close();
  }
});

test("만료가 가까우면 refresh 로 새 토큰을 받고, 회전된 refresh token 으로 바꿔 저장한다", async () => {
  const as = await startFakeAuthServer();
  const bot = await startBot(as.url);
  try {
    await completeLogin(bot, "T1", "U1");
    // 300초 토큰에서 200초가 지난 시점 = 남은 100초 < 기본 여유 150초.
    const later = new WhatapTokenManager(bot.store, bot.client, {
      now: () => Date.now() + 200_000,
    });
    const token = await later.accessToken("T1", "U1");
    assert.equal(token, "at-3");
    const refresh = as.tokenRequests.filter((r) => r.form.grant_type === "refresh_token");
    assert.equal(refresh.length, 1);
    assert.equal(refresh[0].form.refresh_token, "rt-2");
    assert.equal(
      refresh[0].basic,
      "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    );
    const link = bot.store.get("T1", "U1");
    assert.equal(link?.accessToken, "at-3");
    assert.equal(link?.refreshToken, "rt-3", "회전된 refresh token 을 저장해야 한다");
    assert.equal(link?.subject, "whatap-user-1", "갱신해도 연결된 계정은 그대로다");

    // 아직 충분히 남았으면 갱신하지 않는다.
    assert.equal(await bot.manager.accessToken("T1", "U1"), "at-3");
    assert.equal(as.tokenRequests.filter((r) => r.form.grant_type === "refresh_token").length, 1);
  } finally {
    await bot.cleanup();
    await as.close();
  }
});

test("같은 사용자의 동시 요청은 refresh 를 한 번만 한다 (회전된 refresh token 경합 방지)", async () => {
  const as = await startFakeAuthServer();
  const bot = await startBot(as.url);
  try {
    await completeLogin(bot, "T1", "U1");
    const later = new WhatapTokenManager(bot.store, bot.client, {
      now: () => Date.now() + 200_000,
    });
    const tokens = await Promise.all([
      later.accessToken("T1", "U1"),
      later.accessToken("T1", "U1"),
      later.accessToken("T1", "U1"),
    ]);
    assert.deepEqual(tokens, ["at-3", "at-3", "at-3"]);
    assert.equal(as.tokenRequests.filter((r) => r.form.grant_type === "refresh_token").length, 1);
  } finally {
    await bot.cleanup();
    await as.close();
  }
});

test("refresh 가 invalid_grant 로 거절되면 연결을 지우고 다시 로그인하라고 알린다", async () => {
  const as = await startFakeAuthServer();
  const bot = await startBot(as.url);
  try {
    await completeLogin(bot, "T1", "U1");
    as.validRefresh.delete("rt-2"); // 사용자가 front 연결된 앱 화면에서 연결을 끊은 경우
    const later = new WhatapTokenManager(bot.store, bot.client, {
      now: () => Date.now() + 200_000,
    });
    await assert.rejects(later.accessToken("T1", "U1"), LoginRequiredError);
    assert.equal(bot.store.get("T1", "U1"), null);
    await assert.rejects(later.accessToken("T1", "U1"), LoginRequiredError);
  } finally {
    await bot.cleanup();
    await as.close();
  }
});

test("로그인 서버에 닿지 않는 일시 오류면 연결을 지우지 않는다", async () => {
  const as = await startFakeAuthServer();
  const bot = await startBot(as.url);
  try {
    await completeLogin(bot, "T1", "U1");
    await as.close();
    const later = new WhatapTokenManager(bot.store, bot.client, {
      now: () => Date.now() + 200_000,
    });
    await assert.rejects(later.accessToken("T1", "U1"), (err: unknown) => {
      assert.ok(!(err instanceof LoginRequiredError), "일시 오류는 재로그인 사유가 아니다");
      return true;
    });
    assert.equal(bot.store.get("T1", "U1")?.refreshToken, "rt-2");
  } finally {
    await bot.cleanup();
  }
});

test("갱신하는 동안 사용자가 다시 로그인했으면 새 연결을 덮어쓰거나 지우지 않는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whatap-oauth-test-"));
  const store = new WhatapLinkStore(join(dir, "t.sqlite"), "s");
  const old = {
    teamId: "T1",
    slackUserId: "U1",
    subject: "old-user",
    accessToken: "at-old",
    refreshToken: "rt-old",
    expiresAt: 0,
  };
  const relinked = { ...old, subject: "new-user", accessToken: "at-new", refreshToken: "rt-new", expiresAt: Date.now() + 3_600_000 };
  try {
    // refresh 도중 콜백이 끝나 새 연결이 저장된 상황을 만든다.
    const outcomes: Array<() => Promise<unknown>> = [
      async () => {
        store.save(relinked);
        throw new OAuthError("whatap oauth token request failed (400 invalid_grant)", 400, "invalid_grant");
      },
      async () => {
        store.save(relinked);
        return { accessToken: "at-refreshed", refreshToken: "rt-refreshed", expiresAt: Date.now() + 300_000 };
      },
    ];
    for (const outcome of outcomes) {
      store.save(old);
      const client = { refresh: outcome } as unknown as WhatapOAuthClient;
      const manager = new WhatapTokenManager(store, client);
      assert.equal(await manager.accessToken("T1", "U1"), "at-new");
      const link = store.get("T1", "U1");
      assert.equal(link?.subject, "new-user");
      assert.equal(link?.refreshToken, "rt-new");
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("argus 가 401 이면 토큰을 한 번 갱신해 다시 묻는다", async () => {
  const as = await startFakeAuthServer();
  const argus = await startFakeArgus((t) => as.validAccess.has(t));
  const bot = await startBot(as.url);
  try {
    await completeLogin(bot, "T1", "U1");
    as.validAccess.delete("at-2"); // 만료 전에 회수된 access token
    const ask = (token: string) =>
      askWhatapExpertDirect({ url: argus.url, apiToken: "", accessToken: token }, { query: "q" }, () => {});
    const answer = await bot.manager.withAccessToken("T1", "U1", ask);
    assert.equal(answer.text, "볼 수 있는 프로젝트는 2개예요.");
    assert.deepEqual(
      argus.requests.map((r) => r.headers.authorization),
      ["Bearer at-2", "Bearer at-3"],
    );

    // 갱신한 토큰도 거절되면(예: argus 의 audience 설정 오류) 더 돌지 않고 그대로 실패한다.
    const rejecting = await startFakeArgus(() => false);
    try {
      const askRejecting = (token: string) =>
        askWhatapExpertDirect({ url: rejecting.url, apiToken: "", accessToken: token }, { query: "q" }, () => {});
      await assert.rejects(bot.manager.withAccessToken("T1", "U1", askRejecting), (err: unknown) => {
        assert.ok(err instanceof ArgusHttpError);
        assert.equal(err.status, 401);
        return true;
      });
      assert.equal(rejecting.requests.length, 2);
    } finally {
      await rejecting.close();
    }
    assert.equal(as.tokenRequests.filter((r) => r.form.grant_type === "refresh_token").length, 2);
  } finally {
    await bot.cleanup();
    await argus.close();
    await as.close();
  }
});

test("콜백 state 와 login 링크는 한 번만 쓴다", async () => {
  const as = await startFakeAuthServer();
  const bot = await startBot(as.url);
  try {
    const { startUrl, authorize } = await completeLogin(bot, "T1", "U1");
    const exchanges = () => as.tokenRequests.filter((r) => r.form.grant_type === "authorization_code").length;
    assert.equal(exchanges(), 1);

    // 같은 콜백 URL 을 다시 열어도 교환하지 않는다.
    const replay = await httpGet(authorize.location ?? "");
    assert.equal(replay.status, 400);
    assert.match(replay.body, /이미 사용/);
    assert.equal(exchanges(), 1);

    // 연결이 끝난 login 링크는 더 쓸 수 없다.
    const reused = await httpGet(startUrl);
    assert.equal(reused.status, 400);
    assert.match(reused.body, /만료/);
    assert.equal(as.authorizeRequests.length, 1);
  } finally {
    await bot.cleanup();
    await as.close();
  }
});

test("동의를 거부하거나 code 교환이 실패하면 연결하지 않고, 같은 링크로 다시 시도할 수 있다", async () => {
  const as = await startFakeAuthServer();
  const bot = await startBot(as.url);
  try {
    as.behavior.denyConsent = true;
    const denied = await completeLogin(bot, "T1", "U1");
    assert.equal(denied.callback.status, 400);
    assert.match(denied.callback.body, /연결하지 않았어요/);
    assert.equal(bot.store.get("T1", "U1"), null);
    assert.equal(as.tokenRequests.length, 0);
    // 실패한 콜백의 state 도 다시 받지 않는다.
    const replayDenied = await httpGet(denied.authorize.location ?? "");
    assert.equal(replayDenied.status, 400);
    assert.match(replayDenied.body, /이미 사용/);

    as.behavior.denyConsent = false;
    as.behavior.rejectCode = true;
    const retryStart = await httpGet(denied.startUrl);
    assert.equal(retryStart.status, 302, "실패한 시도 뒤에도 같은 login 링크는 유효하다");
    const retryAuthorize = await httpGet(retryStart.location ?? "");
    const failed = await httpGet(retryAuthorize.location ?? "");
    assert.equal(failed.status, 502);
    assert.equal(bot.store.get("T1", "U1"), null);

    as.behavior.rejectCode = false;
    const okStart = await httpGet(denied.startUrl);
    const okAuthorize = await httpGet(okStart.location ?? "");
    const ok = await httpGet(okAuthorize.location ?? "");
    assert.equal(ok.status, 200);
    assert.equal(bot.store.get("T1", "U1")?.subject, "whatap-user-1");
    assert.equal(bot.store.get("T2", "U1"), null, "다른 워크스페이스의 같은 user id 와 섞이지 않는다");
  } finally {
    await bot.cleanup();
    await as.close();
  }
});

test("10분이 지난 login 링크는 와탭 로그인으로 보내지 않는다", async () => {
  const as = await startFakeAuthServer();
  let clock = Date.now();
  const bot = await startBot(as.url, { now: () => clock });
  try {
    const startUrl = loginStartUrl(bot.client.config.redirectUri, bot.pending.create("T1", "U1"));
    clock += 10 * 60 * 1000 + 1;
    const expired = await httpGet(startUrl);
    assert.equal(expired.status, 400);
    assert.match(expired.body, /만료/);
    assert.equal(as.authorizeRequests.length, 0);
  } finally {
    await bot.cleanup();
    await as.close();
  }
});

test("logout 은 연결을 지우고 refresh token 을 로그인 서버에서 회수한다", async () => {
  const as = await startFakeAuthServer();
  const bot = await startBot(as.url);
  try {
    await completeLogin(bot, "T1", "U1");
    assert.equal(await bot.manager.unlink("T1", "U1"), true);
    assert.equal(bot.store.get("T1", "U1"), null);
    assert.deepEqual(as.revoked, ["rt-2"]);
    assert.equal(as.tokenRequests.length, 1, "회수는 토큰 엔드포인트가 아니라 revocation 엔드포인트로 간다");
    assert.equal(await bot.manager.unlink("T1", "U1"), false);

    // 로그인 서버가 안 닿아도 봇 쪽 연결은 지운다.
    await completeLogin(bot, "T1", "U2");
    await as.close();
    assert.equal(await bot.manager.unlink("T1", "U2"), true);
    assert.equal(bot.store.get("T1", "U2"), null);
  } finally {
    await bot.cleanup();
    await as.close().catch(() => {});
  }
});
