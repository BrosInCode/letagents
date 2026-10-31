import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

const { statePath, resetState } = createElectronTestEnv({
  prefix: "letagents-agent-local-state-",
});

const {
  getOrCreateDesktopHostId,
  getStoredAgentSession,
  markAgentSessionEnded,
  readAgentLocalState,
  readAgentLocalStateSnapshot,
  saveAgentSession,
} = await import("../main/agents/state.js");

import type { StoredAgentSessionState } from "../main/agents/state.js";

function workerSession(
  overrides: Partial<StoredAgentSessionState> = {},
): StoredAgentSessionState {
  return {
    session_id: "agent_session_1",
    session_token: "session_token_1",
    room_id: "room_1",
    session_kind: "worker",
    runtime: "codex:LOCAL_CODEX_ROOM_test",
    actor_label: "StoneForge",
    agent_key: "codex/stone-forge",
    display_name: "StoneForge",
    owner_label: "EmmyMay's agent",
    ide_label: "Codex",
    created_at: "2026-06-14T12:00:00.000Z",
    updated_at: "2026-06-14T12:00:00.000Z",
    last_seen_at: "2026-06-14T12:00:00.000Z",
    ended_at: null,
    ...overrides,
  };
}

test("loading local state drops the retired in-app session caches permanently", () => {
  resetState({
    local_host_id: "host_keep",
    current_claude_code_live_session_ids: { room_1: "legacy_claude" },
    claude_code_live_sessions: {
      legacy_claude: { session_id: "legacy_claude", room_id: "room_1", delivery_mode: "desktop_events" },
    },
    current_codex_live_session_ids: { room_1: "legacy_codex" },
    codex_live_sessions: {
      legacy_codex: { session_id: "legacy_codex", room_id: "room_1", delivery_mode: "desktop_events" },
    },
    current_cursor_live_session_ids: { room_1: "legacy_cursor" },
    cursor_live_sessions: {
      legacy_cursor: { session_id: "legacy_cursor", room_id: "room_1", delivery_mode: "desktop_events" },
    },
  });

  assert.deepEqual(readAgentLocalState(), { local_host_id: "host_keep" });
  assert.deepEqual(readAgentLocalStateSnapshot(), {
    state: { local_host_id: "host_keep" },
    complete: true,
  });

  // The next state write must not bring the retired caches back.
  saveAgentSession(workerSession());
  const persisted = JSON.parse(readFileSync(statePath!, "utf8")) as Record<string, unknown>;
  for (const key of [
    "current_claude_code_live_session_ids",
    "claude_code_live_sessions",
    "current_codex_live_session_ids",
    "codex_live_sessions",
    "current_cursor_live_session_ids",
    "cursor_live_sessions",
  ]) {
    assert.equal(key in persisted, false, `${key} must not survive a state write`);
  }
  assert.equal(persisted.local_host_id, "host_keep");
  assert.ok(persisted.agent_sessions, "the agent session saved after the load is kept");
});

test("local state snapshot is complete when the file is missing and incomplete when it is unreadable", () => {
  rmSync(statePath!, { force: true });
  assert.deepEqual(readAgentLocalStateSnapshot(), { state: {}, complete: true });

  writeFileSync(statePath!, "{ this is not json");
  assert.deepEqual(readAgentLocalStateSnapshot(), { state: {}, complete: false });
  assert.deepEqual(readAgentLocalState(), {});
});

test("desktop host id and worker session state are persisted for room surfaces", () => {
  resetState();

  const hostId = getOrCreateDesktopHostId();
  assert.match(hostId, /^host_[0-9a-f]{32}$/);
  assert.equal(getOrCreateDesktopHostId(), hostId);

  const session = saveAgentSession(workerSession({
    session_id: "worker_desktop",
    session_token: "token_desktop",
    host_id: hostId,
    host_kind: "macos",
    host_label: "LetAgents Desktop",
    liveness_capability: "desktop_supervised_codex_app_server",
    tool_bridge_id: `${hostId}:codex:desktop`,
    actor_label: "CedarVista | EmmyMay's agent | Codex",
    agent_key: "EmmyMay/cedar-vista",
    agent_instance_id: "desktop-codex:LOCAL_CODEX_ROOM_test",
    display_name: "CedarVista",
    owner_label: "EmmyMay",
  }));

  assert.deepEqual(getStoredAgentSession("worker_desktop"), session);
  assert.equal(getStoredAgentSession("missing_session"), null);
  assert.equal(getStoredAgentSession("   "), null);
  assert.equal(getStoredAgentSession(null), null);
  assert.equal(readAgentLocalState().current_agent_session_ids?.room_1, "worker_desktop");
  assert.equal(readAgentLocalState().local_host_id, hostId);
});

test("ending a worker session stamps it and clears it as the room's current session", () => {
  resetState();
  saveAgentSession(workerSession({ session_id: "worker_current", room_id: "room_1" }));
  saveAgentSession(workerSession({ session_id: "worker_other", room_id: "room_2" }));

  const ended = markAgentSessionEnded("worker_current", "2026-06-14T13:00:00.000Z");

  assert.equal(ended?.ended_at, "2026-06-14T13:00:00.000Z");
  assert.equal(ended?.updated_at, "2026-06-14T13:00:00.000Z");
  assert.equal(getStoredAgentSession("worker_current")?.ended_at, "2026-06-14T13:00:00.000Z");
  assert.equal(readAgentLocalState().current_agent_session_ids?.room_1, undefined);
  assert.equal(readAgentLocalState().current_agent_session_ids?.room_2, "worker_other");
  assert.equal(getStoredAgentSession("worker_other")?.ended_at, null);
  assert.equal(markAgentSessionEnded("missing_session"), null);
  assert.equal(markAgentSessionEnded(null), null);
});
