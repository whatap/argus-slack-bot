// src/humanize.ts
//
// 에러 → 사용자 친화 메시지 매핑. argus / WhaTap 측 에러 패턴별로 명확한
// 복구 가이드 함께 안내. 매칭 안 되는 케이스는 raw message + :warning: fallback.
//
// 분리한 이유: index.ts 안에 두면 unit test 어려움. 별도 파일이라
// node --test 로 잘 테스트됨. 새 패턴 추가 시 humanize.test.ts 도 같이 갱신.

export function humanizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  // argus /v1/chat error (status) — argusDirect 경로
  const argusHttp = msg.match(/argus \/v1\/(?:chat|agent) error \((\d{3})\)/);
  if (argusHttp) {
    const status = Number(argusHttp[1]);
    if (status === 401) {
      return (
        ":lock: *argus 인증 실패 (401)* — cookie 만료/미등록.\n" +
        "DM 으로 `cookie <JSESSIONID=...>` 갱신 후 다시 질문해 주세요."
      );
    }
    if (status === 403) {
      return (
        ":no_entry: *argus 권한 없음 (403)* — 이 pcode 접근 불가 또는 cookie 무효.\n" +
        "다른 cookie 로 재시도하거나 운영자에게 권한 확인 요청."
      );
    }
    if (status === 404) {
      return ":mag: *argus 404* — 엔드포인트 없음. 봇/argus 버전 mismatch 가능성.";
    }
    if (status >= 500) {
      return `:rotating_light: *argus 서버 에러 (${status})* — 일시 장애. 잠시 후 재시도하거나 운영자에게 알림.`;
    }
  }

  // [F] Invalid token — WHATAP_API_TOKEN 만료/무효 (api.whatap.io 응답)
  if (/\[F\] Invalid token|Invalid.*WhaTap.*token/i.test(msg)) {
    return (
      ":key: *WhaTap API token 만료/무효*\n" +
      "WhaTap Console → 계정 설정 → API Token 에서 새로 발급 후 " +
      "DM 으로 `register <new-token>` 보내주세요."
    );
  }

  // 네트워크 / 도달 불가
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up/i.test(msg)
  ) {
    return (
      `:satellite_antenna: *argus 도달 불가* — 네트워크 또는 봇/argus 호스트 문제.\n` +
      `운영자에게 알림: \`${msg}\``
    );
  }

  // MCP 자식 프로세스 에러
  if (/MCP|stdio|spawn/i.test(msg)) {
    return (
      `:gear: *whatap-mcp 자식 프로세스 에러* — 봇 재기동 후에도 반복되면 운영자에게 알림.\n` +
      `\`${msg}\``
    );
  }

  // Anthropic API 에러
  if (/anthropic|rate.?limit|429|overloaded/i.test(msg)) {
    return (
      `:hourglass_flowing_sand: *Anthropic API 부하* — 잠시 후 재시도해 주세요.\n` +
      `\`${msg}\``
    );
  }

  // 그 외 — 원본 메시지 + 디버그 hint
  return `:warning: argus 호출 실패: \`${msg}\``;
}
