// OPM 조치안 chip (argus `applyOpmAction`) — 무엇을 어디서 실행하는지 보여 주고 [조치 실행]/[취소] 버튼을 단다.
//
// argus 는 확인 토큰을 그 조치를 실행할 권한 그 자체로 보고 대화 기록·로그에 남기지 않는다(argus#1066).
// Slack 메시지도 남는 기록이라 토큰은 봇 메모리(OpmChipStore)에만 두고, 버튼에는 그 토큰을 가리키는
// 손잡이(handle)만 싣는다. 봇이 다시 시작되면 손잡이가 사라져 버튼은 더 쓸 수 없다 — 다시 물어보면 된다.

import { randomBytes } from "node:crypto";

import type { ChipAction } from "./claude-loop.js";

export const OPM_CHIP_TYPE = "applyOpmAction";

/** 서버 조치를 실행할 허락(쓰기 scope)이 없을 때 다시 허락받을 링크와 함께 나에게만 보내는 안내. */
export const OPM_CONSENT_LEAD =
  ":key: 서버 조치를 실행하려면 와탭 로그인에서 쓰기 권한(*WhaTap 설정 변경*)을 허락해야 해요. 아래 링크에서 허락한 뒤 [조치 실행]을 다시 눌러 주세요.";

/** 조치안을 받은 사람. 버튼은 이 사람만 누를 수 있다(argus 도 토큰을 그 사용자에 묶는다). */
export interface OpmChipOwner {
  teamId: string;
  userId: string;
}

export interface OpmChipEntry extends OpmChipOwner {
  token: string;
  title: string;
  createdAt: number;
}

export class OpmChipStore {
  private readonly entries = new Map<string, OpmChipEntry>();
  private readonly retentionMs: number;
  private readonly maxEntries: number;

  /**
   * 보관 기간은 결재를 기다렸다가 [상태 확인]을 누를 만큼 길게 둔다(기본 24시간). 메모리에만 두므로
   * 개수에도 상한을 두고 오래된 것부터 버린다 — 버려진 버튼은 «더 쓸 수 없는 버튼» 으로 안내된다.
   */
  constructor(
    private readonly now: () => number = Date.now,
    opts: { retentionMs?: number; maxEntries?: number } = {},
  ) {
    this.retentionMs = opts.retentionMs ?? 24 * 60 * 60_000;
    this.maxEntries = opts.maxEntries ?? 1000;
  }

