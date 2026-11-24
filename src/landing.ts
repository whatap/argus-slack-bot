// src/landing.ts
//
// 랜딩 페이지 HTML — 봇의 OAuth installer 포트의 root path 에서 서빙.
// Slack App Directory 의 앱 소개 페이지 역할: 개요, Slack 안에서의 동작, 설치,
// 설치 후 할 일, 개인정보 링크, AI 답변 한계를 한 화면에 둔다.
// 핵심 기능(알림 확인·알림 설정·조치)을 먼저 보인다. 바꾸는 작업은 버튼을 눌러야 실행된다는 것과,
// 서버 조치(OPM 연결 환경)·알림 채널 자동 대응(설치만으로 켜지지 않음, 문의)의 조건을 같이 적는다.
// inline CSS 라 외부 의존 0. 흰 바탕에 whatap.io 의 파랑(#296cf2)·보라(#8b52ff)를 AI 강조색으로 쓴다.
// 예시 대화의 분석 과정은 봇의 진행 표시(composeStepStreamingBody)와 같은 모양이다: 도구 이름 (설명) · 소요 시간.

const SLACK_MARK = `<svg width="20" height="20" viewBox="0 0 122 122" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
            <path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9zM32.3 77.6a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 1 1-25.8 0V77.6z" fill="#E01E5A"/>
            <path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2zM45.2 32.3a12.9 12.9 0 1 1 0 25.8H12.9a12.9 12.9 0 1 1 0-25.8h32.3z" fill="#36C5F0"/>
            <path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2zM90.5 45.2a12.9 12.9 0 1 1-25.8 0V12.9a12.9 12.9 0 1 1 25.8 0v32.3z" fill="#2EB67D"/>
            <path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9zM77.6 90.5a12.9 12.9 0 1 1 0-25.8h32.3a12.9 12.9 0 1 1 0 25.8H77.6z" fill="#ECB22E"/>
          </svg>`;

/** Argus 를 나타내는 네 갈래 빛. fill 은 그라데이션(url(#ai-grad)) 또는 단색. */
function spark(className: string, fill = "url(#ai-grad)"): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 1.5c.7 5.6 4.9 9.8 10.5 10.5-5.6.7-9.8 4.9-10.5 10.5C11.3 16.9 7.1 12.7 1.5 12 7.1 11.3 11.3 7.1 12 1.5z" fill="${fill}"/></svg>`;
}

const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** 핵심 기능 아이콘(선 그림). currentColor 로 그린다. */
function icon(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}
const BELL = `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`;
const SLIDERS = `<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>`;
const WRENCH = `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`;
const ZAP = `<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>`;

function addToSlackButton(): string {
  return `<a class="btn-slack" href="/slack/install">
          ${SLACK_MARK}
          <span>Add to Slack</span>
        </a>`;
}

