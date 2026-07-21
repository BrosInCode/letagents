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
