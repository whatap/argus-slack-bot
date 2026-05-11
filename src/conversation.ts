// src/conversation.ts
//
// Slack thread_ts ↔ Anthropic message history 매핑 + argus conversationId 캐시.
// 같은 thread 안의 follow-up 은 history 이어 붙여 LLM 에 같은 컨텍스트 유지.
//
// SQLite backing — 봇 재기동 시에도 thread history 유지. 이전 in-memory Map
// 구현은 재기동 시 모든 대화 손실이라 멀티 사용자 운영에 부담.
//
// 두 테이블:
//   thread_history(thread_key, turn_index, role, content_json) — 메시지 자체
//   thread_meta(thread_key, argus_conversation_id, last_touched_at) — 메타 + gc 키
//
// gc: idle 30분 (`idleMs`) 지난 thread 는 다음 get() 호출 시 일괄 삭제.
// user_tokens / slack_installations 와는 별도 DB 파일 권장 — thread gc 사이클이
// 잦아 vacuuming 비용이 사용자 데이터에 영향 안 가게 분리.

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.mjs";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ThreadState {
  history: MessageParam[];
  /** ask_whatap_expert 첫 호출 후 받은 argus conversationId. follow-up 시 같은 값 사용. */
  argusConversationId?: string;
  lastTouchedAt: number;
}

/** 자른 history 의 첫 메시지가 orphan 인지.
 *  user 메시지가 tool_result 만 들고 있으면 직전 assistant(tool_use) 가 사라진
 *  상태 → 다음 turn 호출 시 Anthropic 이 400 (`unexpected tool_use_id` 에러).
 *  Slack 봇은 thread history cap 으로 슬라이싱할 때 이 케이스가 잘 발생. */
function isOrphanFirstMessage(m: MessageParam): boolean {
  if (m.role !== "user") return false;
  const content = m.content;
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every(
    (b) => (b as { type?: string }).type === "tool_result",
  );
}

export class ThreadHistory {
  private db: Database.Database;

