// src/argus-direct.test.ts
//
// parseSSEBlock 회귀 가드. argus 의 Anthropic Messages SSE 포맷 파싱이 핵심 —
// 한 줄 깨지면 모든 답변 무응답. consumeSSE 통합은 e2e 영역으로 별도.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSSEBlock } from "./argus-direct.js";

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
