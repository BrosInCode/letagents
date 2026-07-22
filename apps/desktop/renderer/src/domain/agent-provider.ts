import type {
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopRoomMessage,
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";

const genericProviderLabels = new Set([
  "agent",
  "other",
  "supervisor",
  "supervisor worker",
  "worker",
]);

function normalized(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function normalizedOwner(value: string | null | undefined): string {
  return normalized(value)
    .replace(/[’']/g, "'")
    .replace(/'s agent$/, "")
    .replace(/' agent$/, "")
    .trim();
}

function providerLabel(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  const key = normalized(raw);
  if (!key || genericProviderLabels.has(key)) return null;
  if (key === "codex" || key.startsWith("codex:")) return "Codex";
  if (key === "claude" || key === "claude code" || key.startsWith("claude:")) return "Claude Code";
  if (key === "cursor" || key.startsWith("cursor:")) return "Cursor";
  if (key === "antigravity" || key.startsWith("antigravity:")) return "Antigravity";
  if (key === "open model" || key === "open-model" || key === "open_model") return "Open Model";
  return raw;
}

export function isGenericAgentProviderLabel(value: string | null | undefined): boolean {
  const key = normalized(value);
  return !key || genericProviderLabels.has(key);
}

type ProviderCandidate = {
  actorLabel?: string | null;
  agentKey?: string | null;
  agentSessionId?: string | null;
  displayName?: string | null;
  ownerLabel?: string | null;
  ideLabel?: string | null;
  runtime?: string | null;
};

function uniqueProvider(candidates: readonly ProviderCandidate[]): string | null {
  const providers = new Set<string>();
  for (const candidate of candidates) {
    const label = providerLabel(candidate.ideLabel) || providerLabel(candidate.runtime);
    if (label) providers.add(label);
  }
  return providers.size === 1 ? [...providers][0] : null;
}

function exact(value: string | null | undefined, candidate: string | null | undefined): boolean {
  const left = normalized(value);
  return Boolean(left && left === normalized(candidate));
}

function messageDisplayName(message: DesktopRoomMessage): string {
  return message.agentIdentity?.displayName?.trim()
    || message.sender.split(" | ")[0]?.trim()
    || message.sender.trim();
}

function messageOwnerLabel(message: DesktopRoomMessage): string {
  return message.agentIdentity?.ownerLabel?.trim()
    || message.agentIdentity?.ownerAttribution?.trim()
    || message.sender.split(" | ")[1]?.trim()
    || "";
}

function supervisorOwnerLabel(entry: DesktopSupervisorManifestEntry): string | null {
  const agentKey = entry.agentKey?.trim() || "";
  const separator = agentKey.indexOf("/");
  return separator > 0 ? agentKey.slice(0, separator) : null;
}

function supervisorProviderCandidate(entry: DesktopSupervisorManifestEntry): ProviderCandidate {
  return {
    agentKey: entry.agentKey,
    agentSessionId: entry.agentSessionId,
    displayName: entry.displayName,
    ownerLabel: supervisorOwnerLabel(entry),
    ideLabel: providerLabel(entry.provider),
    runtime: entry.provider,
  };
}

/**
 * Resolve a message's provider from the strongest current room identity.
 * Historical message snapshots may legitimately retain a generic
 * "Supervisor worker" label; current presence and participant projections
 * carry the exact provider without rewriting message history.
 */
export function resolveMessageProviderLabel(
  message: DesktopRoomMessage,
  participants: readonly DesktopParticipantSummary[] = [],
  presence: readonly DesktopAgentPresence[] = [],
  supervisorEntries: readonly DesktopSupervisorManifestEntry[] = [],
): string | null {
  // Provider badges and agent controls are identity claims, not a fuzzy name
  // decoration. Human/browser/system messages must never inherit them merely
  // because their display name matches a current agent.
  if (message.source !== "agent") return null;
  const explicit = providerLabel(message.agentIdentity?.ideLabel);
  if (explicit) return explicit;

  const candidates: ProviderCandidate[] = [
    ...supervisorEntries.map(supervisorProviderCandidate),
    ...presence,
    ...participants,
  ];
  const sessionId = message.agentIdentity?.agentSessionId;
  const bySession = uniqueProvider(candidates.filter((candidate) => exact(sessionId, candidate.agentSessionId)));
  if (bySession) return bySession;

  const agentKey = message.agentIdentity?.agentKey;
  const byAgentKey = uniqueProvider(candidates.filter((candidate) => exact(agentKey, candidate.agentKey)));
  if (byAgentKey) return byAgentKey;

  const actorLabel = message.agentIdentity?.actorLabel || message.actorLabel || message.sender;
  const byActor = uniqueProvider(candidates.filter((candidate) => exact(actorLabel, candidate.actorLabel)));
  if (byActor) return byActor;

  const displayName = messageDisplayName(message);
  const ownerLabel = normalizedOwner(messageOwnerLabel(message));
  const byDisplayName = candidates.filter((candidate) => exact(displayName, candidate.displayName));
  const ownerQualifiedCandidates = ownerLabel
    ? byDisplayName.filter((candidate) => ownerLabel === normalizedOwner(candidate.ownerLabel))
    : byDisplayName;
  const byDisplayAndOwner = uniqueProvider(
    ownerQualifiedCandidates.length > 0 ? ownerQualifiedCandidates : byDisplayName,
  );
  if (byDisplayAndOwner) return byDisplayAndOwner;

  return message.agentIdentity?.ideLabel?.trim() || null;
}