  constructor(
    /** thread 당 보관할 최대 turn 수. 초과 시 오래된 turn 부터 drop. */
    private maxTurns: number = 10,
    /** 30분 idle 한 thread 자동 expire. */
    private idleMs: number = 30 * 60 * 1000,
    /** SQLite 파일 경로. 기본 ./data/thread_history.sqlite */
    dbPath: string = "./data/thread_history.sqlite",
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_history (
        thread_key   TEXT NOT NULL,
        turn_index   INTEGER NOT NULL,
        role         TEXT NOT NULL,
        content_json TEXT NOT NULL,
        PRIMARY KEY (thread_key, turn_index)
      );
      CREATE TABLE IF NOT EXISTS thread_meta (
        thread_key             TEXT PRIMARY KEY,
        argus_conversation_id  TEXT,
        last_touched_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_meta_touched
        ON thread_meta(last_touched_at);
    `);
  }

  get(threadKey: string): ThreadState {
    this.gcExpired();
    this.touchThread(threadKey);

    const rows = this.db
      .prepare(
        `SELECT role, content_json
         FROM thread_history
         WHERE thread_key = ?
         ORDER BY turn_index`,
      )
      .all(threadKey) as Array<{ role: string; content_json: string }>;

    const history: MessageParam[] = rows.map((r) => {
      const content = JSON.parse(r.content_json);
      return {
        role: r.role as "user" | "assistant",
        content,
      };
    });

    const meta = this.db
      .prepare(
        `SELECT argus_conversation_id FROM thread_meta WHERE thread_key = ?`,
      )
      .get(threadKey) as { argus_conversation_id: string | null } | undefined;

    return {
      history,
      argusConversationId: meta?.argus_conversation_id ?? undefined,
      lastTouchedAt: Date.now(),
    };
  }

  /** 새 turn 의 메시지들을 히스토리에 append. */
  appendTurn(threadKey: string, msgs: MessageParam[]): void {
    if (msgs.length === 0) return;
    const max = (this.db
      .prepare(
        `SELECT COALESCE(MAX(turn_index), -1) AS m
         FROM thread_history WHERE thread_key = ?`,
      )
      .get(threadKey) as { m: number }).m;

    const insert = this.db.prepare(
      `INSERT INTO thread_history (thread_key, turn_index, role, content_json)
       VALUES (?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      let next = max + 1;
      for (const m of msgs) {
        // content 는 string 또는 ContentBlock[] — 둘 다 JSON serializable.
        insert.run(threadKey, next++, m.role, JSON.stringify(m.content));
      }
      this.touchThread(threadKey);
    });
    tx();

    // turn 수 cap — user+assistant+tool 다 합쳐서 maxTurns * 4 정도면 충분.
    const cap = this.maxTurns * 4;
    const count = (this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM thread_history WHERE thread_key = ?`,
      )
      .get(threadKey) as { c: number }).c;
    if (count > cap) {
      // 오래된 turn 부터 drop — turn_index 작은 순.
      const dropCount = count - cap;
      const cutoff = (this.db
        .prepare(
          `SELECT turn_index FROM thread_history
           WHERE thread_key = ? ORDER BY turn_index LIMIT 1 OFFSET ?`,
        )
        .get(threadKey, dropCount) as { turn_index: number } | undefined)
        ?.turn_index;
      if (cutoff !== undefined) {
        this.db
          .prepare(
            `DELETE FROM thread_history
             WHERE thread_key = ? AND turn_index < ?`,
          )
          .run(threadKey, cutoff);
      }
    }

    // tool_use ↔ tool_result 페어 보호 — orphan 첫 메시지 (user with tool_result only) 제거.
    // 한 번이 아닌 while 인 이유: 연속으로 orphan 일 수 있음.
    while (true) {
      const first = this.db
        .prepare(
          `SELECT turn_index, role, content_json
           FROM thread_history WHERE thread_key = ?
           ORDER BY turn_index LIMIT 1`,
        )
        .get(threadKey) as
        | { turn_index: number; role: string; content_json: string }
        | undefined;
      if (!first) break;
      try {
        const content = JSON.parse(first.content_json);
        const msg: MessageParam = {
          role: first.role as "user" | "assistant",
          content,
        };
        if (!isOrphanFirstMessage(msg)) break;
      } catch {
        break;
      }
      this.db
        .prepare(
          `DELETE FROM thread_history
           WHERE thread_key = ? AND turn_index = ?`,
        )
        .run(threadKey, first.turn_index);
    }
  }

  setArgusConvId(threadKey: string, id: string): void {
    // 첫 호출만 set — 이미 있으면 유지.
    const existing = this.db
      .prepare(
        `SELECT argus_conversation_id FROM thread_meta WHERE thread_key = ?`,
      )
      .get(threadKey) as
      | { argus_conversation_id: string | null }
      | undefined;
    if (existing?.argus_conversation_id) return;
    this.db
      .prepare(
        `INSERT INTO thread_meta (thread_key, argus_conversation_id, last_touched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_key) DO UPDATE SET
           argus_conversation_id = excluded.argus_conversation_id,
           last_touched_at = excluded.last_touched_at`,
      )
      .run(threadKey, id, Date.now());
  }

  /** thread 강제 초기화 — "/argus reset" 같은 명령 처리용. */
  reset(threadKey: string): void {
    this.db
      .prepare(`DELETE FROM thread_history WHERE thread_key = ?`)
      .run(threadKey);
    this.db
      .prepare(`DELETE FROM thread_meta WHERE thread_key = ?`)
      .run(threadKey);
  }

  close(): void {
    this.db.close();
  }

  private touchThread(threadKey: string): void {
    this.db
      .prepare(
        `INSERT INTO thread_meta (thread_key, argus_conversation_id, last_touched_at)
         VALUES (?, NULL, ?)
         ON CONFLICT(thread_key) DO UPDATE SET last_touched_at = excluded.last_touched_at`,
      )
      .run(threadKey, Date.now());
  }

  private gcExpired(): void {
    const cutoff = Date.now() - this.idleMs;
    const stale = this.db
      .prepare(
        `SELECT thread_key FROM thread_meta WHERE last_touched_at < ?`,
      )
      .all(cutoff) as Array<{ thread_key: string }>;
    if (stale.length === 0) return;
    const delHistory = this.db.prepare(
      `DELETE FROM thread_history WHERE thread_key = ?`,
    );
    const delMeta = this.db.prepare(
      `DELETE FROM thread_meta WHERE thread_key = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const { thread_key } of stale) {
        delHistory.run(thread_key);
        delMeta.run(thread_key);
      }
    });
    tx();
  }
}
