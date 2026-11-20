// src/argus-direct.test.ts
//
// parseSSEBlock 회귀 가드. argus 의 Anthropic Messages SSE 포맷 파싱이 핵심 —
// 한 줄 깨지면 모든 답변 무응답. consumeSSE 통합은 e2e 영역으로 별도.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  ArgusStreamError,
  __resetSubToolWarnings,
  askWhatapExpertDirect,
  describeArgusSubTool,
  parseSSEBlock,
} from "./argus-direct.js";

test("event + data 한 줄씩 → 정상 parse", () => {
  const block = 'event: message_start\ndata: {"type":"message_start","id":"msg_1"}';
  const evt = parseSSEBlock(block);
  assert.ok(evt);
  assert.equal(evt.event, "message_start");
  assert.equal(evt.data.id, "msg_1");
});

test("event 누락 — 기본 'message'", () => {
  const block = 'data: {"type":"foo"}';
  const evt = parseSSEBlock(block);
  assert.ok(evt);
  assert.equal(evt.event, "message");
  assert.equal(evt.data.type, "foo");
});

test("data 누락 — null 반환", () => {
  const block = "event: ping";
  const evt = parseSSEBlock(block);
  assert.equal(evt, null);
});

test("data 가 plain text (JSON 아님) — raw string 보존", () => {
  const block = "event: error\ndata: not json";
  const evt = parseSSEBlock(block);
  assert.ok(evt);
  assert.equal(evt.event, "error");
  assert.equal(evt.data, "not json");
});

test("data 가 여러 줄 — \\n 으로 join", () => {
  const block = 'event: text\ndata: line1\ndata: line2';
  const evt = parseSSEBlock(block);
  assert.ok(evt);
  // line1\nline2 가 JSON 아니므로 raw 로 보존
  assert.equal(evt.data, "line1\nline2");
});

test("content_block_start type=tool_use — 봇이 sub-tool 추적하는 케이스", () => {
  const block =
    'event: content_block_start\n' +
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"whatap_query_data","id":"toolu_xxx"}}';
  const evt = parseSSEBlock(block);
  assert.ok(evt);
  assert.equal(evt.event, "content_block_start");
  assert.equal(evt.data.content_block.type, "tool_use");
  assert.equal(evt.data.content_block.name, "whatap_query_data");
});

test("content_block_delta text_delta — 답변 텍스트 누적 케이스", () => {
  const block =
    'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"안녕"}}';
  const evt = parseSSEBlock(block);
  assert.ok(evt);
  assert.equal(evt.data.delta.text, "안녕");
});

test("message_stop with conversationId + recommendedQuestions + actions", () => {
  const block =
    'event: message_stop\n' +
    'data: {"type":"message_stop","conversationId":"conv_abc","recommendedQuestions":["q1","q2"],"actions":[{"type":"applyEventRules","label":"적용","payload":{"confirmToken":"ct_x"}}]}';
  const evt = parseSSEBlock(block);
  assert.ok(evt);
  assert.equal(evt.data.conversationId, "conv_abc");
  assert.deepEqual(evt.data.recommendedQuestions, ["q1", "q2"]);
  assert.equal(evt.data.actions[0].type, "applyEventRules");
  assert.equal(evt.data.actions[0].payload.confirmToken, "ct_x");
});

test("conversation_start — convId 발급", () => {
  const block =
    'event: conversation_start\n' +
    'data: {"type":"conversation_start","conversationId":"conv_new"}';
  const evt = parseSSEBlock(block);
  assert.ok(evt);
  assert.equal(evt.data.conversationId, "conv_new");
});

test("data: 뒤 공백 1 칸 trim", () => {
  const block = 'event: x\ndata:  {"a":1}';  // data: 뒤 공백 2개
  const evt = parseSSEBlock(block);
  assert.ok(evt);
  // trimStart 가 모든 leading 공백 제거하므로 JSON parse 성공
  assert.equal(evt.data.a, 1);
});

test("빈 block → null", () => {
  assert.equal(parseSSEBlock(""), null);
  assert.equal(parseSSEBlock("\n"), null);
});

// ── describeArgusSubTool drift detector ──

beforeEach(() => {
  __resetSubToolWarnings();
});

test("describeArgusSubTool — 알려진 도구 → 한국어 라벨", () => {
  assert.equal(describeArgusSubTool("whatap_query_data"), "데이터 쿼리");
  assert.equal(describeArgusSubTool("render_chart"), "차트 생성");
  assert.equal(describeArgusSubTool("docs_search"), "문서 검색");
});

test("describeArgusSubTool — unknown 이름 → raw name fallback + WARN", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    const out = describeArgusSubTool("whatap_brand_new_tool");
    assert.equal(out, "whatap_brand_new_tool");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unknown sub-tool.*whatap_brand_new_tool/);
    assert.match(warnings[0], /SUB_TOOL_DESC 매핑 추가/);
  } finally {
    console.warn = origWarn;
  }
});

