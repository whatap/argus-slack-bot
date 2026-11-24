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

test("public landing leads with alert triage, alert rule changes and remediation, each gated by a button press", () => {
  const html = landingPageHtml();
  for (const pillar of ["알림 확인", "알림 설정", "조치"]) assert.ok(html.includes(pillar), `핵심 기능 누락: ${pillar}`);
  assert.match(html, /\[적용\]/);
  assert.match(html, /조치 실행/);
  assert.match(html, /버튼을 눌러야/);
  // 서버 조치는 OPM 이 연결된 환경에서만 된다. 조건 없이 약속하지 않는다.
  assert.match(html, /OPM/);
  // 알림 채널 자동 대응은 설치만으로 켜지지 않는다(전용 앱·서버 설정). 문의 기능으로 적는다.
  assert.match(html, /자동 대응[\s\S]*문의/);
});

test("public landing labels its sample conversation and ships no internal sample data or external assets", () => {
  const html = landingPageHtml();
  assert.ok(html.includes('href="/slack/install"'));
  assert.match(html, /예시 화면/);
  assert.match(html, /채널.*모든 사람/);
  // 예시 대화는 합성 데이터만 쓴다. 실제 프로젝트 번호·파드 이름 모양을 다시 싣지 않는다.
  assert.doesNotMatch(html, /pcode:?\s*\d+|\d{4,}\s*프로젝트|inference-[0-9a-f]+|변수 치환/);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=|<link\b[^>]*stylesheet|@import|fonts\.googleapis/);
});

test("privacy draft documents OAuth tokens and separates local deletion from upstream retention", () => {
  const html = privacyPageHtml();
  assert.match(html, /refresh token/);
  assert.match(html, /초안/);
  assert.match(html, /Argus.*보관/);
  assert.doesNotMatch(html, /register &lt;token&gt;|cookie &lt;JSESSIONID/);
  assert.match(termsPageHtml(), /정확성/);
});
