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
    description: "Runs with the trusted local access policy already selected for this agent.",
    status: "available", risk: "high",
    detail: "Maps to approvalPolicy=never and sandboxPolicy=dangerFullAccess.", isDefault: true,
  },
  {
    id: "ask_before_write", label: "Ask before writes",
    description: "Requires a provider approval bridge before a background agent can ask safely.",
    status: "gated", risk: "medium",
    detail: "Codex supervised approval bridging is not available yet.", isDefault: false,
  },
  {
    id: "sandboxed_write", label: "Sandboxed writes",
    description: "Requires a verified supervised sandbox launch path.",
    status: "gated", risk: "medium",
    detail: "Codex supervised sandbox presets are not available yet.", isDefault: false,
  },
  {
    id: "read_only", label: "Read-only",
    description: "Requires a verified supervised read-only launch path.",
    status: "gated", risk: "low",
    detail: "Codex supervised read-only mode is not available yet.", isDefault: false,
  },
];

const claudeProfiles: readonly SupervisedPermissionProfile[] = [
  {
    id: "read_only", label: "Read-only",
    description: "Lets Claude inspect with Read, Glob, and Grep while keeping daemon-mediated LetAgents room tools available.",
    status: "available", risk: "low",
    detail: "Write, edit, and shell tools are unavailable, and ambient Claude settings are disabled.", isDefault: true,
  },
  {
    id: "ask_before_write", label: "Ask before writes",
    description: "Would require a live approval conversation between Claude and the desktop.",
    status: "gated", risk: "medium",
    detail: "Claude supervised prompt bridging is not available yet.", isDefault: false,
  },
  {
    id: "full_access", label: "Full access",
    description: "Lets Claude use broad local write and shell access in this trusted workspace.",
    status: "available", risk: "high",
    detail: "Maps to Claude permissionMode=bypassPermissions.", isDefault: false,
  },
  {
    id: "sandboxed_write", label: "Sandboxed writes",
    description: "Claude does not expose a LetAgents-managed sandbox profile here.",
    status: "unsupported", risk: "medium",
    detail: "Choose Read-only or Full access for supervised Claude.", isDefault: false,
  },
];

const openModelProfiles: readonly SupervisedPermissionProfile[] = [
  {
    id: "full_access", label: "Full access",
    description: "Runs OpenCode with broad local write and shell access in this trusted workspace.",
    status: "available", risk: "high",
    detail: "Maps to OpenCode permission=* allow. LetAgents still owns room delivery and credentials.", isDefault: true,
  },
  {
    id: "ask_before_write", label: "Ask before writes",
    description: "Requires a desktop-mediated OpenCode permission bridge.",
    status: "gated", risk: "medium",
    detail: "OpenCode supervised approval bridging is not available yet.", isDefault: false,
  },
  {
    id: "sandboxed_write", label: "Sandboxed writes",
    description: "Requires a verified supervised OpenCode sandbox profile.",
    status: "gated", risk: "medium",
    detail: "OpenCode supervised sandbox presets are not available yet.", isDefault: false,
  },
  {
    id: "read_only", label: "Read-only",
    description: "Requires a verified supervised OpenCode read-only profile.",
    status: "gated", risk: "low",
    detail: "OpenCode supervised read-only mode is not available yet.", isDefault: false,
  },
];

const cursorProfiles: readonly SupervisedPermissionProfile[] = [
  {
    id: "read_only", label: "Read-only", description: "Lets Cursor inspect and answer without editing the workspace.",
    status: "available", risk: "low", detail: "Maps to Cursor mode=ask without --force.", isDefault: false,
  },
  {
    id: "ask_before_write", label: "Ask before writes", description: "Requires prompt bridging and a supervised Cursor runtime.",
    status: "gated", risk: "medium", detail: "Cursor supervised prompt bridging is not available yet.", isDefault: false,
  },
  {
    id: "sandboxed_write", label: "Workspace writes", description: "Lets Cursor inspect, edit source files, and run repository tools in a private turn workspace.",
    status: "available", risk: "medium", detail: "Cursor's native sandbox stays enabled. LetAgents reconciles conflict-checked, nonignored file edits after the turn; ignored dependencies stay read-only and project authority files stay protected.", isDefault: true,
  },
  {
    id: "full_access", label: "Workspace writes (compatibility)", description: "Disables Cursor's inner sandbox for repository tool compatibility.",
    status: "available", risk: "high", detail: "Disables Cursor's native sandbox inside the same private turn workspace. Direct host writes remain blocked; only conflict-checked, nonignored file edits are carried back.", isDefault: false,
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
