import assert from "node:assert/strict";
import { mock, type TestContext } from "node:test";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";
import type {
  DesktopLaunchEvent,
  DesktopSupervisorCreateInput,
  DesktopSupervisorManifestEntry,
} from "../ipc-types.js";

const env = createElectronTestEnv({ prefix: "ipc-supervisor-launch-events-" });
env.resetState({});

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;
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

// The create handler asks which storage a room uses. Every room here is a
// remote room, so the local-room branch never touches the user's chat store.
mock.module("../main/rooms.js", {
  namedExports: {
    ...await import("../main/rooms.js"),
    getDesktopRoomStorage: async () => ({ effectiveMode: "remote", localRoom: null }),
  },
});

// Providers other than Claude refresh the external MCP config before they
// activate. The refresh is replaced so no test reads or writes a real config.
let refreshMcpAuth: () => Promise<void> = async () => {};
mock.module("../main/mcp-setup.js", {
  namedExports: {
    ...await import("../main/mcp-setup.js"),
    refreshInstalledLetAgentsMcpServerAuth: () => refreshMcpAuth(),
  },
});

const { registerDesktopSupervisorIpcHandlers } = await import("../main/ipc-handlers/supervisor.js");
const { supervisorDaemonClient } = await import("../main/supervisor-daemon.js");
const { supervisorGrantCoordinator } = await import("../main/supervisor-grant-coordinator.js");
const { classifyLaunchFailure, LaunchBlockedError, onLaunchEvent } = await import("../main/launch-events.js");

// Registration starts a process-wide state watch. Keep it inert: it finds no
// running daemon and ends at once. The tests stub every other daemon call.
(supervisorDaemonClient as unknown as { connectIfRunning(): Promise<null> }).connectIfRunning = async () => null;
registerDesktopSupervisorIpcHandlers(fakeIpcMain as never);

function patch(t: TestContext, target: object, key: string, implementation: (...args: any[]) => unknown): void {
  t.mock.method(target as never, key as never, implementation as never);
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  assert.ok(handler, `${channel} is registered`);
  return Promise.resolve(handler({}, ...args));
}

/** Records the launch events of one launch, in order, next to the calls the test makes. */
function launchRun(t: TestContext, name: string) {
  // The handler accepts a creation id of 8 to 128 safe characters as the launch id.
  const launchId = `launch_${name}_0001`;
  const events: DesktopLaunchEvent[] = [];
  const timeline: string[] = [];
  const stop = onLaunchEvent((event) => {
    if (event.launchId !== launchId) return;
    events.push(event);
    timeline.push(event.type);
  });
  t.after(stop);
  return { launchId, entryId: `supervised_${launchId}`, events, timeline };
}

/** Records every launch event of every launch while a test runs. */
function recordAllLaunchEvents(t: TestContext): DesktopLaunchEvent[] {
  const events: DesktopLaunchEvent[] = [];
  t.after(onLaunchEvent((event) => { events.push(event); }));
  return events;
}

function savedEntry(id: string, overrides: Record<string, unknown> = {}): DesktopSupervisorManifestEntry {
  return {
    id, roomId: "room_1", provider: "codex", desiredState: "running", observedState: "absent",
    readyReachedAt: null, ...overrides,
  } as unknown as DesktopSupervisorManifestEntry;
}

function createInput(launchId: string, overrides: Partial<DesktopSupervisorCreateInput> = {}): DesktopSupervisorCreateInput {
  return {
    creationRequestId: launchId, roomIdentifier: "room_1", displayName: "Mutable label", providerId: "codex",
    charter: "help", model: null, permissionProfileId: null, repoRootPath: "/tmp/repo", ...overrides,
  };
}

function failureLabel(kind: "unexpected" | "blocked"): string {
  return kind === "blocked" ? "a blocked" : "an unexpected";
}

function stubDaemonReachable(t: TestContext, run?: { timeline: string[] }): void {
  patch(t, supervisorDaemonClient, "ensureRunning", async () => {
    run?.timeline.push("daemon.ensure-running");
    return { generation: 7 };
  });
}

