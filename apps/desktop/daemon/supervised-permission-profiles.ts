/**
 * Permission profiles at the supervised-runtime boundary.
 *
 * This deliberately does not reuse the desktop-managed provider catalog:
 * a profile can be available for an interactive local worker while still being
 * unsafe or impossible for a background supervised runtime.  Both Inspector
 * projection and daemon admission consume this one definition.
 */
export type SupervisedPermissionProfileStatus = "available" | "gated" | "unsupported";
export type SupervisedPermissionProfile = {
  id: string;
  label: string;
  description: string;
  status: SupervisedPermissionProfileStatus;
  risk: "low" | "medium" | "high";
  detail: string | null;
  isDefault: boolean;
};

const codexProfiles: readonly SupervisedPermissionProfile[] = [
  {
    id: "full_access", label: "Full access",
    description: "Can change files and run commands without asking.",
    status: "available", risk: "high",
    detail: "Commands can access files outside your project. Use only for work you trust.", isDefault: true,
  },
  {
    id: "ask_before_write", label: "Ask before writes",
    description: "Requires approval before Codex can run write-capable commands or apply file changes.",
    status: "available", risk: "medium",
    detail: "Starts with read-only file access and no network access. Requests approval when it needs more access.", isDefault: false,
  },
  {
    id: "auto_review", label: "Auto",
    description: "Lets Codex decide, without asking you, when a command may go beyond its working folder.",
    status: "available", risk: "high",
    detail: "Can change files only in its working folder and temporary folders, with no network access, until Codex approves more. Anything a room message asks for counts as approved, including commands that reach outside your project.", isDefault: false,
  },
  {
    id: "sandboxed_write", label: "Sandboxed writes",
    description: "Restricted file editing is unavailable for Codex here.",
    status: "gated", risk: "medium",
    detail: "Choose another available access level.", isDefault: false,
  },
  {
    id: "read_only", label: "Read-only",
    description: "Read-only access is unavailable for Codex here.",
    status: "gated", risk: "low",
    detail: "Choose another available access level.", isDefault: false,
  },
];

const claudeProfiles: readonly SupervisedPermissionProfile[] = [
  {
    id: "read_only", label: "Read-only",
    description: "Can read and search files, and use LetAgents room tools.",
    status: "available", risk: "low",
    detail: "Cannot change files or run commands. Other Claude settings do not apply.", isDefault: true,
  },
  {
    id: "ask_before_write", label: "Ask before writes",
    description: "Requires approval before Claude can change files or run write-capable commands.",
    status: "available", risk: "medium",
    detail: "Commands that only read the project, its history, or its pull requests run without asking. Each approval allows one action. Other Claude settings do not apply. LetAgents room tools remain available.", isDefault: false,
  },
  {
    id: "auto_review", label: "Auto",
    description: "Lets Claude check each action before it runs. Actions it judges safe run without asking.",
    status: "available", risk: "high",
    detail: "Claude blocks actions it judges risky. Anything a room message asks for counts as approved, including commands that reach outside your project. Other Claude settings do not apply.", isDefault: false,
  },
  {
    id: "full_access", label: "Full access",
    description: "Can change files and run commands on this Mac without asking.",
    status: "available", risk: "high",
    detail: "Commands can access files outside your project. Use only for work you trust.", isDefault: false,
  },
  {
    id: "sandboxed_write", label: "Sandboxed writes",
    description: "Restricted file editing is unavailable for Claude Code here.",
    status: "unsupported", risk: "medium",
    detail: "Choose another available access level.", isDefault: false,
  },
];

const openModelProfiles: readonly SupervisedPermissionProfile[] = [
  {
    id: "full_access", label: "Full access",
    description: "Can change files and run commands without asking.",
    status: "available", risk: "high",
    detail: "Commands can access files outside your project. LetAgents manages room messages and sign-in credentials separately.", isDefault: true,
  },
  {
    id: "ask_before_write", label: "Ask before writes",
    description: "Requires approval before OpenCode can run shell commands or change files.",
    status: "available", risk: "medium",
    detail: "Can read files and use LetAgents room tools without asking. Commands and file changes need approval.", isDefault: false,
  },
  {
    id: "auto_review", label: "Auto",
    description: "Lets LetAgents review each command before it runs. Routine commands and edits to project files run without asking.",
    status: "available", risk: "high",
    detail: "Reading and checking commands are sent to LetAgents and to Jev, a decision model, for review. Committing, fetching, reading pull requests, and pushing to the agent's own LetAgents branch run without asking. A command that deletes, installs, force-pushes, or pushes anywhere else still asks you, and so does an edit to a settings or credentials file. Reading project files and looking things up on the web are not reviewed. The agent's own tools cannot open files outside the project.", isDefault: false,
  },
  {
    id: "sandboxed_write", label: "Sandboxed writes",
    description: "Restricted file editing is unavailable for OpenCode here.",
    status: "gated", risk: "medium",
    detail: "Choose another available access level.", isDefault: false,
  },
  {
    id: "read_only", label: "Read-only",
    description: "Read-only access is unavailable for OpenCode here.",
    status: "gated", risk: "low",
    detail: "Choose another available access level.", isDefault: false,
  },
];

