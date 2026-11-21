/**
 * Batch entry replacement and removal, runtime configuration, activity writes and workplace liveness.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import type { DatabaseSync } from "node:sqlite";
import { projectDaemonManifestEntry } from "../manifest-entry-projection.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";
import { type Row, type ActivityRuntimeUpdate, type ActivityWrite, type CommittedActivityWrite, type StoredAgentConfiguration, ManifestConflictError, json, parseJson, committedActivityEvent, canonicalManifestEntry, run, storeMethods } from "./shared.js";

export const activity = storeMethods({
  async replaceEntriesBatch(
    expectedVersions: Readonly<Record<string, number>>,
    entries: DaemonManifestEntry[],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ versions: Record<string, number>; entries: DaemonManifestEntry[] }> {
    const normalized = entries.map(canonicalManifestEntry);
    if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
      throw new Error("Targeted manifest batch contains duplicate agent ids.");
    }
    return this.writeOperationalJournal((database) => {
      const versions: Record<string, number> = {};
      for (const entry of normalized) {
        const expectedVersion = expectedVersions[entry.id];
        const existingRow = database.prepare("SELECT * FROM agents WHERE agent_id = ?").get(entry.id) as Row | undefined;
        if (!existingRow) throw new Error(`Unknown daemon manifest entry: ${entry.id}`);
        if (expectedVersion === undefined || Number(existingRow.version) !== expectedVersion) {
          throw new ManifestConflictError(`Agent ${entry.id} version ${String(existingRow.version)} does not match expected ${String(expectedVersion)}.`);
        }
        const projection = projectDaemonManifestEntry(entry);
        this.updateProjection(database, projection, existingRow, expectedVersion);
        versions[entry.id] = expectedVersion + 1;
      }
      const persistedEntries = normalized.map((entry) => {
        const persisted = this.readEntryFromDatabase(database, entry.id);
        if (!persisted) throw new Error(`Daemon manifest batch entry disappeared during replacement: ${entry.id}`);
        return persisted;
      });
      return { versions, entries: persistedEntries };
    }, commitFence);
  },

  /** Deletes only the durable agent row (and cascading child rows). Callers must first prove purge preconditions. */
  async removeEntry(
    expectedVersion: number,
    agentId: string,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ version: number }> {
    const result = await this.writeAgent(agentId, expectedVersion, (database) => {
      const deleted = database.prepare("DELETE FROM agents WHERE agent_id=? AND version=?").run(agentId, expectedVersion);
      if (Number(deleted.changes) !== 1) throw new ManifestConflictError(`Agent ${agentId} version changed before removal.`);
      return undefined;
    }, commitFence, { bumpVersion: false });
    return { version: result.version };
  },

  async markRuntimeConfigurationApplied(
    expectedVersion: number,
    input: { agentId: string; executionGenerationId: string; appliedRevision: number },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ version: number; configuration: StoredAgentConfiguration }> {
    const result = await this.writeAgent(input.agentId, expectedVersion, (database, row) => {
      if (row.provider_execution_generation_id !== input.executionGenerationId) {
        throw new ManifestConflictError("Provider execution changed before its configuration revision was applied.");
      }
      if (!Number.isSafeInteger(input.appliedRevision) || input.appliedRevision < 1 || input.appliedRevision > Number(row.config_revision)) {
        throw new Error("Applied runtime configuration revision is invalid.");
      }
      if (Number(row.runtime_configuration_revision) > input.appliedRevision) {
        throw new ManifestConflictError("Runtime configuration revision cannot move backwards.");
      }
      run(database.prepare("UPDATE agents SET runtime_configuration_revision=? WHERE agent_id=?"), input.appliedRevision, input.agentId);
    }, commitFence);
    const configuration = await this.getAgentConfiguration(input.agentId);
    if (!configuration) throw new Error("Agent disappeared after runtime configuration apply.");
    return { version: result.version, configuration };
  },

  async getActivityState(agentId: string): Promise<{
    version: number; observed_state: DaemonManifestEntry["observed_state"]; last_sequence: number;
  } | undefined> {
    const database = await this.getDatabase();
    const row = this.reads.get(database, "activityState").get(agentId, agentId) as Row | undefined;
    return row ? { version: Number(row.version), observed_state: String(row.observed_state) as DaemonManifestEntry["observed_state"],
      last_sequence: row.last_sequence == null ? -1 : Number(row.last_sequence) } : undefined;
  },

  /** Persist presentation detail without acquiring any runtime lifecycle field. */
  async appendActivityOnly(
    expectedVersion: number,
    agentId: string,
    event: DaemonActivityEvent,
    limit = 200,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ version: number; entry: DaemonManifestEntry }> {
    const result = await this.writeActivity(expectedVersion, agentId, event, null, limit,
      database => this.activityEntry(database, agentId), commitFence);
    return { version: result.version, entry: result.value };
  },

  /** Native stream consumers do not need a fresh full-history return value. */
  async recordActivity(
    expectedVersion: number,
    agentId: string,
    event: DaemonActivityEvent,
    runtimeUpdate: { observedState: DaemonManifestEntry["observed_state"];
      nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]> } | null,
    limit = 200,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ version: number }> {
    const result = await this.writeActivity(expectedVersion, agentId, event, runtimeUpdate, limit,
      () => undefined, commitFence);
    return { version: result.version };
  },

  /**
   * Writes several admitted activity events in one transaction, in the given
   * order. An event whose entry is gone, or whose sequence is no longer newer
   * than the stored one, is skipped rather than failing the other agents'
   * events in the same batch. Per-agent versions mean activity writes for one
   * agent never collide with unrelated agents.
   */
  async recordActivityBatch(
    items: readonly ActivityWrite[],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
    /** Checked inside the transaction; an event of an entry it refuses is skipped. */
    mayWrite?: (agentId: string) => boolean,
  ): Promise<{ written: number; skipped: number; events: CommittedActivityWrite[] }> {
    const normalized = items.map((item) => {
      const encoded = json(item.event);
      return { ...item, event: parseJson<DaemonActivityEvent>(encoded), bytes: encoded.length };
    });
    const events = await this.writeOperationalJournal((database) => {
      const written: CommittedActivityWrite[] = [];
      for (const item of normalized) {
        if (mayWrite && !mayWrite(item.agentId)) continue;
        const latest = this.reads.get(database, "lastSequence").get(item.agentId) as Row | undefined;
        if (latest && item.event.sequence <= Number(latest.sequence)) continue;
        if (!this.applyActivityRuntime(database, item.agentId, item.runtimeUpdate, true)) continue;
        this.appendActivityEvent(database, item.agentId, item.event, item.limit);
        written.push({ agentId: item.agentId, event: committedActivityEvent(item.event), limit: item.limit, bytes: item.bytes });
      }
      return written;
    }, commitFence);
    return { written: events.length, skipped: items.length - events.length, events };
  },

  applyActivityRuntime(
    database: DatabaseSync,
    agentId: string,
    runtimeUpdate: ActivityRuntimeUpdate | null,
    bumpVersion = false,
  ): boolean {
    if (runtimeUpdate) {
      const nativeJson = json({
        state: runtimeUpdate.nativeLiveness.state,
        observed_at: runtimeUpdate.nativeLiveness.observed_at ?? null,
        detail: runtimeUpdate.nativeLiveness.detail ?? null,
      });
      const updated = database.prepare(`UPDATE agents
        SET observed_state = ?, native_liveness_json = ?${bumpVersion ? ", version = version + 1" : ""}
        WHERE agent_id = ?`).run(runtimeUpdate.observedState, nativeJson, agentId);
      return Number(updated.changes) === 1;
    }
    return Boolean(database.prepare("SELECT 1 FROM agents WHERE agent_id = ?").get(agentId));
  },

  activityEntry(database: DatabaseSync, agentId: string): DaemonManifestEntry {
    const persisted = this.readEntryFromDatabase(database, agentId);
    if (!persisted) throw new Error(`Daemon manifest entry disappeared during activity append: ${agentId}`);
    return persisted;
  },

  writeActivity<T>(
    expectedVersion: number,
    agentId: string,
    event: DaemonActivityEvent,
    runtimeUpdate: { observedState: DaemonManifestEntry["observed_state"];
      nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]> } | null,
    limit: number,
    project: (database: DatabaseSync) => T,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ version: number; value: T }> {
    const normalizedEvent = parseJson<DaemonActivityEvent>(json(event));
    return this.writeAgent(agentId, expectedVersion, database => {
      if (!this.applyActivityRuntime(database, agentId, runtimeUpdate)) throw new Error(`Unknown daemon manifest entry: ${agentId}`);
      this.appendActivityEvent(database, agentId, normalizedEvent, limit);
      return project(database);
    }, commitFence);
  },

  appendActivityEvent(
    database: DatabaseSync,
    agentId: string,
    event: DaemonActivityEvent,
    limit: number,
  ): void {
    const latest = this.reads.get(database, "lastSequence").get(agentId) as Row | undefined;
    const lastSequence = latest ? Number(latest.sequence) : -1;
    if (event.sequence <= lastSequence) throw new Error(`Native activity sequence ${event.sequence} is not newer than ${lastSequence}.`);
    const order = Number((database.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM activity_events WHERE agent_id = ?").get(agentId) as Row).next_order);
    run(database.prepare(`
      INSERT INTO activity_events(
        agent_id, sort_order, observed_at, sequence, provider, kind, method, summary,
        status, payload_json, payload_truncated, payload_redacted, durable_payload_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `), agentId, order, event.observed_at, event.sequence, event.provider,
    event.kind, event.method, event.summary, event.status,
    json(event.payload), Number(event.payload_truncated), Number(event.payload_redacted),
    event.durable_payload_ref);
    run(database.prepare(`
      DELETE FROM activity_events
      WHERE agent_id = ? AND sort_order NOT IN (
        SELECT sort_order FROM activity_events WHERE agent_id = ? ORDER BY sort_order DESC LIMIT ?
      )
    `), agentId, agentId, limit);
  },

  async updateWorkplaceLiveness(
    expectedVersion: number,
    agentId: string,
    liveness: NonNullable<DaemonManifestEntry["workplace_liveness"]>,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ version: number; entry: DaemonManifestEntry }> {
    const result = await this.writeAgent(agentId, expectedVersion, (database) => {
      const workplaceJson = json({
        state: liveness.state,
        observed_at: liveness.observed_at ?? null,
        detail: liveness.detail ?? null,
      });
      const updated = database.prepare(`UPDATE agents SET workplace_liveness_json = ? WHERE agent_id = ?`)
        .run(workplaceJson, agentId);
      if (Number(updated.changes) !== 1) throw new Error(`Unknown daemon manifest entry: ${agentId}`);
      const persisted = this.readEntryFromDatabase(database, agentId);
      if (!persisted) throw new Error(`Daemon manifest entry disappeared during liveness update: ${agentId}`);
      return persisted;
    }, commitFence);
    return { version: result.version, entry: result.value };
  },
});
