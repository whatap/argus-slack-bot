import assert from "node:assert/strict";
import test from "node:test";

import { OpmChipStore, describeOpmError, describeOpmOutcome, opmChipBlocks, renderOpmProposal } from "./opm-action-chips.js";

const base = (extra: Record<string, unknown> = {}) => ({
  confirmToken: "oa_unit", proposalId: "p-1", tool: "operant_action", risk: "warning", pcode: 3396, oid: 1234,
  oname: "demo-was-01", title: "디스크 정리", rationale: "/app/logs 사용률 92%", expiresAt: Date.UTC(2026, 10, 17, 9, 30),
  arguments: { function: "disk_cleanup", pcode: 3396, oid: 1234, params: { path: "/app/logs", days: "7" } },
  ...extra,
});
const chipOf = (payload: Record<string, unknown>) => ({ type: "applyOpmAction", label: String(payload["title"] ?? ""), payload });
const owner = { teamId: "T1", userId: "U1" };

test("조치안에는 대상 서버·실행할 함수와 인자·위험도·근거·확인 마감이 보인다", () => {
  const text = renderOpmProposal(base());
  assert.match(text, /demo-was-01/);
  assert.match(text, /pcode 3396/);
  assert.match(text, /disk_cleanup/);
  assert.match(text, /path=\/app\/logs/);
  assert.match(text, /days=7/);
  assert.match(text, /주의/, "warning 은 주의");
  assert.match(text, /\/app\/logs 사용률 92%/);
  assert.match(text, /<!date\^\d+\^/, "마감은 보는 사람의 시간대로 보인다");
});

test("모델이 쓴 문장이 Slack 멘션·링크로 해석되지 않는다", () => {
  const text = renderOpmProposal(base({ title: "<!channel> 정리", rationale: "<https://evil.example|여기> & 확인", oname: "<@U999>" }));
  assert.doesNotMatch(text, /<!channel>|<https:|<@U999>/);
  assert.match(text, /&lt;!channel&gt;/);
  assert.match(text, /&amp; 확인/);
});

test("스크립트 조치는 실행할 스크립트를 코드 블록으로 보이고, 코드 블록을 깨지 않는다", () => {
  const script = "#!/bin/sh\nfind /app/logs -mtime +7 -delete\necho '```' <done>";
  const text = renderOpmProposal(base({ tool: "operant_execute", risk: "critical", arguments: { pcode: 3396, oid: 1234, scriptContent: script } }));
  assert.match(text, /스크립트/);
  assert.match(text, /find \/app\/logs -mtime \+7 -delete/);
  assert.equal(text.split("```").length - 1, 2, "코드 블록은 한 쌍뿐이다");
  assert.match(text, /&lt;done&gt;/);
  assert.match(text, /높음/, "critical 은 높음");
});

test("아주 긴 스크립트·인자도 Slack 문단 한도(3000자) 안에 들어간다", () => {
  const text = renderOpmProposal(base({ tool: "operant_execute", rationale: "r".repeat(2000), arguments: { scriptContent: "x".repeat(10_000) } }));
  assert.ok(text.length <= 3000, `${text.length}`);
  assert.match(text, /생략/);
});

test("[조치 실행]은 한 번 더 묻고, 위험도가 높으면 빨간 버튼이다", () => {
  const store = new OpmChipStore();
  for (const [risk, style] of [["normal", "primary"], ["warning", "primary"], ["critical", "danger"]] as const) {
    const blocks = opmChipBlocks([chipOf(base({ risk }))], owner, store) as any[];
    const apply = blocks[1].elements[0];
    assert.equal(apply.style, style, risk);
    assert.ok(apply.confirm, `${risk}: Slack 확인 창을 띄운다`);
    assert.match(apply.confirm.text.text, /demo-was-01/);
    assert.ok(apply.confirm.title.text.length <= 100 && apply.confirm.text.text.length <= 300);
  }
});

test("확인 토큰은 버튼·문단 어디에도 없고, 손잡이로 받은 사람과 함께 봇에 남는다", () => {
  const store = new OpmChipStore();
  const blocks = opmChipBlocks([chipOf(base())], owner, store) as any[];
  assert.doesNotMatch(JSON.stringify(blocks), /oa_unit/);
  const handle = blocks[1].elements[0].action_id.split(":")[2];
  assert.deepEqual({ ...store.get(handle) }, { token: "oa_unit", teamId: "T1", userId: "U1", title: "디스크 정리", createdAt: store.get(handle)!.createdAt });
});

