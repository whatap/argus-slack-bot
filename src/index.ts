// src/index.ts
//
// argus-slack-bot 진입점.
// Slack Bolt App (Socket Mode) + Anthropic + whatap-mcp 셋 와이어링.
//
// 동작:
//   1. 부팅 시 whatap-open-mcp-aitf 를 stdio 자식으로 spawn.
//   2. Slack 의 app_mention / message.im 이벤트 받으면 ClaudeLoop 실행.
//   3. 같은 thread 안의 후속 메시지는 ThreadHistory 로 컨텍스트 유지.
//   4. SIGINT/SIGTERM 시 MCP child 정리 후 종료.

import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";
import bolt from "@slack/bolt";

import { runClaudeWithMcp } from "./claude-loop.js";
import { ThreadHistory } from "./conversation.js";
import { WhatapMcpClient } from "./mcp-client.js";
import { splitForSlack, toSlackMrkdwn } from "./slack-format.js";

const { App, LogLevel } = bolt;

// ── 환경변수 검사 ─────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[argus-slack-bot] ${name} env 미설정 — .env.example 참고.`);
    process.exit(1);
  }
  return v;
}

const SLACK_BOT_TOKEN = requireEnv("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = requireEnv("SLACK_APP_TOKEN");
const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
const WHATAP_MCP_PATH = requireEnv("WHATAP_MCP_PATH");

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
const ANTHROPIC_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 8192);
const MAX_TOOL_HOPS = Number(process.env.MAX_TOOL_HOPS || 8);
const MAX_HISTORY_TURNS = Number(process.env.MAX_HISTORY_TURNS || 10);

// ── System prompt ────────────────────────────────────────────
// argus 자체가 풍부한 system prompt 를 들고 있어서 bot 외곽 prompt 는 짧게.
// Slack mrkdwn 가이드만 명시.
const SYSTEM_PROMPT = `당신은 WhaTap 의 도메인 전문가 봇입니다. 사용자가 Slack 에서
모니터링·알림·인프라에 대해 질문하면 ask_whatap_expert 도구로 argus (WhaTap 내부 LLM
에이전트) 에 위임하고, 그 결과를 Slack 메시지로 답하세요.

- 한국어 질문엔 한국어로, 영어엔 영어로 답.
- 답변에 표가 있으면 그대로 둠 (Slack 에선 코드블록으로 자동 변환됨).
- 모호한 질문은 명확화 질문 1개를 우선 던져도 됨.
- argus 가 이미 합성한 답을 받으면 그대로 사용자에게 전달 — 재요약·재해석 금지.
- 도구 호출은 보통 ask_whatap_expert 한 번이면 충분. 특정 메트릭만 필요하면
  whatap_query_data / whatap_recent_alerts 등 직접 호출 가능.`;

