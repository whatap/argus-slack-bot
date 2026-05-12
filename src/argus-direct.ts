// src/argus-direct.ts
//
// argus /v1/chat 직접 호출 — MCP 의 ask_whatap_expert 핸들러를 우회.
// 우회하는 이유는 MCP 가 SSE 를 통째로 누적해서 결과만 주는 반면, 우리는
// argus 안에서의 sub-tool 호출 (whatap_query_data, render_table 등) 을
// 실시간으로 사용자에게 표시하고 싶기 때문.
//
// SSE 포맷은 Anthropic Messages 호환:
//   event: conversation_start | message_start | content_block_start
//        | content_block_delta | content_block_stop | message_stop | error
//
// onProgress:
//   - subTool: argus LLM 이 호출한 sub-tool 이름 (content_block_start type=tool_use)
//   - text: 누적된 답변 텍스트 (content_block_delta type=text_delta)

export interface ArgusDirectConfig {
  /** argus base URL (no trailing slash). 예: http://localhost:8090 */
  url: string;
  /** ARGUS_API_TOKENS 중 하나. X-Argus-Token 헤더. */
  apiToken: string;
  /** dev.whatap.io 의 JSESSIONID — argus 가 cookie pass-through 모드 활성. */
  cookie?: string;
}

export interface ArgusProgress {
  /** argus LLM 이 호출 시작한 sub-tool 이름. */
  subTool?: string;
  /** 누적된 argus 답변 텍스트 (text_delta 만, reasoning 제외). */
  text?: string;
}

export interface AskWhatapExpertResult {
  text: string;
  conversationId?: string;
  recommendedQuestions?: string[];
  /**
   * argus 의 message_stop SSE event 에 동봉된 chip actions (event-rule /
   * dashboard / flex-event 적용·취소). 봇이 Slack Block Kit button 으로 변환.
   * argus 의 frontendActions 가 그대로 흘러 옴.
   */
  actions?: Array<{ type: string; label: string; payload: Record<string, unknown> }>;
}

const REQUEST_TIMEOUT_MS = 120_000;

export async function askWhatapExpertDirect(
  cfg: ArgusDirectConfig,
  params: {
    query: string;
    pcode?: number;
    conversationId?: string;
    /** 가짜 currentUrl — argus 의 screens.Lookup() 이 이 URL 로 화면 매칭 →
     *  cpm.yaml 등의 domain_knowledge / analysis_guides / data_registry 가
     *  system prompt 에 inject. whatap-front 패널이 자연스레 박는 효과를 봇이
     *  사용자 메시지 텍스트 추론 (`screen-infer.ts`) 으로 흉내. */
    currentUrl?: string;
  },
  onProgress: (p: ArgusProgress) => void,
): Promise<AskWhatapExpertResult> {
  // /v1/chat (브라우저용, cookie 인증) 사용 — /v1/agent 의 X-Argus-Token
  // 인증 layer 가 front.apm/nginx/ALB 어딘가에서 자체 검증되어 우회 어려움.
  // 봇이 사용자 cookie 를 가지고 있으니 /v1/chat 으로 호출하면 토큰 무관.
  // body field 는 ChatRequest 형식: query → message.
  // context.client="slack" — argus 가 출력 채널이 텍스트 전용임을 인지해서
  // 차트·대시보드 도구 회피 + 후속 질문에서 시각화 항목 제외.
  const body: Record<string, unknown> = { message: params.query };
  if (typeof params.pcode === "number") body.pcode = params.pcode;
  if (params.conversationId) body.conversationId = params.conversationId;
  const context: Record<string, unknown> = { client: "slack" };
  if (params.currentUrl) context.currentUrl = params.currentUrl;
  body.context = context;
  // /v1/chat 은 Cookie 헤더에서 직접 읽음 — body.cookie 안 씀.

  // 디버그: query 와 routing 추적.
  console.log(
    `[argus-direct/debug] endpoint=/v1/chat query="${params.query.slice(0, 200)}" pcode=${params.pcode} conv=${params.conversationId || "-"} url=${params.currentUrl || "-"} cookie_set=${!!cfg.cookie}`,
  );

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${cfg.url}/v1/chat`, {
      method: "POST",
      headers: {
        ...(cfg.cookie ? { Cookie: cfg.cookie } : {}),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const errText = await res.text().catch(() => "");
    throw new Error(
      `argus /v1/chat error (${res.status}): ${errText || res.statusText}`,
    );
  }
  if (!res.body) {
    clearTimeout(timer);
    throw new Error("argus /v1/chat returned no body");
  }

  try {
    return await consumeSSE(res.body, onProgress);
  } finally {
    clearTimeout(timer);
  }
}

async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onProgress: (p: ArgusProgress) => void,
): Promise<AskWhatapExpertResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let text = "";
  let conversationId: string | undefined;
  let recommendedQuestions: string[] | undefined;
  const actions: Array<{ type: string; label: string; payload: Record<string, unknown> }> = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseSSEBlock(block);
      if (!evt) continue;

      if (evt.event === "error") {
        const code = evt.data?.code ?? "ARGUS_ERROR";
        const msg = evt.data?.message ?? JSON.stringify(evt.data);
        throw new Error(`argus error [${code}]: ${msg}`);
      }
      if (evt.event === "content_block_start") {
        const cb = evt.data?.content_block;
        if (cb?.type === "tool_use" && typeof cb.name === "string") {
          onProgress({ subTool: cb.name });
        }
      } else if (evt.event === "content_block_delta") {
        const d = evt.data?.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          text += d.text;
          onProgress({ text });
        }
      } else if (evt.event === "message_stop") {
        if (typeof evt.data?.conversationId === "string") {
          conversationId = evt.data.conversationId;
        }
        if (Array.isArray(evt.data?.recommendedQuestions)) {
          recommendedQuestions = evt.data.recommendedQuestions.filter(
            (q: unknown): q is string => typeof q === "string",
          );
        }
        // chip actions — argus 의 frontendActions 가 message_stop.actions 로 옴.
        if (Array.isArray(evt.data?.actions)) {
          for (const a of evt.data.actions) {
            if (!a || typeof a !== "object") continue;
            const type = typeof a.type === "string" ? a.type : "";
            const label = typeof a.label === "string" ? a.label : "";
            const payload =
              a.payload && typeof a.payload === "object"
                ? (a.payload as Record<string, unknown>)
                : {};
            if (!type || !label) continue;
            actions.push({ type, label, payload });
          }
        }
      } else if (evt.event === "conversation_start") {
        if (typeof evt.data?.conversationId === "string") {
          conversationId = evt.data.conversationId;
        }
      }
    }
  }

  return {
    text: sanitizeSlackText(text.trim()),
    ...(conversationId ? { conversationId } : {}),
    ...(recommendedQuestions ? { recommendedQuestions } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

// argus LLM 이 가끔 HTML 태그 (<strong>, <em>, <br>) 나 GitHub-style `**bold**`
// 을 박을 때 Slack 은 literal 로 표시해 사용자에게 raw <strong>X</strong> 가
// 그대로 보임 — argus system prompt (Slack mrkdwn) 가이드를 LLM 이 무시하는
// 케이스에 대비한 안전망. 알려진 HTML 화이트리스트만 변환하고 그 외
// `<https://...|label>` 같은 Slack 자체 마크업은 건드리지 않는다.
function sanitizeSlackText(s: string): string {
  return (
    s
      // 두 별표 → 한 별표 (Slack 은 ** 를 literal 처리)
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      // HTML inline → Slack mrkdwn
      .replace(/<strong>(.*?)<\/strong>/gis, "*$1*")
      .replace(/<b>(.*?)<\/b>/gis, "*$1*")
      .replace(/<em>(.*?)<\/em>/gis, "_$1_")
      .replace(/<i>(.*?)<\/i>/gis, "_$1_")
      .replace(/<code>(.*?)<\/code>/gis, "`$1`")
      // HTML link → Slack 링크 syntax
      .replace(/<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/gis, "<$1|$2>")
      // 블록 / 컨테이너 태그 strip — 텍스트는 보존, 태그만 제거
      .replace(/<\/?(br|p|div|span|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6])\s*\/?>/gi, "")
  );
}

