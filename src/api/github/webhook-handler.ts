import {
  getGitHubAppRepositoryByFullName,
  getSupervisorGrantOwnerAccount,
  getSupervisorHostGrantById,
  getProjectById,
  listSupervisorGrantAuthoritiesForRepository,
  markGitHubAppInstallationUninstalled,
  markGitHubAppRepositoryRemoved,
  migrateGitHubRepositoryCanonicalRoom,
  revokeSupervisorGrantAuthority,
  revokeSupervisorGrantsForGitHubInstallationAccessChange,
  revokeSupervisorGrantsForRepositoryAccessChange,
  setGitHubAppInstallationSuspended,
  upsertGitHubAppInstallation,
  upsertGitHubAppRepository,
  upsertGitHubRepositoryLink,
  type GitHubWebhookDeliveryStatus,
  type Project,
} from "../db.js";
import {
  buildGitHubRepoRoomId,
  getGitHubRepositoryOwnerLogin,
  type GitHubWebhookPayload,
} from "./app.js";
import {
  clearGitHubRepoAccessCacheForLogin,
  clearGitHubRepoAccessCacheForRoom,
  resolveGitHubRepoRoomAccessDecision,
} from "./repo-access.js";
import {
  createGitHubAppSync,
  toGitHubWebhookId,
} from "./app-sync.js";
import { clearGitHubInstallationTokenCache } from "./app-client.js";
import { getExistingGitHubEventRefRoom } from "./git-room-routing.js";
import { materializeGitHubWebhookEvent } from "./room-events.js";
import {
  handleMaterializedGitHubRoomEvent,
  persistMaterializedGitHubRoomEvent,
} from "./room-event-projection.js";

const {
  syncGitHubAppInstallationFromPayload,
  syncGitHubAppRepositoryFromPayload,
} = createGitHubAppSync({
  getGitHubAppRepositoryByFullName,
  upsertGitHubAppInstallation,
  upsertGitHubAppRepository,
  upsertGitHubRepositoryLink,
});

interface GitHubWebhookProcessingOptions {
  retryFailedDelivery?: boolean;
}

export interface SupervisorAccessRevocationTarget {
  repository_full_name: string;
  canonical_room_id: string;
  owner_login: string | null;
}

interface SupervisorGrantRevalidationDeps {
  listAuthorities: typeof listSupervisorGrantAuthoritiesForRepository;
  getGrant: typeof getSupervisorHostGrantById;
  getOwner: typeof getSupervisorGrantOwnerAccount;
  resolveAccess: typeof resolveGitHubRepoRoomAccessDecision;
  revokeAuthority: typeof revokeSupervisorGrantAuthority;
}

export async function revalidateSupervisorGrantsForRepositoryAccessChange(
  target: SupervisorAccessRevocationTarget,
  deps: SupervisorGrantRevalidationDeps = {
    listAuthorities: listSupervisorGrantAuthoritiesForRepository,
    getGrant: getSupervisorHostGrantById,
    getOwner: getSupervisorGrantOwnerAccount,
    resolveAccess: resolveGitHubRepoRoomAccessDecision,
    revokeAuthority: revokeSupervisorGrantAuthority,
  },
): Promise<void> {
  const authorities = await deps.listAuthorities(target);
  let indeterminate = false;
  for (const authority of authorities) {
    const grant = await deps.getGrant(authority.grant_id);
    if (!grant) continue;
    // Redelivery must finish teardown after a crash between grant revocation
    // and worker-session cleanup; no provider check is needed once revoked.
    if (grant.revoked_at) {
      await deps.revokeAuthority(authority);
      continue;
    }
    const owner = await deps.getOwner(grant.owner_account_id);
    if (!owner?.provider_access_token) {
      indeterminate = true;
      continue;
    }
    try {
      const decision = await deps.resolveAccess({
        roomName: target.canonical_room_id,
        sessionAccount: owner,
        freshCollaboratorCheck: true,
        throwOnIndeterminate: true,
      });
      if (decision.kind !== "allow") {
        await deps.revokeAuthority(authority);
      }
    } catch {
      indeterminate = true;
    }
  }
  if (indeterminate) {
    throw new Error("Supervisor grant access revalidation was indeterminate; retry webhook delivery.");
  }
}

