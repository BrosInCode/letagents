import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerRepoInitializationTool,
  registerRepoVisibilityTool,
  registerRoomInspectionTools,
  registerRoomJoinTools,
  registerRoomResumeTool,
} from "../server/tools/rooms.js";

type ToolRegistration = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: unknown;
};

function collectRoomToolRegistrations(): ToolRegistration[] {
  const registrations: ToolRegistration[] = [];
  const server = {
    tool(name: string, description: string, schema: Record<string, unknown>, handler: unknown) {
      registrations.push({ name, description, schema, handler });
    },
  };

  registerRoomJoinTools(server as unknown as McpServer);
  registerRoomInspectionTools(server as unknown as McpServer);
  registerRepoInitializationTool(server as unknown as McpServer);
  registerRoomResumeTool(server as unknown as McpServer);
  registerRepoVisibilityTool(server as unknown as McpServer);
  return registrations;
}

test("room tool registration preserves the public surface", () => {
  const registrations = collectRoomToolRegistrations();

  assert.deepEqual(registrations.map((registration) => registration.name), [
    "create_room",
    "create_project",
    "join_code",
    "join_project",
    "join_room",
    "get_current_room",
    "check_repo",
    "initialize_repo",
    "resume_room_session",
    "check_repo_visibility",
  ]);
  assert.ok(registrations.every((registration) => typeof registration.handler === "function"));
});

test("room tools keep expected input fields", () => {
  const schemaByName = new Map(
    collectRoomToolRegistrations().map((registration) => [
      registration.name,
      registration.schema,
    ])
  );

  assert.ok("code" in schemaByName.get("join_code")!);
  assert.ok("session_mode" in schemaByName.get("join_code")!);
  assert.ok("code" in schemaByName.get("join_project")!);
  assert.ok("session_mode" in schemaByName.get("join_project")!);
  assert.ok("name" in schemaByName.get("join_room")!);
  assert.ok("session_mode" in schemaByName.get("join_room")!);
  assert.ok("conversation_id" in schemaByName.get("get_current_room")!);
  assert.ok("cwd" in schemaByName.get("check_repo")!);
  assert.ok("cwd" in schemaByName.get("initialize_repo")!);
  assert.ok("room" in schemaByName.get("initialize_repo")!);
  assert.ok("room_id" in schemaByName.get("resume_room_session")!);
  assert.ok("cwd" in schemaByName.get("check_repo_visibility")!);
});
