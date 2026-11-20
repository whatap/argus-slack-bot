// 자동 대응(온콜) — 알림 채널에 당번을 정해 두면, 새 알림이 왔을 때 봇이 [분석] 버튼을 기다리지 않고 당번의
// 와탭 권한으로 분석을 시작하고, 정해 둔 위험도 안의 OPM 조치안 하나를 스스로 실행한다.
// 설정 읽기·대상 판정·조치안 나누기·명령 읽기·당번 저장소·타이머를 여기 두고, index.ts 는 Slack·와탭 호출만 잇는다.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ChipAction } from "./claude-loop.js";
import { OPM_CHIP_TYPE, riskOf } from "./opm-action-chips.js";
import { LoginRequiredError } from "./whatap-oauth.js";

export type OpmRisk = "normal" | "warning" | "critical";

export interface OncallSettings {
  /** 규칙 이름에 이 중 하나가 들어 있는 알림만 자동 대응한다. 비어 있으면 아무 알림도 대상이 아니다. */
  rules: string[];
  /** 사람 확인 없이 실행할 OPM 조치안의 위험도. */
  risks: OpmRisk[];
  /** 자동 조치 뒤 이만큼(분) 지나도 해소되지 않으면 당번을 부른다. */
  escalateMin: number;
  /** 당번 토큰을 이 간격(분)으로 갱신해 둔다(refresh token 수명 8시간보다 짧게). */
  keepAliveMin: number;
}

const RISKS: readonly OpmRisk[] = ["normal", "warning", "critical"];

/** 쉼표로 나눈 목록. 앞뒤 공백과 빈 칸은 버린다. */
const list = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** 분 단위 양의 정수. 비어 있으면 기본값. max 는 그 값을 넘지 않아야 한다. */
function minutes(env: Record<string, string | undefined>, key: string, fallback: number, max: number): number {
  const raw = (env[key] ?? "").trim();
  if (!raw) return fallback;
  const n = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  if (!(n <= max)) throw new Error(`${key} 는 1~${max} 사이의 분(정수)이어야 해요: ${raw}`);
  return n;
}

export function loadOncallSettings(
  env: Record<string, string | undefined>,
  deps: { whatapLogin: boolean; alertChannel: boolean },
): OncallSettings | null {
  const flag = (env.ONCALL_AUTO ?? "").trim();
  // 꺼져 있으면(기본) 나머지 값은 읽지 않는다 — 지금과 똑같이 동작한다.
  if (flag !== "1") {
    if (flag !== "" && flag !== "0") throw new Error(`ONCALL_AUTO 는 1(켜기) 또는 0(끄기)이어야 해요: ${flag}`);
    return null;
  }
  // 당번 본인의 와탭 권한으로만 분석·조치한다. 공용 계정으로 떨어지지 않게 로그인 모드가 아니면 시작하지 않는다.
  if (!deps.whatapLogin) throw new Error("자동 대응(ONCALL_AUTO=1)은 와탭 로그인(OAuth) 모드에서만 켤 수 있어요");
  if (!deps.alertChannel) {
    throw new Error("자동 대응(ONCALL_AUTO=1)에는 알림 채널 설정(SLACK_ALERT_TEAM_ID·SLACK_ALERT_CHANNEL_ID·SLACK_ALERT_BOT_IDS)이 필요해요");
  }
  const risks = list(env.ONCALL_AUTO_RISKS?.trim() ? env.ONCALL_AUTO_RISKS : "normal,warning");
  for (const r of risks) {
    if (!RISKS.includes(r as OpmRisk)) throw new Error(`ONCALL_AUTO_RISKS 에는 normal·warning·critical 만 쓸 수 있어요: ${r}`);
  }
  return {
    rules: list(env.ONCALL_AUTO_RULES),
    risks: risks as OpmRisk[],
    // 사건은 하루만 기억하고, setTimeout 은 24.8일이 넘는 지연을 곧바로 부른다. 그래서 하루(1440분)까지만 받는다.
    escalateMin: minutes(env, "ONCALL_ESCALATE_MIN", 10, 1440),
    // refresh token 은 8시간(480분)이면 끝난다. 그 전에 한 번은 갱신해야 이어진다.
    keepAliveMin: minutes(env, "ONCALL_KEEPALIVE_MIN", 60, 479),
  };
}

