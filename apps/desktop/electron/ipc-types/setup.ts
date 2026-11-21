import type {
  DesktopMcpInstallConfigPath,
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
} from "#provider-runtime/desktop-types.js";
export type {
  DesktopMcpInstallConfigPath,
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
} from "#provider-runtime/desktop-types.js";

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

export interface DesktopMcpInstallFailure {
  targetId: DesktopMcpInstallTargetId | null;
  targetName: string;
  configPath: string | null;
  configLabel: string | null;
  message: string;
}

export interface DesktopMcpInstallManyResult {
  success: boolean;
  targets: DesktopMcpInstallTarget[];
  installState: DesktopMcpInstallState;
  failures: DesktopMcpInstallFailure[];
  message: string;
}
