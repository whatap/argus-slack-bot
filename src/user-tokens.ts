// src/user-tokens.ts
//
// Slack user_id → WhaTap 인증 매핑을 SQLite 에 저장.
// MVP: WHATAP_API_TOKEN + ARGUS_COOKIE 두 키만. 향후 OAuth 로 옮기면 deprecate.
//
// 토큰은 plaintext 저장 — 노트북 / 단일 운영 호스트 전제. 다중 노드면
// 서버 사이드 암호화 필요 (KMS / vault 등).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface UserCreds {
  whatapApiToken: string;
  /** dev.whatap.io 세션 cookie (전체 Cookie 헤더 값, e.g. "JSESSIONID=..."). 옵셔널. */
  argusCookie?: string;
  /** WHATAP_API_URL override. 안 주면 기본 https://dev.whatap.io. */
  whatapApiUrl?: string;
}

export class UserTokenStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id   TEXT PRIMARY KEY,
        whatap_api_token TEXT NOT NULL,
        argus_cookie    TEXT,
        whatap_api_url  TEXT,
        updated_at      INTEGER NOT NULL
      )
    `);
  }

  set(slackUserId: string, creds: UserCreds): void {
    this.db
      .prepare(
        `INSERT INTO user_tokens (slack_user_id, whatap_api_token, argus_cookie, whatap_api_url, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slack_user_id) DO UPDATE SET
           whatap_api_token = excluded.whatap_api_token,
           argus_cookie     = excluded.argus_cookie,
           whatap_api_url   = excluded.whatap_api_url,
           updated_at       = excluded.updated_at`,
      )
      .run(
        slackUserId,
        creds.whatapApiToken,
        creds.argusCookie ?? null,
        creds.whatapApiUrl ?? null,
        Date.now(),
      );
  }

  get(slackUserId: string): UserCreds | null {
    const row = this.db
      .prepare(
        `SELECT whatap_api_token, argus_cookie, whatap_api_url
         FROM user_tokens WHERE slack_user_id = ?`,
      )
      .get(slackUserId) as
      | {
          whatap_api_token: string;
          argus_cookie: string | null;
          whatap_api_url: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      whatapApiToken: row.whatap_api_token,
      argusCookie: row.argus_cookie ?? undefined,
      whatapApiUrl: row.whatap_api_url ?? undefined,
    };
  }

  delete(slackUserId: string): boolean {
    const r = this.db
      .prepare(`DELETE FROM user_tokens WHERE slack_user_id = ?`)
      .run(slackUserId);
    return r.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

/** 토큰 마스킹 — 사용자한테 echo 할 때 안전하게. */
export function maskToken(t: string | undefined | null): string {
  if (!t) return "(미설정)";
  if (t.length <= 8) return "***";
  return t.slice(0, 4) + "***" + t.slice(-2);
}