test("describeArgusSubTool — 같은 unknown 이름 두 번째 → WARN 1회만", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    describeArgusSubTool("same_unknown");
    describeArgusSubTool("same_unknown");
    describeArgusSubTool("same_unknown");
    assert.equal(warnings.length, 1, "노이즈 방지로 1회만 WARN");
  } finally {
    console.warn = origWarn;
  }
});

test("describeArgusSubTool — 다른 unknown 이름은 각각 WARN", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    describeArgusSubTool("unknown_a");
    describeArgusSubTool("unknown_b");
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = origWarn;
  }
});

// ── 입구: 로그인 사용자의 질문도 /v1/chat ───────────────────────────────────
// argus 는 토큰용 입구(/v1/agent)와 토큰 검증을 없앴다. 봇은 front 의 /argus/v1/chat 에 사용자
// 토큰을 싣고, front 가 그 계정의 짧은 세션으로 바꿔 argus 에 넘긴다. 그래서 본문은 화면 채팅과
// 같은 모양이어야 한다. 실제 askWhatapExpertDirect 를 돌리고 전송(fetch)만 바꾼다.
async function captureRequest(
  cfg: Parameters<typeof askWhatapExpertDirect>[0],
  params: Parameters<typeof askWhatapExpertDirect>[1],
) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    seen.push({ url: String(input), headers: { ...(init?.headers ?? {}) }, body: JSON.parse(init?.body ?? "{}") });
    return new Response('event: message_stop\ndata: {"type":"message_stop","conversationId":"conv-1"}\n\n', { status: 200 });
  }) as typeof fetch;
  console.log = () => {};
  try {
    await askWhatapExpertDirect(cfg, params, () => {});
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(seen.length, 1);
  return seen[0];
}

test("로그인 사용자의 질문은 화면 채팅과 같은 /v1/chat 으로 가고, 자격은 사용자 토큰만 싣는다", async () => {
  const sent = await captureRequest(
    { url: "https://front.invalid/argus", apiToken: "", accessToken: "synthetic-access" },
    { query: "CPU 높은 파드 보여줘", pcode: 3396, conversationId: "conv-9" },
  );
  assert.equal(sent.url, "https://front.invalid/argus/v1/chat");
  assert.equal(sent.headers.Authorization, ["Bearer", "synthetic-access"].join(" "));
  assert.equal(sent.headers.Cookie, undefined);
  assert.deepEqual(sent.body, {
    message: "CPU 높은 파드 보여줘",
    pcode: 3396,
    conversationId: "conv-9",
    context: { client: "slack" },
  });
});

test("로그인 사용자의 질문에도 추론한 화면(currentUrl)을 싣는다", async () => {
  const sent = await captureRequest(
    { url: "https://front.invalid/argus", apiToken: "", accessToken: "synthetic-access" },
    { query: "CPU 높은 파드 보여줘", pcode: 3396, currentUrl: "/v2/project/cpm/3396/containerMap" },
  );
  assert.deepEqual(sent.body.context, { client: "slack", currentUrl: "/v2/project/cpm/3396/containerMap" });
});