/** 알림의 규칙 이름에 설정한 부분 문자열 중 하나가 들어 있으면 자동 대응 대상이다. 목록이 비면 아무것도 아니다. */
export function ruleEligible(rules: readonly string[], rule: string): boolean {
  return rules.some((part) => rule.includes(part));
}

export interface OpmPick {
  /** 사람 확인 없이 실행할 조치안. 사건마다 많아야 하나다. */
  auto?: ChipAction;
  /** 나머지 chip — 지금처럼 버튼으로 그린다(OPM 조치안은 당번만 누를 수 있다). */
  manual: ChipAction[];
}

/**
 * 자동 대응 답의 chip 을 자동 실행 하나와 나머지로 나눈다. 자동 실행은 OPM 조치안 가운데 위험도가 risks 안에 있고,
 * 알림이 가리키는 서버(같은 프로젝트의 같은 oid)를 겨냥한 첫 번째 것뿐이다. 알림에 oid 가 없으면 아무것도 자동이 아니다.
 */
export function pickAutoOpm(chips: ChipAction[], target: { project: string; oid?: string }, risks: readonly OpmRisk[]): OpmPick {
  // 알림이 서버 oid 를 모르면 어느 조치안이 그 서버를 겨냥하는지 알 수 없다 — 모두 사람이 누른다.
  const sameServer = (p: Record<string, unknown>) => target.oid !== undefined &&
    String(p["oid"] ?? "") === target.oid && String(p["pcode"] ?? "") === target.project;
  const auto = chips.find((c) => c.type === OPM_CHIP_TYPE && typeof c.payload["confirmToken"] === "string" && c.payload["confirmToken"] !== "" &&
    risks.includes(riskOf(c.payload)) && sameServer(c.payload));
  return { auto, manual: chips.filter((c) => c !== auto) };
}

const RISK_WORD: Record<OpmRisk, string> = { normal: "보통(normal)", warning: "주의(warning)", critical: "높음(critical)" };

/** 켜기·상태 명령에 보여 줄 설정 — 어떤 알림을, 어디까지 사람 없이 하고, 언제 당번을 부르는지. */
export function oncallSettingsLines(s: OncallSettings): string[] {
  return [
    s.rules.length
      ? `• 대상 알림: 규칙 이름에 다음 글자가 들어 있는 알림 — ${s.rules.map((r) => `\`${r}\``).join(", ")}`
      : "• 대상 알림: 없음 — ONCALL_AUTO_RULES 가 비어 있어 어떤 알림도 자동 대응하지 않아요",
    `• 사람 확인 없이 실행하는 조치: 위험도 ${s.risks.map((r) => RISK_WORD[r]).join("·")} — 사건마다 하나, 알림이 가리킨 서버에만`,
    `• 자동 조치 뒤 ${s.escalateMin}분 안에 해소되지 않으면 당번을 불러요. 멈추려면 누구든 \`자동 대응 끄기\``,
  ];
}

export type OncallCommand = "on" | "off" | "status";

const COMMANDS = new Map<string, OncallCommand>([["자동 대응 켜기", "on"], ["자동 대응 끄기", "off"], ["자동 대응 상태", "status"]]);

/** 알림 채널에서 봇을 멘션한 글(멘션은 뺀 것)이 자동 대응 명령인지. 글 전체가 명령과 같아야 한다. */
export function parseOncallCommand(text: string): OncallCommand | undefined {
  return COMMANDS.get(text.trim().replace(/\s+/g, " "));
}

export interface OncallOwner {
  teamId: string;
  channelId: string;
  ownerId: string;
}

