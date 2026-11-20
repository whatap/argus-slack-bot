import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  OncallIncidents,
  OncallKeepAlive,
  OncallOwners,
  escalationText,
  loadOncallSettings,
  oncallLog,
  parseOncallCommand,
  pickAutoOpm,
  resolvedAfterApply,
  ruleEligible,
} from "./oncall-auto.js";
import { LoginRequiredError } from "./whatap-oauth.js";

const ready = { whatapLogin: true, alertChannel: true };

test("자동 대응은 ONCALL_AUTO=1 일 때만 켜지고, 꺼져 있으면 다른 설정은 읽지도 않는다", () => {
  assert.equal(loadOncallSettings({}, ready), null);
  assert.equal(loadOncallSettings({ ONCALL_AUTO: "" }, ready), null);
  assert.equal(loadOncallSettings({ ONCALL_AUTO: "0", ONCALL_AUTO_RISKS: "bogus", ONCALL_ESCALATE_MIN: "x" }, ready), null);
  assert.deepEqual(loadOncallSettings({ ONCALL_AUTO: "1" }, ready), { rules: [], risks: ["normal", "warning"], escalateMin: 10, keepAliveMin: 60 });
});

test("대상 규칙은 쉼표로 나눈 부분 문자열이고, 자동 실행 위험도는 normal·warning·critical 중에서만 받는다", () => {
  const s = loadOncallSettings({ ONCALL_AUTO: "1", ONCALL_AUTO_RULES: " disk , cpu high,,", ONCALL_AUTO_RISKS: "normal" }, ready)!;
  assert.deepEqual(s.rules, ["disk", "cpu high"]);
  assert.deepEqual(s.risks, ["normal"]);
  assert.deepEqual(loadOncallSettings({ ONCALL_AUTO: "1", ONCALL_AUTO_RISKS: "critical, warning" }, ready)!.risks, ["critical", "warning"]);
  for (const bad of ["normal,danger", "NORMAL", "low", "normal;warning"]) {
    assert.throws(() => loadOncallSettings({ ONCALL_AUTO: "1", ONCALL_AUTO_RISKS: bad }, ready), /ONCALL_AUTO_RISKS/, bad);
  }
});

test("에스컬레이션·토큰 유지 간격은 분 단위 양의 정수이고, 토큰 유지는 refresh token 수명(8시간)보다 짧아야 한다", () => {
  const s = loadOncallSettings({ ONCALL_AUTO: "1", ONCALL_ESCALATE_MIN: "15", ONCALL_KEEPALIVE_MIN: "479" }, ready)!;
  assert.deepEqual([s.escalateMin, s.keepAliveMin], [15, 479]);
  // setTimeout 은 24.8일이 넘으면 바로 불린다. 사건은 하루만 기억하므로 에스컬레이션도 하루(1440분)까지다.
  for (const bad of ["0", "-1", "1.5", "abc", "10m", "1441"]) {
    assert.throws(() => loadOncallSettings({ ONCALL_AUTO: "1", ONCALL_ESCALATE_MIN: bad }, ready), /ONCALL_ESCALATE_MIN/, bad);
  }
  for (const bad of ["0", "480", "600", "x", "30.5"]) {
    assert.throws(() => loadOncallSettings({ ONCALL_AUTO: "1", ONCALL_KEEPALIVE_MIN: bad }, ready), /ONCALL_KEEPALIVE_MIN/, bad);
  }
});

test("ONCALL_AUTO=1 은 와탭 로그인 모드와 알림 채널 설정이 없으면 시작하지 않고, 1·0 이 아닌 값도 받지 않는다", () => {
  assert.throws(() => loadOncallSettings({ ONCALL_AUTO: "1" }, { whatapLogin: false, alertChannel: true }), /와탭 로그인/);
  assert.throws(() => loadOncallSettings({ ONCALL_AUTO: "1" }, { whatapLogin: true, alertChannel: false }), /SLACK_ALERT_CHANNEL_ID/);
  for (const bad of ["yes", "true", "on", "2"]) assert.throws(() => loadOncallSettings({ ONCALL_AUTO: bad }, ready), /ONCALL_AUTO/, bad);
});

test("명령은 멘션을 뺀 글 전체가 '자동 대응 켜기·끄기·상태' 일 때만이다", () => {
  assert.equal(parseOncallCommand("자동 대응 켜기"), "on");
  assert.equal(parseOncallCommand("  자동 대응   끄기 "), "off");
  assert.equal(parseOncallCommand("자동 대응 상태"), "status");
  for (const text of ["자동 대응 켜기 해줘", "자동대응 켜기", "자동 대응", "자동 대응 켜기?", "지금 자동 대응 상태 알려줘", "", "켜기", "constructor", "__proto__", "toString"]) {
    assert.equal(parseOncallCommand(text), undefined, text);
  }
});

