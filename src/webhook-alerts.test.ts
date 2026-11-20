import assert from "node:assert/strict";
import { test } from "node:test";
import { AlertThreads, alertSource, alertTimeZone, incidentPrompt, readAlert } from "./webhook-alerts.js";

const body = ["프로젝트 이름 : example", "프로젝트 코드 : 42", "에이전트 이름 : test-target", "이벤트 메시지 : sample",
  "이벤트 시작 시간 : 2025-01-31 09:00:00 +0900", "바로가기 : https://fixture.invalid/link/event?pcode=42&archiveId=17"].join("\n");
const pretext = "[Critical][fixture][example][test-target][test-rule]";
const parse = (text = body, title = pretext) => readAlert([{ pretext: title, text }]);
const recovered = pretext.replace("[test-rule]", "[RECOVERED: test-rule]");
const offBody = body + "\n이벤트 종료 시간 : 2025-01-31 09:05:00 +0900";

test("expired or over-capacity state cannot be reused as a new incident", () => {
  let now = Date.now();
  const ts = `${Math.floor(now / 1000)}.000001`;
  const threads = new AlertThreads(() => now, 1);
  assert.equal(threads.observe(parse()!, ts, "B1")?.kind, "offer");
  now += 1000;
  const second = `${Math.floor(now / 1000)}.000001`;
  assert.equal(threads.observe(parse(body.replace("archiveId=17", "archiveId=18"))!, second, "B1"), undefined, "do not evict live state to admit another start");
  now += 25 * 60 * 60 * 1000;
  assert.equal(threads.get(ts), undefined);
  assert.equal(threads.observe(parse()!, ts, "B1"), undefined, "expired Slack retry");
  assert.equal(threads.observe(parse()!, `${Math.floor(now / 1000)}.000001`, "B1")?.kind, "offer");
});

// Alerts that keep arriving while the tracker is full must not keep it closed: once an old entry expires, new alerts are
// tracked again. An occurrence refused while full stays refused while its first root is fresh (it may recur as a second root).
test("a full tracker resumes as soon as an expired entry frees space, however many alerts arrived meanwhile", () => {
  const hour = 60 * 60 * 1000;
  let now = Date.now();
  const at = () => `${Math.floor(now / 1000)}.000001`;
  const archive = (id: number) => parse(body.replace("archiveId=17", `archiveId=${id}`))!;
  const threads = new AlertThreads(() => now, 1);
  assert.equal(threads.observe(archive(17), at(), "B1")?.kind, "offer");
  for (let id = 18; id <= 40; id++) {
    now += hour;
    assert.equal(threads.observe(archive(id), at(), "B1"), undefined, `full at hour ${id - 17}`);
  }
  now += hour + 60_000; // archive 17 is now more than a day old and leaves the tracker
  assert.equal(threads.observe(archive(40), at(), "B1"), undefined, "a refused occurrence is not admitted later as a new root");
  assert.equal(threads.observe(archive(99), at(), "B1")?.kind, "offer", "a new alert is tracked again");
  now += 1000;
  assert.equal(threads.observe(archive(100), at(), "B1"), undefined, "and the tracker is full again");
});

