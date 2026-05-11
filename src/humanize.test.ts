// src/humanize.test.ts
//
// humanizeError 의 패턴 매칭 회귀 가드. 새 에러 패턴 추가 시 여기에도 case 추가.

import assert from "node:assert/strict";
import { test } from "node:test";

import { humanizeError } from "./humanize.js";

test("argus 401 → cookie 갱신 안내", () => {
  const msg = humanizeError(new Error("argus /v1/chat error (401): unauthorized"));
  assert.match(msg, /cookie 만료\/미등록/);
  assert.match(msg, /DM 으로 `cookie/);
});

test("argus 403 → 권한 안내", () => {
  const msg = humanizeError(new Error("argus /v1/chat error (403): forbidden"));
  assert.match(msg, /권한 없음/);
});

test("argus 5xx → 일시 장애 안내", () => {
  const msg = humanizeError(new Error("argus /v1/chat error (503): unavailable"));
  assert.match(msg, /서버 에러 \(503\)/);
});

test("WhaTap API token 무효 → register 재안내", () => {
  const msg = humanizeError(new Error("[F] Invalid token: xxx"));
  assert.match(msg, /WhaTap API token/);
  assert.match(msg, /register <new-token>/);
});

test("WhaTap API token (대소문자/공백 변형) 매칭", () => {
  const msg = humanizeError(new Error("Invalid WhaTap API token provided"));
  assert.match(msg, /WhaTap API token/);
});

test("ECONNREFUSED → 도달 불가 안내", () => {
  const msg = humanizeError(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8090"));
  assert.match(msg, /도달 불가/);
});

test("ETIMEDOUT → 도달 불가 안내", () => {
  const msg = humanizeError(new Error("connect ETIMEDOUT 1.2.3.4:443"));
  assert.match(msg, /도달 불가/);
});

test("MCP stdio 에러 → 자식 프로세스 안내", () => {
  const msg = humanizeError(new Error("MCP stdio transport closed unexpectedly"));
  assert.match(msg, /whatap-mcp 자식 프로세스/);
});

test("Anthropic rate limit → 재시도 안내", () => {
  const msg = humanizeError(new Error("429: rate_limit_error"));
  assert.match(msg, /Anthropic API 부하/);
});

test("Anthropic overloaded → 재시도 안내", () => {
  const msg = humanizeError(new Error("Anthropic API: overloaded"));
  assert.match(msg, /Anthropic API 부하/);
});

test("매칭 안 됨 → :warning: fallback + raw msg 보존", () => {
  const msg = humanizeError(new Error("something completely unexpected"));
  assert.match(msg, /:warning:/);
  assert.match(msg, /something completely unexpected/);
});

test("Error 가 아닌 throw 도 안전 처리", () => {
  const msg = humanizeError("plain string error");
  assert.match(msg, /:warning:/);
  assert.match(msg, /plain string error/);
});

test("null/undefined 도 crash 없이 처리", () => {
  const msg = humanizeError(null);
  assert.match(msg, /:warning:/);
});

test("순서 우선순위: HTTP status 가 다른 패턴보다 우선", () => {
  // 메시지에 'fetch failed' 가 있어도 HTTP 401 매칭이 먼저.
  const msg = humanizeError(
    new Error("argus /v1/chat error (401): fetch failed somewhere"),
  );
  assert.match(msg, /argus 인증 실패/);
  assert.doesNotMatch(msg, /도달 불가/);
});
