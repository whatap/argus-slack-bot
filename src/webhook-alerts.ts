// Korean notihub templates-v2 non-email alerts only. Never use display names to admit a sender.
export function alertSource(env: NodeJS.ProcessEnv) {
  const team = env.SLACK_ALERT_TEAM_ID;
  const channel = env.SLACK_ALERT_CHANNEL_ID;
  const bots = env.SLACK_ALERT_BOT_IDS?.split(",").map(id => id.trim());
  if (!team || !/^T[A-Z0-9]+$/.test(team) || !channel || !/^[CG][A-Z0-9]+$/.test(channel) ||
      !bots?.length || !bots.every(id => /^B[A-Z0-9]+$/.test(id))) return undefined;
  return { team, channel, bots: new Set(bots) };
}

// ALERT_TIME_ZONE: the zone Webhook JSON epoch times are shown in (IANA name). Unset keeps such alerts unread.
export function alertTimeZone(env: NodeJS.ProcessEnv): string | undefined {
  const zone = env.ALERT_TIME_ZONE?.trim();
  if (!zone) return undefined;
  try {
    // An offset such as +09:00 is not a zone name: it would not follow daylight saving rules.
    if (/^[+-]/.test(zone)) throw new RangeError(zone);
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(`ALERT_TIME_ZONE 은 IANA 시간대 이름이어야 해요 (예: Asia/Seoul): ${zone}`);
  }
  return zone;
}

type Source = NonNullable<ReturnType<typeof alertSource>>;
export function isAlertEnvelope(source: Source, m: Record<string, unknown>,
  body: { team_id?: string; is_ext_shared_channel?: boolean; authorizations?: unknown }, ownBot: unknown) {
  return body.team_id === source.team && m.channel === source.channel &&
    (m.team === undefined || m.team === source.team) && !body.is_ext_shared_channel &&
    Array.isArray(body.authorizations) && body.authorizations.some(a => a?.team_id === source.team && a.is_bot === true) &&
    (m.channel_type === "channel" || m.channel_type === "group") && m.thread_ts === undefined &&
    (m.subtype === undefined || m.subtype === "bot_message") && typeof m.bot_id === "string" &&
    !!ownBot && m.bot_id !== ownBot && source.bots.has(m.bot_id) &&
    typeof m.ts === "string" && /^\d{10}\.\d{6}$/.test(m.ts);
}

// Sender's EventDateTimeHelper.eventTime(): yyyy-MM-dd HH:mm:ss Z (not machine-local time).
function eventMillis(value: string) {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-])(\d\d)(\d\d)$/.exec(value);
  if (!m || +m[4] > 14 || +m[5] > 59) return NaN;
  const wall = `${m[1]}T${m[2]}`;
  const utc = Date.parse(wall + "Z");
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 19) !== wall) return NaN;
  return Date.parse(`${wall}${m[3]}${m[4]}:${m[5]}`);
}

