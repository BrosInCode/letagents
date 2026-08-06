import type {
  DaemonAgentConfiguration,
  DaemonAgentIdentity,
  DaemonAgentLaunchIntent,
  DaemonAgentLifecycleState,
  DaemonAgentProfile,
  DaemonAgentReadinessRecord,
  DaemonAgentRoomMembership,
  DaemonManifestEntry,
  DaemonReconciliationRecord,
  DaemonRetainedWorkerBindingRecord,
  DaemonRuntimeDeployment,
  DaemonTurnControlJournalRecord,
} from "./types.js";

const DEPLOYMENT_ID_PREFIX = "daemon-deployment:";

export type DaemonManifestDomainProjection = {
  identity: DaemonAgentIdentity;
  profile: DaemonAgentProfile;
  membership: DaemonAgentRoomMembership;
  configuration: DaemonAgentConfiguration;
  launch_intent: DaemonAgentLaunchIntent;
  runtime_deployment: DaemonRuntimeDeployment;
  lifecycle: DaemonAgentLifecycleState;
  readiness: DaemonAgentReadinessRecord;
  turn_control_journal: DaemonTurnControlJournalRecord;
  retained_worker_binding: DaemonRetainedWorkerBindingRecord;
  reconciliation: DaemonReconciliationRecord;
};

/**
 * Collision-safe external key for one replaceable deployment. JSON tuple
 * encoding keeps agent/run boundaries unambiguous even when ids contain the
 * same delimiters.
 */
export function serializeDaemonDeploymentId(agentId: string, runId: string): string {
  if (!agentId || !runId) throw new Error("Daemon deployment ids require non-empty agent and run ids.");
  return `${DEPLOYMENT_ID_PREFIX}${JSON.stringify([agentId, runId])}`;
}

