// src/legal.ts
//
// Privacy Policy + Terms of Service 페이지 HTML — Slack App Directory submit
// 시 필수. landing.ts 와 동일 스타일 시스템 (navy / accent) 재사용.
// 시연/PoC 단계의 합리적 minimum draft — 정식 출시 전 법무 검토 권장.

const LAST_UPDATED = "2026-11-03";
const SUPPORT_EMAIL = "jykim@whatap.io";

function legalShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — WhaTap Argus</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --navy: #0a1628;
      --navy-2: #122236;
      --accent: #4f9cf9;
      --text: #e6edf3;
      --text-dim: #8b95a3;
      --border: #1e2d44;
    }
    html, body {
      background: var(--navy);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro KR", "Apple SD Gothic Neo",
                   "Pretendard", "Noto Sans KR", sans-serif;
      line-height: 1.7;
      word-break: keep-all;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 800px; margin: 0 auto; padding: 64px 24px 96px; }
    header { border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 40px; }
    h1 { font-size: 36px; font-weight: 800; letter-spacing: -0.8px; margin-bottom: 8px; }
    .last-updated { font-size: 13px; color: var(--text-dim); }
    h2 { font-size: 22px; font-weight: 700; margin: 40px 0 12px; letter-spacing: -0.3px; }
    h3 { font-size: 17px; font-weight: 600; margin: 24px 0 8px; }
    p { font-size: 15px; color: var(--text); margin-bottom: 12px; }
    ul { margin: 8px 0 16px 24px; }
    li { font-size: 15px; color: var(--text); margin-bottom: 6px; }
    code { background: var(--navy-2); border: 1px solid var(--border); padding: 1px 6px; border-radius: 4px; font-size: 13px; }
    .footer { margin-top: 64px; padding-top: 24px; border-top: 1px solid var(--border); font-size: 13px; color: var(--text-dim); }
    .footer a { margin-right: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${title}</h1>
      <div class="last-updated">최종 업데이트 / Last updated: ${LAST_UPDATED}</div>
    </header>
    ${body}
    <div class="footer">
      <a href="/">홈</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
      <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>
    </div>
  </div>
</body>
</html>`;
}

export function supportPageHtml(): string {
  return legalShell("지원", `
    <p>설치, 계정 연결 및 데이터 열람·삭제 문의는 <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> 로 보내 주세요. 문의를 위해 별도 계정을 만들 필요는 없습니다.</p>
    <p>워크스페이스 이름, 발생 시각, 오류 문구를 알려 주세요. 비밀번호, 토큰, 로그인 링크는 보내지 마세요.</p>
    <h2>처음 사용하기</h2>
    <p>봇 DM 에서 <code>login</code> 을 보내고 브라우저에서 와탭 계정을 연결하세요. 계정이 없으면 <a href="https://service.whatap.io">와탭 콘솔</a> 에서 가입하거나 조직 관리자에게 초대와 프로젝트 접근 권한을 요청하세요.</p>
    <p><code>whoami</code> 는 연결 계정 확인, <code>logout</code> 은 연결 해제, <code>help</code> 는 사용법 안내입니다.</p>
    <p><strong>운영 공개 전 검토 초안:</strong> 팀 지원 연락처와 응답 담당·처리 기준은 공개 전에 확정해야 합니다.</p>
  `);
}

export function privacyPageHtml(): string {
  const body = `
    <p><strong>운영 공개 전 검토 초안:</strong> 아래는 와탭 OAuth 모드의 코드상 처리 방식입니다. 운영 LLM 제공자·모델·저장 지역·보관 기간과 지원 창구를 확정하고 검토한 뒤 공개해야 합니다.</p>
    <p><strong>WhaTap Argus Slack App</strong> ("서비스") 는 WhaTap Labs Inc. 가 제공하는 Slack 봇 통합입니다. 본 정책은 사용자가 본 서비스를 사용할 때 수집·처리되는 데이터를 설명합니다.</p>

    <h2>1. 수집 데이터</h2>
    <ul>
      <li>Slack 사용자 ID, 워크스페이스 ID, 채널/스레드 ID</li>
      <li>WhaTap OAuth access token·refresh token, 사용자 식별자와 이메일 — 브라우저에서 로그인·동의 후 연결</li>
      <li>스레드 대화 기록 — 동일 스레드 내 최근 메시지 (컨텍스트 유지용)</li>
      <li>워크스페이스 OAuth 토큰 — 봇이 메시지 송수신용</li>
    </ul>

    <h2>2. 사용 목적</h2>
    <ul>
      <li>사용자 메시지를 WhaTap 모니터링 백엔드 및 LLM 제공자에 전달하여 응답 생성</li>
      <li>동일 스레드 내 멀티턴 대화 컨텍스트 유지</li>
      <li>사용자 권한 내 프로젝트·지표 조회와 질문에 대한 설명 제공</li>
    </ul>

    <h2>3. 제3자 공유</h2>
    <ul>
      <li><strong>Argus 및 설정된 LLM 제공자</strong> — 질문·대화 문맥·조회 결과가 응답 생성에 사용됩니다. 실제 제공자, 모델, 데이터 보관 정책과 저장 지역은 운영 구성 확정 후 명시해야 합니다.</li>
      <li><strong>WhaTap Labs</strong> — 사용자 WhaTap 계정 데이터 조회를 위해 WhaTap API 가 호출됩니다.</li>
      <li>광고 / 마케팅 / 분석 목적의 제3자 공유 없음.</li>
    </ul>

    <h2>4. 보관 기간</h2>
    <ul>
      <li>WhaTap OAuth 연결 — <code>logout</code>, 무효 refresh token 확인 또는 앱 삭제·봇 토큰 회수 이벤트 처리 시 로컬 연결 삭제</li>
      <li>봇의 스레드 대화 기록 — 30분 이상 비활성인 기록은 다음 대화 조회 시 정리. 워크스페이스별 기록은 앱 삭제 이벤트 처리 시 삭제</li>
      <li>Slack 설치 토큰 — 앱 삭제 또는 해당 봇 토큰 회수 이벤트 처리 시 삭제</li>
      <li>봇 로컬 삭제는 Argus 서버·LLM 제공자의 대화/로그 보관 데이터 삭제를 의미하지 않습니다. 별도 보관·삭제 정책과 백업 정리 절차를 운영 공개 전에 확정해야 합니다.</li>
    </ul>

    <h2>5. 사용자 권리</h2>
    <ul>
      <li>봇 DM 에서 <code>logout</code> — 등록한 WhaTap 자격증명 삭제</li>
      <li>워크스페이스 admin 이 앱을 제거하면 해당 이벤트 수신 후 봇의 워크스페이스 설치 정보·OAuth 연결·워크스페이스별 대화 기록을 정리</li>
      <li>데이터 열람 / 삭제 요청 — <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> 로 이메일</li>
    </ul>

    <h2>6. 보안</h2>
    <ul>
      <li>전송 구간 — TLS 1.2+</li>
      <li>저장 구간 — 와탭 OAuth 토큰·이메일은 AES-256-GCM 암호화. 공개 HTTP 다중 워크스페이스 모드는 Slack 설치 토큰 저장에도 암호화 키를 요구</li>
      <li>내부 데이터베이스 외부 공개 접근 차단</li>
    </ul>

    <h2>7. 정책 변경</h2>
    <p>본 정책은 변경될 수 있으며, 중요한 변경 사항은 봇 DM 또는 본 페이지 공지로 안내됩니다.</p>

    <h2>8. 연락처</h2>
    <ul>
      <li>이메일: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></li>
      <li>WhaTap: <a href="https://whatap.io">https://whatap.io</a></li>
    </ul>
  `;
  return legalShell("Privacy Policy", body);
}

export function termsPageHtml(): string {
  const body = `
    <p><strong>WhaTap Argus Slack App</strong> ("서비스") 의 이용약관입니다. 본 서비스를 사용함으로써 사용자는 본 약관에 동의한 것으로 간주됩니다.</p>

    <h2>1. 서비스 정의</h2>
    <p>본 서비스는 사용자가 Slack 환경에서 WhaTap 모니터링 데이터를 자연어로 질의하고, 알림 분석·룰 등록 등 관찰성 작업을 수행할 수 있도록 하는 AI 어시스턴트 봇입니다. 서비스는 "있는 그대로 (as-is)" 제공되며 best-effort 가용성을 목표로 합니다.</p>

    <h2>2. 적법한 사용</h2>
    <ul>
      <li>사용자는 본 서비스를 자신이 정당하게 접근 권한을 가진 WhaTap 계정의 모니터링 / 관찰성 목적으로만 사용해야 합니다.</li>
      <li>서비스를 악용 (reverse-engineer, exploit, 과도한 요청 등) 하거나 LLM 을 통해 부적절한 콘텐츠를 생성·전파하는 행위는 금지됩니다.</li>
      <li>제3자 권리를 침해하는 사용은 금지됩니다.</li>
    </ul>

    <h2>3. 제한 / 보증 부인</h2>
    <ul>
      <li>본 서비스는 <strong>"AS IS"</strong> 로 제공되며, 명시적·묵시적 보증 (상품성, 특정 목적 적합성 등) 을 부인합니다.</li>
      <li>LLM 이 생성한 응답의 정확성을 보증하지 않으며, 사용자는 중요한 의사결정 전 응답을 독립적으로 검증해야 합니다.</li>
      <li>워크스페이스 / 사용자별 사용량 한도 (rate limit) 가 적용될 수 있습니다.</li>
    </ul>

    <h2>4. 종료</h2>
    <ul>
      <li>사용자는 언제든지 워크스페이스에서 봇을 uninstall 함으로써 서비스 이용을 중단할 수 있습니다.</li>
      <li>운영자는 약관 위반, 보안 위협, WhaTap 계정 정지 등 합리적 사유로 서비스 접근을 제한·종료할 수 있습니다.</li>
    </ul>

    <h2>5. 책임 제한</h2>
    <ul>
      <li>WhaTap Labs 의 본 서비스 관련 총 책임은 사용자가 직전 12개월 동안 본 서비스에 지불한 금액 (무료 사용자는 0) 으로 제한됩니다.</li>
      <li>간접 손해 / 결과적 손해 / 데이터 손실에 대한 책임은 부인됩니다.</li>
    </ul>

    <h2>6. 준거법 / 관할</h2>
    <p>본 약관은 대한민국 법률에 따라 해석·집행되며, 분쟁 발생 시 서울중앙지방법원을 1심 전속 관할 법원으로 합니다.</p>

    <h2>7. 약관 변경</h2>
    <p>운영자는 본 약관을 변경할 수 있으며, 중요한 변경은 봇 DM 또는 본 페이지로 공지합니다. 공지 후 사용자가 서비스를 계속 사용하는 것은 변경된 약관에 동의한 것으로 간주됩니다.</p>

    <h2>8. 연락처</h2>
    <ul>
      <li>이메일: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></li>
      <li>WhaTap: <a href="https://whatap.io">https://whatap.io</a></li>
    </ul>
  `;
  return legalShell("Terms of Service", body);
}
