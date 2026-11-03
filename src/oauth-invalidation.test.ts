import assert from "node:assert/strict";
import type http from "node:http";
import { test } from "node:test";
import { PendingLogins, createOAuthHttpHandler } from "./oauth-http.js";
import { createSlackLifecycleHandlers } from "./slack-lifecycle.js";
import { WhatapLinkStore } from "./whatap-links.js";
import { LoginRequiredError, OAuthError, WhatapOAuthClient, WhatapTokenManager, type TokenSet } from "./whatap-oauth.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function clientFixture() {
  const client = new WhatapOAuthClient({
    issuer: "https://issuer.invalid", clientId: "fixture", clientSecret: "fixture-secret",
    redirectUri: "https://bot.invalid/oauth/callback", scope: "openid",
  });
  const revoked: string[] = [];
  client.revoke = async (token) => { revoked.push(token); return true; };
  return { client, revoked };
}

const oldLink = {
  teamId: "T1", slackUserId: "U1", subject: "old", accessToken: "access-old",
  refreshToken: "refresh-old", expiresAt: 0,
};
const refreshed: TokenSet = { accessToken: "access-rotated", refreshToken: "refresh-rotated", expiresAt: 999_999 };

// Exercise the real listener without starting an application or network server.
function callback(handler: http.RequestListener, state: string) {
  return new Promise<{ status: number; body: string }>((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; },
      end(body = "") { resolve({ status, body }); },
    } as unknown as http.ServerResponse;
    handler({ method: "GET", url: `/oauth/callback?state=${state}&code=fixture` } as http.IncomingMessage, res);
  });
}

test("workspace invalidation also removes states whose login was already swept", () => {
  let now = 0;
  const pending = new PendingLogins({ isWorkspaceActive: () => true, now: () => now, ttlMs: 10 });
  const login = pending.create("T1", "U1");
  now = 5;
  const state = pending.begin(login)!.state;
  now = 11;
  pending.create("T2", "U1"); // sweeps expired login; its newer state is still alive
  pending.revokeTeam("T1");
  assert.equal(pending.take(state), null);
});

test("a callback already awaiting exchange cannot save after its login is invalidated", { timeout: 2000 }, async () => {
  const store = new WhatapLinkStore(":memory:", "s");
  const pending = new PendingLogins({ isWorkspaceActive: () => true });
  const { client, revoked } = clientFixture();
  const entered = deferred<void>();
  const exchange = deferred<TokenSet>();
  client.exchangeCode = () => { entered.resolve(); return exchange.promise; };
  const loginId = pending.create("T1", "U1");
  const state = pending.begin(loginId)!.state;
  try {
    const response = callback(createOAuthHttpHandler({ client, pending, store, log: () => {} }), state);
    await entered.promise;
    const manager = new WhatapTokenManager(store, client);
    await createSlackLifecycleHandlers({ whatap: { store, pending, manager } })
      .appUninstalled({ body: { team_id: "T1" }, event: { type: "app_uninstalled" } });
    exchange.resolve(refreshed);
    assert.equal((await response).status, 400, "invalidated callback must not display success");
    assert.equal(store.get("T1", "U1"), null);
    assert.ok(revoked.includes("refresh-rotated"));
    assert.equal(pending.take(state), null);
  } finally { store.close(); }
});

test("a cancelled access-only callback revokes its token using the access_token hint", { timeout: 2000 }, async (t) => {
  const store = new WhatapLinkStore(":memory:", "s");
  const pending = new PendingLogins({ isWorkspaceActive: () => true });
  const { client } = clientFixture();
  client.revoke = WhatapOAuthClient.prototype.revoke.bind(client);
  const exchange = deferred<TokenSet>();
  const entered = deferred<void>();
  const sent = deferred<URLSearchParams>();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requests++;
    if (url.includes(".well-known")) return Response.json({ issuer: "https://issuer.invalid", authorization_endpoint: "https://issuer.invalid/authorize", token_endpoint: "https://issuer.invalid/token", revocation_endpoint: "https://issuer.invalid/revoke" });
    assert.equal(init?.redirect, "error");
    sent.resolve(new URLSearchParams(init?.body as string));
    return new Response("", { status: 200 });
  });
  client.exchangeCode = () => { entered.resolve(); return exchange.promise; };
  const login = pending.create("T1", "U1");
  const state = pending.begin(login)!.state;
  try {
    const response = callback(createOAuthHttpHandler({ client, pending, store, log: () => {} }), state);
    await entered.promise;
    pending.revokeTeam("T1");
    exchange.resolve({ accessToken: "access-only", expiresAt: 99 });
    assert.equal((await response).status, 400);
    assert.ok(requests > 0, "access-only credentials must not be abandoned without a revocation attempt");
    const form = await sent.promise;
    assert.equal(form.get("token"), "access-only");
    assert.equal(form.get("token_type_hint"), "access_token");
  } finally { store.close(); }
});