/** Only definitive GitHub authorization-boundary events revoke live grants. */
export function getSupervisorAccessRevocationTarget(
  eventName: string,
  payload: GitHubWebhookPayload,
): SupervisorAccessRevocationTarget | null {
  const repositoryFullName = payload.repository?.full_name?.trim();
  if (!repositoryFullName) return null;
  if (eventName === "repository" && payload.action === "privatized") {
    return {
      repository_full_name: repositoryFullName,
      canonical_room_id: buildGitHubRepoRoomId(repositoryFullName),
      owner_login: null,
    };
  }
  const memberLogin = payload.member?.login?.trim();
  if (
    eventName === "member"
    && payload.action === "removed"
    && memberLogin
    && payload.repository?.private !== false
  ) {
    return {
      repository_full_name: repositoryFullName,
      canonical_room_id: buildGitHubRepoRoomId(repositoryFullName),
      owner_login: memberLogin,
    };
  }
  return null;
}

function clearRepoAccessCacheForWebhookPayload(payload: GitHubWebhookPayload): void {
  if (payload.repository?.full_name) {
    clearGitHubRepoAccessCacheForRoom(buildGitHubRepoRoomId(payload.repository.full_name));
  }
  const memberLogin = payload.member?.login;
  if (typeof memberLogin === "string" && memberLogin.trim()) {
    clearGitHubRepoAccessCacheForLogin(memberLogin);
  }
  const senderLogin = payload.sender?.login;
  if (typeof senderLogin === "string" && senderLogin.trim()) {
    clearGitHubRepoAccessCacheForLogin(senderLogin);
  }
}

async function emitGitHubPullRequestEvent(
  project: Project,
  payload: GitHubWebhookPayload,
  deliveryId: string,
  options: GitHubWebhookProcessingOptions = {}
): Promise<{
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  const installationId =
    (await syncGitHubAppInstallationFromPayload(payload)) ??
    toGitHubWebhookId(payload.installation?.id);
  const repositorySync = await syncGitHubAppRepositoryFromPayload(payload.repository, installationId);
  const roomId = repositorySync.roomId ?? project.id;

  if (!payload.repository || !payload.pull_request || !payload.action) {
    return {
      status: "ignored",
      installationId: repositorySync.installationId,
      githubRepoId: repositorySync.githubRepoId,
      roomId,
    };
  }

  const materializedEvent = materializeGitHubWebhookEvent("pull_request", payload, deliveryId);
  if (!materializedEvent) {
    return {
      status: "ignored",
      installationId: repositorySync.installationId,
      githubRepoId: repositorySync.githubRepoId,
      roomId,
    };
  }

  const eventProject = await getExistingGitHubEventRefRoom({
    event: materializedEvent,
    payload,
    repository: payload.repository,
    githubRepoId: repositorySync.githubRepoId,
  });

  return handleMaterializedGitHubRoomEvent(project, materializedEvent, {
    deliveryId,
    installationId: repositorySync.installationId,
    githubRepoId: repositorySync.githubRepoId,
    eventProject,
    retryFailedDelivery: options.retryFailedDelivery,
  });
}

async function handleMaterializedRepoRoomWebhook(
  eventName: string,
  payload: GitHubWebhookPayload,
  deliveryId: string,
  input: {
    installationId: string | null;
    githubRepoId: string | null;
    roomId: string | null;
  },
  options: GitHubWebhookProcessingOptions = {}
): Promise<{
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  const materializedEvent = materializeGitHubWebhookEvent(eventName, payload, deliveryId);
  if (!materializedEvent) {
    return {
      status: "ignored",
      installationId: input.installationId,
      githubRepoId: input.githubRepoId,
      roomId: input.roomId,
    };
  }

  const project = await getProjectById(input.roomId ?? "");
  if (!project) {
    return {
      status: "ignored",
      installationId: input.installationId,
      githubRepoId: input.githubRepoId,
      roomId: input.roomId,
    };
  }

  const eventProject = await getExistingGitHubEventRefRoom({
    event: materializedEvent,
    payload,
    repository: payload.repository,
    githubRepoId: input.githubRepoId,
  });

  return handleMaterializedGitHubRoomEvent(project, materializedEvent, {
    deliveryId,
    installationId: input.installationId,
    githubRepoId: input.githubRepoId,
    eventProject,
    retryFailedDelivery: options.retryFailedDelivery,
  });
}

