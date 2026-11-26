import type { DesktopUpdateProgress, DesktopUpdateStatus } from "../ipc-types.js";

const supportedDesktopUpdateArchitectures = new Set(["arm64", "x64"]);
const supportedWindowsUpdateArchitectures = new Set(["x64"]);
const DEFAULT_DOWNLOAD_ATTEMPT_LIMIT = 3;

/**
 * macOS feeds are named by architecture (`feeds/arm64`, `feeds/x64`); the
 * Windows feed names the platform too (`feeds/win32-x64`), so the two x64
 * feeds never share a folder. Matches createDesktopUpdaterConfig in
 * electron/scripts/release-metadata.mjs.
 */
export function desktopUpdateFeedBaseUrl(arch: string, platform: string = "darwin"): string | null {
  if (platform === "win32") {
    if (!supportedWindowsUpdateArchitectures.has(arch)) return null;
    return `https://downloads.letagents.chat/desktop/feeds/win32-${arch}`;
  }
  if (platform !== "darwin") return null;
  if (!supportedDesktopUpdateArchitectures.has(arch)) return null;
  return `https://downloads.letagents.chat/desktop/feeds/${arch}`;
}

/**
 * Whether a packaged app-update.yml names a publisherName. electron-updater's
 * NsisUpdater checks an installer's Authenticode signature only then, so it
 * is the Windows build's own record of whether its releases are signed.
 * package-artifact.mjs writes the file as JSON, which is also YAML.
 */
export function updaterConfigNamesPublisher(config: string): boolean {
  return /(?:^|[{,])\s*["']?publisherName["']?\s*:/m.test(config);
}

export interface DesktopDownloadedUpdate {
  releaseName?: string | null;
  releaseNotes?: string | null;
}

export interface DesktopAvailableUpdate extends DesktopDownloadedUpdate {
  version?: string | null;
  total?: number | null;
}

export interface DesktopUpdateCheckResult extends DesktopAvailableUpdate {
  isUpdateAvailable: boolean;
}

export type DesktopUpdateDiagnosticEvent = {
  event:
    | "check_started"
    | "check_retry_scheduled"
    | "check_failed"
    | "update_not_available"
    | "update_available"
    | "download_started"
    | "download_retry_scheduled"
    | "download_failed"
    | "download_completed"
    | "install_started"
    | "install_failed";
  stage?: "check" | "download" | "install";
  attempt?: number;
  attemptLimit?: number;
  delayMs?: number;
  version?: string | null;
  detail?: string;
};

export interface DesktopUpdaterControllerOptions {
  currentVersion: string;
  supported: boolean;
  unsupportedReason?: string | null;
  /** The build installs code-signed releases. Defaults to false. */
  releaseSigned?: boolean;
  /** Running agents keep running while an update installs. Defaults to true. */
  agentsSurviveInstall?: boolean;
  checkForUpdates: () => Promise<DesktopUpdateCheckResult | null>;
  downloadUpdate: () => Promise<unknown>;
  prepareForInstall: () => Promise<void>;
  recoverAfterInstallFailure?: () => Promise<void>;
  quitAndInstall: () => void;
  publish?: (status: DesktopUpdateStatus) => void;
  diagnostic?: (event: DesktopUpdateDiagnosticEvent) => void;
  transportAttemptLimit?: number;
  retryDelayMs?: (nextAttempt: number) => number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => Date;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, Math.max(0, delayMs));
    timeout.unref?.();
  });
}

function defaultRetryDelayMs(nextAttempt: number): number {
  return nextAttempt <= 2 ? 1_000 : 4_000;
}