test("a successful retired refresh preserves the newer login and revokes only the retired credentials", { timeout: 2000 }, async () => {
  const store = new WhatapLinkStore(":memory:", "s");
  const { client, revoked } = clientFixture();
  const entered = deferred<void>();
  const exchange = deferred<TokenSet>();
  client.refresh = () => { entered.resolve(); return exchange.promise; };
  const manager = new WhatapTokenManager(store, client);
  store.save(oldLink);
  try {
    const running = manager.accessToken("T1", "U1");
    await entered.promise;
    const relinked = { ...oldLink, subject: "new-user", accessToken: "new-login", refreshToken: "new-refresh" };
    store.save(relinked);
    exchange.resolve(refreshed);
    assert.equal(await running, "new-login");
    assert.equal(store.get("T1", "U1")?.refreshToken, "new-refresh");
    assert.ok(revoked.includes("refresh-rotated"), "orphaned refresh credentials must be revoked");
    assert.ok(!revoked.includes("new-refresh"));
  } finally { store.close(); }
});

test("relogin remains authoritative even when the provider reused a refresh token", { timeout: 2000 }, async () => {
  const store = new WhatapLinkStore(":memory:", "s");
  try {
    for (const fails of [false, true]) {
      const { client } = clientFixture();
      const entered = deferred<void>();
      const exchange = deferred<TokenSet>();
      client.refresh = () => { entered.resolve(); return exchange.promise; };
      const manager = new WhatapTokenManager(store, client);
      store.save(oldLink);
      const result = manager.accessToken("T1", "U1").then((value) => value, () => "unexpected error");
      await entered.promise;
      store.save({ ...oldLink, accessToken: "new-login", subject: "new-user" });
      if (fails) exchange.reject(new OAuthError("expired", 400, "invalid_grant"));
      else exchange.resolve(refreshed);
      assert.equal(await result, "new-login");
      assert.equal(store.get("T1", "U1")?.subject, "new-user");
    }
  } finally { store.close(); }
});

test("a new login does not join the old login's in-flight refresh", { timeout: 2000 }, async () => {
  const store = new WhatapLinkStore(":memory:", "s");
  const { client } = clientFixture();
  const oldExchange = deferred<TokenSet>();
  const newExchange = deferred<TokenSet>();
  let calls = 0;
  client.refresh = () => ++calls === 1 ? oldExchange.promise : newExchange.promise;
  const manager = new WhatapTokenManager(store, client);
  store.save(oldLink);
  const first = manager.accessToken("T1", "U1").catch(() => "deleted");
  try {
    await manager.unlink("T1", "U1");
    store.save({ ...oldLink, accessToken: "new-login", refreshToken: "new-refresh" });
    const second = manager.accessToken("T1", "U1");
    const joined = manager.accessToken("T1", "U1");
    assert.equal(calls, 2, "single-flight must be scoped to the login, not just team/user");
    newExchange.resolve({ ...refreshed, accessToken: "new-rotated", refreshToken: "new-rotated-refresh" });
    assert.deepEqual(await Promise.all([second, joined]), ["new-rotated", "new-rotated"]);
    oldExchange.resolve(refreshed);
    assert.equal(await first, "new-rotated");
    assert.equal(store.get("T1", "U1")?.accessToken, "new-rotated");
  } finally {
    oldExchange.resolve(refreshed);
    newExchange.resolve(refreshed);
    await first;
    store.close();
  }
});

test("an in-flight refresh cannot resurrect a deleted link and revokes its returned credentials", { timeout: 2000 }, async () => {
  const store = new WhatapLinkStore(":memory:", "s");
  const { client, revoked } = clientFixture();
  const entered = deferred<void>();
  const exchange = deferred<TokenSet>();
  client.refresh = () => { entered.resolve(); return exchange.promise; };
  const manager = new WhatapTokenManager(store, client);
  store.save(oldLink);
  try {
    const running = manager.accessToken("T1", "U1");
    const result = running.then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    await manager.unlink("T1", "U1");
    assert.equal(store.get("T1", "U1"), null);
    exchange.resolve(refreshed);
    const outcome = await result;
    assert.ok("error" in outcome && outcome.error instanceof LoginRequiredError, "deleted authorization must fail closed, not return a refreshed token");
    assert.equal(store.get("T1", "U1"), null);
    assert.ok(revoked.includes("refresh-rotated"));
  } finally { store.close(); }
});
