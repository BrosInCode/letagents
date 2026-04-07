import type { GitHubAppInstallation, GitHubAppRepository } from "./db.js";

export interface GitHubAppRoomIntegrationStatus {
  configured: boolean;
  install_url_available: boolean;
  setup_manifest_available: boolean;
  app_slug: string | null;
  setup_url: string | null;
  connected: boolean;
  repository: {
    github_repo_id: string;
    full_name: string;
    room_id: string;
    removed_at: string | null;
    installation_id: string;
    updated_at: string;
  } | null;
  installation: {
    installation_id: string;
    target_login: string;
    target_type: string;
    repository_selection: string;
    suspended_at: string | null;
    uninstalled_at: string | null;
    last_synced_at: string;
    permissions_json: string | null;
  } | null;
}

function normalizeRedirectPath(pathValue: string | null | undefined): string {
  const trimmed = pathValue?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/";
  }
  return trimmed;
}

export function buildGitHubAppInstallationUrl(input: {
  appSlug: string;
  state: string;
}): string {
  const url = new URL(`https://github.com/apps/${input.appSlug}/installations/new`);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function buildGitHubAppSetupRedirectPath(input: {
  redirectTo?: string | null;
  setupAction?: string | null;
  stateValid?: boolean;
}): string {
  const redirectTo = normalizeRedirectPath(input.redirectTo);
  const url = new URL(redirectTo, "http://localhost");
  url.searchParams.set("github_app_setup", input.setupAction?.trim() || "complete");
  if (input.stateValid === false) {
    url.searchParams.set("github_app_state", "invalid");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function resolveGitHubAppRoomIntegrationStatus(input: {
  configured: boolean;
  appSlug?: string | null;
  setupUrl?: string | null;
  repository?: GitHubAppRepository | null;
  installation?: GitHubAppInstallation | null;
}): GitHubAppRoomIntegrationStatus {
  const repository = input.repository ?? null;
  const installation = input.installation ?? null;
  const connected = Boolean(
    repository &&
      installation &&
      !repository.removed_at &&
      !installation.suspended_at &&
      !installation.uninstalled_at
  );

  return {
    configured: input.configured,
    install_url_available: Boolean(input.configured && input.appSlug),
    setup_manifest_available: !input.configured,
    app_slug: input.appSlug?.trim() || null,
    setup_url: input.setupUrl?.trim() || null,
    connected,
    repository: repository
      ? {
          github_repo_id: repository.github_repo_id,
          full_name: repository.full_name,
          room_id: repository.room_id,
          removed_at: repository.removed_at,
          installation_id: repository.installation_id,
          updated_at: repository.updated_at,
        }
      : null,
    installation: installation
      ? {
          installation_id: installation.installation_id,
          target_login: installation.target_login,
          target_type: installation.target_type,
          repository_selection: installation.repository_selection,
          suspended_at: installation.suspended_at,
          uninstalled_at: installation.uninstalled_at,
          last_synced_at: installation.last_synced_at,
          permissions_json: installation.permissions_json,
        }
      : null,
  };
}
