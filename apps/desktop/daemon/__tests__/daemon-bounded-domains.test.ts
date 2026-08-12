import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mainSource = read("../main.ts");
const routerSource = read("../control-request-router.ts");
const cloudSource = read("../cloud-http.ts");

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
  "supervisor.bind_worker_session",
  "supervisor.bootstrap_room_ingress",
  "supervisor.borrow_worker_credential",
  "supervisor.checkpoint_worker_cursor",
  "supervisor.commit_room_move",
  "supervisor.complete_bounded_effect",
  "supervisor.get_agent_configuration",
  "supervisor.get_agent_inspector_detail",
  "supervisor.get_current_room_move",
  "supervisor.get_room_move",
  "supervisor.install_host_grant",
  "supervisor.install_open_model_credential",
  "supervisor.install_worker_credential",
  "supervisor.prepare_bounded_effect",
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
    "cloud-http",
    "control-request-router",
    "manifest-view-projection",
    "process-identity",
    "provider-state-policy",
    "provider-stream-policy",
  ]) {
    assert.match(mainSource, new RegExp(`from "\\./${moduleName}\\.js"`));
  }
  assert.equal(matches(mainSource, /^export function providerStreamLifecycle/mg).length, 0);
  assert.equal(matches(mainSource, /^function projectDeliveryReceipts/mg).length, 0);
});

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function matches(source: string, pattern: RegExp): RegExpMatchArray[] {
  return [...source.matchAll(pattern)];
}
