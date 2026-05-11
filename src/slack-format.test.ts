// src/slack-format.test.ts
//
// toSlackMrkdwn / splitForSlack 회귀 가드. argus 가 표준 Markdown 으로 응답하는데
// Slack 은 mrkdwn 만 지원해서 변환이 핵심. 표는 코드블록으로, [text](url) 은
// <url|text> 로, **bold** 는 *bold* 로, ## 헤딩은 *헤딩* 으로 등.

import assert from "node:assert/strict";
import { test } from "node:test";

import { splitForSlack, toSlackMrkdwn } from "./slack-format.js";

test("**bold** → *bold*", () => {
  assert.equal(toSlackMrkdwn("**hello**"), "*hello*");
});

test("[text](url) → <url|text>", () => {
  assert.equal(
    toSlackMrkdwn("[프로젝트](https://example.com/pcode/3396)"),
    "<https://example.com/pcode/3396|프로젝트>",
  );
});

test("## H2 → *H2*", () => {
  assert.equal(toSlackMrkdwn("## 컨테이너 분석"), "*컨테이너 분석*");
});

test("### H3 도 → *H3*", () => {
  assert.equal(toSlackMrkdwn("### 세부 항목"), "*세부 항목*");
});

test("표 → 코드블록으로 자동 변환", () => {
  const md = [
    "| pcode | name |",
    "|-------|------|",
    "| 3396  | gpu  |",
    "",
  ].join("\n");
  const out = toSlackMrkdwn(md);
  assert.match(out, /^```/m, "코드블록 시작 마커가 있어야");
  assert.match(out, /pcode/, "표 내용은 보존");
  assert.match(out, /3396/);
});

test("inline `code` 는 그대로 보존", () => {
  assert.equal(toSlackMrkdwn("실행: `pnpm dev`"), "실행: `pnpm dev`");
});

test("코드 펜스 ```...``` 그대로 보존", () => {
  const md = "```\nconst x = 1;\n```";
  assert.equal(toSlackMrkdwn(md), md);
});

test("리스트 - item 그대로 보존", () => {
  const md = "- 첫째\n- 둘째\n- 셋째";
  assert.equal(toSlackMrkdwn(md), md);
});

test("복합 — 헤딩 + bold + link 한 번에", () => {
  const md = "## 결과\n\n**3개** 프로젝트, 자세히: [링크](https://x.com)";
  const out = toSlackMrkdwn(md);
  assert.match(out, /\*결과\*/);
  assert.match(out, /\*3개\*/);
  assert.match(out, /<https:\/\/x\.com\|링크>/);
});

test("splitForSlack — 짧은 텍스트는 단일 chunk", () => {
  assert.deepEqual(splitForSlack("hello world"), ["hello world"]);
});

test("splitForSlack — 3500자 초과 시 분할", () => {
  const long = "가".repeat(4000);
  const chunks = splitForSlack(long);
  assert.ok(chunks.length > 1, "여러 chunk 로 분할되어야");
  for (const c of chunks) {
    assert.ok(c.length <= 3500, `각 chunk 는 3500 자 이하: actual ${c.length}`);
  }
  // 합치면 원본과 같아야 (newline 손실 가능, 여기선 newline 없는 입력)
  assert.equal(chunks.join(""), long);
});

test("splitForSlack — newline 경계 우선 분할", () => {
  // 3000자 + \n + 3000자 = 두 chunk 로 (newline 경계에서 잘림)
  const a = "a".repeat(3000);
  const b = "b".repeat(3000);
  const chunks = splitForSlack(`${a}\n${b}`);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], a);
  assert.equal(chunks[1], b);
});
