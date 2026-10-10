import type {
  DesktopAgentProviderId,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
} from "../../ipc-types.js";

const CLAUDE_CODE_PROFILES: DesktopManagedAgentPermissionProfile[] = [
  {
    id: "read_only",
    label: "Read-only",
    description: "Can read and search files, and use LetAgents room tools.",
    status: "available",
    risk: "low",
    detail: "Cannot change files or run commands. Other Claude settings do not apply.",
    isDefault: true,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Allows read tools and asks in the room or desktop UI before write, edit, or shell tools.",
    status: "gated",
    risk: "medium",
    detail: "Approval requests are unavailable in this connection mode.",
    isDefault: false,
  },
  {
    id: "auto_review",
    label: "Auto",
    description: "Automatic review is unavailable for Claude Code in this connection mode.",
    status: "gated",
    risk: "high",
    detail: "Choose another available access level.",
    isDefault: false,
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Can change files and run commands on this Mac without asking.",
    status: "available",
    risk: "high",
    detail: "Cannot use LetAgents tools to manage rooms, rentals, or access.",
    isDefault: false,
  },
  {
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Restricted file editing is unavailable for Claude Code here.",
    status: "unsupported",
    risk: "medium",
    detail: "Choose Read-only to prevent changes, or Full access to allow them.",
    isDefault: false,
  },
];

const CODEX_PROFILES: DesktopManagedAgentPermissionProfile[] = [
  {
    id: "full_access",
    label: "Full access",
    description: "Can change files and run commands on this Mac without asking.",
    status: "available",
    risk: "high",
    detail: "Commands can access files outside the project. Use only for work you trust.",
    isDefault: true,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Approval requests are unavailable for Codex in this connection mode.",
    status: "gated",
    risk: "medium",
    detail: "Choose another available access level.",
    isDefault: false,
  },
  {
    id: "auto_review",
    label: "Auto",
    description: "Automatic review is unavailable for Codex in this connection mode.",
    status: "gated",
    risk: "high",
    detail: "Choose another available access level.",
    isDefault: false,
  },
  {
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Restricted file editing is unavailable for Codex here.",
    status: "gated",
    risk: "medium",
    detail: "Full access allows file changes and commands without asking.",
    isDefault: false,
  },
  {
    id: "read_only",
    label: "Read-only",
    description: "Read-only access is unavailable for Codex here.",
    status: "gated",
    risk: "low",
    detail: "Choose another available access level.",
    isDefault: false,
  },
];

const CURSOR_PROFILES: DesktopManagedAgentPermissionProfile[] = [
  {
    id: "read_only",
    label: "Read-only",
    description: "Can answer room messages and inspect files without editing them.",
    status: "available",
    risk: "low",
    detail: "Runs Cursor in ask mode without workspace edits.",
    isDefault: true,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Unavailable because Cursor can edit ordinary workspace files without asking.",
    status: "gated",
    risk: "medium",
    detail: "Cursor does not request approval for every workspace edit. Use Read-only to prevent edits, or a write profile to allow them.",
    isDefault: false,
  },
  {
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Runs Cursor with writes enabled inside Cursor's sandbox.",
    status: "available",
    risk: "medium",
    detail: "Cursor restricts its own file and command access. Connected tools can still make changes outside those restrictions.",
    isDefault: false,
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Runs Cursor with broad write and shell access for trusted local work.",
    status: "available",
    risk: "high",
    detail: "Can change files and run commands outside the project without asking. Use only with projects and connected tools you trust.",
    isDefault: false,
  },
];

const OPEN_MODEL_PROFILES: DesktopManagedAgentPermissionProfile[] = [
  {
    id: "full_access",
    label: "Full access",
    description: "Can change files and run commands using your chosen model.",
    status: "available",
    risk: "high",
    detail: "Runs without asking and can access files outside the project. Model reliability varies; use only for work you trust.",
    isDefault: true,
  },
  {
    id: "ask_before_write",
    label: "Ask before writes",
    description: "Approval requests are unavailable for OpenCode in this connection mode.",
    status: "gated",
    risk: "medium",
    detail: "Choose another available access level.",
    isDefault: false,
  },
  {
    id: "auto_review",
    label: "Auto",
    description: "Automatic review is unavailable for OpenCode in this connection mode.",
    status: "gated",
    risk: "high",
    detail: "Choose another available access level.",
    isDefault: false,
  },
  {
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Restricted file editing is unavailable for OpenCode here.",
    status: "gated",
    risk: "medium",
    detail: "Full access allows file changes and commands without asking.",
    isDefault: false,
  },
  {
    id: "read_only",
    label: "Read-only",
    description: "Read-only access is unavailable for OpenCode here.",
    status: "gated",
    risk: "low",
    detail: "Choose another available access level.",
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
  if (launchMode === "supervised" && profile.id === "auto_review" && providerId === "open-model") {
    return { ...profile, status: "available",
      description: "Lets LetAgents review each command before it runs. Routine commands and edits to project files run without asking.",
      detail: "Reading and checking commands are sent to LetAgents and to Jev, a decision model, for review. Committing, fetching, reading pull requests, and pushing to the agent's own LetAgents branch run without asking. A command that deletes, installs, force-pushes, or pushes anywhere else still asks you, and so does an edit to a settings or credentials file. Reading project files and looking things up on the web are not reviewed. The agent's own tools cannot open files outside the project." };
  }
  if (launchMode === "supervised" && profile.id === "auto_review" && (providerId === "claude-code" || providerId === "codex")) {
    return providerId === "claude-code"
      ? { ...profile, status: "available",
        description: "Lets Claude check each action before it runs. Actions it judges safe run without asking.",
        detail: "Claude blocks actions it judges risky. Anything a room message asks for counts as approved, including commands that reach outside your project. Other Claude settings do not apply." }
      : { ...profile, status: "available",
        description: "Lets Codex decide, without asking you, when a command may go beyond its working folder.",
        detail: "Can change files only in its working folder and temporary folders, with no network access, until Codex approves more. Anything a room message asks for counts as approved, including commands that reach outside your project." };
  }
  if (launchMode === "supervised" && providerId === "claude-code" && profile.id === "ask_before_write") {
    return { ...profile, status: "available",
      description: "Requires approval before Claude can change files or run write-capable commands.",
      detail: "Commands that only read the project, its history, or its pull requests run without asking. Each approval allows one action. Other Claude settings do not apply. LetAgents room tools remain available." };
  }
  if (launchMode === "supervised" && providerId === "codex" && profile.id === "read_only") {
    return { ...profile, status: "available", risk: "medium",
      description: "Can read files on this Mac, also outside your project, and read and post in the room.",
      detail: "Cannot change files. Its commands cannot use the network, and web search is off. Its commands cannot read your Codex sign-in file. It asks for no approval: a command that needs more is refused. Your saved Codex command rules do not apply to it. It cannot change the task board, join rooms or submit reviews." };
  }
  if (
    launchMode === "supervised"
    && (providerId === "codex" || providerId === "open-model")
    && profile.id === "ask_before_write"
  ) {
    const openModel = providerId === "open-model";
    return {
      ...profile,
      status: "available",
      description: openModel
        ? "Requires approval before OpenCode can run shell commands or change files."
        : "Requires approval before Codex can run write-capable commands or apply file changes.",
      detail: openModel
        ? "Can read files and use LetAgents room tools without asking. Commands and file changes need approval."
        : "Starts with read-only file access and no network access. Requests approval when it needs more access.",
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