// Epoch millis in the shape the sender prints event times (yyyy-MM-dd HH:mm:ss Z), in an explicitly configured zone.
function eventClock(ms: number, zone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(ms).map(x => [x.type, x.value]));
  const offset = /^GMT([+-])(\d\d):(\d\d)$/.exec(p.timeZoneName ?? "");
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${offset ? offset[1] + offset[2] + offset[3] : "+0000"}`;
}

export function readAlert(attachments: unknown, zone?: string) {
  if (!Array.isArray(attachments) || attachments.length !== 1) return;
  const a = attachments[0];
  if (typeof a?.pretext !== "string" || typeof a.text !== "string" || a.text.length > 16000) return;
  const subject = /^\[(Warning|Critical|Info)\]\[([^\[\]\r\n]{1,80})\]\[([^\[\]\r\n]{1,160})\]\[([^\[\]\r\n]{1,160})\]\[([^\[\]\r\n]{1,200})\]$/.exec(a.pretext);
  if (!subject) return;
  const fields = new Map<string, string>();
  for (const line of a.text.split(/\r?\n/)) {
    const i = line.indexOf(" : ");
    if (i < 0) continue;
    const key = line.slice(0, i);
    if (fields.has(key)) return;
    fields.set(key, line.slice(i + 3));
  }
  const project = fields.get("프로젝트 코드") ?? "";
  if (fields.has("서버 이름") && fields.has("에이전트 이름")) return;
  const target = fields.get("서버 이름") ?? fields.get("에이전트 이름");
  // A "Webhook JSON" plugin body (docs/webhook-alerts.md) states the event's status and gives epoch millis, the server
  // oid and the event id. Epoch times are shown only in a configured zone, the way the sender prints event times.
  const status = fields.get("이벤트 상태");
  const at = fields.get("이벤트 시각(ms)") ?? "";
  if (status !== undefined && (!zone || fields.has("이벤트 시작 시간") || !/^\d{13}$/.test(at))) return;
  const start = status === undefined ? fields.get("이벤트 시작 시간") : eventClock(Number(at), zone!);
  // The target is written into the incident rows below as-is; a name the row grammar would misread is not admitted.
  if (!/^[1-9]\d{0,14}$/.test(project) || fields.get("프로젝트 이름") !== subject[3] ||
      target !== subject[4] || /[—«»]|\(\s*oid\b/i.test(target) || !start) return;
  const recovered = status === undefined ? subject[5].startsWith("RECOVERED: ") : status === "off";
  // Editing or switching off a rule while its event is open closes it as cancelled (a DISABLED title): a closure, never a recovery.
  const cancelled = status === "cancel";
  const rule = recovered && subject[5].startsWith("RECOVERED: ") ? subject[5].slice("RECOVERED: ".length)
    : cancelled && subject[5].startsWith("DISABLED: ") ? subject[5].slice("DISABLED: ".length) : subject[5];
  const closed = fields.get("해소 시각(ms)") ?? "";
  const end = status === undefined ? fields.get("이벤트 종료 시간") : recovered && /^\d{13}$/.test(closed) ? eventClock(Number(closed), zone!) : undefined;
  const startMs = status === undefined ? eventMillis(start) : Number(at);
  const endMs = end === undefined ? undefined : status === undefined ? eventMillis(end) : Number(closed);
  if (!rule || /^(?:DISABLED|RECOVERED):/.test(rule) || !Number.isFinite(startMs) ||
      (endMs !== undefined && (!recovered || !Number.isFinite(endMs) || endMs < startMs))) return;
  const link = fields.get("바로가기");
  let archive: string | undefined;
  if (link !== undefined) {
    const raw = link.startsWith("<") && link.endsWith(">") ? link.slice(1, -1) : link;
    const m = /^(https?:\/\/[\w.:-]+)\/link\/event\?pcode=(\d+)&(?:amp;)?archiveId=([1-9]\d{0,18})$/.exec(raw);
    if (!m || m[2] !== project) return;
    archive = JSON.stringify([m[1], project, m[3]]);
  }
  // The event id names the occurrence: a start and its close carry the same one.
  if (status !== undefined) archive = JSON.stringify(["event", project, (fields.get("이벤트 ID") ?? "").toLowerCase()]);
  const identity = JSON.stringify([subject[2], subject[3], project, target, rule, start,
    fields.get("이벤트 규칙"), fields.get("알림 조건"), fields.get("이벤트 발생 조건")]);
  const message = fields.get("이벤트 메시지") ?? "";
  // The alert template has no oid. A rule whose message writes one (`oid ${oid}`) lets the incident name the server
  // for OPM; Argus still checks that oid against the server name before it offers an action.
  const oids = new Set([...message.matchAll(/(?:^|[\s(,])oid[\s:=]+(-?[1-9]\d{0,18})(?![\w.])/gi)].map(m => m[1]));
  const written = fields.get("서버 oid") ?? "";
  const oid = status !== undefined ? (/^-?[1-9]\d{0,18}$/.test(written) ? written : undefined) : oids.size === 1 ? [...oids][0] : undefined;
  return { project, target, rule, level: subject[1], message, oid, start, recovered, cancelled, end, startMs, endMs, archive, identity };
}

type Alert = NonNullable<ReturnType<typeof readAlert>>;

const inline = (text: string, max: number) =>
  text.replace(/[«»]/g, "").replace(/—/g, "-").replace(/\s+/g, " ").trim().slice(0, max);

// The incident text that argus-agents `workflow.sms.sre-incident` reads by code (sms.sre.incident tools.py is the
// contract): header first, one target row, one alert row. Times are the alert's own wall clock; oid 0 means unknown.
export function incidentPrompt(alert: Pick<Alert, "rule" | "target" | "level" | "message" | "oid" | "start">): string {
  const day = alert.start.slice(0, 10), time = alert.start.slice(11, 16);
  const verdict = alert.level === "Critical" ? "위험" : alert.level === "Warning" ? "주의" : "확인 필요";
  const rule = inline(alert.rule, 120), message = inline(alert.message, 200) || rule;
  return [
    `SRE 사건 분석 요청입니다 (알림 규칙 «${rule}», 서버 1대, 기준 시각 ${day} ${time}).`,
    "대상 서버:",
    `- [${verdict}] ${alert.target} (oid ${alert.oid ?? 0}) — 1건, 최근 ${time} «${message}»`,
    "알림:",
    `- ${time} ${alert.level} ${alert.target} — ${message}`,
    "원인을 분석하고 OPM 조치안을 제안하세요.",
  ].join("\n");
}
interface Thread { alert: Alert; root: string; bot: string; buttonTs?: string; state: "open" | "resolved" | "ignored" }
type Notice = { kind: "offer"; thread: Thread } | { kind: "resolved"; root: string; text: string };

// One instance per configured source. Reserve synchronously before posting to Slack, even on a retry.
export class AlertThreads {
  private readonly records = new Map<string, Thread>();
  private readonly ttl = 24 * 60 * 60 * 1000;
  private holdNewUntil = 0;
  constructor(private readonly now = Date.now, private readonly limit = 2048) {}
  clear() { this.records.clear(); this.holdNewUntil = 0; }
  private fresh(ts: string) {
    const age = this.now() - Number(ts) * 1000;
    return age >= -60_000 && age < this.ttl;
  }
  get(root: string) {
    if (!this.fresh(root)) return;
    for (const e of this.records.values()) if (e.root === root && e.state !== "ignored") return e;
  }
  observe(alert: Alert, ts: string, bot: string): Notice | undefined {
    if (!this.fresh(ts)) return;
    for (const [key, e] of this.records) if (!this.fresh(e.root)) this.records.delete(key);
    // Without a link the occurrence is its identity, which carries the event's own start time.
    const key = alert.archive ?? alert.identity;
    const old = this.records.get(key);
    // A recovery and a cancellation (rule edited or switched off) both close the occurrence.
    const closing = alert.recovered || alert.cancelled;
    if (!old) {
      // An omitted first delivery may recur; don't admit it as a new root while still fresh.
      if (this.records.size >= this.limit || this.now() < this.holdNewUntil) {
        this.holdNewUntil = this.now() + this.ttl;
        return;
      }
      const thread: Thread = { alert, root: ts, bot, state: closing ? "ignored" : "open" };
      this.records.set(key, thread);
      return closing ? undefined : { kind: "offer", thread };
    }
    if (old.state === "ignored" || old.root === ts) return;
    if (!closing || old.bot !== bot || old.alert.identity !== alert.identity || ts <= old.root) {
      old.state = "ignored";
      return;
    }
    if (old.state !== "open") return;
    old.state = "resolved";
    // Not a recovery: the event ended because its rule changed, so there is no duration to report.
    if (alert.cancelled) return { kind: "resolved", root: old.root, text: `DISABLED: 규칙이 바뀌거나 꺼져 이벤트가 닫혔습니다 · 시작 ${alert.start}` };
    if (alert.endMs === undefined) {
      const startMs = Math.floor(Number(old.root) * 1000), endMs = Math.floor(Number(ts) * 1000);
      return { kind: "resolved", root: old.root, text: `RECOVERED: ${new Date(endMs).toISOString()} (Slack 수신 기준) · 수신 간격 ${Math.floor((endMs - startMs) / 1000)}초` };
    }
    return { kind: "resolved", root: old.root,
      text: `RECOVERED: ${alert.end} (이벤트 시각) · 시작 ${alert.start} · 소요 ${Math.round((alert.endMs - alert.startMs) / 1000)}초` };
  }
}
