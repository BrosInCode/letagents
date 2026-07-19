import assert from "node:assert/strict";
import test from "node:test";

import type {
  DaemonAgentConfiguration,
  DaemonAgentDefinition,
  DaemonManifestEntry,
  DaemonRuntimeDeployment,
} from "../types.js";

const entry = {
  id: "agent_8f31",
  room_id: "room_architecture",
  display_name: "MistyMorrow",
  created_by: "user_1",
  created_at: "2026-07-19T00:00:00.000Z",
  provider: "codex",
  model: null,
  charter: "Investigate runtime failures.",
  desired_state: "running",
  permission_profile_id: null,
  provider_launch_policy: { deliveryMode: "mcp_polling" },
  source_repo_path: "/repo",
  observed_state: "working",
  condition: "none",
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
    execution_generation_id: "run_1",
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
} satisfies DaemonManifestEntry;

test("the flat manifest wire shape composes durable agent and replaceable runtime contracts", () => {
  const definition: DaemonAgentDefinition = {
    id: entry.id,
    room_id: entry.room_id,
    display_name: entry.display_name,
    created_by: entry.created_by,
    created_at: entry.created_at,
  };
  const configuration: DaemonAgentConfiguration = {
    provider: entry.provider,
    model: entry.model,
    charter: entry.charter,
    desired_state: entry.desired_state,
    permission_profile_id: entry.permission_profile_id,
    provider_launch_policy: entry.provider_launch_policy,
    source_repo_path: entry.source_repo_path,
  };
  const deployment: DaemonRuntimeDeployment = {
    id: entry.id,
    observed_state: entry.observed_state,
    condition: entry.condition,
    workspace_path: entry.workspace_path,
    work_attempt_id: entry.work_attempt_id,
    provider_ref: entry.provider_ref,
    workplace_liveness: entry.workplace_liveness,
    native_liveness: entry.native_liveness,
  };

  // @ts-expect-error Durable identity must not acquire provider process state.
  void definition.provider_ref;
  // @ts-expect-error Durable configuration must not acquire liveness state.
  void configuration.native_liveness;
  // @ts-expect-error A replaceable deployment must not become the agent charter.
  void deployment.charter;

  assert.equal(deployment.id, definition.id, "runtime deployment remains attached to the stable agent id");
  assert.equal(deployment.provider_ref?.provider_connection?.kind, "codex_app_server");
  assert.equal(configuration.provider, "codex");
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry, "the compatibility manifest remains a flat JSON payload");

  const replacementDeployment: DaemonRuntimeDeployment = {
    ...deployment,
    provider_ref: {
      ...deployment.provider_ref!,
      provider_connection: {
        kind: "codex_app_server",
        url: "http://127.0.0.1:5678",
        pid: 654,
        processIdentity: "birth-654",
      },
      execution_generation_id: "run_2",
    },
  };

  assert.equal(replacementDeployment.id, definition.id, "a replacement run does not replace the agent");
  assert.equal(replacementDeployment.provider_ref?.execution_generation_id, "run_2");
  assert.equal(replacementDeployment.provider_ref?.provider_connection?.pid, 654);
});
