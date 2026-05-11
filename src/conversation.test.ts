// src/conversation.test.ts
//
// ThreadHistory SQLite 백킹 회귀 가드. 핵심:
//   - get/appendTurn 기본 동작
//   - orphan tool_result 첫 메시지 자동 제거
//   - turn cap 초과 시 오래된 것부터 drop
//   - setArgusConvId 첫 호출만 set
//   - close 후 재오픈 시 데이터 영속 (in-memory → SQLite 의 핵심 가치)

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ThreadHistory } from "./conversation.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-bot-test-"));
  dbPath = join(tmpDir, "th.sqlite");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("새 thread → 빈 history", () => {
  const th = new ThreadHistory(10, 30 * 60 * 1000, dbPath);
  try {
    const s = th.get("C1:1.0");
    assert.equal(s.history.length, 0);
    assert.equal(s.argusConversationId, undefined);
  } finally {
    th.close();
  }
});

test("appendTurn → get 으로 동일 메시지 복원", () => {
  const th = new ThreadHistory(10, 30 * 60 * 1000, dbPath);
  try {
    th.appendTurn("C1:1.0", [
      { role: "user", content: "안녕" },
      { role: "assistant", content: "반갑습니다." },
    ]);
    const s = th.get("C1:1.0");
    assert.equal(s.history.length, 2);
    assert.equal(s.history[0].role, "user");
    assert.equal(s.history[0].content, "안녕");
    assert.equal(s.history[1].role, "assistant");
    assert.equal(s.history[1].content, "반갑습니다.");
  } finally {
    th.close();
  }
});

test("SQLite 영속 — close 후 재오픈해도 history 유지", () => {
  const th1 = new ThreadHistory(10, 30 * 60 * 1000, dbPath);
  th1.appendTurn("C1:1.0", [
    { role: "user", content: "첫 질문" },
  ]);
  th1.close();

  // 새 인스턴스로 재오픈 (== 봇 재시작)
  const th2 = new ThreadHistory(10, 30 * 60 * 1000, dbPath);
  try {
    const s = th2.get("C1:1.0");
    assert.equal(s.history.length, 1);
    assert.equal(s.history[0].content, "첫 질문");
  } finally {
    th2.close();
  }
});

test("orphan 첫 메시지 (tool_result only user) 자동 제거", () => {
  const th = new ThreadHistory(10, 30 * 60 * 1000, dbPath);
  try {
    // 일부러 orphan 만들기 — user(tool_result) 가 시작.
    // 실제 운영에선 cap slicing 후 발생할 패턴.
    th.appendTurn("C1:1.0", [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "abc", content: "result" },
        ],
      },
      { role: "assistant", content: "정상 응답" },
    ]);
    const s = th.get("C1:1.0");
    // orphan first 제거되어 첫 메시지는 assistant
    assert.equal(s.history.length, 1);
    assert.equal(s.history[0].role, "assistant");
  } finally {
    th.close();
  }
});

test("연속 orphan 도 제거", () => {
  const th = new ThreadHistory(10, 30 * 60 * 1000, dbPath);
  try {
    th.appendTurn("C1:1.0", [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "r1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "r2" }] },
      { role: "assistant", content: "ok" },
    ]);
    const s = th.get("C1:1.0");
    assert.equal(s.history.length, 1);
    assert.equal(s.history[0].role, "assistant");
  } finally {
    th.close();
  }
});

test("turn cap — maxTurns*4 초과 시 오래된 것부터 drop", () => {
  // maxTurns=2 → cap 8. 12개 push 하면 마지막 8개만 남음.
  const th = new ThreadHistory(2, 30 * 60 * 1000, dbPath);
  try {
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg-${i}`,
    }));
    th.appendTurn("C1:1.0", msgs);
    const s = th.get("C1:1.0");
    assert.equal(s.history.length, 8);
    // 마지막 8개 (msg-4 ~ msg-11)
    assert.equal(s.history[0].content, "msg-4");
    assert.equal(s.history[7].content, "msg-11");
  } finally {
    th.close();
  }
});

test("setArgusConvId 첫 호출만 set — 두 번째 호출은 무시", () => {
  const th = new ThreadHistory(10, 30 * 60 * 1000, dbPath);
  try {
    th.appendTurn("C1:1.0", [{ role: "user", content: "q" }]);
    th.setArgusConvId("C1:1.0", "conv_first");
    th.setArgusConvId("C1:1.0", "conv_second");  // 무시
    const s = th.get("C1:1.0");
    assert.equal(s.argusConversationId, "conv_first");
  } finally {
    th.close();
  }
});

test("reset → history + meta 모두 삭제", () => {
  const th = new ThreadHistory(10, 30 * 60 * 1000, dbPath);
  try {
    th.appendTurn("C1:1.0", [{ role: "user", content: "q" }]);
    th.setArgusConvId("C1:1.0", "conv_x");
    th.reset("C1:1.0");
    const s = th.get("C1:1.0");
    assert.equal(s.history.length, 0);
    assert.equal(s.argusConversationId, undefined);
  } finally {
    th.close();
  }
});

test("다른 thread 끼리 격리", () => {
  const th = new ThreadHistory(10, 30 * 60 * 1000, dbPath);
  try {
    th.appendTurn("C1:1.0", [{ role: "user", content: "thread A" }]);
    th.appendTurn("C2:2.0", [{ role: "user", content: "thread B" }]);
    assert.equal(th.get("C1:1.0").history[0].content, "thread A");
    assert.equal(th.get("C2:2.0").history[0].content, "thread B");
  } finally {
    th.close();
  }
});

test("idle 만료 thread 는 gc 됨", () => {
  // idleMs 1ms 로 만들어 gc 강제 발동
  const th = new ThreadHistory(10, 1, dbPath);
  try {
    th.appendTurn("C1:1.0", [{ role: "user", content: "old" }]);
    // 잠시 기다린 후 다른 thread 의 get() 호출 시 gc 발동
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* busy wait 10ms */
    }
    th.get("C2:2.0");  // gc 트리거
    // C1 은 idle 1ms 지났으니 삭제됨
    const s = th.get("C1:1.0");
    assert.equal(s.history.length, 0);
  } finally {
    th.close();
  }
});
