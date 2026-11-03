// src/whatap-oauth.ts
//
// 와탭 로그인 서버(whatap.server.oauth, front 가 대리)와의 OAuth 2.0 통신과 사용자별
// access token 관리.
//
//   - authorization code + PKCE(S256), client_secret_basic
//   - 엔드포인트는 issuer 의 /.well-known/openid-configuration 에서 읽는다
//   - refresh 마다 새 refresh token 이 나오므로(rotation) 매번 바꿔 저장한다
//   - 같은 사용자의 동시 갱신은 한 번으로 묶는다 (rotation 경합 방지)
//
// 토큰 요청은 redirect 를 따라가지 않는다. Basic 자격증명이 다른 주소로 다시 실려
// 나가는 것을 막기 위해서다.

import { createHash, randomBytes } from "node:crypto";

import type { WhatapLink, WhatapLinkStore } from "./whatap-links.js";

export interface WhatapOAuthConfig {
  /** 와탭 로그인 issuer = front 외부 주소. 예: https://service.whatap.io */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** 로그인 뒤 돌아올 봇 주소. 로그인 서버에 등록한 값과 정확히 같아야 한다. */
  redirectUri: string;
  scope: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
  scope?: string;
  subject?: string;
  email?: string;
}

/** 토큰 엔드포인트가 거절한 경우. code 는 OAuth error 값 (예: invalid_grant). */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/** 연결된 와탭 계정이 없거나 갱신이 거절돼 다시 로그인해야 하는 경우. */
export class LoginRequiredError extends Error {
  constructor(message = "와탭 계정 연결이 필요해요") {
    super(message);
    this.name = "LoginRequiredError";
  }
}

const DEFAULT_EXPIRES_IN_SEC = 300;
const HTTP_TIMEOUT_MS = 15_000;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: pkceChallenge(verifier) };
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

interface Endpoints {
  authorization: string;
  token: string;
  revocation?: string;
}

export class WhatapOAuthClient {
  private discovery?: Promise<Endpoints>;

