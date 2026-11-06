// deploy/backup-db.mjs 시험 — 서비스가 쓰는 중(WAL)인 DB 의 일관된 사본과 무결성 확인
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { backupDatabases } from "../backup-db.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "backup-db.mjs");
const NODE_MODULES = join(HERE, "..", "..", "node_modules");

test("WAL 로 열려 있는 DB 를 백업하고, 없는 DB 는 건너뛰고, 같은 경로는 한 번만 뜬다", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "asb-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, "user_tokens.sqlite");
  const live = new Database(src);
  live.pragma("journal_mode = WAL");
  live.exec("create table t (k text primary key, v text)");
  const put = live.prepare("insert into t values (?, ?)");
  for (let i = 0; i < 200; i++) put.run(`k${i}`, `enc:${i}`);

  const out = join(dir, "out");
  const logs = [];
  const results = await backupDatabases(out, [src, join(dir, "missing.sqlite"), src], (m) => logs.push(m));
  live.close();

  assert.deepEqual(results.map((r) => r.status), ["ok", "missing"]);
  const copy = new Database(join(out, "user_tokens.sqlite"), { readonly: true });
  assert.equal(copy.prepare("select count(*) as n from t").get().n, 200);
  copy.close();
  assert.ok(logs.some((m) => m.includes("skip (없음)")));
});

// systemd 처럼 current 심볼릭 링크 경로로 CLI 를 실행한다: <dir>/current -> releases/r1, releases/r1/node_modules -> 저장소 node_modules
function releaseTree(t) {
  const dir = mkdtempSync(join(tmpdir(), "asb-backup-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rel = join(dir, "releases", "r1");
  mkdirSync(join(rel, "deploy"), { recursive: true });
  copyFileSync(SCRIPT, join(rel, "deploy", "backup-db.mjs"));
  assert.ok(existsSync(join(NODE_MODULES, "better-sqlite3")), `${NODE_MODULES} 에 better-sqlite3 가 없어요`);
  symlinkSync(NODE_MODULES, join(rel, "node_modules"));
  symlinkSync(join("releases", "r1"), join(dir, "current"));
  return { dir, cli: join(dir, "current", "deploy", "backup-db.mjs") };
}

function makeDb(path) {
  const db = new Database(path);
  db.exec("create table t (k text)");
  db.prepare("insert into t values (?)").run("synthetic");
  db.close();
}

const runCli = (cli, args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("CLI(current 링크 경로): 있는 DB 를 뜨고 종료 코드 0", (t) => {
  const { dir, cli } = releaseTree(t);
  const src = join(dir, "installations.sqlite");
  makeDb(src);
  const out = join(dir, "out");
  const r = runCli(cli, [out, src]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(out, "installations.sqlite")));
});

test("CLI: 인자가 없으면 종료 코드 2", (t) => {
  const { cli } = releaseTree(t);
  assert.equal(runCli(cli, []).status, 2);
});

test("CLI: 없는 DB 가 있으면 있는 DB 는 다 뜬 뒤 종료 코드 1", (t) => {
  const { dir, cli } = releaseTree(t);
  const src = join(dir, "user_tokens.sqlite");
  makeDb(src);
  const out = join(dir, "out");
  const r = runCli(cli, [out, join(dir, "missing.sqlite"), src]);
  assert.equal(r.status, 1);
  assert.ok(existsSync(join(out, "user_tokens.sqlite")));
  assert.match(r.stderr, /missing\.sqlite/);
});

test("CLI: DB 경로가 모두 비어 있으면 종료 코드 1", (t) => {
  const { dir, cli } = releaseTree(t);
  assert.equal(runCli(cli, [join(dir, "out"), "", ""]).status, 1);
});
