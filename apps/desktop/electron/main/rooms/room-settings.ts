import {
  ROOM_AGENT_GUIDELINES_MAX_BYTES,
  ROOM_AGENT_GUIDELINES_TOKEN_BUDGET,
  normalizeGitHubRoomChatEventKinds,
  normalizeRoomAgentGuidelines,
  roomAgentGuidelinesBytes,
  type GitHubRoomChatEventFilter,
  type RoomAgentGuidelines,
} from "../../../../../shared/room-settings.mjs";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

/** These settings are chosen for everyone in the room, so they live on the server. */
async function settingsPath(identifier: string, setting: "github-event-filter" | "agent-guidelines"): Promise<string> {
  if (!identifier?.trim()) throw new Error("Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") throw new Error("This setting requires a cloud room.");
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}/${setting}`;
}

export async function getDesktopGitHubEventFilter(identifier: string): Promise<GitHubRoomChatEventFilter> {
  return apiFetch(await settingsPath(identifier, "github-event-filter"));
}

export async function setDesktopGitHubEventFilter(identifier: string, enabledKinds: unknown): Promise<GitHubRoomChatEventFilter> {
  const kinds = normalizeGitHubRoomChatEventKinds(enabledKinds);
  if (!kinds) throw new Error("Choose which GitHub events to post.");
  return apiFetch(await settingsPath(identifier, "github-event-filter"), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled_kinds: kinds }),
  });
}

export async function getDesktopRoomAgentGuidelines(identifier: string): Promise<RoomAgentGuidelines> {
  return apiFetch(await settingsPath(identifier, "agent-guidelines"));
}

export async function setDesktopRoomAgentGuidelines(identifier: string, guidelines: unknown): Promise<RoomAgentGuidelines> {
  if (typeof guidelines !== "string") throw new Error("Guidelines must be text.");
  const text = normalizeRoomAgentGuidelines(guidelines);
  if (roomAgentGuidelinesBytes(text) > ROOM_AGENT_GUIDELINES_MAX_BYTES) {
    throw new Error(`Guidelines can be at most about ${ROOM_AGENT_GUIDELINES_TOKEN_BUDGET} tokens. Shorten them to save.`);
  }
  return apiFetch(await settingsPath(identifier, "agent-guidelines"), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guidelines: text }),
  });
}
