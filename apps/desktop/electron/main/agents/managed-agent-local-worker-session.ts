import { randomUUID } from "node:crypto";

import type { DesktopRoomStorageState } from "../../ipc-types.js";
import {
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "../rooms/local-store.js";
import {
  getOrCreateDesktopHostId,
  saveAgentSession,
  type StoredAgentSessionState,
} from "./state.js";

export interface LocalDesktopManagedAgentWorkerSessionInput {
  roomIdentifier: string;
  runtime: string;
  agentInstanceId: string;
  displayName: string;
  ideLabel: string;
  repoBranch: string | null;
  registrationLiveness: Record<string, string | null>;
}

function normalizeDisplayText(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return normalized || fallback;
}

function normalizeAgentKeyPart(value: string | null | undefined, fallback: string): string {
  const normalized = normalizeDisplayText(value, fallback)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

function formatOwnerAttribution(ownerLabel: string): string {
  const normalized = normalizeDisplayText(ownerLabel, "Desktop");
  return /s$/i.test(normalized) ? `${normalized}' agent` : `${normalized}'s agent`;
}

function buildAgentActorLabel(input: {
  displayName: string;
  ownerLabel: string;
  ideLabel: string;
}): string {
  return [
    normalizeDisplayText(input.displayName, "Agent"),
    formatOwnerAttribution(input.ownerLabel),
    normalizeDisplayText(input.ideLabel, "Agent"),
  ].join(" | ");
}

async function readLocalOwnerLabel(): Promise<string> {
  try {
    const { readStoredAuth } = await import("../auth.js");
    const storedAuth = await readStoredAuth();
    return normalizeDisplayText(
      storedAuth.account?.displayName || storedAuth.account?.login,
      "Desktop",
    );
  } catch {
    return "Desktop";
  }
}

function livenessField(
  registrationLiveness: Record<string, string | null>,
  field: string,
): string | null {
  const value = registrationLiveness[field];
  return typeof value === "string" && value.trim() ? value : null;
}

export async function createLocalDesktopManagedAgentWorkerSession(
  input: LocalDesktopManagedAgentWorkerSessionInput,
  storage: DesktopRoomStorageState,
): Promise<StoredAgentSessionState> {
  const now = new Date().toISOString();
  const roomId = localRoomIdentifierForStorage(storage, input.roomIdentifier);
  const ownerLabel = await readLocalOwnerLabel();
  const displayName = normalizeDisplayText(input.displayName, input.ideLabel);
  const ideLabel = normalizeDisplayText(input.ideLabel, "Agent");
  const actorLabel = buildAgentActorLabel({ displayName, ownerLabel, ideLabel });
  const hostId = livenessField(input.registrationLiveness, "host_id") || getOrCreateDesktopHostId();

  return saveAgentSession({
    session_id: `local_agent_session_${randomUUID()}`,
    session_token: `local_agent_token_${randomUUID()}`,
    room_id: roomId,
    session_kind: "worker",
    runtime: input.runtime,
    host_id: hostId,
    host_kind: livenessField(input.registrationLiveness, "host_kind"),
    host_label: livenessField(input.registrationLiveness, "host_label") || "LetAgents Desktop",
    liveness_capability: livenessField(input.registrationLiveness, "liveness_capability"),
    tool_bridge_id: livenessField(input.registrationLiveness, "tool_bridge_id"),
    actor_label: actorLabel,
    agent_key: [
      "local",
      normalizeAgentKeyPart(ownerLabel, "desktop"),
      normalizeAgentKeyPart(displayName, "agent"),
    ].join("/"),
    agent_instance_id: input.agentInstanceId,
    display_name: displayName,
    owner_label: ownerLabel,
    ide_label: ideLabel,
    repo_branch: input.repoBranch,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    ended_at: null,
  });
}

export async function createLocalDesktopManagedAgentWorkerSessionForRoom(
  input: LocalDesktopManagedAgentWorkerSessionInput,
): Promise<StoredAgentSessionState | null> {
  const storage = await resolveLocalAwareRoomStorageMode(input.roomIdentifier);
  if (storage.effectiveMode !== "local") {
    return null;
  }
  return createLocalDesktopManagedAgentWorkerSession(input, storage);
}
