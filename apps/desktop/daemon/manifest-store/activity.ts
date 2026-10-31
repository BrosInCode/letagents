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
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entries: DaemonManifestEntry[] }> {
    const normalized = entries.map(canonicalManifestEntry);
    if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
      throw new Error("Targeted manifest batch contains duplicate agent ids.");
    }
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const findOrder = database.prepare("SELECT sort_order FROM agent_identities WHERE agent_id = ?");
      const remove = database.prepare("DELETE FROM agent_identities WHERE agent_id = ?");
      for (const entry of normalized) {
        const row = findOrder.get(entry.id) as Row | undefined;
        if (!row) throw new Error(`Unknown daemon manifest entry: ${entry.id}`);
        const configuration = database.prepare("SELECT * FROM agent_configurations WHERE agent_id=?").get(entry.id) as Row;
        const projection = projectDaemonManifestEntry(entry);
        this.preserveInspectorConfiguration(projection, configuration);
        run(remove, entry.id);
        this.insertProjection(database, projection, Number(row.sort_order));
      }
      return normalized.map((entry) => {
        const persisted = this.readEntryFromDatabase(database, entry.id);
        if (!persisted) throw new Error(`Daemon manifest batch entry disappeared during replacement: ${entry.id}`);
        return persisted;
      });
    }, commitFence);
    return { generation: result.generation, entries: result.value };
  },

  /** Deletes only the durable manifest identity. Callers must first prove purge preconditions. */
  async removeEntry(
    expectedGeneration: number,
    agentId: string,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number }> {
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      run(database.prepare("DELETE FROM turn_control_sequence_watermarks WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM reconciliation_action_tombstones WHERE agent_id=?"), agentId);
      const deleted = database.prepare("DELETE FROM agent_identities WHERE agent_id=?").run(agentId);
      if (Number(deleted.changes) !== 1) throw new Error(`Unknown daemon manifest entry: ${agentId}`);
      return undefined;
    }, commitFence);
    return { generation: result.generation };
  },

  async markRuntimeConfigurationApplied(expectedGeneration: number, input: { agentId: string; executionGenerationId: string; appliedRevision: number }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<{ generation: number; configuration: StoredAgentConfiguration }> {
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const row = database.prepare(`SELECT c.config_revision,c.runtime_configuration_revision,d.provider_execution_generation_id FROM agent_configurations c JOIN runtime_deployments d USING(agent_id) WHERE c.agent_id=?`).get(input.agentId) as Row | undefined;
      if (!row || row.provider_execution_generation_id !== input.executionGenerationId) throw new ManifestConflictError("Provider execution changed before its configuration revision was applied.");
      if (!Number.isSafeInteger(input.appliedRevision) || input.appliedRevision < 1 || input.appliedRevision > Number(row.config_revision)) throw new Error("Applied runtime configuration revision is invalid.");
      if (Number(row.runtime_configuration_revision) > input.appliedRevision) throw new ManifestConflictError("Runtime configuration revision cannot move backwards.");
      run(database.prepare("UPDATE agent_configurations SET runtime_configuration_revision=? WHERE agent_id=?"), input.appliedRevision, input.agentId);
    }, commitFence);
    const configuration = await this.getAgentConfiguration(input.agentId);
    if (!configuration) throw new Error("Agent disappeared after runtime configuration apply.");
    return { generation: result.generation, configuration };
  },

  async getActivityState(agentId: string): Promise<{
    observed_state: DaemonManifestEntry["observed_state"]; last_sequence: number;
  } | undefined> {
    const database = await this.getDatabase();
    const row = this.reads.get(database, "activityState").get(agentId, agentId) as Row | undefined;
    return row ? { observed_state: String(row.observed_state) as DaemonManifestEntry["observed_state"],
      last_sequence: row.last_sequence == null ? -1 : Number(row.last_sequence) } : undefined;
  },

  /** Persist presentation detail without acquiring any runtime lifecycle field. */
  async appendActivityOnly(
    expectedGeneration: number,
    agentId: string,
    event: DaemonActivityEvent,
    limit = 200,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }> {
    const result = await this.writeActivity(expectedGeneration, agentId, event, null, limit,
      database => this.activityEntry(database, agentId), commitFence);
    return { generation: result.generation, entry: result.value };
  },

  /** Native stream consumers do not need a fresh full-history return value. */
  async recordActivity(
    expectedGeneration: number,
    agentId: string,
    event: DaemonActivityEvent,
    runtimeUpdate: { observedState: DaemonManifestEntry["observed_state"];
      nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]> } | null,
    limit = 200,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number }> {
    const result = await this.writeActivity(expectedGeneration, agentId, event, runtimeUpdate, limit,
      () => undefined, commitFence);
    return { generation: result.generation };
  },

  /**
   * Writes several admitted activity events in one transaction, in the given
   * order, with one generation bump. Each event is applied exactly as
   * recordActivity applies it. An event whose entry is gone, or whose sequence
   * is no longer newer than the stored one, is skipped rather than failing the
   * other agents' events in the same batch.
   */
  async recordActivityBatch(
    expectedGeneration: number,
    items: readonly ActivityWrite[],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
    /** Checked inside the transaction; an event of an entry it refuses is skipped. */
    mayWrite?: (agentId: string) => boolean,
  ): Promise<{ generation: number; written: number; skipped: number; events: CommittedActivityWrite[] }> {
    const normalized = items.map((item) => {
      const encoded = json(item.event);
      return { ...item, event: parseJson<DaemonActivityEvent>(encoded), bytes: encoded.length };
    });
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const written: CommittedActivityWrite[] = [];
      for (const item of normalized) {
        if (mayWrite && !mayWrite(item.agentId)) continue;
        const latest = this.reads.get(database, "lastSequence").get(item.agentId) as Row | undefined;
        if (latest && item.event.sequence <= Number(latest.sequence)) continue;
        if (!this.applyActivityRuntime(database, item.agentId, item.runtimeUpdate)) continue;
        this.appendActivityEvent(database, item.agentId, item.event, item.limit);
        written.push({ agentId: item.agentId, event: committedActivityEvent(item.event), limit: item.limit, bytes: item.bytes });
      }
      return written;
    }, commitFence);
    return { generation: result.generation, written: result.value.length,
      skipped: items.length - result.value.length, events: result.value };
  },

  applyActivityRuntime(database: DatabaseSync, agentId: string, runtimeUpdate: ActivityRuntimeUpdate | null): boolean {
    const updated = runtimeUpdate
      ? database.prepare(`UPDATE runtime_deployments
          SET observed_state = ?, native_liveness_present = 1, native_liveness_state = ?,
              native_liveness_observed_at = ?, native_liveness_detail = ?, activity_present = 1
          WHERE agent_id = ?`).run(runtimeUpdate.observedState, runtimeUpdate.nativeLiveness.state,
        runtimeUpdate.nativeLiveness.observed_at ?? null, runtimeUpdate.nativeLiveness.detail ?? null, agentId)
      : database.prepare("UPDATE runtime_deployments SET activity_present = 1 WHERE agent_id = ?").run(agentId);
    return Number(updated.changes) === 1;
  },

  activityEntry(database: DatabaseSync, agentId: string): DaemonManifestEntry {
    const persisted = this.readEntryFromDatabase(database, agentId);
    if (!persisted) throw new Error(`Daemon manifest entry disappeared during activity append: ${agentId}`);
    return persisted;
  },

  writeActivity<T>(
    expectedGeneration: number,
    agentId: string,
    event: DaemonActivityEvent,
    runtimeUpdate: { observedState: DaemonManifestEntry["observed_state"];
      nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]> } | null,
    limit: number,
    project: (database: DatabaseSync) => T,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; value: T }> {
    const normalizedEvent = parseJson<DaemonActivityEvent>(json(event));
    return this.writeTargeted(expectedGeneration, database => {
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
    expectedGeneration: number,
    agentId: string,
    liveness: NonNullable<DaemonManifestEntry["workplace_liveness"]>,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }> {
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const updated = database.prepare(`
        UPDATE runtime_deployments
        SET workplace_liveness_present = 1, workplace_liveness_state = ?,
            workplace_liveness_observed_at = ?, workplace_liveness_detail = ?
        WHERE agent_id = ?
      `).run(liveness.state, liveness.observed_at ?? null, liveness.detail ?? null, agentId);
      if (Number(updated.changes) !== 1) throw new Error(`Unknown daemon manifest entry: ${agentId}`);
      const persisted = this.readEntryFromDatabase(database, agentId);
      if (!persisted) throw new Error(`Daemon manifest entry disappeared during liveness update: ${agentId}`);
      return persisted;
    }, commitFence);
    return { generation: result.generation, entry: result.value };
  },
});
