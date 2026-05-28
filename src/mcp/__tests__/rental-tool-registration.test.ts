import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRentalTools } from "../server/tools/rental.js";

type ToolRegistration = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: unknown;
};

function collectRentalToolRegistrations(): ToolRegistration[] {
  const registrations: ToolRegistration[] = [];
  const server = {
    tool(name: string, description: string, schema: Record<string, unknown>, handler: unknown) {
      registrations.push({ name, description, schema, handler });
    },
  };

  registerRentalTools(server as unknown as McpServer);
  return registrations;
}

test("registerRentalTools preserves the public rental tool surface", () => {
  const registrations = collectRentalToolRegistrations();

  assert.deepEqual(registrations.map((registration) => registration.name), [
    "rental_list_requests",
    "rental_accept",
    "rental_provision",
    "rental_decline",
    "rental_heartbeat",
    "rental_refresh_quota",
    "rental_report_usage",
    "rental_request_budget_extension",
    "rental_read_file",
    "rental_search",
    "rental_propose_edit",
    "rental_propose_patch",
    "rental_run_command",
    "rental_emit_activity",
    "rental_complete",
    "rental_cancel",
  ]);
  assert.ok(registrations.every((registration) => typeof registration.handler === "function"));
});

test("rental tools keep expected input fields", () => {
  const schemaByName = new Map(
    collectRentalToolRegistrations().map((registration) => [
      registration.name,
      registration.schema,
    ])
  );

  assert.deepEqual(Object.keys(schemaByName.get("rental_list_requests")!), []);
  assert.ok("session_id" in schemaByName.get("rental_accept")!);
  assert.ok("idempotency_key" in schemaByName.get("rental_accept")!);
  assert.ok("parent_room_id" in schemaByName.get("rental_provision")!);
  assert.ok("provider_display_name" in schemaByName.get("rental_provision")!);
  assert.ok("reason" in schemaByName.get("rental_decline")!);
  assert.ok("provider" in schemaByName.get("rental_refresh_quota")!);
  assert.ok("report" in schemaByName.get("rental_report_usage")!);
  assert.ok("requested_additional_lrt" in schemaByName.get("rental_request_budget_extension")!);
  assert.ok("path" in schemaByName.get("rental_read_file")!);
  assert.ok("query" in schemaByName.get("rental_search")!);
  assert.ok("before_content" in schemaByName.get("rental_propose_edit")!);
  assert.ok("files" in schemaByName.get("rental_propose_patch")!);
  assert.ok("argv" in schemaByName.get("rental_run_command")!);
  assert.ok("event_type" in schemaByName.get("rental_emit_activity")!);
  assert.ok("summary" in schemaByName.get("rental_complete")!);
  assert.ok("reason" in schemaByName.get("rental_cancel")!);
});
