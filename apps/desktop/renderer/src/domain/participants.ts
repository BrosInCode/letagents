import type { DesktopParticipantSummary } from "../../../electron/ipc-types";

const AGENT_RUNTIME_PREFIXES = ["antigravity", "claude", "codex", "orchestrator"] as const;

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