// ── 부팅 ──────────────────────────────────────────────────────
async function main() {
  // 1) MCP 자식 띄움
  console.log("[argus-slack-bot] starting MCP client (whatap-mcp)...");
  const mcpClient = new WhatapMcpClient({ scriptPath: WHATAP_MCP_PATH });
  await mcpClient.connect();
  const toolNames = mcpClient.toolsForAnthropic().map((t) => t.name);
  console.log(`[argus-slack-bot] MCP tools loaded (${toolNames.length}): ${toolNames.join(", ")}`);

  // 2) Anthropic + 대화 history
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const threadHistory = new ThreadHistory(MAX_HISTORY_TURNS);

  // 3) Slack Bolt App (Socket Mode)
  const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // 메시지 핸들러 — app_mention / DM 둘 다 처리.
  // Bolt 가 app_mention 과 message.im 을 각각 트리거하지만 처리 로직은 동일.
  const handle = async (params: {
    text: string;
    threadKey: string;
    say: (args: { text: string; thread_ts?: string }) => Promise<unknown>;
    threadTs: string;
  }) => {
    const { text, threadKey, say, threadTs } = params;
    if (!text) return;

    // 로딩 표시 (Slack 은 typing indicator 를 사용자 봇은 못 띄움 — placeholder 메시지로 대체)
    let placeholderTs: string | undefined;
    try {
      const placed = (await say({ text: "_argus 가 응답 준비 중..._", thread_ts: threadTs })) as
        | { ts?: string }
        | undefined;
      placeholderTs = placed?.ts;
    } catch {
      // placeholder 실패해도 본 응답은 시도.
    }

    try {
      const state = threadHistory.get(threadKey);
      const t0 = Date.now();
      const result = await runClaudeWithMcp(
        {
          anthropic,
          mcpClient,
          model: ANTHROPIC_MODEL,
          maxTokens: ANTHROPIC_MAX_TOKENS,
          maxHops: MAX_TOOL_HOPS,
          system: SYSTEM_PROMPT,
        },
        text,
        state.history,
      );
      const dur = Date.now() - t0;
      console.log(
        `[argus-slack-bot] thread=${threadKey} hops=${result.hops} dur=${dur}ms text_len=${result.text.length}`,
      );

      threadHistory.appendTurn(threadKey, result.newMessages);

      const formatted = toSlackMrkdwn(result.text || "_(빈 응답)_");
      const chunks = splitForSlack(formatted);

      // placeholder 가 있으면 첫 chunk 로 update, 아니면 새 메시지.
      if (placeholderTs) {
        try {
          await app.client.chat.update({
            channel: getChannelFromThreadKey(threadKey),
            ts: placeholderTs,
            text: chunks[0],
          });
        } catch {
          await say({ text: chunks[0], thread_ts: threadTs });
        }
      } else {
        await say({ text: chunks[0], thread_ts: threadTs });
      }
      // 후속 chunk 는 추가 메시지로.
      for (let i = 1; i < chunks.length; i++) {
        await say({ text: chunks[i], thread_ts: threadTs });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[argus-slack-bot] error in thread=${threadKey}:`, err);
      const errText = `:warning: argus 호출 실패: \`${msg}\``;
      if (placeholderTs) {
        try {
          await app.client.chat.update({
            channel: getChannelFromThreadKey(threadKey),
            ts: placeholderTs,
            text: errText,
          });
        } catch {
          await say({ text: errText, thread_ts: threadTs });
        }
      } else {
        await say({ text: errText, thread_ts: threadTs });
      }
    }
  };

  app.event("app_mention", async ({ event, say }) => {
    const channel = event.channel;
    // 멘션은 기본적으로 thread_ts 가 부모 메시지라면 thread 안, 아니면 메시지 자체 ts.
    const threadTs = event.thread_ts ?? event.ts;
    const threadKey = `${channel}:${threadTs}`;
    // <@U123> argus 멘션 토큰 자체를 prompt 에서 제거.
    const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    await handle({
      text: cleanText,
      threadKey,
      threadTs,
      say: (args) => say(args),
    });
  });

  app.message(async ({ message, say }) => {
    // Bolt 의 message union 은 GenericMessage + BotMessage + ... 등 다수 형태.
    // DM 만 처리 (channel_type === "im"). subtype 있는 (bot 자기 메시지·edit 등) 은 무시.
    // 모든 union 분기에서 필드 접근하려고 record 캐스팅.
    const m = message as unknown as Record<string, unknown>;
    if (m.channel_type !== "im") return;
    if (m.subtype) return;
    const text = String(m.text ?? "").trim();
    if (!text) return;
    const channel = String(m.channel ?? "");
    const ts = String(m.ts ?? "");
    const threadTs = String(m.thread_ts ?? ts);
    const threadKey = `${channel}:${threadTs}`;
    await handle({ text, threadKey, threadTs, say: (args) => say(args) });
  });

  await app.start();
  console.log("[argus-slack-bot] connected (Socket Mode). Mention me with @argus in any channel I'm invited to.");

  // 4) Graceful shutdown
  const shutdown = async (sig: string) => {
    console.log(`[argus-slack-bot] received ${sig}, shutting down...`);
    try {
      await app.stop();
    } catch {}
    try {
      await mcpClient.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** threadKey 는 "<channel>:<ts>" 포맷 — channel 추출. */
function getChannelFromThreadKey(threadKey: string): string {
  const idx = threadKey.indexOf(":");
  return idx > 0 ? threadKey.slice(0, idx) : threadKey;
}

main().catch((err) => {
  console.error("[argus-slack-bot] fatal:", err);
  process.exit(1);
});