test("source requires a full explicit bundle of IDs (never names or wildcards)", () => {
  const env = { SLACK_ALERT_TEAM_ID: "T1", SLACK_ALERT_CHANNEL_ID: "C1", SLACK_ALERT_BOT_IDS: "B1, B2" };
  assert.deepEqual([...alertSource(env)!.bots], ["B1", "B2"]);
  for (const key of Object.keys(env)) for (const bad of [undefined, "", "*", "B2,", "test-name"]) {
    assert.equal(alertSource({ ...env, [key]: bad }), undefined);
  }
});
test("parser rejects ambiguous identity fields, bad clocks and unsupported shapes", () => {
  assert.ok(parse());
  for (const [label, text, title] of [
    ["two target fields", body + "\n서버 이름 : test-target", pretext],
    ["duplicate project", body + "\n프로젝트 코드 : 42", pretext],
    ["wrong target", body.replace("test-target", "other"), pretext],
    ["missing target", body.replace("에이전트 이름", "unknown"), pretext],
    ["mismatched archive project", body.replace("pcode=42", "pcode=43"), pretext],
    ["duplicate archive id", body + "&archiveId=18", pretext],
    ["impossible date", body.replace("01-31", "02-31"), pretext],
    ["no offset", body.replace(" +0900", ""), pretext],
    ["non-recovery with end", offBody, pretext],
    ["end before start", offBody.replace("09:05:00", "08:55:00"), recovered],
    ["disabled", body, pretext.replace("[test-rule]", "[DISABLED: test-rule]")],
  ]) assert.equal(parse(text, title), undefined, label);
  assert.equal(readAlert([{ pretext, text: body }, { pretext, text: body }]), undefined);
  assert.equal(readAlert([{ text: body }]), undefined);
});
test("correlation requires matching source, project, archive, target, rule and actual start", () => {
  const now = Math.floor(Date.now() / 1000) - 10;
  for (const [label, text, title, bot] of [
    ["sender", offBody, recovered, "B2"],
    ["project", offBody.replaceAll("42", "43"), recovered, "B1"],
    ["archive", offBody.replace("archiveId=17", "archiveId=18"), recovered, "B1"],
    ["no archive", offBody.replace(/^바로가기.*$/m, ""), recovered, "B1"],
    ["host", offBody.replace("fixture.invalid", "other.invalid"), recovered, "B1"],
    ["target", offBody.replace("test-target", "other"), recovered.replace("test-target", "other"), "B1"],
    ["title", offBody, recovered.replace("test-rule", "other"), "B1"],
    ["condition", offBody + "\n알림 조건 : different", recovered, "B1"],
    ["onset", offBody.replace("09:00:00", "09:00:01"), recovered, "B1"],
  ]) {
    const threads = new AlertThreads();
    assert.equal(threads.observe(parse()!, `${now}.000001`, "B1")?.kind, "offer");
    const off = parse(text, title); assert.ok(off, label);
    assert.equal(threads.observe(off, `${now + 1}.000001`, bot), undefined, label);
  }
});

// The sender omits the link unless its deployment turns event links on, so a start and its RECOVERED
// must also pair on the remaining identity (which carries the event's own start time).
const noLink = (text: string) => text.replace(/\n?바로가기.*$/m, "");
test("alerts without a link pair on the same identity and start time, once", () => {
  const now = Math.floor(Date.now() / 1000) - 10;
  const threads = new AlertThreads();
  const start = parse(noLink(body))!;
  assert.equal(start.archive, undefined);
  assert.equal(threads.observe(start, `${now}.000001`, "B1")?.kind, "offer");
  const off = threads.observe(parse(noLink(offBody), recovered)!, `${now + 1}.000001`, "B1");
  assert.equal(off?.kind, "resolved");
  assert.equal(off.kind === "resolved" && off.root, `${now}.000001`);
  assert.match(off.kind === "resolved" ? off.text : "", /2025-01-31 09:05:00 \+0900.*300초/);
  assert.equal(threads.observe(parse(noLink(offBody), recovered)!, `${now + 2}.000001`, "B1"), undefined, "recorded once");
});
test("alerts without a link never pair across a different identity, a linked message or two starts", () => {
  const now = Math.floor(Date.now() / 1000) - 10;
  for (const [label, text, title, bot] of [
    ["sender", noLink(offBody), recovered, "B2"],
    ["project", noLink(offBody).replaceAll("42", "43"), recovered, "B1"],
    ["target", noLink(offBody).replace("test-target", "other"), recovered.replace("test-target", "other"), "B1"],
    ["title", noLink(offBody), recovered.replace("test-rule", "other"), "B1"],
    ["condition", noLink(offBody) + "\n알림 조건 : different", recovered, "B1"],
    ["onset", noLink(offBody).replace("09:00:00", "09:00:01"), recovered, "B1"],
    ["linked recovery", offBody, recovered, "B1"],
  ]) {
    const threads = new AlertThreads();
    assert.equal(threads.observe(parse(noLink(body))!, `${now}.000001`, "B1")?.kind, "offer");
    const off = parse(text, title); assert.ok(off, label);
    assert.equal(threads.observe(off, `${now + 1}.000001`, bot), undefined, label);
  }
  const threads = new AlertThreads();
  assert.equal(threads.observe(parse(noLink(body))!, `${now}.000001`, "B1")?.kind, "offer");
  assert.equal(threads.observe(parse(noLink(body))!, `${now + 1}.000001`, "B1"), undefined, "a second root for the same identity");
  assert.equal(threads.observe(parse(noLink(offBody), recovered)!, `${now + 2}.000001`, "B1"), undefined, "never choose between two roots");
  assert.equal(threads.get(`${now}.000001`), undefined, "and its button is retired");
});

