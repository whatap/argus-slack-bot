import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SLACK_BOT_SCOPES } from "./slack-app.js";

test("HTTP manifest matches runtime least scopes and enables only implemented bot surfaces", () => {
  const manifest = JSON.parse(readFileSync(new URL("../slack-manifest.http.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.oauth_config.scopes.bot, SLACK_BOT_SCOPES);
  assert.equal(manifest.oauth_config.scopes.user, undefined);
  assert.equal(manifest.oauth_config.scopes.user_optional, undefined);
  assert.equal(manifest.settings.socket_mode_enabled, false);
  assert.equal(manifest.settings.is_mcp_enabled, false);
  assert.equal(manifest.features.app_home.home_tab_enabled, false);
  assert.equal(manifest.features.app_home.messages_tab_enabled, true);
  assert.equal(manifest.features.app_home.messages_tab_read_only_enabled, false);
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ["app_mention", "message.im", "app_uninstalled", "tokens_revoked"]);
  assert.equal(manifest.settings.event_subscriptions.user_events, undefined);
  assert.equal(new URL(manifest.settings.event_subscriptions.request_url).pathname, "/slack/events");
  assert.equal(manifest.settings.interactivity.request_url, manifest.settings.event_subscriptions.request_url);
  assert.equal(new URL(manifest.oauth_config.redirect_urls[0]).pathname, "/slack/oauth_redirect");
  assert.match(manifest.display_information.long_description, /와탭 계정.*로그인/);
  assert.match(manifest.display_information.long_description, /부정확/);
  assert.doesNotMatch(manifest.display_information.long_description, /40\+|14개|API 토큰|적용.*취소/);
});
