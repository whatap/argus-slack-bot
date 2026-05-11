// src/claude-loop.ts
//
// Anthropic Messages API 의 manual tool_use 루프.
// MCP 도구를 Anthropic tool 스키마로 변환 → tool_use 응답 받으면 MCP 로 dispatch
// → tool_result 메시지로 다시 Anthropic 에 전달 → final text 까지 반복.
//
// 참고: argus 자체가 내부 FC loop 를 돌리므로 bot 의 외곽 루프는 보통 1~3 hop
// 이면 충분 (ask_whatap_expert 1 회 → final text). MAX_TOOL_HOPS 는 사고 가드.

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages.mjs";

import {
  askWhatapExpertDirect,
  type ArgusDirectConfig,
} from "./argus-direct.js";
import type { WhatapMcpClient } from "./mcp-client.js";

export interface ClaudeLoopConfig {
  anthropic: Anthropic;
  mcpClient: WhatapMcpClient;
  model: string;
  maxTokens: number;
  /** 도구 호출 hop 한계. 초과시 강제 종료. 기본 8. */
  maxHops?: number;
  /** Anthropic 한테 전달할 system prompt. bot 페르소나 + Slack mrkdwn 가이드. */
  system: string;
  /**
   * 스트리밍 진행 콜백. 누적된 모든 텍스트와 도구 상태를 받음.
   * 호출자가 throttle 해서 Slack chat.update 호출.
   */
  onProgress?: (snapshot: {
    text: string; // 누적 텍스트 (모든 hop 의 text 블록 join)
    toolInProgress?: {
      name: string;
      input?: unknown;
      /** ask_whatap_expert 안에서 argus 가 호출 중인 sub-tool 이름. */
      subTool?: string;
    };
    /** 이번 turn 에서 이미 끝난 도구 호출들. 누적. */
    toolCallLog: ToolCallEntry[];
    hops: number;
  }) => void;
  /**
   * argus 직접 호출 설정. ask_whatap_expert tool 을 MCP 우회해서 봇이 직접
   * argus /v1/agent SSE 받음 — sub-tool 호출을 onProgress 로 흘림.
   * 미설정이면 MCP 의 ask_whatap_expert 그대로 사용 (backwards compat).
   */
  argusDirect?: ArgusDirectConfig;
}

export interface ToolCallEntry {
  name: string;
  /** 호출 시작 → 결과 받기까지 ms. */
  durationMs: number;
  /** 에러로 끝났는지. */
  isError?: boolean;
}

export interface RunResult {
  /** 최종 assistant 텍스트. tool 호출 hop 만 있고 final text 없으면 빈 string. */
  text: string;
  /** 이번 turn 에서 추가된 메시지들 — 호출자가 thread history 에 append. */
  newMessages: MessageParam[];
  /** 사용된 hop 수 (디버그용 로깅). */
  hops: number;
  /** 이번 turn 의 도구 호출 기록 — 답변 끝에 footer 로 표시. */
  toolCallLog: ToolCallEntry[];
  /**
   * 도구 응답에서 추출된 chip actions (event-rule / dashboard / flex-event).
   * 호출자(index.ts)가 Slack Block Kit button 으로 변환해서 같이 보냄.
   * 클릭 시 argus 의 /v1/event-rules/apply 또는 /cancel 호출.
   */
  chipActions: ChipAction[];
}

export interface ChipAction {
  /** "applyEventRules" | "cancelEventRules" | "applyDashboard" 등. */
  type: string;
  /** chip 라벨 (예: "[GPU 전력 사용량] 1개 프로젝트에 적용"). */
  label: string;
  /** 도구 응답의 payload 그대로. confirmToken / pcodeCount / summary 등 포함. */
  payload: Record<string, unknown>;
}

