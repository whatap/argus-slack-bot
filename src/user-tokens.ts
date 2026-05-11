// src/user-tokens.ts
//
// Slack user_id → WhaTap 인증 매핑을 SQLite 에 저장.
// MVP: WHATAP_API_TOKEN + ARGUS_COOKIE 두 키만. 향후 OAuth 로 옮기면 deprecate.
//
// 암호화:
//   - SLACK_TOKENS_ENCRYPTION_KEY env 가 있으면 AES-256-GCM 으로 token/cookie
//     암호화 (envelope, 'enc:' prefix).
//   - 미설정이면 plaintext (legacy / dev). DB 파일 평문 유출 위협 그대로.
//   - 점진 전환: key 추가 후 새 write 부터 암호화. 기존 legacy plaintext row 도
//     decryptToken 의 prefix 검사로 그대로 read.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { decryptToken, deriveKey, encryptToken } from "./crypto.js";

export interface UserCreds {
  whatapApiToken: string;
  /** dev.whatap.io 세션 cookie (전체 Cookie 헤더 값, e.g. "JSESSIONID=..."). 옵셔널. */
  argusCookie?: string;
  /** WHATAP_API_URL override. 안 주면 기본 https://dev.whatap.io. */
  whatapApiUrl?: string;
}

export class UserTokenStore {
  private db: Database.Database;
  /** 32-byte AES-256 key. null 이면 plaintext 모드 (legacy / dev). */
  private encKey: Buffer | null;

  constructor(dbPath: string, encryptionSecret?: string) {
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
    this.encKey = encryptionSecret ? deriveKey(encryptionSecret) : null;
  }

  /** 암호화 활성 상태. 부팅 로그용. */
  isEncrypted(): boolean {
    return this.encKey !== null;
  }

  private enc(v: string): string {
    return this.encKey ? encryptToken(v, this.encKey) : v;
  }

  private dec(v: string): string {
    return decryptToken(v, this.encKey);
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
        this.enc(creds.whatapApiToken),
        creds.argusCookie ? this.enc(creds.argusCookie) : null,
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
      whatapApiToken: this.dec(row.whatap_api_token),
      argusCookie: row.argus_cookie ? this.dec(row.argus_cookie) : undefined,
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
