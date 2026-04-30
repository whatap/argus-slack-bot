// src/conversation.ts
//
// Slack thread_ts ↔ Anthropic message history 매핑 + argus conversationId 캐시.
// 같은 thread 안의 follow-up 은 history 이어 붙여 LLM 에 같은 컨텍스트 유지.
//
// in-memory Map — bot 재기동시 손실 OK (사용자가 thread 안 follow-up 안 하면
// 새 conversation 으로 자연 시작).

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.mjs";

interface ThreadState {
  history: MessageParam[];
  /** ask_whatap_expert 첫 호출 후 받은 argus conversationId. follow-up 시 같은 값 사용. */
  argusConversationId?: string;
  lastTouchedAt: number;
}

export class ThreadHistory {
  private threads = new Map<string, ThreadState>();

  constructor(
    /** thread 당 보관할 최대 turn 수. 초과 시 오래된 turn 부터 drop. */
    private maxTurns: number = 10,
    /** 30분 idle 한 thread 자동 expire (메모리 누수 방지). */
    private idleMs: number = 30 * 60 * 1000,
  ) {}

  get(threadKey: string): ThreadState {
    this.gcExpired();
    let s = this.threads.get(threadKey);
    if (!s) {
      s = { history: [], lastTouchedAt: Date.now() };
      this.threads.set(threadKey, s);
    } else {
      s.lastTouchedAt = Date.now();
    }
    return s;
  }

  /** 새 turn 의 메시지들을 히스토리에 append. */
  appendTurn(threadKey: string, msgs: MessageParam[]): void {
    const s = this.get(threadKey);
    s.history.push(...msgs);
    // turn 수 = user + assistant pair 기준 대략 추정 — message count 로 cap.
    // user/assistant/tool 모두 합쳐서 maxTurns * 4 정도면 충분.
    const cap = this.maxTurns * 4;
    if (s.history.length > cap) {
      s.history = s.history.slice(s.history.length - cap);
    }
  }

  setArgusConvId(threadKey: string, id: string): void {
    const s = this.get(threadKey);
    if (!s.argusConversationId) {
      s.argusConversationId = id;
    }
  }

  /** thread 강제 초기화 — "/argus reset" 같은 명령 처리용. */
  reset(threadKey: string): void {
    this.threads.delete(threadKey);
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [k, s] of this.threads) {
      if (now - s.lastTouchedAt > this.idleMs) {
        this.threads.delete(k);
      }
    }
  }
}
