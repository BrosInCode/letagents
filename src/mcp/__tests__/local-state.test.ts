import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearPendingDeviceAuth,
  endStoredAgentSession,
  getCurrentAgentSession,
  getCurrentCodexLiveSession,
  getLocalStatePath,
  getPendingDeviceAuth,
  getStoredAgentIdentity,
  getStoredAuth,
  getStoredCodexLiveSession,
  getStoredCurrentRoom,
  getStoredRoomSession,
  readLocalState,
  saveAgentSession,
  saveCodexLiveSession,
  saveRoomSession,
  setPendingDeviceAuth,
  setStoredAgentIdentity,
  setStoredAuth,
  touchRoomSession,
  updateCodexLiveSession,
  updateLocalState,
  type CodexLiveSessionState,
  type PendingDeviceAuthState,
  type StoredAgentIdentityState,
  type StoredAgentSessionState,
} from "../local-state.js";
import { resolveWaitAgentSession } from "../server/tools/messages/wait-tool.js";

function withTempLocalState(callback: () => void): void {
  const previousStatePath = process.env.LETAGENTS_STATE_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-local-state-"));
  process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");

  try {
    callback();
  } finally {
    if (previousStatePath === undefined) {
      delete process.env.LETAGENTS_STATE_PATH;
    } else {
      process.env.LETAGENTS_STATE_PATH = previousStatePath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const pendingAuth: PendingDeviceAuthState = {
  request_id: "device_request_1",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  interval_seconds: 5,
  expires_at: "2099-01-01T00:00:00.000Z",
  started_at: "2026-05-28T00:00:00.000Z",
  suggested_room_id: "room_1",
};

const identity: StoredAgentIdentityState = {
  name: "agent",
  display_name: "Agent",
  owner_label: "Owner",
  actor_label: "Owner | Agent",
  source: "local",
  resolved_at: "2026-05-28T00:00:00.000Z",
};

function agentSession(input: Partial<StoredAgentSessionState> = {}): StoredAgentSessionState {
  const now = input.updated_at ?? "2026-05-28T00:00:00.000Z";
  const session: StoredAgentSessionState = {
    session_id: input.session_id ?? "agent_session_1",
    session_token: input.session_token ?? "token_1",
    room_id: input.room_id ?? "room_1",
    session_kind: input.session_kind ?? "worker",
    runtime: input.runtime ?? "codex",
    actor_label: input.actor_label ?? "Owner | Agent",
    agent_key: input.agent_key ?? "agent_key_1",
    display_name: input.display_name ?? "Agent",
    owner_label: input.owner_label ?? "Owner",
    ide_label: input.ide_label ?? "Codex",
    created_at: input.created_at ?? now,
    updated_at: now,
    last_seen_at: input.last_seen_at ?? now,
  };
  if (input.ended_at !== undefined) {
    session.ended_at = input.ended_at;
  }
  return session;
}

function codexSession(input: Partial<CodexLiveSessionState> = {}): CodexLiveSessionState {
  const now = input.updated_at ?? "2026-05-28T00:00:00.000Z";
  return {
    session_id: input.session_id ?? "codex_session_1",
    room_id: input.room_id ?? "room_1",
    room_identifier: input.room_identifier ?? input.room_id ?? "room_1",
    joined_via: input.joined_via ?? "join_room",
    cwd: input.cwd ?? "/tmp/letagents",
    repo_branch: input.repo_branch ?? "codex/git-rooms",
    stop_phrase: input.stop_phrase ?? "/stop-codex-room",
    max_minutes: input.max_minutes ?? 0,
    deadline_utc: input.deadline_utc ?? null,
    token: input.token ?? "LOCAL_CODEX_ROOM_test",
    thread_id: input.thread_id ?? "thread_1",
    turn_id: input.turn_id ?? "turn_1",
    server_url: input.server_url ?? "ws://127.0.0.1:8765",
    server_pid: input.server_pid ?? null,
    launched_server: input.launched_server ?? false,
    codex_bin: input.codex_bin ?? "codex",
    status: input.status ?? "running",
    last_error: input.last_error ?? null,
    started_at: input.started_at ?? now,
    updated_at: now,
  };
}

test("auth helpers clear pending device auth and remove expired auth", () => {
  withTempLocalState(() => {
    assert.equal(getLocalStatePath().endsWith("state.json"), true);

    setPendingDeviceAuth(pendingAuth);
    assert.deepEqual(getPendingDeviceAuth(), pendingAuth);

    const stored = setStoredAuth({
      token: "letagents_token",
      stored_at: "2026-05-28T00:00:00.000Z",
      source: "device_flow",
      account: { login: "octocat" },
    });

    assert.deepEqual(getStoredAuth(), stored);
    assert.equal(getPendingDeviceAuth(), null);
    assert.equal(readLocalState().pending_device_auth, undefined);

    setStoredAuth({
      token: "expired_token",
      expires_at: "2000-01-01T00:00:00.000Z",
      stored_at: "1999-01-01T00:00:00.000Z",
      source: "device_flow",
    });

    assert.equal(getStoredAuth(), null);
    assert.equal(readLocalState().auth, undefined);
  });
});

test("pending device auth expires and can be cleared explicitly", () => {
  withTempLocalState(() => {
    setPendingDeviceAuth({
      ...pendingAuth,
      expires_at: "2000-01-01T00:00:00.000Z",
    });

    assert.equal(getPendingDeviceAuth(), null);
    assert.equal(readLocalState().pending_device_auth, undefined);

    setPendingDeviceAuth(pendingAuth);
    clearPendingDeviceAuth();
    assert.equal(getPendingDeviceAuth(), null);
  });
});

test("agent identities keep scoped identities separate from instance fallback", () => {
  withTempLocalState(() => {
    setStoredAgentIdentity(identity);
    assert.deepEqual(getStoredAgentIdentity(), identity);
    assert.deepEqual(getStoredAgentIdentity("legacy-room"), identity);
    assert.equal(getStoredAgentIdentity("instance:other-process"), null);

    const scopedIdentity = {
      ...identity,
      name: "scoped",
      display_name: "Scoped Agent",
      actor_label: "Owner | Scoped Agent",
    };
    setStoredAgentIdentity(scopedIdentity, "instance:process-1");

    assert.deepEqual(getStoredAgentIdentity("instance:process-1"), scopedIdentity);
    assert.equal(getStoredAgentIdentity("instance:process-2"), null);
    assert.deepEqual(getStoredAgentIdentity(), scopedIdentity);
  });
});

test("agent session helpers maintain current sessions per room and skip ended sessions", () => {
  withTempLocalState(() => {
    const oldSession = saveAgentSession(agentSession({
      session_id: "agent_session_old",
      room_id: "room_1",
      updated_at: "2026-05-28T00:00:00.000Z",
    }));
    const newSession = saveAgentSession(agentSession({
      session_id: "agent_session_new",
      room_id: "room_2",
      updated_at: "2026-05-28T00:05:00.000Z",
    }));

    assert.deepEqual(getCurrentAgentSession("room_1"), oldSession);
    assert.deepEqual(getCurrentAgentSession("room_2"), newSession);
    assert.deepEqual(getCurrentAgentSession(), newSession);
    assert.equal(resolveWaitAgentSession("room_1", null), null);
    assert.equal(resolveWaitAgentSession("room_1", undefined), null);
    assert.deepEqual(resolveWaitAgentSession("room_1", oldSession.session_id), oldSession);

    const ended = endStoredAgentSession("agent_session_new", "2026-05-28T00:06:00.000Z");
    assert.equal(ended?.ended_at, "2026-05-28T00:06:00.000Z");
    assert.equal(getCurrentAgentSession("room_2"), null);
    assert.deepEqual(getCurrentAgentSession(), oldSession);
  });
});

test("room session helpers preserve join metadata and update current room on touch", () => {
  withTempLocalState(() => {
    saveRoomSession({
      room_id: "room_1",
      code: "ABCD-1234",
      display_name: "Room One",
      git_room: {
        provider: "github",
        repository: { full_name: "owner/repo" },
        ref: { type: "branch", name: "codex/git-rooms" },
      },
      joined_via: "join_room",
      last_message_id: "msg_1",
    });

    const originalJoinedAt = "2026-05-28T00:00:00.000Z";
    updateLocalState((state) => {
      const session = state.room_sessions?.room_1;
      assert.ok(session);
      session.joined_at = originalJoinedAt;
      if (state.current_room?.room_id === "room_1") {
        state.current_room = { ...state.current_room, joined_at: originalJoinedAt };
      }
      return state;
    });

    const resaved = saveRoomSession({
      room_id: "room_1",
      joined_via: "auto",
    });

    assert.equal(resaved.joined_at, originalJoinedAt);
    assert.equal(resaved.code, "ABCD-1234");
    assert.equal(resaved.display_name, "Room One");
    assert.deepEqual(resaved.git_room, {
      provider: "github",
      repository: { full_name: "owner/repo" },
      ref: { type: "branch", name: "codex/git-rooms" },
    });
    assert.equal(resaved.last_message_id, "msg_1");

    const touchedWithoutMessage = touchRoomSession("room_1");
    assert.equal(touchedWithoutMessage?.last_message_id, "msg_1");
    assert.deepEqual(getStoredCurrentRoom(), touchedWithoutMessage);

    const touchedWithMessage = touchRoomSession("room_1", "msg_2");
    assert.equal(touchedWithMessage?.last_message_id, "msg_2");
    assert.deepEqual(getStoredRoomSession("room_1"), touchedWithMessage);
    assert.equal(touchRoomSession("missing_room"), null);
  });
});

test("codex live session helpers maintain per-room current sessions", () => {
  withTempLocalState(() => {
    const first = saveCodexLiveSession(codexSession({
      session_id: "codex_session_1",
      room_id: "room_1",
      updated_at: "2026-05-28T00:00:00.000Z",
    }));
    const second = saveCodexLiveSession(codexSession({
      session_id: "codex_session_2",
      room_id: "room_2",
      updated_at: "2026-05-28T00:10:00.000Z",
    }));

    assert.deepEqual(getCurrentCodexLiveSession("room_1"), first);
    assert.deepEqual(getCurrentCodexLiveSession("room_2"), second);
    assert.deepEqual(getCurrentCodexLiveSession(), second);
    assert.deepEqual(getStoredCodexLiveSession("codex_session_1"), first);
    assert.equal(getStoredCodexLiveSession("codex_session_1")?.repo_branch, "codex/git-rooms");

    const background = saveCodexLiveSession(codexSession({
      session_id: "codex_session_3",
      room_id: "room_3",
      updated_at: "2026-05-28T00:20:00.000Z",
    }), false);

    assert.equal(getCurrentCodexLiveSession("room_3"), null);
    const updated = updateCodexLiveSession(background.session_id, (session) => ({
      ...session,
      status: "failed",
      updated_at: "2026-05-28T00:21:00.000Z",
    }));

    assert.equal(updated?.status, "failed");
    assert.deepEqual(getCurrentCodexLiveSession("room_3"), updated);
    assert.equal(updateCodexLiveSession("missing_session", (session) => session), null);
  });
});