/** 채널의 당번. 와탭 연결과 같은 SQLite 파일에 두어 봇이 다시 시작해도 남는다. 토큰은 두지 않는다(와탭 연결 저장소에 있다). */
export class OncallOwners {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oncall_owners (
        team_id     TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        owner_id    TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (team_id, channel_id)
      )
    `);
  }

  get(teamId: string, channelId: string): string | null {
    const row = this.db.prepare(`SELECT owner_id FROM oncall_owners WHERE team_id = ? AND channel_id = ?`)
      .get(teamId, channelId) as { owner_id: string } | undefined;
    return row?.owner_id ?? null;
  }

  set(teamId: string, channelId: string, ownerId: string): void {
    this.db.prepare(
      `INSERT INTO oncall_owners (team_id, channel_id, owner_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(team_id, channel_id) DO UPDATE SET owner_id = excluded.owner_id, updated_at = excluded.updated_at`,
    ).run(teamId, channelId, ownerId, Date.now());
  }

  clear(teamId: string, channelId: string): boolean {
    return this.db.prepare(`DELETE FROM oncall_owners WHERE team_id = ? AND channel_id = ?`).run(teamId, channelId).changes > 0;
  }

  list(): OncallOwner[] {
    const rows = this.db.prepare(`SELECT team_id, channel_id, owner_id FROM oncall_owners ORDER BY team_id, channel_id`)
      .all() as { team_id: string; channel_id: string; owner_id: string }[];
    return rows.map((r) => ({ teamId: r.team_id, channelId: r.channel_id, ownerId: r.owner_id }));
  }

  /** 앱이 지워진 워크스페이스의 당번을 모두 지운다. */
  deleteTeam(teamId: string): number {
    return this.db.prepare(`DELETE FROM oncall_owners WHERE team_id = ?`).run(teamId).changes;
  }

  close(): void {
    this.db.close();
  }
}

/** 타이머와 시계. 테스트가 손으로 돌릴 수 있게 주입한다. 걸어 둔 타이머는 unref 해 프로세스 종료를 막지 않는다. */
export interface OncallTimers {
  now(): number;
  setTimeout(fn: () => unknown, ms: number): { unref?(): unknown };
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => unknown, ms: number): { unref?(): unknown };
  clearInterval(handle: unknown): void;
}

export const systemTimers: OncallTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

interface Incident {
  owner: string;
  at: number;
  /** 이 사건에서 자동으로 실행한(하려는) 조치안의 확인 토큰. 사건마다 하나다. */
  token?: string;
  /** 자동으로 실행한 시각(봇 시계). */
  appliedAt?: number;
  escalation?: unknown;
}

/** 자동 대응한 사건(알림 원본 글 ts 마다)의 상태 — 한 번만 분석, 자동 조치는 하나, 에스컬레이션 타이머. 메모리에만 둔다. */
export class OncallIncidents {
  private readonly incidents = new Map<string, Incident>();
  /** 알림 추적(AlertThreads)과 같이 하루만 기억한다. */
  private readonly ttl = 24 * 60 * 60 * 1000;

  constructor(private readonly timers: OncallTimers) {}

  /** 이 원본 글을 처음 자동 대응하면 true. */
  claim(root: string, owner: string): boolean {
    const now = this.timers.now();
    for (const [key, i] of this.incidents) {
      if (now - i.at < this.ttl) continue;
      if (i.escalation !== undefined) this.timers.clearTimeout(i.escalation);
      this.incidents.delete(key);
    }
    if (this.incidents.has(root)) return false;
    this.incidents.set(root, { owner, at: now });
    return true;
  }

  /** 이 사건에서 이 확인 토큰을 자동으로 실행해도 되면 표시하고 true. */
  tryApply(root: string, token: string): boolean {
    const incident = this.incidents.get(root);
    // 같은 확인 토큰은 어느 사건에서든 다시 실행하지 않는다(사건 기록이 남아 있는 하루 동안 — argus 토큰은 그 전에 만료된다).
    if (!incident || incident.token !== undefined || [...this.incidents.values()].some((i) => i.token === token)) return false;
    incident.token = token;
    return true;
  }

  /** 자동 조치를 실행했다. escalateMs 안에 해소(resolve)되지 않으면 onEscalate 를 한 번 부른다. */
  applied(root: string, escalateMs: number, onEscalate: () => unknown): void {
    const incident = this.incidents.get(root);
    if (!incident) return;
    incident.appliedAt = this.timers.now();
    const timer = this.timers.setTimeout(() => {
      incident.escalation = undefined;
      return onEscalate();
    }, escalateMs);
    timer.unref?.();
    incident.escalation = timer;
  }

  /** 사건이 해소됐다. 에스컬레이션을 멈추고, 자동 대응한 사건이면 당번과 자동 조치 뒤 지난 시간(봇 시계)을 돌려준다. */
  resolve(root: string): { owner: string; appliedAgoMs?: number } | undefined {
    const incident = this.incidents.get(root);
    if (!incident) return undefined;
    if (incident.escalation !== undefined) this.timers.clearTimeout(incident.escalation);
    incident.escalation = undefined;
    return incident.appliedAt === undefined
      ? { owner: incident.owner }
      : { owner: incident.owner, appliedAgoMs: this.timers.now() - incident.appliedAt };
  }
}

/** 자동 조치 뒤 정해 둔 시간이 지나도 해소되지 않았을 때 알림 스레드에 남겨 당번을 부르는 글. */
export function escalationText(owner: string, minutes: number): string {
  return `<@${owner}> 자동 조치 후 ${minutes}분이 지났는데 아직 해소되지 않았어요. 확인이 필요해요.`;
}

/** 자동 조치를 한 사건의 해소 글 끝에 붙인다. 두 시각 모두 봇 시계라 이벤트 시각과 섞지 않는다. */
export function resolvedAfterApply(ms: number): string {
  const took = ms < 60_000 ? "1분 안에" : `${Math.round(ms / 60_000)}분 만에`;
  return ` · 자동 조치 후 ${took} 해소 (봇 기준)`;
}

/**
 * 자동 대응 한 단계의 기록 한 줄 — ISO 시각, 워크스페이스, 채널, 원본 글 ts, 당번, 단계와 결과. 토큰·본문은 넘기지 않는다.
 * 값의 공백·줄바꿈은 _ 로 바꿔 한 줄이 둘로 읽히지 않게 한다.
 */
export function oncallLog(fields: { team: string; channel: string; root?: string; owner: string; step: string; [key: string]: string | number | undefined }, now: number): string {
  const { team, channel, root, owner, step, ...extra } = fields;
  const one = (v: string | number | undefined) => String(v ?? "-").replace(/\s+/g, "_");
  const rest = Object.entries(extra).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}=${one(v)}`).join("");
  return `[argus-slack-bot] oncall at=${new Date(now).toISOString()} team=${one(team)} channel=${one(channel)} root=${one(root)} owner=${one(owner)} step=${one(step)}${rest}`;
}

