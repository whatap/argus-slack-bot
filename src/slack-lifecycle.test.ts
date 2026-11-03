import assert from "node:assert/strict";
import { test } from "node:test";
import type { Installation } from "@slack/bolt";
import { SqliteInstallationStore } from "./installations.js";
import { WhatapLinkStore } from "./whatap-links.js";
import { PendingLogins } from "./oauth-http.js";
import { WhatapOAuthClient, WhatapTokenManager } from "./whatap-oauth.js";
import { createSlackLifecycleHandlers } from "./slack-lifecycle.js";

function installation(teamId: string): Installation<"v2", false> {
  return {
    team: { id: teamId, name: "fixture" }, enterprise: undefined,
    user: { id: "UINSTALLER", token: undefined, scopes: undefined }, isEnterpriseInstall: false, tokenType: "bot",
    bot: { id: "B1", userId: `UBOT-${teamId}`, token: `fixture-bot-${teamId}`, scopes: ["chat:write"] },
  };
}
function fixture() {
  const installationStore = new SqliteInstallationStore(":memory:", "s");
  const store = new WhatapLinkStore(":memory:", "s");
  const pending = new PendingLogins({ isWorkspaceActive: (team) => installationStore.getBotIdentity(team) !== null });
  const client = new WhatapOAuthClient({ issuer: "https://as.invalid", clientId: "fixture", clientSecret: "fixture-secret", redirectUri: "https://bot.invalid/oauth/callback", scope: "openid" });
  const revoked: string[] = [];
  client.revoke = async (token) => { revoked.push(token); return true; };
  const manager = new WhatapTokenManager(store, client);
  const deletedTeams: string[] = [];
  const deps = { installationStore, whatap: { store, pending, manager }, onWorkspaceDeleted: (teamId: string) => { deletedTeams.push(teamId); } };
  return { ...deps, store, pending, client, manager, revoked, deletedTeams, close() { store.close(); installationStore.close(); } };
}
function saveLink(store: WhatapLinkStore, teamId: string, slackUserId: string) {
  store.save({ teamId, slackUserId, subject: "fixture", accessToken: `at-${teamId}-${slackUserId}`, refreshToken: `rt-${teamId}-${slackUserId}`, expiresAt: 0 });
}

test("lifecycle rejects a missing or blank envelope team instead of guessing authorization context", async () => {
  const f = fixture();
  try {
    await f.installationStore.storeInstallation(installation("T1"));
    saveLink(f.store, "T1", "U1");
    const handlers = createSlackLifecycleHandlers(f);
    for (const team_id of [undefined, "", " "]) {
      await assert.rejects(handlers.appUninstalled({ body: { team_id }, event: { type: "app_uninstalled" } }), /team/i);
    }
    assert.equal(f.installationStore.count(), 1);
    assert.ok(f.store.get("T1", "U1"));
    assert.deepEqual(f.deletedTeams, []);
  } finally { f.close(); }
});

test("tokens_revoked removes a workspace only for its stored bot USER id, never oauth users, bot ids, or token strings", async () => {
  const f = fixture();
  try {
    for (const teamId of ["T1", "T2"]) {
      await f.installationStore.storeInstallation(installation(teamId));
      saveLink(f.store, teamId, "U1");
    }
    const handlers = createSlackLifecycleHandlers(f);
    for (const tokens of [{ oauth: ["UBOT-T1"] }, { bot: ["B1"] }, { bot: ["fixture-bot-T1"] }, { bot: ["UBOT-T2"] }, {}]) {
      await handlers.tokensRevoked({ body: { team_id: "T1" }, event: { type: "tokens_revoked", tokens } });
      assert.equal(f.installationStore.count(), 2);
      assert.ok(f.store.get("T1", "U1"));
    }
    await handlers.tokensRevoked({ body: { team_id: "T1" }, event: { type: "tokens_revoked", tokens: { bot: ["UBOT-T1"] } } });
    assert.equal(f.installationStore.count(), 1);
    assert.equal(f.store.get("T1", "U1"), null);
    assert.ok(f.store.get("T2", "U1"));
    await handlers.tokensRevoked({ body: { team_id: "T1" }, event: { type: "tokens_revoked", tokens: { bot: ["UBOT-T1"] } } });
    assert.deepEqual(f.deletedTeams, ["T1"]);
    await assert.rejects(handlers.tokensRevoked({ body: {}, event: { type: "tokens_revoked", tokens: { bot: ["UBOT-T2"] } } }), /team/i);
  } finally { f.close(); }
});

