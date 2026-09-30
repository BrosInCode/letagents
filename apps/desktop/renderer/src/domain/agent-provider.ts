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
  if (key === "claude" || key === "claude code" || key === "claude-code" || key.startsWith("claude:")) return "Claude Code";
  if (key === "cursor" || key.startsWith("cursor:")) return "Cursor";
  if (key === "antigravity" || key.startsWith("antigravity:")) return "Antigravity";
  if (key === "open model" || key === "open-model" || key === "open_model") return "Open Model";
  if (key === "opencode" || key === "open code") return "OpenCode";
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

function uniqueProvider(providers: ReadonlySet<string> | undefined): string | null {
  return providers?.size === 1 ? providers.values().next().value! : null;
}

function addProvider(index: Map<string, Set<string>>, key: string, label: string | null): void {
  if (!key) return;
  let labels = index.get(key);
  if (!labels) {
    labels = new Set();
    index.set(key, labels);
  }
  if (label) labels.add(label);
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
  return createMessageProviderLabelResolver(participants, presence, supervisorEntries)(message);
}

/** Build once per reactive room roster, then resolve every displayed row. */
export function createMessageProviderLabelResolver(
  participants: readonly DesktopParticipantSummary[] = [],
  presence: readonly DesktopAgentPresence[] = [],
  supervisorEntries: readonly DesktopSupervisorManifestEntry[] = [],
): (message: DesktopRoomMessage) => string | null {
  const sessions = new Map<string, Set<string>>();
  const agentKeys = new Map<string, Set<string>>();
  const actors = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  const namesByOwner = new Map<string, Map<string, Set<string>>>();
  const candidates: ProviderCandidate[] = [
    ...supervisorEntries.map(supervisorProviderCandidate),
    ...presence,
    ...participants,
  ];
  for (const candidate of candidates) {
    const label = providerLabel(candidate.ideLabel) || providerLabel(candidate.runtime);
    addProvider(sessions, normalized(candidate.agentSessionId), label);
    addProvider(agentKeys, normalized(candidate.agentKey), label);
    addProvider(actors, normalized(candidate.actorLabel), label);
    const name = normalized(candidate.displayName);
    addProvider(names, name, label);
    const owner = normalizedOwner(candidate.ownerLabel);
    if (name && owner) {
      let ownerNames = namesByOwner.get(owner);
      if (!ownerNames) {
        ownerNames = new Map();
        namesByOwner.set(owner, ownerNames);
      }
      // Keep an empty set for generic-only candidates: their owner match must
      // still prevent falling back to another owner's concrete provider.
      addProvider(ownerNames, name, label);
    }
  }

  return (message) => {
    // Provider badges and agent controls are identity claims, not a fuzzy name
    // decoration. Human/browser/system messages must never inherit them merely
    // because their display name matches a current agent.
    if (message.source !== "agent") return null;
    const explicit = providerLabel(message.agentIdentity?.ideLabel);
    if (explicit) return explicit;

    const sessionId = message.agentIdentity?.agentSessionId;
    const bySession = uniqueProvider(sessions.get(normalized(sessionId)));
    if (bySession) return bySession;

    const agentKey = message.agentIdentity?.agentKey;
    const byAgentKey = uniqueProvider(agentKeys.get(normalized(agentKey)));
    if (byAgentKey) return byAgentKey;

    const actorLabel = message.agentIdentity?.actorLabel || message.actorLabel || message.sender;
    const byActor = uniqueProvider(actors.get(normalized(actorLabel)));
    if (byActor) return byActor;

    const displayName = normalized(messageDisplayName(message));
    const ownerLabel = normalizedOwner(messageOwnerLabel(message));
    const ownerProviders = namesByOwner.get(ownerLabel)?.get(displayName);
    const byDisplayAndOwner = uniqueProvider(ownerProviders ?? names.get(displayName));
    if (byDisplayAndOwner) return byDisplayAndOwner;

    return message.agentIdentity?.ideLabel?.trim() || null;
  };
}