  put(token: string, owner: OpmChipOwner, title: string): string {
    const handle = randomBytes(12).toString("base64url");
    this.entries.set(handle, { token, teamId: owner.teamId, userId: owner.userId, title, createdAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return handle;
  }

  get(handle: string): OpmChipEntry | undefined {
    const entry = this.entries.get(handle);
    if (entry && this.now() - entry.createdAt > this.retentionMs) {
      this.entries.delete(handle);
      return undefined;
    }
    return entry;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Slack mrkdwn 에 넣을 글. &, <, > 를 엔티티로 바꿔 모델이 쓴 문장이 멘션·링크로 해석되지 않게 하고,
 * 바꾼 뒤 길이로 자른다(엔티티를 반쯤 자르지 않게 글자 단위로 센다).
 */
function clipEscaped(v: unknown, max: number): { text: string; clipped: boolean } {
  let out = "";
  for (const ch of String(v ?? "")) {
    const e = ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
    if (out.length + e.length > max) return { text: out, clipped: true };
    out += e;
  }
  return { text: out, clipped: false };
}

function esc(v: unknown, max = 300): string {
  const c = clipEscaped(v, max);
  return c.clipped ? c.text + "…" : c.text;
}

/** 모델이 쓴 글을 Slack mrkdwn 에 넣을 때(멘션·링크로 해석되지 않게, 길면 자른다). 자동 대응 글에도 쓴다. */
export const opmText = esc;

/** 코드 블록 안에 넣을 글 — ``` 가 블록을 닫지 않게 끊고 길면 줄인다. */
function codeBody(raw: string, max: number): string {
  const c = clipEscaped(raw.replace(/`{3,}/g, (m) => m.split("").join("\u200b")), max);
  return c.clipped ? c.text + "\n…(생략)" : c.text;
}

const TOOL_LABEL: Record<string, string> = {
  operant_action: "카탈로그 조치",
  operant_execute: "스크립트",
  operant_jobs_create: "Job 등록",
  operant_jobs_delete: "Job 삭제",
  operant_deploy_activate: "Job 배포 시작",
  operant_deploy_deactivate: "Job 배포 중지",
  operant_api_request: "OPM API 호출",
};

const RISK_LABEL: Record<string, string> = {
  normal: ":large_green_circle: 보통",
  warning: ":large_orange_circle: 주의",
  critical: ":red_circle: 높음",
};

/** argus NormalizeRisk 와 같은 규칙 — 자유 스크립트와 모르는 값은 가장 무거운 쪽으로 본다. */
export function riskOf(payload: Record<string, unknown>): "normal" | "warning" | "critical" {
  if (payload["tool"] === "operant_execute") return "critical";
  const r = String(payload["risk"] ?? "").trim().toLowerCase();
  return r === "normal" || r === "warning" ? r : "critical";
}

/** Slack section 문단 한도는 3000자다. */
const SECTION_MAX = 2900;
const CODE_MAX = 1200;

/**
 * 버튼 위에 그릴 조치안 — 대상 서버, 실행할 것(함수와 인자 또는 스크립트 원문), 위험도, 근거, 확인 마감.
 * 사용자는 무엇이 실행되는지 보고 눌러야 한다(argus 가 chip 에 arguments 를 싣는 이유).
 */
export function renderOpmProposal(payload: Record<string, unknown>): string {
  const args = asRecord(payload["arguments"]) ?? {};
  const tool = String(payload["tool"] ?? "");
  const lines = [`*:wrench: 조치안 — ${esc(payload["title"], 120)}*`];
  const oid = payload["oid"] ? ` · oid ${esc(payload["oid"], 20)}` : "";
  lines.push(payload["oname"]
    ? `• 대상: *${esc(payload["oname"], 100)}* (pcode ${esc(payload["pcode"], 20)}${oid})`
    : `• 대상: pcode ${esc(payload["pcode"], 20)}${oid}`);
  let code = "";
  switch (tool) {
    case "operant_action": {
      const params = Object.entries(asRecord(args["params"]) ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(", ");
      lines.push(`• 실행: 카탈로그 조치 \`${esc(args["function"], 100)}\`${params ? ` (${esc(params, 400)})` : ""}`);
      break;
    }
    case "operant_execute":
      lines.push("• 실행: 스크립트 (아래 원문 그대로)");
      code = String(args["scriptContent"] ?? "");
      break;
    case "operant_jobs_create":
      lines.push(`• 실행: Job 등록 *${esc(args["jobName"], 100)}*${args["triggerType"] ? ` (${esc(args["triggerType"], 20)} ${esc(args["triggerValue"], 60)})` : ""}`);
      code = JSON.stringify(args["script"] ?? {}, null, 2);
      break;
    case "operant_jobs_delete":
    case "operant_deploy_activate":
    case "operant_deploy_deactivate": {
      const job = asRecord(payload["job"]);
      const agents = Array.isArray(args["agents"]) ? ` · 대상 에이전트 ${args["agents"].length}개` : "";
      const digest = job?.["digest"] ? ` (정의 \`${esc(job["digest"], 12)}\`)` : "";
      lines.push(`• 실행: ${TOOL_LABEL[tool]} *${esc(job?.["jobName"] ?? args["jobId"], 100)}*${digest}${agents}`);
      break;
    }
    case "operant_api_request":
      lines.push(`• 실행: OPM API \`${esc(args["method"], 10)} ${esc(args["path"], 200)}\``);
      if (args["body"] !== undefined) code = JSON.stringify(args["body"], null, 2);
      break;
    default:
      lines.push(`• 실행: \`${esc(tool || "알 수 없음", 60)}\``);
      code = JSON.stringify(args, null, 2);
  }
  lines.push(`• 위험도: ${RISK_LABEL[riskOf(payload)]} — 결재를 거칠지는 OPM 설정이 정해요`);
  if (payload["rationale"]) lines.push(`• 근거: ${esc(payload["rationale"], 500)}`);
  const exp = Number(payload["expiresAt"]);
  if (Number.isFinite(exp) && exp > 0) {
    lines.push(`• 확인 마감: <!date^${Math.floor(exp / 1000)}^{date_short_pretty} {time}|${new Date(exp).toISOString().slice(0, 16).replace("T", " ")} UTC>`);
  }
  let text = lines.join("\n");
  if (code) text += "\n```" + codeBody(code, Math.min(CODE_MAX, SECTION_MAX - text.length - 8)) + "```";
  return text;
}

/** OPM 조치안 chip 마다 설명 문단과 [조치 실행]/[취소] 버튼 줄. 토큰은 store 에 두고 손잡이만 싣는다. */
export function opmChipBlocks(actions: ChipAction[], owner: OpmChipOwner, store: OpmChipStore): unknown[] {
  const blocks: unknown[] = [];
  for (const a of actions) {
    if (a.type !== OPM_CHIP_TYPE) continue;
    const token = typeof a.payload["confirmToken"] === "string" ? a.payload["confirmToken"] : "";
    if (!token) continue;
    const handle = store.put(token, owner, String(a.payload["title"] ?? a.label));
    const critical = riskOf(a.payload) === "critical";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: renderOpmProposal(a.payload) } });
    blocks.push({
      type: "actions",
      block_id: rowId(handle),
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "조치 실행" },
          action_id: `opm_action:apply:${handle}`,
          style: critical ? "danger" : "primary",
          // 서버에서 실제로 무언가가 돈다 — 잘못 누르지 않게 Slack 확인 창을 한 번 띄운다.
          confirm: {
            title: { type: "plain_text", text: "조치를 실행할까요?" },
            text: { type: "mrkdwn", text: `*${esc(a.payload["title"] ?? a.label, 120)}* 을(를) *${esc(a.payload["oname"] ?? `pcode ${String(a.payload["pcode"] ?? "")}`, 80)}* 에서 실행해요.` },
            confirm: { type: "plain_text", text: "실행" },
            deny: { type: "plain_text", text: "그만두기" },
            ...(critical ? { style: "danger" } : {}),
          },
        },
        { type: "button", text: { type: "plain_text", text: "취소" }, action_id: `opm_action:cancel:${handle}` },
      ],
    });
  }
  return blocks;
}