test("create-agent records requested, connected, saved, then activated, and returns the coordinator's entry", async (t) => {
  const run = launchRun(t, "created");
  const manifest = savedEntry(run.entryId);
  const seen: Array<{ input: DesktopSupervisorCreateInput }> = [];
  stubDaemonReachable(t);
  patch(t, supervisorGrantCoordinator, "createAndInstall", async (
    input: DesktopSupervisorCreateInput,
    hooks: { onSaved?: (entry: DesktopSupervisorManifestEntry) => void },
  ) => {
    seen.push({ input });
    run.timeline.push("coordinator.saved");
    hooks.onSaved?.(manifest);
    run.timeline.push("coordinator.installed");
    return { entry: manifest, agentKey: "owner/agent" };
  });

  const result = await invoke("desktop:supervisor:create-agent", createInput(run.launchId));

  assert.equal(result, manifest, "the caller receives the entry the coordinator saved");
  assert.deepEqual(run.events.map((event) => event.type), [
    "launch.requested", "supervisor.connected", "agent.saved", "launch.activated",
  ]);
  assert.deepEqual(run.timeline, [
    "launch.requested", "supervisor.connected", "coordinator.saved", "agent.saved", "coordinator.installed", "launch.activated",
  ], "agent.saved comes from the save hook, and activation is reported only after the install returns");
  assert.deepEqual(run.events.map((event) => event.sequence), [1, 2, 3, 4]);
  for (const event of run.events) {
    assert.equal(event.launchId, run.launchId);
    assert.equal(event.entryId, run.entryId);
    assert.equal(event.roomIdentifier, "room_1");
    assert.equal(event.provider, "codex");
  }
  assert.equal(run.events[2]!.durable, true, "the saved fact is durable");
  assert.equal(run.events[3]!.durable, true, "the activation fact is durable");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.input.creationRequestId, run.launchId, "the pinned launch id reaches the coordinator");
});

for (const kind of ["unexpected", "blocked"] as const) {
  test(`create-agent failure after the save records the saved fact, then ${failureLabel(kind)} failure, and rethrows`, async (t) => {
    const run = launchRun(t, `after_save_${kind}`);
    const manifest = savedEntry(run.entryId);
    const error = kind === "blocked"
      ? new LaunchBlockedError("Sign in to Codex, then try again.", "retry")
      : new Error("daemon rejected the grant");
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
    stubDaemonReachable(t);
    patch(t, supervisorGrantCoordinator, "createAndInstall", async (
      _input: DesktopSupervisorCreateInput,
      hooks: { onSaved?: (entry: DesktopSupervisorManifestEntry) => void },
    ) => {
      hooks.onSaved?.(manifest);
      throw error;
    });

    await assert.rejects(
      invoke("desktop:supervisor:create-agent", createInput(run.launchId)),
      (thrown: unknown) => thrown === error,
    );

    const expected = classifyLaunchFailure(error);
    assert.equal(expected.type, kind === "blocked" ? "launch.blocked" : "launch.failed");
    assert.deepEqual(run.events.map((event) => event.type), [
      "launch.requested", "supervisor.connected", "agent.saved", expected.type,
    ], "the failure fact follows the saved fact; it never replaces it");
    const failure = run.events[3]!;
    assert.equal(failure.entryId, run.entryId);
    assert.equal(failure.detail, expected.detail);
    assert.equal(failure.diagnostic, expected.diagnostic);
    assert.equal(failure.recovery, expected.recovery);
    if (kind === "blocked") {
      assert.equal(failure.detail, "Sign in to Codex, then try again.");
      assert.equal(failure.recovery, "retry");
    } else {
      assert.equal(failure.diagnostic, "daemon rejected the grant");
    }
    assert.equal(logged.length, 1, "the failure is logged once for diagnostics");
    assert.match(String(logged[0]![0]), new RegExp(run.entryId));
  });
}

