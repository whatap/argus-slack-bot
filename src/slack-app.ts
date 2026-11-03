// Slack transport selection. The same handlers run over Socket Mode or signed HTTP.
import bolt from "@slack/bolt";
import type { AppOptions } from "@slack/bolt";

export const SLACK_BOT_SCOPES = ["app_mentions:read", "chat:write", "im:history"];

export interface SlackSettings {
  transport: "socket" | "http";
  multiWorkspace: boolean;
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  clientId?: string;
  clientSecret?: string;
  stateSecret?: string;
  publicUrl?: string;
  appId: string;
  port: number;
  listenHost: string;
}

export function loadSlackSettings(env: Record<string, string | undefined>): SlackSettings {
  const transport = env.SLACK_TRANSPORT || "socket";
  if (transport !== "http" && transport !== "socket") {
    throw new Error("SLACK_TRANSPORT 는 socket 또는 http 이어야 해요");
  }
  if (transport === "http" && !env.SLACK_SIGNING_SECRET) {
    throw new Error("HTTP 수신에는 SLACK_SIGNING_SECRET 이 필요해요");
  }
  if (transport === "socket" && !env.SLACK_APP_TOKEN) {
    throw new Error("Socket Mode 에는 SLACK_APP_TOKEN 이 필요해요");
  }
  const multiWorkspace = !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET &&
    env.SLACK_STATE_SECRET && env.SLACK_SIGNING_SECRET);
  if (transport === "http" && !multiWorkspace &&
      [env.SLACK_CLIENT_ID, env.SLACK_CLIENT_SECRET, env.SLACK_STATE_SECRET].some(Boolean)) {
    throw new Error("Slack OAuth 설정이 일부만 있어요: CLIENT_ID, CLIENT_SECRET, STATE_SECRET 을 모두 설정하세요");
  }
  if (transport === "http" && multiWorkspace) {
    if (!env.SLACK_TOKENS_ENCRYPTION_KEY) {
      throw new Error("공개 설치 토큰 저장에는 SLACK_TOKENS_ENCRYPTION_KEY 가 필요해요");
    }
    if (!env.SLACK_PUBLIC_URL) {
      throw new Error("공개 HTTP 설치에는 SLACK_PUBLIC_URL 이 필요해요");
    }
  }
  if (!multiWorkspace && !env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN 이 필요해요");
  }
  let publicUrl: string | undefined;
  if (env.SLACK_PUBLIC_URL) {
    let url: URL;
    try { url = new URL(env.SLACK_PUBLIC_URL); } catch {
      throw new Error("SLACK_PUBLIC_URL 은 올바른 HTTPS origin 이어야 해요");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("SLACK_PUBLIC_URL 은 경로·query·자격증명 없는 HTTPS origin 이어야 해요");
    }
    publicUrl = url.origin;
  }
  const port = Number(env.SLACK_HTTP_PORT || env.SLACK_OAUTH_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SLACK_HTTP_PORT (또는 SLACK_OAUTH_PORT) 는 1~65535 정수여야 해요");
  }
  return {
    transport,
    multiWorkspace,
    botToken: env.SLACK_BOT_TOKEN ?? "",
    appToken: env.SLACK_APP_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    stateSecret: env.SLACK_STATE_SECRET,
    publicUrl,
    appId: env.SLACK_APP_ID || "A0AFUKNJ5SS",
    port,
    listenHost: env.SLACK_LISTEN_HOST || "127.0.0.1",
  };
}

type SlackAppDeps = Pick<AppOptions, "clientOptions" | "customRoutes" | "installationStore" | "logLevel">;

export function slackAppOptions(
  settings: SlackSettings,
  deps: SlackAppDeps = {},
): AppOptions {
  if (settings.multiWorkspace && !deps.installationStore) {
    throw new Error("multi-workspace 모드에는 영속 installationStore 가 필요해요");
  }
  const slackReturnUrl = (teamId?: string) => {
    const url = new URL("https://slack.com/app_redirect");
    url.searchParams.set("app", settings.appId);
    if (teamId) url.searchParams.set("team", teamId);
    return url.toString();
  };
  return {
    ...(settings.multiWorkspace ? {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      stateSecret: settings.stateSecret,
      signingSecret: settings.signingSecret,
      installationStore: deps.installationStore,
      scopes: [...SLACK_BOT_SCOPES],
      redirectUri: settings.publicUrl ? `${settings.publicUrl}/slack/oauth_redirect` : undefined,
      installerOptions: {
        port: settings.port,
        installPath: "/slack/install",
        redirectUriPath: "/slack/oauth_redirect",
        directInstall: true,
        stateVerification: true,
        callbackOptions: {
          success: (installation, _options, _req, res) => {
            res.writeHead(302, { Location: slackReturnUrl(installation.team?.id) });
            res.end();
          },
          failure: (_error, _options, _req, res) => {
            res.writeHead(302, { Location: slackReturnUrl() });
            res.end();
          },
        },
      },
    } : { token: settings.botToken }),
    socketMode: settings.transport === "socket",
    ...(settings.transport === "socket" ? { appToken: settings.appToken } : {
      signingSecret: settings.signingSecret,
      endpoints: "/slack/events",
      port: settings.port,
      signatureVerification: true,
      processBeforeResponse: false,
    }),
    clientOptions: deps.clientOptions,
    customRoutes: deps.customRoutes,
    logLevel: deps.logLevel ?? bolt.LogLevel.INFO,
  };
}

export function createSlackApp(settings: SlackSettings, deps: SlackAppDeps = {}) {
  return new bolt.App(slackAppOptions(settings, deps));
}
