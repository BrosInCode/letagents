import {
  buildGitHubRepoRoomId,
  getGitHubInstallationTarget,
  getGitHubRepositoryOwnerLogin,
  type GitHubWebhookPayload,
  type GitHubWebhookRepository,
} from "./github-app.js";

export interface GitHubAppInstallationSyncInput {
  installation_id: string;
  target_type: string;
  target_login: string;
  target_github_id: string;
  repository_selection: string;
  permissions?: Record<string, string> | null;
  suspended_at?: string | null;
  uninstalled_at?: string | null;
}

export interface GitHubAppRepositorySyncInput {
  github_repo_id: string;
  installation_id: string;
  owner_login: string;
  repo_name: string;
}

export interface GitHubRepositoryLinkSyncInput {
  github_repo_id: string;
  room_id: string;
  owner_login: string;
  repo_name: string;
}

export interface GitHubAppSyncDeps {
  getGitHubAppRepositoryByFullName(
    fullName: string
  ): Promise<{ installation_id: string } | null | undefined>;
  upsertGitHubAppInstallation(input: GitHubAppInstallationSyncInput): Promise<unknown>;
  upsertGitHubAppRepository(input: GitHubAppRepositorySyncInput): Promise<unknown>;
  upsertGitHubRepositoryLink(input: GitHubRepositoryLinkSyncInput): Promise<unknown>;
}

export interface GitHubAppRepositorySyncResult {
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}

export function toGitHubWebhookId(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

export function createGitHubAppSync(deps: GitHubAppSyncDeps) {
  async function syncGitHubAppInstallationFromPayload(
    payload: GitHubWebhookPayload,
    options?: {
      suspended_at?: string | null;
      uninstalled_at?: string | null;
    }
  ): Promise<string | null> {
    const installationId = toGitHubWebhookId(payload.installation?.id);
    if (!installationId) {
      return null;
    }

    const target = getGitHubInstallationTarget(payload);
    if (!target?.login) {
      return installationId;
    }

    await deps.upsertGitHubAppInstallation({
      installation_id: installationId,
      target_type: payload.installation?.target_type ?? target.type ?? "Account",
      target_login: target.login,
      target_github_id: toGitHubWebhookId(target.id) ?? installationId,
      repository_selection: payload.installation?.repository_selection ?? "selected",
      permissions: payload.installation?.permissions,
      suspended_at: options?.suspended_at,
      uninstalled_at: options?.uninstalled_at,
    });

    return installationId;
  }

  async function syncGitHubAppRepositoryFromPayload(
    repository: GitHubWebhookRepository | undefined,
    installationId: string | null
  ): Promise<GitHubAppRepositorySyncResult> {
    if (!repository) {
      return {
        installationId,
        githubRepoId: null,
        roomId: null,
      };
    }

    const githubRepoId = toGitHubWebhookId(repository.id);
    const roomId = buildGitHubRepoRoomId(repository.full_name);
    const ownerLogin = getGitHubRepositoryOwnerLogin(repository);
    let resolvedInstallationId = installationId;

    if (!resolvedInstallationId) {
      resolvedInstallationId =
        (await deps.getGitHubAppRepositoryByFullName(repository.full_name))?.installation_id ??
        null;
    }

    if (resolvedInstallationId && githubRepoId && ownerLogin && repository.name) {
      await deps.upsertGitHubAppRepository({
        github_repo_id: githubRepoId,
        installation_id: resolvedInstallationId,
        owner_login: ownerLogin,
        repo_name: repository.name,
      });

      await deps.upsertGitHubRepositoryLink({
        github_repo_id: githubRepoId,
        room_id: roomId,
        owner_login: ownerLogin,
        repo_name: repository.name,
      });
    }

    return {
      installationId: resolvedInstallationId,
      githubRepoId,
      roomId,
    };
  }

  return {
    syncGitHubAppInstallationFromPayload,
    syncGitHubAppRepositoryFromPayload,
  };
}
