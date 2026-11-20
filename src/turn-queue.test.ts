// src/turn-queue.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { TurnQueue } from "./turn-queue.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** enter 가 끝났는지 지켜본다. */
function watch(entering: Promise<() => void>) {
  const seen = { entered: false, leave: () => {} };
  const done = entering.then((leave) => {
    seen.entered = true;
    seen.leave = leave;
  });
  return { seen, done };
}

test("같은 대화의 다음 턴은 앞 턴이 끝난 뒤에 들어간다", async () => {
  const q = new TurnQueue(60_000);
  const leaveFirst = await q.enter("D1:dm#U1");
  const second = watch(q.enter("D1:dm#U1"));
  const third = watch(q.enter("D1:dm#U1"));
  await tick();
  assert.equal(second.seen.entered, false, "the second turn waits for the first");

  leaveFirst();
  await second.done;
  await tick();
  assert.equal(third.seen.entered, false, "the third turn waits for the second, not just the first");

  second.seen.leave();
  await third.done;
  third.seen.leave();
  assert.equal(q.size, 0, "finished conversations leave nothing behind");
});

test("다른 대화는 기다리지 않는다", async () => {
  const q = new TurnQueue(60_000);
  const leaveA = await q.enter("D1:dm#U1");
  const other = watch(q.enter("D2:dm#U2"));
  await other.done;
  assert.equal(other.seen.entered, true);
  other.seen.leave();
  leaveA();
  assert.equal(q.size, 0);
});

test("앞 턴이 끝나지 않아도 정한 시간이 지나면 들어간다", async () => {
  const q = new TurnQueue(30);
  const leaveStuck = await q.enter("D1:dm#U1");
  const startedAt = Date.now();
  const next = watch(q.enter("D1:dm#U1"));
  await tick();
  assert.equal(next.seen.entered, false, "it does wait first");
  await next.done;
  assert.ok(Date.now() - startedAt >= 25, "it waited about the configured time");

  // 뒤늦게 끝난 앞 턴이 지금 턴의 자리를 지우지 않는다.
  leaveStuck();
  const after = watch(q.enter("D1:dm#U1"));
  await tick();
  assert.equal(after.seen.entered, false, "a later turn still waits for the one that is running");
  next.seen.leave();
  await after.done;
  after.seen.leave();
  assert.equal(q.size, 0);
});

test("끝났다는 표시는 여러 번 해도 된다", async () => {
  const q = new TurnQueue(60_000);
  const leave = await q.enter("k");
  leave();
  leave();
  const next = await q.enter("k");
  next();
  assert.equal(q.size, 0);
});
