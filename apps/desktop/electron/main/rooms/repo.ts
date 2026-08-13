import electron from "electron";
import { basename } from "node:path";
import type {
  DesktopGitHubIntegrationActionResult,
  DesktopGitHubIntegrationStatus,
  DesktopRepoRoomSelection,
  DesktopRepoWorktreeResult,
  DesktopRoomInfo,
  DesktopProjectBindingContext,
  DesktopProjectConnectionResult,
} from "../../ipc-types.js";
import { buildRepoStatus, resolveRoomIdentifierFromPath } from "../../repo-status.js";
import { projectContextsCompatibleForConnection } from "../../project-bindings.js";
import { ensureRepoWorktree } from "./worktrees.js";
import { apiFetch } from "../auth.js";
import { openAllowedExternalUrl } from "../external-url.js";
import { isDesktopSmokeCheck } from "../smoke.js";
import { focusMainWindow } from "../window.js";
import {
  bindProjectRoot,
} from "../project-bindings-store.js";
import { fetchRoomSnapshot } from "./snapshot.js";
import {
  cloudRoomIdentifierForStorage,
  createLocalRoom,
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
  setLocalAwareRoomStorageMode,
  updateLocalRoomDisplayName,
} from "./local-store.js";
import {
  mapDesktopRoomInfoPayload,
  rememberJoinedRoomInfo,
  type RoomInfoPayload,
} from "./room-info.js";

const { dialog } = electron as typeof import("electron");

export async function pickRepoRoom(): Promise<DesktopRepoRoomSelection> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a repository",
    buttonLabel: "Open",
    properties: ["openDirectory"],
  };
  focusMainWindow();
  const result = await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) {
    return {
      canceled: true,
      repoPath: null,
      repoStatus: null,
      roomIdentifier: null,
      source: null,
      snapshot: null,
      error: null,
      warning: null,
      projectBinding: null,
    };
  }

  return openRepoRoomFromPath(result.filePaths[0]);
}

export async function openRepoRoomFromPath(
  folderPath: string,
): Promise<DesktopRepoRoomSelection> {
  const selectedPath = folderPath.trim();
  if (!selectedPath) {
    return {
      canceled: false,
      repoPath: null,
      repoStatus: null,
      roomIdentifier: null,
      source: null,
      snapshot: null,
      error: "Choose a project folder.",
      warning: null,
      projectBinding: null,
    };
  }

  const resolved = await resolveRoomIdentifierFromPath(selectedPath);
  const repoPath = resolved.repoRoot || selectedPath;
  const isLocalProjectRoom = resolved.source === "local_git" || resolved.source === "local_folder";

  if (isLocalProjectRoom) {
    await createLocalRoom({
      roomIdentifier: resolved.roomIdentifier,
      displayName: basename(repoPath),
      gitRoom: resolved.gitRoom,
    });
    await setLocalAwareRoomStorageMode(resolved.roomIdentifier, "local");
  } else {
    const storage = await resolveLocalAwareRoomStorageMode(resolved.roomIdentifier);
    if (storage.effectiveMode === "local") {
      await createLocalRoom({
        roomIdentifier: resolved.roomIdentifier,
        displayName: basename(repoPath),
        gitRoom: resolved.gitRoom,
      });
    }
  }

  const snapshot = await fetchRoomSnapshot(resolved.roomIdentifier);
  const selectedRepoStatus = await buildRepoStatus(repoPath);
  const projectBinding = await bindProjectRoot({
    context: {
      roomIdentifier: snapshot.roomIdentifier || resolved.roomIdentifier,
      gitRoom: snapshot.room?.gitRoom || resolved.gitRoom,
    },
    rootPath: selectedRepoStatus.isGitRepo
      ? selectedRepoStatus.mainRootPath || selectedRepoStatus.rootPath
      : repoPath,
    source: resolved.source || "local_folder",
  });

  return {
    canceled: false,
    repoPath: projectBinding.rootPath,
    repoStatus: selectedRepoStatus,
    roomIdentifier: resolved.roomIdentifier,
    source: resolved.source,
    snapshot,
    error: null,
    warning: resolved.warning,
    projectBinding,
  };
}

