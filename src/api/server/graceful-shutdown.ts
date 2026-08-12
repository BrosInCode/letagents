import type { EventEmitter } from "node:events";
import type { Server } from "node:http";

export interface GracefulShutdownDeps {
  stopIntake: () => Promise<void>;
  stopWorkers: () => Promise<void>;
  stopBridge: () => Promise<void>;
  closeBroker: () => void;
  drainConnections?: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  exit?: (code: number) => void;
  onError?: (error: unknown) => void;
  forceClose?: () => void;
  timeoutMs?: number;
}

type SignalSource = Pick<EventEmitter, "on" | "off">;

/**
 * Stop accepting HTTP work while periodically retiring sockets that become
 * idle after broker-owned SSE/poll responses close. A single early
 * `closeIdleConnections()` call misses exactly that transition and can leave
 * `server.close()` waiting through the keep-alive timeout.
 */
export function closeHttpServerIntake(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let idleSweep: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      settled = true;
      if (idleSweep) clearInterval(idleSweep);
      idleSweep = null;
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    };
    server.close(finish);
    const closeIdle = () => server.closeIdleConnections?.();
    closeIdle();
    if (!settled) idleSweep = setInterval(closeIdle, 25);
  });
}

/**
 * Owns one idempotent shutdown generation. Signals stop new HTTP work first,
 * then drain background producers and bridged publishes before releasing the
 * broker and database. `dispose` makes module restart/test reload leak-free.
 */
export function createGracefulShutdownController(
  deps: GracefulShutdownDeps,
  signalSource: SignalSource = process,
) {
  let shutdownPromise: Promise<void> | null = null;
  let installed = false;
  const timeoutMs = Math.max(1, deps.timeoutMs ?? 15_000);

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    const graceful = (async () => {
      const intakeStopped = deps.stopIntake();
      await Promise.all([
        deps.stopWorkers(),
        deps.stopBridge(),
      ]);
      // Closing broker subscriptions lets long-lived SSE/poll responses finish,
      // which in turn allows Server.close() to resolve without a shutdown
      // deadlock.
      deps.closeBroker();
      await intakeStopped;
      await deps.drainConnections?.();
      await deps.closeDatabase();
    })();
    shutdownPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { deps.forceClose?.(); } catch { /* best-effort hard stop */ }
        reject(new Error(`Graceful shutdown exceeded ${timeoutMs}ms.`));
      }, timeoutMs);
      void graceful.then(
        () => { clearTimeout(timeout); resolve(); },
        (error) => { clearTimeout(timeout); reject(error); },
      );
    });
    return shutdownPromise;
  };

  const handleSignal = () => {
    void shutdown().then(
      () => deps.exit?.(0),
      (error) => {
        deps.onError?.(error);
        deps.exit?.(1);
      },
    );
  };

  return {
    shutdown,
    install() {
      if (installed) return;
      installed = true;
      signalSource.on("SIGTERM", handleSignal);
      signalSource.on("SIGINT", handleSignal);
    },
    dispose() {
      if (!installed) return;
      installed = false;
      signalSource.off("SIGTERM", handleSignal);
      signalSource.off("SIGINT", handleSignal);
    },
  };
}