test("create-agent refuses an unavailable permission profile before it saves anything", async (t) => {
  const run = launchRun(t, "bad_profile");
  let installs = 0;
  t.mock.method(console, "error", () => {});
  stubDaemonReachable(t, run);
  patch(t, supervisorGrantCoordinator, "createAndInstall", async () => { installs += 1; throw new Error("unexpected save"); });

  await assert.rejects(
    invoke("desktop:supervisor:create-agent", createInput(run.launchId, { permissionProfileId: "no_such_profile" as never })),
    /Unknown permission profile/,
  );

  assert.equal(installs, 0, "no entry is saved for a profile that is not available");
  assert.deepEqual(run.timeline, ["launch.requested", "launch.blocked"], "the daemon is not even contacted");
  assert.equal(run.events[1]!.recovery, "retry");
});

test("create-agent reports an unreachable background service as blocked, before anything is saved", async (t) => {
  const run = launchRun(t, "no_daemon");
  let installs = 0;
  t.mock.method(console, "error", () => {});
  patch(t, supervisorDaemonClient, "ensureRunning", async () => { throw new Error("spawn failed"); });
  patch(t, supervisorGrantCoordinator, "createAndInstall", async () => { installs += 1; throw new Error("unexpected save"); });

  await assert.rejects(
    invoke("desktop:supervisor:create-agent", createInput(run.launchId)),
    /could not reach background agent management/,
  );

  assert.equal(installs, 0);
  assert.deepEqual(run.timeline, ["launch.requested", "launch.blocked"], "supervisor.connected is never claimed");
  assert.equal(run.events[1]!.recovery, "reconnect");
});

test("set-desired-state running on a saved supervised entry records a durable request, then activates, then reports it", async (t) => {
  const run = launchRun(t, "restart");
  const saved = savedEntry(run.entryId, { desiredState: "stopped", observedState: "stopped" });
  const started = savedEntry(run.entryId, { desiredState: "running" });
  refreshMcpAuth = async () => { run.timeline.push("mcp.refresh-auth"); };
  t.after(() => { refreshMcpAuth = async () => {}; });
  patch(t, supervisorDaemonClient, "list", async () => [saved]);
  patch(t, supervisorDaemonClient, "setDesiredState", async (id: string, state: string) => {
    run.timeline.push(`daemon.set-desired:${id}:${state}`);
    return started;
  });
  patch(t, supervisorGrantCoordinator, "activateEntry", async (
    entry: DesktopSupervisorManifestEntry,
    activate: () => Promise<unknown>,
  ) => {
    assert.equal(entry, saved, "activation receives the listed entry");
    run.timeline.push("coordinator.activate");
    return activate();
  });

  const result = await invoke("desktop:supervisor:set-desired-state", run.entryId, "running");

  assert.equal(result, started);
  assert.deepEqual(run.timeline, [
    "launch.requested", "mcp.refresh-auth", "coordinator.activate", `daemon.set-desired:${run.entryId}:running`, "launch.activated",
  ], "the request is recorded before any activation work, and the activation after it");
  const [requested, activated] = run.events;
  assert.equal(requested!.durable, true, "the request fact is durable");
  assert.equal(activated!.durable, true);
  for (const event of run.events) {
    assert.equal(event.entryId, run.entryId);
    assert.equal(event.launchId, run.launchId);
    assert.equal(event.roomIdentifier, "room_1");
    assert.equal(event.provider, "codex");
  }
});