/** 버튼 줄과, 누른 뒤 그 자리에 놓는 상태 줄의 block_id. 손잡이마다 하나다. */
const rowId = (handle: string) => `opm_row:${handle}`;
const statusId = (handle: string) => `opm_status:${handle}`;

export type OpmOp = "apply" | "cancel" | "check";

/** 버튼을 누른 직전부터 답을 받을 때까지 버튼 자리에 두는 문장 — 두 번 누르지 않게 버튼을 바로 거둔다. */
export const OPM_PENDING: Record<OpmOp, string> = {
  apply: ":hourglass_flowing_sand: 실행 요청 중…",
  cancel: ":hourglass_flowing_sand: 취소하는 중…",
  check: ":hourglass_flowing_sand: 상태 확인 중…",
};

/** 버튼 줄 자리에 놓을 상태 줄. 다시 확인할 거리가 있으면(결재 대기 등) [상태 확인] 버튼을 함께 둔다. */
export function opmStatusRow(handle: string, status: string, withCheck = false): unknown[] {
  const rows: unknown[] = [{ type: "context", block_id: statusId(handle), elements: [{ type: "mrkdwn", text: status }] }];
  if (withCheck) {
    rows.push({
      type: "actions",
      block_id: rowId(handle),
      elements: [{ type: "button", text: { type: "plain_text", text: "상태 확인" }, action_id: `opm_action:check:${handle}` }],
    });
  }
  return rows;
}

