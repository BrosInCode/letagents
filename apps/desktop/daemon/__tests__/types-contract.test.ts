import assert from "node:assert/strict";
import test from "node:test";

import {
  composeDaemonManifestEntry,
  parseDaemonDeploymentId,
  projectDaemonCreateRequestReplayParameters,
  projectDaemonManifestEntry,
  serializeDaemonDeploymentId,
} from "../manifest-entry-projection.js";
import type { DaemonManifestEntry } from "../types.js";

const entry = {
  id: "agent:/8f31\u0000segment",
  room_id: "room_architecture",
  display_name: "MistyMorrow",
  created_by: "user_1",
  created_at: "2026-07-19T00:00:00.000Z",
  provider: "codex",
  model: null,
  charter: "Investigate runtime failures.",
  desired_state: "running",
  observed_state: "working",
  condition: "none",
  permission_profile_id: null,
  provider_launch_policy: { deliveryMode: "mcp_polling" },
  source_repo_path: "/repo",
  workspace_path: "/worktrees/agent_8f31",
  work_attempt_id: "attempt_1",
  provider_ref: {
    work_attempt_id: "attempt_1",
    provider_continuation_id: "thread_1",
    provider_connection: {
      kind: "codex_app_server" as const,
      url: "http://127.0.0.1:1234",
      pid: 321,
      processIdentity: "birth-321",
    },
    execution_generation_id: "run:/1\u0000segment",
  },
  workplace_liveness: {
    state: "reachable" as const,
    observed_at: "2026-07-19T00:01:00.000Z",
    detail: null,
  },
  native_liveness: {
    state: "active" as const,
    observed_at: "2026-07-19T00:01:00.000Z",
    detail: "streaming",
  },
  ready_reached_at: "2026-07-19T00:01:00.000Z",
  activity: [],
  turn_control: null,
  last_worker_binding: null,
  reconciliation: {
    exit_timestamps_ms: [],
    consecutive_action_failures: 0,
    last_observed_state: "working" as const,
    next_restart_at_ms: null,
    completed_action_ids: [],
    last_action_sequence: 0,
    pending_action: null,
  },
  reconciliation_notices: [],
} satisfies DaemonManifestEntry;

test("manifest projection separates independently owned records and round-trips the flat wire shape", () => {
  const projected = projectDaemonManifestEntry(entry);

  assert.deepEqual(projected.identity, {
    agent_id: entry.id,
    created_by: entry.created_by,
    created_at: entry.created_at,
  });
  assert.deepEqual(projected.profile, { agent_id: entry.id, display_name: entry.display_name });
  assert.deepEqual(projected.membership, { agent_id: entry.id, room_id: entry.room_id });
  assert.equal(projected.configuration.charter, entry.charter);
  assert.equal(projected.launch_intent.desired_state, "running");
  assert.equal(projected.runtime_deployment.run_id, entry.provider_ref.execution_generation_id);
  assert.deepEqual(parseDaemonDeploymentId(projected.runtime_deployment.deployment_id!), {
    agent_id: entry.id,
    run_id: entry.provider_ref.execution_generation_id,
  });
  assert.equal(projected.readiness.ready_reached_at, entry.ready_reached_at);
  assert.equal(projected.turn_control_journal.turn_control, null);
  assert.equal(projected.retained_worker_binding.last_worker_binding, null);
  assert.deepEqual(projected.reconciliation.reconciliation_notices, []);

  // @ts-expect-error Stable identity cannot acquire profile fields.
  void projected.identity.display_name;
  // @ts-expect-error Agent configuration cannot acquire launch intent.
  void projected.configuration.desired_state;
  // @ts-expect-error Runtime deployment cannot acquire lifecycle condition.
  void projected.runtime_deployment.condition;
  // @ts-expect-error Runtime deployment cannot own the readiness stamp.
  void projected.runtime_deployment.ready_reached_at;

  const composed = composeDaemonManifestEntry(projected);
  const runtimeIdentity = {
    run_id: entry.provider_ref.execution_generation_id,
    deployment_id: projected.runtime_deployment.deployment_id,
  };
  assert.deepEqual(composed, { ...entry, ...runtimeIdentity });
  assert.deepEqual(
    JSON.parse(JSON.stringify(composed)),
    JSON.parse(JSON.stringify({ ...entry, ...runtimeIdentity })),
    "serialization preserves the flat wire keys and values independent of object insertion order",
  );
});

test("deployment ids serialize agent and run ids without delimiter collisions", () => {
  const first = serializeDaemonDeploymentId("agent:a/b\u0000c", "run:x/y\u0000z");
  const second = serializeDaemonDeploymentId("agent:a", "b/run:x/y\u0000z");

  assert.notEqual(first, second);
  assert.deepEqual(parseDaemonDeploymentId(first), {
    agent_id: "agent:a/b\u0000c",
    run_id: "run:x/y\u0000z",
  });
  assert.throws(() => serializeDaemonDeploymentId("agent", ""), /non-empty/);
  assert.throws(() => parseDaemonDeploymentId("daemon-deployment:not-json"), /payload/);
  assert.throws(() => parseDaemonDeploymentId("other:[\"agent\",\"run\"]"), /prefix/);
  assert.throws(() => projectDaemonManifestEntry({ ...entry, run_id: "run_1" }), /requires both/);
  assert.throws(() => composeDaemonManifestEntry(projectDaemonManifestEntry({
    ...entry,
    run_id: "different-run",
    deployment_id: serializeDaemonDeploymentId(entry.id, "different-run"),
  })), /does not match its provider execution/);
  assert.throws(() => composeDaemonManifestEntry(projectDaemonManifestEntry({
    ...entry,
    run_id: entry.provider_ref.execution_generation_id,
    deployment_id: serializeDaemonDeploymentId(entry.id, "wrong-run"),
  })), /does not match its agent and run ids/);
});

test("create-request replay comparison is explicit and does not imply field immutability", () => {
  const original = projectDaemonCreateRequestReplayParameters(entry);
  const runtimeOnlyChange = projectDaemonCreateRequestReplayParameters({
    ...entry,
    desired_state: "stopped",
    observed_state: "stopped",
    created_at: "2026-07-20T00:00:00.000Z",
    provider_ref: null,
  });
  const changedProfile = projectDaemonCreateRequestReplayParameters({ ...entry, display_name: "Renamed" });

  assert.deepEqual(runtimeOnlyChange, original, "runtime/control evolution does not invalidate a lost-response retry");
  assert.notDeepEqual(changedProfile, original, "a retry carrying different creation parameters is rejected");
});

test("non-Codex provider process facts retain the compatibility wire shape", () => {
  const claudeEntry: DaemonManifestEntry = {
    ...entry,
    id: "agent_claude",
    provider: "claude-code",
    provider_ref: {
      ...entry.provider_ref,
      provider_connection: { kind: "claude_cli", pid: 987, processIdentity: "birth-987" },
    },
  };

  const projected = projectDaemonManifestEntry(claudeEntry);
  assert.deepEqual(composeDaemonManifestEntry(projected), {
    ...claudeEntry,
    run_id: claudeEntry.provider_ref!.execution_generation_id,
    deployment_id: projected.runtime_deployment.deployment_id,
  });
});
