import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizationKind, createBotDmGuard } from "./dm-guard.js";

function slackError(error: string) {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });
}

function infoClient(answer: (channel: string) => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    conversations: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      info: async ({ channel }: { channel: string }): Promise<any> => {
        calls.push(channel);
        return answer(channel);
      },
    },
  };
}

const BOT = [{ team_id: "T1", user_id: "UBOT", is_bot: true }];
const USER = [{ team_id: "T1", user_id: "U1", is_bot: false }];

test("a DM the bot installation can see is accepted without a Web API call", async () => {
  const guard = createBotDmGuard();
  const client = infoClient(async () => { throw new Error("must not be called"); });
  assert.deepEqual(
    await guard({ teamId: "T1", channel: "D1", authorizations: BOT, client }),
    { ok: true, via: "bot-authorization" },
  );
  assert.equal(client.calls.length, 0);
});

test("a DM seen only through a user token is rejected when the bot is not in it, and the answer is cached", async () => {
  const guard = createBotDmGuard();
  const client = infoClient(async () => { throw slackError("channel_not_found"); });
  const input = { teamId: "T1", channel: "DOTHER", authorizations: USER, client };
  assert.deepEqual(await guard(input), { ok: false, reason: "bot-not-in-conversation" });
  assert.deepEqual(await guard(input), { ok: false, reason: "bot-not-in-conversation" });
  assert.equal(client.calls.length, 1, "IM membership never changes, so one check is enough");
});

test("the bot's own DM reported with a user authorization is accepted after a membership check", async () => {
  const guard = createBotDmGuard();
  const client = infoClient(async (channel) => ({ ok: true, channel: { id: channel, is_im: true, user: "U1" } }));
  const input = { teamId: "T1", channel: "D1", authorizations: USER, client };
  assert.deepEqual(await guard(input), { ok: true, via: "membership" });
  assert.deepEqual(await guard(input), { ok: true, via: "cache" });
  assert.equal(client.calls.length, 1);
});

test("a conversation that is not an IM is rejected", async () => {
  const guard = createBotDmGuard();
  const client = infoClient(async (channel) => ({ ok: true, channel: { id: channel, is_im: false } }));
  assert.deepEqual(
    await guard({ teamId: "T1", channel: "G1", authorizations: USER, client }),
    { ok: false, reason: "not-im" },
  );
});

test("a failed membership check fails closed and is retried on the next message", async () => {
  const guard = createBotDmGuard();
  let failing = true;
  const client = infoClient(async (channel) => {
    if (failing) throw slackError("missing_scope");
    return { ok: true, channel: { id: channel, is_im: true } };
  });
  const input = { teamId: "T1", channel: "D1", client };
  assert.deepEqual(await guard(input), { ok: false, reason: "membership-check-failed:missing_scope" });
  failing = false;
  assert.deepEqual(await guard(input), { ok: true, via: "membership" });
  assert.equal(client.calls.length, 2, "a transient failure must not be cached");
});

test("cached answers are scoped to the workspace and bounded", async () => {
  const guard = createBotDmGuard(2);
  const client = infoClient(async (channel) => ({ ok: true, channel: { id: channel, is_im: true } }));
  for (const [teamId, channel] of [["T1", "D1"], ["T2", "D1"], ["T1", "D2"], ["T1", "D1"]]) {
    await guard({ teamId, channel, authorizations: USER, client });
  }
  assert.deepEqual(client.calls, ["D1", "D1", "D2", "D1"], "T2:D1 is a separate entry and the oldest entry is evicted");
});

test("authorizationKind reports which installation Slack chose", () => {
  assert.equal(authorizationKind(BOT), "bot");
  assert.equal(authorizationKind(USER), "user");
  assert.equal(authorizationKind([]), "none");
  assert.equal(authorizationKind(undefined), "none");
});