export async function runClaudeWithMcp(
  cfg: ClaudeLoopConfig,
  userText: string,
  history: MessageParam[],
): Promise<RunResult> {
  const tools = cfg.mcpClient.toolsForAnthropic();
  const maxHops = cfg.maxHops ?? 8;
  console.log(
    `[claude-loop/debug] tools sent to anthropic: count=${tools.length} names=[${tools.map((t) => t.name).join(",")}]`,
  );

  // 누적될 새 메시지들 — 사용자 메시지부터 시작.
  const newMessages: MessageParam[] = [
    { role: "user", content: userText },
  ];

  // hop 간에 누적되는 보여지는 텍스트 (마지막 hop 의 final text 만 보내는 게
  // 아니라, 도구 호출 사이에 모델이 말한 모든 텍스트도 같이 합쳐 사용자에게).
  let cumulativeText = "";
  let hops = 0;
  let finalText = "";
  const toolCallLog: ToolCallEntry[] = [];
  const chipActions: ChipAction[] = [];

  const emit = (toolInProgress?: {
    name: string;
    input?: unknown;
    subTool?: string;
  }) => {
    cfg.onProgress?.({ text: cumulativeText, toolInProgress, toolCallLog, hops });
  };

  for (hops = 0; hops < maxHops; hops++) {
    // 이번 hop 시작 — 누적 텍스트에 segment 구분자 (앞 hop 결과 + tool result 섞임 방지)
    const hopStartLen = cumulativeText.length;

    const stream = cfg.anthropic.messages.stream({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system: cfg.system,
      tools,
      messages: [...history, ...newMessages],
    });

    // text delta 마다 누적 + onProgress
    stream.on("text", (textDelta: string) => {
      cumulativeText += textDelta;
      emit();
    });

    // 최종 메시지 받기 (블록 단위 정리됨)
    const response = await stream.finalMessage();

    // hop 끝나도 누적 텍스트 길이가 늘지 않았으면 (도구만 호출하고 텍스트 0) skip
    void hopStartLen;

    // assistant 응답 자체를 history 에 추가 (tool_use 가 있어도 그대로).
    newMessages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      // 최종 텍스트는 누적된 것으로 (스트리밍 한 그대로).
      finalText = cumulativeText;
      emit();
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolUses = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );
      const toolResults: ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        // 사용자에게 어떤 도구 호출 중인지 알림
        emit({ name: tu.name, input: tu.input });
        const toolStart = Date.now();
        try {
          let result: string;
          if (tu.name === "ask_whatap_expert" && cfg.argusDirect) {
            // ask_whatap_expert 만 MCP 우회 — argus SSE 를 봇이 직접 받아
            // sub-tool 호출 (whatap_query_data, render_table 등) 을
            // 사용자에게 실시간 노출.
            const params = tu.input as {
              query: string;
              pcode?: number;
              conversationId?: string;
            };
            const r = await askWhatapExpertDirect(
              cfg.argusDirect,
              params,
              (progress) => {
                if (progress.subTool) {
                  emit({
                    name: tu.name,
                    input: tu.input,
                    subTool: progress.subTool,
                  });
                }
              },
            );
            const lines: string[] = [r.text || "(argus 응답 없음)"];
            if (r.recommendedQuestions && r.recommendedQuestions.length > 0) {
              lines.push("", "**Suggested follow-ups:**");
              for (const q of r.recommendedQuestions) {
                lines.push(`- ${q}`);
              }
            }
            if (r.conversationId) {
              lines.push(
                "",
                `_conversationId: \`${r.conversationId}\`_`,
              );
            }
            result = lines.join("\n");
            // argus 의 message_stop.actions (chip) 그대로 chipActions 에 누적.
            // 봇이 Slack Block Kit button 으로 변환해서 같이 전송.
            if (r.actions && r.actions.length > 0) {
              for (const a of r.actions) {
                chipActions.push(a);
              }
            }
          } else {
            result = await cfg.mcpClient.callTool(tu.name, tu.input);
          }
          toolCallLog.push({
            name: tu.name,
            durationMs: Date.now() - toolStart,
          });
          // 도구 응답에서 chip actions 추출 — Slack Block Kit button 으로 변환할 것.
          // event-rule / flex-event / dashboard 도구의 응답에 actions 배열 동봉.
          extractChipActions(result, chipActions);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: result,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolCallLog.push({
            name: tu.name,
            durationMs: Date.now() - toolStart,
            isError: true,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Tool error: ${msg}`,
            is_error: true,
          });
        }
      }
      // 도구 호출 끝나면 indicator 비우고 다음 hop 으로
      emit();
      newMessages.push({ role: "user", content: toolResults });
      continue;
    }

    // 그 외 stop_reason — 텍스트만 누적된 거 사용
    finalText = cumulativeText;
    emit();
    break;
  }

  if (!finalText && hops >= maxHops) {
    finalText = `(도구 호출 ${maxHops} hop 초과 — 응답 미완성)`;
  }

  return { text: finalText, newMessages, hops, toolCallLog, chipActions };
}

function extractText(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

// extractChipActions — argus 도구 응답 (string) 에서 actions 배열을 찾아 누적.
//
// argus 의 event-rule / flex-event / dashboard 도구가 응답 안에
// `"actions": [{"type":"applyEventRules","label":"...","payload":{"confirmToken":"..."}}]`
// 형태로 chip 발급. ask_whatap_expert (argus direct) 는 applyDirect 가 아니라 별도
// SSE 흐름으로 들어오므로 여기는 직접 도구 호출 응답만 다룸.
//
// result 가 JSON object/array 면 parse 해서 최상위 actions 추출. parse 실패하면
// silently skip — 도구 응답이 plain text 인 경우 정상.
function extractChipActions(result: string, sink: ChipAction[]): void {
  if (!result || result.length < 10) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  // result 자체가 array (여러 도구 출력 묶음) 면 각 element 검사.
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const acts = (c as { actions?: unknown }).actions;
    if (!Array.isArray(acts)) continue;
    for (const a of acts) {
      if (!a || typeof a !== "object") continue;
      const obj = a as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "";
      const label = typeof obj.label === "string" ? obj.label : "";
      const payload =
        obj.payload && typeof obj.payload === "object"
          ? (obj.payload as Record<string, unknown>)
          : {};
      if (!type || !label) continue;
      sink.push({ type, label, payload });
    }
  }
}

// 작은 헬퍼 — 다른 모듈에서 직접 안 씀, ESLint silence.
export const __unused: TextBlockParam | null = null;
