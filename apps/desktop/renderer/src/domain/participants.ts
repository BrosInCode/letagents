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

export function agentOwnerAttribution(
  ownerLabel: string | null | undefined,
  actorLabel?: string | null,
): string {
  const owner = normalizeDisplayName(ownerLabel) || ownerLabelFromActor(actorLabel);
  if (!owner) return "Agent";
  if (/['’]s\s+agent$/i.test(owner)) return owner;
  return `${owner}'s agent`;
}

function ownerLabelFromActor(actorLabel: string | null | undefined): string {
  const parts = normalizeDisplayName(actorLabel).split(" | ").map((part) => part.trim());
  return parts.length === 3 && /agent$/i.test(parts[1] || "") ? parts[1] : "";
}

function normalizeDisplayName(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function isParserCompatibleMentionHandle(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/.test(value);
}

function agentMentionInsertText(
  participant: DesktopParticipantSummary,
  duplicateDisplayName: boolean,
): string | null {
  const displayName = normalizeDisplayName(participant.displayName);
  if (!duplicateDisplayName && isParserCompatibleMentionHandle(displayName)) {
    return displayName;
  }
  const canonical = participant.agentKey ? `agent:${participant.agentKey.trim()}` : "";
  return canonical && isParserCompatibleMentionHandle(canonical) ? canonical : null;
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

  const allMentionableParticipants = sortMentionableRoomParticipants(participants
    .filter(isMentionableRoomParticipant)
    .filter((participant) => participant.displayName.toLowerCase() !== "everyone"));
  const mentionableParticipants = allMentionableParticipants.filter((participant) => [
      participant.displayName,
      participant.ownerLabel,
      ownerLabelFromActor(participant.actorLabel),
    ].some((value) => normalizeDisplayName(value).toLowerCase().includes(normalizedQuery)));
  const agentDisplayNameCounts = new Map<string, number>();
  for (const participant of allMentionableParticipants) {
    if (participant.kind !== "agent") continue;
    const key = participant.displayName.toLowerCase();
    agentDisplayNameCounts.set(key, (agentDisplayNameCounts.get(key) || 0) + 1);
  }

  candidates.push(...mentionableParticipants.flatMap((participant) => {
    const duplicateDisplayName = participant.kind === "agent" &&
      (agentDisplayNameCounts.get(participant.displayName.toLowerCase()) || 0) > 1;
    const insertText = participant.kind === "agent"
      ? agentMentionInsertText(participant, duplicateDisplayName)
      : participant.displayName;
    if (!insertText) return [];
    return [{
      participantKey: participant.participantKey,
      kind: participant.kind,
      displayName: participant.displayName,
      insertText,
      label: participant.kind === "agent"
        ? agentOwnerAttribution(participant.ownerLabel, participant.actorLabel)
        : "Human",
    }];
  }));

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
