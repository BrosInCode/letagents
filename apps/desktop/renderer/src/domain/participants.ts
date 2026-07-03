import type { DesktopParticipantSummary } from "../../../electron/ipc-types";

const AGENT_RUNTIME_PREFIXES = ["antigravity", "claude", "codex", "orchestrator"] as const;
const EVERYONE_MENTION_CANDIDATE: RoomMentionCandidate = {
  participantKey: "room:everyone",
  kind: "broadcast",
  displayName: "everyone",
  insertText: "everyone",
  label: "Everyone",
};

export interface RoomMentionCandidate {
  participantKey: string;
  kind: DesktopParticipantSummary["kind"] | "broadcast";
  displayName: string;
  insertText: string;
  label: string;
}

function normalizeDisplayName(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function matchesRuntimePrefix(value: string, prefix: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === prefix || normalized.startsWith(`${prefix}-`)) {
    return true;
  }

  const compact = value.replace(/[^a-zA-Z0-9]+/g, "");
  if (compact.toLowerCase() === prefix) {
    return true;
  }

  if (!compact.toLowerCase().startsWith(prefix)) {
    return false;
  }

  const next = compact[prefix.length];
  return Boolean(next && /[A-Z0-9]/.test(next));
}

function looksLikeBareRuntimeAgentName(value: string): boolean {
  return AGENT_RUNTIME_PREFIXES.some((prefix) => matchesRuntimePrefix(value, prefix));
}

export function isMentionableRoomParticipant(
  participant: Pick<
    DesktopParticipantSummary,
    "activityState" | "displayName" | "githubLogin" | "hiddenAt" | "kind"
  >,
): boolean {
  if (participant.hiddenAt || participant.activityState === "offline") {
    return false;
  }

  const displayName = normalizeDisplayName(participant.displayName);
  const githubLogin = normalizeDisplayName(participant.githubLogin);
  if (
    !displayName ||
    displayName.toLowerCase() === "anonymous" ||
    githubLogin.toLowerCase() === "anonymous"
  ) {
    return false;
  }

  if (participant.kind === "human" && looksLikeBareRuntimeAgentName(displayName)) {
    return false;
  }

  return true;
}

export function sortMentionableRoomParticipants<T extends Pick<
  DesktopParticipantSummary,
  "activityState" | "displayName" | "kind" | "sourceFlags"
>>(participants: readonly T[]): T[] {
  return [...participants].sort((left, right) =>
    mentionPriority(left) - mentionPriority(right) ||
    left.displayName.localeCompare(right.displayName)
  );
}

export function roomMentionCandidates(
  participants: readonly DesktopParticipantSummary[],
  query: string | null | undefined,
  limit = 6,
): RoomMentionCandidate[] {
  const normalizedQuery = normalizeDisplayName(query).toLowerCase();
  const candidates: RoomMentionCandidate[] = [];
  if ("everyone".includes(normalizedQuery)) {
    candidates.push(EVERYONE_MENTION_CANDIDATE);
  }

  candidates.push(...sortMentionableRoomParticipants(participants
    .filter(isMentionableRoomParticipant)
    .filter((participant) => participant.displayName.toLowerCase() !== "everyone")
    .filter((participant) => participant.displayName.toLowerCase().includes(normalizedQuery)))
    .map((participant) => ({
      participantKey: participant.participantKey,
      kind: participant.kind,
      displayName: participant.displayName,
      insertText: participant.displayName,
      label: participant.kind === "agent" ? "Agent" : "Human",
    })));

  return candidates.slice(0, limit);
}

function mentionPriority(
  participant: Pick<DesktopParticipantSummary, "activityState" | "kind" | "sourceFlags">,
): number {
  if (participant.kind !== "agent") {
    return 3;
  }
  const reachable = participant.activityState === "active" || participant.activityState === "away";
  if (reachable && participant.sourceFlags.includes("delivery")) {
    return 0;
  }
  if (reachable) {
    return 1;
  }
  return 2;
}
