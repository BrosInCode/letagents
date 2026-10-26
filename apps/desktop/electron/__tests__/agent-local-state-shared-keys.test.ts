import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const { readAgentLocalState, saveAgentSession } = await import("../main/agents/state.js");

let stateDir: string;
let statePath: string;
let previousStatePath: string | undefined;

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "letagents-shared-state-"));
  statePath = join(stateDir, "mcp-state.json");
  previousStatePath = process.env.LETAGENTS_STATE_PATH;
  process.env.LETAGENTS_STATE_PATH = statePath;
});

after(() => {
  if (previousStatePath === undefined) delete process.env.LETAGENTS_STATE_PATH;
  else process.env.LETAGENTS_STATE_PATH = previousStatePath;
  rmSync(stateDir, { recursive: true, force: true });
});

function seedState(): void {
  writeFileSync(statePath, `${JSON.stringify({
    local_host_id: "host_1",
    agent_sessions: {},
    current_agent_session_ids: {},
    // Written by `letagents` MCP packages before 0.12.46 (start_local_codex_session).
    codex_live_sessions: {
      local_package: { session_id: "local_package", room_id: "room_a", status: "running" },
      local_desktop: { session_id: "local_desktop", room_id: "room_b", status: "running", desktop_managed: true, delivery_mode: "desktop_events" },
    },
    current_codex_live_session_ids: { room_a: "local_package", room_b: "local_desktop" },
    // Owned only by the retired Electron engine.
    cursor_live_sessions: { local_cursor: { session_id: "local_cursor" } },
    current_cursor_live_session_ids: { room_c: "local_cursor" },
    claude_code_live_sessions: { local_claude: { session_id: "local_claude" } },
    current_claude_code_live_session_ids: { room_d: "local_claude" },
    // Unknown to the desktop; must survive untouched.
    package_only_setting: { enabled: true },
  }, null, 2)}\n`, "utf8");
}

test("loading local state keeps the MCP package's Codex sessions and drops only the retired engine's caches", () => {
  seedState();
  const state = readAgentLocalState() as Record<string, unknown>;
  assert.deepEqual(state.codex_live_sessions, {
    local_package: { session_id: "local_package", room_id: "room_a", status: "running" },
  });
  assert.deepEqual(state.current_codex_live_session_ids, { room_a: "local_package" });
  assert.equal("cursor_live_sessions" in state, false);
  assert.equal("current_cursor_live_session_ids" in state, false);
  assert.equal("claude_code_live_sessions" in state, false);
  assert.equal("current_claude_code_live_session_ids" in state, false);
  assert.deepEqual(state.package_only_setting, { enabled: true });
});

test("a desktop write preserves the keys the MCP package owns", () => {
  seedState();
  saveAgentSession({ session_id: "worker_1", room_id: "room_a", session_kind: "worker", runtime: "codex" });
  const written = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(written.codex_live_sessions, {
    local_package: { session_id: "local_package", room_id: "room_a", status: "running" },
  });
  assert.deepEqual(written.current_codex_live_session_ids, { room_a: "local_package" });
  assert.deepEqual(written.package_only_setting, { enabled: true });
  assert.deepEqual(written.current_agent_session_ids, { room_a: "worker_1" });
  assert.equal("cursor_live_sessions" in written, false);
  assert.equal("claude_code_live_sessions" in written, false);
});
