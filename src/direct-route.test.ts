// src/direct-route.test.ts
//
// runDirectToArgus 가 argus 응답에서 받은 것을 handle() 이 쓰는 RunResult 로 넘기는지 본다.
// 실제 runDirectToArgus · askWhatapExpertDirect 를 돌리고 전송(fetch)만 바꾼다.

import assert from "node:assert/strict";
import { test } from "node:test";

import { runDirectToArgus } from "./direct-route.js";

async function runWithStream(events: Array<[string, unknown]>) {
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  console.log = () => {};
  try {
    return await runDirectToArgus(
      { argusDirect: { url: "https://argus.invalid", apiToken: "", accessToken: "synthetic-access" } },
      "알림 삭제해줘",
    );
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}

test("argus 의 선택지와 그 위치를 RunResult 로 넘긴다", async () => {
  const r = await runWithStream([
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "opt_1", name: "render_options", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"options":["sample (1234)"]}' } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "위 버튼에서 선택해 주세요." } }],
    ["message_stop", { type: "message_stop", conversationId: "conv-1" }],
  ]);
  assert.deepEqual(r.options, [{ label: "sample (1234)", value: "sample (1234)" }]);
  assert.equal(r.optionsBeforeText, true);
  assert.equal(r.argusConversationId, "conv-1");
});

test("선택지가 없는 답에는 options 가 없다", async () => {
  const r = await runWithStream([
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "답변" } }],
  ]);
  assert.equal(r.options, undefined);
  assert.equal(r.optionsBeforeText, undefined);
});