export function landingPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="theme-color" content="#ffffff" />
  <title>argus — Slack에서 와탭 알림 확인부터 조치까지</title>
  <meta name="description" content="Slack에서 와탭 알림을 확인하고, 알림 규칙을 만들고, 조치까지 이어 갑니다. 모든 조회와 변경은 내 와탭 권한 안에서 이뤄집니다." />
  <meta property="og:title" content="argus — Slack에서 와탭 알림 확인부터 조치까지" />
  <meta property="og:description" content="Slack에서 와탭 알림을 확인하고, 알림 규칙을 만들고, 조치까지 이어 갑니다. 모든 조회와 변경은 내 와탭 권한 안에서 이뤄집니다." />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #ffffff;
      --bg-soft: #f6f8fc;
      --ink: #0f172a;
      --ink-2: #3b4557;
      --muted: #667085;
      --line: #e6e9f0;
      --blue: #296cf2;
      --violet: #8b52ff;
      --ai: linear-gradient(100deg, #296cf2 0%, #8b52ff 100%);
      --ai-soft: linear-gradient(120deg, #eef4ff 0%, #f4efff 100%);
      --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    }
    html { scroll-behavior: smooth; }
    html, body {
      background: var(--bg);
      color: var(--ink);
      font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont,
                   "Apple SD Gothic Neo", "SF Pro KR", "Noto Sans KR", "Segoe UI", sans-serif;
      line-height: 1.6;
      word-break: keep-all;
      overflow-wrap: break-word;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; text-underline-offset: 3px; }
    a:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; border-radius: 6px; }
    p { text-wrap: pretty; }
    .container { max-width: 1140px; margin: 0 auto; padding: 0 24px; }
    .nw { white-space: nowrap; }
    .defs { position: absolute; width: 0; height: 0; overflow: hidden; }
    code {
      font-family: var(--mono);
      font-size: 0.86em;
      color: #3d3fd6;
      background: #f1f3ff;
      border: 1px solid #e2e5fb;
      border-radius: 6px;
      padding: 1px 6px;
      white-space: nowrap;
    }
    .grad { color: var(--blue); }
    @supports ((-webkit-background-clip: text) or (background-clip: text)) {
      .grad { background: var(--ai); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    }

    /* Header */
    .site-header { border-bottom: 1px solid var(--line); background: rgba(255, 255, 255, 0.92); position: relative; z-index: 2; }
    .site-header .container { display: flex; align-items: center; justify-content: space-between; gap: 24px; height: 64px; }
    .brand { display: flex; align-items: center; gap: 8px; color: var(--ink); }
    .brand:hover { text-decoration: none; }
    .brand .spark-brand { width: 20px; height: 20px; }
    .brand-mark { font-size: 21px; font-weight: 800; letter-spacing: -0.5px; }
    .brand-by { font-size: 13px; color: var(--muted); margin-left: 2px; }
    .nav { display: flex; gap: 28px; font-size: 14px; }
    .nav a { color: var(--ink-2); }
    .nav a:hover { color: var(--ink); text-decoration: none; }

    /* Buttons */
    .btn-slack {
      display: inline-flex; align-items: center; justify-content: center; gap: 12px;
      height: 50px; padding: 0 24px;
      background: var(--ink); color: #fff;
      border-radius: 10px;
      font-size: 16px; font-weight: 700;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.08), 0 8px 20px rgba(41, 108, 242, 0.18);
      transition: box-shadow 0.15s, transform 0.15s;
    }
    .btn-slack:hover { text-decoration: none; transform: translateY(-1px); box-shadow: 0 2px 4px rgba(16, 24, 40, 0.1), 0 14px 32px rgba(139, 82, 255, 0.24); }
    .link-arrow { color: var(--ink); font-weight: 600; font-size: 15px; }
    .link-arrow span { color: var(--muted); margin-left: 4px; }

    /* Hero */
    .hero { position: relative; overflow: hidden; padding: 84px 0 72px; }
    .hero::before {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      background-image: radial-gradient(#dfe4ef 1px, transparent 1px);
      background-size: 22px 22px;
      -webkit-mask-image: radial-gradient(ellipse 60% 70% at 72% 42%, #000 20%, transparent 75%);
      mask-image: radial-gradient(ellipse 60% 70% at 72% 42%, #000 20%, transparent 75%);
    }
    .hero .container {
      position: relative;
      display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.06fr);
      gap: 64px; align-items: center;
    }
    .badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 14px 6px 10px; margin-bottom: 22px;
      border: 1px solid transparent; border-radius: 999px;
      background: linear-gradient(#fff, #fff) padding-box, var(--ai) border-box;
      font-size: 13px; font-weight: 600; color: var(--ink-2);
    }
    .badge .spark-badge { width: 16px; height: 16px; }
    .hero h1 {
      font-size: clamp(36px, 4.8vw, 58px);
      font-weight: 800;
      letter-spacing: -0.035em;
      line-height: 1.16;
      margin-bottom: 22px;
    }
    .lede { font-size: 18px; color: var(--ink-2); max-width: 520px; margin-bottom: 34px; }
    .cta-row { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; }
    .assurances { list-style: none; display: flex; flex-direction: column; gap: 8px; margin-top: 28px; font-size: 14px; color: var(--ink-2); }
    .assurances li { display: inline-flex; align-items: center; gap: 6px; }
    .assurances svg { width: 16px; height: 16px; color: var(--blue); flex: none; }

    /* Slack conversation sample */
    .sample { position: relative; margin: 0; }
    .sample::before {
      content: ""; position: absolute; inset: -48px -36px; z-index: 0; pointer-events: none;
      background:
        radial-gradient(42% 46% at 28% 30%, rgba(41, 108, 242, 0.26), transparent 70%),
        radial-gradient(44% 48% at 78% 68%, rgba(139, 82, 255, 0.24), transparent 70%),
        radial-gradient(30% 34% at 62% 22%, rgba(34, 184, 230, 0.12), transparent 70%);
      filter: blur(28px);
    }
    .slack {
      position: relative; z-index: 1;
      border: 1px solid transparent; border-radius: 16px;
      background: linear-gradient(#fff, #fff) padding-box,
                  linear-gradient(135deg, rgba(41, 108, 242, 0.45), rgba(139, 82, 255, 0.45)) border-box;
      box-shadow: 0 24px 60px rgba(30, 41, 89, 0.14), 0 2px 6px rgba(30, 41, 89, 0.06);
      color: #1d1c1d;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", "Noto Sans KR", sans-serif;
    }
    .slack-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 20px; border-bottom: 1px solid #ececf1; }
    .slack-top b { font-size: 15px; }
    .slack-top .ch { font-size: 13px; color: #616061; margin-left: 6px; }
    .tag-example { font-size: 11px; font-weight: 700; color: #5b45d6; background: #f1edff; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
    .slack-body { padding: 6px 0 18px; }
    .msg { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 10px; padding: 10px 20px 2px; }
    .avatar { width: 36px; height: 36px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; color: #fff; }
    .avatar-user { background: #8a6a4b; }
    .avatar-bot { background: var(--ai); }
    .avatar-bot svg { width: 20px; height: 20px; }
    .msg-head { display: flex; align-items: baseline; gap: 6px; line-height: 1.3; margin-bottom: 3px; }
    .msg-head b { font-size: 15px; }
    .app-tag { font-size: 10px; font-weight: 700; color: #616061; background: #eeeeee; border-radius: 3px; padding: 1px 4px; }
    .msg-time { font-size: 12px; color: #616061; }
    .msg-text { font-size: 15px; line-height: 1.5; }
    .mention { color: #1264a3; background: #e8f5fa; border-radius: 3px; padding: 0 2px; }
    .trace { margin: 6px 0 12px; padding: 10px 12px 8px; border-radius: 10px; background: var(--ai-soft); border: 1px solid #e4e6fb; }
    .trace-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: #4b3fc4; margin-bottom: 6px; }
    .trace-head svg { width: 13px; height: 13px; }
    .trace ol { list-style: none; }
    .trace li { display: flex; align-items: center; gap: 8px; font-size: 13px; line-height: 1.9; color: #3b4557; }
    .trace li .ok { width: 16px; height: 16px; border-radius: 50%; background: #e3f4ea; color: #1f8a4c; display: inline-flex; align-items: center; justify-content: center; flex: none; }
    .trace li .ok svg { width: 11px; height: 11px; }
    .trace li .tool { font-family: var(--mono); font-size: 12px; color: #1d1c1d; }
    .trace li .desc { color: #667085; }
    .trace li .dur { margin-left: auto; font-family: var(--mono); font-size: 12px; color: #667085; }
    .answer ul { list-style: none; margin: 6px 0 2px; }
    .answer li { position: relative; padding-left: 16px; margin-bottom: 3px; }
    .answer li::before { content: "•"; position: absolute; left: 3px; color: #616061; }
    .answer .path { font-family: var(--mono); font-size: 13px; color: #c01343; background: #f6f6f6; border-radius: 3px; padding: 0 3px; }
    .slack-context { margin-top: 12px; font-size: 12px; color: #616061; }
    .slack-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .slack-btn { display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border: 1px solid rgba(29, 28, 29, 0.3); border-radius: 4px; font-size: 13px; font-weight: 700; white-space: nowrap; background: #fff; }
    .sample figcaption { position: relative; z-index: 1; margin-top: 16px; font-size: 13px; color: var(--muted); }
    .avatar-alert { background: #1d1c1d; font-size: 14px; }
    .alert-post { margin-top: 2px; padding: 8px 12px; border-left: 4px solid #e01e5a; background: #fff6f8; border-radius: 4px; font-size: 14px; line-height: 1.55; color: #3b3b3d; }
    .alert-post b { color: #b4123f; }
    .proposal { margin-top: 12px; padding: 10px 12px; border: 1px solid #e3e3e8; border-radius: 8px; font-size: 14px; line-height: 1.6; }
    .proposal-title { font-weight: 700; display: flex; align-items: center; gap: 6px; }
    .proposal-title svg { width: 15px; height: 15px; color: #616061; flex: none; }
    .proposal p { color: #3b4557; }
    .risk { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #2eb67d; margin: 0 5px 0 1px; }
    .slack-btn.primary { background: #007a5a; border-color: #007a5a; color: #fff; }

    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .trace li { animation: rise 0.45s ease both; }
    .trace li:nth-child(1) { animation-delay: 0.3s; }
    .trace li:nth-child(2) { animation-delay: 0.75s; }
    .trace li:nth-child(3) { animation-delay: 1.2s; }
    .answer, .proposal, .slack-context, .slack-actions { animation: rise 0.5s ease both; animation-delay: 1.65s; }

    /* Sections */
    .section { padding: 96px 0; }
    .section-soft { background: var(--bg-soft); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .eyebrow { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; color: var(--blue); margin-bottom: 12px; }
    .eyebrow svg { width: 14px; height: 14px; }
    .section h2 { font-size: clamp(28px, 3.2vw, 36px); font-weight: 800; letter-spacing: -0.03em; line-height: 1.25; margin-bottom: 14px; }
    .section-lede { font-size: 17px; color: var(--ink-2); max-width: 620px; }

    /* How it works */
    .pipeline { list-style: none; position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 28px; margin-top: 56px; }
    .pipeline::before {
      content: ""; position: absolute; top: 21px; left: 22px; right: calc(25% - 43px); height: 2px;
      background: linear-gradient(90deg, rgba(41, 108, 242, 0.45), rgba(139, 82, 255, 0.45));
    }
    .pipeline li { position: relative; }
    .node {
      position: relative; z-index: 1;
      width: 44px; height: 44px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      border: 2px solid transparent;
      background: linear-gradient(#fff, #fff) padding-box, var(--ai) border-box;
      font-family: var(--mono); font-weight: 700; font-size: 15px; color: #4b3fc4;
      box-shadow: 0 4px 14px rgba(41, 108, 242, 0.16);
      margin-bottom: 20px;
    }
    .pipeline h3 { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 8px; }
    .pipeline p { font-size: 15px; color: var(--ink-2); margin-bottom: 12px; }
    .hint { display: inline-block; font-family: var(--mono); font-size: 12px; color: var(--muted); background: var(--bg-soft); border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; }
    .prompts { margin-top: 56px; padding: 26px 28px; border-radius: 16px; border: 1px solid var(--line); background: #fff; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: center; }
    .prompts-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .chips { display: flex; flex-wrap: wrap; gap: 10px; }
    .chip { display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 999px; background: var(--bg-soft); border: 1px solid var(--line); font-size: 14px; color: var(--ink); }
    .chip svg { width: 14px; height: 14px; flex: none; }

    /* Core features */
    .features { list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin-top: 48px; }
    .feature {
      position: relative; overflow: hidden;
      display: flex; flex-direction: column;
      padding: 28px 26px 24px; border-radius: 18px;
      background: #fff; border: 1px solid var(--line);
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 12px 32px rgba(30, 41, 89, 0.06);
    }
    .feature::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: var(--ai); }
    .f-icon { width: 42px; height: 42px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex: none; background: var(--ai-soft); border: 1px solid #e4e6fb; color: #4b3fc4; margin-bottom: 18px; }
    .f-icon svg { width: 21px; height: 21px; }
    .feature h3 { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 8px; }
    .feature > p { font-size: 15px; color: var(--ink-2); margin-bottom: 18px; }
    .f-demo { margin-top: auto; padding: 12px 14px; border-radius: 12px; border: 1px solid #e4e6fb; background: linear-gradient(180deg, #fbfbff 0%, #ffffff 100%); font-size: 13px; color: var(--ink-2); }
    .f-q { color: var(--ink); font-weight: 600; margin-bottom: 8px; }
    .f-demo ul { list-style: none; }
    .f-demo li { position: relative; padding-left: 12px; line-height: 1.75; }
    .f-demo li::before { content: "·"; position: absolute; left: 2px; color: var(--muted); }
    .f-btns { display: flex; gap: 6px; margin-top: 10px; }
    .f-btns .slack-btn { height: 26px; padding: 0 10px; font-size: 12px; }
    .feature > p.f-note { margin: -8px 0 18px; font-size: 13px; color: var(--muted); }
    .integration { margin-top: 24px; display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; gap: 18px; align-items: center; padding: 22px 26px; border-radius: 16px; background: var(--ai-soft); border: 1px solid #e4e6fb; }
    .integration .f-icon { margin-bottom: 0; background: #fff; }
    .integration h3 { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 800; margin-bottom: 4px; }
    .integration p { font-size: 15px; color: var(--ink-2); }
    .integration .link-arrow { white-space: nowrap; font-size: 14px; }
    .tag-opt { font-size: 11px; font-weight: 700; color: #1f6f4c; background: #e3f4ea; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }

    /* Getting started */
    .start-grid { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 64px; align-items: start; }
    .account-note { margin-top: 32px; padding: 20px 22px; border-radius: 14px; background: #fff; border: 1px solid var(--line); }
    .account-note strong { display: block; font-size: 15px; margin-bottom: 6px; }
    .account-note p { font-size: 15px; color: var(--ink-2); }
    .timeline { list-style: none; }
        .timeline li { position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 18px; padding-bottom: 28px; }
    .timeline li:last-child { padding-bottom: 0; }
    .timeline li:not(:last-child)::before { content: ""; position: absolute; left: 17px; top: 36px; bottom: 0; width: 2px; background: linear-gradient(180deg, rgba(41, 108, 242, 0.4), rgba(139, 82, 255, 0.4)); }
    .t-num { position: relative; z-index: 1; width: 36px; height: 36px; border-radius: 50%; background: var(--ai); color: #fff; font-family: var(--mono); font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 5px var(--bg-soft); }
    .timeline h3 { font-size: 18px; font-weight: 700; margin: 5px 0 6px; letter-spacing: -0.01em; }
    .timeline p { font-size: 15px; color: var(--ink-2); }
    .commands { margin-top: 56px; padding: 28px; border-radius: 16px; background: #fff; border: 1px solid var(--line); }
    .commands-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
    .commands-head h3 { font-size: 18px; font-weight: 700; }
    .commands-head p { font-size: 14px; color: var(--muted); }
    .cmd-grid { list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 40px; }
    .cmd-grid li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 16px; align-items: baseline; padding: 14px 0; border-top: 1px solid var(--line); }
    .cmd-grid code { justify-self: start; }
    .cmd-grid p { font-size: 15px; color: var(--ink-2); }

    /* Trust */
    .split { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: 64px; align-items: start; }
    .rows { list-style: none; border-top: 1px solid var(--line); }
    .rows li { display: grid; grid-template-columns: 28px 200px minmax(0, 1fr); gap: 14px; padding: 18px 0; border-bottom: 1px solid var(--line); align-items: start; }
    .rows .mark { width: 22px; height: 22px; border-radius: 50%; background: #eef2ff; color: var(--blue); display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }
    .rows .mark svg { width: 13px; height: 13px; }
    .rows .key { font-weight: 700; font-size: 15px; }
    .rows p { font-size: 15px; color: var(--ink-2); }
    .split-links { margin-top: 24px; display: flex; gap: 20px; flex-wrap: wrap; font-size: 15px; font-weight: 600; }

    /* Closing CTA */
    .closing { padding: 0 0 96px; }
    .closing-panel {
      position: relative; overflow: hidden;
      display: flex; align-items: center; justify-content: space-between; gap: 32px; flex-wrap: wrap;
      padding: 44px 48px; border-radius: 20px;
      background: var(--ai-soft); border: 1px solid #e4e6fb;
    }
    .closing-panel::after {
      content: ""; position: absolute; right: -80px; top: -120px; width: 360px; height: 360px; pointer-events: none;
      background: radial-gradient(closest-side, rgba(139, 82, 255, 0.18), transparent);
    }
    .closing h2 { font-size: clamp(24px, 2.6vw, 30px); font-weight: 800; letter-spacing: -0.02em; margin-bottom: 8px; }
    .closing p { color: var(--ink-2); font-size: 16px; }
    .closing .btn-slack { position: relative; z-index: 1; }

    /* Footer */
    footer { padding: 32px 0 40px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
    footer .container { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    footer nav { display: flex; gap: 20px; flex-wrap: wrap; }
    footer a { color: var(--muted); }
    footer a:hover { color: var(--ink); }

    @media (max-width: 1000px) {
      .hero { padding: 56px 0 72px; }
      .hero .container { grid-template-columns: minmax(0, 1fr); gap: 56px; }
      .lede { max-width: none; }
      .pipeline { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 40px; }
      .pipeline::before { display: none; }
      .start-grid, .split { grid-template-columns: minmax(0, 1fr); gap: 36px; }
      .prompts { grid-template-columns: minmax(0, 1fr); gap: 14px; }
      .features { grid-template-columns: minmax(0, 1fr); gap: 18px; }
      .integration { grid-template-columns: 42px minmax(0, 1fr); }
      .integration .link-arrow { grid-column: 2; }
    }
    @media (max-width: 640px) {
      .nav { display: none; }
      .section { padding: 72px 0; }
      .btn-slack { width: 100%; }
      .cta-row { gap: 18px; }
      .msg { padding: 10px 14px 2px; }
      .slack-top { padding: 12px 14px; }
      .trace li .desc { display: none; }
      .pipeline { grid-template-columns: minmax(0, 1fr); row-gap: 32px; }
      .prompts, .commands { padding: 22px 20px; }
      .feature { padding: 24px 20px 20px; }
      .integration { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 20px; }
      .integration .link-arrow { grid-column: auto; }
      .cmd-grid { grid-template-columns: minmax(0, 1fr); }
      .cmd-grid li { grid-template-columns: 84px minmax(0, 1fr); }
      .rows li { grid-template-columns: 28px minmax(0, 1fr); }
      .rows li p { grid-column: 2; }
      .closing-panel { padding: 32px 24px; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { animation: none !important; transition: none !important; }
      .btn-slack:hover { transform: none; }
    }
  </style>
</head>
<body>
  <svg class="defs" aria-hidden="true" focusable="false"><defs><linearGradient id="ai-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#296cf2"/><stop offset="1" stop-color="#8b52ff"/></linearGradient></defs></svg>

  <header class="site-header">
    <div class="container">
      <a class="brand" href="/" aria-label="argus 홈">
        ${spark("spark-brand")}
        <span class="brand-mark">argus</span>
        <span class="brand-by">by WhaTap</span>
      </a>
      <nav class="nav" aria-label="페이지 안내">
        <a href="#features">핵심 기능</a>
        <a href="#how">작동 방식</a>
        <a href="#start">시작하기</a>
        <a href="#trust">권한과 데이터</a>
        <a href="/support">지원</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container">
        <div>
          <p class="badge">${spark("spark-badge")}WhaTap AI · Slack 앱</p>
          <h1>와탭 알림,<br /><span class="grad">확인부터 조치까지</span></h1>
          <p class="lede">알림이 오면 Argus가 원인을 분석하고, 알림 규칙을 만들거나 고치고, 조치안까지 제안합니다. 바꾸는 작업은 미리보기를 보고 내가 버튼을 눌러야 실행됩니다.</p>
          <div class="cta-row">
            ${addToSlackButton()}
            <a class="link-arrow" href="#features">핵심 기능 보기<span aria-hidden="true">→</span></a>
          </div>
          <ul class="assurances">
            <li>${CHECK}내 와탭 권한 안에서만 조회하고 변경</li>
            <li>${CHECK}알림 규칙 변경과 조치는 버튼으로 확인한 뒤 실행</li>
            <li>${CHECK}비밀번호는 Slack에 입력하지 않음</li>
          </ul>
        </div>

        <figure class="sample">
          <div class="slack">
            <div class="slack-top"><span><b>스레드</b><span class="ch"># 서비스-알림</span></span><span class="tag-example">예시 화면</span></div>
            <div class="slack-body">
              <div class="msg">
                <div class="avatar avatar-alert" aria-hidden="true">W</div>
                <div>
                  <div class="msg-head"><b>WhaTap 알림</b><span class="app-tag">앱</span><span class="msg-time">오후 2:03</span></div>
                  <div class="alert-post"><b>[Critical] CPU 사용률 95% 초과</b><br />결제 API · web-02 · 10분째 계속</div>
                </div>
              </div>
              <div class="msg">
                <div class="avatar avatar-user" aria-hidden="true">민</div>
                <div>
                  <div class="msg-head"><b>김민준</b><span class="msg-time">오후 2:04</span></div>
                  <div class="msg-text"><span class="mention">@argus</span> 이 알림 원인 분석하고 조치 방법 알려줘</div>
                </div>
              </div>
              <div class="msg">
                <div class="avatar avatar-bot" aria-hidden="true">${spark("spark-avatar", "#ffffff")}</div>
                <div>
                  <div class="msg-head"><b>argus</b><span class="app-tag">앱</span><span class="msg-time">오후 2:04</span></div>
                  <div class="msg-text">
                    <div class="trace">
                      <div class="trace-head">${spark("spark-trace")}분석 과정</div>
                      <ol>
                        <li><span class="ok">${CHECK}</span><span class="tool">whatap_recent_alerts</span><span class="desc">알림 조회</span><span class="dur">0.7s</span></li>
                        <li><span class="ok">${CHECK}</span><span class="tool">whatap_query_data</span><span class="desc">데이터 쿼리</span><span class="dur">2.3s</span></li>
                        <li><span class="ok">${CHECK}</span><span class="tool">check_project_metrics</span><span class="desc">프로젝트 메트릭 확인</span><span class="dur">1.1s</span></li>
                      </ol>
                    </div>
                    <div class="answer">
                      <b>web-02</b>의 CPU 알림을 분석했습니다.
                      <ul>
                        <li>14:01부터 배치 작업 프로세스 하나가 CPU를 대부분 쓰고 있습니다.</li>
                        <li>같은 시각 결제 API 응답시간도 함께 늘었습니다.</li>
                      </ul>
                    </div>
                    <div class="proposal">
                      <p class="proposal-title">${icon(WRENCH)}조치안 — 배치 작업 프로세스 재시작</p>
                      <p>대상: web-02</p>
                      <p>위험도: <span class="risk"></span>보통</p>
                    </div>
                    <div class="slack-actions" aria-hidden="true">
                      <span class="slack-btn primary">조치 실행</span>
                      <span class="slack-btn">취소</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <figcaption>예시 화면입니다. 실제 조회 결과가 아닙니다.</figcaption>
        </figure>
      </div>
    </section>

    <section class="section section-soft" id="features">
      <div class="container">
        <p class="eyebrow">${spark("spark-eyebrow")}핵심 기능</p>
        <h2>알림 확인, 알림 설정, 조치를 스레드 하나에서</h2>
        <p class="section-lede">알림을 보고 원인을 묻고, 규칙을 고치고, 조치까지 이어 갑니다. 바꾸는 작업은 미리보기를 확인하고 질문한 사람이 버튼을 눌러야 실행됩니다.</p>
        <ul class="features">
          <li class="feature">
            <span class="f-icon">${icon(BELL)}</span>
            <h3>알림 확인</h3>
            <p>최근 알림을 요약하고, 알림 하나를 골라 원인을 분석합니다. 알림 이력과 관련 지표를 함께 봅니다.</p>
            <p class="f-note">내가 볼 수 있는 프로젝트의 알림만 조회합니다.</p>
            <div class="f-demo">
              <p class="f-q"><span class="mention">@argus</span> 최근 24시간 알림 현황 알려줘</p>
              <ul>
                <li>Critical 2건 · Warning 5건</li>
                <li>가장 잦은 알림: 디스크 사용률 (3건)</li>
              </ul>
              <div class="f-btns" aria-hidden="true"><span class="slack-btn">디스크 알림 원인 분석</span><span class="slack-btn">어제와 비교</span></div>
            </div>
          </li>
          <li class="feature">
            <span class="f-icon">${icon(SLIDERS)}</span>
            <h3>알림 설정</h3>
            <p>말로 요청하면 알림 규칙을 만들고, 고치고, 지웁니다. 대상·조건·등급을 미리보기로 보여 주고 [적용]을 눌러야 반영합니다.</p>
            <p class="f-note">그 프로젝트의 경고 알림 설정 권한이 있어야 합니다.</p>
            <div class="f-demo">
              <p class="f-q"><span class="mention">@argus</span> CPU 90% 넘으면 알려줘</p>
              <ul>
                <li>조건: CPU 사용률 &gt; 90%</li>
                <li>등급: Warning · 켜짐</li>
              </ul>
              <div class="f-btns" aria-hidden="true"><span class="slack-btn primary">적용</span><span class="slack-btn">취소</span></div>
            </div>
          </li>
          <li class="feature">
            <span class="f-icon">${icon(WRENCH)}</span>
            <h3>조치</h3>
            <p>분석 결과에 서버 조치안이 나오면 [조치 실행]으로 실행하고, 결과를 같은 스레드에 남깁니다.</p>
            <p class="f-note">서버 조치는 OPM이 연결된 환경에서 쓸 수 있습니다.</p>
            <div class="f-demo">
              <p class="f-q">조치안 — 배치 작업 프로세스 재시작</p>
              <ul>
                <li>대상: web-02 · 위험도 보통</li>
                <li>결재가 필요한지는 OPM 설정을 따릅니다</li>
              </ul>
              <div class="f-btns" aria-hidden="true"><span class="slack-btn primary">조치 실행</span><span class="slack-btn">취소</span></div>
            </div>
          </li>
        </ul>
        <div class="integration">
          <span class="f-icon">${icon(ZAP)}</span>
          <div>
            <h3>알림 채널 연동 <span class="tag-opt">선택 기능</span></h3>
            <p>와탭 알림이 올라오는 채널에 연결하면 알림마다 [분석] 버튼을 붙이고, 해소되면 걸린 시간을 기록합니다. 당번이 자동 대응을 켜면 새 알림을 바로 분석해 미리 허용한 범위의 조치 하나를 당번 권한으로 실행하고, 해결되지 않으면 당번을 부릅니다. 설치만으로 켜지지 않는 기능이라 지원 페이지로 문의해 주세요.</p>
          </div>
          <a class="link-arrow" href="/support">도입 문의<span aria-hidden="true">→</span></a>
        </div>
      </div>
    </section>

    <section class="section" id="how">
      <div class="container">
        <p class="eyebrow">${spark("spark-eyebrow")}작동 방식</p>
        <h2>질문부터 답까지, Argus가 하는 일</h2>
        <p class="section-lede">질문을 받으면 필요한 데이터를 골라 조회하고, 결과를 해석해 답합니다. 모든 조회와 변경은 질문한 사람의 와탭 권한 안에서 이뤄집니다.</p>
        <ol class="pipeline">
          <li>
            <span class="node">1</span>
            <h3>질문 이해</h3>
            <p>평소 말투로 물어도 프로젝트, 기간, 보고 싶은 지표와 알림을 알아듣습니다.</p>
            <span class="hint">web-02 · CPU 알림 · 원인</span>
          </li>
          <li>
            <span class="node">2</span>
            <h3>권한 확인</h3>
            <p>질문한 사람이 연결한 와탭 계정으로만 조회합니다. 권한은 와탭이 확인합니다.</p>
            <span class="hint">내 와탭 계정</span>
          </li>
          <li>
            <span class="node">3</span>
            <h3>데이터 조회</h3>
            <p>질문에 맞는 조회 도구를 골라 프로젝트, 지표, 알림 이력을 직접 확인합니다.</p>
            <span class="hint">whatap_recent_alerts 등</span>
          </li>
          <li>
            <span class="node">4</span>
            <h3>분석과 제안</h3>
            <p>결과를 해석해 원인을 정리하고, 필요하면 알림 규칙 변경이나 조치안을 버튼과 함께 제안합니다.</p>
            <span class="hint">답변 · 미리보기 · 조치안</span>
          </li>
        </ol>
        <div class="prompts">
          <p class="prompts-title">이렇게 물어볼 수 있습니다 <span class="tag-example">예시</span></p>
          <div class="chips">
            <span class="chip">${spark("spark-chip")}오늘 발생한 경고 알림 요약해줘</span>
            <span class="chip">${spark("spark-chip")}이 알림 원인 분석해줘</span>
            <span class="chip">${spark("spark-chip")}CPU 90% 넘으면 Warning으로 알려줘</span>
            <span class="chip">${spark("spark-chip")}디스크 알림 임계치를 85%로 바꿔줘</span>
          </div>
        </div>
      </div>
    </section>

    <section class="section section-soft" id="start">
      <div class="container">
        <div class="start-grid">
          <div>
            <p class="eyebrow">${spark("spark-eyebrow")}시작하기</p>
            <h2>설치부터 첫 질문까지</h2>
            <p class="section-lede">워크스페이스에 앱을 추가한 뒤, 질문할 사람마다 자기 와탭 계정을 연결합니다.</p>
            <div class="account-note">
              <strong>와탭 계정이 없나요?</strong>
              <p>계정이 없으면 <a href="https://service.whatap.io" target="_blank" rel="noopener">와탭 콘솔</a>에서 가입하거나 조직 관리자에게 초대를 요청하세요. 질문할 프로젝트의 접근 권한도 필요합니다.</p>
            </div>
          </div>
          <ol class="timeline">
            <li>
              <span class="t-num">1</span>
              <div>
                <h3>워크스페이스에 설치</h3>
                <p><b>Add to Slack</b>을 눌러 워크스페이스에 앱을 추가합니다. 워크스페이스 설정에 따라 관리자 승인이 필요할 수 있습니다.</p>
              </div>
            </li>
            <li>
              <span class="t-num">2</span>
              <div>
                <h3>와탭 계정 연결</h3>
                <p>봇 DM에 <span class="nw"><code>login</code>을</span> 보내면 나에게만 보이는 링크가 옵니다. 와탭 로그인 페이지에서 로그인하고 권한(조회, 설정 변경)에 동의하세요.</p>
              </div>
            </li>
            <li>
              <span class="t-num">3</span>
              <div>
                <h3>질문하기</h3>
                <p>DM으로 묻거나 채널에서 <span class="nw"><code>@argus</code>를</span> 멘션하세요. 알림 규칙 변경과 조치는 미리보기 아래 버튼을 눌러 실행합니다.</p>
              </div>
            </li>
          </ol>
        </div>
        <div class="commands">
          <div class="commands-head">
            <h3>봇 명령어</h3>
            <p>계정 연결은 봇 DM에서 명령어로 관리합니다. 그 밖의 메시지는 모두 질문으로 받습니다.</p>
          </div>
          <ul class="cmd-grid">
            <li><code>login</code><p>와탭 계정으로 로그인해 봇과 연결합니다. 링크는 나에게만 보입니다.</p></li>
            <li><code>whoami</code><p>연결된 와탭 계정을 확인합니다.</p></li>
            <li><code>logout</code><p>연결을 끊고 저장된 토큰을 지웁니다.</p></li>
            <li><code>help</code><p>사용법을 봅니다.</p></li>
          </ul>
        </div>
      </div>
    </section>

    <section class="section" id="trust">
      <div class="container split">
        <div>
          <p class="eyebrow">${spark("spark-eyebrow")}보안과 개인정보</p>
          <h2>권한과 데이터</h2>
          <p class="section-lede">Argus는 질문한 사람의 와탭 권한 안에서만 조회하고 변경합니다. 자세한 처리 방식은 개인정보 처리방침에 적었습니다.</p>
          <div class="split-links">
            <a href="/privacy">개인정보 처리방침</a>
            <a href="/terms">이용약관</a>
          </div>
        </div>
        <ul class="rows">
          <li><span class="mark">${CHECK}</span><span class="key">내 권한으로만 조회·변경</span><p>각 사용자가 연결한 와탭 계정으로 조회하고 바꿉니다. 권한은 와탭이 확인하므로 접근 권한이 없는 프로젝트는 조회되지 않고 설정도 바뀌지 않습니다.</p></li>
          <li><span class="mark">${CHECK}</span><span class="key">바꾸는 작업은 버튼으로</span><p>알림 규칙 적용과 서버 조치는 미리보기를 확인한 뒤 질문한 사람이 버튼을 눌러야 실행됩니다. 다른 사람의 질문에서 나온 버튼은 누를 수 없습니다.</p></li>
          <li><span class="mark">${CHECK}</span><span class="key">비밀번호는 Slack 밖에서</span><p>로그인은 와탭 로그인 페이지에서 합니다. 비밀번호나 토큰을 Slack 메시지에 붙여넣지 마세요.</p></li>
          <li><span class="mark">${CHECK}</span><span class="key">채널 답은 모두가 봅니다</span><p>채널에서 물으면 채널의 모든 사람이 답을 봅니다. 혼자 볼 내용은 DM으로 물어보세요.</p></li>
          <li><span class="mark">${CHECK}</span><span class="key">연결 정보는 암호화</span><p>와탭 토큰은 암호화해 저장합니다. <span class="nw"><code>logout</code>을</span> 보내거나 앱을 삭제하면 지웁니다.</p></li>
          <li><span class="mark">${CHECK}</span><span class="key">AI 답변 확인</span><p>AI가 만든 답변은 부정확할 수 있습니다. 중요한 판단 전에는 와탭 콘솔에서 원본 데이터를 확인하세요.</p></li>
        </ul>
      </div>
    </section>

    <section class="closing">
      <div class="container">
        <div class="closing-panel">
          <div>
            <h2>팀 워크스페이스에 argus를 추가하세요</h2>
            <p>설치한 뒤 각자 <span class="nw"><code>login</code>으로</span> 와탭 계정을 연결하면 알림 확인부터 조치까지 Slack에서 이어 갈 수 있습니다.</p>
          </div>
          ${addToSlackButton()}
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="container">
      <p>© WhaTap Labs · <a href="https://whatap.io" target="_blank" rel="noopener">whatap.io</a></p>
      <nav aria-label="정책과 지원">
        <a href="/privacy">개인정보 처리방침</a>
        <a href="/terms">이용약관</a>
        <a href="/support">지원</a>
      </nav>
    </div>
  </footer>
</body>
</html>`;
}