  constructor(
    readonly config: WhatapOAuthConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async authorizationUrl(state: string, codeChallenge: string): Promise<string> {
    const ep = await this.endpoints();
    const url = new URL(ep.authorization);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  /** refresh token 회수 (RFC 7009). 실패해도 예외를 던지지 않는다. 결과는 회수 요청이
   *  2xx 로 끝났는지 여부. */
  async revoke(token: string, tokenTypeHint: "refresh_token" | "access_token" = "refresh_token"): Promise<boolean> {
    try {
      const ep = await this.endpoints();
      if (!ep.revocation) return false;
      const res = await fetch(ep.revocation, {
        method: "POST",
        headers: {
          Authorization: this.basicAuth(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token,
          token_type_hint: tokenTypeHint,
        }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  private basicAuth(): string {
    // RFC 6749 2.3.1 — id/secret 을 form-urlencode 한 뒤 Basic 으로 묶는다.
    const id = encodeURIComponent(this.config.clientId);
    const secret = encodeURIComponent(this.config.clientSecret);
    return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
  }

  private endpoints(): Promise<Endpoints> {
    if (!this.discovery) {
      this.discovery = this.fetchDiscovery().catch((err) => {
        this.discovery = undefined; // 실패는 캐시하지 않는다
        throw err;
      });
    }
    return this.discovery;
  }

  private async fetchDiscovery(): Promise<Endpoints> {
    const issuer = trimSlash(this.config.issuer);
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`whatap oauth discovery failed (${res.status})`);
    }
    const doc = (await res.json()) as Record<string, unknown>;
    if (typeof doc.issuer !== "string" || trimSlash(doc.issuer) !== issuer) {
      throw new Error("whatap oauth discovery issuer mismatch");
    }
    if (typeof doc.authorization_endpoint !== "string" || typeof doc.token_endpoint !== "string") {
      throw new Error("whatap oauth discovery has no authorization/token endpoint");
    }
    return {
      authorization: doc.authorization_endpoint,
      token: doc.token_endpoint,
      revocation:
        typeof doc.revocation_endpoint === "string" ? doc.revocation_endpoint : undefined,
    };
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenSet> {
    const ep = await this.endpoints();
    const res = await fetch(ep.token, {
      method: "POST",
      headers: {
        Authorization: this.basicAuth(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const errorCode = typeof body.error === "string" ? body.error : undefined;
    if (!res.ok) {
      throw new OAuthError(
        `whatap oauth token request failed (${res.status}${errorCode ? ` ${errorCode}` : ""})`,
        res.status,
        errorCode,
      );
    }
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new OAuthError("whatap oauth token response has no access_token", res.status);
    }
    const expiresIn =
      Number(body.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_EXPIRES_IN_SEC;
    return {
      accessToken: body.access_token,
      refreshToken:
        typeof body.refresh_token === "string" && body.refresh_token !== ""
          ? body.refresh_token
          : undefined,
      expiresAt: this.now() + expiresIn * 1000,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      ...this.identityFromIdToken(body.id_token),
    };
  }

  /** id_token 은 토큰 엔드포인트에서 직접 받은 값이라 서명 대신 iss·aud 만 확인한다
   *  (OIDC Core 3.1.3.7). 맞지 않으면 다른 대상의 토큰이므로 연결하지 않는다. */
  private identityFromIdToken(idToken: unknown): { subject?: string; email?: string } {
    if (typeof idToken !== "string" || idToken === "") return {};
    const parts = idToken.split(".");
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    } catch {
      throw new OAuthError("whatap oauth id_token is malformed", 200);
    }
    const aud = claims.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.config.clientId) : aud === this.config.clientId;
    const issOk =
      typeof claims.iss === "string" && trimSlash(claims.iss) === trimSlash(this.config.issuer);
    if (!audOk || !issOk) {
      throw new OAuthError("whatap oauth id_token issuer/audience mismatch", 200);
    }
    return {
      subject: typeof claims.sub === "string" ? claims.sub : undefined,
      email: typeof claims.email === "string" ? claims.email : undefined,
    };
  }
}

export interface TokenManagerOptions {
  /** 남은 수명이 이보다 짧으면 미리 갱신한다. argus 한 번의 실행(최대 2분) 동안
   *  front 데이터 조회에 같은 토큰이 쓰이므로 그보다 길게 둔다. */
  minRemainingMs?: number;
  now?: () => number;
}

/** Never hold local invalidation or a callback response open for remote revocation. */
export async function revokeTokensBestEffort(
  client: WhatapOAuthClient,
  tokens: Pick<TokenSet, "refreshToken" | "accessToken">,
): Promise<void> {
  try {
    if (tokens.refreshToken) await client.revoke(tokens.refreshToken);
    else await client.revoke(tokens.accessToken, "access_token");
  } catch {
    // Cleanup is best-effort, including custom client failures; never log credentials.
  }
}

export class WhatapTokenManager {
  private readonly minRemainingMs: number;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly store: WhatapLinkStore,
    private readonly client: WhatapOAuthClient,
    opts: TokenManagerOptions = {},
  ) {
    this.minRemainingMs = opts.minRemainingMs ?? 150_000;
    this.now = opts.now ?? Date.now;
  }

  async accessToken(
    teamId: string,
    slackUserId: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<string> {
    const link = this.store.get(teamId, slackUserId);
    if (!link) throw new LoginRequiredError();
    if (!opts.forceRefresh && link.expiresAt - this.now() > this.minRemainingMs) {
      return link.accessToken;
    }
    return this.refreshOnce(link);
  }

  /** 사용자 토큰으로 fn 을 부른다. fn 이 status 401 오류(예: ArgusHttpError)를 던지면
   *  만료 전에 회수된 토큰일 수 있으므로 한 번 갱신해 다시 부른다. 그래도 401 이면 그대로 던진다. */
  async withAccessToken<T>(
    teamId: string,
    slackUserId: string,
    fn: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.accessToken(teamId, slackUserId);
    try {
      return await fn(token);
    } catch (err) {
      if ((err as { status?: unknown } | null)?.status !== 401) throw err;
      const fresh = await this.accessToken(teamId, slackUserId, { forceRefresh: true });
      return fn(fresh);
    }
  }

  /** 연결을 지우고 refresh token 을 로그인 서버에서 회수한다. 회수는 best-effort 라
   *  로그인 서버가 안 닿아도 봇 쪽 연결은 지운다. 연결이 없었으면 false. */
  async unlink(teamId: string, slackUserId: string): Promise<boolean> {
    const link = this.store.get(teamId, slackUserId);
    if (!link) return false;
    this.store.delete(teamId, slackUserId);
    if (link.refreshToken) await this.client.revoke(link.refreshToken);
    return true;
  }

  /** Local deletion is synchronous; remote cleanup is bounded to one revoke at a time. */
  unlinkTeam(teamId: string): number {
    const links = this.store.listTeam(teamId);
    const count = this.store.deleteTeam(teamId);
    void this.revokeLinks(links);
    return count;
  }

  private async revokeLinks(links: WhatapLink[]): Promise<void> {
    for (const link of links) await revokeTokensBestEffort(this.client, link);
  }

  /** 같은 사용자의 갱신이 이미 진행 중이면 그 결과를 같이 기다린다. 두 번 갱신하면
   *  먼저 끝난 쪽이 refresh token 을 회전시켜 다른 쪽이 invalid_grant 로 실패한다. */
  private refreshOnce(link: WhatapLink): Promise<string> {
    // Re-login may occur while the old exchange is still awaiting a response.
    const key = JSON.stringify([link.teamId, link.slackUserId, link.subject, link.accessToken, link.refreshToken]);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.refresh(link).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async refresh(link: WhatapLink): Promise<string> {
    if (!link.refreshToken) throw new LoginRequiredError();
    let tokens: TokenSet;
    try {
      tokens = await this.client.refresh(link.refreshToken);
    } catch (err) {
      // invalid_grant = refresh token 만료·회수(연결된 앱에서 끊음 등). 다시 로그인해야 한다.
      // 그 밖의 실패(네트워크, 5xx, invalid_client)는 연결을 지우지 않고 그대로 올린다.
      if (err instanceof OAuthError && err.code === "invalid_grant") {
        const replaced = this.replacedLink(link);
        if (replaced) return replaced.accessToken;
        this.store.delete(link.teamId, link.slackUserId);
        throw new LoginRequiredError("와탭 로그인이 만료됐어요");
      }
      throw err;
    }
    if (!this.store.get(link.teamId, link.slackUserId)) {
      void revokeTokensBestEffort(this.client, tokens);
      throw new LoginRequiredError();
    }
    // 갱신을 기다리는 사이 다시 로그인해 연결이 바뀌었으면 그 연결을 그대로 쓴다.
    const replaced = this.replacedLink(link);
    if (replaced) {
      if (tokens.refreshToken !== replaced.refreshToken) void revokeTokensBestEffort(this.client, tokens);
      return replaced.accessToken;
    }
    const updated: WhatapLink = {
      ...link,
      accessToken: tokens.accessToken,
      // rotation — 새 값이 오면 반드시 바꾼다. 안 오면 기존 값을 유지한다.
      refreshToken: tokens.refreshToken ?? link.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope ?? link.scope,
    };
    this.store.save(updated);
    return updated.accessToken;
  }

  /** 저장된 연결이 갱신을 시작한 연결과 다르면(재로그인) 그 연결을 돌려준다. */
  private replacedLink(link: WhatapLink): WhatapLink | null {
    const current = this.store.get(link.teamId, link.slackUserId);
    return current && (current.refreshToken !== link.refreshToken
      || current.accessToken !== link.accessToken || current.subject !== link.subject) ? current : null;
  }
}

export interface WhatapOAuthSettings {
  oauth: WhatapOAuthConfig;
  /** /oauth/start·/oauth/callback 을 받을 로컬 리슨 포트. */
  listenPort: number;
  listenHost: string;
}

const DEFAULT_SCOPE = "openid profile email whatap:read";
const OAUTH_ENV_KEYS = [
  "WHATAP_OAUTH_ISSUER",
  "WHATAP_OAUTH_CLIENT_ID",
  "WHATAP_OAUTH_CLIENT_SECRET",
  "WHATAP_OAUTH_REDIRECT_URI",
] as const;

/** 와탭 로그인 모드 설정. 네 값이 모두 없으면 null(기존 register/cookie 방식). 일부만 있거나
 *  함께 필요한 값이 빠졌으면 조용히 기존 방식으로 떨어지지 않도록 예외를 던진다. */
export function loadWhatapOAuthSettings(
  env: Record<string, string | undefined>,
): WhatapOAuthSettings | null {
  const present = OAUTH_ENV_KEYS.filter((k) => env[k]);
  if (present.length === 0) return null;
  const missing = OAUTH_ENV_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`와탭 로그인 설정이 일부만 있어요. 빠진 값: ${missing.join(", ")}`);
  }
  if (!env.SLACK_TOKENS_ENCRYPTION_KEY) {
    throw new Error("와탭 로그인 토큰을 저장하려면 SLACK_TOKENS_ENCRYPTION_KEY 가 필요해요");
  }
  if (!env.ARGUS_URL) {
    throw new Error("와탭 로그인 모드는 ARGUS_URL 이 필요해요");
  }
  const redirect = new URL(env.WHATAP_OAUTH_REDIRECT_URI as string);
  if (redirect.pathname !== "/oauth/callback") {
    throw new Error("WHATAP_OAUTH_REDIRECT_URI 의 경로는 /oauth/callback 이어야 해요");
  }
  const port = Number(env.WHATAP_OAUTH_PORT || redirect.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("콜백 주소에 포트가 없으면 WHATAP_OAUTH_PORT 로 리슨 포트를 정하세요");
  }
  return {
    oauth: {
      issuer: env.WHATAP_OAUTH_ISSUER as string,
      clientId: env.WHATAP_OAUTH_CLIENT_ID as string,
      clientSecret: env.WHATAP_OAUTH_CLIENT_SECRET as string,
      redirectUri: env.WHATAP_OAUTH_REDIRECT_URI as string,
      scope: env.WHATAP_OAUTH_SCOPE || DEFAULT_SCOPE,
    },
    listenPort: port,
    listenHost: env.WHATAP_OAUTH_LISTEN_HOST || "127.0.0.1",
  };
}

export type { WhatapLink };