export function parseDaemonDeploymentId(deploymentId: string): { agent_id: string; run_id: string } {
  if (!deploymentId.startsWith(DEPLOYMENT_ID_PREFIX)) throw new Error("Invalid daemon deployment id prefix.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(deploymentId.slice(DEPLOYMENT_ID_PREFIX.length));
  } catch {
    throw new Error("Invalid daemon deployment id payload.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => typeof part !== "string" || !part)) {
    throw new Error("Invalid daemon deployment id tuple.");
  }
  return { agent_id: parsed[0] as string, run_id: parsed[1] as string };
}

/** Decomposes the legacy flat transport record without assigning it domain ownership. */
export function projectDaemonManifestEntry(entry: DaemonManifestEntry): DaemonManifestDomainProjection {
  const hasRunId = Object.hasOwn(entry, "run_id");
  const hasDeploymentId = Object.hasOwn(entry, "deployment_id");
  if (hasRunId !== hasDeploymentId) throw new Error("Daemon flat runtime identity requires both run_id and deployment_id.");
  const providerRunId = entry.provider_ref?.execution_generation_id ?? null;
  const runId = hasRunId ? entry.run_id ?? null : providerRunId;
  const deploymentId = hasDeploymentId
    ? entry.deployment_id ?? null
    : runId === null ? null : serializeDaemonDeploymentId(entry.id, runId);
  return {
    identity: {
      agent_id: entry.id,
      created_by: entry.created_by,
      created_at: entry.created_at,
    },
    profile: {
      agent_id: entry.id,
      display_name: entry.display_name,
    },
    membership: {
      agent_id: entry.id,
      room_id: entry.room_id,
    },
    configuration: {
      agent_id: entry.id,
      provider: entry.provider,
      model: entry.model,
      ...(Object.hasOwn(entry, "reasoning_effort") ? { reasoning_effort: entry.reasoning_effort } : {}),
      charter: entry.charter,
      permission_profile_id: entry.permission_profile_id,
      ...(Object.hasOwn(entry, "config_revision") ? { config_revision: entry.config_revision } : {}),
      ...(Object.hasOwn(entry, "runtime_configuration_revision") ? { runtime_configuration_revision: entry.runtime_configuration_revision } : {}),
      ...(Object.hasOwn(entry, "delivery_mode") ? { delivery_mode: entry.delivery_mode } : {}),
      ...(Object.hasOwn(entry, "delivery_cutover") ? { delivery_cutover: entry.delivery_cutover } : {}),
      ...(Object.hasOwn(entry, "provider_launch_policy") ? { provider_launch_policy: entry.provider_launch_policy } : {}),
    },
    launch_intent: {
      agent_id: entry.id,
      desired_state: entry.desired_state,
      ...(Object.hasOwn(entry, "source_repo_path") ? { source_repo_path: entry.source_repo_path } : {}),
    },
    runtime_deployment: {
      agent_id: entry.id,
      run_id: runId,
      deployment_id: deploymentId,
      observed_state: entry.observed_state,
      ...(Object.hasOwn(entry, "workspace_path") ? { workspace_path: entry.workspace_path } : {}),
      ...(Object.hasOwn(entry, "work_attempt_id") ? { work_attempt_id: entry.work_attempt_id } : {}),
      ...(Object.hasOwn(entry, "provider_ref") ? { provider_ref: entry.provider_ref } : {}),
      ...(Object.hasOwn(entry, "workplace_liveness") ? { workplace_liveness: entry.workplace_liveness } : {}),
      ...(Object.hasOwn(entry, "native_liveness") ? { native_liveness: entry.native_liveness } : {}),
      ...(Object.hasOwn(entry, "activity") ? { activity: entry.activity } : {}),
    },
    lifecycle: {
      agent_id: entry.id,
      condition: entry.condition,
      ...(Object.hasOwn(entry, "last_error") ? { last_error: entry.last_error } : {}),
    },
    readiness: {
      agent_id: entry.id,
      ...(Object.hasOwn(entry, "ready_reached_at") ? { ready_reached_at: entry.ready_reached_at } : {}),
    },
    turn_control_journal: {
      agent_id: entry.id,
      last_turn_control_sequence: entry.last_turn_control_sequence ?? 0,
      ...(Object.hasOwn(entry, "turn_control") ? { turn_control: entry.turn_control } : {}),
    },
    retained_worker_binding: {
      agent_id: entry.id,
      ...(Object.hasOwn(entry, "last_worker_binding") ? { last_worker_binding: entry.last_worker_binding } : {}),
    },
    reconciliation: {
      agent_id: entry.id,
      ...(Object.hasOwn(entry, "reconciliation") ? { reconciliation: entry.reconciliation } : {}),
      ...(Object.hasOwn(entry, "reconciliation_notices") ? { reconciliation_notices: entry.reconciliation_notices } : {}),
    },
  };
}

function assertProjectionLinks(projection: DaemonManifestDomainProjection): void {
  const agentId = projection.identity.agent_id;
  for (const record of [
    projection.profile,
    projection.membership,
    projection.configuration,
    projection.launch_intent,
    projection.runtime_deployment,
    projection.lifecycle,
    projection.readiness,
    projection.turn_control_journal,
    projection.retained_worker_binding,
    projection.reconciliation,
  ]) {
    if (record.agent_id !== agentId) throw new Error("Daemon manifest projection contains records for different agents.");
  }
  const runtime = projection.runtime_deployment;
  const providerRunId = runtime.provider_ref?.execution_generation_id ?? null;
  if (providerRunId !== null && runtime.run_id !== providerRunId) throw new Error("Daemon runtime run id does not match its provider execution generation.");
  const expectedDeploymentId = runtime.run_id === null ? null : serializeDaemonDeploymentId(agentId, runtime.run_id);
  if (runtime.deployment_id !== expectedDeploymentId) throw new Error("Daemon runtime deployment id does not match its agent and run ids.");
}

/** Reconstitutes the compatibility wire record from independently owned domain records. */
export function composeDaemonManifestEntry(projection: DaemonManifestDomainProjection): DaemonManifestEntry {
  assertProjectionLinks(projection);
  const {
    identity,
    profile,
    membership,
    configuration,
    launch_intent: launchIntent,
    runtime_deployment: runtime,
    lifecycle,
    readiness,
    turn_control_journal: turnControlJournal,
    retained_worker_binding: retainedWorkerBinding,
    reconciliation,
  } = projection;
  return {
    id: identity.agent_id,
    room_id: membership.room_id,
    display_name: profile.display_name,
    provider: configuration.provider,
    model: configuration.model,
    charter: configuration.charter,
    desired_state: launchIntent.desired_state,
    observed_state: runtime.observed_state,
    condition: lifecycle.condition,
    permission_profile_id: configuration.permission_profile_id,
    ...(Object.hasOwn(configuration, "delivery_mode") ? { delivery_mode: configuration.delivery_mode } : {}),
    ...(Object.hasOwn(configuration, "delivery_cutover") ? { delivery_cutover: configuration.delivery_cutover } : {}),
    created_by: identity.created_by,
    created_at: identity.created_at,
    ...(Object.hasOwn(lifecycle, "last_error") ? { last_error: lifecycle.last_error } : {}),
    ...(Object.hasOwn(configuration, "provider_launch_policy") ? { provider_launch_policy: configuration.provider_launch_policy } : {}),
    ...(Object.hasOwn(launchIntent, "source_repo_path") ? { source_repo_path: launchIntent.source_repo_path } : {}),
    ...(Object.hasOwn(runtime, "workspace_path") ? { workspace_path: runtime.workspace_path } : {}),
    ...(Object.hasOwn(runtime, "work_attempt_id") ? { work_attempt_id: runtime.work_attempt_id } : {}),
    ...(runtime.run_id !== null
      ? { run_id: runtime.run_id, deployment_id: runtime.deployment_id }
      : {}),
    ...(Object.hasOwn(runtime, "provider_ref") ? { provider_ref: runtime.provider_ref } : {}),
    ...(Object.hasOwn(runtime, "workplace_liveness") ? { workplace_liveness: runtime.workplace_liveness } : {}),
    ...(Object.hasOwn(runtime, "native_liveness") ? { native_liveness: runtime.native_liveness } : {}),
    ...(Object.hasOwn(readiness, "ready_reached_at") ? { ready_reached_at: readiness.ready_reached_at } : {}),
    ...(Object.hasOwn(runtime, "activity") ? { activity: runtime.activity } : {}),
    last_turn_control_sequence: turnControlJournal.last_turn_control_sequence,
    ...(Object.hasOwn(turnControlJournal, "turn_control") ? { turn_control: turnControlJournal.turn_control } : {}),
    ...(Object.hasOwn(retainedWorkerBinding, "last_worker_binding") ? { last_worker_binding: retainedWorkerBinding.last_worker_binding } : {}),
    ...(Object.hasOwn(reconciliation, "reconciliation") ? { reconciliation: reconciliation.reconciliation } : {}),
    ...(Object.hasOwn(reconciliation, "reconciliation_notices") ? { reconciliation_notices: reconciliation.reconciliation_notices } : {}),
  };
}

/**
 * Parameters compared when a client retries `manifest.put` after losing its
 * response. This validates replay equivalence only; it is not a declaration
 * that display name, room membership, charter, or configuration are immutable.
 */
export function projectDaemonCreateRequestReplayParameters(entry: DaemonManifestEntry) {
  const projection = projectDaemonManifestEntry(entry);
  return {
    id: projection.identity.agent_id,
    room_id: projection.membership.room_id,
    display_name: projection.profile.display_name,
    provider: projection.configuration.provider,
    model: projection.configuration.model,
    reasoning_effort: projection.configuration.reasoning_effort ?? null,
    charter: projection.configuration.charter,
    permission_profile_id: projection.configuration.permission_profile_id,
    delivery_mode: projection.configuration.delivery_mode,
    provider_launch_policy: projection.configuration.provider_launch_policy ?? null,
    created_by: projection.identity.created_by,
    source_repo_path: projection.launch_intent.source_repo_path ?? null,
  };
}
