import { parseAgentActorLabel } from "./agent-identity.js";

export const ROOM_PARTICIPANT_KINDS = ["human", "agent"] as const;

export type RoomParticipantKind = (typeof ROOM_PARTICIPANT_KINDS)[number];

function normalizeParticipantKeyPart(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function buildAgentRoomParticipantKey(actorLabel: string | null | undefined): string | null {
  const normalizedActorLabel = normalizeParticipantKeyPart(
    parseAgentActorLabel(actorLabel)?.raw ?? actorLabel
  );
  return normalizedActorLabel ? `agent:${normalizedActorLabel}` : null;
}

export function buildHumanRoomParticipantKey(input: {
  github_login?: string | null;
  display_name?: string | null;
}): string | null {
  const loginKey = normalizeParticipantKeyPart(input.github_login);
  if (loginKey) {
    return `human:login:${loginKey}`;
  }

  const displayNameKey = normalizeParticipantKeyPart(input.display_name);
  return displayNameKey ? `human:name:${displayNameKey}` : null;
}
