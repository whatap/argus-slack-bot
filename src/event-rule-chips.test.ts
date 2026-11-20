import assert from "node:assert/strict";
import test from "node:test";

import { chipStatus, describeApplyFailures, describeApplyResult, describeEventRuleOpError, missingScope, renderRulePreview, resolveChipBlocks } from "./event-rule-chips.js";

test("scope 부족은 다시 로그인해 허락하라는 안내와 로그인 링크 신호", () => {
  const view = describeApplyFailures([
    { pcode: 38, reason: "the user has not granted this app permission for this action; log in again and allow it (/open/api/v2/event/metrics/create)" },
  ]);
  assert.equal(view.needsConsent, true);
  assert.match(view.text, /WhaTap 설정 변경/);
});

test("front 의 403 insufficient_scope 만 '허락이 모자람'으로 읽는다", () => {
  assert.equal(missingScope(403, 'Bearer error="insufficient_scope", scope="whatap:write"'), "whatap:write");
  assert.equal(missingScope(403, 'Bearer error="insufficient_scope"'), "", "scope 를 안 알려도 허락 문제다");
  assert.equal(missingScope(403, null), null, "헤더 없는 403(프로젝트 권한 등)은 아니다");
  assert.equal(missingScope(401, 'Bearer error="insufficient_scope", error_description="path not allowed for this client"'), null, "401 은 표면 설정 문제");
  assert.equal(missingScope(403, 'Bearer error="invalid_token"'), null);
});

test("프로젝트 권한 부족은 관리자에게 요청하라는 안내, 로그인 링크는 보내지 않는다", () => {
  const view = describeApplyFailures([
    { pcode: 38, reason: 'front bearer 403 /open/api/v2/event/metrics/create: {"code":403,"msg":"FTno permission to change alert settings of this project"}' },
  ]);
  assert.equal(view.needsConsent, false);
  assert.match(view.text, /경고 알림 설정 권한/);
});

test("사용자 토큰으로 아직 못 하는 기능은 화면에서 하라고 안내", () => {
  const view = describeApplyFailures([
    { pcode: 38, reason: "this WhaTap feature needs a browser session and is not available with a user OAuth token" },
  ]);
  assert.equal(view.needsConsent, false);
  assert.match(view.text, /와탭 화면/);
});

test("모르는 사유는 첫 사유를 잘라서 보인다, 실패가 없으면 빈 문자열", () => {
  assert.deepEqual(describeApplyFailures([]), { text: "", needsConsent: false });
  const long = "x".repeat(300);
  const view = describeApplyFailures([{ pcode: 1, reason: long }]);
  assert.equal(view.needsConsent, false);
  assert.ok(view.text.length < 230);
});

test("와탭 데이터 서버에 닿지 못한 실패는 원문 대신 확인 후 재시도 안내 (예전·새 front 둘 다)", () => {
  for (const reason of [
    "yard event envelope parse: unexpected end of JSON input",
    'front bearer 502 /open/api/v2/event/metrics/delete: {"code":502,"msg":"FTno response from the WhaTap data server (yard); the change may not have been applied"}',
  ]) {
    const view = describeApplyFailures([{ pcode: 3396, reason }]);
    assert.equal(view.needsConsent, false);
    assert.match(view.text, /와탭 데이터 서버에 연결하지 못해/);
    assert.doesNotMatch(view.text, /envelope|JSON/);
  }
});

test("와탭 서버가 제때 답하지 않은 실패도 원문(내부 주소·Go 오류) 대신 확인 후 재시도 안내", () => {
  for (const reason of [
    // 2026-11-11 봇 DM 실측: argus 의 프로젝트당 10초 상한이 front 응답보다 먼저 끝났다.
    'Post "http://localhost:18080/open/api/v2/event/metrics/delete": context deadline exceeded',
    'Post "http://front.internal:8080/open/api/v2/event/mxql/create": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
    'Post "http://front.internal:8080/open/api/v2/event/metrics/update": dial tcp 10.0.0.7:8080: connect: connection refused',
    'Post "http://front.internal:8080/open/api/v2/event/metrics/update": dial tcp 10.0.0.7:8080: i/o timeout',
    'Post "http://front.internal:8080/open/api/v2/event/metrics/create": EOF',
    "context deadline exceeded",
  ]) {
    const view = describeApplyFailures([{ pcode: 3396, reason }]);
    assert.equal(view.needsConsent, false);
    assert.match(view.text, /반영됐는지 확실하지 않으니/, reason);
    assert.doesNotMatch(view.text, /http|localhost|internal|deadline|dial tcp|EOF/, reason);
  }
});

