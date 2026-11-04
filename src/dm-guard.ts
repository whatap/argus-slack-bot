// DM 이 이 봇과의 대화인지 확인한다.
//
// 앱이 사용자 이벤트(user_events 의 message.im)를 구독하면, 앱을 승인한 사용자가 다른 사람과
// 나누는 DM 도 같은 message 이벤트로 들어온다. channel_type 만 보면 봇 DM 과 구분되지 않아
// 남의 대화가 질문으로 처리될 수 있다.
//
// 이벤트의 authorizations 는 그 이벤트를 볼 수 있는 앱 설치 중 "하나" 다
// (https://docs.slack.dev/apis/events-api#callback-field). 봇 설치가 오면 봇이 그 DM 에 있다는
// 뜻이라 바로 통과한다. 사용자 설치가 오면 봇 DM 일 수도 있고 남의 DM 일 수도 있어서, 봇 토큰으로
// conversations.info 를 불러 확인한다(봇이 없는 DM 은 channel_not_found). 이 확인에는 im:read 가
// 필요하다. 사용자 토큰이 없는 설정(봇 권한만)에서는 항상 봇 설치가 오므로 호출하지 않는다.
// 확인하지 못하면 처리하지 않는다.

export interface ConversationsInfoClient {
  conversations: {
    info(args: { channel: string }): Promise<{ channel?: { is_im?: boolean } }>;
  };
}

export type DmVerdict =
  | { ok: true; via: "bot-authorization" | "membership" | "cache" }
  | { ok: false; reason: string };

/** 로그용: Slack 이 고른 설치가 봇인지 사용자인지. */
export function authorizationKind(authorizations: unknown): "bot" | "user" | "none" {
  if (!Array.isArray(authorizations) || authorizations.length === 0) return "none";
  return authorizations.some((a) => (a as { is_bot?: unknown } | null)?.is_bot === true) ? "bot" : "user";
}

function slackErrorCode(err: unknown): string {
  const e = err as { data?: { error?: unknown }; code?: unknown } | null;
  if (typeof e?.data?.error === "string") return e.data.error;
  if (typeof e?.code === "string") return e.code;
  return "unknown";
}

/** 1:1 DM 의 참여자는 바뀌지 않으므로 확인 결과를 workspace·채널 단위로 기억한다(크기 제한). */
export function createBotDmGuard(maxEntries = 5000) {
  const known = new Map<string, true | string>();
  const remember = (key: string, value: true | string) => {
    known.delete(key);
    known.set(key, value);
    if (known.size > maxEntries) known.delete(known.keys().next().value as string);
  };
  return async (input: {
    teamId: string;
    channel: string;
    authorizations?: unknown;
    client: ConversationsInfoClient;
  }): Promise<DmVerdict> => {
    const key = `${input.teamId}:${input.channel}`;
    if (authorizationKind(input.authorizations) === "bot") {
      remember(key, true);
      return { ok: true, via: "bot-authorization" };
    }
    const cached = known.get(key);
    if (cached === true) return { ok: true, via: "cache" };
    if (cached !== undefined) return { ok: false, reason: cached };
    try {
      const res = await input.client.conversations.info({ channel: input.channel });
      if (res.channel?.is_im === true) {
        remember(key, true);
        return { ok: true, via: "membership" };
      }
      remember(key, "not-im");
      return { ok: false, reason: "not-im" };
    } catch (err) {
      const code = slackErrorCode(err);
      if (code === "channel_not_found") {
        remember(key, "bot-not-in-conversation");
        return { ok: false, reason: "bot-not-in-conversation" };
      }
      // 권한 부족·일시 오류는 기억하지 않고 이번 메시지만 처리하지 않는다.
      return { ok: false, reason: `membership-check-failed:${code}` };
    }
  };
}
