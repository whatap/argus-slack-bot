// src/oauth-settings.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadWhatapOAuthSettings } from "./whatap-oauth.js";

const FULL = {
  WHATAP_OAUTH_ISSUER: "http://localhost:18080",
  WHATAP_OAUTH_CLIENT_ID: "argus-slack-bot-local",
  WHATAP_OAUTH_CLIENT_SECRET: "secret",
  WHATAP_OAUTH_REDIRECT_URI: "http://localhost:3901/oauth/callback",
  SLACK_TOKENS_ENCRYPTION_KEY: "k",
  ARGUS_URL: "http://localhost:8091",
};

test("와탭 로그인 설정이 하나도 없으면 기존 방식(null)", () => {
  assert.equal(loadWhatapOAuthSettings({}), null);
});

test("일부만 있으면 빠진 이름을 알려 주며 시작하지 않는다", () => {
  assert.throws(
    () =>
      loadWhatapOAuthSettings({
        WHATAP_OAUTH_ISSUER: FULL.WHATAP_OAUTH_ISSUER,
        WHATAP_OAUTH_CLIENT_ID: FULL.WHATAP_OAUTH_CLIENT_ID,
      }),
    /WHATAP_OAUTH_CLIENT_SECRET, WHATAP_OAUTH_REDIRECT_URI/,
  );
});

test("토큰 암호화 키와 ARGUS_URL 이 없으면 시작하지 않는다", () => {
  assert.throws(
    () => loadWhatapOAuthSettings({ ...FULL, SLACK_TOKENS_ENCRYPTION_KEY: "" }),
    /SLACK_TOKENS_ENCRYPTION_KEY/,
  );
  assert.throws(() => loadWhatapOAuthSettings({ ...FULL, ARGUS_URL: "" }), /ARGUS_URL/);
});

test("콜백 경로는 /oauth/callback 이어야 한다", () => {
  assert.throws(
    () =>
      loadWhatapOAuthSettings({
        ...FULL,
        WHATAP_OAUTH_REDIRECT_URI: "http://localhost:3901/callback",
      }),
    /\/oauth\/callback/,
  );
});

test("기본값: scope, 콜백 주소의 포트, 127.0.0.1", () => {
  const s = loadWhatapOAuthSettings(FULL);
  assert.ok(s);
  assert.deepEqual(s.oauth, {
    issuer: "http://localhost:18080",
    clientId: "argus-slack-bot-local",
    clientSecret: "secret",
    redirectUri: "http://localhost:3901/oauth/callback",
    scope: "openid profile email whatap:read",
  });
  assert.equal(s.listenPort, 3901);
  assert.equal(s.listenHost, "127.0.0.1");
});

test("공개 HTTPS 콜백이면 리슨 포트는 WHATAP_OAUTH_PORT 를 쓴다", () => {
  const s = loadWhatapOAuthSettings({
    ...FULL,
    WHATAP_OAUTH_REDIRECT_URI: "https://bot.example.com/oauth/callback",
    WHATAP_OAUTH_PORT: "8443",
    WHATAP_OAUTH_LISTEN_HOST: "0.0.0.0",
    WHATAP_OAUTH_SCOPE: "openid whatap:read",
  });
  assert.equal(s?.listenPort, 8443);
  assert.equal(s?.listenHost, "0.0.0.0");
  assert.equal(s?.oauth.scope, "openid whatap:read");
  assert.throws(
    () =>
      loadWhatapOAuthSettings({
        ...FULL,
        WHATAP_OAUTH_REDIRECT_URI: "https://bot.example.com/oauth/callback",
      }),
    /WHATAP_OAUTH_PORT/,
  );
});
