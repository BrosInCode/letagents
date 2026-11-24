import { normalizeAgentAvatar } from "../../../../shared/agent-avatar.mjs";
/**
 * Entry rows to and from the schema v1 `agents` domain table.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import type { DatabaseSync } from "node:sqlite";
import { MAX_PROJECTED_COMPLETED_ACTION_IDS } from "../reconciler-state.js";
import { STATE_WATCH_ACTIVITY_SUMMARY_LIMIT } from "../state-watch-projection.js";
import { projectDaemonManifestEntry, type DaemonManifestDomainProjection } from "../manifest-entry-projection.js";
import type { DaemonAgentConfiguration, DaemonManifestEntry, DaemonProviderConnection, DaemonProviderRuntimeReference, DaemonTurnControlEffect, DaemonWorkerBindingProjection, ReconciliationNotice, ReconciliationState } from "../types.js";
import { type Row, ManifestConflictError, liveSharingState, bool, nullableString, json, parseJson, activityEventFromRow, canonicalManifestEntry, run, storeMethods } from "./shared.js";

function encodeProjectionValues(
  projection: DaemonManifestDomainProjection,
  durableWatermark: number,
) {
  const {
    identity, profile, membership, configuration, launch_intent: launch,
    runtime_deployment: runtime, lifecycle, readiness, turn_control_journal: turnJournal,
    retained_worker_binding: bindingRecord, reconciliation: reconciliationRecord,
  } = projection;
  const turn = turnJournal.turn_control ?? null;
  if (!Number.isSafeInteger(durableWatermark) || durableWatermark < 0) {
    throw new Error("Turn-control sequence watermark must be a non-negative safe integer.");
  }
  if (turn && (!Number.isSafeInteger(turn.action_sequence) || turn.action_sequence < 1)) {
    throw new Error("Persisted turn control requires a positive exact action sequence.");
  }
  if (turn && turn.action_sequence !== durableWatermark) {
    throw new Error("Persisted turn control does not exactly match its durable sequence watermark.");
  }
  const providerRef = runtime.provider_ref ?? null;
  const policyJson = Object.hasOwn(configuration, "provider_launch_policy")
    && configuration.provider_launch_policy !== undefined
    ? json(configuration.provider_launch_policy)
    : null;
  const reconciliationState = reconciliationRecord.reconciliation
    ? {
      ...reconciliationRecord.reconciliation,
      completed_action_ids: reconciliationRecord.reconciliation.completed_action_ids.slice(-MAX_PROJECTED_COMPLETED_ACTION_IDS),
    }
    : null;
  return {
    agent_id: identity.agent_id,
    created_by: identity.created_by,
    created_at: identity.created_at,
    display_name: profile.display_name,
    avatar_json: profile.avatar ? json(profile.avatar) : null,
    room_id: membership.room_id,
    local_room_id: membership.local_room_id ?? null,
    provider: configuration.provider,
    model: configuration.model,
    reasoning_effort: configuration.reasoning_effort ?? null,
    charter: configuration.charter,
    permission_profile_id: configuration.permission_profile_id,
    config_revision: configuration.config_revision ?? 1,
    runtime_configuration_revision: configuration.runtime_configuration_revision ?? configuration.config_revision ?? 1,
    provider_launch_policy_json: policyJson,
    image_input: configuration.image_input === true ? 1 : 0,
    live_sharing: liveSharingState(configuration.live_sharing),
    desired_state: launch.desired_state,
    source_repo_path: launch.source_repo_path ?? null,
    deployment_id: runtime.deployment_id,
    run_id: runtime.run_id,
    observed_state: runtime.observed_state,
    workspace_path: runtime.workspace_path ?? null,
    work_attempt_id: runtime.work_attempt_id ?? null,
    provider_work_attempt_id: providerRef?.work_attempt_id ?? null,
    provider_continuation_id: providerRef?.provider_continuation_id ?? null,
    provider_execution_generation_id: providerRef?.execution_generation_id ?? null,
    provider_connection_json: providerRef?.provider_connection ? json(providerRef.provider_connection) : null,
    workplace_liveness_json: runtime.workplace_liveness ? json(runtime.workplace_liveness) : null,
    native_liveness_json: runtime.native_liveness ? json(runtime.native_liveness) : null,
    condition: lifecycle.condition,
    last_error: lifecycle.last_error ?? null,
    ready_reached_at: readiness.ready_reached_at ?? null,
    last_turn_control_sequence: durableWatermark,
    turn_control_inbox_item_id: turn?.inbox_item_id ?? null,
    turn_control_status: turn?.status ?? null,
    turn_control_json: turn ? json(turn) : null,
    last_worker_binding_json: bindingRecord.last_worker_binding ? json(bindingRecord.last_worker_binding) : null,
    reconciliation_json: reconciliationState ? json(reconciliationState) : null,
    reconciliation_notices_json: reconciliationRecord.reconciliation_notices !== undefined
      ? json(reconciliationRecord.reconciliation_notices)
      : null,
  };
}

export const projections = storeMethods({
  preserveInspectorConfiguration(projection: DaemonManifestDomainProjection, row: Row): void {
    // Inspector revisions are database-owned and cannot be replaced by stale
    // compatibility manifest fields during lifecycle/runtime updates.
    projection.configuration.provider = String(row.provider);
    projection.configuration.model = nullableString(row.model);
    projection.configuration.reasoning_effort = nullableString(row.reasoning_effort) as DaemonAgentConfiguration["reasoning_effort"];
    projection.configuration.charter = String(row.charter);
    projection.configuration.permission_profile_id = nullableString(row.permission_profile_id);
    projection.configuration.config_revision = Number(row.config_revision);
    projection.configuration.runtime_configuration_revision = Number(row.runtime_configuration_revision);
    projection.configuration.image_input = bool(row.image_input);
    projection.configuration.live_sharing = liveSharingState(row.live_sharing);
    if (row.provider_launch_policy_json !== null && row.provider_launch_policy_json !== undefined) {
      projection.configuration.provider_launch_policy = parseJson(row.provider_launch_policy_json);
    } else {
      delete projection.configuration.provider_launch_policy;
    }
  },

  initializeMintStateIfExplicit(database: DatabaseSync, entry: DaemonManifestEntry): void {
    if (!Object.hasOwn(entry, "last_worker_binding")) return;
    const binding = entry.last_worker_binding ?? null;
    run(database.prepare(`
      INSERT OR IGNORE INTO supervised_worker_mint_states
        (agent_id,room_id,agent_instance_id,phase,agent_session_id,updated_at)
      VALUES (?,?,?,?,?,?)
    `), entry.id, entry.room_id, `daemon:${entry.id}`,
    binding ? "exact" : "never_minted", binding?.agent_session_id ?? null,
    binding?.updated_at ?? new Date().toISOString());
  },

  replaceActivityEvents(database: DatabaseSync, agentId: string, events: DaemonManifestEntry["activity"]): void {
    run(database.prepare("DELETE FROM activity_events WHERE agent_id = ?"), agentId);
    const insertActivity = database.prepare("INSERT INTO activity_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    (events ?? []).forEach((event, index) => run(insertActivity,
      agentId, index, event.observed_at, event.sequence, event.provider, event.kind,
      event.method, event.summary, event.status, json(event.payload), Number(event.payload_truncated),
      Number(event.payload_redacted), event.durable_payload_ref));
  },

  insertProjection(database: DatabaseSync, projection: DaemonManifestDomainProjection, sortOrder: number): void {
    const projectedWatermark = projection.turn_control_journal.last_turn_control_sequence;
    const values = encodeProjectionValues(projection, projectedWatermark);
    run(database.prepare(`
      INSERT INTO agents(
        agent_id, sort_order, version, created_by, created_at, display_name, avatar_json,
        room_id, local_room_id, provider, model, reasoning_effort, charter, permission_profile_id,
        config_revision, runtime_configuration_revision, provider_launch_policy_json,
        image_input, live_sharing, desired_state, source_repo_path,
        deployment_id, run_id, observed_state, workspace_path, work_attempt_id,
        provider_work_attempt_id, provider_continuation_id, provider_execution_generation_id,
        provider_connection_json, workplace_liveness_json, native_liveness_json,
        condition, last_error, ready_reached_at,
        last_turn_control_sequence, turn_control_inbox_item_id, turn_control_status, turn_control_json,
        last_worker_binding_json, reconciliation_json, reconciliation_notices_json
      ) VALUES (${Array.from({ length: 42 }, () => "?").join(", ")})
    `),
      values.agent_id, sortOrder, 1, values.created_by, values.created_at, values.display_name, values.avatar_json,
      values.room_id, values.local_room_id, values.provider, values.model, values.reasoning_effort, values.charter, values.permission_profile_id,
      values.config_revision, values.runtime_configuration_revision, values.provider_launch_policy_json,
      values.image_input, values.live_sharing, values.desired_state, values.source_repo_path,
      values.deployment_id, values.run_id, values.observed_state, values.workspace_path, values.work_attempt_id,
      values.provider_work_attempt_id, values.provider_continuation_id, values.provider_execution_generation_id,
      values.provider_connection_json, values.workplace_liveness_json, values.native_liveness_json,
      values.condition, values.last_error, values.ready_reached_at,
      values.last_turn_control_sequence, values.turn_control_inbox_item_id, values.turn_control_status, values.turn_control_json,
      values.last_worker_binding_json, values.reconciliation_json, values.reconciliation_notices_json);
    this.replaceActivityEvents(database, values.agent_id, projection.runtime_deployment.activity);
  },

  updateProjection(
    database: DatabaseSync,
    projection: DaemonManifestDomainProjection,
    existingRow: Row,
    expectedVersion: number,
    options: { turnControlSequenceOverride?: number; appliedRuntimeRevision?: number } = {},
  ): void {
    this.preserveInspectorConfiguration(projection, existingRow);
    if (options.appliedRuntimeRevision !== undefined) {
      projection.configuration.runtime_configuration_revision = options.appliedRuntimeRevision;
    }
    const durableWatermark = options.turnControlSequenceOverride ?? Number(existingRow.last_turn_control_sequence);
    const values = encodeProjectionValues(projection, durableWatermark);
    const updated = database.prepare(`
      UPDATE agents SET
        version = version + 1,
        created_by = ?, created_at = ?, display_name = ?, avatar_json = ?,
        room_id = ?, local_room_id = ?, provider = ?, model = ?, reasoning_effort = ?,
        charter = ?, permission_profile_id = ?, config_revision = ?, runtime_configuration_revision = ?,
        provider_launch_policy_json = ?, image_input = ?, live_sharing = ?,
        desired_state = ?, source_repo_path = ?,
        deployment_id = ?, run_id = ?, observed_state = ?, workspace_path = ?, work_attempt_id = ?,
        provider_work_attempt_id = ?, provider_continuation_id = ?, provider_execution_generation_id = ?,
        provider_connection_json = ?, workplace_liveness_json = ?, native_liveness_json = ?,
        condition = ?, last_error = ?, ready_reached_at = ?,
        last_turn_control_sequence = ?, turn_control_inbox_item_id = ?, turn_control_status = ?, turn_control_json = ?,
        last_worker_binding_json = ?, reconciliation_json = ?, reconciliation_notices_json = ?
      WHERE agent_id = ? AND version = ?
    `).run(
      values.created_by, values.created_at, values.display_name, values.avatar_json,
      values.room_id, values.local_room_id, values.provider, values.model, values.reasoning_effort,
      values.charter, values.permission_profile_id, values.config_revision, values.runtime_configuration_revision,
      values.provider_launch_policy_json, values.image_input, values.live_sharing,
      values.desired_state, values.source_repo_path,
      values.deployment_id, values.run_id, values.observed_state, values.workspace_path, values.work_attempt_id,
      values.provider_work_attempt_id, values.provider_continuation_id, values.provider_execution_generation_id,
      values.provider_connection_json, values.workplace_liveness_json, values.native_liveness_json,
      values.condition, values.last_error, values.ready_reached_at,
      values.last_turn_control_sequence, values.turn_control_inbox_item_id, values.turn_control_status, values.turn_control_json,
      values.last_worker_binding_json, values.reconciliation_json, values.reconciliation_notices_json,
      values.agent_id, expectedVersion,
    );
    if (Number(updated.changes) !== 1) {
      throw new ManifestConflictError(`Agent ${values.agent_id} version does not match expected ${expectedVersion}.`);
    }
    this.replaceActivityEvents(database, values.agent_id, projection.runtime_deployment.activity);
  },

  replaceEntries(
    database: DatabaseSync,
    entries: DaemonManifestEntry[],
    expectedVersions: Readonly<Record<string, number>> | null = null,
    initializeNewMintStates = true,
  ): Record<string, number> {
    const existingRows = new Map(
      (database.prepare("SELECT * FROM agents ORDER BY sort_order").all() as Row[])
        .map((row) => [String(row.agent_id), row]),
    );
    if (expectedVersions !== null) {
      for (const [agentId, row] of existingRows) {
        const expected = expectedVersions[agentId];
        if (expected !== undefined && Number(row.version) !== expected) {
          throw new ManifestConflictError(`Agent ${agentId} version ${String(row.version)} does not match expected ${expected}.`);
        }
      }
      for (const [agentId, expected] of Object.entries(expectedVersions)) {
        if (!existingRows.has(agentId)) {
          throw new ManifestConflictError(`Agent ${agentId} no longer exists (expected version ${expected}).`);
        }
      }
    }
    const nextIds = new Set(entries.map((entry) => entry.id));
    for (const agentId of existingRows.keys()) {
      if (!nextIds.has(agentId)) {
        run(database.prepare("DELETE FROM agents WHERE agent_id = ?"), agentId);
      }
    }
    // Park surviving sort_order values above the max so reordering never
    // collides with UNIQUE(sort_order).
    const maxOrder = Number((database.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM agents").get() as Row).value);
    const offset = maxOrder + entries.length + 1;
    database.prepare("UPDATE agents SET sort_order = sort_order + ?").run(offset);

    const versions: Record<string, number> = {};
    entries.forEach((entry, index) => {
      const normalized = canonicalManifestEntry(entry);
      const projection = projectDaemonManifestEntry(normalized);
      const existing = existingRows.get(normalized.id);
      if (existing) {
        const currentVersion = Number(existing.version);
        this.updateProjection(database, projection, existing, currentVersion);
        run(database.prepare("UPDATE agents SET sort_order = ? WHERE agent_id = ?"), index, normalized.id);
        versions[normalized.id] = currentVersion + 1;
      } else {
        this.insertProjection(database, projection, index);
        if (initializeNewMintStates) this.initializeMintStateIfExplicit(database, normalized);
        versions[normalized.id] = 1;
      }
    });
    return versions;
  },

  projectionFromRow(database: DatabaseSync, row: Row, activityMode: "full" | "summary" = "full"): DaemonManifestDomainProjection {
    const agentId = String(row.agent_id);
    let providerRef: DaemonProviderRuntimeReference | undefined;
    if (row.provider_execution_generation_id !== null && row.provider_execution_generation_id !== undefined) {
      providerRef = {
        work_attempt_id: String(row.provider_work_attempt_id),
        provider_continuation_id: String(row.provider_continuation_id),
        provider_connection: row.provider_connection_json === null || row.provider_connection_json === undefined
          ? null
          : parseJson<DaemonProviderConnection>(row.provider_connection_json),
        execution_generation_id: String(row.provider_execution_generation_id),
      };
    }
    // Bound the database read itself: state watchers never need raw payloads.
    const activityRows = activityMode === "summary"
      ? (this.reads.get(database, "activitySummary")
        .all(agentId, STATE_WATCH_ACTIVITY_SUMMARY_LIMIT) as Row[]).reverse()
      : this.reads.get(database, "activity").all(agentId) as Row[];
    const activity = activityRows.map((event) => activityEventFromRow(event, activityMode === "summary" ? null : parseJson(event.payload_json)));

    const runtime: DaemonManifestDomainProjection["runtime_deployment"] = {
      agent_id: agentId,
      deployment_id: nullableString(row.deployment_id),
      run_id: nullableString(row.run_id),
      observed_state: String(row.observed_state) as DaemonManifestEntry["observed_state"],
      ...(row.workspace_path !== null && row.workspace_path !== undefined ? { workspace_path: String(row.workspace_path) } : {}),
      ...(row.work_attempt_id !== null && row.work_attempt_id !== undefined ? { work_attempt_id: String(row.work_attempt_id) } : {}),
      ...(providerRef !== undefined ? { provider_ref: providerRef } : {}),
      ...(row.workplace_liveness_json !== null && row.workplace_liveness_json !== undefined
        ? { workplace_liveness: parseJson(row.workplace_liveness_json) }
        : {}),
      ...(row.native_liveness_json !== null && row.native_liveness_json !== undefined
        ? { native_liveness: parseJson(row.native_liveness_json) }
        : {}),
      activity,
    };
    const turn = row.turn_control_json !== null && row.turn_control_json !== undefined
      ? parseJson<DaemonTurnControlEffect>(row.turn_control_json)
      : undefined;
    const reconciliation = row.reconciliation_json !== null && row.reconciliation_json !== undefined
      ? parseJson<ReconciliationState>(row.reconciliation_json)
      : undefined;
    const notices = row.reconciliation_notices_json !== null && row.reconciliation_notices_json !== undefined
      ? parseJson<ReconciliationNotice[]>(row.reconciliation_notices_json)
      : undefined;
    const lastWorkerBinding = row.last_worker_binding_json !== null && row.last_worker_binding_json !== undefined
      ? parseJson<DaemonWorkerBindingProjection>(row.last_worker_binding_json)
      : undefined;

    return {
      identity: { agent_id: agentId, created_by: String(row.created_by), created_at: String(row.created_at) },
      profile: {
        agent_id: agentId,
        display_name: String(row.display_name),
        ...(row.avatar_json ? { avatar: normalizeAgentAvatar(parseJson(row.avatar_json)) } : {}),
      },
      membership: {
        agent_id: agentId,
        room_id: String(row.room_id),
        ...(row.local_room_id == null ? {} : { local_room_id: String(row.local_room_id) }),
      },
      configuration: {
        agent_id: agentId,
        provider: String(row.provider),
        model: nullableString(row.model),
        reasoning_effort: nullableString(row.reasoning_effort) as DaemonAgentConfiguration["reasoning_effort"],
        charter: String(row.charter),
        permission_profile_id: nullableString(row.permission_profile_id),
        config_revision: Number(row.config_revision),
        runtime_configuration_revision: Number(row.runtime_configuration_revision),
        delivery_mode: "daemon_inbox",
        ...(row.provider_launch_policy_json !== null && row.provider_launch_policy_json !== undefined
          ? { provider_launch_policy: parseJson(row.provider_launch_policy_json) }
          : {}),
      },
      launch_intent: {
        agent_id: agentId,
        desired_state: String(row.desired_state) as DaemonManifestEntry["desired_state"],
        ...(row.source_repo_path !== null && row.source_repo_path !== undefined ? { source_repo_path: String(row.source_repo_path) } : {}),
      },
      runtime_deployment: runtime,
      lifecycle: {
        agent_id: agentId,
        condition: String(row.condition) as DaemonManifestEntry["condition"],
        ...(row.last_error !== null && row.last_error !== undefined ? { last_error: String(row.last_error) } : {}),
      },
      readiness: {
        agent_id: agentId,
        ...(row.ready_reached_at !== null && row.ready_reached_at !== undefined ? { ready_reached_at: String(row.ready_reached_at) } : {}),
      },
      turn_control_journal: {
        agent_id: agentId,
        last_turn_control_sequence: Number(row.last_turn_control_sequence),
        ...(turn !== undefined ? { turn_control: turn } : {}),
      },
      retained_worker_binding: {
        agent_id: agentId,
        ...(lastWorkerBinding !== undefined ? { last_worker_binding: lastWorkerBinding } : {}),
      },
      reconciliation: {
        agent_id: agentId,
        ...(reconciliation !== undefined ? { reconciliation } : {}),
        ...(notices !== undefined ? { reconciliation_notices: notices } : {}),
      },
    };
  },
});
