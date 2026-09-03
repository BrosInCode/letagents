import type {
  DesktopAgentProviderId,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
} from "../../ipc-types.js";

const CLAUDE_CODE_PROFILES: DesktopManagedAgentPermissionProfile[] = [
  {
    id: "read_only",
    label: "Read-only",
    description: "Allows Read, Glob, and Grep while keeping daemon-mediated LetAgents room tools available.",
    status: "available",
    risk: "low",
    detail: "Write, edit, and shell tools are unavailable, and ambient Claude settings are disabled.",
    isDefault: true,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Allows read tools and asks in the room or desktop UI before write, edit, or shell tools.",
    status: "gated",
    risk: "medium",
    detail: "Claude supervised prompt bridging is not available yet.",
    isDefault: false,
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Auto-allows non-blocked Claude Code tools with broad local access on this host.",
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
    detail: "Use read-only or full access for Claude Code managed sessions.",
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
    detail: "Runs Cursor in ask mode without workspace edits.",
    isDefault: true,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Cursor approval prompts are not bridged into the desktop or room yet.",
    status: "gated",
    risk: "medium",
    detail: "Needs verified headless approval events before this can be honest user approval.",
    isDefault: false,
  },
  {
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Runs Cursor with writes enabled inside Cursor's sandbox.",
    status: "available",
    risk: "medium",
    detail: "Maps to cursor-agent --force --sandbox enabled. Cursor's sandbox applies to Cursor operations; selected MCP tools may have their own side effects.",
    isDefault: false,
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Runs Cursor with broad write and shell access for trusted local work.",
    status: "available",
    risk: "high",
    detail: "Maps to cursor-agent --force --sandbox disabled. Use only for trusted repositories and trusted MCP configurations.",
    isDefault: false,
  },
];

const OPEN_MODEL_PROFILES: DesktopManagedAgentPermissionProfile[] = [
  {
    id: "full_access",
    label: "Full access",
    description: "Runs OpenCode with broad write and shell access against your configured model endpoint.",
    status: "available",
    risk: "high",
    detail: "Maps to OpenCode permission=* allow. Open models vary in tool-call reliability; use only with trusted repos.",
    isDefault: true,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Desktop-mediated approvals are not wired for OpenCode agents yet.",
    status: "gated",
    risk: "medium",
    detail: "Requires an OpenCode permission bridge before it can be enabled.",
    isDefault: false,
  },
  {
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "OpenCode sandbox presets are not verified for supervised agents yet.",
    status: "gated",
    risk: "medium",
    detail: "The current managed launch uses full access.",
    isDefault: false,
  },
  {
    id: "read_only",
    label: "Read-only",
    description: "A read-only OpenCode profile is not currently wired.",
    status: "gated",
    risk: "low",
    detail: "Requires a verified OpenCode read-only execution boundary.",
    isDefault: false,
  },
];

const PROVIDER_PERMISSION_PROFILES: Record<string, DesktopManagedAgentPermissionProfile[]> = {
  "claude-code": CLAUDE_CODE_PROFILES,
  codex: CODEX_PROFILES,
  cursor: CURSOR_PROFILES,
  "open-model": OPEN_MODEL_PROFILES,
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
  launchMode: "legacy" | "supervised" = "legacy",
): DesktopManagedAgentPermissionProfile {
  const requested = normalizeProfileId(requestedProfileId);
  const profiles = listManagedAgentPermissionProfiles(providerId);
  if (requested && !profiles.some((profile) => profile.id === requested)) {
    throw new Error(`Unknown permission profile '${requested}' for ${providerId}.`);
  }
  const profile = managedAgentPermissionProfileForProvider(providerId, requestedProfileId);
  if (
    launchMode === "supervised"
    && providerId === "codex"
    && profile.id === "ask_before_write"
  ) {
    return {
      ...profile,
      status: "available",
      description: "Requires approval before Codex can run write-capable commands or apply file changes.",
      detail: "Maps to approvalPolicy=on-request and a read-only, network-disabled sandbox.",
    };
  }
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