/** 이 손잡이의 버튼 줄·상태 줄을 replacement 로 바꾼 blocks. 조치안 설명 문단은 그대로 둔다. 해당 줄이 없으면 undefined. */
export function replaceOpmRow(blocks: unknown[], handle: string, replacement: unknown[]): unknown[] | undefined {
  const mine = (b: unknown) => {
    const id = asRecord(b)?.["block_id"];
    return id === rowId(handle) || id === statusId(handle);
  };
  const at = blocks.findIndex(mine);
  if (at < 0) return undefined;
  const rest = blocks.filter((b) => !mine(b));
  return [...rest.slice(0, at), ...replacement, ...rest.slice(at)];
}

/** 누가 언제 눌렀는지 — 상태 줄 끝에 붙인다. 시각은 보는 사람의 시간대로 보인다. */
export function opmStamp(userId: string, now = new Date()): string {
  return `<@${userId}> · <!date^${Math.floor(now.getTime() / 1000)}^{time}|${now.toISOString().slice(11, 16)} UTC>`;
}

export interface OpmOutcome {
  /** 버튼 자리에 남길 상태. */
  status: string;
  /** 스레드에 남길 결과 문장. */
  text: string;
  /** 지금 상태가 앞으로 바뀔 수 있어(결재 대기 등) [상태 확인]을 둘지. */
  check: boolean;
}

const RESULT_MAX = 1500;

function resultBlock(result: unknown): string {
  const s = String(result ?? "").trim();
  if (!s) return "";
  return "\n```" + codeBody(s, RESULT_MAX) + "```";
}

/**
 * argus 가 돌려준 조치안 상태를 상태 줄과 결과 문장으로. 상태는 argus opmaction 의 Status* 값이다.
 * 실행 여부는 사용자의 클릭과 OPM 이 정한다 — 결재가 필요한 조치는 OPM 결재함에 올라가고, 결재가 끝나야 실행된다.
 */
