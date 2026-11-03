import assert from "node:assert/strict";
import { test } from "node:test";
import { landingPageHtml } from "./landing.js";
import { privacyPageHtml, termsPageHtml } from "./legal.js";

test("public landing explains user OAuth, account creation and AI limitations instead of token pasting", () => {
  const html = landingPageHtml();
  assert.match(html, /login/);
  assert.match(html, /계정이 없/);
  assert.match(html, /가입|초대/);
  assert.match(html, /부정확/);
  for (const route of ["/privacy", "/terms", "/support"]) assert.ok(html.includes(`href="${route}"`));
  assert.doesNotMatch(html, /register &lt;token&gt;|14개|opus 4\.7|LLM 백엔드.*선택/);
});

test("privacy draft documents OAuth tokens and separates local deletion from upstream retention", () => {
  const html = privacyPageHtml();
  assert.match(html, /refresh token/);
  assert.match(html, /초안/);
  assert.match(html, /Argus.*보관/);
  assert.doesNotMatch(html, /register &lt;token&gt;|cookie &lt;JSESSIONID/);
  assert.match(termsPageHtml(), /정확성/);
});