const cursorProfiles: readonly SupervisedPermissionProfile[] = [
  {
    id: "read_only", label: "Read-only", description: "Lets Cursor inspect and answer without editing the workspace.",
    status: "available", risk: "low", detail: "Can inspect project files without changing them.", isDefault: false,
  },
  {
    id: "ask_before_write", label: "Ask before writes", description: "Unavailable because Cursor can edit ordinary workspace files without asking.",
    status: "gated", risk: "medium", detail: "Cursor does not request approval for every workspace edit. Use Read-only to prevent edits, or Workspace writes to allow them.", isDefault: false,
  },
  {
    id: "sandboxed_write", label: "Workspace writes", description: "Can inspect files, edit code, and run project tools in a separate copy of your project.",
    status: "available", risk: "medium", detail: "Cursor restricts file and command access. LetAgents checks for conflicts before copying changes back. Files ignored by Git stay read-only, and project access settings stay protected.", isDefault: true,
  },
  {
    id: "full_access", label: "Workspace writes (compatibility)", description: "Turns off Cursor’s own command restrictions so more project tools can run.",
    status: "available", risk: "high", detail: "Cursor still works in a separate copy and cannot write directly to files on this Mac. LetAgents checks for conflicts before copying changes back. Files ignored by Git are not copied back.", isDefault: false,
  },
];

export function supervisedPermissionProfilesForProvider(providerId: string): SupervisedPermissionProfile[] {
  const provider = providerId.trim().toLowerCase();
  const profiles = provider === "claude-code" || provider === "claude"
    ? claudeProfiles
    : provider === "open-model"
      ? openModelProfiles
      : provider === "codex"
      ? codexProfiles
      : provider === "cursor"
        ? cursorProfiles
        : [];
  return profiles.map((profile) => ({ ...profile }));
}

/**
 * What changes in an access level's description for an agent that uses its
 * owner's own setup. The owner's allow rules, hooks, MCP tools and plugins
 * then apply as well, and some of them act without an approval, so a line
 * that promises an approval for everything would no longer be true.
 */
const OWNER_SETUP_DESCRIPTIONS: Readonly<Record<string, Readonly<Record<string, { description?: string; detail: string }>>>> = {
  "claude-code": {
    read_only: {
      description: "Can read and search files, and use LetAgents room tools and the MCP tools your own Claude Code rules allow.",
      detail: "Its own tools cannot change files or run commands. Your MCP tools and hooks can, where your own Claude Code settings allow them. Nothing asks you.",
    },
    ask_before_write: {
      description: "Asks before Claude changes files or runs write-capable commands, unless your own Claude Code rules already allow them.",
      detail: "Commands that only read the project, its history, or its pull requests run without asking. Each approval allows one action. Your own Claude Code allow rules apply too, and can let the agent act without asking you. Your hooks run as you set them up. LetAgents room tools remain available.",
    },
    auto_review: {
      detail: "Claude blocks actions it judges risky. Anything a room message asks for counts as approved, including commands that reach outside your project. Your own Claude Code allow rules apply first, and your hooks run as you set them up.",
    },
    full_access: {
      detail: "Commands can access files outside your project. Use only for work you trust. While your own setup is on, the project's own Claude settings, hooks, skills, commands and MCP servers are not loaded. Its CLAUDE.md still is.",
    },
  },
  codex: {
    ask_before_write: {
      detail: "Starts with read-only file access and no network access. Requests approval when it needs more access. Your own MCP tools, hooks and plugins are not held to these limits: they run as you, and some run without asking.",
    },
    auto_review: {
      detail: "Can change files only in its working folder and temporary folders, with no network access, until Codex approves more. Anything a room message asks for counts as approved, including commands that reach outside your project. Your own MCP tools, hooks and plugins are not held to these limits: they run as you.",
    },
  },
};

/** The same profiles, described truthfully for an agent that uses its owner's own setup. */
export function describeProfilesWithOwnerSetup(providerId: string, profiles: unknown): unknown {
  const provider = providerId.trim().toLowerCase();
  const descriptions = OWNER_SETUP_DESCRIPTIONS[provider === "claude" ? "claude-code" : provider];
  if (!descriptions || !Array.isArray(profiles)) return profiles;
  return profiles.map((profile) => {
    const id = profile && typeof profile === "object" ? (profile as { id?: unknown }).id : null;
    const described = typeof id === "string" && Object.hasOwn(descriptions, id) ? descriptions[id] : null;
    // Only an access level the agent can actually use is redescribed.
    return described && (profile as { status?: unknown }).status === "available" ? { ...profile, ...described } : profile;
  });
}

export function assertSupervisedPermissionProfileAvailable(providerId: string, requestedId: string | null): string {
  const profiles = supervisedPermissionProfilesForProvider(providerId);
  if (!profiles.length) throw new Error(`Provider '${providerId}' does not expose supervised permission profiles.`);
  const requested = requestedId?.trim() || null;
  const profile = requested
    ? profiles.find((candidate) => candidate.id === requested)
    : profiles.find((candidate) => candidate.isDefault) ?? profiles.find((candidate) => candidate.status === "available");
  if (!profile) throw new Error(`Permission profile '${requested ?? "default"}' is unavailable for supervised ${providerId}.`);
  if (profile.status !== "available") {
    throw new Error(`${profile.label} is unavailable for supervised ${providerId}: ${profile.detail || profile.description}`);
  }
  return profile.id;
}

/**
 * Internet rentals are narrower than trusted local supervised agents. Keep
 * this final daemon-side admission fence independent of renderer/Electron
 * policy so recovery cannot restart an older unsafe rental manifest.
 */
export function assertSupervisedRentalPermissionProfileAvailable(
  providerId: string,
  requestedId: string | null,
): string {
  const provider = providerId.trim().toLowerCase();
  const requested = requestedId?.trim() || null;
  if (provider !== "cursor" || requested !== "sandboxed_write") {
    throw new Error(
      "Rented agents require an explicit verified workspace-rooted permission profile.",
    );
  }
  return assertSupervisedPermissionProfileAvailable(provider, requested);
}
