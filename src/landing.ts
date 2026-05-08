// src/landing.ts
//
// 랜딩 페이지 HTML — 봇의 OAuth installer 포트의 root path 에서 서빙.
// 데모/홍보용. inline CSS 라 외부 의존 0.

export function landingPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>argus — Slack 에서 만나는 WhaTap AI 어시스턴트</title>
  <meta name="description" content="WhaTap 모니터링 데이터를 Slack 자연어 채팅으로. 알림·메트릭·장애 분석을 argus 가 합성해서 답변." />
  <meta property="og:title" content="argus — Slack 에서 만나는 WhaTap AI 어시스턴트" />
  <meta property="og:description" content="자연어로 묻고, 실시간 데이터로 답하는 모니터링 챗봇." />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --navy: #0a1628;
      --navy-2: #122236;
      --accent: #4f9cf9;
      --accent-soft: #4f9cf933;
      --text: #e6edf3;
      --text-dim: #8b95a3;
      --border: #1e2d44;
    }
    html, body {
      background: var(--navy);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro KR", "Apple SD Gothic Neo",
                   "Pretendard", "Noto Sans KR", sans-serif;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 960px; margin: 0 auto; padding: 0 24px; }

    /* Header */
    header {
      padding: 24px 0;
      border-bottom: 1px solid var(--border);
    }
    header .container {
      display: flex; align-items: center; justify-content: space-between;
    }
    .brand {
      display: flex; align-items: baseline; gap: 8px;
    }
    .brand-mark { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
    .brand-by { font-size: 13px; color: var(--text-dim); }
    .header-link { font-size: 14px; color: var(--text-dim); }

    /* Hero */
    .hero {
      padding: 96px 0 64px;
      text-align: center;
    }
    .hero-badge {
      display: inline-block;
      background: var(--accent-soft);
      color: var(--accent);
      padding: 6px 14px;
      border-radius: 100px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 24px;
    }
    .hero h1 {
      font-size: 52px;
      font-weight: 800;
      letter-spacing: -1.5px;
      line-height: 1.15;
      margin-bottom: 20px;
      background: linear-gradient(135deg, #fff 0%, #8b95a3 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero p {
      font-size: 19px;
      color: var(--text-dim);
      max-width: 640px;
      margin: 0 auto 40px;
    }
    .cta-row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .btn-primary {
      display: inline-flex; align-items: center; gap: 10px;
      background: var(--accent);
      color: #fff;
      padding: 14px 28px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
      transition: transform 0.1s, box-shadow 0.1s;
    }
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 8px 24px var(--accent-soft);
      text-decoration: none;
    }
    .btn-secondary {
      display: inline-flex; align-items: center; gap: 10px;
      color: var(--text);
      border: 1px solid var(--border);
      padding: 14px 28px;
      border-radius: 8px;
      font-weight: 500;
      font-size: 16px;
    }
    .btn-secondary:hover { background: var(--navy-2); text-decoration: none; }

    /* Features */
    .features {
      padding: 80px 0;
      border-top: 1px solid var(--border);
    }
    .features h2 {
      text-align: center;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 48px;
    }
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 20px;
    }
    .feature {
      background: var(--navy-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px;
    }
    .feature-icon { font-size: 28px; margin-bottom: 12px; }
    .feature h3 { font-size: 17px; margin-bottom: 8px; font-weight: 600; }
    .feature p { font-size: 14px; color: var(--text-dim); }

    /* How */
    .how {
      padding: 80px 0;
      border-top: 1px solid var(--border);
    }
    .how h2 {
      text-align: center;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 48px;
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px;
      counter-reset: step;
    }
    .step {
      background: var(--navy-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px;
      position: relative;
      counter-increment: step;
    }
    .step::before {
      content: counter(step);
      position: absolute;
      top: 20px; right: 20px;
      width: 32px; height: 32px;
      background: var(--accent-soft);
      color: var(--accent);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 14px;
    }
    .step h3 { font-size: 16px; margin-bottom: 8px; font-weight: 600; }
    .step p { font-size: 14px; color: var(--text-dim); }
    .step code {
      background: var(--navy);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 13px;
      color: var(--accent);
    }

    /* Demo */
    .demo {
      padding: 80px 0;
      border-top: 1px solid var(--border);
      background: var(--navy-2);
    }
    .demo .container {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 60px; align-items: center;
    }
    @media (max-width: 720px) {
      .demo .container { grid-template-columns: 1fr; }
    }
    .demo h2 {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 16px;
    }
    .demo p { color: var(--text-dim); margin-bottom: 24px; }
    .chat-mock {
      background: var(--navy);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      font-size: 13px;
      line-height: 1.7;
    }
    .msg { margin-bottom: 12px; }
    .msg-user { color: var(--accent); }
    .msg-bot { color: var(--text); }
    .msg-bot strong { color: #f7c160; }

    /* Footer */
    footer {
      padding: 40px 0;
      border-top: 1px solid var(--border);
      text-align: center;
      color: var(--text-dim);
      font-size: 13px;
    }
    footer a { color: var(--text-dim); }

    /* Final CTA */
    .final-cta { padding: 80px 0; text-align: center; }
    .final-cta h2 {
      font-size: 36px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 16px;
    }
    .final-cta p { color: var(--text-dim); margin-bottom: 32px; }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <div class="brand">
        <span class="brand-mark">argus</span>
        <span class="brand-by">by WhaTap</span>
      </div>
      <a class="header-link" href="https://whatap.io" target="_blank" rel="noopener">whatap.io →</a>
    </div>
  </header>

  <section class="hero">
    <div class="container">
      <div class="hero-badge">✨ Slack × WhaTap × Claude</div>
      <h1>모니터링이<br/>대화가 됩니다</h1>
      <p>Slack 에서 자연어로 묻고, argus 가 14개 모니터링 도구를 조합해 답변. 알림·메트릭·장애 원인을 한 줄 질문으로.</p>
      <div class="cta-row">
        <a class="btn-primary" href="/slack/install">
          <svg width="20" height="20" viewBox="0 0 122 122" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9zM32.3 77.6a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 1 1-25.8 0V77.6z" fill="#E01E5A"/>
            <path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2zM45.2 32.3a12.9 12.9 0 1 1 0 25.8H12.9a12.9 12.9 0 1 1 0-25.8h32.3z" fill="#36C5F0"/>
            <path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2zM90.5 45.2a12.9 12.9 0 1 1-25.8 0V12.9a12.9 12.9 0 1 1 25.8 0v32.3z" fill="#2EB67D"/>
            <path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9zM77.6 90.5a12.9 12.9 0 1 1 0-25.8h32.3a12.9 12.9 0 1 1 0 25.8H77.6z" fill="#ECB22E"/>
          </svg>
          Add to Slack
        </a>
        <a class="btn-secondary" href="#how">사용법 보기 ↓</a>
      </div>
    </div>
  </section>

  <section class="features">
    <div class="container">
      <h2>왜 argus 인가요?</h2>
      <div class="feature-grid">
        <div class="feature">
          <div class="feature-icon">🗣️</div>
          <h3>자연어 질의</h3>
          <p>"3396 프로젝트 알림 보여줘", "K8s 클러스터 GPU 점유율 추이" 같이 평소 말투로.</p>
        </div>
        <div class="feature">
          <div class="feature-icon">⚡</div>
          <h3>14개 도구 조합</h3>
          <p>argus 가 프로젝트 메타·MXQL·알림·토폴로지를 자동으로 연결해 한 번에 답변.</p>
        </div>
        <div class="feature">
          <div class="feature-icon">🔐</div>
          <h3>사용자별 권한</h3>
          <p>각자 자기 WhaTap 토큰으로 인증. 자기 프로젝트만 보이고, 다른 사람과 격리.</p>
        </div>
        <div class="feature">
          <div class="feature-icon">💬</div>
          <h3>Slack 네이티브</h3>
          <p>채널 멘션 / DM / 스레드 follow-up 다 지원. 새 앱 설치 / 별 화면 X.</p>
        </div>
        <div class="feature">
          <div class="feature-icon">🧠</div>
          <h3>Claude opus 4.7</h3>
          <p>Anthropic 최신 모델 + WhaTap 도메인 컨텍스트 결합. 복합 질문도 한 번에.</p>
        </div>
        <div class="feature">
          <div class="feature-icon">🛠️</div>
          <h3>설정 1분</h3>
          <p>워크스페이스 install + DM 으로 토큰 register, 끝.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="how" id="how">
    <div class="container">
      <h2>3단계 시작</h2>
      <div class="steps">
        <div class="step">
          <h3>워크스페이스에 추가</h3>
          <p>위 <strong>"Add to Slack"</strong> 버튼 클릭 → 워크스페이스 선택 → Allow.</p>
        </div>
        <div class="step">
          <h3>토큰 등록</h3>
          <p><a href="https://service.whatap.io" target="_blank" rel="noopener">WhaTap Console</a> 에서 API 토큰 발급 → 봇한테 DM 으로 <code>register &lt;token&gt;</code>.</p>
        </div>
        <div class="step">
          <h3>질문 시작</h3>
          <p>채널에서 <code>@argus 무엇이든 물어봐</code> 또는 봇 DM 으로 자유롭게.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="demo">
    <div class="container">
      <div>
        <h2>이렇게 동작합니다</h2>
        <p>실제 Slack 대화 예시. argus 가 도구를 조합해 합성 답변.</p>
      </div>
      <div class="chat-mock">
        <div class="msg msg-user">@argus 3396 프로젝트의 최근 알림 보여줘</div>
        <div class="msg msg-bot">
          <strong>K8s-GPU (pcode: 3396)</strong> 최근 24h 알림 <strong>2건</strong>:<br/>
          • 🔴 <strong>Critical</strong> 17:06 — gpu/inference-65d8 GPU 스케줄링 실패 (ON)<br/>
          • ✅ Cancel 17:07 — 변수 치환 버그 재발송<br/><br/>
          실제 사건은 1건 (변수 치환 룰 버그 의심). 노드 GPU 리소스 확인할까요?
        </div>
      </div>
    </div>
  </section>

  <section class="final-cta">
    <div class="container">
      <h2>지금 바로 시작</h2>
      <p>1분이면 워크스페이스에 들어옵니다.</p>
      <a class="btn-primary" href="/slack/install">+ Add to Slack</a>
    </div>
  </section>

  <footer>
    <div class="container">
      <p>© WhaTap Labs · powered by Claude · <a href="https://whatap.io" target="_blank" rel="noopener">whatap.io</a></p>
    </div>
  </footer>
</body>
</html>`;
}