function normalizeProgress(progress: DesktopUpdateProgress): DesktopUpdateProgress {
  const total = Number.isFinite(progress.total) && progress.total > 0 ? Math.floor(progress.total) : 0;
  const transferred = Number.isFinite(progress.transferred) && progress.transferred > 0
    ? Math.min(Math.floor(progress.transferred), total || Number.MAX_SAFE_INTEGER)
    : 0;
  const derivedPercent = total > 0 ? (transferred / total) * 100 : 0;
  const percent = Number.isFinite(progress.percent) ? progress.percent : derivedPercent;
  return {
    percent: Math.max(0, Math.min(100, percent)),
    transferred,
    total,
    bytesPerSecond: Number.isFinite(progress.bytesPerSecond) && progress.bytesPerSecond > 0
      ? Math.floor(progress.bytesPerSecond)
      : 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown update error");
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : errorMessage(error);
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function errorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number" && Number.isInteger(statusCode)) return statusCode;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const match = code.match(/^HTTP_ERROR_(\d{3})$/);
  return match ? Number(match[1]) : null;
}

export function isRetryableUpdateTransportError(error: unknown): boolean {
  const statusCode = errorStatusCode(error);
  if (statusCode !== null) return retryableHttpStatus(statusCode);
  const detail = errorDetail(error);
  const messageStatus = detail.match(/(?:HTTP status|status)\s+(\d{3})\b/i);
  if (messageStatus && retryableHttpStatus(Number(messageStatus[1]))) return true;
  return /(?:net::ERR_(?:CONNECTION_(?:CLOSED|RESET|ABORTED|TIMED_OUT)|NETWORK_CHANGED|INTERNET_DISCONNECTED|TIMED_OUT|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)|\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETDOWN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE)\b|socket hang up|network error|request timed out|(?:request|response) has been aborted by the server)/i.test(detail);
}

export function versionFromReleaseName(releaseName: string | null | undefined): string | null {
  const match = String(releaseName || "").match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match?.[1] || null;
}

function releaseVersionParts(version: string): number[] | null {
  const match = version.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

/**
 * Whether `candidate` is a newer release than `staged`. An unknown staged
 * version counts as older, so the newest release is staged again.
 */
export function isNewerReleaseVersion(candidate: string, staged: string | null | undefined): boolean {
  if (!staged) return true;
  const next = releaseVersionParts(candidate);
  const current = releaseVersionParts(staged);
  if (!next || !current) return candidate.trim() !== staged.trim();
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== current[index]) return next[index] > current[index];
  }
  return false;
}

export class DesktopUpdaterController {
  private status: DesktopUpdateStatus;
  private readonly options: DesktopUpdaterControllerOptions;
  private checkOperation: Promise<DesktopUpdateStatus> | null = null;
  private installOperation: Promise<DesktopUpdateStatus> | null = null;
  private installRecoveryOperation: Promise<DesktopUpdateStatus> | null = null;
  /** A check of the feed while a downloaded update waits for a restart. */
  private recheckingReady = false;

  constructor(options: DesktopUpdaterControllerOptions) {
    this.options = options;
    this.status = this.withCapabilities({
      phase: options.supported ? "idle" : "unsupported",
      currentVersion: options.currentVersion,
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      updateSize: null,
      downloadProgress: null,
      lastCheckedAt: null,
      error: null,
      failureStage: null,
      downloadAttempt: null,
      downloadAttemptLimit: null,
      unsupportedReason: options.supported
        ? null
        : options.unsupportedReason || "Automatic updates are unavailable in this build.",
      releaseSigned: options.supported && options.releaseSigned === true,
      agentsSurviveInstall: options.agentsSurviveInstall !== false,
      canCheck: false,
      canInstall: false,
    });
  }

  getStatus(): DesktopUpdateStatus {
    return {
      ...this.status,
      downloadProgress: this.status.downloadProgress ? { ...this.status.downloadProgress } : null,
    };
  }

  isInstalling(): boolean {
    return this.status.phase === "installing";
  }

  check(): Promise<DesktopUpdateStatus> {
    if (this.checkOperation) return this.checkOperation;
    if (!this.options.supported || ["installing", "downloading"].includes(this.status.phase)) {
      return Promise.resolve(this.getStatus());
    }
    // A downloaded update still checks the feed: a newer release replaces it,
    // so a restart never installs a version that already has a successor.
    const run = this.status.phase === "ready" ? () => this.recheckWhileReady() : () => this.checkOnce();
    // Defer the provider call until after the owning operation is recorded so
    // even a synchronously emitted electron-updater error is classified once.
    this.checkOperation = Promise.resolve().then(run).finally(() => {
      this.checkOperation = null;
    });
    return this.checkOperation;
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
    this.update({ phase: "checking", error: null, failureStage: null });
  }

