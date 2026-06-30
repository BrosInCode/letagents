import type {
  DesktopAgentProviderId,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
} from "../../ipc-types.js";

const CLAUDE_CODE_PROFILES: DesktopManagedAgentPermissionProfile[] = [
  {
    id: "read_only",
    label: "Read-only",
    description: "Allows read and planning tools, then denies write, edit, and shell tools.",
    status: "available",
    risk: "low",
    detail: "Claude Code non-read tool calls are denied before a room approval request is created.",
    isDefault: false,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Allows read tools and asks in the room or desktop UI before write, edit, or shell tools.",
    status: "available",
    risk: "medium",
    detail: "Backed by the Claude Code canUseTool bridge and pending permission requests.",
    isDefault: true,
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Auto-allows non-blocked Claude Code tools for this local repo.",
    status: "available",
    risk: "high",
    detail: "LetAgents room, rental, and provisioning tools stay blocked.",
    isDefault: false,
  },
  {
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Claude Code does not expose a separate LetAgents-managed sandbox profile here.",
    status: "unsupported",
    risk: "medium",
    detail: "Use ask-before-write or full access for Claude Code managed sessions.",
    isDefault: false,
  },
];

const CODEX_PROFILES: DesktopManagedAgentPermissionProfile[] = [
  {
    id: "full_access",
    label: "Full access",
    description: "Runs Codex with the current app-server launch policy for trusted local work.",
    status: "available",
    risk: "high",
    detail: "Maps to approvalPolicy=never and sandboxPolicy=dangerFullAccess.",
    isDefault: true,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Desktop-mediated Codex approvals are not wired for managed agents yet.",
    status: "gated",
    risk: "medium",
    detail: "Requires Codex app-server approval bridging before it can be enabled.",
    isDefault: false,
  },
  {
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Codex managed sandbox presets need app-server contract tests before exposure.",
    status: "gated",
    risk: "medium",
    detail: "The current managed Codex launch uses full access.",
    isDefault: false,
  },
  {
    id: "read_only",
    label: "Read-only",
    description: "A read-only Codex managed profile is not currently wired.",
    status: "gated",
    risk: "low",
    detail: "Requires a Codex app-server read-only launch path.",
    isDefault: false,
  },
];

const CURSOR_PROFILES: DesktopManagedAgentPermissionProfile[] = [
  {
    id: "read_only",
    label: "Read-only",
    description: "Runs Cursor Agent in ask mode for desktop-delivered room events.",
    status: "available",
    risk: "low",
    detail: "Matches the Cursor phase-0 managed runtime gate.",
    isDefault: true,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Cursor managed approvals are not exposed through a desktop canUseTool bridge yet.",
    status: "gated",
    risk: "medium",
    detail: "Needs a provider-owned approval path before write-capable mode is enabled.",
    isDefault: false,
  },
  {
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Cursor sandbox writes remain gated behind config isolation and sandbox tests.",
    status: "gated",
    risk: "medium",
    detail: "Do not enable until LetAgents MCP tools are unavailable or denied under the managed profile.",
    isDefault: false,
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Cursor full access is blocked until auth and config isolation are proven.",
    status: "gated",
    risk: "high",
    detail: "The current Cursor managed runtime intentionally exposes read-only mode only.",
    isDefault: false,
  },
];

const PROVIDER_PERMISSION_PROFILES: Record<string, DesktopManagedAgentPermissionProfile[]> = {
  "claude-code": CLAUDE_CODE_PROFILES,
  codex: CODEX_PROFILES,
  cursor: CURSOR_PROFILES,
};

export function listManagedAgentPermissionProfiles(
  providerId: DesktopAgentProviderId | null | undefined,
): DesktopManagedAgentPermissionProfile[] {
  return cloneProfiles(PROVIDER_PERMISSION_PROFILES[String(providerId ?? "")] ?? []);
}

export function defaultManagedAgentPermissionProfileId(
  providerId: DesktopAgentProviderId | null | undefined,
): DesktopManagedAgentPermissionProfileId | null {
  const profiles = listManagedAgentPermissionProfiles(providerId);
  const profile = profiles.find((entry) => entry.isDefault) ??
    profiles.find((entry) => entry.status === "available") ??
    null;
  return profile?.id ?? null;
}

export function managedAgentPermissionProfileForProvider(
  providerId: DesktopAgentProviderId,
  requestedProfileId?: DesktopManagedAgentPermissionProfileId | null,
): DesktopManagedAgentPermissionProfile {
  const profiles = listManagedAgentPermissionProfiles(providerId);
  if (!profiles.length) {
    throw new Error(`Provider '${providerId}' does not expose desktop managed permission profiles.`);
  }
  const requested = normalizeProfileId(requestedProfileId);
  const selected = requested
    ? profiles.find((profile) => profile.id === requested)
    : null;
  return selected ?? profiles.find((profile) => profile.isDefault) ?? profiles[0];
}

export function assertManagedAgentPermissionProfileAvailable(
  providerId: DesktopAgentProviderId,
  requestedProfileId?: DesktopManagedAgentPermissionProfileId | null,
): DesktopManagedAgentPermissionProfile {
  const requested = normalizeProfileId(requestedProfileId);
  const profiles = listManagedAgentPermissionProfiles(providerId);
  if (requested && !profiles.some((profile) => profile.id === requested)) {
    throw new Error(`Unknown permission profile '${requested}' for ${providerId}.`);
  }
  const profile = managedAgentPermissionProfileForProvider(providerId, requestedProfileId);
  if (profile.status !== "available") {
    throw new Error(`${profile.label} is not available for ${providerId}: ${profile.detail || profile.description}`);
  }
  return profile;
}

function cloneProfiles(
  profiles: readonly DesktopManagedAgentPermissionProfile[],
): DesktopManagedAgentPermissionProfile[] {
  return profiles.map((profile) => ({ ...profile }));
}

function normalizeProfileId(
  value: DesktopManagedAgentPermissionProfileId | null | undefined,
): DesktopManagedAgentPermissionProfileId | null {
  const normalized = String(value ?? "").trim() as DesktopManagedAgentPermissionProfileId;
  return normalized || null;
}
