import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNT_SETUP_GUIDANCE, WHATAP_LOGIN_HELP } from "./onboarding.js";

test("Slack help and login guidance support users without a WhaTap account", () => {
  assert.match(ACCOUNT_SETUP_GUIDANCE, /계정이 없/);
  assert.match(ACCOUNT_SETUP_GUIDANCE, /가입.*초대/);
  assert.match(ACCOUNT_SETUP_GUIDANCE, /https:\/\/service\.whatap\.io/);
  assert.ok(WHATAP_LOGIN_HELP.includes(ACCOUNT_SETUP_GUIDANCE));
  for (const command of ["login", "whoami", "logout"]) assert.ok(WHATAP_LOGIN_HELP.includes(command));
  assert.doesNotMatch(WHATAP_LOGIN_HELP, /register <|JSESSIONID|API token/);
});
