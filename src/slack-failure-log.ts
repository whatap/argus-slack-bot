// Slack 처리 실패를 시각·workspace·채널과 함께 남긴다.
// 메시지 본문, 토큰, Slack 사용자 ID 는 남기지 않는다.

type Body = {
  type?: string;
  team_id?: string;
  team?: { id?: string };
  user?: { team_id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; thread_ts?: string };
  message?: { thread_ts?: string };
  event?: { type?: string; channel?: string; channel_type?: string; thread_ts?: string };
};

export function describeSlackFailure(error: unknown, body: unknown, at: Date = new Date()): string {
  const b = (body ?? {}) as Body;
  const event = b.event ?? {};
  const team = b.team_id || b.team?.id || b.user?.team_id || "-";
  const channel = event.channel || b.channel?.id || b.container?.channel_id || "-";
  const channelType = event.channel_type || "-";
  const thread = event.thread_ts || b.message?.thread_ts || b.container?.thread_ts ? "yes" : "no";
  const kind = b.type === "event_callback" ? `event:${event.type || "-"}` : b.type || "-";
  const e = error as { code?: unknown; data?: { error?: unknown } } | null;
  const code = typeof e?.code === "string" ? e.code : "-";
  const slackError = typeof e?.data?.error === "string" ? e.data.error : "-";
  return `at=${at.toISOString()} team=${team} channel=${channel} channel_type=${channelType} thread=${thread} kind=${kind} code=${code} slack_error=${slackError}`;
}

/** Bolt 전역 오류 처리기(extendedErrorHandler). 맥락을 남긴 뒤 같은 오류를 다시 던져
 *  기존 처리(receiver 의 오류 기록·응답)를 그대로 둔다. 스택은 오류 객체 대신 문자열로만 남긴다. */
export function createSlackFailureHandler(
  log: (...args: unknown[]) => void = (...args) => console.error(...args),
) {
  return async ({ error, body }: { error: Error; body?: unknown }): Promise<void> => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    log(`[argus-slack-bot] slack handler failed ${describeSlackFailure(error, body)}\n${detail}`);
    throw error;
  };
}
