import type {
  DesktopSupervisorRetirementEvent,
  DesktopSupervisorRetirementInput,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorRetirementReceipt,
} from "../ipc-types.js";

interface ActiveRetirement {
  daemonGeneration: number;
  operationIds: Set<string>;
}

export interface SupervisorRetirementOperationDependencies {
  retire: (entryId: string, daemonGeneration: number) => Promise<void>;
  emit: (event: DesktopSupervisorRetirementEvent) => void;
  now?: () => Date;
}

/** Durable completion requires both halves of the authority boundary: the
 * daemon has stopped and cleared its exact worker binding, and daemon-inbox
 * host authority has a durable remote-revocation acknowledgement. */
export function desktopRetirementDurablyCompleted(
  entry: DesktopSupervisorManifestEntry,
  hostGrantRevocationAttested: boolean,
): boolean {
  return entry.desiredState === "stopped"
    && entry.observedState === "stopped"
    && entry.agentSessionId === null
    && entry.agentSessionBindingState !== "active"
    && (entry.deliveryMode !== "daemon_inbox" || hostGrantRevocationAttested);
}

function assertRetirementInput(input: DesktopSupervisorRetirementInput): void {
  if (!input || typeof input !== "object"
    || typeof input.operationId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.operationId)
    || typeof input.entryId !== "string"
    || !input.entryId.trim()
    || input.entryId !== input.entryId.trim()
    || !Number.isSafeInteger(input.daemonGeneration)
    || input.daemonGeneration < 1) {
    throw new Error("Retirement submission requires exact typed coordinates.");
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Agent retirement could not be completed.";
}

/**
 * Accepts retirement without holding renderer IPC open for provider shutdown,
 * worker-session fencing, or server revocation. One entry has one underlying
 * operation, while repeated clicks receive their own correlated completion
 * event and share the idempotent work.
 */
export class SupervisorRetirementOperations {
  private readonly active = new Map<string, ActiveRetirement>();
  private readonly now: () => Date;

  constructor(private readonly dependencies: SupervisorRetirementOperationDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  start(input: DesktopSupervisorRetirementInput): DesktopSupervisorRetirementReceipt {
    assertRetirementInput(input);
    const existing = this.active.get(input.entryId);
    if (existing) {
      if (existing.daemonGeneration !== input.daemonGeneration) {
        throw new Error("Agent retirement is already continuing under another supervisor generation.");
      }
      existing.operationIds.add(input.operationId);
      return { ...input, status: "accepted" };
    }

    const operation: ActiveRetirement = {
      daemonGeneration: input.daemonGeneration,
      operationIds: new Set([input.operationId]),
    };
    this.active.set(input.entryId, operation);
    void Promise.resolve()
      .then(() => this.dependencies.retire(input.entryId, input.daemonGeneration))
      .then(
        () => this.finish(input.entryId, operation, "completed", null),
        (error) => this.finish(input.entryId, operation, "failed", errorDetail(error)),
      );
    return { ...input, status: "accepted" };
  }

  private finish(
    entryId: string,
    operation: ActiveRetirement,
    status: DesktopSupervisorRetirementEvent["status"],
    error: string | null,
  ): void {
    if (this.active.get(entryId) !== operation) return;
    this.active.delete(entryId);
    const occurredAt = this.now().toISOString();
    for (const operationId of operation.operationIds) {
      try {
        this.dependencies.emit({
          operationId,
          entryId,
          daemonGeneration: operation.daemonGeneration,
          status,
          error,
          occurredAt,
        });
      } catch {
        // Window teardown can race completion. Durable lifecycle + grant state
        // remains authoritative and is queried when a renderer reconnects.
      }
    }
  }
}
