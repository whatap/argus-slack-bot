// src/oauth-http.ts
//
// 와탭 계정 연결용 HTTP 엔드포인트 두 개.
//
//   GET /oauth/start?login=<id>   Slack 에서 받은 링크. 새 state + PKCE 로 와탭 로그인(authorize)에 보낸다.
//   GET /oauth/callback           로그인·동의 뒤 돌아오는 곳. code 를 토큰으로 바꿔 Slack 사용자에 저장한다.
//
// login id 는 Slack 사용자에게만 보낸 일회용 값이다 (기본 10분). 콜백의 state 는 한 번만
// 받는다. 진행 중인 로그인은 메모리에만 두며, 봇이 재시작되면 Slack 에서 다시 login 하면 된다.

import type http from "node:http";

import type { WhatapLinkStore } from "./whatap-links.js";
import { createPkcePair, randomToken, revokeTokensBestEffort, type WhatapOAuthClient } from "./whatap-oauth.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface LoginSubject {
  teamId: string;
  slackUserId: string;
}

interface PendingState extends LoginSubject {
  loginId: string;
  verifier: string;
  expiresAt: number;
}

export class PendingLogins {
  private readonly logins = new Map<string, LoginSubject & { expiresAt: number }>();
  private readonly states = new Map<string, PendingState>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: {
    /** Current local Slack installation, not a caller-supplied team assertion. */
    isWorkspaceActive: (teamId: string) => boolean;
    ttlMs?: number;
    now?: () => number;
  }) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Slack 사용자에게 보낼 login id 를 만든다. */
  create(teamId: string, slackUserId: string): string {
    if (!this.opts.isWorkspaceActive(teamId)) throw new Error("Slack workspace installation is inactive");
    this.sweep();
    const id = randomToken(32);
    this.logins.set(id, { teamId, slackUserId, expiresAt: this.now() + this.ttlMs });
    return id;
  }

  /** /oauth/start — 살아 있는 login id 면 새 state 와 PKCE challenge 를 만든다. */
  begin(loginId: string): { state: string; challenge: string; isActive: () => boolean } | null {
    this.sweep();
    const login = this.logins.get(loginId);
    if (!login || !this.opts.isWorkspaceActive(login.teamId)) return null;
    const { verifier, challenge } = createPkcePair();
    const state = randomToken(32);
    const entry: PendingState = {
      teamId: login.teamId,
      slackUserId: login.slackUserId,
      loginId,
      verifier,
      expiresAt: this.now() + this.ttlMs,
    };
    this.states.set(state, entry);
    return { state, challenge, isActive: () => this.states.get(state) === entry && this.isActive(entry) };
  }

  /** /oauth/callback — state 는 한 번만 쓸 수 있다. */
  take(state: string): PendingState | null {
    const entry = this.states.get(state);
    this.states.delete(state);
    if (!entry || entry.expiresAt <= this.now() || !this.opts.isWorkspaceActive(entry.teamId)) return null;
    return entry;
  }

  /** Check again after exchange: take() alone does not authorize a late write. */
  isActive(entry: PendingState): boolean {
    const login = this.logins.get(entry.loginId);
    return this.opts.isWorkspaceActive(entry.teamId)
      && !!login && login.teamId === entry.teamId && login.slackUserId === entry.slackUserId
      && login.expiresAt > this.now() && entry.expiresAt > this.now();
  }

  /** 연결이 끝나면 그 login id 와 남은 state 를 모두 지운다. */
  finish(loginId: string): void {
    this.logins.delete(loginId);
    for (const [state, entry] of this.states) {
      if (entry.loginId === loginId) this.states.delete(state);
    }
  }

  /** Includes states already taken by callbacks: their login id is invalidated too. */
  revokeTeam(teamId: string): void {
    for (const [id, login] of this.logins) {
      if (login.teamId === teamId) this.logins.delete(id);
    }
    for (const [state, entry] of this.states) {
      if (entry.teamId === teamId) this.states.delete(state);
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, login] of this.logins) {
      if (login.expiresAt <= now) this.logins.delete(id);
    }
    for (const [state, entry] of this.states) {
      if (entry.expiresAt <= now) this.states.delete(state);
    }
  }
}

