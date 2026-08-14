import type {
  DesktopSupervisorQuitAgent,
  DesktopSupervisorQuitPreparation,
} from "./supervisor-daemon.js";

export type DesktopActiveAgentQuitChoice = "keep_running" | "stop_and_quit" | "cancel";
export type DesktopQuitFailureChoice = "quit_anyway" | "cancel";

export interface DesktopQuitEvent {
  preventDefault(): void;
}

export interface DesktopQuitCoordinatorOptions {
  prepareDaemonIfIdle: () => Promise<DesktopSupervisorQuitPreparation>;
  stopAgentsAndPrepareDaemon: (
    agents: readonly DesktopSupervisorQuitAgent[],
  ) => Promise<Exclude<DesktopSupervisorQuitPreparation, { outcome: "active" }>>;
  chooseForActiveAgents: (agents: readonly DesktopSupervisorQuitAgent[]) => Promise<DesktopActiveAgentQuitChoice>;
  chooseAfterFailure: (error: Error) => Promise<DesktopQuitFailureChoice>;
  cleanup: () => Promise<void>;
  quit: () => void;
  bypassForUpdate: () => boolean;
  cleanupTimeoutMs?: number;
  reportError?: (error: unknown) => void;
}

const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 5_000;

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error || "Unknown quit error"));
}

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Desktop cleanup timed out.")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Owns the re-entrant Electron before-quit handshake. */
export class DesktopQuitCoordinator {
  private allowQuit = false;
  private operation: Promise<void> | null = null;
  private cleanupStarted = false;

  constructor(private readonly options: DesktopQuitCoordinatorOptions) {}

  handleBeforeQuit(event: DesktopQuitEvent): void {
    if (this.allowQuit || this.options.bypassForUpdate()) {
      this.startCleanupBestEffort();
      return;
    }
    event.preventDefault();
    if (this.operation) return;
    this.operation = this.coordinateQuit().finally(() => {
      this.operation = null;
    });
  }

  private async coordinateQuit(): Promise<void> {
    try {
      const preparation = await this.options.prepareDaemonIfIdle();
      if (preparation.outcome === "active") {
        const choice = await this.options.chooseForActiveAgents(preparation.activeAgents);
        if (choice === "cancel") return;
        if (choice === "stop_and_quit") {
          await this.options.stopAgentsAndPrepareDaemon(preparation.activeAgents);
        }
      }
      await this.finishQuit();
    } catch (error) {
      const normalized = errorValue(error);
      this.options.reportError?.(normalized);
      try {
        if (await this.options.chooseAfterFailure(normalized) === "quit_anyway") {
          await this.finishQuit();
        }
      } catch (dialogError) {
        this.options.reportError?.(dialogError);
      }
    }
  }

  private async finishQuit(): Promise<void> {
    try {
      await within(
        this.options.cleanup(),
        this.options.cleanupTimeoutMs ?? DEFAULT_QUIT_CLEANUP_TIMEOUT_MS,
      );
    } catch (error) {
      this.options.reportError?.(error);
    }
    this.cleanupStarted = true;
    this.allowQuit = true;
    this.options.quit();
  }

  private startCleanupBestEffort(): void {
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    void this.options.cleanup().catch((error) => this.options.reportError?.(error));
  }
}
