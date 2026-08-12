import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopManagedAgentSession } from "../../electron/ipc-types";
import {
  managedAgentSessionListsEqual,
  withRoomManagedAgentSessions,
  withUpsertedManagedAgentSession,
} from "../src/domain/managed-agents";

function session(overrides: Partial<DesktopManagedAgentSession> = {}): DesktopManagedAgentSession {
  return {
    id: "session_1",
    providerId: "claude-code",
    runtime: "claude-code:token",
    roomIdentifier: "room_1",
    roomDisplayName: null,
    repoRootPath: "/tmp/repo",
    repoBranch: "main",
    status: "completed",
    deliveryMode: "desktop_events",
    permissionProfileId: "full_access",
    permissionProfile: {
      id: "full_access",
      label: "Full access",
      status: "available",
      risk: "high",
      isDefault: false,
      description: "Full access",
      detail: "Full access",
    },
    canStop: true,
    agentSessionId: "agent_session_1",
    actorLabel: "CedarVista | Emmy's agent | Claude Code",
    agentKey: "emmy/cedarvista",
    displayName: "CedarVista",
    ownerLabel: "Emmy",
    ideLabel: "Claude Code",
    model: null,
    reasoningSessionId: null,
    activeWork: null,
    pendingPermissionRequests: [],
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    lastError: null,
    ...overrides,
  } as DesktopManagedAgentSession;
}

test("content-equal polled lists keep the current array reference", () => {
  const current = [session()];
  const polledCopy = [session()];
  assert.equal(managedAgentSessionListsEqual(current, polledCopy), true);
  assert.equal(withRoomManagedAgentSessions(current, "room_1", polledCopy), current);
});

test("a real change produces a new list", () => {
  const current = [session()];
  const changed = [session({ status: "running" })];
  assert.equal(managedAgentSessionListsEqual(current, changed), false);
  const next = withRoomManagedAgentSessions(current, "room_1", changed);
  assert.notEqual(next, current);
  assert.equal(next[0]?.status, "running");
});

test("room replacement preserves sessions from other rooms", () => {
  const otherRoom = session({ id: "session_2", roomIdentifier: "room_2" });
  const current = [otherRoom, session()];
  const next = withRoomManagedAgentSessions(current, "room_1", [session({ status: "running" })]);
  assert.deepEqual(next.map((entry) => entry.id), ["session_2", "session_1"]);
});

test("content-equal upserts keep the current array and order", () => {
  const a = session();
  const b = session({ id: "session_2" });
  const current = [b, a];
  assert.equal(withUpsertedManagedAgentSession(current, session()), current);
  const next = withUpsertedManagedAgentSession(current, session({ status: "running" }));
  assert.notEqual(next, current);
  assert.deepEqual(next.map((entry) => entry.id), ["session_1", "session_2"]);
});