test("single-workspace revocation requires a team-bound configured or authorized bot identity", async () => {
  const f = fixture();
  try {
    const event = { type: "tokens_revoked", tokens: { bot: ["UBOT-T1"] } };
    const single = createSlackLifecycleHandlers({ whatap: f.whatap, singleWorkspace: { teamId: "T1", botUserId: "UBOT-T1" } });
    saveLink(f.store, "T1", "U1");
    saveLink(f.store, "T2", "U1");
    await single.tokensRevoked({ body: { team_id: "T2" }, event });
    await single.appUninstalled({ body: { team_id: "T2" }, event: { type: "app_uninstalled" } });
    assert.ok(f.store.get("T2", "U1"));
    await single.tokensRevoked({ body: { team_id: "T1" }, event });
    assert.equal(f.store.get("T1", "U1"), null);

    saveLink(f.store, "T1", "U1");
    const contextual = createSlackLifecycleHandlers({ whatap: f.whatap });
    await contextual.tokensRevoked({ body: { team_id: "T1" }, event });
    await contextual.tokensRevoked({ body: { team_id: "T1" }, event, context: { teamId: "T2", botUserId: "UBOT-T1" } });
    assert.ok(f.store.get("T1", "U1"), "unknown or foreign context must not authorize deletion");
    await contextual.tokensRevoked({ body: { team_id: "T1" }, event, context: { teamId: "T1", botUserId: "UBOT-T1" } });
    assert.equal(f.store.get("T1", "U1"), null);
  } finally { f.close(); }
});

test("events older than the current Slack installation cannot erase a reinstall", async () => {
  const f = fixture();
  try {
    await f.installationStore.storeInstallation(installation("T1"));
    saveLink(f.store, "T1", "U1");
    const handlers = createSlackLifecycleHandlers(f);
    const installed = f.installationStore.getBotIdentity("T1")!;
    const older = Math.floor(installed.installedAt / 1000) - 10;
    await handlers.appUninstalled({ body: { team_id: "T1", event_time: older }, event: { type: "app_uninstalled" } });
    await handlers.tokensRevoked({ body: { team_id: "T1" }, event: { type: "tokens_revoked", event_ts: `${older}.000000`, tokens: { bot: ["UBOT-T1"] } } });
    assert.equal(f.installationStore.count(), 1, "reinstallation must survive delayed events");
    assert.ok(f.store.get("T1", "U1"));
    assert.deepEqual(f.deletedTeams, []);
    // Envelope time has only second precision: do not reject a real uninstall in that second.
    await handlers.appUninstalled({ body: { team_id: "T1", event_time: Math.floor(installed.installedAt / 1000) }, event: { type: "app_uninstalled" } });
    assert.equal(f.installationStore.count(), 0);
  } finally { f.close(); }
});

test("uninstall immediately removes only the target workspace and invalidates pending/taken logins, even when revocation stalls", { timeout: 2000 }, async () => {
  const f = fixture();
  let finishRevoke!: (ok: boolean) => void;
  const blocked = new Promise<boolean>((resolve) => { finishRevoke = resolve; });
  f.client.revoke = (token) => { f.revoked.push(token); return blocked; };
  try {
    for (const team of ["T1", "T2"]) {
      await f.installationStore.storeInstallation(installation(team));
      saveLink(f.store, team, "U1");
      saveLink(f.store, team, "U2");
    }
    const login = f.pending.create("T1", "U1");
    const active = f.pending.begin(login)!;
    const taken = f.pending.take(active.state)!;
    const unused = f.pending.begin(login)!;
    const other = f.pending.create("T2", "U1");
    const otherState = f.pending.begin(other)!;
    const handlers = createSlackLifecycleHandlers(f);
    await handlers.appUninstalled({ body: { team_id: "T1" }, event: { type: "app_uninstalled" } });
    assert.equal(f.store.get("T1", "U1"), null);
    assert.equal(f.store.get("T1", "U2"), null);
    assert.equal(f.store.get("T2", "U1")?.accessToken, "at-T2-U1");
    await assert.rejects(f.installationStore.fetchInstallation({ teamId: "T1", enterpriseId: undefined, isEnterpriseInstall: false }));
    assert.equal(f.installationStore.count(), 1);
    assert.equal(f.pending.begin(login), null);
    assert.equal(f.pending.take(unused.state), null);
    assert.equal(f.pending.isActive(taken), false);
    assert.ok(f.pending.take(otherState.state));
    assert.ok(f.pending.begin(other));
    assert.ok(f.revoked.includes("rt-T1-U1"));
    assert.ok(f.revoked.every((token) => !token.includes("T2")));
    assert.deepEqual(f.deletedTeams, ["T1"]);
    // Slack can retry: a duplicate removes nothing outside this team and throws nothing.
    await handlers.appUninstalled({ body: { team_id: "T1" }, event: { type: "app_uninstalled" } });
    assert.equal(f.installationStore.count(), 1);
    assert.ok(f.store.get("T2", "U2"));
  } finally { finishRevoke(true); f.close(); }
});
