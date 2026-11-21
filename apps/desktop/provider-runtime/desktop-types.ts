// Types that the provider runtime and the desktop app share. They were in
// electron/ipc-types, which still exports each of them by the same name.
// The provider runtime cannot import from the Electron folder, so their one
// definition is here.

export type DesktopMcpInstallTargetId = "claude-code" | "antigravity" | "cursor" | "codex";

export interface DesktopMcpInstallConfigPath {
  path: string;
  label: string;
  status: "not_installed" | "installed" | "needs_attention";
  hasLetAgents: boolean;
  issue: string | null;
}

export interface DesktopMcpInstallTarget {
  id: DesktopMcpInstallTargetId;
  name: string;
  description: string;
  configPath: string;
  configPaths: DesktopMcpInstallConfigPath[];
  configIssue: string | null;
  status: "not_installed" | "installed" | "needs_attention";
  lastInstalledAt: string | null;
  restartHint: string;
}

export type DesktopAgentProviderId =
  | "claude-code"
  | "antigravity"
  | "cursor"
  | "codex"
  | "open-model"
  | (string & {});

export type DesktopCursorMcpPolicy =
  | "filter_letagents"
  | "normal"
  | "none";

export type DesktopManagedAgentPermissionProfileId =
  | "read_only"
  | "ask_before_write"
  | "auto_review"
  | "sandboxed_write"
  | "full_access"
  | (string & {});

export type DesktopManagedAgentPermissionProfileStatus =
  | "available"
  | "gated"
  | "unsupported";

export type DesktopManagedAgentPermissionProfileRisk =
  | "low"
  | "medium"
  | "high";

export interface DesktopManagedAgentPermissionProfile {
  id: DesktopManagedAgentPermissionProfileId;
  label: string;
  description: string;
  status: DesktopManagedAgentPermissionProfileStatus;
  risk: DesktopManagedAgentPermissionProfileRisk;
  detail: string | null;
  isDefault: boolean;
}

export interface DesktopOpenModelSettingsStatus {
  configured: boolean;
  hasApiKey: boolean;
  baseUrl: string;
  model: string;
  savedAt: string | null;
  settingsPath: string;
  error: string | null;
  contextWindow?: number | null;
}

export interface DesktopOpenModelSaveSettingsInput {
  baseUrl?: string | null;
  model?: string | null;
  /** A string saves a new key, null clears the saved key, undefined keeps the current key. */
  apiKey?: string | null;
  contextWindow?: number | null;
}

export interface DesktopAgentCommitIdentitySettings {
  /** True when the owner chose to keep the host's own Git identity for agent commits. */
  useHostGitIdentity: boolean;
  /** The signed-in GitHub account's noreply identity, or null when no GitHub account is known. */
  githubIdentity: { name: string; email: string } | null;
}
