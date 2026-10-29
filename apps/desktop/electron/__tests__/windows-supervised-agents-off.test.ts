import assert from "node:assert/strict";
import { join } from "node:path";
import test, { mock } from "node:test";

import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({ prefix: "windows-supervised-agents-off-" });

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;
const handlers = new Map<string, Handler>();
const fakeIpcMain = {
  handle(channel: string, handler: Handler) { handlers.set(channel, handler); },
  on() {},
  removeHandler() {},
};
const app = { name: "LetAgents", getPath: () => "", getVersion: () => "0.0.0", isPackaged: false, relaunch() {}, exit() {} };
mock.module("electron", {
  defaultExport: { ipcMain: fakeIpcMain, app, dialog: {}, BrowserWindow: class {}, shell: {}, safeStorage: {} },
  namedExports: { ipcMain: fakeIpcMain, app, dialog: {}, BrowserWindow: class {}, shell: {}, safeStorage: {} },
});

const capabilities = await import("../main/platform-capabilities.js");
// Everything below runs as if on Windows, whatever machine runs the suite.
const previousDaemonOverride = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
capabilities.setDesktopPlatformCapabilitiesForTest({ platform: "win32" });
test.after(() => {
  capabilities.setDesktopPlatformCapabilitiesForTest(null);
  if (previousDaemonOverride !== undefined) process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousDaemonOverride;
});

const { SupervisorDaemonClient, supervisorDaemonClient } = await import("../main/supervisor-daemon.js");
const { registerDesktopSupervisorIpcHandlers } = await import("../main/ipc-handlers/supervisor.js");
const { registerDesktopWorkerIpcHandlers } = await import("../main/ipc-handlers/workers.js");
const { registerDaemonMaintenanceIpcHandlers } = await import("../main/ipc-handlers/maintenance.js");
const { registerDesktopAskIpcHandlers } = await import("../main/ipc-handlers/asks.js");
const { registerDesktopAuthAndSetupIpcHandlers } = await import("../main/ipc-handlers/auth-setup.js");
const { registerDesktopRentalDomainIpcHandlers } = await import("../main/ipc-handlers/rental.js");
const { gateSupervisedAgentIpc } = await import("../main/ipc-handlers/supervised-agent-gate.js");
const { subscribeLocalTasks, requestDesktopBoardMutation } = await import("../main/rooms/local-task-subscription.js");

// Any request to the supervisor during these tests is a failure.
const daemonCalls: string[] = [];
for (const method of ["ensureRunning", "connectIfRunning", "list", "listHostApprovals", "listHostToolRules",
  "getMaintenanceStatus", "getServiceSnapshot", "waitForStartup", "isMaintenanceHeld"] as const) {
  (supervisorDaemonClient as unknown as Record<string, unknown>)[method] = async () => {
    daemonCalls.push(method);
    throw new Error(`unexpected supervisor call: ${method}`);
  };
}

registerDesktopSupervisorIpcHandlers(fakeIpcMain as never);
registerDesktopWorkerIpcHandlers(fakeIpcMain as never);
registerDaemonMaintenanceIpcHandlers(fakeIpcMain as never);
registerDesktopAskIpcHandlers(fakeIpcMain as never);
registerDesktopAuthAndSetupIpcHandlers(fakeIpcMain as never);
const startRentalServices = registerDesktopRentalDomainIpcHandlers(fakeIpcMain as never);

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  assert.ok(handler, `${channel} is registered`);
  return Promise.resolve(handler({ sender: {}, senderFrame: null }, ...args));
}

test("the daemon client never starts or connects to the supervisor on Windows", async () => {
  let spawns = 0;
  const client = new SupervisorDaemonClient({
    socketPath: join(env.tempDir, "daemon.sock"),
    spawnDaemon: () => { spawns += 1; throw new Error("spawned"); },
  });
  await assert.rejects(client.ensureRunning(), (error: Error & { code?: string }) =>
    error instanceof capabilities.SupervisedAgentsUnsupportedError && error.code === "unsupported_platform"
      && /not available on Windows yet/.test(error.message));
  await assert.rejects(client.restartForEnvironmentRefresh(), capabilities.SupervisedAgentsUnsupportedError);
  assert.equal(await client.connectIfRunning(), null);
  // An app update has no supervisor to hand off on Windows, so it is not blocked.
  await client.prepareForApplicationUpdate();
  // Any other read is refused before a socket is opened.
  await assert.rejects(client.list(null), capabilities.SupervisedAgentsUnsupportedError);
  await assert.rejects(client.isRuntimeEnvironmentCurrent(), capabilities.SupervisedAgentsUnsupportedError);
  assert.equal(spawns, 0);
});

