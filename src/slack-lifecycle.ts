// Bolt skips authorize for these lifecycle events. Only wire these listeners behind
// Bolt's verified Slack ingress; workspace identity comes from the signed envelope.
import type { SqliteInstallationStore } from "./installations.js";
import type { WhatapLinkStore } from "./whatap-links.js";
import type { PendingLogins } from "./oauth-http.js";
import type { WhatapTokenManager } from "./whatap-oauth.js";

export interface SlackLifecycleDeps {
  installationStore?: SqliteInstallationStore | null;
  whatap?: { store: WhatapLinkStore; pending: PendingLogins; manager: WhatapTokenManager } | null;
  /** Current verified identity for token-based single-workspace mode, not event.authorizations. */
  singleWorkspace?: { teamId: string; botUserId: string; installedAt?: number };
  onWorkspaceDeleted?: (teamId: string) => void;
}

export interface SlackLifecycleArgs {
  body: { team_id?: string; event_time?: number };
  event: { type: string; event_ts?: string; tokens?: { oauth?: string[]; bot?: string[] } };
  context?: { teamId?: string; botUserId?: string };
}

export function createSlackLifecycleHandlers(deps: SlackLifecycleDeps) {
  async function deleteWorkspace(teamId: string): Promise<void> {
    // Do not await any remote work before deleting all local state.
    deps.whatap?.pending.revokeTeam(teamId);
    deps.whatap?.manager.unlinkTeam(teamId);
    const deletion = deps.installationStore?.deleteInstallation({ teamId, enterpriseId: undefined, isEnterpriseInstall: false });
    deps.onWorkspaceDeleted?.(teamId);
    await deletion;
  }
  async function appUninstalled({ body, event }: SlackLifecycleArgs): Promise<void> {
    const teamId = requireTeam(body);
    if (deps.singleWorkspace && deps.singleWorkspace.teamId !== teamId) return;
    const identity = deps.installationStore ? deps.installationStore.getBotIdentity(teamId) : deps.singleWorkspace;
    if (isStale(body, event, identity?.installedAt)) return;
    await deleteWorkspace(teamId);
  }

  async function tokensRevoked({ body, event, context }: SlackLifecycleArgs): Promise<void> {
    const teamId = requireTeam(body);
    if (deps.singleWorkspace && deps.singleWorkspace.teamId !== teamId) return;
    const identity = deps.installationStore
      ? deps.installationStore.getBotIdentity(teamId)
      : deps.singleWorkspace ?? (context?.teamId === teamId ? { botUserId: context.botUserId, installedAt: undefined } : undefined);
    if (isStale(body, event, identity?.installedAt)) return;
    // Slack sends bot USER ids here, not bot ids, bearer tokens or OAuth user ids.
    if (!identity?.botUserId || !event.tokens?.bot?.includes(identity.botUserId)) return;
    await deleteWorkspace(teamId);
  }
  return { appUninstalled, tokensRevoked };
}

function requireTeam(body: SlackLifecycleArgs["body"]): string {
  const teamId = body.team_id;
  if (typeof teamId !== "string" || !teamId.trim()) throw new Error("Slack lifecycle: team_id is required");
  return teamId;
}

function isStale(body: SlackLifecycleArgs["body"], event: SlackLifecycleArgs["event"], installedAt?: number): boolean {
  const seconds = Number(event.event_ts ?? body.event_time);
  // Slack's envelope time is second-granular. Same-second reinstall races cannot
  // be distinguished; timestamps missing from old payloads remain supported.
  return installedAt !== undefined && Number.isFinite(seconds)
    && Math.floor(seconds) < Math.floor(installedAt / 1000);
}