export async function handleGitHubWebhookEvent(
  eventName: string,
  payload: GitHubWebhookPayload,
  deliveryId: string,
  options: GitHubWebhookProcessingOptions = {}
): Promise<{
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  const installationId = toGitHubWebhookId(payload.installation?.id);
  const githubRepoId = toGitHubWebhookId(payload.repository?.id);
  const roomId = payload.repository?.full_name
    ? buildGitHubRepoRoomId(payload.repository.full_name)
    : null;

  if (
    installationId
    && (eventName === "installation" || eventName === "installation_repositories")
  ) {
    clearGitHubInstallationTokenCache(installationId);
  }

  if (
    eventName === "member"
    || eventName === "membership"
    || eventName === "repository"
    || eventName === "installation"
    || eventName === "installation_repositories"
  ) {
    clearRepoAccessCacheForWebhookPayload(payload);
  }

  const accessRevocationTarget = getSupervisorAccessRevocationTarget(eventName, payload);
  if (accessRevocationTarget) {
    await revalidateSupervisorGrantsForRepositoryAccessChange(accessRevocationTarget);
  }

  if (eventName === "ping") {
    return {
      status: "processed",
      installationId,
      githubRepoId,
      roomId,
    };
  }

  switch (eventName) {
    case "member":
      return {
        status: accessRevocationTarget ? "processed" : "ignored",
        installationId,
        githubRepoId,
        roomId,
      };

    case "installation": {
      if (!installationId || !payload.action) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const materializedEvent = materializeGitHubWebhookEvent(eventName, payload, deliveryId);
      const now = new Date().toISOString();
      if (payload.action === "deleted") {
        await markGitHubAppInstallationUninstalled(installationId, now);
        await revokeSupervisorGrantsForGitHubInstallationAccessChange({
          installation_id: installationId,
          repositories: (payload.repositories ?? []).map((repository) => ({
            full_name: repository.full_name,
          })),
        });
        if (materializedEvent) {
          await persistMaterializedGitHubRoomEvent(materializedEvent, {
            deliveryId,
          });
        }
        return {
          status: "processed",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      if (payload.action === "suspend") {
        const syncedInstallationId = await syncGitHubAppInstallationFromPayload(payload, {
          suspended_at: now,
          uninstalled_at: null,
        });
        if (!payload.installation?.account) {
          await setGitHubAppInstallationSuspended(installationId, now);
        }
        await revokeSupervisorGrantsForGitHubInstallationAccessChange({
          installation_id: installationId,
          repositories: (payload.repositories ?? []).map((repository) => ({
            full_name: repository.full_name,
          })),
        });
        if (materializedEvent) {
          await persistMaterializedGitHubRoomEvent(materializedEvent, {
            deliveryId,
          });
        }
        return {
          status: "processed",
          installationId: syncedInstallationId ?? installationId,
          githubRepoId,
          roomId,
        };
      }

      if (payload.action === "unsuspend") {
        const syncedInstallationId = await syncGitHubAppInstallationFromPayload(payload, {
          suspended_at: null,
          uninstalled_at: null,
        });
        if (!payload.installation?.account) {
          await setGitHubAppInstallationSuspended(installationId, null);
        }
        if (syncedInstallationId && materializedEvent) {
          await persistMaterializedGitHubRoomEvent(materializedEvent, {
            deliveryId,
          });
        }
        return {
          status: syncedInstallationId ? "processed" : "ignored",
          installationId: syncedInstallationId ?? installationId,
          githubRepoId,
          roomId,
        };
      }

      const syncedInstallationId = await syncGitHubAppInstallationFromPayload(payload, {
        suspended_at: null,
        uninstalled_at: null,
      });
      if (syncedInstallationId && materializedEvent) {
        await persistMaterializedGitHubRoomEvent(materializedEvent, {
          deliveryId,
        });
      }
      return {
        status: syncedInstallationId ? "processed" : "ignored",
        installationId: syncedInstallationId ?? installationId,
        githubRepoId,
        roomId,
      };
    }

    case "installation_repositories": {
      if (!installationId) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const syncedInstallationId =
        (await syncGitHubAppInstallationFromPayload(payload, {
          suspended_at: null,
          uninstalled_at: null,
        })) ?? installationId;

      for (const repository of payload.repositories_added ?? []) {
        await syncGitHubAppRepositoryFromPayload(repository, syncedInstallationId);
      }

      for (const repository of payload.repositories_removed ?? []) {
        const repositoryId = toGitHubWebhookId(repository.id);
        if (!repositoryId) {
          continue;
        }

        await markGitHubAppRepositoryRemoved(repositoryId);
        await revokeSupervisorGrantsForRepositoryAccessChange({
          repository_full_name: repository.full_name,
          canonical_room_id: buildGitHubRepoRoomId(repository.full_name),
        });
      }

      const materializedEvent = materializeGitHubWebhookEvent(eventName, payload, deliveryId);
      if (materializedEvent) {
        await persistMaterializedGitHubRoomEvent(materializedEvent, {
          deliveryId,
        });
      }

      return {
        status: "processed",
        installationId: syncedInstallationId,
        githubRepoId,
        roomId,
      };
    }

    case "pull_request": {
      if (!payload.repository) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const project = await getProjectById(roomId ?? "");
      if (!project) {
        const repositorySync = await syncGitHubAppRepositoryFromPayload(
          payload.repository,
          (await syncGitHubAppInstallationFromPayload(payload)) ?? installationId
        );
        return {
          status: "ignored",
          installationId: repositorySync.installationId,
          githubRepoId: repositorySync.githubRepoId,
          roomId: repositorySync.roomId,
        };
      }

      return emitGitHubPullRequestEvent(project, payload, deliveryId, options);
    }

    case "repository": {
      if (!payload.repository || !payload.action) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const syncedInstallationId =
        (await syncGitHubAppInstallationFromPayload(payload)) ?? installationId;

      if (payload.action === "renamed" || payload.action === "transferred") {
        const currentOwner = getGitHubRepositoryOwnerLogin(payload.repository);
        const currentName = payload.repository.name;
        const repoId = toGitHubWebhookId(payload.repository.id);

        let oldFullName: string | null = null;
        if (payload.action === "renamed" && payload.changes?.repository?.name?.from) {
          const oldName = payload.changes.repository.name.from;
          oldFullName = `${currentOwner}/${oldName}`;
        } else if (payload.action === "transferred" && payload.changes?.owner?.from?.login) {
          const oldOwner = payload.changes.owner.from.login;
          oldFullName = `${oldOwner}/${currentName}`;
        }

        let migratedRoom = null;
        if (repoId) {
          migratedRoom = await migrateGitHubRepositoryCanonicalRoom({
            github_repo_id: repoId,
            owner_login: currentOwner,
            repo_name: currentName,
          });
        }

        const repositorySync = await syncGitHubAppRepositoryFromPayload(
          payload.repository,
          syncedInstallationId
        );

        const repositoryEvent = materializeGitHubWebhookEvent("repository", payload, deliveryId);
        const fallbackRoom =
          migratedRoom ??
          (repositorySync.roomId ? await getProjectById(repositorySync.roomId) : null) ??
          (oldFullName ? await getProjectById(buildGitHubRepoRoomId(oldFullName)) : null);
        if (fallbackRoom && repositoryEvent) {
          await handleMaterializedGitHubRoomEvent(fallbackRoom, repositoryEvent, {
            deliveryId,
            installationId: syncedInstallationId,
            githubRepoId: repositorySync.githubRepoId,
            retryFailedDelivery: options.retryFailedDelivery,
          });
        }

        return {
          status: "processed",
          installationId: syncedInstallationId,
          githubRepoId: repositorySync.githubRepoId,
          roomId: repositorySync.roomId,
        };
      }

      const repositorySync = await syncGitHubAppRepositoryFromPayload(
        payload.repository,
        syncedInstallationId
      );

      return {
        status: accessRevocationTarget ? "processed" : "ignored",
        installationId: syncedInstallationId,
        githubRepoId: repositorySync.githubRepoId,
        roomId: repositorySync.roomId,
      };
    }

    case "issues":
    case "issue_comment":
    case "pull_request_review":
    case "check_run":
    case "push":
    case "create":
    case "delete":
      return handleMaterializedRepoRoomWebhook(eventName, payload, deliveryId, {
        installationId,
        githubRepoId,
        roomId,
      }, options);

    default:
      return {
        status: "ignored",
        installationId,
        githubRepoId,
        roomId,
      };
  }
}
