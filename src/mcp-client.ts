// src/mcp-client.ts
//
// whatap-open-mcp-aitf 를 stdio 자식 프로세스로 spawn 하고
// MCP SDK Client 로 연결. 도구 list / call 만 wrap.
//
// MCP 서버 (whatap-mcp) 의 env 는 부모 프로세스의 env 에서 그대로 주입 —
// .env 의 WHATAP_API_TOKEN / ARGUS_URL / ARGUS_API_TOKEN / ARGUS_COOKIE
// 가 stdio child 로 전달돼야 ask_whatap_expert 도구가 등록된다.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface McpClientConfig {
  /** node CLI script path (whatap-open-mcp-aitf/dist/cli.js). */
  scriptPath: string;
  /** 자식 프로세스에 추가로 주입할 env. 기본: process.env 그대로. */
  env?: Record<string, string>;
}

export class WhatapMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private cachedTools: Tool[] | null = null;

  constructor(private cfg: McpClientConfig) {}

  /** stdio child 띄우고 initialize 까지 마침. listTools 결과 캐시. */
  async connect(): Promise<void> {
    // process.env 는 string | undefined 라 MCP SDK 의 Record<string,string> 시그니처
    // 에 직접 못 넘김 — undefined 필터링.
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) baseEnv[k] = v;
    }
    const env = { ...baseEnv, ...(this.cfg.env ?? {}) };

    this.transport = new StdioClientTransport({
      command: "node",
      args: [this.cfg.scriptPath],
      env,
    });

    this.client = new Client(
      { name: "argus-slack-bot", version: "0.1.0" },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);

    const list = await this.client.listTools();
    this.cachedTools = list.tools;
  }

  /** Anthropic tool 스키마로 변환된 도구 목록 반환.
   *
   * **하네스 layer**: ask_whatap_expert 만 노출. 다른 MCP 직접 호출 도구
   * (whatap_list_projects 등) 는 `api.whatap.io` 의 WHATAP_API_TOKEN 만료 시
   * 400 ([F] Invalid token) 에러. ask_whatap_expert 는 argus /v1/chat 으로
   * cookie 인증 → 토큰 무관. 8082 frontend 와 동일 흐름.
   *
   * 외곽 claude 가 도구 선택 자유도 갖되 ask_whatap_expert 한 개만 보임 →
   * 자동으로 그것 호출 → argus 가 풀 카탈로그로 sub-tool 결정.
   */
  toolsForAnthropic(): Array<{
    name: string;
    description: string;
    input_schema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  }> {
    if (!this.cachedTools) throw new Error("MCP client not connected");
    const ALLOWED = new Set(["ask_whatap_expert"]);
    const filtered = this.cachedTools.filter((t) => ALLOWED.has(t.name));
    console.log(
      `[mcp-client/debug] toolsForAnthropic — cached=${this.cachedTools.length}, filtered=${filtered.length}, returning=[${filtered.map((t) => t.name).join(",")}]`,
    );
    return filtered.map((t) => {
      // MCP 의 inputSchema 는 JSON Schema 객체. Anthropic 은 type:"object" 만 허용.
      const raw = (t.inputSchema ?? {}) as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      return {
        name: t.name,
        description: t.description ?? "",
        input_schema: {
          type: "object" as const,
          properties: raw.properties ?? {},
          ...(raw.required ? { required: raw.required } : {}),
        },
      };
    });
  }

  /** 도구 호출. 결과 텍스트 합산해서 string 으로 반환. */
  async callTool(name: string, args: unknown): Promise<string> {
    if (!this.client) throw new Error("MCP client not connected");
    const res = await this.client.callTool({
      name,
      arguments: (args as Record<string, unknown>) ?? {},
    });

    // MCP 응답 content 는 [{type:"text", text:"..."}, ...] 배열.
    const content = res.content as Array<{ type: string; text?: string }>;
    const texts: string[] = [];
    for (const c of content ?? []) {
      if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
    }
    if (texts.length === 0) {
      // tool_result 가 비어있어도 LLM 한테 빈 string 보내면 혼란 — 표식 남김.
      return "(tool returned no text content)";
    }
    return texts.join("\n");
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    this.client = null;
    this.transport = null;
    this.cachedTools = null;
  }
}
