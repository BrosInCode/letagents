import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({ prefix: "ipc-room-delivery-retry-" });
env.resetState({});

type Handler = (event: unknown, input: unknown) => Promise<unknown> | unknown;
const handlers = new Map<string, Handler>();
const fakeIpcMain = {
  handle(channel: string, handler: Handler) { handlers.set(channel, handler); },
  on() {},
  removeHandler() {},
};

mock.module("electron", {
  defaultExport: { ipcMain: fakeIpcMain },
  namedExports: { ipcMain: fakeIpcMain },
});

const { registerDesktopIpcHandlers } = await import("../main/ipc.js");
const { supervisorDaemonClient } = await import("../main/supervisor-daemon.js");
const { supervisorGrantCoordinator } = await import("../main/supervisor-grant-coordinator.js");

test("registerDesktopIpcHandlers routes exact room-delivery retries and propagates stale failures", async () => {
  const original = supervisorDaemonClient.retryRoomDelivery;
  const seen: unknown[] = [];
  try {
    (supervisorDaemonClient as unknown as { retryRoomDelivery(input: unknown): Promise<void> }).retryRoomDelivery = async (input) => { seen.push(input); };
    registerDesktopIpcHandlers(fakeIpcMain as never);
    const handler = handlers.get("desktop:supervisor:retry-room-delivery");
    assert.ok(handler, "the production IPC registration owns the retry channel");
    const exact = {
      entryId: "agent_1", roomId: "room_1", sourceMessageId: "msg_1", workAttemptId: "attempt_1",
      executionGenerationId: "generation_1", agentSessionId: "session_1",
    };
    await handler!({}, exact);
    assert.deepEqual(seen, [exact]);
    (supervisorDaemonClient as unknown as { retryRoomDelivery(input: unknown): Promise<void> }).retryRoomDelivery = async () => {
      throw new Error("The room delivery binding is stale; refresh before retrying.");
    };
    await assert.rejects(async () => { await handler!({}, exact); }, /binding is stale/);
  } finally {
    (supervisorDaemonClient as unknown as { retryRoomDelivery: typeof original }).retryRoomDelivery = original;
  }
});

test("purge IPC never attests an exact worker session when local revocation identity is unavailable", async () => {
  const originalPurge = supervisorDaemonClient.purgeAgent;
  const originalRevoke = supervisorGrantCoordinator.revokeEntryForPurge;
  const calls: Array<string | null> = [];
  try {
    (supervisorDaemonClient as unknown as {
      purgeAgent(entryId: string, daemonGeneration: number, revokedAgentSessionId?: string | null): Promise<{ outcome: "revocation_required"; operationId: string; agentSessionId: string }>;
    }).purgeAgent = async (_entryId, _daemonGeneration, revokedAgentSessionId = null) => {
      calls.push(revokedAgentSessionId);
      return { outcome: "revocation_required", operationId: "purge:agent_1", agentSessionId: "session_1" };
    };
    (supervisorGrantCoordinator as unknown as {
      revokeEntryForPurge(entryId: string, agentSessionId: string): Promise<void>;
    }).revokeEntryForPurge = async (_entryId, agentSessionId) => {
      assert.equal(agentSessionId, "session_1");
      throw new Error("local supervisor-grant registry is missing; local agent state was preserved");
    };
    const handler = handlers.get("desktop:supervisor:purge-agent");
    assert.ok(handler, "the production IPC registration owns the purge channel");
    await assert.rejects(
      async () => { await handler!({}, { entryId: "agent_1", daemonGeneration: 40 }); },
      /registry is missing.*local agent state was preserved/,
    );
    assert.deepEqual(calls, [null], "the daemon purge journal remains at revocation_required");
  } finally {
    (supervisorDaemonClient as unknown as { purgeAgent: typeof originalPurge }).purgeAgent = originalPurge;
    (supervisorGrantCoordinator as unknown as { revokeEntryForPurge: typeof originalRevoke }).revokeEntryForPurge = originalRevoke;
  }
});