  markAvailable(update: DesktopAvailableUpdate = {}): void {
    if (!this.options.supported || this.status.phase === "installing") return;
    const version = update.version?.trim() || null;
    const releaseName = update.releaseName?.trim() || (version ? `LetAgents ${version}` : null);
    const total = Number.isFinite(update.total) && Number(update.total) > 0 ? Math.floor(Number(update.total)) : 0;
    this.update({
      phase: "downloading",
      availableVersion: version || versionFromReleaseName(releaseName),
      releaseName,
      releaseNotes: update.releaseNotes?.trim() || null,
      updateSize: total || null,
      // The signed manifest size describes the complete archive. Differential
      // network bytes are unknown until electron-updater reports real progress.
      downloadProgress: null,
      lastCheckedAt: this.now(),
      error: null,
      failureStage: null,
    });
  }

  markDownloadProgress(progress: DesktopUpdateProgress): void {
    if (!this.options.supported || this.status.phase === "installing") return;
    this.update({
      phase: "downloading",
      downloadProgress: normalizeProgress(progress),
      error: null,
      failureStage: null,
    });
  }

  markUpToDate(): void {
    if (!this.options.supported || this.status.phase === "installing") return;
    this.update({
      phase: "up-to-date",
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      updateSize: null,
      downloadProgress: null,
      lastCheckedAt: this.now(),
      error: null,
      failureStage: null,
      downloadAttempt: null,
      downloadAttemptLimit: null,
    });
  }

  markDownloaded(update: DesktopDownloadedUpdate): void {
    if (!this.options.supported || this.status.phase === "installing") return;
    const releaseName = update.releaseName?.trim() || this.status.releaseName;
    const downloadProgress = this.status.downloadProgress?.total
      ? {
          ...this.status.downloadProgress,
          percent: 100,
          transferred: this.status.downloadProgress.total,
        }
      : this.status.downloadProgress;
    this.update({
      phase: "ready",
      availableVersion: versionFromReleaseName(releaseName) || this.status.availableVersion,
      releaseName,
      releaseNotes: update.releaseNotes?.trim() || this.status.releaseNotes,
      downloadProgress,
      lastCheckedAt: this.now(),
      error: null,
      failureStage: null,
      downloadAttempt: null,
      downloadAttemptLimit: null,
    });
  }

  fail(error: unknown): Promise<DesktopUpdateStatus> {
    if (!this.options.supported) return Promise.resolve(this.getStatus());
    if (this.status.phase === "installing") return this.recoverFromInstallFailure(error);
    // electron-updater emits an error event before rejecting the exact check or
    // download promise. The owning operation classifies that rejection once.
    if (this.checkOperation) return Promise.resolve(this.getStatus());
    if (this.status.phase === "ready") {
      this.update({
        error: this.status.error || errorMessage(error),
        failureStage: "install",
        lastCheckedAt: this.now(),
      });
      return Promise.resolve(this.getStatus());
    }
    return Promise.resolve(this.failOperation(this.status.phase === "downloading" ? "download" : "check", error));
  }

  private async checkOnce(): Promise<DesktopUpdateStatus> {
    this.update({
      phase: "checking",
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      updateSize: null,
      error: null,
      failureStage: null,
      downloadProgress: null,
      downloadAttempt: null,
      downloadAttemptLimit: null,
    });
    this.report({ event: "check_started", stage: "check" });
    const checked = await this.checkFeedWithRetries();
    if (!checked.ok) {
      return this.failOperation("check", checked.error, checked.attempt, checked.attemptLimit);
    }
    const result = checked.result;
    if (!result?.isUpdateAvailable) {
      this.markUpToDate();
      this.report({ event: "update_not_available", stage: "check" });
      return this.getStatus();
    }
    this.markAvailable(result);
    this.report({
      event: "update_available",
      stage: "check",
      version: result.version || versionFromReleaseName(result.releaseName),
    });
    return this.downloadAvailableUpdate();
  }