// The reading side of the incident text contract: the regexes of argus-agents sms.sre.incident (tools.py),
// which that file declares canonical. The bot's text is read here the way the workflow's code reads it.
const SRE = {
  header: /SRE 사건 분석 요청입니다|SRE インシデント分析の依頼です|SRE incident analysis request/i,
  rule: /«([^»]+)»/,
  servers: /(?:서버|サーバー)\s*(\d+)\s*(?:대|台)|(\d+)\s*servers?\b/i,
  ref: /(?:기준\s*시각|基準時刻|reference\s+time)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/i,
  storm: /폭주|ストーム|\bstorm\b/i,
  targets: /^(?:대상 서버|対象サーバー|target servers)\s*[:：]\s*$/i,
  alerts: /^(?:알림|アラート|alerts)\s*[:：]\s*$/i,
  targetRow: /^-\s*\[([^\]]+)\]\s*(.+?)\s*\(oid\s*(-?\d+)(?:\s*,\s*os\s+([A-Za-z][\w.-]{0,30}))?\)\s*(?:—\s*(.*))?$/i,
  alertRow: /^-\s*(\S+)\s+(Critical|Warning|Info)\s+(.+?)\s+—\s+(.*)$/i,
};
function readIncident(message: string) {
  const lines = message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !SRE.header.test(lines[0])) return undefined;
  const ref = SRE.ref.exec(lines[0]), n = SRE.servers.exec(lines[0]);
  const out = {
    rule: SRE.rule.exec(lines[0])?.[1].trim() ?? "", ref: ref ? `${ref[1]} ${ref[2].padStart(2, "0")}:${ref[3]}` : "",
    servers: n ? Number(n[1] ?? n[2]) : undefined, storm: SRE.storm.test(lines[0]), lines: lines.length, last: lines.at(-1),
    targets: [] as { verdict: string; oname: string; oid: number; detail: string }[],
    alerts: [] as { time: string; level: string; oname: string; message: string }[],
  };
  let section = "";
  for (const line of lines.slice(1)) {
    if (SRE.targets.test(line)) { section = "targets"; continue; }
    if (SRE.alerts.test(line)) { section = "alerts"; continue; }
    const t = section === "targets" ? SRE.targetRow.exec(line) : null;
    const a = section === "alerts" ? SRE.alertRow.exec(line) : null;
    if (t) out.targets.push({ verdict: t[1], oname: t[2].trim(), oid: Number(t[3]), detail: t[5] ?? "" });
    else if (a) out.alerts.push({ time: a[1], level: a[2], oname: a[3].trim(), message: a[4] });
  }
  return out;
}
const alertWith = (over: { level?: string; message?: string; rule?: string; target?: string } = {}) => {
  const target = over.target ?? "test-target";
  return readAlert([{ pretext: `[${over.level ?? "Critical"}][fixture][example][${target}][${over.rule ?? "test-rule"}]`,
    text: body.replace("이벤트 메시지 : sample", `이벤트 메시지 : ${over.message ?? "CPU = 97%"}`).replace("에이전트 이름 : test-target", `에이전트 이름 : ${target}`) }]);
};

