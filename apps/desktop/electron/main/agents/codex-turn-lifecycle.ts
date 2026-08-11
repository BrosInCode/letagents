import type { RpcNotification } from "./codex-rpc-client.js";

export const CODEX_TURN_LIFECYCLE_WATCHDOG_MS = 30_000;

export type CodexTurnLifecycleSignal =
  | { kind: "terminal"; status: string }
  | { kind: "activity" }
  | { kind: "disconnect" }
  | { kind: "watchdog" };

type PendingTurnSignal = {
  resolve: (signal: CodexTurnLifecycleSignal) => void;
  timer: ReturnType<typeof setTimeout>;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function notificationTurnId(value: unknown): string | null {
  const root = recordValue(value);
  const nested = recordValue(root?.turn);
  const candidate = root?.turnId ?? root?.turn_id ?? nested?.id;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function notificationThreadId(value: unknown): string | null {
  const root = recordValue(value);
  const nested = recordValue(root?.thread);
  const candidate = root?.threadId ?? root?.thread_id ?? nested?.id;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function exactTurnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

/**
 * Correlates Codex lifecycle notifications to one exact thread/turn pair.
 * Terminal edges are retained briefly so a completion racing the turn/start
 * response cannot be lost before its waiter is installed.
 */
export class CodexTurnLifecycleObserver {
  private readonly terminalTurns = new Map<string, string>();
  private readonly pending = new Map<string, PendingTurnSignal>();
  private disconnected = false;

  observe(notification: RpcNotification): void {
    const turnId = notificationTurnId(notification.params);
    const threadId = notificationThreadId(notification.params);
    if (!turnId || !threadId || !/^(?:turn|item)\//i.test(notification.method)) {
      return;
    }

    const key = exactTurnKey(threadId, turnId);
    // Unknown future terminal names intentionally fall through to the watchdog
    // and authoritative thread read instead of being trusted as terminal.
    const terminal = /^turn\/(completed|interrupted|failed|cancelled|stopped)$/i.exec(
      notification.method,
    );
    if (terminal) {
      const status = terminal[1]!.toLowerCase();
      if (!this.settle(key, { kind: "terminal", status })) {
        this.terminalTurns.set(key, status);
        while (this.terminalTurns.size > 64) {
          this.terminalTurns.delete(this.terminalTurns.keys().next().value!);
        }
      }
      return;
    }

    this.settle(key, { kind: "activity" });
  }

  notifyDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const key of [...this.pending.keys()]) {
      this.settle(key, { kind: "disconnect" });
    }
  }

  waitForTurn(
    threadId: string,
    turnId: string,
    watchdogMs = CODEX_TURN_LIFECYCLE_WATCHDOG_MS,
  ): Promise<CodexTurnLifecycleSignal> {
    const key = exactTurnKey(threadId, turnId);
    if (this.disconnected) {
      return Promise.resolve({ kind: "disconnect" });
    }
    const terminal = this.terminalTurns.get(key);
    if (terminal) {
      this.terminalTurns.delete(key);
      return Promise.resolve({ kind: "terminal", status: terminal });
    }
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`Codex turn ${turnId} already has a lifecycle waiter.`));
    }

    return new Promise<CodexTurnLifecycleSignal>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.get(key)?.timer !== timer) return;
        this.pending.delete(key);
        resolve({ kind: "watchdog" });
      }, watchdogMs);
      this.pending.set(key, { resolve, timer });
    });
  }

  private settle(key: string, signal: CodexTurnLifecycleSignal): boolean {
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(signal);
    return true;
  }
}