/** Connect the current room to a folder without turning folder choice into navigation. */
export async function connectProjectToRoom(
  context: DesktopProjectBindingContext,
): Promise<DesktopProjectConnectionResult> {
  focusMainWindow();
  const result = await dialog.showOpenDialog({
    title: "Connect this room to a project",
    buttonLabel: "Connect project",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, binding: null, repoStatus: null, error: null };
  }
  try {
    const resolved = await resolveRoomIdentifierFromPath(result.filePaths[0]);
    const resolvedContext: DesktopProjectBindingContext = {
      roomIdentifier: resolved.roomIdentifier,
      gitRoom: resolved.gitRoom,
    };
    if (!projectContextsCompatibleForConnection(
      context,
      resolvedContext,
      resolved.source || "local_folder",
    )) {
      return {
        canceled: false,
        binding: null,
        repoStatus: null,
        error: "That folder belongs to a different project room.",
      };
    }
    const selectedRepoStatus = await buildRepoStatus(resolved.repoRoot || result.filePaths[0]);
    const rootPath = selectedRepoStatus.isGitRepo
      ? selectedRepoStatus.mainRootPath || selectedRepoStatus.rootPath
      : result.filePaths[0];
    const binding = await bindProjectRoot({
      context: {
        roomIdentifier: context.roomIdentifier || resolved.roomIdentifier,
        gitRoom: context.gitRoom || resolved.gitRoom,
      },
      rootPath,
      source: resolved.source || "local_folder",
    });
    return {
      canceled: false,
      binding,
      repoStatus: selectedRepoStatus,
      error: null,
    };
  } catch (error) {
    return {
      canceled: false,
      binding: null,
      repoStatus: null,
      error: error instanceof Error ? error.message : "LetAgents could not connect that project.",
    };
  }
}

export async function createRepoRoomWorktree(
  repoRoot: string,
  branch: string,
): Promise<DesktopRepoWorktreeResult> {
  const trimmedRoot = repoRoot.trim();
  const trimmedBranch = branch.trim();
  if (!trimmedRoot) {
    return { worktreePath: null, branch: null, error: "Open a repository before creating a worktree." };
  }
  if (!trimmedBranch) {
    return { worktreePath: null, branch: null, error: "Choose a branch for the worktree." };
  }
  try {
    const ensured = await ensureRepoWorktree({ repoRoot: trimmedRoot, branch: trimmedBranch });
    return { worktreePath: ensured.worktreePath, branch: trimmedBranch, error: null };
  } catch (error) {
    return {
      worktreePath: null,
      branch: trimmedBranch,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function renameDesktopRoom(
  roomIdentifier: string,
  displayName: string,
): Promise<DesktopRoomInfo> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedDisplayName = displayName.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before renaming it.");
  }
  if (!trimmedDisplayName) {
    throw new Error("Enter a room name.");
  }

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoom = await updateLocalRoomDisplayName(
      localRoomIdentifierForStorage(storage, trimmedRoomIdentifier),
      trimmedDisplayName,
    );
    const payload: RoomInfoPayload = {
      room_id: localRoom.roomIdentifier,
      code: "",
      name: localRoom.displayName,
      display_name: localRoom.displayName,
      role: "local",
      authenticated: false,
      kind: "main",
      git_room: localRoom.gitRoom,
    };
    rememberJoinedRoomInfo(localRoom.roomIdentifier, payload);
    return mapDesktopRoomInfoPayload(localRoom.roomIdentifier, payload);
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const updated = await apiFetch<RoomInfoPayload>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: trimmedDisplayName }),
    },
  );
  rememberJoinedRoomInfo(cloudRoomIdentifier, updated);
  return mapDesktopRoomInfoPayload(cloudRoomIdentifier, updated);
}

export async function getDesktopGitHubIntegrationStatus(
  roomIdentifier: string,
): Promise<DesktopGitHubIntegrationStatus> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before checking GitHub.");
  }

  if (isDesktopSmokeCheck()) {
    return {
      roomId: trimmedRoomIdentifier,
      accessRoomId: null,
      configured: false,
      setupManifestAvailable: false,
      connected: false,
      installUrlAvailable: false,
      repository: null,
    };
  }

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    return {
      roomId: localRoomIdentifierForStorage(storage, trimmedRoomIdentifier),
      accessRoomId: null,
      configured: false,
      setupManifestAvailable: false,
      connected: false,
      installUrlAvailable: false,
      repository: null,
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const status = await apiFetch<{
    room_id?: string;
    access_room_id?: string | null;
    configured?: boolean;
    setup_manifest_available?: boolean;
    connected?: boolean;
    install_url_available?: boolean;
    repository?: { full_name?: string } | null;
  }>(`/rooms/${encodeURIComponent(cloudRoomIdentifier)}/integrations/github`);

  return {
    roomId: status.room_id || cloudRoomIdentifier,
    accessRoomId: status.access_room_id || null,
    configured: Boolean(status.configured),
    setupManifestAvailable: Boolean(status.setup_manifest_available),
    connected: Boolean(status.connected),
    installUrlAvailable: Boolean(status.install_url_available),
    repository: status.repository?.full_name
      ? { fullName: status.repository.full_name }
      : null,
  };
}

export async function openDesktopGitHubInstall(
  roomIdentifier: string,
): Promise<DesktopGitHubIntegrationActionResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before opening GitHub.");
  }

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    return {
      opened: false,
      message: "Publish this local room before connecting GitHub.",
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const payload = await apiFetch<{ install_url?: string }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/integrations/github/install-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!payload.install_url) {
    return { opened: false, message: "GitHub did not return an install URL." };
  }
  await openAllowedExternalUrl(payload.install_url, ["github.com"]);
  return { opened: true, message: "GitHub opened in your browser." };
}