test("the analysis request is the incident text the SRE workflow reads: rule, reference time, one target, one alert", () => {
  const text = incidentPrompt(alertWith()!);
  const got = readIncident(text);
  assert.ok(got, "the first line must be the incident header, or the workflow is not chosen");
  assert.deepEqual({ rule: got.rule, ref: got.ref, servers: got.servers, storm: got.storm, lines: got.lines },
    { rule: "test-rule", ref: "2025-01-31 09:00", servers: 1, storm: false, lines: 6 });
  assert.deepEqual(got.targets.map(({ verdict, oname, oid }) => ({ verdict, oname, oid })), [{ verdict: "위험", oname: "test-target", oid: 0 }]);
  assert.match(got.targets[0].detail, /^1건, 최근 09:00 «CPU = 97%»$/);
  assert.deepEqual(got.alerts, [{ time: "09:00", level: "Critical", oname: "test-target", message: "CPU = 97%" }]);
  assert.equal(got.last, "원인을 분석하고 OPM 조치안을 제안하세요.");
  assert.doesNotMatch(text, /fixture\.invalid|archiveId/, "the link is not part of the request");
});
test("the alert level becomes the contract's verdict word; only Critical and Warning are 위험 and 주의", () => {
  for (const [level, word] of [["Critical", "위험"], ["Warning", "주의"]]) {
    const got = readIncident(incidentPrompt(alertWith({ level })!))!;
    assert.equal(got.targets[0].verdict, word, level);
    assert.equal(got.alerts[0].level, level);
  }
  const info = readIncident(incidentPrompt(alertWith({ level: "Info" })!))!;
  assert.equal(info.targets.length, 1);
  assert.ok(!["위험", "주의", "critical", "warning", "危険", "注意"].includes(info.targets[0].verdict.toLowerCase()), "Info is neither");
});
test("an oid written in the event message reaches the target row; none, zero or two different ones mean unknown (0)", () => {
  for (const [message, oid] of [
    ["CPU = 97% (oid 1234)", 1234], ["oid=-1234567890 CPU = 97%", -1234567890], ["CPU 97%, OID: 77", 77], ["oid 9 … oid 9", 9],
    ["CPU = 97%", 0], ["oid 0", 0], ["void 12", 0], ["android 5", 0], ["oid abc", 0], ["oid 12x", 0], ["oid 12 oid 34", 0],
  ] as const) {
    const got = readIncident(incidentPrompt(alertWith({ message })!))!;
    assert.deepEqual(got.targets.map((t) => [t.oname, t.oid]), [["test-target", oid]], message);
  }
});
test("quotes and dashes in the rule or message cannot change which rows the workflow reads; long text is cut", () => {
  const got = readIncident(incidentPrompt(alertWith({ rule: "disk » full «x» — now", message: "값 — 97% «peak» — web-99 (id 5) — z" })!))!;
  assert.equal(got.rule, "disk full x - now");
  assert.deepEqual(got.targets.map((t) => [t.oname, t.oid]), [["test-target", 0]]);
  assert.deepEqual(got.alerts.map((a) => [a.oname, a.message]), [["test-target", "값 - 97% peak - web-99 (id 5) - z"]]);
  const long = readIncident(incidentPrompt(alertWith({ rule: "r".repeat(180), message: "m".repeat(900) })!))!;
  assert.equal(long.rule.length, 120);
  assert.equal(long.alerts[0].message.length, 200);
  assert.equal(long.targets.length, 1);
});
test("an alert whose target name would break the row grammar is not admitted; ordinary punctuation is", () => {
  for (const target of ["web — 01", "web «x»", "web (oid 5)", "web (OID -5) x"]) assert.equal(alertWith({ target }), undefined, target);
  for (const target of ["web(01)", "web-01.example", "web 01"]) {
    const got = readIncident(incidentPrompt(alertWith({ target })!))!;
    assert.deepEqual(got.targets.map((t) => t.oname), [target]);
    assert.deepEqual(got.alerts.map((a) => a.oname), [target]);
  }
});

