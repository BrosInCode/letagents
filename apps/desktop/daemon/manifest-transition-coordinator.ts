import { redactCredentialText } from "./credential-redaction.js";
import { advanceReconciliationState } from "./reconciler-state.js";
import type {
  DaemonManifestEntry,
  ExecutionTerminalPayload,
  ObservedState,
  PolicyCondition,
  ReconciliationNotice,
} from "./types.js";

type CommitFence = (commit: () => Promise<void>) => Promise<void>;

export type ManifestTransitionPorts = {
  store: {
    getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
    replaceEntry(
      expectedGeneration: number,
      entry: DaemonManifestEntry,
      commitFence: CommitFence,
      roomMoveCancellation?: { agentId: string; detail: string },
    ): Promise<{ generation: number; entry: DaemonManifestEntry }>;
  };
  authority: {
    currentManifestGeneration(): number;
    acceptManifestGeneration(generation: number): void;
    assertCurrent(): Promise<void>;
    serializeMutation<T>(operation: () => Promise<T>): Promise<T>;
    serializeCommit<T>(operation: () => Promise<T>): Promise<T>;
    fenceCommit: CommitFence;
  };
  audit: {
    append(event: {
      at: string;
      entry_id: string;
      from: ObservedState;
      to: ObservedState;
      cause: string;
      actor: string;
      generation: number;
    }): Promise<void>;
  };
  nowMs(): number;
};

/** Owns generic fenced manifest mutation and observed-state transitions. */
export class ManifestTransitionCoordinator {
  constructor(private readonly ports: ManifestTransitionPorts) {}

  async updateEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
    roomMoveCancellation?: { agentId: string; detail: string },
  ): Promise<DaemonManifestEntry> {
    return this.ports.authority.serializeMutation(async () => {
      await this.ports.authority.assertCurrent();
      const entry = await this.ports.store.getEntry(entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      const updated = update(entry);
      if (updated === entry) return entry;
      const next = await this.ports.store.replaceEntry(
        this.ports.authority.currentManifestGeneration(),
        updated,
        this.ports.authority.fenceCommit,
        roomMoveCancellation,
      );
      this.ports.authority.acceptManifestGeneration(next.generation);
      return next.entry;
    });
  }

  async transition(
    entryId: string,
    to: ObservedState,
    condition: PolicyCondition,
    cause: string,
    actor: string,
    reconciliation?: DaemonManifestEntry["reconciliation"],
  ): Promise<void> {
    return this.ports.authority.serializeMutation(() =>
      this.transitionOnce(entryId, to, condition, cause, actor, reconciliation));
  }

  async transitionOnce(
    entryId: string,
    to: ObservedState,
    condition: PolicyCondition,
    cause: string,
    actor: string,
    reconciliation?: DaemonManifestEntry["reconciliation"],
    notice?: ReconciliationNotice["kind"],
    terminal?: ExecutionTerminalPayload,
  ): Promise<void> {
    await this.ports.authority.assertCurrent();
    const entry = await this.ports.store.getEntry(entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    const safeCause = redactCredentialText(cause).value;
    const safeActor = redactCredentialText(actor).value;
    const candidateReconciliation = reconciliation
      ?? advanceReconciliationState(entry.reconciliation, to, this.ports.nowMs());
    const nextReconciliation = {
      ...candidateReconciliation,
      last_terminal: sanitizeTerminal(candidateReconciliation.last_terminal),
    };
    const safeTerminal = sanitizeTerminal(terminal);
    const noticeKind = notice
      ?? (condition === "quarantined"
        ? "quarantine_death"
        : condition === "coordination_blocked"
          ? "coordination_escalation"
          : undefined);
    const notices = (entry.reconciliation_notices ?? []).map((candidate) => ({
      ...candidate,
      cause: redactCredentialText(candidate.cause).value,
      terminal: sanitizeTerminal(candidate.terminal),
    }));
    if (noticeKind) {
      notices.push({
        at: new Date().toISOString(),
        kind: noticeKind,
        cause: safeCause,
        terminal: safeTerminal ?? nextReconciliation.last_terminal ?? undefined,
      });
    }
    const lastError = to === "failed" || condition !== "none"
      ? safeCause
      : ["working", "idle", "stopped"].includes(to)
        ? null
        : entry.last_error === null || entry.last_error === undefined
          ? null
          : redactCredentialText(entry.last_error).value;
    const updated: DaemonManifestEntry = {
      ...entry,
      observed_state: to,
      condition,
      last_error: lastError,
      reconciliation: nextReconciliation,
      reconciliation_notices: notices.slice(-32),
    };
    const next = await this.ports.store.replaceEntry(
      this.ports.authority.currentManifestGeneration(),
      updated,
      this.ports.authority.fenceCommit,
    );
    this.ports.authority.acceptManifestGeneration(next.generation);
    await this.ports.authority.serializeCommit(async () => {
      await this.ports.authority.assertCurrent();
      await this.ports.audit.append({
        at: new Date().toISOString(),
        entry_id: entryId,
        from: entry.observed_state,
        to,
        cause: safeCause,
        actor: safeActor,
        generation: next.generation,
      });
    });
  }
}

function sanitizeTerminal(
  value: ExecutionTerminalPayload | undefined,
): ExecutionTerminalPayload | undefined {
  return value ? {
    ...value,
    signal: value.signal === null ? null : redactCredentialText(value.signal).value,
    stdio_archive_ref: value.stdio_archive_ref === null
      ? null
      : redactCredentialText(value.stdio_archive_ref).value,
    stdio_tail: redactCredentialText(value.stdio_tail, 64 * 1024).value,
    terminal_cause: redactCredentialText(value.terminal_cause).value,
    actor: redactCredentialText(value.actor).value,
    provider_continuation_id: value.provider_continuation_id === null
      ? null
      : redactCredentialText(value.provider_continuation_id).value,
  } : undefined;
}
