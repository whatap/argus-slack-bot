// 알림 규칙 적용/취소 chip — 미리보기, 결과 문장, 버튼 상태, 실패 안내.
//
// argus 는 적용을 프로젝트별로 front 알림 규칙 API 에 보내고, 실패하면 항목마다 사유를
// 문자열로 돌려준다. 사유 문자열은 argus·front 가 정한 문구라 여기서 부분 일치로 가른다.

/** argus upstream.ErrBearerInsufficientScope — 사용자가 이 앱에 알림 설정 변경을 허락하지 않았다. */
const SCOPE_MISSING = "has not granted this app permission";
/** front OpenApiEventRuleController — 프로젝트의 경고 알림 설정 권한이 없다. */
const ROLE_MISSING = "no permission to change alert settings";
/** 쓰기 허락이 없을 때 다시 허락받을 링크와 함께 나에게만 보내는 안내. */
export const WRITE_CONSENT_LEAD =
  ":key: 알림 설정을 바꾸려면 와탭 로그인에서 *WhaTap 설정 변경* 을 허락해야 해요. 아래 링크에서 허락한 뒤 [적용]을 다시 눌러 주세요.";

/**
 * front 가 scope 가 모자란 토큰을 막은 응답(RFC 6750 3.1: 403 + insufficient_scope)이면 모자란 scope 를,
 * 아니면 null 을 돌려준다. scope 를 알리지 않았으면 빈 문자열이다.
 */
export function missingScope(status: number, wwwAuthenticate: string | null | undefined): string | null {
  if (status !== 403 || !wwwAuthenticate || !/error="insufficient_scope"/.test(wwwAuthenticate)) return null;
  return /scope="([^"]*)"/.exec(wwwAuthenticate)?.[1] ?? "";
}
/** argus upstream.errBearerSessionAPI — 사용자 토큰으로는 아직 못 하는 기능(복합 메트릭스 등). */
const SESSION_ONLY = "needs a browser session";
/**
 * front 가 yard 에 닿지 못했다(VPN 끊김·서비스 탐색 실패 등). 새 front 는 502 와 이 문구를 주고,
 * 예전 front 는 빈 200 을 줘서 argus 가 envelope 파싱에서 실패했다.
 */
const UPSTREAM_DOWN = ["no response from the WhaTap data server", "yard event envelope parse", "front bearer 502", "front bearer 503", "front bearer 504"];
/**
 * argus 가 front 의 답을 받지 못했다(프로젝트당 시간 상한 초과, 연결 실패·끊김). Go net/http 오류 문구다.
 * 쓰기 요청이 이미 나간 뒤일 수 있어 반영 여부를 알 수 없다.
 */
const UPSTREAM_NO_ANSWER = ["context deadline exceeded", "Client.Timeout exceeded", "connection refused", "connection reset", "i/o timeout", "no such host"];
/** 응답 도중 연결이 끊기면 Go 는 사유 끝에 EOF 만 남긴다. */
const UPSTREAM_CUT = /(^|: )(unexpected )?EOF$/;

/**
 * 분류하지 못한 사유는 그대로 보여 주되 주소는 뺀다. Go 의 HTTP 오류는 `Post "http://host/path": 사유` 꼴이라
 * 그대로 내면 내부 호스트 이름이 Slack 에 남는다.
 */
