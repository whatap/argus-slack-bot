// src/whatap-links.ts
//
// Slack 사용자(team_id + user_id) ↔ 와탭 계정 연결과 그 OAuth 토큰을 SQLite 에 저장한다.
// 토큰과 이메일은 항상 AES-256-GCM 으로 암호화한다 (crypto.ts). refresh token 은 오래
// 쓰는 자격증명이라 기존 user_tokens 처럼 평문 모드를 두지 않는다.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { decryptToken, deriveKey, encryptToken } from "./crypto.js";

export interface WhatapLink {
  teamId: string;
  slackUserId: string;
  /** 와탭 로그인 서버가 준 사용자 식별자 (id_token sub). */
  subject: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  /** access token 만료 시각 (epoch ms). */
  expiresAt: number;
  scope?: string;
}

interface LinkRow {
  team_id: string;
  slack_user_id: string;
  subject: string;
  email: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  scope: string | null;
}

export class WhatapLinkStore {
  private db: Database.Database;
  private key: Buffer;

  constructor(dbPath: string, encryptionSecret: string) {
    if (!encryptionSecret) {
      throw new Error("WhatapLinkStore: 토큰 암호화 키(SLACK_TOKENS_ENCRYPTION_KEY)가 필요해요");
    }
    this.key = deriveKey(encryptionSecret);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whatap_oauth_links (
        team_id        TEXT NOT NULL,
        slack_user_id  TEXT NOT NULL,
        subject        TEXT NOT NULL,
        email          TEXT,
        access_token   TEXT NOT NULL,
        refresh_token  TEXT,
        expires_at     INTEGER NOT NULL,
        scope          TEXT,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (team_id, slack_user_id)
      )
    `);
  }

  save(link: WhatapLink): void {
    this.db
      .prepare(
        `INSERT INTO whatap_oauth_links
           (team_id, slack_user_id, subject, email, access_token, refresh_token, expires_at, scope, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, slack_user_id) DO UPDATE SET
           subject       = excluded.subject,
           email         = excluded.email,
           access_token  = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at    = excluded.expires_at,
           scope         = excluded.scope,
           updated_at    = excluded.updated_at`,
      )
      .run(
        link.teamId,
        link.slackUserId,
        link.subject,
        link.email ? encryptToken(link.email, this.key) : null,
        encryptToken(link.accessToken, this.key),
        link.refreshToken ? encryptToken(link.refreshToken, this.key) : null,
        link.expiresAt,
        link.scope ?? null,
        Date.now(),
      );
  }

  get(teamId: string, slackUserId: string): WhatapLink | null {
    const row = this.db
      .prepare(
        `SELECT team_id, slack_user_id, subject, email, access_token, refresh_token, expires_at, scope
         FROM whatap_oauth_links WHERE team_id = ? AND slack_user_id = ?`,
      )
      .get(teamId, slackUserId) as LinkRow | undefined;
    if (!row) return null;
    return this.decode(row);
  }

  listTeam(teamId: string): WhatapLink[] {
    const rows = this.db.prepare(`SELECT * FROM whatap_oauth_links WHERE team_id = ?`).all(teamId) as LinkRow[];
    return rows.map((row) => this.decode(row));
  }

  deleteTeam(teamId: string): number {
    return this.db.prepare(`DELETE FROM whatap_oauth_links WHERE team_id = ?`).run(teamId).changes;
  }

  private decode(row: LinkRow): WhatapLink {
    return {
      teamId: row.team_id,
      slackUserId: row.slack_user_id,
      subject: row.subject,
      email: row.email ? decryptToken(row.email, this.key) : undefined,
      accessToken: decryptToken(row.access_token, this.key),
      refreshToken: row.refresh_token ? decryptToken(row.refresh_token, this.key) : undefined,
      expiresAt: row.expires_at,
      scope: row.scope ?? undefined,
    };
  }

  delete(teamId: string, slackUserId: string): boolean {
    const r = this.db
      .prepare(`DELETE FROM whatap_oauth_links WHERE team_id = ? AND slack_user_id = ?`)
      .run(teamId, slackUserId);
    return r.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