const proposal = (status: string, extra: Record<string, unknown> = {}) => ({
  proposal: { id: "p-1", status, title: "디스크 정리", oname: "demo-was-01", pcode: 3396, ...extra },
});

test("실행 결과마다 버튼 자리의 상태와 스레드 문장이 다르다", () => {
  const cases: [string, Record<string, unknown>, RegExp, RegExp, boolean][] = [
    ["executed", { result: "ok" }, /실행함/, /demo-was-01에서 실행했어요/, false],
    ["pending_approval", { approvalId: 7 }, /결재 대기/, /결재 #7/, true],
    ["approved", {}, /결재됨/, /실행/, true],
    ["running", {}, /실행 중/, /실행 중/, true],
    ["rejected", {}, /반려/, /실행하지 않았어요/, false],
    ["failed", { result: "OPM did not run the action; nothing was executed." }, /실행 실패/, /nothing was executed/, false],
    ["unknown", { result: "The OPM call was interrupted after it was sent" }, /확인 필요/, /실행 이력/, false],
    ["expired", {}, /만료/, /다시 물어봐/, false],
    ["cancelled", {}, /취소함/, /실행된 건 없어요/, false],
  ];
  for (const [status, extra, statusRe, textRe, check] of cases) {
    const out = describeOpmOutcome("apply", proposal(status, extra), "fallback");
    assert.match(out.status, statusRe, status);
    assert.match(out.text, textRe, status);
    assert.equal(out.check, check, `${status}: 다시 확인할 거리가 있을 때만 [상태 확인]`);
  }
});

test("결재 번호를 모르면 OPM 결재함에서 확인하라고 한다", () => {
  const out = describeOpmOutcome("apply", proposal("pending_approval"), "fallback");
  assert.match(out.text, /OPM 결재함/);
  assert.equal(out.check, false, "argus 가 따라갈 결재 번호가 없으면 [상태 확인]이 늘 같은 답을 준다");
});

test("[상태 확인]에 아직 결재 대기면 아직이라고 말한다", () => {
  const out = describeOpmOutcome("check", proposal("pending_approval", { approvalId: 7 }), "fallback");
  assert.match(out.text, /아직/);
  assert.equal(out.check, true);
});

test("이미 처리된 조치안을 다시 누르면(replayed) 새로 실행하지 않았다고 먼저 말한다", () => {
  const out = describeOpmOutcome("apply", { ...proposal("executed", { result: "ok" }), replayed: true }, "fallback");
  assert.match(out.text, /^:information_source: 이미 처리된 조치안이에요/);
});

test("실행 결과가 길면 잘라서 보인다", () => {
  const out = describeOpmOutcome("apply", proposal("executed", { result: "x".repeat(5000) }), "fallback");
  assert.ok(out.text.length < 1800);
  assert.match(out.text, /생략/);
});

test("결과 문장도 멘션·링크로 해석되지 않고, OPM 결과가 코드 블록을 깨지 않는다", () => {
  const out = describeOpmOutcome("apply", proposal("executed", { title: "<!channel> 정리", oname: "<@U999>", result: "done ``` <!here>" }), "fallback");
  assert.doesNotMatch(out.text, /<!channel>|<@U999>|<!here>/);
  assert.equal(out.text.split("```").length - 1, 2, "코드 블록은 한 쌍뿐이다");
});

test("[상태 확인]에 argus 가 기록을 모르면 실행하지 않았다고 단정하지 않는다", () => {
  const view = describeOpmError("check", 404, { code: "token_not_found", error: "Not Found" }, "디스크 정리");
  assert.equal(view.row, "retire");
  assert.doesNotMatch(view.text, /실행하지 않았어요/, "이미 실행됐을 수 있다 — 결재 대기 뒤에 보관 기간이 지난 경우");
  assert.match(view.text, /OPM 실행 이력/);
});

test("봇이 들고 있는 확인 토큰은 보관 기간이 지나거나 너무 많아지면 오래된 것부터 버린다", () => {
  let now = 1_000;
  const store = new OpmChipStore(() => now, { retentionMs: 60_000, maxEntries: 2 });
  const a = store.put("oa_a", owner, "a");
  now += 10; const b = store.put("oa_b", owner, "b");
  now += 10; const c = store.put("oa_c", owner, "c");
  assert.equal(store.get(a), undefined, "가장 오래된 것을 버린다");
  assert.equal(store.get(b)?.token, "oa_b");
  now += 60_001;
  assert.equal(store.get(c), undefined, "보관 기간이 지나면 버린다");
});