test("분류하지 못한 실패 사유에도 내부 주소는 싣지 않는다", () => {
  const view = describeApplyFailures([
    { pcode: 1, reason: 'Post "http://front.internal:8080/open/api/v2/event/metrics/create": something unexpected' },
  ]);
  assert.match(view.text, /something unexpected/);
  assert.doesNotMatch(view.text, /front\.internal|8080|http/);
});

test("적용 API 오류 code 안내, 모르는 code 는 빈 문자열", () => {
  assert.match(describeEventRuleOpError("token_not_found"), /시간이 지났어요/);
  assert.match(describeEventRuleOpError("token_forbidden"), /본인 질문/);
  assert.equal(describeEventRuleOpError("internal"), "");
  assert.equal(describeEventRuleOpError(undefined), "");
});

const createPayload = {
  confirmToken: "ct_x",
  action: "create",
  targetLabel: "CPU 80% 초과 알림",
  preview: {
    action: "create",
    rule: {
      title: "[AI] CPU 80% 초과 알림", category: "kube_node_perf", message: "CPU <cpu> 초과 & 경고",
      enabled: true, stateful: true, silentMs: 300000,
      conditions: [{ level: "Warning", rule: "cpuTotal > 80", enabled: true }],
    },
    items: [
      { pcode: 3396, action: "create", newEventId: "e1" },
      { pcode: 8, action: "skip", reason: "duplicate: 같은 category+title 룰 이미 존재" },
    ],
    simulation: { estimatedTotalPerHour: 2.5, confidence: "low" },
    warnings: ["샘플 평균 12.0건/h — 임계값 점검 권장"],
  },
};

test("미리보기: 생성할 규칙·조건·상태·대상을 버튼 위에 그대로 보여 준다", () => {
  const text = renderRulePreview(createPayload)!;
  assert.match(text, /알림 규칙 생성/);
  assert.match(text, /\*\[AI\] CPU 80% 초과 알림\* \(`kube_node_perf`\)/);
  assert.match(text, /Warning `cpuTotal &gt; 80`/, "mrkdwn 에서 > 는 엔티티로 바꾼다");
  assert.match(text, /켜짐 · 상태 유지 · 무음 5분/);
  assert.match(text, /메시지: CPU &lt;cpu&gt; 초과 &amp; 경고/);
  assert.match(text, /pcode 3396: 새로 생성/);
  assert.match(text, /pcode 8: 건너뜀 — duplicate/);
  assert.match(text, /시간당 약 2\.5건/);
  assert.match(text, /:warning: 샘플 평균/);
});

test("미리보기: 꺼진 규칙은 눈에 띄게 — 모델이 지어낸 임시 규칙이 드러나야 한다", () => {
  const text = renderRulePreview({ preview: {
    action: "create",
    rule: { title: "[AI] 임시 확인용 알림", category: "server_base", enabled: false, silentMs: 0,
      conditions: [{ level: "Info", rule: "cpu > 100", enabled: true }] },
    items: [{ pcode: 3396, action: "create" }],
  } })!;
  assert.match(text, /\*꺼짐\* \(만들어져도 알림이 울리지 않아요\)/);
  assert.match(text, /무음 없음/);
  assert.match(text, /Info `cpu &gt; 100`/);
});

