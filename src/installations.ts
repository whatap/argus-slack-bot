// src/installations.ts
//
// Slack OAuth installation 영속화. Bolt 의 InstallationStore 인터페이스 구현.
// team_id (workspace) → bot_token + 메타데이터.
//
// Bolt 가 OAuth 콜백 받으면 storeInstallation 호출 → DB 저장.
// 봇이 어떤 워크스페이스의 이벤트를 받으면 fetchInstallation 으로
// 해당 워크스페이스의 bot_token 을 찾아서 응답할 때 사용.

import Database from "better-sqlite3";
// @slack/bolt re-exports these from @slack/oauth.
import type { Installation, InstallationQuery } from "@slack/bolt";

export class SqliteInstallationStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS slack_installations (
        team_id        TEXT PRIMARY KEY,
        enterprise_id  TEXT,
        bot_user_id    TEXT,
        bot_token      TEXT NOT NULL,
        scopes         TEXT,
        installed_at   INTEGER NOT NULL,
        raw_json       TEXT NOT NULL
      )
    `);
  }

  /** Bolt 가 OAuth 성공 시 호출 — installation 통째로 JSON 저장. */
  async storeInstallation<AuthVersion extends "v1" | "v2">(
    installation: Installation<AuthVersion, boolean>,
  ): Promise<void> {
    // team 정보. enterprise install 케이스도 있지만 MVP 는 team 단위만.
    const teamId = installation.team?.id;
    if (!teamId) {
      throw new Error("storeInstallation: team.id 누락 (enterprise install 미지원)");
    }
    const enterpriseId = installation.enterprise?.id ?? null;
    const botUserId = installation.bot?.userId ?? null;
    const botToken = installation.bot?.token ?? null;
    if (!botToken) {
      throw new Error("storeInstallation: bot.token 누락");
    }
    const scopes = Array.isArray(installation.bot?.scopes)
      ? installation.bot.scopes.join(",")
      : null;

    this.db
      .prepare(
        `INSERT INTO slack_installations
           (team_id, enterprise_id, bot_user_id, bot_token, scopes, installed_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id) DO UPDATE SET
           enterprise_id = excluded.enterprise_id,
           bot_user_id   = excluded.bot_user_id,
           bot_token     = excluded.bot_token,
           scopes        = excluded.scopes,
           installed_at  = excluded.installed_at,
           raw_json      = excluded.raw_json`,
      )
      .run(
        teamId,
        enterpriseId,
        botUserId,
        botToken,
        scopes,
        Date.now(),
        JSON.stringify(installation),
      );
  }

  /** Bolt 가 이벤트 처리 전에 호출 — team_id 로 bot_token 등 lookup. */
  async fetchInstallation(
    query: InstallationQuery<boolean>,
  ): Promise<Installation<"v1" | "v2", boolean>> {
    const teamId = query.teamId;
    if (!teamId) {
      throw new Error("fetchInstallation: teamId 누락");
    }
    const row = this.db
      .prepare(`SELECT raw_json FROM slack_installations WHERE team_id = ?`)
      .get(teamId) as { raw_json: string } | undefined;
    if (!row) {
      throw new Error(`fetchInstallation: ${teamId} 미설치`);
    }
    return JSON.parse(row.raw_json) as Installation<"v1" | "v2", boolean>;
  }

  /** Bolt 가 app_uninstalled / tokens_revoked 시 호출. */
  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    const teamId = query.teamId;
    if (!teamId) return;
    this.db
      .prepare(`DELETE FROM slack_installations WHERE team_id = ?`)
      .run(teamId);
  }

  /** 디버그용: 설치된 워크스페이스 카운트. */
  count(): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS c FROM slack_installations`)
      .get() as { c: number };
    return r.c;
  }

  close(): void {
    this.db.close();
  }
}