function withoutUrls(reason: string): string {
  return reason
    .replace(/\b(?:Get|Post|Put|Patch|Delete|Head) "https?:\/\/[^"]*": /g, "")
    .replace(/https?:\/\/[^\s"'`]+/g, "(주소 생략)")
    .trim();
}

const ACTION_VERB: Record<string, string> = { create: "생성", update: "수정", delete: "삭제" };

/** Slack mrkdwn 에서 &, <, > 는 엔티티로 바꿔야 링크·멘션으로 해석되지 않는다. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function esc(v: unknown, max = 200): string {
  const s = String(v ?? "");
  return escapeMrkdwn(s.length > max ? s.slice(0, max) + "…" : s);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function durationText(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "없음";
  const sec = Math.round(n / 1000);
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}시간`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}분`;
  return `${sec}초`;
}

const DIFF_LABELS: Record<string, string> = {
  title: "제목", message: "메시지", enabled: "켜짐 여부", conditions: "조건", silent: "무음",
  repeatCount: "반복 횟수", repeatDuration: "반복 기간", receiver: "수신자", timeTag: "시간대",
};

function diffValue(key: string, v: unknown): string {
  if (key === "enabled") return v ? "켜짐" : "꺼짐";
  if (key === "silent" || key === "repeatDuration") return durationText(v);
  if (Array.isArray(v)) return v.length === 0 ? "없음" : esc(v.map(String).join(", "));
  if (v === null || v === undefined || v === "") return "없음";
  return esc(v);
}

const PREVIEW_MAX_ITEMS = 15;
const PREVIEW_MAX_CHARS = 2800;

/**
 * 적용 버튼 위에 그릴 미리보기. argus 가 확인 토큰에 묶인 계획을 payload.preview 로 보낸다.
 * 답변 문장과 상관없이 무엇이 어떻게 바뀌는지 보여 준다 — 모델이 지어낸 규칙도 여기서 드러난다.
 * preview 가 없으면(구버전 argus) undefined.
 */
export function renderRulePreview(payload: Record<string, unknown> | undefined): string | undefined {
  const preview = asRecord(payload?.["preview"]);
  if (!preview) return undefined;
  const verb = ACTION_VERB[String(preview["action"] ?? payload?.["action"] ?? "")] ?? "변경";
  const lines: string[] = [`*:mag: [적용]을 누르면 — 알림 규칙 ${verb}*`];

  const rule = asRecord(preview["rule"]);
  if (rule) {
    lines.push(`• 규칙: *${esc(rule["title"])}* (\`${esc(rule["category"])}\`)`);
    const conds = Array.isArray(rule["conditions"]) ? rule["conditions"] : [];
    const condText = conds
      .map((c) => {
        const r = asRecord(c) ?? {};
        return `${esc(r["level"])} \`${esc(r["rule"])}\`${r["enabled"] === false ? " (이 조건은 꺼짐)" : ""}`;
      })
      .join(", ");
    if (condText) lines.push(`• 조건: ${condText}`);
    if (rule["selectString"]) lines.push(`• 대상 필터: \`${esc(rule["selectString"])}\``);
    const state = [rule["enabled"] === false ? "*꺼짐* (만들어져도 알림이 울리지 않아요)" : "켜짐"];
    if (rule["stateful"]) state.push("상태 유지");
    state.push(`무음 ${durationText(rule["silentMs"])}`);
    lines.push(`• 상태: ${state.join(" · ")}`);
    if (rule["message"]) lines.push(`• 메시지: ${esc(rule["message"])}`);
  }

  const items = Array.isArray(preview["items"]) ? preview["items"] : [];
  for (const raw of items.slice(0, PREVIEW_MAX_ITEMS)) {
    const it = asRecord(raw) ?? {};
    const where = `pcode ${esc(it["pcode"])}`;
    const matched = asRecord(it["matchedRule"]);
    const title = matched ? `*${esc(matched["title"])}* ` : "";
    switch (it["action"]) {
      case "create": {
        const dups = Array.isArray(it["duplicateCandidates"]) ? it["duplicateCandidates"].length : 0;
        lines.push(`• ${where}: 새로 생성${dups > 0 ? ` · :warning: 같은 대상을 보는 규칙 ${dups}개 있음` : ""}`);
        break;
      }
      case "update": {
        lines.push(`• ${where}: ${title}수정`);
        const diff = asRecord(it["diff"]) ?? {};
        for (const [key, change] of Object.entries(diff)) {
          const c = asRecord(change) ?? {};
          lines.push(`    – ${DIFF_LABELS[key] ?? esc(key)}: ${diffValue(key, c["before"])} → ${diffValue(key, c["after"])}`);
        }
        break;
      }
      case "delete":
        lines.push(`• ${where}: ${title}삭제`);
        break;
      case "skip":
        lines.push(`• ${where}: 건너뜀 — ${esc(withoutUrls(String(it["reason"] ?? "")))}`);
        break;
      case "ambiguous": {
        const cands = Array.isArray(it["candidates"]) ? it["candidates"] : [];
        const names = cands.slice(0, 3).map((c) => esc(asRecord(c)?.["title"])).join(", ");
        lines.push(`• ${where}: 해당하는 규칙이 ${cands.length}개라 건너뜀 (${names})`);
        break;
      }
      default:
        lines.push(`• ${where}: 실패 — ${esc(withoutUrls(String(it["reason"] ?? "")))}`);
    }
  }
  const hidden = Math.max(0, items.length - PREVIEW_MAX_ITEMS) + (Number(preview["truncated"]) || 0);
  if (hidden > 0) lines.push(`• … 외 ${hidden}개 프로젝트`);

  const sim = asRecord(preview["simulation"]);
  const perHour = sim?.["estimatedTotalPerHour"];
  if (typeof perHour === "number" && Number.isFinite(perHour)) {
    lines.push(`• 예상 알림: 시간당 약 ${perHour.toFixed(1)}건 (최근 데이터 샘플 기준)`);
  }
  const warnings = Array.isArray(preview["warnings"]) ? preview["warnings"] : [];
  for (const w of warnings.slice(0, 3)) lines.push(`:warning: ${esc(w)}`);

  let text = "";
  for (const line of lines) {
    if (text.length + line.length + 1 > PREVIEW_MAX_CHARS) {
      text += "\n• …";
      break;
    }
    text += (text ? "\n" : "") + line;
  }
  return text;
}

/**
 * 누른 버튼 줄(같은 확인 토큰)을 상태 문장으로 바꾼 blocks. 다시 누를 수 없게 하고, 무엇을
 * 했는지 메시지에 남긴다. 미리보기 문단은 그대로 둔다. 해당 버튼 줄이 없으면 undefined.
 */
export function resolveChipBlocks(blocks: unknown[], token: string, status: string): unknown[] | undefined {
  let found = false;
  const out = blocks.map((b) => {
    const block = asRecord(b);
    const elements = block?.["elements"];
    if (block?.["type"] !== "actions" || !Array.isArray(elements)) return b;
    const mine = elements.some((e) => String(asRecord(e)?.["action_id"] ?? "").endsWith(`_event_rule:${token}`));
    if (!mine) return b;
    found = true;
    return { type: "context", elements: [{ type: "mrkdwn", text: status }] };
  });
  return found ? out : undefined;
}

/** 결과에 맞는 버튼 자리 상태 문장. */
export function chipStatus(op: "apply" | "cancel", body: Record<string, unknown>): string {
  if (op === "cancel") return ":wastebasket: 취소함";
  const ok = Array.isArray(body["succeeded"]) ? body["succeeded"].length : 0;
  const bad = Array.isArray(body["failed"]) ? body["failed"].length : 0;
  if (ok > 0 && bad > 0) return ":warning: 일부만 적용됨";
  if (bad > 0) return ":x: 적용 실패";
  if (ok > 0) return ":white_check_mark: 적용함";
  return ":information_source: 바뀐 것 없음";
}

export interface ApplyFailureView {
  /** 결과 메시지에 덧붙일 문장. 없으면 빈 문자열. */
  text: string;
  /** 다시 로그인해 동의받으면 풀리는 실패인가. 그러면 로그인 링크를 같이 보낸다. */
  needsConsent: boolean;
}

/**
 * 적용/취소 결과 문장 — 무엇이(label) 어느 프로젝트에 어떻게 됐는지.
 * 실패가 있으면 사유를 사용자가 할 수 있는 일로 바꿔 덧붙인다(describeApplyFailures).
 */
export function describeApplyResult(op: "apply" | "cancel", body: Record<string, unknown>, label: string): ApplyFailureView {
  const name = label ? `*${esc(label)}* ` : "";
  if (op === "cancel") return { text: `:wastebasket: ${name}적용을 취소했어요. 바뀐 건 없어요.`, needsConsent: false };
  const verb = ACTION_VERB[String(body["action"] ?? "")] ?? "적용";
  const succeeded = Array.isArray(body["succeeded"]) ? body["succeeded"] : [];
  const failed = Array.isArray(body["failed"]) ? body["failed"] : [];
  const pcodes = succeeded.map((s) => asRecord(s)?.["pcode"]).filter((p) => p !== undefined && p !== null).map(String);
  const elapsed = Number(body["elapsedMs"]) || 0;
  const took = elapsed > 0 ? ` (${(elapsed / 1000).toFixed(1)}초)` : "";
  const lines: string[] = [];
  if (succeeded.length > 0) {
    const where = pcodes.length === 1
      ? `pcode ${pcodes[0]}`
      : `프로젝트 ${succeeded.length}개(${pcodes.slice(0, 10).join(", ")}${pcodes.length > 10 ? " …" : ""})`;
    lines.push(`:white_check_mark: ${name}— ${where}에 ${verb}했어요${took}`);
  } else if (failed.length === 0) {
    lines.push(`:information_source: ${name}— ${verb}할 대상이 없었어요. 바뀐 건 없어요.`);
  }
  let needsConsent = false;
  if (failed.length > 0) {
    lines.push(`:x: 프로젝트 ${failed.length}개는 ${verb}하지 못했어요.`);
    const why = describeApplyFailures(failed);
    if (why.text) lines.push(why.text);
    needsConsent = why.needsConsent;
  }
  return { text: lines.join("\n"), needsConsent };
}

export function describeApplyFailures(failed: unknown[]): ApplyFailureView {
  const reasons = failed
    .map((f) => String((f as { reason?: unknown } | null)?.reason ?? ""))
    .filter(Boolean);
  if (reasons.length === 0) return { text: "", needsConsent: false };
  if (reasons.some((r) => r.includes(SCOPE_MISSING))) {
    return {
      text: ":key: 와탭 로그인에서 *WhaTap 설정 변경* 을 아직 허락하지 않아 적용하지 못했어요. 나에게만 보이는 링크로 다시 로그인해 허락한 뒤 다시 시도해 주세요.",
      needsConsent: true,
    };
  }
  if (reasons.some((r) => r.includes(ROLE_MISSING))) {
    return {
      text: ":lock: 이 프로젝트의 경고 알림 설정 권한이 없어 적용하지 못했어요. 프로젝트 관리자에게 권한을 요청해 주세요.",
      needsConsent: false,
    };
  }
  if (reasons.some((r) => r.includes(SESSION_ONLY))) {
    return {
      text: ":information_source: 이 종류의 알림(복합 메트릭스 등)은 아직 와탭 로그인으로 바꿀 수 없어요. 와탭 화면에서 설정해 주세요.",
      needsConsent: false,
    };
  }
  if (reasons.some((r) => UPSTREAM_DOWN.some((p) => r.includes(p)))) {
    return {
      text: ":warning: 와탭 데이터 서버에 연결하지 못해 처리하지 못했어요. 반영됐는지 확실하지 않으니 규칙 목록을 확인한 뒤 다시 시도해 주세요.",
      needsConsent: false,
    };
  }
  if (reasons.some((r) => UPSTREAM_NO_ANSWER.some((p) => r.includes(p)) || UPSTREAM_CUT.test(r))) {
    return {
      text: ":warning: 와탭 서버가 제때 응답하지 않아 결과를 확인하지 못했어요. 반영됐는지 확실하지 않으니 규칙 목록을 확인한 뒤 다시 시도해 주세요.",
      needsConsent: false,
    };
  }
  const first = withoutUrls(reasons[0]);
  return { text: `실패 사유: \`${first.length > 200 ? first.slice(0, 200) + "…" : first}\``, needsConsent: false };
}

/** argus /v1/event-rules/* 의 오류 code 를 안내 문장으로. 모르는 code 면 빈 문자열(호출자가 원문을 보인다). */
export function describeEventRuleOpError(code: unknown): string {
  switch (code) {
    case "token_not_found":
      return ":hourglass: 적용 확인 시간이 지났어요. 같은 내용을 다시 물어봐 주세요.";
    case "token_forbidden":
      return ":lock: 다른 사람의 질문에서 나온 버튼이에요. 본인 질문의 버튼만 누를 수 있어요.";
    case "apply_in_progress":
      return ":hourglass_flowing_sand: 이미 적용 중이에요. 잠시 뒤 결과를 확인해 주세요.";
    case "apply_disabled":
      return ":no_entry: 지금은 알림 규칙 적용이 꺼져 있어요.";
    default:
      return "";
  }
}
