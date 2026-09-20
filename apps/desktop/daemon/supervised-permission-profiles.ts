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
    detail: "Each approval allows one action. Other Claude settings do not apply. LetAgents room tools remain available.", isDefault: false,
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
