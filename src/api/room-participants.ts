import type { OwnerTokenAccount, SessionAccount } from "./db.js";
import { parseAgentActorLabel } from "../shared/agent-identity.js";
import {
  buildAgentRoomParticipantKey,
  buildHumanRoomParticipantKey,
} from "../shared/room-participant.js";

export interface RoomParticipantUpsertInput {
  room_id: string;
  participant_key: string;
  kind: "human" | "agent";
  actor_label?: string | null;
  agent_key?: string | null;
  github_login?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  last_seen_at?: string | null;
  preserve_last_seen_at_on_conflict?: boolean;
}

export type UpsertRoomParticipant = (input: RoomParticipantUpsertInput) => Promise<unknown>;

export interface RememberHumanRoomParticipantInput {
  projectId: string;
  sender?: string | null;
  sessionAccount?: SessionAccount | OwnerTokenAccount | null | undefined;
  lastSeenAt?: string | null;
}

export interface RememberAgentRoomParticipantInput {
  projectId: string;
  actorLabel?: string | null;
  agentKey?: string | null;
  displayName?: string | null;
  ownerLabel?: string | null;
  ideLabel?: string | null;
  lastSeenAt?: string | null;
  preserveLastSeenAtOnConflict?: boolean;
}

export interface RememberRoomParticipantFromMessageInput {
  projectId: string;
  sender: string;
  source: string | undefined;
  sessionAccount?: SessionAccount | OwnerTokenAccount | null | undefined;
  timestamp: string;
}

export function normalizeParticipantValue(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function getOwnerLabelFromAttribution(
  ownerAttribution: string | null | undefined
): string | null {
  const normalized = normalizeParticipantValue(ownerAttribution);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(.+?)(?:'s|s')?\s+agent$/i);
  return match?.[1]?.trim() || normalized;
}

export function isAgentIdentityValue(value: string | null | undefined): boolean {
  const parsed = parseAgentActorLabel(value);
  return Boolean(parsed && (parsed.structured || parsed.owner_attribution || parsed.ide_label));
}

export function buildHumanRoomParticipantUpsert(
  input: RememberHumanRoomParticipantInput
): RoomParticipantUpsertInput | null {
  const githubLogin = normalizeParticipantValue(input.sessionAccount?.login ?? input.sender);
  const displayName = githubLogin || normalizeParticipantValue(input.sender);
  const participantKey = buildHumanRoomParticipantKey({
    github_login: githubLogin || null,
    display_name: displayName || null,
  });

  if (!participantKey || !displayName) {
    return null;
  }

  return {
    room_id: input.projectId,
    participant_key: participantKey,
    kind: "human",
    github_login: githubLogin || null,
    display_name: displayName,
    last_seen_at: input.lastSeenAt ?? null,
  };
}

export function buildAgentRoomParticipantUpsert(
  input: RememberAgentRoomParticipantInput
): RoomParticipantUpsertInput | null {
  const actorLabel = normalizeParticipantValue(input.actorLabel);
  const participantKey = buildAgentRoomParticipantKey(actorLabel);
  if (!actorLabel || !participantKey) {
    return null;
  }

  const parsed = parseAgentActorLabel(actorLabel);
  const displayName = normalizeParticipantValue(input.displayName)
    || parsed?.display_name
    || actorLabel;

  return {
    room_id: input.projectId,
    participant_key: participantKey,
    kind: "agent",
    actor_label: actorLabel,
    agent_key: normalizeParticipantValue(input.agentKey) || null,
    display_name: displayName,
    owner_label: normalizeParticipantValue(input.ownerLabel)
      || getOwnerLabelFromAttribution(parsed?.owner_attribution),
    ide_label: normalizeParticipantValue(input.ideLabel) || parsed?.ide_label || null,
    last_seen_at: input.lastSeenAt ?? null,
    preserve_last_seen_at_on_conflict: input.preserveLastSeenAtOnConflict ?? false,
  };
}

export function buildRoomParticipantUpsertFromMessage(
  input: RememberRoomParticipantFromMessageInput
): RoomParticipantUpsertInput | null {
  const normalizedSender = normalizeParticipantValue(input.sender);
  const normalizedSource = normalizeParticipantValue(input.source).toLowerCase();
  if (!normalizedSender) {
    return null;
  }

  if (normalizedSource === "agent" || isAgentIdentityValue(normalizedSender)) {
    return buildAgentRoomParticipantUpsert({
      projectId: input.projectId,
      actorLabel: normalizedSender,
      lastSeenAt: input.timestamp,
    });
  }

  const lowerSender = normalizedSender.toLowerCase();
  if (lowerSender === "letagents" || lowerSender === "system" || lowerSender === "github") {
    return null;
  }

  return buildHumanRoomParticipantUpsert({
    projectId: input.projectId,
    sender: normalizedSender,
    sessionAccount: input.sessionAccount,
    lastSeenAt: input.timestamp,
  });
}

export function createRoomParticipantRecorder(deps: {
  upsertRoomParticipant: UpsertRoomParticipant;
}) {
  return {
    async rememberHumanRoomParticipant(input: RememberHumanRoomParticipantInput): Promise<void> {
      const participant = buildHumanRoomParticipantUpsert(input);
      if (!participant) {
        return;
      }

      await deps.upsertRoomParticipant(participant);
    },

    async rememberAgentRoomParticipant(input: RememberAgentRoomParticipantInput): Promise<void> {
      const participant = buildAgentRoomParticipantUpsert(input);
      if (!participant) {
        return;
      }

      await deps.upsertRoomParticipant(participant);
    },

    async rememberRoomParticipantFromMessage(
      input: RememberRoomParticipantFromMessageInput
    ): Promise<void> {
      const participant = buildRoomParticipantUpsertFromMessage(input);
      if (!participant) {
        return;
      }

      await deps.upsertRoomParticipant(participant);
    },
  };
}
