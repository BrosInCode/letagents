export type DesktopUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "downloading"
  | "up-to-date"
  | "ready"
  | "installing"
  | "error";

export interface DesktopUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface DesktopUpdateStatus {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  /** Signed full-archive size from the release manifest. */
  updateSize: number | null;
  /** Current network transfer. This can be smaller than updateSize for differential updates. */
  downloadProgress: DesktopUpdateProgress | null;
  lastCheckedAt: string | null;
  error: string | null;
  failureStage: "check" | "download" | "install" | null;
  downloadAttempt: number | null;
  downloadAttemptLimit: number | null;
  unsupportedReason: string | null;
  /**
   * Whether this build installs code-signed releases whose signature the
   * update path checks. False for an unsigned build (Windows today).
   */
  releaseSigned: boolean;
  /**
   * Whether running agents keep running while an update installs. False on
   * Windows: the installer stops the process-tree helpers that own them.
   */
  agentsSurviveInstall: boolean;
  canCheck: boolean;
  canInstall: boolean;
}