interface SSEEvent {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export function parseSSEBlock(block: string): SSEEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

/** argus 의 sub-tool 이름을 한국어 친화 표현으로 매핑.
 *  argus 측에 새 도구 추가/삭제 시 SUB_TOOL_DESC 도 같이 갱신 필요. 자동 sync
 *  메커니즘은 없고 runtime drift 감지로만 (아래 WARN). 안정화되면 argus 측
 *  `/v1/tools/metadata` 엔드포인트 노출 후 봇이 부팅 시 fetch 가 정석. */
const SUB_TOOL_DESC: Record<string, string> = {
  whatap_query_data: "데이터 쿼리",
  whatap_create_promql: "PromQL 생성",
  whatap_list_projects: "프로젝트 목록",
  whatap_project_info: "프로젝트 정보",
  whatap_list_agents: "에이전트 목록",
  whatap_recent_alerts: "알림 조회",
  whatap_organization_alerts: "조직 알림",
  whatap_apm_anomaly: "APM 이상 탐지",
  whatap_service_topology: "서비스 토폴로지",
  whatap_data_availability: "데이터 가용성 확인",
  whatap_describe_query: "쿼리 분석",
  whatap_install_agent: "에이전트 설치",
  whatap_list_fields: "필드 목록",
  whatap_list_dashboards: "대시보드 목록",
  render_chart: "차트 생성",
  check_project_metrics: "프로젝트 메트릭 확인",
  docs_search: "문서 검색",
};

/** 이미 WARN 출력한 unknown 이름. 한 이름은 한 번만 로그 — 운영 로그 노이즈
 *  방지. 봇 재시작 시 reset. */
const unknownSubToolWarned = new Set<string>();

export function describeArgusSubTool(name: string): string {
  const desc = SUB_TOOL_DESC[name];
  if (desc) return desc;
  // Runtime drift detector — argus 가 새 sub-tool 추가했는데 봇 매핑이 안
  // 따라잡은 경우 운영자에게 알림. 자동 PR 같은 형태는 아니지만 정기 로그
  // 점검 시 누락 발견 가능. 사용자에겐 영향 X (raw name fallback).
  if (!unknownSubToolWarned.has(name)) {
    unknownSubToolWarned.add(name);
    console.warn(
      `[argus-direct] unknown sub-tool: "${name}" — SUB_TOOL_DESC 매핑 추가 필요. 일단 raw name 사용.`,
    );
  }
  return name;
}

/** 테스트용 — warned set 초기화. */
export function __resetSubToolWarnings(): void {
  unknownSubToolWarned.clear();
}
