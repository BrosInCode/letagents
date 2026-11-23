import { redactCredentialText } from "./credential-redaction.js";
import { ManifestConflictError } from "./manifest-store.js";
import { resolveReadyReachedAt } from "./provider-stream-policy.js";
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
    getEntry(entryId: string, activityMode?: "full" | "summary"): Promise<DaemonManifestEntry | undefined>;
    getEntryWithVersion(entryId: string, activityMode?: "full" | "summary"): Promise<{ entry: DaemonManifestEntry; version: number } | undefined>;
    replaceEntry(
      expectedVersion: number,
      entry: DaemonManifestEntry,
      commitFence: CommitFence,
      roomMoveCancellation?: { agentId: string; detail: string },
    ): Promise<{ version: number; entry: DaemonManifestEntry }>;
  };
  authority: {
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

  /**
   * With `readsNoActivity`, the callback promises to read no activity event and
   * to depend only on the entry it is given (it may run twice, so it must reset
   * any state it sets). The first run gets the entry without its activity: the
   * `activity` property is a non-enumerable getter that throws, so a callback
   * that reads it fails at once (spreading the entry is safe). When the
   * callback returns that entry unchanged, a summary read is returned, and its
   * `activity` is only the short summary window, not the full stored list.
   * When it returns a change, the full entry is read inside the same lock and
   * the callback runs again on it, so the committed write always starts from
   * the full committed row. Callers of this option must not use the returned
   * entry's activity.
   */
  async updateEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
    roomMoveCancellation?: { agentId: string; detail: string },
    options?: { readsNoActivity?: boolean },
  ): Promise<DaemonManifestEntry> {
    return this.ports.authority.serializeMutation(async () => {
      await this.ports.authority.assertCurrent();
      if (options?.readsNoActivity) {
        const scalars = await this.ports.store.getEntry(entryId, "summary");
        if (!scalars) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
        const guarded = Object.defineProperty({ ...scalars }, "activity", {
          enumerable: false,
          get(): never { throw new Error("An update that declares readsNoActivity read the entry's activity."); },
        }) as DaemonManifestEntry;
        if (update(guarded) === guarded) return scalars;
      }
      const loaded = await this.ports.store.getEntryWithVersion(entryId);
      if (!loaded) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      const updated = update(loaded.entry);
      if (updated === loaded.entry) return loaded.entry;
      const next = await this.ports.store.replaceEntry(
        loaded.version,
        updated,
        this.ports.authority.fenceCommit,
        roomMoveCancellation,
      );
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
    expectedVersion?: number,
  ): Promise<void> {
    return this.ports.authority.serializeMutation(() =>
      this.transitionOnce(
        entryId,
        to,
        condition,
        cause,
        actor,
        reconciliation,
        undefined,
        undefined,
        undefined,
        expectedVersion,
      ));
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
    commitFence?: CommitFence,
    expectedVersion?: number,
  ): Promise<void> {
    await this.ports.authority.assertCurrent();
    const loaded = await this.ports.store.getEntryWithVersion(entryId);
    if (!loaded) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    if (expectedVersion !== undefined && loaded.version !== expectedVersion) {
      throw new ManifestConflictError(
        `Daemon manifest entry ${entryId} changed from version ${expectedVersion} to ${loaded.version}.`,
      );
    }
    const entry = loaded.entry;
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
    // Cursor runs no process between turns, so no runtime fact marks it ready
    // while it starts: its first one comes with its first turn and finds it
    // idle. Reaching idle after a launch is its ready mark.
    const readyReachedAt = entry.provider === "cursor"
      ? resolveReadyReachedAt({ ...entry, observed_state: to, condition }, false, new Date().toISOString())
      : null;
    const updated: DaemonManifestEntry = {
      ...entry,
      observed_state: to,
      condition,
      last_error: lastError,
      ...(readyReachedAt ? { ready_reached_at: readyReachedAt } : {}),
      reconciliation: nextReconciliation,
      reconciliation_notices: notices.slice(-32),
    };
    const next = await this.ports.store.replaceEntry(
      loaded.version,
      updated,
      commitFence ?? this.ports.authority.fenceCommit,
    );
    await this.ports.authority.serializeCommit(async () => {
      await this.ports.authority.assertCurrent();
      await this.ports.audit.append({
        at: new Date().toISOString(),
        entry_id: entryId,
        from: entry.observed_state,
        to,
        cause: safeCause,
        actor: safeActor,
        generation: next.version,
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
