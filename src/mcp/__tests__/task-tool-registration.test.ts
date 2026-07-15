import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "../server/tools/tasks/index.js";

type ToolRegistration = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: unknown;
};

function collectTaskToolRegistrations(): ToolRegistration[] {
  const registrations: ToolRegistration[] = [];
  const server = {
    tool(name: string, description: string, schema: Record<string, unknown>, handler: unknown) {
      registrations.push({ name, description, schema, handler });
    },
  };

  registerTaskTools(server as unknown as McpServer);
  return registrations;
}

test("registerTaskTools preserves the public task tool surface", () => {
  const registrations = collectTaskToolRegistrations();

  assert.deepEqual(registrations.map((registration) => registration.name), [
    "add_task",
    "get_board",
    "get_board_settings",
    "set_board_manager_mode",
    "assign_board_manager",
    "release_board_manager",
    "register_board_intent",
    "register_task_create_intent",
    "register_task_claim_intent",
    "register_task_close_intent",
    "register_task_lease_action_intent",
    "list_board_intents",
    "approve_board_intent",
    "deny_board_intent",
    "get_room_events",
    "get_room_artifacts",
    "publish_room_artifact",
    "claim_task",
    "update_task",
    "complete_task",
    "claim_task_review",
    "release_task_review",
    "release_task_lease",
    "handoff_task_lease",
    "submit_review_verdict",
  ]);
  assert.ok(registrations.every((registration) => typeof registration.handler === "function"));
});

test("worker task mutations keep registered worker-session inputs", () => {
  const registrations = collectTaskToolRegistrations();
  const workerToolNames = new Set([
    "add_task",
    "claim_task",
    "update_task",
    "complete_task",
    "register_board_intent",
    "register_task_create_intent",
    "register_task_claim_intent",
    "register_task_close_intent",
    "register_task_lease_action_intent",
    "approve_board_intent",
    "deny_board_intent",
    "claim_task_review",
    "release_task_review",
    "release_task_lease",
    "handoff_task_lease",
    "submit_review_verdict",
  ]);

  for (const registration of registrations) {
    if (!workerToolNames.has(registration.name)) continue;

    assert.ok("room_id" in registration.schema, `${registration.name} should accept room_id`);
    assert.ok("conversation_id" in registration.schema, `${registration.name} should accept conversation_id`);
    assert.ok("agent_session_id" in registration.schema, `${registration.name} should accept agent_session_id`);
  }
});

test("submit_review_verdict requires an exact 40-hex expected head SHA", () => {
  const verdict = collectTaskToolRegistrations()
    .find((registration) => registration.name === "submit_review_verdict");
  assert.ok(verdict);
  const expectedHead = verdict.schema.expected_head_sha as {
    safeParse(value: unknown): { success: boolean };
  };
  assert.equal(expectedHead.safeParse("a".repeat(40)).success, true);
  assert.equal(expectedHead.safeParse("a".repeat(39)).success, false);
  assert.equal(expectedHead.safeParse("HEAD").success, false);
  assert.equal(expectedHead.safeParse(undefined).success, false);
});