test("purge IPC advances only with the exact session whose end and grant revoke were acknowledged", async () => {
  const originalPurge = supervisorDaemonClient.purgeAgent;
  const originalRevoke = supervisorGrantCoordinator.revokeEntryForPurge;
  const calls: Array<string | null> = [];
  try {
    (supervisorDaemonClient as unknown as {
      purgeAgent(entryId: string, daemonGeneration: number, revokedAgentSessionId?: string | null): Promise<any>;
    }).purgeAgent = async (_entryId, _daemonGeneration, revokedAgentSessionId = null) => {
      calls.push(revokedAgentSessionId);
      return revokedAgentSessionId === null
        ? { outcome: "revocation_required", operationId: "purge:agent_1", agentSessionId: "session_exact" }
        : { outcome: "purged" };
    };
    (supervisorGrantCoordinator as unknown as {
      revokeEntryForPurge(entryId: string, agentSessionId: string): Promise<void>;
    }).revokeEntryForPurge = async (entryId, agentSessionId) => {
      assert.equal(entryId, "agent_1");
      assert.equal(agentSessionId, "session_exact");
    };
    registerDesktopIpcHandlers(fakeIpcMain as never);
    const handler = handlers.get("desktop:supervisor:purge-agent");
    const result = await handler!({}, { entryId: "agent_1", daemonGeneration: 40 });
    assert.deepEqual(result, { outcome: "purged" });
    assert.deepEqual(calls, [null, "session_exact"]);
  } finally {
    (supervisorDaemonClient as unknown as { purgeAgent: typeof originalPurge }).purgeAgent = originalPurge;
    (supervisorGrantCoordinator as unknown as { revokeEntryForPurge: typeof originalRevoke }).revokeEntryForPurge = originalRevoke;
  }
});

test("room-move IPC durably requests rollback and restores source authority when destination preparation fails", async () => {
  const daemon = supervisorDaemonClient as unknown as {
    commitRoomMove(input: unknown): Promise<any>;
    rollbackRoomMove(input: unknown): Promise<any>;
  };
  const coordinator = supervisorGrantCoordinator as unknown as {
    prepareRoomMoveDestination(move: unknown): Promise<void>;
    prepareRoomMoveSourceRollback(move: unknown): Promise<void>;
  };
  const originalCommit = daemon.commitRoomMove;
  const originalRollback = daemon.rollbackRoomMove;
  const originalDestination = coordinator.prepareRoomMoveDestination;
  const originalSource = coordinator.prepareRoomMoveSourceRollback;
  const events: string[] = [];
  const base = {
    operationId: "move_1", requestId: "request_1", entryId: "agent_1",
    sourceRoomId: "room_1", destinationRoomId: "room_2", daemonGeneration: 40,
    workAttemptId: "attempt_1", executionGenerationId: "execution_1",
    agentSessionId: "session_1", remoteRoomId: "room_2", destinationCursor: null,
    sourceCredentialsRevoked: false, error: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
  };
  let commits = 0;
  try {
    daemon.commitRoomMove = async () => {
      commits += 1;
      events.push(`commit:${commits}`);
      return commits === 1 ? { ...base, phase: "rotating_credentials" } : {
        ...base, phase: "failed", error: "source restored",
      };
    };
    daemon.rollbackRoomMove = async (input) => {
      events.push(`rollback:${(input as { error: string }).error}`);
      return { ...base, phase: "rollback_required", error: "destination failed" };
    };
    coordinator.prepareRoomMoveDestination = async () => {
      events.push("destination");
      throw new Error("owner API unavailable");
    };
    coordinator.prepareRoomMoveSourceRollback = async () => { events.push("source"); };
    registerDesktopIpcHandlers(fakeIpcMain as never);
    const handler = handlers.get("desktop:supervisor:commit-room-move");
    assert.ok(handler);
    const result = await handler!({}, { operationId: "move_1", entryId: "agent_1", daemonGeneration: 40 }) as { phase: string };
    assert.equal(result.phase, "failed");
    assert.deepEqual(events, [
      "commit:1", "destination", "rollback:owner API unavailable", "source", "commit:2",
    ]);
  } finally {
    daemon.commitRoomMove = originalCommit;
    daemon.rollbackRoomMove = originalRollback;
    coordinator.prepareRoomMoveDestination = originalDestination;
    coordinator.prepareRoomMoveSourceRollback = originalSource;
  }
});