/** 봇과 같은 SQLite 파일(와탭 연결 저장소가 쓰는 파일)을 흉내 낸 임시 파일. */
function dbFile(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "oncall-owners-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "user_tokens.sqlite");
}

test("당번은 (워크스페이스, 채널)마다 한 명이고, 봇이 다시 시작해도(같은 DB 파일) 남는다", (t) => {
  const path = dbFile(t);
  const first = new OncallOwners(path);
  assert.equal(first.get("T1", "C1"), null);
  first.set("T1", "C1", "U1");
  first.set("T1", "C1", "U2");
  first.set("T1", "C2", "U3");
  first.close();
  const again = new OncallOwners(path);
  t.after(() => again.close());
  assert.equal(again.get("T1", "C1"), "U2", "다시 켜면 당번이 바뀐다");
  assert.deepEqual(again.list(), [{ teamId: "T1", channelId: "C1", ownerId: "U2" }, { teamId: "T1", channelId: "C2", ownerId: "U3" }]);
  assert.equal(again.clear("T1", "C1"), true);
  assert.equal(again.clear("T1", "C1"), false, "이미 꺼져 있다");
  assert.equal(again.get("T1", "C1"), null);
  assert.equal(again.get("T1", "C2"), "U3", "다른 채널은 그대로");
});

test("워크스페이스가 앱을 지우면 그 워크스페이스의 당번만 지운다", (t) => {
  const owners = new OncallOwners(dbFile(t));
  t.after(() => owners.close());
  owners.set("T1", "C1", "U1");
  owners.set("T1", "C9", "U9");
  owners.set("T2", "C1", "U2");
  assert.equal(owners.deleteTeam("T1"), 2);
  assert.deepEqual(owners.list(), [{ teamId: "T2", channelId: "C1", ownerId: "U2" }]);
});

test("자동 대응 대상은 규칙 이름에 설정한 부분 문자열 중 하나가 들어 있는 알림뿐이고, 목록이 비면 아무것도 아니다", () => {
  assert.equal(ruleEligible(["disk", "cpu"], "disk full on /app"), true);
  assert.equal(ruleEligible(["disk", "cpu"], "high cpu"), true);
  assert.equal(ruleEligible(["disk"], "Disk full"), false, "대소문자를 가린다");
  assert.equal(ruleEligible(["disk"], "memory"), false);
  assert.equal(ruleEligible([], "disk full"), false);
});

// argus 의 OPM 조치안 chip(applyOpmAction). 위험도는 argus 가 붙이고, 대상 서버는 oid·oname 으로 온다.
const opm = (over: Record<string, unknown> = {}) => ({ type: "applyOpmAction", label: "디스크 정리",
  payload: { confirmToken: "oa_1", tool: "operant_action", risk: "warning", pcode: 42, oid: 1234, oname: "web-01", title: "디스크 정리", ...over } });
/** 알림이 가리키는 서버: 프로젝트 코드와 서버 oid(알림에 적혀 있을 때만). */
const target = { project: "42", oid: "1234" };

test("자동 실행은 허용한 위험도이고 알림의 서버를 겨냥한 첫 조치안 하나뿐이고, 나머지는 사람 버튼으로 남는다", () => {
  const rule = { type: "applyEventRules", label: "규칙", payload: { confirmToken: "ct_1" } };
  const first = opm({ confirmToken: "oa_a" }), second = opm({ confirmToken: "oa_b", risk: "normal" });
  const picked = pickAutoOpm([rule, first, second], target, ["normal", "warning"]);
  assert.equal(picked.auto, first);
  assert.deepEqual(picked.manual, [rule, second], "두 번째 조치안은 자동으로 실행하지 않는다(사건마다 하나)");
});

test("위험도가 허용 밖이면(기본: critical) 자동으로 실행하지 않는다 — 자유 스크립트와 모르는 위험도는 critical 로 본다", () => {
  for (const chip of [opm({ risk: "critical" }), opm({ tool: "operant_execute", risk: "normal" }), opm({ risk: "low" }), opm({ risk: undefined })]) {
    const picked = pickAutoOpm([chip], target, ["normal", "warning"]);
    assert.equal(picked.auto, undefined, JSON.stringify(chip.payload));
    assert.deepEqual(picked.manual, [chip], "사람 버튼으로 남는다");
  }
  assert.equal(pickAutoOpm([opm({ risk: "warning" })], target, ["normal"]).auto, undefined, "ONCALL_AUTO_RISKS=normal 이면 warning 도 사람이 누른다");
  assert.ok(pickAutoOpm([opm({ risk: "critical" })], target, ["critical"]).auto, "운영자가 critical 까지 허용했으면 실행한다");
});

