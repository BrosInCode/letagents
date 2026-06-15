export type DesktopMcpInstallTargetId = "claude-code" | "antigravity" | "cursor" | "codex";

export interface DesktopMcpInstallOptions {
  cwd?: string | null;
}

export interface DesktopMcpInstallTarget {
  id: DesktopMcpInstallTargetId;
  name: string;
  description: string;
  configPath: string;
  status: "not_installed" | "installed" | "needs_attention";
  lastInstalledAt: string | null;
  restartHint: string;
}

export interface DesktopMcpInstallState {
  completed: boolean;
  completedAt: string | null;
  selectedTargetId: DesktopMcpInstallTargetId | null;
  targets: DesktopMcpInstallTarget[];
}

export interface DesktopMcpInstallResult {
  success: boolean;
  target: DesktopMcpInstallTarget;
  installState: DesktopMcpInstallState;
  message: string;
}

export interface DesktopMcpInstallManyResult {
  success: boolean;
  targets: DesktopMcpInstallTarget[];
  installState: DesktopMcpInstallState;
  message: string;
}