  /**
   * Check the feed while a downloaded update waits. The downloaded update
   * stays installable during the check and after a failed or empty one. Only
   * a release newer than the downloaded one starts a new download.
   */
  private async recheckWhileReady(): Promise<DesktopUpdateStatus> {
    const stagedVersion = this.status.availableVersion;
    this.recheckingReady = true;
    this.update({});
    this.report({ event: "check_started", stage: "check", version: stagedVersion });
    let checked: Awaited<ReturnType<DesktopUpdaterController["checkFeedWithRetries"]>>;
    try {
      checked = await this.checkFeedWithRetries();
    } finally {
      this.recheckingReady = false;
    }
    // The person chose Restart while the feed was read: install what is ready.
    if (this.status.phase !== "ready") {
      this.update({});
      return this.getStatus();
    }
    if (!checked.ok) {
      this.update({ lastCheckedAt: this.now() });
      this.report({
        event: "check_failed",
        stage: "check",
        attempt: checked.attempt,
        attemptLimit: checked.attemptLimit,
        version: stagedVersion,
        detail: errorDetail(checked.error),
      });
      return this.getStatus();
    }
    const result = checked.result;
    const version = result?.isUpdateAvailable
      ? result.version?.trim() || versionFromReleaseName(result.releaseName)
      : null;
    if (!result || !version || !isNewerReleaseVersion(version, stagedVersion)) {
      this.update({ lastCheckedAt: this.now() });
      this.report({ event: "update_not_available", stage: "check", version: stagedVersion });
      return this.getStatus();
    }
    this.markAvailable(result);
    this.report({ event: "update_available", stage: "check", version });
    return this.downloadAvailableUpdate();
  }