test("미리보기: 삭제는 지울 규칙 이름, 수정은 바뀌는 값", () => {
  const del = renderRulePreview({ preview: { action: "delete", items: [
    { pcode: 3396, action: "delete", matchedRule: { eventId: "e1", title: "[AI] 임시 확인용 알림" } },
  ] } })!;
  assert.match(del, /알림 규칙 삭제/);
  assert.match(del, /pcode 3396: \*\[AI\] 임시 확인용 알림\* 삭제/);
  const upd = renderRulePreview({ preview: { action: "update", items: [
    { pcode: 8, action: "update", matchedRule: { title: "Server CPU" },
      diff: { conditions: { before: ["Warning cpu>90"], after: ["Critical cpu>95"] }, enabled: { before: false, after: true }, silent: { before: 0, after: 600000 } } },
    { pcode: 9, action: "ambiguous", candidates: [{ title: "A" }, { title: "B" }] },
  ] } })!;
  assert.match(upd, /pcode 8: \*Server CPU\* 수정/);
  assert.match(upd, /조건: Warning cpu&gt;90 → Critical cpu&gt;95/);
  assert.match(upd, /켜짐 여부: 꺼짐 → 켜짐/);
  assert.match(upd, /무음: 없음 → 10분/);
  assert.match(upd, /pcode 9: 해당하는 규칙이 2개라 건너뜀 \(A, B\)/);
});

test("미리보기: preview 가 없으면(구버전 argus) 그리지 않고, 많으면 잘라서 외 N개", () => {
  assert.equal(renderRulePreview({ confirmToken: "ct_x" }), undefined);
  assert.equal(renderRulePreview(undefined), undefined);
  const items = Array.from({ length: 20 }, (_, i) => ({ pcode: i, action: "create" }));
  const text = renderRulePreview({ preview: { action: "create", items, truncated: 5 } })!;
  assert.match(text, /외 10개 프로젝트/);
  assert.ok(text.length <= 2810);
});

test("결과: 무엇을 어느 프로젝트에 어떻게 했는지 쓴다", () => {
  assert.match(
    describeApplyResult("apply", { action: "create", succeeded: [{ pcode: 3396 }], failed: [], elapsedMs: 300 }, "CPU 80% 초과 알림").text,
    /:white_check_mark: \*CPU 80% 초과 알림\* — pcode 3396에 생성했어요 \(0\.3초\)/,
  );
  assert.match(
    describeApplyResult("apply", { action: "delete", succeeded: [{ pcode: 1 }, { pcode: 2 }], failed: [] }, "x").text,
    /프로젝트 2개\(1, 2\)에 삭제했어요/,
  );
  const partial = describeApplyResult("apply", { action: "create", succeeded: [{ pcode: 1 }],
    failed: [{ pcode: 2, reason: "the user has not granted this app permission for this action" }] }, "x");
  assert.match(partial.text, /프로젝트 1개는 생성하지 못했어요/);
  assert.equal(partial.needsConsent, true);
  assert.match(describeApplyResult("apply", { action: "create", succeeded: [], failed: [] }, "").text, /생성할 대상이 없었어요/);
  assert.match(describeApplyResult("cancel", {}, "x").text, /적용을 취소했어요\. 바뀐 건 없어요/);
});

test("버튼 상태: 누른 확인 토큰의 버튼 줄만 상태 문장으로 바꾸고 나머지는 둔다", () => {
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "답변" } },
    { type: "section", text: { type: "mrkdwn", text: "미리보기" } },
    { type: "actions", elements: [{ type: "button", action_id: "apply_event_rule:ct_a" }, { type: "button", action_id: "cancel_event_rule:ct_a" }] },
    { type: "actions", elements: [{ type: "button", action_id: "followup_question:0" }] },
  ];
  const out = resolveChipBlocks(blocks, "ct_a", "적용함")!;
  assert.equal(out.length, 4);
  assert.deepEqual(out[2], { type: "context", elements: [{ type: "mrkdwn", text: "적용함" }] });
  assert.deepEqual(out[1], blocks[1], "미리보기는 그대로");
  assert.deepEqual(out[3], blocks[3], "후속 질문 버튼은 그대로");
  assert.equal(resolveChipBlocks(blocks, "ct_other", "x"), undefined);
});

test("버튼 자리 상태 문장", () => {
  assert.match(chipStatus("apply", { succeeded: [{}], failed: [] }), /적용함/);
  assert.match(chipStatus("apply", { succeeded: [{}], failed: [{}] }), /일부만/);
  assert.match(chipStatus("apply", { succeeded: [], failed: [{}] }), /적용 실패/);
  assert.match(chipStatus("apply", { succeeded: [], failed: [] }), /바뀐 것 없음/);
  assert.match(chipStatus("cancel", {}), /취소함/);
});
