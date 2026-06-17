import { dialog } from "electron";
import { basename } from "node:path";
import type {
  DesktopGitHubIntegrationActionResult,
  DesktopGitHubIntegrationStatus,
  DesktopRepoRoomSelection,
  DesktopRoomInfo,
} from "../../ipc-types.js";
import { buildRepoStatus, resolveRoomIdentifierFromPath } from "../../repo-status.js";
import { apiFetch } from "../auth.js";
import { openAllowedExternalUrl } from "../external-url.js";
import { isDesktopSmokeCheck } from "../smoke.js";
import { focusMainWindow } from "../window.js";
import { fetchRoomSnapshot } from "./snapshot.js";
import {
  cloudRoomIdentifierForStorage,
  createLocalRoom,
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
  updateLocalRoomDisplayName,
} from "./local-store.js";
import {
  mapDesktopRoomInfoPayload,
  rememberJoinedRoomInfo,
  type RoomInfoPayload,
} from "./room-info.js";

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
    };
  }

  const selectedPath = result.filePaths[0];
  const resolved = await resolveRoomIdentifierFromPath(selectedPath);
  const repoPath = resolved.repoRoot || selectedPath;
  const storage = await resolveLocalAwareRoomStorageMode(resolved.roomIdentifier);
  if (storage.effectiveMode === "local") {
    await createLocalRoom({
      roomIdentifier: resolved.roomIdentifier,
      displayName: basename(repoPath),
    });
  }
  return {
    canceled: false,
    repoPath,
    repoStatus: await buildRepoStatus(repoPath),
    roomIdentifier: resolved.roomIdentifier,
    source: resolved.source,
    snapshot: await fetchRoomSnapshot(resolved.roomIdentifier),
    error: null,
    warning: resolved.warning,
  };
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