  private async checkFeedWithRetries(): Promise<
    | { ok: true; result: DesktopUpdateCheckResult | null }
    | { ok: false; error: unknown; attempt: number; attemptLimit: number }
  > {
    const attemptLimit = this.transportAttemptLimit();
    const sleep = this.options.sleep ?? defaultSleep;
    const retryDelayMs = this.options.retryDelayMs ?? defaultRetryDelayMs;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return { ok: true, result: await this.options.checkForUpdates() };
      } catch (error) {
        if (attempt >= attemptLimit || !isRetryableUpdateTransportError(error)) {
          return { ok: false, error, attempt, attemptLimit };
        }
        const nextAttempt = attempt + 1;
        const delayMs = Math.max(0, retryDelayMs(nextAttempt));
        this.report({
          event: "check_retry_scheduled",
          stage: "check",
          attempt: nextAttempt,
          attemptLimit,
          delayMs,
          detail: errorDetail(error),
        });
        await sleep(delayMs);
      }
    }
  }

  private async downloadAvailableUpdate(): Promise<DesktopUpdateStatus> {
    const attemptLimit = this.transportAttemptLimit();
    const sleep = this.options.sleep ?? defaultSleep;
    const retryDelayMs = this.options.retryDelayMs ?? defaultRetryDelayMs;
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      this.update({
        phase: "downloading",
        downloadAttempt: attempt,
        downloadAttemptLimit: attemptLimit,
        error: attempt === 1 ? null : this.status.error,
        failureStage: null,
      });
      this.report({
        event: "download_started",
        stage: "download",
        attempt,
        attemptLimit,
        version: this.status.availableVersion,
      });
      try {
        await this.options.downloadUpdate();
        if (this.status.phase !== "ready") this.markDownloaded({});
        this.report({
          event: "download_completed",
          stage: "download",
          attempt,
          attemptLimit,
          version: this.status.availableVersion,
        });
        return this.getStatus();
      } catch (error) {
        if (attempt >= attemptLimit || !isRetryableUpdateTransportError(error)) {
          return this.failOperation("download", error, attempt, attemptLimit);
        }
        const nextAttempt = attempt + 1;
        const delayMs = Math.max(0, retryDelayMs(nextAttempt));
        this.update({
          phase: "downloading",
          error: errorMessage(error),
          failureStage: null,
          downloadProgress: null,
          downloadAttempt: nextAttempt,
          downloadAttemptLimit: attemptLimit,
        });
        this.report({
          event: "download_retry_scheduled",
          stage: "download",
          attempt: nextAttempt,
          attemptLimit,
          delayMs,
          version: this.status.availableVersion,
          detail: errorDetail(error),
        });
        await sleep(delayMs);
      }
    }
    return this.getStatus();
  }

  private failOperation(
    stage: "check" | "download",
    error: unknown,
    attempt?: number,
    attemptLimit?: number,
  ): DesktopUpdateStatus {
    this.update({
      phase: "error",
      error: errorMessage(error),
      failureStage: stage,
      lastCheckedAt: this.now(),
      downloadAttempt: stage === "download" ? attempt ?? this.status.downloadAttempt : null,
      downloadAttemptLimit: stage === "download" ? attemptLimit ?? this.status.downloadAttemptLimit : null,
    });
    this.report({
      event: stage === "download" ? "download_failed" : "check_failed",
      stage,
      attempt,
      attemptLimit,
      version: this.status.availableVersion,
      detail: errorDetail(error),
    });
    return this.getStatus();
  }

  private async installOnce(): Promise<DesktopUpdateStatus> {
    this.update({ phase: "installing", error: null, failureStage: null });
    this.report({ event: "install_started", stage: "install", version: this.status.availableVersion });
    let handoffCompleted = false;
    try {
      await this.options.prepareForInstall();
      handoffCompleted = true;
      this.options.quitAndInstall();
    } catch (error) {
      if (handoffCompleted) {
        return this.recoverFromInstallFailure(error);
      }
      this.update({ phase: "ready", error: errorMessage(error), failureStage: "install" });
      this.report({
        event: "install_failed",
        stage: "install",
        version: this.status.availableVersion,
        detail: errorDetail(error),
      });
    }
    return this.getStatus();
  }

  private recoverFromInstallFailure(error: unknown): Promise<DesktopUpdateStatus> {
    if (this.installRecoveryOperation) return this.installRecoveryOperation;
    this.installRecoveryOperation = this.recoverFromInstallFailureOnce(error).finally(() => {
      this.installRecoveryOperation = null;
    });
    return this.installRecoveryOperation;
  }

  private async recoverFromInstallFailureOnce(error: unknown): Promise<DesktopUpdateStatus> {
    let detail = errorMessage(error);
    if (this.options.recoverAfterInstallFailure) {
      try {
        await this.options.recoverAfterInstallFailure();
      } catch (recoveryError) {
        detail = `${detail} Supervisor recovery also failed: ${errorMessage(recoveryError)}`;
      }
    }
    this.update({ phase: "ready", error: detail, failureStage: "install" });
    this.report({ event: "install_failed", stage: "install", version: this.status.availableVersion, detail });
    return this.getStatus();
  }

  private now(): string {
    return this.options.now?.().toISOString() || new Date().toISOString();
  }

  private transportAttemptLimit(): number {
    const configured = this.options.transportAttemptLimit ?? DEFAULT_DOWNLOAD_ATTEMPT_LIMIT;
    return Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured))
      : DEFAULT_DOWNLOAD_ATTEMPT_LIMIT;
  }

  private report(event: DesktopUpdateDiagnosticEvent): void {
    try {
      this.options.diagnostic?.(event);
    } catch {
      // Diagnostics must never affect updater state or delivery.
    }
  }

  private update(patch: Partial<DesktopUpdateStatus>): void {
    this.status = this.withCapabilities({ ...this.status, ...patch });
    this.options.publish?.(this.getStatus());
  }

  private withCapabilities(status: DesktopUpdateStatus): DesktopUpdateStatus {
    return {
      ...status,
      canCheck: this.options.supported
        && !this.recheckingReady
        && !["checking", "downloading", "installing"].includes(status.phase),
      canInstall: status.phase === "ready",
    };
  }
}
