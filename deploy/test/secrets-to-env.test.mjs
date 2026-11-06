// deploy/secrets-to-env.mjs 시험 — node --test deploy/test/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SECRET_KEYS, secretsToEnv } from "../secrets-to-env.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "secrets-to-env.mjs");
const full = () => Object.fromEntries(SECRET_KEYS.map((k, i) => [k, `v${i}+/=_.~-AZaz09`]));

test("허용 키 5개를 KEY=value 줄로 쓴다", () => {
  const out = secretsToEnv(JSON.stringify(full()));
  assert.equal(out, SECRET_KEYS.map((k, i) => `${k}=v${i}+/=_.~-AZaz09`).join("\n") + "\n");
});

test("없는 키나 빈 값은 키 이름만 밝히고 실패한다", () => {
  const s = full();
  delete s.SLACK_STATE_SECRET;
  s.WHATAP_OAUTH_CLIENT_SECRET = "";
  assert.throws(() => secretsToEnv(JSON.stringify(s)), /SLACK_STATE_SECRET, WHATAP_OAUTH_CLIENT_SECRET/);
});

test("모르는 키는 거부한다 (NODE_OPTIONS 같은 값이 서비스 환경에 섞이지 않게)", () => {
  assert.throws(() => secretsToEnv(JSON.stringify({ ...full(), NODE_OPTIONS: "--require=x" })), /NODE_OPTIONS/);
});

test("따옴표·$·공백·줄바꿈이 든 값은 거부하고 값은 오류에 싣지 않는다", () => {
  for (const bad of ['a"b', "a$b", "a b", "a\nb", "a\\b"]) {
    const s = { ...full(), SLACK_SIGNING_SECRET: bad };
    assert.throws(
      () => secretsToEnv(JSON.stringify(s)),
      (err) => err.message.includes("SLACK_SIGNING_SECRET") && !err.message.includes(bad),
    );
  }
});

test("JSON 이 아니거나 객체가 아니면 실패한다", () => {
  assert.throws(() => secretsToEnv("not-json"), /JSON 이 아니에요/);
  assert.throws(() => secretsToEnv("[1,2]"), /객체가 아니에요/);
});

test("CLI: stdin → stdout, 실패하면 종료 코드 1 이고 값은 stderr 에 없다", () => {
  const ok = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(full()), encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.split("\n").filter(Boolean).length, 5);
  const secret = "zzz-unique-secret-value";
  const bad = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ ...full(), SLACK_CLIENT_SECRET: `${secret} with space` }),
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.ok(!bad.stderr.includes(secret));
});

test("CLI: systemd 처럼 current 심볼릭 링크 경로로 실행해도 돈다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "asb-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "releases", "r1", "deploy"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "releases", "r1", "deploy", "secrets-to-env.mjs"));
  symlinkSync(join("releases", "r1"), join(dir, "current"));
  const viaCurrent = join(dir, "current", "deploy", "secrets-to-env.mjs");

  const ok = spawnSync(process.execPath, [viaCurrent], { input: JSON.stringify(full()), encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.split("\n").filter(Boolean).length, 5);
  const partial = full();
  delete partial.SLACK_STATE_SECRET;
  const bad = spawnSync(process.execPath, [viaCurrent], { input: JSON.stringify(partial), encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
});
