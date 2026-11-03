import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import Database from "better-sqlite3";
import { SqliteInstallationStore } from "./installations.js";
import { WhatapLinkStore } from "./whatap-links.js";
import { ThreadHistory } from "./conversation.js";

async function unusedPort() {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("public multi-workspace HTTP mode refuses the legacy shared-credential path", { timeout: 7000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-http-gate-"));
  const port = await unusedPort();
  try {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: dir, timeout: 2500, encoding: "utf8",
      env: {
        PATH: process.env.PATH, HOME: dir, TMPDIR: dir,
        SLACK_TRANSPORT: "http", SLACK_HTTP_PORT: String(port),
        SLACK_SIGNING_SECRET: "synthetic-signing", SLACK_CLIENT_ID: "synthetic-client",
        SLACK_CLIENT_SECRET: "synthetic-secret", SLACK_STATE_SECRET: "synthetic-state",
        SLACK_PUBLIC_URL: "https://bot.example.com", SLACK_TOKENS_ENCRYPTION_KEY: "synthetic-encryption",
        ANTHROPIC_API_KEY: "synthetic-unused", WHATAP_MCP_PATH: "/unused-test-path",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /공개 HTTP.*와탭 OAuth/);
    assert.doesNotMatch(result.stdout, /listening \(HTTP\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real entrypoint starts HTTP OAuth mode without Socket, Anthropic or MCP credentials", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "argus-http-boot-"));
  const httpPort = await unusedPort();
  const oauthPort = await unusedPort();
  const dbPath = join(dir, "data/user_tokens.sqlite");
  const historyPath = join(dir, "data/thread_history.sqlite");
  const installations = new SqliteInstallationStore(dbPath, "synthetic-encryption");
  const links = new WhatapLinkStore(dbPath, "synthetic-encryption");
  const history = new ThreadHistory(10, 1800000, historyPath);
  for (const teamId of ["T1", "T2", "T3"]) {
    await installations.storeInstallation({
      team: { id: teamId }, enterprise: undefined, isEnterpriseInstall: false, tokenType: "bot",
      user: { id: "UINSTALLER", token: undefined, scopes: undefined },
      bot: { id: "B1", userId: `UBOT${teamId}`, token: `xoxb-synthetic-${teamId}`, scopes: ["chat:write"] },
    });
    links.save({ teamId, slackUserId: "U1", subject: "synthetic-user", accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 300000 });
    history.forWorkspace(teamId).appendTurn("D1:1.0#U1", [{ role: "user", content: "synthetic history" }]);
  }
  installations.close(); links.close(); history.close();
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: dir,
    env: {
      PATH: process.env.PATH, HOME: dir, TMPDIR: dir,
      SLACK_TRANSPORT: "http", SLACK_HTTP_PORT: String(httpPort), SLACK_LISTEN_HOST: "127.0.0.1",
      SLACK_SIGNING_SECRET: "synthetic-signing", SLACK_CLIENT_ID: "synthetic-client",
      SLACK_CLIENT_SECRET: "synthetic-secret", SLACK_STATE_SECRET: "synthetic-state",
      SLACK_PUBLIC_URL: "https://bot.example.com", SLACK_TOKENS_ENCRYPTION_KEY: "synthetic-encryption",
      WHATAP_OAUTH_ISSUER: "http://127.0.0.1:1", WHATAP_OAUTH_CLIENT_ID: "whatap-test",
      WHATAP_OAUTH_CLIENT_SECRET: "synthetic-whatap-secret", WHATAP_OAUTH_PORT: String(oauthPort),
      WHATAP_OAUTH_REDIRECT_URI: "https://bot.example.com/oauth/callback",
      ARGUS_URL: "http://127.0.0.1:1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  t.after(async () => {
    if (!exited) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exit;
      clearTimeout(force);
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`HTTP startup timed out: ${output}`)), 8000);
    const ingest = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("listening (HTTP)")) { clearTimeout(timeout); resolve(); }
    };
    child.stdout.on("data", ingest);
    child.stderr.on("data", ingest);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`startup exit ${code}: ${output}`)); });
  });
  const origin = `http://127.0.0.1:${httpPort}`;
  const root = await fetch(origin);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /WhaTap/);
  const support = await fetch(`${origin}/support`);
  assert.equal(support.status, 200);
  const supportHtml = await support.text();
  assert.ok(supportHtml.includes("mailto:"));
  assert.ok(supportHtml.includes("login"));
  const install = await fetch(`${origin}/slack/install`, { redirect: "manual" });
  assert.equal(install.status, 302);
  assert.equal(new URL(install.headers.get("location")!).pathname, "/oauth/v2/authorize");
  assert.equal((await fetch(`http://127.0.0.1:${oauthPort}/oauth/start?login=missing`)).status, 400);
  assert.doesNotMatch(output, /synthetic-signing|synthetic-secret|synthetic-encryption|synthetic-whatap-secret/);

  const inspect = new Database(dbPath, { readonly: true });
  const inspectHistory = new Database(historyPath, { readonly: true });
  const linkCount = (team: string) => (inspect.prepare("SELECT COUNT(*) AS n FROM whatap_oauth_links WHERE team_id=?").get(team) as { n: number }).n;
  const installCount = (team: string) => (inspect.prepare("SELECT COUNT(*) AS n FROM slack_installations WHERE team_id=?").get(team) as { n: number }).n;
  const historyCount = (team: string) => (inspectHistory.prepare("SELECT COUNT(*) AS n FROM thread_history WHERE thread_key=?").get(`${team}:D1:1.0#U1`) as { n: number }).n;
  async function lifecycle(teamId: string, event: Record<string, unknown>, forged = false) {
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: "event_callback", team_id: teamId, event_id: `${teamId}-${event.type}-${forged}`, event_time: ts, event });
    const signature = createHmac("sha256", "synthetic-signing").update(`v0:${ts}:${body}`).digest("hex");
    return fetch(`${origin}/slack/events`, { method: "POST", body, headers: {
      "Content-Type": "application/json", "X-Slack-Request-Timestamp": String(ts),
      "X-Slack-Signature": `v0=${forged ? "0".repeat(64) : signature}`,
    } });
  }
  async function waitForDeletion(team: string) {
    for (let i = 0; i < 100; i++) {
      if (installCount(team) === 0 && linkCount(team) === 0 && historyCount(team) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`signed lifecycle event did not clean ${team}`);
  }
  try {
    assert.equal((await lifecycle("T1", { type: "app_uninstalled" }, true)).status, 401);
    assert.equal(installCount("T1"), 1);
    assert.equal((await lifecycle("T3", { type: "tokens_revoked", tokens: { oauth: ["UBOTT3"] } })).status, 200);
    assert.equal((await lifecycle("T1", { type: "tokens_revoked", tokens: { bot: ["UBOTT1"] } })).status, 200);
    await waitForDeletion("T1");
    assert.equal((await lifecycle("T2", { type: "app_uninstalled" })).status, 200);
    await waitForDeletion("T2");
    assert.equal(installCount("T3"), 1);
    assert.equal(linkCount("T3"), 1);
    assert.equal(historyCount("T3"), 1);
  } finally { inspect.close(); inspectHistory.close(); }
});
