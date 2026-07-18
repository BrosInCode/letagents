import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopManagedAgentSession } from "../../electron/ipc-types";
import { createManagedAgentSessionViewSelector } from "../src/components/desktop/content/add-agent/managed-agent-sessions-context";

function session(overrides: Partial<DesktopManagedAgentSession> = {}): DesktopManagedAgentSession {
  return {
    id: "managed_1",
    providerId: "codex",
    runtime: "codex-cli",
    roomIdentifier: "room-1",
    roomDisplayName: "Room one",
    repoRootPath: "/tmp/repo",
    repoBranch: "main",
    status: "running",
    deliveryMode: "desktop_events",
    permissionProfileId: "full_access",
    permissionProfile: {
      id: "full_access",
      label: "Full access",
      description: "Full access",
      status: "available",
      risk: "high",
      detail: null,
      isDefault: true,
    },
    canStop: true,
    agentSessionId: null,
    actorLabel: null,
    agentKey: null,
    displayName: "Codex agent",
    ownerLabel: null,
    ideLabel: null,
    reasoningSessionId: null,
    activeWork: null,
    pendingPermissionRequests: [],
    startedAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

test("managed-session selector retains its view for identical and heartbeat-only data", () => {
  const select = createManagedAgentSessionViewSelector();
  const first = select([session()], "room-1", "codex");
  const identical = select([session()], "room-1", "codex");
  const heartbeat = select([session({ updatedAt: "2026-07-18T10:00:04.000Z" })], "room-1", "codex");

  assert.strictEqual(identical, first);
  assert.strictEqual(heartbeat, first);
});

test("managed-session selector replaces its view when rendered fields change", () => {
  const select = createManagedAgentSessionViewSelector();
  const first = select([session()], "room-1", "codex");

  assert.notStrictEqual(select([session({ status: "stopped" })], "room-1", "codex"), first);
  const renamed = select([session({ displayName: "Renamed agent" })], "room-1", "codex");
  assert.notStrictEqual(renamed, first);
  assert.notStrictEqual(select([session({ canStop: false })], "room-1", "codex"), renamed);
});

test("managed-session selector preserves rendered permission, Cursor policy, and effort detail", () => {
  const select = createManagedAgentSessionViewSelector();
  const cursor = session({
    providerId: "cursor",
    runtime: "cursor-agent",
    displayName: "Cursor agent",
    permissionProfileId: "sandboxed_write",
    permissionProfile: undefined as unknown as DesktopManagedAgentSession["permissionProfile"],
    cursorMcpPolicy: "normal",
    effort: "max",
    lastError: "Provider connection lost",
  });
  const first = select([cursor], "room-1", "cursor");

  assert.match(first[0]!.detail, /sandboxed write/);
  assert.match(first[0]!.detail, /Normal Cursor MCPs/);
  assert.match(first[0]!.detail, /Max effort/);
  assert.equal(
    select([{ ...cursor, lastError: "A different hidden diagnostic" }], "room-1", "cursor"),
    first,
    "non-rendered diagnostics must not invalidate the visible session model",
  );
  assert.notStrictEqual(
    select([{ ...cursor, cursorMcpPolicy: "none" }], "room-1", "cursor"),
    first,
  );
});
