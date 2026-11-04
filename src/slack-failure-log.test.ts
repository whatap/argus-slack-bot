import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackFailureHandler, describeSlackFailure } from "./slack-failure-log.js";

const AT = new Date("2026-11-04T03:04:05.678Z");

function platformError(error: string) {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });
}

test("event failures record time, workspace, channel and Slack error without message text", () => {
  const line = describeSlackFailure(platformError("channel_not_found"), {
    type: "event_callback",
    team_id: "T1",
    event: { type: "message", channel: "D9", channel_type: "im", text: "private question", user: "U1", ts: "1.0" },
  }, AT);
  assert.equal(
    line,
    "at=2026-11-04T03:04:05.678Z team=T1 channel=D9 channel_type=im thread=no kind=event:message code=slack_webapi_platform_error slack_error=channel_not_found",
  );
});

test("action failures read the channel and thread from the interaction payload", () => {
  const line = describeSlackFailure(new TypeError("boom"), {
    type: "block_actions",
    team: { id: "T2" },
    channel: { id: "C5" },
    message: { ts: "2.0", thread_ts: "1.0", text: "private answer" },
  }, AT);
  assert.equal(
    line,
    "at=2026-11-04T03:04:05.678Z team=T2 channel=C5 channel_type=- thread=yes kind=block_actions code=- slack_error=-",
  );
});

test("the failure handler logs context with the stack and rethrows the same error", async () => {
  const lines: string[] = [];
  const handler = createSlackFailureHandler((...args) => { lines.push(args.map(String).join(" ")); });
  const error = platformError("channel_not_found");
  await assert.rejects(
    handler({ error, body: { type: "event_callback", team_id: "T1", event: { type: "message", channel: "D9", text: "private question" } } }),
    (thrown) => thrown === error,
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[argus-slack-bot\] slack handler failed at=\d{4}-\d{2}-\d{2}T/);
  assert.match(lines[0], /channel=D9 /);
  assert.match(lines[0], /An API error occurred: channel_not_found\n\s+at /, "keep the stack for diagnosis");
  assert.doesNotMatch(lines[0], /private question/);
});