test("알림에 서버 oid 가 없거나, 조치안이 다른 서버·다른 프로젝트를 겨냥하면 자동으로 실행하지 않는다", () => {
  const risks = ["normal", "warning"] as const;
  assert.equal(pickAutoOpm([opm()], { project: "42" }, risks).auto, undefined, "알림이 oid 를 모르면 무엇이 같은 서버인지 모른다");
  for (const over of [{ oid: 999 }, { oid: undefined }, { oid: "" }, { pcode: 43 }, { pcode: undefined }]) {
    const chip = opm(over);
    const picked = pickAutoOpm([chip], target, risks);
    assert.equal(picked.auto, undefined, JSON.stringify(over));
    assert.deepEqual(picked.manual, [chip]);
  }
  assert.ok(pickAutoOpm([opm({ oid: "1234", pcode: "42" })], target, risks).auto, "문자열로 와도 같은 서버다");
  assert.ok(pickAutoOpm([opm({ oid: -1725776847 })], { project: "42", oid: "-1725776847" }, risks).auto, "음수 oid 도 그대로 비교한다");
});

/** 시계와 타이머를 손으로 돌린다. 콜백이 돌려준 promise 까지 기다린다. */
function fakeClock(start = Date.UTC(2026, 10, 19, 1, 0)) {
  let now = start;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => unknown; every?: number }>();
  const unrefd = new Set<number>();
  const handle = (id: number) => ({ id, unref() { unrefd.add(id); return this; } });
  return {
    now: () => now,
    setTimeout: (fn: () => unknown, ms: number) => { const id = ++seq; due.set(id, { at: now + ms, fn }); return handle(id); },
    clearTimeout: (h: unknown) => { due.delete((h as { id?: number } | undefined)?.id ?? -1); },
    setInterval: (fn: () => unknown, ms: number) => { const id = ++seq; due.set(id, { at: now + ms, fn, every: ms }); return handle(id); },
    clearInterval: (h: unknown) => { due.delete((h as { id?: number } | undefined)?.id ?? -1); },
    /** 아직 걸려 있는 타이머 수. */
    pending: () => due.size,
    /** 걸려 있는 타이머가 모두 unref 됐는지(프로세스 종료를 막지 않는지). */
    allUnrefd: () => [...due.keys()].every((id) => unrefd.has(id)),
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

test("같은 알림(원본 글)은 한 번만 자동 대응한다", () => {
  const incidents = new OncallIncidents(fakeClock());
  assert.equal(incidents.claim("100.000001", "U1"), true);
  assert.equal(incidents.claim("100.000001", "U1"), false, "Slack 이 같은 글을 다시 보내도 두 번 분석하지 않는다");
  assert.equal(incidents.claim("100.000002", "U1"), true);
});

test("하루가 지난 사건은 잊는다 — 메모리를 끝없이 쓰지 않는다", async () => {
  const clock = fakeClock();
  const incidents = new OncallIncidents(clock);
  incidents.claim("100.000001", "U1");
  await clock.advance(24 * 60 * 60 * 1000);
  assert.equal(incidents.claim("200.000001", "U1"), true);
  assert.equal(incidents.claim("100.000001", "U1"), true, "하루 지난 기록은 지웠다");
});

test("자동 조치는 사건마다 하나이고, 같은 확인 토큰은 두 번 실행하지 않으며, 자동 대응하지 않은 사건의 것은 실행하지 않는다", () => {
  const incidents = new OncallIncidents(fakeClock());
  incidents.claim("100.000001", "U1");
  incidents.claim("200.000001", "U1");
  assert.equal(incidents.tryApply("100.000001", "oa_a"), true);
  assert.equal(incidents.tryApply("100.000001", "oa_b"), false, "사건마다 하나");
  assert.equal(incidents.tryApply("200.000001", "oa_a"), false, "같은 확인 토큰은 다른 사건에서도 다시 실행하지 않는다");
  assert.equal(incidents.tryApply("200.000001", "oa_c"), true);
  assert.equal(incidents.tryApply("300.000001", "oa_d"), false, "자동 대응을 시작하지 않은 사건");
});

test("자동 조치 뒤 정해 둔 시간 안에 해소되지 않으면 당번을 한 번 부르고, 그 타이머는 프로세스 종료를 막지 않는다", async () => {
  const clock = fakeClock();
  const incidents = new OncallIncidents(clock);
  incidents.claim("100.000001", "U1");
  let calls = 0;
  incidents.applied("100.000001", 10 * 60_000, () => { calls++; });
  assert.equal(clock.pending(), 1);
  assert.ok(clock.allUnrefd(), "unref");
  await clock.advance(10 * 60_000 - 1);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  await clock.advance(60 * 60_000);
  assert.equal(calls, 1, "한 번만 부른다");
});

test("해소되면 에스컬레이션을 멈추고, 자동 조치 뒤 얼마 만에 해소됐는지 돌려준다", async () => {
  const clock = fakeClock();
  const incidents = new OncallIncidents(clock);
  incidents.claim("100.000001", "U1");
  incidents.claim("200.000001", "U2");
  let calls = 0;
  incidents.applied("100.000001", 10 * 60_000, () => { calls++; });
  incidents.applied("999.000001", 10 * 60_000, () => { calls++; });
  assert.equal(clock.pending(), 1, "자동 대응하지 않은 사건에는 타이머를 걸지 않는다");
  await clock.advance(3 * 60_000);
  assert.deepEqual(incidents.resolve("100.000001"), { owner: "U1", appliedAgoMs: 180_000 });
  assert.equal(clock.pending(), 0, "에스컬레이션을 멈췄다");
  await clock.advance(60 * 60_000);
  assert.equal(calls, 0);
  assert.deepEqual(incidents.resolve("200.000001"), { owner: "U2" }, "자동 조치 없이 해소");
  assert.equal(incidents.resolve("300.000001"), undefined, "자동 대응하지 않은 사건");
});

test("하루가 지나 잊은 사건의 에스컬레이션은 부르지 않는다 — 해소 알림도 더는 그 사건과 잇지 못한다", async () => {
  const clock = fakeClock();
  const incidents = new OncallIncidents(clock);
  incidents.claim("100.000001", "U1");
  await clock.advance(5 * 60_000);
  let calls = 0;
  incidents.applied("100.000001", 24 * 60 * 60_000, () => { calls++; });
  await clock.advance(24 * 60 * 60_000 - 5 * 60_000);
  incidents.claim("200.000001", "U1");
  await clock.advance(10 * 60_000);
  assert.equal(calls, 0);
});

test("에스컬레이션은 당번을 부르고, 해소 글에는 자동 조치 뒤 걸린 시간(봇 시계)을 덧붙인다", () => {
  assert.equal(escalationText("U1", 10), "<@U1> 자동 조치 후 10분이 지났는데 아직 해소되지 않았어요. 확인이 필요해요.");
  assert.equal(resolvedAfterApply(180_000), " · 자동 조치 후 3분 만에 해소 (봇 기준)");
  assert.equal(resolvedAfterApply(150_000), " · 자동 조치 후 3분 만에 해소 (봇 기준)");
  assert.equal(resolvedAfterApply(20_000), " · 자동 조치 후 1분 안에 해소 (봇 기준)");
});

test("자동 대응 기록은 한 줄에 시각·워크스페이스·채널·원본 글·당번·단계를 남기고, 값의 공백이 줄을 나누지 못한다", () => {
  const at = Date.UTC(2026, 10, 19, 1, 2, 3);
  assert.equal(oncallLog({ team: "T1", channel: "C1", root: "100.000001", owner: "U1", step: "auto-apply", result: "ok", status: "executed" }, at),
    "[argus-slack-bot] oncall at=2026-11-19T01:02:03.000Z team=T1 channel=C1 root=100.000001 owner=U1 step=auto-apply result=ok status=executed");
  assert.equal(oncallLog({ team: "T1", channel: "C1", owner: "U1", step: "keepalive", result: "error", reason: "fetch failed\nnext" }, at),
    "[argus-slack-bot] oncall at=2026-11-19T01:02:03.000Z team=T1 channel=C1 root=- owner=U1 step=keepalive result=error reason=fetch_failed_next");
});

// ── 토큰 유지 ────────────────────────────────────────────────────────────────
// 로그인 서버의 access token 은 5분, refresh token 은 8시간이고 갱신할 때마다 새 8시간짜리로 바뀐다.
// 알림이 8시간 넘게 없으면 당번 연결이 끊기므로, 자동 대응이 켜져 있는 동안 당번 토큰을 주기적으로 한 번씩 쓴다.
function keepAliveFixture(owners = [{ teamId: "T1", channelId: "C1", ownerId: "U1" }]) {
  const clock = fakeClock();
  const refreshed: string[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  let refresh: (team: string, user: string) => Promise<unknown> = async () => undefined;
  const keepAlive = new OncallKeepAlive({
    timers: clock, everyMs: 60 * 60_000, owners: () => owners,
    refresh: (team, user) => { refreshed.push(`${team}:${user}`); return refresh(team, user); },
    notifyExpired: async (o) => { notices.push(`${o.teamId}:${o.channelId}:${o.ownerId}`); },
    log: (line) => logs.push(line),
  });
  return { clock, keepAlive, refreshed, notices, logs, refreshWith: (fn: typeof refresh) => { refresh = fn; } };
}

test("토큰 유지는 정해 둔 간격마다 당번 토큰을 한 번씩 쓰고, 결과를 한 줄씩 남기며, 그 타이머는 프로세스 종료를 막지 않는다", async () => {
  const f = keepAliveFixture([{ teamId: "T1", channelId: "C1", ownerId: "U1" }, { teamId: "T2", channelId: "C7", ownerId: "U2" }]);
  f.keepAlive.start();
  assert.equal(f.clock.pending(), 1);
  assert.ok(f.clock.allUnrefd(), "unref");
  await f.clock.advance(60 * 60_000 - 1);
  assert.deepEqual(f.refreshed, []);
  await f.clock.advance(1);
  assert.deepEqual(f.refreshed, ["T1:U1", "T2:U2"]);
  await f.clock.advance(60 * 60_000);
  assert.equal(f.refreshed.length, 4, "주기마다");
  assert.equal(f.logs.length, 4);
  assert.match(f.logs[0], /^\[argus-slack-bot\] oncall at=\S+ team=T1 channel=C1 root=- owner=U1 step=keepalive result=ok$/);
  assert.deepEqual(f.notices, []);
});

test("갱신이 거절되면(로그인 만료) 채널에 한 번만 알리고, 다음 주기마다 다시 알리지 않는다", async () => {
  const f = keepAliveFixture();
  f.refreshWith(async () => { throw new LoginRequiredError("와탭 로그인이 만료됐어요", { expired: true }); });
  f.keepAlive.start();
  await f.clock.advance(3 * 60 * 60_000);
  assert.equal(f.refreshed.length, 3, "멈춘 동안에도 다시 로그인했는지 계속 확인한다");
  assert.deepEqual(f.notices, ["T1:C1:U1"], "한 번만");
  assert.equal(f.logs.filter((l) => / step=keepalive result=login-required$/.test(l)).length, 3);
});

test("다시 로그인해 갱신되면 조용히 이어 가고, 그 뒤 다시 만료되면 그때 한 번 더 알린다", async () => {
  const f = keepAliveFixture();
  let expired = true;
  f.refreshWith(async () => { if (expired) throw new LoginRequiredError("와탭 로그인이 만료됐어요", { expired: true }); });
  f.keepAlive.start();
  await f.clock.advance(2 * 60 * 60_000);
  assert.equal(f.notices.length, 1);
  expired = false;
  await f.clock.advance(60 * 60_000);
  assert.equal(f.notices.length, 1, "이어 갈 때는 아무것도 올리지 않는다");
  assert.match(f.logs.at(-1)!, / result=ok$/);
  expired = true;
  await f.clock.advance(2 * 60 * 60_000);
  assert.equal(f.notices.length, 2, "새로 멈추면 다시 한 번 알린다");
});

test("로그인 서버에 닿지 않는 일시 오류는 채널에 알리지 않고 기록만 남긴다", async () => {
  const f = keepAliveFixture();
  f.refreshWith(async () => { throw new TypeError("fetch failed"); });
  f.keepAlive.start();
  await f.clock.advance(60 * 60_000);
  assert.deepEqual(f.notices, []);
  assert.match(f.logs.at(-1)!, / step=keepalive result=error$/);
});

test("한 당번의 알림이 실패해도 다른 당번의 토큰 유지는 이어 간다", async () => {
  const owners = [{ teamId: "T1", channelId: "C1", ownerId: "U1" }, { teamId: "T2", channelId: "C2", ownerId: "U2" }];
  const clock = fakeClock();
  const refreshed: string[] = [];
  const logs: string[] = [];
  const keepAlive = new OncallKeepAlive({
    timers: clock, everyMs: 60 * 60_000, owners: () => owners,
    refresh: async (team, user) => { refreshed.push(`${team}:${user}`); if (user === "U1") throw new LoginRequiredError(); },
    notifyExpired: async () => { throw new Error("slack down"); },
    log: (line) => logs.push(line),
  });
  await keepAlive.tick();
  assert.deepEqual(refreshed, ["T1:U1", "T2:U2"]);
  assert.match(logs.join("\n"), /owner=U1 step=keepalive result=notify-failed/);
});