export interface KeepAliveDeps {
  timers: OncallTimers;
  everyMs: number;
  /** 토큰을 이어 둘 당번들. 부르는 쪽이 설정된 알림 채널과 설치된 워크스페이스로 거른다. */
  owners: () => OncallOwner[];
  /** 당번 토큰을 한 번 쓴다(withAccessToken 에 아무것도 안 하는 fn). 만료가 가까우면 이때 갱신된다. */
  refresh: (teamId: string, ownerId: string) => Promise<unknown>;
  /** 갱신이 거절돼(로그인 만료) 자동 대응이 멈췄다고 채널에 알리고, 로그인 링크를 당번에게만 보낸다. */
  notifyExpired: (owner: OncallOwner) => Promise<unknown>;
  log: (line: string) => void;
}

/** 자동 대응이 켜져 있는 동안 당번의 와탭 토큰이 끊기지 않게 주기적으로 한 번씩 쓴다. */
export class OncallKeepAlive {
  /** 로그인 만료를 이미 채널에 알린 당번(워크스페이스·채널·당번). 주기마다 다시 알리지 않는다. */
  private readonly notified = new Set<string>();

  constructor(private readonly deps: KeepAliveDeps) {}

  start(): void {
    const timer = this.deps.timers.setInterval(() => this.tick(), this.deps.everyMs);
    timer.unref?.();
  }

  /** 한 주기. 실패해도 다음 당번·다음 주기는 이어 간다(던지지 않는다). */
  async tick(): Promise<void> {
    for (const o of this.deps.owners()) {
      const key = JSON.stringify([o.teamId, o.channelId, o.ownerId]);
      const line = (result: string) => this.deps.log(oncallLog({ team: o.teamId, channel: o.channelId, owner: o.ownerId, step: "keepalive", result }, this.deps.timers.now()));
      try {
        await this.deps.refresh(o.teamId, o.ownerId);
        // 다시 로그인했으면 조용히 이어 간다. 다음에 또 멈추면 그때 다시 알린다.
        this.notified.delete(key);
        line("ok");
      } catch (err) {
        if (!(err instanceof LoginRequiredError)) {
          line("error");
          continue;
        }
        line("login-required");
        if (this.notified.has(key)) continue;
        this.notified.add(key);
        await this.deps.notifyExpired(o).catch(() => line("notify-failed"));
      }
    }
  }
}
