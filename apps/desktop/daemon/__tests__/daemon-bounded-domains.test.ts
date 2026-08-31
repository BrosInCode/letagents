import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mainSource = read("../main.ts");
const routerSource = read("../control-request-router.ts");
const cloudSource = read("../cloud-http.ts");
const daemonReadModelSource = read("../daemon-read-model.ts");
const deliveryCutoverExecutionSource = read("../delivery-cutover-execution-coordinator.ts");
const desiredStateSource = read("../desired-state-coordinator.ts");
const manifestTransitionSource = read("../manifest-transition-coordinator.ts");
const nativeActivityPublicationSource = read("../native-activity-publication-coordinator.ts");
const providerCheckpointSource = read("../provider-checkpoint-coordinator.ts");
const providerSchedulerFailureSource = read("../provider-scheduler-failure-coordinator.ts");
const providerTerminalSource = read("../provider-terminal-coordinator.ts");
const roomAgentProjectionSource = read("../room-agent-state-projection.ts");
const runtimeRecoverySource = read("../runtime-recovery-coordinator.ts");
const supervisedDeliveryLifecycleSource = read("../supervised-delivery-lifecycle-coordinator.ts");

const expectedControlMethods = [
  "attempt.read",
  "daemon.negotiate",
  "daemon.prepare_handoff",
  "daemon.status",
  "lane.activate_legacy",
  "lane.release_legacy",
  "lane.reserve_legacy",
  "manifest.append_activity",
  "manifest.compare_and_set_desired_state",
  "manifest.control_turn",
  "manifest.list",
  "manifest.put",
  "manifest.resolve_turn_control",
  "manifest.set_desired_state",
  "manifest.set_display_name",
  "manifest.update_workplace_liveness",
  "manifest.watch_state",
  "supervisor.acknowledge_room_move_source_revocation",
  "supervisor.activate_custodial_polling",
  "supervisor.authorize_custodial_polling",
  "supervisor.bind_worker_session",
  "supervisor.bootstrap_room_ingress",
  "supervisor.borrow_worker_credential",
  "supervisor.cancel_delivery_drain",
  "supervisor.cancel_polling_activation",
  "supervisor.checkpoint_worker_cursor",
  "supervisor.commit_room_move",
  "supervisor.complete_bounded_effect",
  "supervisor.execute_bounded_tool",
  "supervisor.get_agent_configuration",
  "supervisor.get_agent_inspector_detail",
  "supervisor.get_current_room_move",
  "supervisor.get_delivery_drain",
  "supervisor.get_polling_activation",
  "supervisor.get_room_move",
  "supervisor.host_approval_challenge",
  "supervisor.host_approval_request",
  "supervisor.install_host_grant",
  "supervisor.install_open_model_credential",
  "supervisor.install_worker_credential",
  "supervisor.prepare_bounded_effect",
  "supervisor.prepare_custodial_forward",
  "supervisor.prepare_delivery_drain",
  "supervisor.prepare_room_move",
  "supervisor.purge_agent",
  "supervisor.recover_agent_runtime",
  "supervisor.restore_agent_conversation",
  "supervisor.retire_agent",
  "supervisor.retry_room_delivery",
  "supervisor.rollback_room_move",
  "supervisor.skip_room_delivery",
  "supervisor.update_agent_configuration",
  "supervisor.verify_worker_session",
  "supervisor.watch_agent_stream",
].sort();

test("the daemon entrypoint delegates control-protocol parsing to one router", () => {
  assert.equal(matches(mainSource, /request\.method\s*===/g).length, 0);
  assert.equal(matches(mainSource, /createDaemonControlRequestHandler\s*\(/g).length, 1);

  const actualMethods = matches(routerSource, /request\.method\s*===\s*"([^"]+)"/g)
    .map((match) => match[1])
    .filter((method, index, methods) => methods.indexOf(method) === index)
    .sort();
  assert.deepEqual(actualMethods, expectedControlMethods);
});

