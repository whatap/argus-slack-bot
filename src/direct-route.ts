// src/direct-route.ts
//
// 봇 외곽 Claude tool_use loop 우회 — 사용자 메시지를 곧장 argus /v1/chat 으로
// forward. 외곽 LLM 1-2 hop (5-10초) 제거 → whatap-front 의 WhaTap AI 패널과
// 같은 진입 흐름.
//
// 배경:
//   - 봇 외곽 LLM 의 원래 역할 = (1) 도구 선택, (2) argus 응답 final 합성
//   - 그러나 P0/P1 작업으로:
//     · mcp-client 화이트리스트가 ask_whatap_expert 1개만 노출 → 도구 선택 X
//     · system prompt 가 default 강제 + query forward 정책 → reword X
//     → 외곽 LLM 이 사실상 "메시지 → ask_whatap_expert(query=같은 메시지) → echo" 만 함
//
// 흐름:
//   handle() → resolveUserCreds → 이 모듈 → argus /v1/chat SSE
//   직접 소비 → step list + text 누적 → onProgress 콜백 → Slack placeholder update
//   응답 끝 → RunResult 형식 반환 → handle() 의 기존 후처리 (chip, recommendedQuestions, 등) 재사용

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.mjs";

import {
  askWhatapExpertDirect,
  type ArgusDirectConfig,
} from "./argus-direct.js";
import type { ChipAction, RunResult } from "./claude-loop.js";

export interface StepProgress {
  /** argus sub-tool 이름 (예: whatap_query_data, render_chart). */
  name: string;
  /** Date.now() 기준 시작 시각. */
  startedAt: number;
  /** 완료 시각. undefined 면 진행 중. */
  doneAt?: number;
}

export interface DirectRouteSnap {
  /** 누적 step list (순서 보존). */
  steps: StepProgress[];
  /** 누적 답변 텍스트 (argus 의 text_delta). */
  text: string;
  /** false = 응답 완료. */
  inProgress: boolean;
}

export interface DirectRouteConfig {
  argusDirect: ArgusDirectConfig;
  /** 이전 turn 의 argus conversationId. 같은 thread follow-up 자동 이어받음. */
  argusConversationId?: string;
  /** placeholder 메시지 progressive update 콜백. throttle 은 호출자 책임. */
  onProgress?: (snap: DirectRouteSnap) => void;
}

/**
 * argus /v1/chat 직접 호출 — 외곽 Claude tool_use loop 우회.
 * 반환 형식은 runClaudeWithMcp 의 RunResult 와 호환 → 호출자의 chip /
 * recommendedQuestions / history persistence 로직 그대로 재사용.
 *
 * 외곽 LLM 0 hop 이므로 RunResult.hops 는 -1 로 표기 (legacy hops 0 = "외곽 LLM
 * 도구 없이 답변" 케이스와 구분).
 */
export async function runDirectToArgus(
  cfg: DirectRouteConfig,
  userText: string,
  pcode?: number,
  /** 가짜 currentUrl — `screen-infer.inferCurrentUrl()` 결과 전달. */
  currentUrl?: string,
): Promise<RunResult> {
  const steps: StepProgress[] = [];
  let cumulativeText = "";

  const emit = (inProgress: boolean) => {
    cfg.onProgress?.({ steps: [...steps], text: cumulativeText, inProgress });
  };

  const r = await askWhatapExpertDirect(
    cfg.argusDirect,
    {
      query: userText,
      ...(typeof pcode === "number" && pcode > 0 ? { pcode } : {}),
      ...(cfg.argusConversationId
        ? { conversationId: cfg.argusConversationId }
        : {}),
      ...(currentUrl ? { currentUrl } : {}),
    },
    (progress) => {
      if (progress.subTool) {
        // 이전 step 완료로 마킹 (argus SSE 는 명시적 stop 이벤트 없이 다음 tool_use
        // start 가 이전 도구의 종료를 의미).
        const prev = steps[steps.length - 1];
        if (prev && !prev.doneAt) prev.doneAt = Date.now();
        steps.push({ name: progress.subTool, startedAt: Date.now() });
        emit(true);
      } else if (typeof progress.text === "string") {
        cumulativeText = progress.text;
        emit(true);
      }
    },
  );

  // SSE 종료 — 마지막 step 의 doneAt 마킹.
  const last = steps[steps.length - 1];
  if (last && !last.doneAt) last.doneAt = Date.now();
  emit(false);

  // RunResult 호환 형식. history 는 단순 user/assistant text 만 (외곽 LLM 의
  // tool_use/tool_result 블록 없음 — 외곽 우회).
  const newMessages: MessageParam[] = [
    { role: "user", content: userText },
    { role: "assistant", content: r.text || "(argus 응답 없음)" },
  ];
  const toolCallLog = steps.map((s) => ({
    name: s.name,
    durationMs: (s.doneAt ?? Date.now()) - s.startedAt,
  }));

  const chipActions: ChipAction[] = r.actions ?? [];

  return {
    text: r.text,
    newMessages,
    hops: -1, // direct route 마커 — 로그에서 `hops=-1` 로 식별
    toolCallLog,
    chipActions,
    ...(r.conversationId
      ? { argusConversationId: r.conversationId }
      : {}),
    ...(r.recommendedQuestions
      ? { recommendedQuestions: r.recommendedQuestions }
      : {}),
  };
}
