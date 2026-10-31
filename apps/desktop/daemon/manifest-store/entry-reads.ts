/**
 * Manifest and entry reads, runtime lifecycle authority, and typed lifecycle effects.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import { sameProviderActionConnectionSnapshot } from "../provider-action-port.js";
import { composeDaemonManifestEntry } from "../manifest-entry-projection.js";
import { executionRuntimeStorageIdentity } from "../execution-shadow-store.js";
import { lifecycleAuthorityModeSchema, type LifecycleAuthorityMode } from "../lifecycle-authority-mode.js";
import type { DaemonManifest, DaemonManifestEntry, DaemonProviderConnection } from "../types.js";
import { type Row, type ActivityShape, type PendingTypedLifecycleEffect, type TypedLifecycleEffectInstallation, ManifestConflictError, storeMethods } from "./shared.js";

export const entryReads = storeMethods({
  async load(activityMode: "full" | "summary" = "full"): Promise<DaemonManifest> {
    const database = await this.getDatabase();
    const generation = Number((this.reads.get(database, "generation").get() as Row).generation);
    const entries = (this.reads.get(database, "allEntries").all() as Row[])
      .map((row) => composeDaemonManifestEntry(this.projectionFromRow(database, row, activityMode)));
    return { generation, entries };
  },

  async getEntry(agentId: string, activityMode: "full" | "summary" = "full"): Promise<DaemonManifestEntry | undefined> {
    const database = await this.getDatabase();
    return this.readEntryFromDatabase(database, agentId, activityMode);
  },

  /**
   * One entry as getEntry(agentId, "summary") reads it, and the shape of its
   * whole activity, from the same snapshot. Reads no payloads.
   */
  async getEntrySummaryWithActivityShape(agentId: string): Promise<{ entry: DaemonManifestEntry; activityShape: ActivityShape } | undefined> {
    const database = await this.getDatabase();
    const entry = this.readEntryFromDatabase(database, agentId, "summary");
    if (!entry) return undefined;
    const row = this.reads.get(database, "activityShape").get(agentId, agentId) as Row;
    return { entry, activityShape: {
      count: Number(row.count), sequenceTotal: Number(row.sequence_total),
      firstSequence: row.first_sequence == null ? null : Number(row.first_sequence),
    } };
  },

  async listRoomEntries(roomId: string): Promise<DaemonManifestEntry[]> {
    const database = await this.getDatabase();
    return (this.reads.get(database, "roomEntries").all(roomId) as Row[])
      .map((row) => composeDaemonManifestEntry(this.projectionFromRow(database, row)));
  },

  /**
   * Read the authority frozen onto one exact native process birth. This never
   * consults current release policy and never materializes or relabels a row.
   */
  async readRuntimeLifecycleAuthority(input: {
    agentId: string;
    executionGenerationId: string;
    providerConnection: DaemonProviderConnection;
    configurationRevision: number;
  }): Promise<LifecycleAuthorityMode | null> {
    const snapshot = structuredClone(input);
    if (!snapshot.agentId || !snapshot.executionGenerationId
      || snapshot.providerConnection.pid === null || !snapshot.providerConnection.processIdentity
      || !Number.isSafeInteger(snapshot.configurationRevision) || snapshot.configurationRevision < 1) return null;
    const provider = {
      codex_app_server: "codex",
      claude_cli: "claude-code",
      cursor_cli: "cursor",
      opencode_server: "open-model",
    } as const;
    const runtimeGenerationId = executionRuntimeStorageIdentity(snapshot.agentId,
      snapshot.executionGenerationId, snapshot.providerConnection.kind,
      snapshot.providerConnection.pid, snapshot.providerConnection.processIdentity);
    const row = (await this.getDatabase()).prepare(`SELECT authority_mode FROM execution_runtime_generations
      WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=? AND provider=? AND config_revision=?`)
      .get(snapshot.agentId, snapshot.executionGenerationId, runtimeGenerationId,
        provider[snapshot.providerConnection.kind], snapshot.configurationRevision) as Row | undefined;
    const authority = lifecycleAuthorityModeSchema.safeParse(row?.authority_mode);
    return authority.success ? authority.data : null;
  },

  /** Bounded pending tail; the durable state, not this read, owns retries. */
  async listPendingTypedLifecycleEffects(agentId?: string, limit = 32, afterFactSequence = 0): Promise<PendingTypedLifecycleEffect[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("Lifecycle effect read limit is invalid.");
    if (!Number.isSafeInteger(afterFactSequence) || afterFactSequence < 0) throw new Error("Lifecycle effect cursor is invalid.");
    return this.serialize(async () => {
      const database = await this.getDatabase();
      const rows = database.prepare(`SELECT e.fact_id,e.agent_id,e.fact_sequence,
          e.observer_execution_generation_id,e.observer_runtime_generation_id,e.effect_kind,f.observed_at_ms
        FROM execution_lifecycle_effects e JOIN execution_facts f ON f.fact_id=e.fact_id
        WHERE e.state='pending' AND e.fact_sequence>? AND (? IS NULL OR e.agent_id=?)
        ORDER BY e.fact_sequence LIMIT ?`).all(afterFactSequence, agentId ?? null, agentId ?? null, limit) as Row[];
      return rows.map((row) => ({
        factId: String(row.fact_id), agentId: String(row.agent_id), factSequence: Number(row.fact_sequence),
        observerExecutionGenerationId: String(row.observer_execution_generation_id),
        observerRuntimeGenerationId: String(row.observer_runtime_generation_id),
        effectKind: String(row.effect_kind) as PendingTypedLifecycleEffect["effectKind"],
        observedAtMs: Number(row.observed_at_ms),
      }));
    });
  },

  /** Applies one exact typed lifecycle projection and acknowledges it in the
   * same SQLite transaction. A hard runtime terminal authenticates its own
   * dead birth; live turn effects still require the exact installation. */
  async applyTypedLifecycleEffect(
    expectedGeneration: number,
    effect: PendingTypedLifecycleEffect,
    installation: TypedLifecycleEffectInstallation | null,
    commitFence: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; disposition: "applied" | "superseded" | "settled" | "pending"; entry?: DaemonManifestEntry }> {
    const pending = structuredClone(effect);
    const exact = installation ? structuredClone(installation) : null;
    return this.writeOperationalJournal((database) => {
      const generation = Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton=1").get() as Row).generation);
      const row = database.prepare(`SELECT e.*,f.observed_at_ms,f.domain AS fact_domain,f.state AS fact_state,
          subject.provider AS subject_provider,subject.runtime_state AS subject_runtime_state,
          observer.runtime_state AS observer_runtime_state,
          observer.authority_mode AS durable_observer_authority,
          observer.config_revision AS durable_observer_configuration_revision
        FROM execution_lifecycle_effects e
        JOIN execution_facts f ON f.fact_id=e.fact_id AND f.sequence=e.fact_sequence AND f.agent_id=e.agent_id
        JOIN execution_runtime_generations subject ON subject.agent_id=f.agent_id
          AND subject.execution_generation_id=f.execution_generation_id
          AND subject.runtime_generation_id=f.runtime_generation_id
        LEFT JOIN execution_runtime_generations observer ON observer.agent_id=e.agent_id
          AND observer.execution_generation_id=e.observer_execution_generation_id
          AND observer.runtime_generation_id=e.observer_runtime_generation_id
        WHERE e.fact_id=? AND e.agent_id=? AND e.fact_sequence=?`).get(
        pending.factId, pending.agentId, pending.factSequence,
      ) as Row | undefined;
      if (!row || row.state !== "pending") return { generation, disposition: "settled" as const };
      if (pending.effectKind !== row.effect_kind
        || pending.observerExecutionGenerationId !== row.observer_execution_generation_id
        || pending.observerRuntimeGenerationId !== row.observer_runtime_generation_id) {
        throw new Error("Lifecycle effect installation identity is invalid.");
      }
      const entry = this.readEntryFromDatabase(database, pending.agentId);
      const configuration = database.prepare(`SELECT runtime_configuration_revision
        FROM agent_configurations WHERE agent_id=?`).get(pending.agentId) as Row | undefined;
      const manifestConnection = entry?.provider_ref?.provider_connection;
      const manifestRuntimeId = entry?.provider_ref?.execution_generation_id
        && manifestConnection?.pid !== null && manifestConnection?.pid !== undefined
        && manifestConnection.processIdentity
        ? executionRuntimeStorageIdentity(pending.agentId, entry.provider_ref.execution_generation_id,
          manifestConnection.kind, manifestConnection.pid, manifestConnection.processIdentity)
        : null;
      const terminal = database.prepare(`SELECT terminal_json FROM work_attempt_executions
        WHERE work_attempt_id=? AND execution_generation_id=?`).get(
        entry?.provider_ref?.work_attempt_id ?? "", pending.observerExecutionGenerationId,
      ) as Row | undefined;
      const durableBirth = manifestRuntimeId === pending.observerRuntimeGenerationId
        && entry?.provider_ref?.execution_generation_id === pending.observerExecutionGenerationId
        && row.observer_authority_mode === "typed" && row.subject_authority_mode === "typed"
        && row.durable_observer_authority === "typed";
      const runtimeFailure = pending.effectKind === "manifest_failed";
      const cursorTurnEffect = row.subject_provider === "cursor"
        && row.fact_domain === "turn" && (row.fact_state === "terminal" || row.fact_state === "lost");
      const runtimeReady = pending.effectKind === "manifest_idle"
        && row.fact_domain === "runtime" && row.fact_state === "ready";
      const completedStopTurn = entry?.desired_state === "running"
        && entry.turn_control?.execution_generation_id === entry.provider_ref?.execution_generation_id
        && entry.turn_control?.status === "completed"
        && entry.turn_control?.has_correction === false
        && entry.turn_control?.interrupted === true
        && entry.turn_control?.resumed === false
        && entry.turn_control?.state === "idle";
      const definitivelyStale = !durableBirth
        || (!runtimeFailure && !cursorTurnEffect && (row.subject_runtime_state === "exited"
          || row.observer_runtime_state === "exited" || terminal?.terminal_json !== null))
        || (runtimeReady && !["starting", "recovering"].includes(entry?.observed_state ?? ""))
        || (runtimeFailure && completedStopTurn)
        || entry?.desired_state !== "running" || entry.condition === "quarantined"
        || (entry.delivery_mode ?? "mcp_polling") !== "daemon_inbox";
      const disposedAtMs = Math.max(Number(row.created_at_ms), exact?.disposedAtMs ?? pending.observedAtMs);
      if (definitivelyStale) {
        database.prepare(`UPDATE execution_lifecycle_effects SET state='superseded',disposed_at_ms=?
          WHERE fact_id=? AND state='pending'`).run(disposedAtMs, pending.factId);
        return { generation, disposition: "superseded" as const };
      }
      const durableCursorTurn = cursorTurnEffect && durableBirth
        && row.subject_runtime_state === "exited" && row.observer_runtime_state === "exited";
      if (!exact && !runtimeFailure && !durableCursorTurn) return { generation, disposition: "pending" as const };
      if (!entry?.provider_ref) throw new Error("Lifecycle effect lost its durable provider reference.");
      if (exact && (pending.agentId !== exact.agentId
        || pending.observerExecutionGenerationId !== exact.executionGenerationId
        || exact.providerConnection.pid === null || !exact.providerConnection.processIdentity
        || !Number.isSafeInteger(exact.configurationRevision) || exact.configurationRevision < 1
        || !Number.isSafeInteger(exact.disposedAtMs) || exact.disposedAtMs < 0)) {
        throw new Error("Lifecycle effect installation identity is invalid.");
      }
      const exactBirth = exact ? executionRuntimeStorageIdentity(exact.agentId, exact.executionGenerationId,
        exact.providerConnection.kind, exact.providerConnection.pid!, exact.providerConnection.processIdentity!) === pending.observerRuntimeGenerationId
          && Number(configuration?.runtime_configuration_revision) === exact.configurationRevision
          && entry.work_attempt_id === exact.workAttemptId
          && entry.provider_ref?.work_attempt_id === exact.workAttemptId
          && entry.provider_ref.provider_continuation_id === exact.providerContinuationId
          && entry.provider_ref.execution_generation_id === exact.executionGenerationId
          && sameProviderActionConnectionSnapshot(entry.provider_ref.provider_connection, exact.providerConnection)
        : (runtimeFailure || durableCursorTurn)
          && Number(configuration?.runtime_configuration_revision) === Number(row.durable_observer_configuration_revision)
          && row.subject_runtime_state === "exited" && row.observer_runtime_state === "exited";
      if (!exactBirth) return { generation, disposition: "pending" as const };
      const generationUpdate = database.prepare(`UPDATE manifest_metadata SET generation=generation+1
        WHERE singleton=1 AND generation=?`).run(expectedGeneration);
      if (Number(generationUpdate.changes) !== 1) {
        throw new ManifestConflictError(`Manifest generation ${generation} does not match expected ${expectedGeneration}.`);
      }
      const observedAt = new Date(pending.observedAtMs).toISOString();
      const observedState = pending.effectKind === "manifest_working" ? "working"
        : pending.effectKind === "manifest_failed" ? "failed" : "idle";
      const nativeState = pending.effectKind === "manifest_working" ? "active"
        : pending.effectKind === "manifest_failed" ? "terminal" : "idle";
      const updated = database.prepare(`UPDATE runtime_deployments
        SET observed_state=?,native_liveness_present=1,native_liveness_state=?,
          native_liveness_observed_at=?,native_liveness_detail=? WHERE agent_id=?`).run(
        observedState, nativeState, observedAt,
        pending.effectKind === "manifest_working" ? "Provider turn active"
          : pending.effectKind === "manifest_failed" ? "Provider runtime unavailable"
            : runtimeReady ? "Provider runtime ready" : "Provider turn terminal",
        pending.agentId,
      );
      if (Number(updated.changes) !== 1) throw new Error(`Unknown daemon manifest entry: ${pending.agentId}`);
      if (runtimeReady) {
        const readiness = database.prepare(`UPDATE agent_readiness
          SET ready_reached_at_present=1,ready_reached_at=COALESCE(ready_reached_at,?)
          WHERE agent_id=?`).run(observedAt, pending.agentId);
        if (Number(readiness.changes) !== 1) throw new Error(`Unknown daemon manifest entry: ${pending.agentId}`);
      }
      const acknowledged = database.prepare(`UPDATE execution_lifecycle_effects SET state='applied',disposed_at_ms=?
        WHERE fact_id=? AND state='pending'`).run(disposedAtMs, pending.factId);
      if (Number(acknowledged.changes) !== 1) throw new Error("Lifecycle effect disposition changed before apply.");
      const persisted = this.readEntryFromDatabase(database, pending.agentId);
      if (!persisted) throw new Error(`Daemon manifest entry disappeared during lifecycle effect apply: ${pending.agentId}`);
      return { generation: expectedGeneration + 1, disposition: "applied" as const, entry: persisted };
    }, commitFence);
  },
});