test("cloud requests are isolated from the daemon authority owner", () => {
  assert.equal(matches(mainSource, /\bfetch\s*\(/g).length, 0);
  assert.ok(matches(cloudSource, /\bfetch\s*\(/g).length >= 8);
});

test("daemon policy and projection domains remain extracted", () => {
  for (const moduleName of [
    "agent-stream-registry",
    "bounded-effect-coordinator",
    "cloud-http",
    "continuation-repair-coordinator",
    "continuation-repair-policy",
    "control-request-router",
    "daemon-authority",
    "daemon-error-policy",
    "daemon-read-model",
    "daemon-state-watch",
    "delivery-cutover-coordinator",
    "delivery-cutover-execution-coordinator",
    "desired-state-coordinator",
    "entry-concurrency-gate",
    "legacy-lane-coordinator",
    "lifecycle-administration-coordinator",
    "manifest-administration-coordinator",
    "manifest-transition-coordinator",
    "native-activity-publication-coordinator",
    "process-identity",
    "provider-checkpoint-coordinator",
    "provider-execution-coordinator",
    "provider-reconciliation-coordinator",
    "provider-scheduler-failure-coordinator",
    "provider-stream-coordinator",
    "provider-stream-policy",
    "provider-terminal-coordinator",
    "room-delivery-control",
    "room-move-coordinator",
    "runtime-recovery-coordinator",
    "supervised-delivery-lifecycle-coordinator",
    "turn-control-coordinator",
    "worker-authority-coordinator",
    "worker-runtime-custody",
  ]) {
    assert.match(mainSource, new RegExp(`from "\\./${moduleName}\\.js"`));
  }
  assert.match(roomAgentProjectionSource, /from "\.\/manifest-view-projection\.js"/);
  assert.match(daemonReadModelSource, /from "\.\/room-agent-state-projection\.js"/);
  assert.match(deliveryCutoverExecutionSource, /controlExactTurn/);
  assert.match(mainSource, /startDelivery: \(entryId\) => this\.startSupervisedDelivery\(entryId, "wake"\)/,
    "cutover cancellation wakes an existing A without refreshing or aborting its loop");
  assert.equal(matches(mainSource, /\.controlExactTurn\s*\(/g).length, 0);
  assert.match(desiredStateSource, /compareAndSet/);
  assert.equal(matches(mainSource, /private async setDesiredState\s*\(/g).length, 0);
  assert.match(providerCheckpointSource, /checkpointCursorPreparedTurn/);
  assert.match(providerCheckpointSource, /from "\.\/provider-state-policy\.js"/);
  assert.equal(matches(mainSource, /\.checkpointCursorPreparedTurn\s*\(/g).length, 0);
  assert.match(runtimeRecoverySource, /commitTurnControlState/);
  assert.equal(matches(mainSource, /\.commitTurnControlState\s*\(/g).length, 0);
  assert.match(supervisedDeliveryLifecycleSource, /exactActiveBoundedContext/);
  assert.equal(matches(mainSource, /preparedRoomMove\s*\(/g).length, 0);
  assert.match(providerSchedulerFailureSource, /transientProviderStartFailure/);
  assert.equal(matches(mainSource, /transientProviderStartFailure/g).length, 0);
  assert.match(nativeActivityPublicationSource, /publishWorkerNativeActivity/);
  assert.equal(matches(mainSource, /publishWorkerNativeActivity/g).length, 0);
  assert.match(manifestTransitionSource, /function sanitizeTerminal/);
  assert.equal(matches(mainSource, /function sanitizeTerminal/g).length, 0);
  assert.match(providerTerminalSource, /advanceReconciliationState/);
  assert.equal(matches(mainSource, /advanceReconciliationState/g).length, 0);
  assert.match(daemonReadModelSource, /projectRoomAgentManifestEntry/);
  assert.equal(matches(mainSource, /projectRoomAgentManifestEntry/g).length, 0);
  assert.equal(matches(mainSource, /^export function providerStreamLifecycle/mg).length, 0);
  assert.equal(matches(mainSource, /^function projectDeliveryReceipts/mg).length, 0);
  assert.ok(mainSource.split("\n").length < 1_510, "main.ts must remain a thin composition root");
});

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function matches(source: string, pattern: RegExp): RegExpMatchArray[] {
  return [...source.matchAll(pattern)];
}