/** Slack 으로 보낼 시작 링크. 콜백과 같은 출처의 /oauth/start 를 쓴다. */
export function loginStartUrl(redirectUri: string, loginId: string): string {
  const url = new URL("/oauth/start", redirectUri);
  url.searchParams.set("login", loginId);
  return url.toString();
}

export interface OAuthHttpDeps {
  client: WhatapOAuthClient;
  store: WhatapLinkStore;
  pending: PendingLogins;
  /** 연결 완료 화면의 "Slack 으로 돌아가기" 링크용. */
  slackAppId?: string;
  log?: (msg: string) => void;
}

export function createOAuthHttpHandler(deps: OAuthHttpDeps): http.RequestListener {
  const log = deps.log ?? ((msg: string) => console.log(`[whatap-oauth] ${msg}`));

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/oauth/start" && url.pathname !== "/oauth/callback") {
      return sendPage(res, 404, "페이지를 찾을 수 없어요", "");
    }
    if (req.method !== "GET") {
      return sendPage(res, 405, "지원하지 않는 요청이에요", "");
    }

    if (url.pathname === "/oauth/start") {
      const started = deps.pending.begin(url.searchParams.get("login") ?? "");
      if (!started) {
        return sendPage(
          res,
          400,
          "로그인 링크가 만료됐어요",
          "Slack 에서 login 을 다시 보내 새 링크를 받으세요.",
        );
      }
      const location = await deps.client.authorizationUrl(started.state, started.challenge);
      if (!started.isActive()) {
        return sendPage(res, 400, "로그인 요청이 취소됐어요", "Slack 에서 login 을 다시 보내세요.");
      }
      res.writeHead(302, {
        Location: location,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      return res.end();
    }

    const pending = deps.pending.take(url.searchParams.get("state") ?? "");
    if (!pending) {
      return sendPage(
        res,
        400,
        "로그인 요청을 확인할 수 없어요",
        "링크가 만료됐거나 이미 사용됐어요. Slack 에서 login 을 다시 보내세요.",
      );
    }
    const code = url.searchParams.get("code") ?? "";
    if (!code) {
      return sendPage(
        res,
        400,
        "와탭 계정을 연결하지 않았어요",
        "권한 허용이 끝나지 않았어요. 연결하려면 Slack 에서 받은 링크를 다시 여세요.",
      );
    }

    let tokens;
    try {
      tokens = await deps.client.exchangeCode(code, pending.verifier);
    } catch (err) {
      log(`code exchange failed: ${err instanceof Error ? err.message : String(err)}`);
      return sendPage(
        res,
        502,
        "와탭 로그인 서버와 통신하지 못했어요",
        "잠시 후 Slack 에서 받은 링크를 다시 여세요.",
      );
    }

    if (!deps.pending.isActive(pending)) {
      void revokeTokensBestEffort(deps.client, tokens);
      return sendPage(res, 400, "로그인 요청이 취소됐어요", "Slack 에서 login 을 다시 보내세요.");
    }
    deps.store.save({
      teamId: pending.teamId,
      slackUserId: pending.slackUserId,
      subject: tokens.subject ?? "",
      email: tokens.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    });
    deps.pending.finish(pending.loginId);
    log(`linked team=${pending.teamId} user=${pending.slackUserId} sub=${tokens.subject ?? "-"}`);

    const back = deps.slackAppId
      ? `https://slack.com/app_redirect?app=${encodeURIComponent(deps.slackAppId)}&team=${encodeURIComponent(pending.teamId)}`
      : undefined;
    return sendPage(res, 200, "와탭 계정을 연결했어요", "Slack 으로 돌아가서 질문하세요.", back);
  };

  return (req, res) => {
    handle(req, res).catch((err) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        sendPage(res, 500, "잠시 문제가 생겼어요", "잠시 후 다시 시도하세요.");
      } else {
        res.end();
      }
    });
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendPage(
  res: http.ServerResponse,
  status: number,
  title: string,
  message: string,
  link?: string,
): void {
  const linkHtml = link
    ? `<p><a href="${escapeHtml(link)}">Slack 으로 돌아가기</a></p>`
    : "";
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#1d1c1d}h1{font-size:20px}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${linkHtml}</body></html>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(html);
}
