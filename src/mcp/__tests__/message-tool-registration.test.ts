import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMessageTools, registerStatusTools } from "../server/tools/messages.js";

type ToolRegistration = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: unknown;
};

function collectMessageToolRegistrations(): ToolRegistration[] {
  const registrations: ToolRegistration[] = [];
  const server = {
    tool(name: string, description: string, schema: Record<string, unknown>, handler: unknown) {
      registrations.push({ name, description, schema, handler });
    },
  };

  registerStatusTools(server as unknown as McpServer);
  registerMessageTools(server as unknown as McpServer);
  return registrations;
}

test("message and status tool registration preserves the public surface", () => {
  const registrations = collectMessageToolRegistrations();

  assert.deepEqual(registrations.map((registration) => registration.name), [
    "post_status",
    "post_reasoning",
    "send_message",
    "read_messages",
    "wait_for_messages",
  ]);
  assert.ok(registrations.every((registration) => typeof registration.handler === "function"));
});

test("worker-facing message tools keep registered worker-session inputs", () => {
  const registrations = collectMessageToolRegistrations();
  const workerToolNames = new Set([
    "post_status",
    "post_reasoning",
    "send_message",
    "wait_for_messages",
  ]);

  for (const registration of registrations) {
    assert.ok("room_id" in registration.schema, `${registration.name} should accept room_id`);
    if (!workerToolNames.has(registration.name)) continue;

    assert.ok("agent_session_id" in registration.schema, `${registration.name} should accept agent_session_id`);
  }
});