export function describeOpmOutcome(op: OpmOp, body: Record<string, unknown>, fallbackTitle: string): OpmOutcome {
  const p = asRecord(body["proposal"]) ?? {};
  const title = `*${esc(p["title"] ?? fallbackTitle, 120)}*`;
  const where = p["oname"] ? esc(p["oname"], 100) : `pcode ${esc(p["pcode"], 20)}`;
  const approvalId = Number(p["approvalId"]);
  const approval = Number.isInteger(approvalId) && approvalId > 0 ? ` (결재 #${approvalId})` : "";
  const result = resultBlock(p["result"]);
  const status = esc(p["status"] ?? "", 40);
  let view: OpmOutcome;
  switch (status) {
    case "executed":
      view = { status: ":white_check_mark: 실행함", text: `:white_check_mark: ${title} — ${where}에서 실행했어요.${result}`, check: false };
      break;
    case "pending_approval":
      // argus 는 결재 번호가 있어야 OPM 결재함을 따라간다. 번호가 없으면 [상태 확인]은 늘 같은 답이다.
      view = approval
        ? {
            status: `:inbox_tray: 결재 대기${approval}`,
            text: op === "check"
              ? `:inbox_tray: ${title} — 아직 결재를 기다리고 있어요${approval}.`
              : `:inbox_tray: ${title} — 결재가 필요해 OPM 결재함에 올렸어요${approval}. 결재가 끝나면 [상태 확인]을 눌러 결과를 확인해 주세요.`,
            check: true,
          }
        : { status: ":inbox_tray: 결재 대기", text: `:inbox_tray: ${title} — 결재가 필요해 OPM 결재함에 올렸어요. 진행 상황은 OPM 결재함에서 확인해 주세요.`, check: false };
      break;
    case "approved":
      view = { status: `:ballot_box_with_check: 결재됨${approval}`, text: `:ballot_box_with_check: ${title} — 결재됐고 곧 실행돼요. 잠시 뒤 [상태 확인]을 눌러 주세요.`, check: true };
      break;
    case "running":
    case "executing":
      view = { status: `:hourglass_flowing_sand: 실행 중${approval}`, text: `:hourglass_flowing_sand: ${title} — ${where}에서 실행 중이에요. 잠시 뒤 [상태 확인]을 눌러 주세요.`, check: true };
      break;
    case "rejected":
      view = { status: `:no_entry_sign: 결재 반려됨${approval}`, text: `:no_entry_sign: ${title} — 결재가 반려돼 실행하지 않았어요.${result}`, check: false };
      break;
    case "failed":
      view = { status: ":x: 실행 실패", text: `:x: ${title} — ${where}에서 실행하지 못했어요.${result}`, check: false };
      break;
    case "unknown":
      // 다시 실행하게 두면 같은 조치가 두 번 나갈 수 있다 — argus 도 끝난 상태로 본다.
      view = {
        status: ":grey_question: 실행 여부 확인 필요",
        text: `:grey_question: ${title} — 실행됐는지 확인하지 못했어요. 두 번 실행되지 않게 버튼을 거뒀어요. OPM 실행 이력에서 확인해 주세요.${result}`,
        check: false,
      };
      break;
    case "expired":
      view = { status: ":hourglass: 만료됨", text: `:hourglass: ${title} — 확인 시간이 지나 실행하지 않았어요. 같은 내용을 다시 물어봐 주세요.`, check: false };
      break;
    case "cancelled":
      view = { status: ":wastebasket: 취소함", text: `:wastebasket: ${title} — 조치안을 취소했어요. 실행된 건 없어요.`, check: false };
      break;
    default:
      view = { status: `:information_source: 상태: ${status || "알 수 없음"}`, text: `:information_source: ${title} — 지금 상태: \`${status || "알 수 없음"}\``, check: false };
  }
  if (body["replayed"] === true) {
    view = { ...view, text: `:information_source: 이미 처리된 조치안이에요 — 다시 실행하지 않았어요.\n${view.text}` };
  }
  return view;
}

/**
 * [조치 실행]의 답을 받지 못했을 때(연결 끊김·시간 초과·front 의 5xx). argus 는 조치안마다 한 번만 실행하고
 * 다시 누르면 지금 상태를 돌려준다(replayed) — 그래서 버튼을 되돌리고 다시 눌러 확인하게 한다.
 */
export const OPM_NO_ANSWER =
  ":warning: 실행 결과를 받지 못했어요. 이미 실행됐을 수도 있어요 — [조치 실행]을 다시 누르면 두 번 실행하지 않고 지금 상태를 알려 줘요.";

export interface OpmErrorView {
  /** restore = 누르기 전 버튼으로 되돌린다(다시 누를 수 있다). retire = 상태 줄로 바꾼다(다시 눌러도 소용없다). */
  row: "restore" | "retire";
  /** retire 일 때 버튼 자리에 남길 상태. */
  status: string;
  /** 스레드에 남길 문장. */
  text: string;
  /** retire 자리에 [상태 확인]을 둘지(이미 실행 중과 겹친 경우). */
  check: boolean;
}

/**
 * argus /v1/opm/actions/* 의 오류 응답(argus#1066 handler.go 의 code 표)을 사용자가 할 수 있는 일로.
 * 실행하지 않은 것이 확실한 거절은 버튼을 되돌리고, 다시 눌러도 소용없는 것(만료·Job 변경 등)은 거둔다.
 */