// What a WhaTap "Webhook JSON" plugin posts when its body is the template in docs/webhook-alerts.md: the same
// subject and `key : value` lines, carrying the event's status, epoch times, server oid and event id.
// The shape is that of a real delivery; names, the oid and the event id are replaced.
const wj = (over: Partial<Record<"status" | "time" | "off" | "oid" | "id" | "message" | "title" | "level", string>> = {}) => {
  const f = { status: "on", time: "1795003326611", off: "", oid: "987654321", id: "0123456789abcdef0123456789abcdef",
    message: "cpu 0.8511", title: "test-rule", level: "Warning", ...over };
  return [{ pretext: `[${f.level}][Server][example][test-target][${f.title}]`,
    text: ["프로젝트 이름 : example", "프로젝트 코드 : 42", "서버 이름 : test-target", `이벤트 메시지 : ${f.message}`, `이벤트 상태 : ${f.status}`,
      `이벤트 시각(ms) : ${f.time}`, `해소 시각(ms) : ${f.off}`, `서버 oid : ${f.oid}`, `이벤트 ID : ${f.id}`, "지표 : cpu = 0.8511 (임계값 0.0)"].join("\n") }];
};
test("a Webhook JSON alert carries the server oid and the event's start in the configured zone", () => {
  const alert = readAlert(wj(), "Asia/Seoul");
  assert.ok(alert);
  assert.deepEqual({ project: alert.project, target: alert.target, rule: alert.rule, level: alert.level, oid: alert.oid, start: alert.start, startMs: alert.startMs, recovered: alert.recovered },
    { project: "42", target: "test-target", rule: "test-rule", level: "Warning", oid: "987654321", start: "2026-11-18 21:02:06 +0900", startMs: 1795003326611, recovered: false });
  assert.equal(readAlert(wj(), "America/New_York")?.start, "2026-11-18 07:02:06 -0500");
  const got = readIncident(incidentPrompt(alert))!;
  assert.equal(got.ref, "2026-11-18 21:02");
  assert.deepEqual(got.targets.map((t) => [t.oname, t.oid]), [["test-target", 987654321]]);
  assert.equal(readAlert(wj()), undefined, "epoch times are not rendered without a configured zone");
});
// Unattended action trusts only the structured field. An oid written in the event message (free text by whoever wrote the
// rule, or forged in an alert body) still reaches the analysis text, but it never names the server to act on.
test("only the Webhook JSON 서버 oid field names the server for unattended action; an oid in the event message does not", () => {
  const template = alertWith({ message: "CPU = 97% (oid 1234)" })!;
  assert.equal(template.oid, "1234", "the analysis text still carries it");
  assert.equal(template.serverOid, undefined);
  assert.equal(readAlert(wj(), "Asia/Seoul")?.serverOid, "987654321");
  assert.equal(readAlert(wj({ oid: "-1234567890" }), "Asia/Seoul")?.serverOid, "-1234567890");
  assert.equal(readAlert(wj({ oid: "", message: "cpu 0.85 (oid 1234)" }), "Asia/Seoul")?.serverOid, undefined, "a JSON message is free text too");
});
test("Webhook JSON off closes its own event once with the event's end time; an off without one says so", () => {
  const now = Math.floor(Date.now() / 1000) - 10, zone = "Asia/Seoul", root = `${now}.000001`;
  // Whether the closing title repeats the RECOVERED prefix or not, it is the same rule.
  for (const title of ["RECOVERED: test-rule", "test-rule"]) {
    const threads = new AlertThreads();
    assert.equal(threads.observe(readAlert(wj(), zone)!, root, "B1")?.kind, "offer");
    const off = readAlert(wj({ status: "off", off: "1795003656999", title, level: "Info", message: "RECOVERED" }), zone);
    assert.ok(off, title);
    assert.deepEqual({ rule: off.rule, recovered: off.recovered, end: off.end }, { rule: "test-rule", recovered: true, end: "2026-11-18 21:07:36 +0900" });
    const note = threads.observe(off, `${now + 1}.000001`, "B1");
    assert.deepEqual(note, { kind: "resolved", root, text: "RECOVERED: 2026-11-18 21:07:36 +0900 (이벤트 시각) · 시작 2026-11-18 21:02:06 +0900 · 소요 330초" });
    assert.equal(threads.observe(off, `${now + 2}.000001`, "B1"), undefined, "recorded once");
  }
  const threads = new AlertThreads();
  threads.observe(readAlert(wj(), zone)!, root, "B1");
  const other = readAlert(wj({ status: "off", off: "1795003656999", id: "0".repeat(32), title: "RECOVERED: test-rule", level: "Info" }), zone)!;
  assert.equal(threads.observe(other, `${now + 1}.000001`, "B1"), undefined, "another event's off, though rule, target and start agree");
  const bare = threads.observe(readAlert(wj({ status: "off", title: "RECOVERED: test-rule", level: "Info" }), zone)!, `${now + 7}.000001`, "B1");
  assert.match(bare?.kind === "resolved" ? bare.text : "", /\(Slack 수신 기준\) · 수신 간격 7초$/);
});
// Editing or switching off a rule while its event is open sends status cancel with a DISABLED title, not an off.
test("Webhook JSON cancel closes the thread as DISABLED with no duration; a close seen first never arms a start", () => {
  const now = Math.floor(Date.now() / 1000) - 10, zone = "Asia/Seoul", root = `${now}.000001`;
  const stop = readAlert(wj({ status: "cancel", title: "DISABLED: test-rule", level: "Info", message: "DISABLED" }), zone);
  assert.ok(stop);
  assert.deepEqual({ rule: stop.rule, recovered: stop.recovered, cancelled: stop.cancelled }, { rule: "test-rule", recovered: false, cancelled: true });
  const threads = new AlertThreads();
  assert.equal(threads.observe(readAlert(wj(), zone)!, root, "B1")?.kind, "offer");
  assert.deepEqual(threads.observe(stop, `${now + 3}.000001`, "B1"),
    { kind: "resolved", root, text: "DISABLED: 규칙이 바뀌거나 꺼져 이벤트가 닫혔습니다 · 시작 2026-11-18 21:02:06 +0900" });
  assert.ok(threads.get(root), "the incident can still be analysed");
  const off = readAlert(wj({ status: "off", off: "1795003656999", title: "RECOVERED: test-rule", level: "Info" }), zone)!;
  assert.equal(threads.observe(off, `${now + 4}.000001`, "B1"), undefined, "closed once");
  const late = new AlertThreads();
  assert.equal(late.observe(stop, root, "B1"), undefined);
  assert.equal(late.observe(readAlert(wj(), zone)!, `${now + 1}.000001`, "B1"), undefined, "a start after its own close gets no button");
});

// Webhook JSON epoch times are printed only in a zone the operator names; the host's own zone is a guess.
test("the alert time zone is an IANA name checked at startup; without one, epoch alerts stay unread", () => {
  assert.equal(alertTimeZone({}), undefined);
  assert.equal(alertTimeZone({ ALERT_TIME_ZONE: "" }), undefined);
  assert.equal(alertTimeZone({ ALERT_TIME_ZONE: "Asia/Seoul" }), "Asia/Seoul");
  for (const bad of ["Asia/Nowhere", "KST+9", "not a zone", "+09:00"]) {
    assert.throws(() => alertTimeZone({ ALERT_TIME_ZONE: bad }), /ALERT_TIME_ZONE/, bad);
  }
});
