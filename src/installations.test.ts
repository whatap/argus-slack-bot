import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Installation } from "@slack/bolt";

import { SqliteInstallationStore } from "./installations.js";

test("Slack installation creates missing parent directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-install-test-"));
  try {
    const store = new SqliteInstallationStore(join(dir, "new", "nested", "install.sqlite"), "s");
    assert.equal(store.count(), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function installation(teamId: string): Installation<"v2", false> {
  return {
    enterprise: undefined,
    team: { id: teamId, name: "test workspace" },
    user: { id: "UINSTALLER", token: `user-sensitive-${teamId}`, scopes: [] },
    bot: { id: "B1", userId: `UBOT-${teamId}`, token: `bot-sensitive-${teamId}`, scopes: ["chat:write"] },
    tokenType: "bot", isEnterpriseInstall: false,
  };
}

test("legacy plaintext installations remain readable with a key and deletion stays tenant-scoped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-install-test-"));
  const path = join(dir, "install.sqlite");
  let store = new SqliteInstallationStore(path);
  try {
    await store.storeInstallation(installation("T1"));
    await store.storeInstallation(installation("T2"));
    store.close();
    store = new SqliteInstallationStore(path, "new-key");
    assert.equal((await store.fetchInstallation({ teamId: "T1", enterpriseId: undefined, isEnterpriseInstall: false })).bot?.token, "bot-sensitive-T1");
    assert.equal(store.getBotIdentity("T1")?.botUserId, "UBOT-T1");
    await store.deleteInstallation({ teamId: "T1", enterpriseId: undefined, isEnterpriseInstall: false });
    await store.deleteInstallation({ teamId: "T1", enterpriseId: undefined, isEnterpriseInstall: false });
    assert.equal(store.getBotIdentity("T1"), null);
    assert.equal(store.count(), 1);
    assert.equal((await store.fetchInstallation({ teamId: "T2", enterpriseId: undefined, isEnterpriseInstall: false })).bot?.token, "bot-sensitive-T2");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("encrypted Slack installation refuses a missing or wrong key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-install-test-"));
  const path = join(dir, "install.sqlite");
  const store = new SqliteInstallationStore(path, "right-key");
  try {
    await store.storeInstallation(installation("T1"));
    for (const secret of [undefined, "wrong-key"]) {
      const reader = new SqliteInstallationStore(path, secret);
      try {
        await assert.rejects(reader.fetchInstallation({ teamId: "T1", enterpriseId: undefined, isEnterpriseInstall: false }));
        assert.equal(reader.getBotIdentity("T1")?.botUserId, "UBOT-T1", "identity cleanup lookup needs no credentials");
      } finally { reader.close(); }
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Slack installation encrypts bot_token and the complete raw_json on new writes and reopens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-install-test-"));
  const path = join(dir, "install.sqlite");
  let store = new SqliteInstallationStore(path, "test-secret");
  try {
    await store.storeInstallation(installation("T1"));
    await store.storeInstallation(installation("T2"));
    const db = new Database(path, { readonly: true });
    const rows = db.prepare("SELECT * FROM slack_installations ORDER BY team_id").all() as Array<{ bot_token: string; raw_json: string }>;
    db.close();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.bot_token, /^enc:/);
      assert.match(row.raw_json, /^enc:/);
    }
    assert.ok(!JSON.stringify(rows).includes("sensitive-"), "neither user nor bot credentials may remain plaintext");
    store.close();
    store = new SqliteInstallationStore(path, "test-secret");
    assert.deepEqual(await store.fetchInstallation({ teamId: "T1", enterpriseId: undefined, isEnterpriseInstall: false }), JSON.parse(JSON.stringify(installation("T1"))));
    assert.deepEqual(await store.fetchInstallation({ teamId: "T2", enterpriseId: undefined, isEnterpriseInstall: false }), JSON.parse(JSON.stringify(installation("T2"))));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
