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
}

export interface RunResult {
  /** 최종 assistant 텍스트. tool 호출 hop 만 있고 final text 없으면 빈 string. */
  text: string;
  /** 이번 turn 에서 추가된 메시지들 — 호출자가 thread history 에 append. */
  newMessages: MessageParam[];
  /** 사용된 hop 수 (디버그용 로깅). */
  hops: number;
}

export async function runClaudeWithMcp(
  cfg: ClaudeLoopConfig,
  userText: string,
  history: MessageParam[],
): Promise<RunResult> {
  const tools = cfg.mcpClient.toolsForAnthropic();
  const maxHops = cfg.maxHops ?? 8;

  // 누적될 새 메시지들 — 사용자 메시지부터 시작.
  const newMessages: MessageParam[] = [
    { role: "user", content: userText },
  ];

  let hops = 0;
  let finalText = "";

  for (hops = 0; hops < maxHops; hops++) {
    const response = await cfg.anthropic.messages.create({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system: cfg.system,
      tools,
      messages: [...history, ...newMessages],
    });

    // assistant 응답 자체를 history 에 추가 (tool_use 가 있어도 그대로).
    newMessages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      finalText = extractText(response.content);
      break;
    }

    if (response.stop_reason === "tool_use") {
      // tool_use 블록만 골라 MCP 로 dispatch, tool_result 모아 user 메시지로 push.
      const toolUses = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );
      const toolResults: ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        try {
          const result = await cfg.mcpClient.callTool(tu.name, tu.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: result,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Tool error: ${msg}`,
            is_error: true,
          });
        }
      }
      newMessages.push({ role: "user", content: toolResults });
      continue;
    }

    // 그 외 stop_reason (refusal 등) — 텍스트만 뽑고 종료.
    finalText = extractText(response.content);
    break;
  }

  if (!finalText && hops >= maxHops) {
    finalText = `(도구 호출 ${maxHops} hop 초과 — 응답 미완성)`;
  }

  return { text: finalText, newMessages, hops };
}

function extractText(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

// 작은 헬퍼 — 다른 모듈에서 직접 안 씀, ESLint silence.
export const __unused: TextBlockParam | null = null;