for (const kind of ["unexpected", "blocked"] as const) {
  test(`set-desired-state running records ${failureLabel(kind)} activation failure as the attempt's terminal fact and rethrows`, async (t) => {
    const run = launchRun(t, `restart_fails_${kind}`);
    const error = kind === "blocked"
      ? new LaunchBlockedError("LetAgents could not reach background agent management.", "reconnect")
      : new Error("daemon rejected the grant");
    patch(t, supervisorDaemonClient, "list", async () => [savedEntry(run.entryId, { desiredState: "stopped" })]);
    patch(t, supervisorDaemonClient, "setDesiredState", async () => { throw new Error("must not start the entry"); });
    patch(t, supervisorGrantCoordinator, "activateEntry", async () => { throw error; });

    await assert.rejects(
      invoke("desktop:supervisor:set-desired-state", run.entryId, "running"),
      (thrown: unknown) => thrown === error,
    );

    const expected = classifyLaunchFailure(error);
    assert.deepEqual(run.timeline, ["launch.requested", expected.type]);
    const failure = run.events[1]!;
    assert.equal(failure.entryId, run.entryId);
    assert.equal(failure.detail, expected.detail);
    assert.equal(failure.diagnostic, expected.diagnostic);
    assert.equal(failure.recovery, expected.recovery);
    assert.equal(failure.durable, true);
    assert.equal(expected.recovery, kind === "blocked" ? "reconnect" : "retry");
  });
}

test("set-desired-state running records a failed MCP auth refresh as the attempt's failure and never activates", async (t) => {
  const run = launchRun(t, "restart_refresh_fails");
  const refreshError = new Error("MCP config is read-only");
  let activations = 0;
  refreshMcpAuth = async () => { throw refreshError; };
  t.after(() => { refreshMcpAuth = async () => {}; });
  patch(t, supervisorDaemonClient, "list", async () => [savedEntry(run.entryId, { desiredState: "stopped" })]);
  patch(t, supervisorGrantCoordinator, "activateEntry", async () => { activations += 1; return savedEntry(run.entryId); });

  await assert.rejects(
    invoke("desktop:supervisor:set-desired-state", run.entryId, "running"),
    (thrown: unknown) => thrown === refreshError,
  );

  assert.equal(activations, 0);
  assert.deepEqual(run.timeline, ["launch.requested", "launch.failed"]);
  assert.equal(run.events[1]!.diagnostic, "MCP config is read-only");
});

test("set-desired-state running on an entry that is not a supervised launch activates it and emits no launch facts", async (t) => {
  const all = recordAllLaunchEvents(t);
  const legacy = savedEntry("agent_manual_0001", { desiredState: "stopped" });
  const started = savedEntry("agent_manual_0001");
  const activated: string[] = [];
  patch(t, supervisorDaemonClient, "list", async () => [legacy]);
  patch(t, supervisorDaemonClient, "setDesiredState", async () => started);
  patch(t, supervisorGrantCoordinator, "activateEntry", async (
    entry: DesktopSupervisorManifestEntry,
    activate: () => Promise<unknown>,
  ) => {
    activated.push(entry.id);
    return activate();
  });

  const result = await invoke("desktop:supervisor:set-desired-state", "agent_manual_0001", "running");

  assert.equal(result, started);
  assert.deepEqual(activated, ["agent_manual_0001"]);
  assert.deepEqual(all, [], "an entry without a supervised launch id has no launch history to write");
});

test("set-desired-state running on an entry that is not a supervised launch emits nothing even when activation fails", async (t) => {
  const all = recordAllLaunchEvents(t);
  const error = new Error("daemon rejected the grant");
  patch(t, supervisorDaemonClient, "list", async () => [savedEntry("agent_manual_0002", { desiredState: "stopped" })]);
  patch(t, supervisorGrantCoordinator, "activateEntry", async () => { throw error; });

  await assert.rejects(
    invoke("desktop:supervisor:set-desired-state", "agent_manual_0002", "running"),
    (thrown: unknown) => thrown === error,
  );

  assert.deepEqual(all, []);
});

test("set-desired-state running on an unknown entry fails before it writes any launch fact", async (t) => {
  const all = recordAllLaunchEvents(t);
  patch(t, supervisorDaemonClient, "list", async () => []);

  await assert.rejects(
    invoke("desktop:supervisor:set-desired-state", "supervised_launch_missing_0001", "running"),
    /Unknown supervised agent: supervised_launch_missing_0001/,
  );

  assert.deepEqual(all, []);
});
