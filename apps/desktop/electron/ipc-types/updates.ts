export type DesktopUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "downloading"
  | "up-to-date"
  | "ready"
  | "installing"
  | "error";

export interface DesktopUpdateStatus {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  lastCheckedAt: string | null;
  error: string | null;
  unsupportedReason: string | null;
  canCheck: boolean;
  canInstall: boolean;
}