export function describeOpmError(op: OpmOp, httpStatus: number, body: Record<string, unknown>, fallbackTitle: string): OpmErrorView {
  const code = String(body["code"] ?? "");
  const restore = (text: string): OpmErrorView => ({ row: "restore", status: "", text, check: false });
  const retire = (status: string, text: string): OpmErrorView => ({ row: "retire", status, text, check: false });
  const proposal = asRecord(body["proposal"]);
  switch (code) {
    case "token_not_found":
      // [상태 확인]에서 모른다면 보관 기간이 지난 것이다 — 결재 뒤 이미 실행됐을 수 있어 «실행 안 함» 이라 하지 않는다.
      if (op === "check") {
        return retire(":grey_question: 기록 없음", ":grey_question: 이 조치안의 기록이 argus 에 남아 있지 않아요(보관 기간이 지났을 수 있어요). 실행 여부는 OPM 실행 이력에서 확인해 주세요.");
      }
      return retire(":hourglass: 만료됨", ":hourglass: 확인 시간이 지나 실행하지 않았어요. 같은 내용을 다시 물어봐 주세요.");
    case "token_expired":
      return retire(":hourglass: 만료됨", ":hourglass: 확인 시간이 지나 실행하지 않았어요. 같은 내용을 다시 물어봐 주세요.");
    case "job_changed":
      return retire(":hourglass: 만료됨", ":hourglass: 확인한 뒤 OPM Job 정의가 바뀌어 실행하지 않았어요. 같은 내용을 다시 물어봐 주세요.");
    case "job_actions_disabled":
      return retire(":no_entry: 실행하지 않음", ":no_entry: 이 환경에서는 Job 등록·삭제·배포 조치가 꺼져 있어 실행하지 않았어요.");
    case "action_unverifiable":
      return retire(":no_entry: 실행하지 않음", ":no_entry: 실행 전에 대상을 확인할 수 없어 실행하지 않았어요. OPM 에서 직접 확인해 주세요.");
    case "action_conflict": {
      if (!proposal) return restore(":information_source: 이미 처리 중인 조치안이에요. 잠시 뒤 다시 눌러 주세요.");
      const now = describeOpmOutcome(op, { proposal }, fallbackTitle);
      return { row: "retire", status: now.status, text: `:information_source: 이미 실행 중이거나 처리된 조치안이에요.\n${now.text}`, check: now.check };
    }
    case "token_forbidden":
      return restore(":lock: 이 조치안은 다른 와탭 계정으로 받은 거예요. 그 계정으로 연결한 뒤 눌러 주세요.");
    case "project_forbidden":
      return restore(":lock: 지금 이 프로젝트에 접근할 수 없어 실행하지 않았어요. 프로젝트 권한을 확인해 주세요.");
    case "apply_disabled":
      return restore(":no_entry: 지금은 조치 실행이 꺼져 있어요. 관리자에게 문의해 주세요.");
    case "session_unavailable":
      return restore(":warning: OPM 에 전달할 로그인 세션을 만들지 못해 실행하지 않았어요. 잠시 뒤 다시 눌러 주세요.");
    case "verification_unavailable":
      return restore(":warning: 지금 권한을 확인하지 못해 실행하지 않았어요. 잠시 뒤 다시 눌러 주세요.");
  }
  if (httpStatus >= 500) {
    return restore(op === "apply" ? OPM_NO_ANSWER : `:warning: ${op === "cancel" ? "취소" : "상태 확인"}하지 못했어요 (HTTP ${httpStatus}). 잠시 뒤 다시 눌러 주세요.`);
  }
  return restore(`:x: 요청이 거절됐어요 (HTTP ${httpStatus}${code ? `, ${code}` : ""}).`);
}

/** OPM 조치는 실행에 1분 넘게 걸릴 수 있다(argus 실행 상한 90초 + 확인). 그보다 길게 기다린다. */
const OPM_CALL_TIMEOUT_MS = 150_000;

/** front 의 /argus 를 거쳐 argus /v1/opm/actions/{op} 를 부른다. 확인 토큰은 요청 본문으로만 보낸다(URL 은 접근 로그에 남는다). */
export function postOpmAction(fetchFn: typeof fetch, argusUrl: string, op: OpmOp, accessToken: string, confirmToken: string): Promise<Response> {
  return fetchFn(`${argusUrl}/v1/opm/actions/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ confirmToken }),
    signal: AbortSignal.timeout(OPM_CALL_TIMEOUT_MS),
  });
}