test("agent reads answer empty and agent actions answer a typed unsupported result", async () => {
  assert.deepEqual(await invoke("desktop:supervisor:list-agents", null), []);
  assert.deepEqual(await invoke("desktop:supervisor:list-host-approvals", "room"), { available: false, approvals: [], error: null });
  assert.deepEqual(await invoke("desktop:supervisor:list-host-tool-rules", "agent"), []);
  assert.deepEqual(await invoke("desktop:supervisor:get-launch-events", "launch", null), []);
  assert.equal(await invoke("desktop:supervisor:get-current-room-move", {}), null);
  assert.equal(await invoke("desktop:supervisor:watch-agent-stream", "entry"), undefined);
  assert.deepEqual(await invoke("desktop:maintenance:status"), { held: false, ready: false });
  assert.deepEqual(await invoke("desktop:workers:list-agent-providers"), []);
  const models = await invoke("desktop:workers:list-agent-provider-models", "codex", {}) as Record<string, unknown>;
  assert.deepEqual({ ...models, error: typeof models.error }, {
    providerId: "codex", status: "unavailable", models: [], defaultModel: null, error: "string",
  });
  const storage = await invoke("desktop:supervisor-grant:get-storage-status") as Record<string, unknown>;
  assert.equal(storage.available, false);
  assert.equal(storage.canOpenCredentialStorage, false);
  const snapshot = await invoke("desktop:supervisor:get-service-snapshot") as Record<string, unknown>;
  assert.equal(snapshot.status, null);
  assert.equal(snapshot.state, null);

  for (const channel of ["desktop:supervisor:get-status", "desktop:supervisor:create-agent", "desktop:supervisor:set-desired-state",
    "desktop:supervisor:retire-agent", "desktop:supervisor:purge-agent", "desktop:maintenance:restart",
    "desktop:workers:run-agent-provider-preflight", "desktop:workers:run-agent-provider-setup"]) {
    const result = await invoke(channel, { providerId: "codex", roomIdentifier: "room" });
    assert.equal(capabilities.isDesktopUnsupportedPlatformResult(result), true, channel);
    assert.deepEqual(result, capabilities.supervisedAgentsUnsupportedResult("win32"), channel);
  }
  // Views that do not need the supervisor keep their real handlers.
  assert.ok(Array.isArray(await invoke("desktop:workers:list")));
  assert.deepEqual(daemonCalls, []);
});

test("giving an agent is refused with one sentence; asking still works", async () => {
  assert.equal(await invoke("desktop:asks:can-give", "codex"), false);
  const given = await invoke("desktop:asks:give", { token: "t", providerId: "codex" }) as { ok: boolean; error?: string };
  assert.equal(given.ok, false);
  assert.match(given.error ?? "", /not available on Windows yet/);
  assert.ok(handlers.has("desktop:asks:create"));
});

test("rental channels answer the existing disabled result and start no background services", async () => {
  for (const channel of ["desktop:rental:list-listings", "desktop:rental:get-provider-settings", "desktop:rental:accept-request"]) {
    assert.deepEqual(await invoke(channel, {}), { enabled: false }, channel);
  }
  startRentalServices();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(daemonCalls, []);
});

test("the gate returns the real IpcMain where agents are supported", () => {
  const target = { handle() {}, on() {} };
  assert.equal(gateSupervisedAgentIpc(target as never, { platform: "darwin", env: {} }), target);
  assert.notEqual(gateSupervisedAgentIpc(target as never, { platform: "win32", env: {} }), target);
});

test("the board of a local-only room reports once and stops instead of retrying", async () => {
  const errors: unknown[] = [];
  const controller = new AbortController();
  await subscribeLocalTasks("local_room", controller.signal, () => assert.fail("no tasks"), (error) => errors.push(error));
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof capabilities.SupervisedAgentsUnsupportedError);
  assert.match((errors[0] as Error).message, /board of a room saved only on this computer/);
  await assert.rejects(requestDesktopBoardMutation("addLocalTask", []), capabilities.SupervisedAgentsUnsupportedError);
  assert.deepEqual(daemonCalls, []);
});
