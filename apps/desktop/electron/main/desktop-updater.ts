import type { DesktopUpdateStatus } from "../ipc-types.js";

const supportedDesktopUpdateArchitectures = new Set(["arm64", "x64"]);

export function desktopUpdateFeedBaseUrl(arch: string): string | null {
  if (!supportedDesktopUpdateArchitectures.has(arch)) return null;
  return `https://github.com/BrosInCode/letagents/releases/download/desktop-feed-${arch}`;
}

export interface DesktopUpdaterControllerOptions {
  currentVersion: string;
  supported: boolean;
  unsupportedReason?: string | null;
  checkForUpdates: () => void | Promise<unknown>;
  prepareForInstall: () => Promise<void>;
  recoverAfterInstallFailure?: () => Promise<void>;
  quitAndInstall: () => void;
  publish?: (status: DesktopUpdateStatus) => void;
  now?: () => Date;
}

export interface DesktopDownloadedUpdate {
  releaseName?: string | null;
  releaseNotes?: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown update error");
}

export function versionFromReleaseName(releaseName: string | null | undefined): string | null {
  const match = String(releaseName || "").match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match?.[1] || null;
}

export class DesktopUpdaterController {
  private status: DesktopUpdateStatus;
  private readonly options: DesktopUpdaterControllerOptions;
  private installOperation: Promise<DesktopUpdateStatus> | null = null;

  constructor(options: DesktopUpdaterControllerOptions) {
    this.options = options;
    this.status = this.withCapabilities({
      phase: options.supported ? "idle" : "unsupported",
      currentVersion: options.currentVersion,
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      lastCheckedAt: null,
      error: null,
      unsupportedReason: options.supported
        ? null
        : options.unsupportedReason || "Automatic updates are unavailable in this build.",
      canCheck: false,
      canInstall: false,
    });
  }

  getStatus(): DesktopUpdateStatus {
    return { ...this.status };
  }

  isInstalling(): boolean {
    return this.status.phase === "installing";
  }

  async check(): Promise<DesktopUpdateStatus> {
    if (!this.options.supported || ["installing", "downloading", "ready"].includes(this.status.phase)) {
      return this.getStatus();
    }
    this.update({ phase: "checking", error: null });
    try {
      await this.options.checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
    return this.getStatus();
  }

  install(): Promise<DesktopUpdateStatus> {
    if (this.installOperation) return this.installOperation;
    if (this.status.phase !== "ready") return Promise.resolve(this.getStatus());
    this.installOperation = this.installOnce().finally(() => {
      this.installOperation = null;
    });
    return this.installOperation;
  }

  markChecking(): void {
    if (!this.options.supported || this.status.phase === "installing") return;
    this.update({ phase: "checking", error: null });
  }

  markAvailable(): void {
    if (!this.options.supported || this.status.phase === "installing") return;
    this.update({ phase: "downloading", error: null });
  }

  markUpToDate(): void {
    if (!this.options.supported || this.status.phase === "installing") return;
    this.update({
      phase: "up-to-date",
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      lastCheckedAt: this.options.now?.().toISOString() || new Date().toISOString(),
      error: null,
    });
  }

  markDownloaded(update: DesktopDownloadedUpdate): void {
    if (!this.options.supported || this.status.phase === "installing") return;
    const releaseName = update.releaseName?.trim() || null;
    this.update({
      phase: "ready",
      availableVersion: versionFromReleaseName(releaseName),
      releaseName,
      releaseNotes: update.releaseNotes?.trim() || null,
      lastCheckedAt: this.options.now?.().toISOString() || new Date().toISOString(),
      error: null,
    });
  }

  fail(error: unknown): void {
    if (!this.options.supported || this.status.phase === "installing") return;
    this.update({
      phase: "error",
      error: errorMessage(error),
      lastCheckedAt: this.options.now?.().toISOString() || new Date().toISOString(),
    });
  }

  private async installOnce(): Promise<DesktopUpdateStatus> {
    this.update({ phase: "installing", error: null });
    let handoffCompleted = false;
    try {
      await this.options.prepareForInstall();
      handoffCompleted = true;
      this.options.quitAndInstall();
    } catch (error) {
      let detail = errorMessage(error);
      if (handoffCompleted && this.options.recoverAfterInstallFailure) {
        try {
          await this.options.recoverAfterInstallFailure();
        } catch (recoveryError) {
          detail = `${detail} Supervisor recovery also failed: ${errorMessage(recoveryError)}`;
        }
      }
      this.update({ phase: "ready", error: detail });
    }
    return this.getStatus();
  }

  private update(patch: Partial<DesktopUpdateStatus>): void {
    this.status = this.withCapabilities({ ...this.status, ...patch });
    this.options.publish?.(this.getStatus());
  }

  private withCapabilities(status: DesktopUpdateStatus): DesktopUpdateStatus {
    return {
      ...status,
      canCheck: this.options.supported && !["checking", "downloading", "ready", "installing"].includes(status.phase),
      canInstall: status.phase === "ready",
    };
  }
}
