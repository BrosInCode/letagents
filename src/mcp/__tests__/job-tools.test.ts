import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { registerJobTools } = await import("../server/tools/jobs.js");
const { REMOTE_ALLOWED_TOOLS } = await import("../server/remote-tool-surface.js");
const { SUPERVISED_READ_ONLY_TOOLS } = await import("../../../shared/supervised-read-tools.mjs");
const { CODEX_READ_ONLY_ROOM_TOOLS } = await import("../../../shared/codex-read-only-room-tools.mjs");

function registered(): Map<string, { description: string; schema: Record<string, unknown> }> {
  const tools = new Map<string, { description: string; schema: Record<string, unknown> }>();
  registerJobTools({ tool(name: string, description: string, schema: Record<string, unknown>) {
    tools.set(name, { description, schema });
  } } as unknown as McpServer);
  return tools;
}

test("agents get get_job, update_job and complete_job, keyed by the job id in the message's client_message_id", () => {
  const tools = registered();
  assert.deepEqual([...tools.keys()], ["get_job", "update_job", "complete_job"]);
  assert.deepEqual(Object.keys(tools.get("update_job")!.schema), ["job_id", "progress", "state", "room_id", "agent_session_id"]);
  assert.deepEqual(Object.keys(tools.get("complete_job")!.schema), ["job_id", "result", "error", "room_id", "agent_session_id"]);
  for (const { description } of tools.values()) assert.match(description, /client_message_id is "internal:job:<job id>"/);
  assert.match(tools.get("complete_job")!.description, /resultSchema/);
});

test("job tools reach every agent kind; only get_job is a read", () => {
  for (const name of ["get_job", "update_job", "complete_job"]) {
    assert.ok(REMOTE_ALLOWED_TOOLS.includes(name), name);
    // A Read-only Codex agent may still report on work it was given.
    assert.ok(CODEX_READ_ONLY_ROOM_TOOLS.has(name), name);
  }
  assert.ok(SUPERVISED_READ_ONLY_TOOLS.has("get_job"));
  assert.ok(!SUPERVISED_READ_ONLY_TOOLS.has("update_job") && !SUPERVISED_READ_ONLY_TOOLS.has("complete_job"),
    "reports go through the supervised effect journal");
});