// ── render_options: argus 가 선택지를 tool_use 블록으로 보낸다 ──────────────
// 실제 askWhatapExpertDirect 를 돌리고 전송(fetch)만 바꾼다. argus 의 SSE 모양은
// internal/platform/wire/sse.go (ToolUseBlockStart · ToolInputJsonDelta · ToolBlockStop).
async function askWithStream(events: Array<[string, unknown]>) {
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  console.log = () => {};
  try {
    return await askWhatapExpertDirect(
      { url: "https://argus.invalid", apiToken: "", accessToken: "synthetic-access" },
      { query: "알림 삭제해줘" },
      () => {},
    );
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}
const optionsBlock = (index: number, ...partials: string[]): Array<[string, unknown]> => [
  ["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: "opt_call_1", name: "render_options", input: {} } }],
  ...partials.map((partial_json): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }]),
  ["content_block_stop", { type: "content_block_stop", index }],
];
const textDelta = (index: number, text: string): [string, unknown] =>
  ["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }];

test("render_options 의 선택지를 결과에 싣고, 글보다 먼저 왔음을 알린다", async () => {
  const r = await askWithStream([
    ...optionsBlock(0, '{"options":["K8s-GPU (3396)","demo (5490)"]}'),
    textDelta(1, "위 버튼에서 프로젝트를 선택해 주세요."),
    ["message_stop", { type: "message_stop", conversationId: "conv-1" }],
  ]);
  assert.deepEqual(r.options, [
    { label: "K8s-GPU (3396)", value: "K8s-GPU (3396)" },
    { label: "demo (5490)", value: "demo (5490)" },
  ]);
  assert.equal(r.optionsBeforeText, true);
  assert.equal(r.text, "위 버튼에서 프로젝트를 선택해 주세요.");
  assert.equal(r.conversationId, "conv-1");
});

test("글 뒤에 온 선택지는 optionsBeforeText=false, {label,value} 꼴과 조각난 JSON 도 받는다", async () => {
  const r = await askWithStream([
    textDelta(0, "어떤 대시보드를 만들까요?"),
    ...optionsBlock(1, '{"options":[{"label":"성능","va', 'lue":"성능 대시보드 만들어줘"},"직접 입력할게"]}'),
    ["message_stop", { type: "message_stop" }],
  ]);
  assert.deepEqual(r.options, [
    { label: "성능", value: "성능 대시보드 만들어줘" },
    { label: "직접 입력할게", value: "직접 입력할게" },
  ]);
  assert.equal(r.optionsBeforeText, false);
});

test("읽을 수 없는 선택지·빈 값·중복·다른 도구의 입력은 선택지가 아니다", async () => {
  const otherTool: Array<[string, unknown]> = [
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "whatap_query_data", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"options":["도구 인자일 뿐"]}' } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ];
  const broken = await askWithStream([...otherTool, ...optionsBlock(1, '{"options":["A"'), textDelta(2, "답변")]);
  assert.equal(broken.options, undefined);
  assert.equal(broken.optionsBeforeText, undefined);

  const cleaned = await askWithStream([
    ...optionsBlock(0, '{"options":["A","  ","A",{"label":"B"},{"value":""},7,null]}'),
    ...optionsBlock(1, '{"options":["A","C"]}'),
  ]);
  assert.deepEqual(cleaned.options, [
    { label: "A", value: "A" },
    { label: "B", value: "B" },
    { label: "C", value: "C" },
  ]);
});

test("블록을 닫는 이벤트 없이 끝난 스트림의 선택지도 쓴다", async () => {
  const r = await askWithStream(optionsBlock(0, '{"options":["A","B"]}').slice(0, 2));
  assert.deepEqual(r.options?.map((o) => o.value), ["A", "B"]);
});

test("실제 argus 스트림 모양 (2026-11-12 로컬 argus 캡처, id 만 바꿈)", async () => {
  // 선택지는 도구 상태 이벤트(block_delta 의 params.options)에도 한 번 더 실려 온다 — 두 번 세지 않는다.
  const r = await askWithStream([
    ["conversation_start", { conversationId: "conv-real", type: "conversation_start" }],
    ["message_start", { message: { content: [], id: "msg_1", model: "argus-v1", role: "assistant" }, type: "message_start" }],
    ["block_delta", { callId: "call_1", delta: { params: { options: ["성능", "리소스", "에러"] }, status: "completed", type: "block_delta" }, type: "block_delta" }],
    ["content_block_start", { content_block: { id: "opt_call_1", input: {}, name: "render_options", type: "tool_use" }, index: 0, type: "content_block_start" }],
    ["content_block_delta", { delta: { partial_json: '{"options":["성능","리소스","에러"]}', type: "input_json_delta" }, index: 0, type: "content_block_delta" }],
    ["content_block_stop", { index: 0, type: "content_block_stop" }],
    ["content_block_start", { content_block: { text: "", type: "text" }, index: 1, type: "content_block_start" }],
    ...["분", "석", " 방향", "을", " 선택", "해", " 주세요", "."].map((text) => textDelta(1, text)),
    ["content_block_stop", { index: 1, type: "content_block_stop" }],
    ["message_stop", { conversationId: "conv-real", recommendedQuestions: ["성능 분석", "리소스 분석", "에러 분석"], type: "message_stop" }],
  ]);
  assert.equal(r.text, "분석 방향을 선택해 주세요.");
  assert.deepEqual(r.options?.map((o) => o.value), ["성능", "리소스", "에러"]);
  assert.equal(r.optionsBeforeText, true);
  assert.deepEqual(r.recommendedQuestions, ["성능 분석", "리소스 분석", "에러 분석"]);
});

test("argus 의 error 이벤트는 종류(code)를 가진 오류로 던진다", async () => {
  // 실제 모양 (2026-11-12 로컬 argus 캡처: 모르는 conversationId 를 보냈을 때).
  await assert.rejects(
    askWithStream([["error", { error: { message: "A temporary error occurred while generating a response.", title: "", type: "NOT_FOUND" }, type: "error" }]]),
    (err: unknown) => {
      assert.ok(err instanceof ArgusStreamError);
      assert.equal(err.code, "NOT_FOUND");
      assert.equal(err.message, "argus error [NOT_FOUND]: A temporary error occurred while generating a response.");
      return true;
    },
  );
  // 예전 모양 { code, message } 도 받는다.
  await assert.rejects(
    askWithStream([["error", { code: "RATE_LIMITED", message: "slow down" }]]),
    (err: unknown) => err instanceof ArgusStreamError && err.code === "RATE_LIMITED" && err.message === "argus error [RATE_LIMITED]: slow down",
  );
  // 모르는 모양은 받은 그대로 보여 준다.
  await assert.rejects(
    askWithStream([["error", { reason: "quota" }]]),
    (err: unknown) => err instanceof ArgusStreamError && err.code === "ARGUS_ERROR" && err.message === 'argus error [ARGUS_ERROR]: {"reason":"quota"}',
  );
});

