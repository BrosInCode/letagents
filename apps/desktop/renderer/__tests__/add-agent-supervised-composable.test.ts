import assert from "node:assert/strict";
import test from "node:test";
import { nextTick, ref } from "vue";
import type { DesktopLaunchEvent, DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import {
  canAddAnotherSupervisedAgent,
  useSupervisedAgentLaunch,
} from "../src/components/desktop/content/add-agent/useSupervisedAgentLaunch";
import { createSupervisedAgentFromSnapshot } from "../src/components/desktop/content/add-agent/useAddAgentController";
import {
  canStartNewSupervisedLaunch,
  recoveryScanAllowsNewLaunch,
} from "../src/components/desktop/content/add-agent/useSupervisedLaunchRecovery";

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_launch-1",
    roomId: "room-1",
    displayName: "Codex supervised agent",
    provider: "codex",
    model: null,
    charter: "Work from the board.",
    desiredState: "running",
    observedState: "starting",
    condition: "none",
    lastError: null,
    permissionProfileId: null,
    createdBy: "desktop",
    createdAt: "2026-07-18T00:00:00.000Z",
    workspacePath: null,
    workAttemptId: null,
    agentSessionId: null,
    agentSessionBindingState: "none",
    bindingUpdatedAt: null,
    executionGenerationId: null,
    providerContinuationId: null,
    providerPid: null,
    workplaceLiveness: { state: "unknown", observedAt: null, detail: null },
    nativeLiveness: { state: "unknown", observedAt: null, detail: null },
    restartCount: 0,
    lastTerminal: null,
    activity: [],
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function memorySessionStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("supervised polling serializes reads and unsubscribes at terminal state", async () => {
  const firstRead = deferred<DesktopSupervisorManifestEntry[]>();
  const storage = memorySessionStorage();
  const timers: Array<() => void> = [];
  let reads = 0;
  let unsubscribed = 0;
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: storage,
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: () => {
            reads += 1;
            return reads === 1
              ? firstRead.promise
              : Promise.resolve([entry({
                  observedState: "working",
                  workspacePath: "/tmp/worktree",
                  providerPid: 42,
                  agentSessionId: "agent-1",
                  agentSessionBindingState: "active",
                  workplaceLiveness: { state: "reachable", observedAt: "2026-07-18T00:00:02.000Z", detail: null },
                  nativeLiveness: { state: "working", observedAt: "2026-07-18T00:00:02.000Z", detail: null },
                })]);
          },
          onLaunchEvent: () => () => { unsubscribed += 1; },
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const open = ref(true);
  const launch = useSupervisedAgentLaunch({
    open,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    supportsConcurrentAgents: () => true,
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  launch.complete(entry());
  assert.equal(reads, 1);
  assert.equal(timers.length, 0, "no second read is scheduled while the first is in flight");

  firstRead.resolve([entry()]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.length, 1);
  timers.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();

  assert.equal(reads, 2);
  assert.equal(launch.view.value?.ready, true);
  assert.equal(unsubscribed, 1);
  assert.equal(storage.getItem("letagents:add-agent:attached-launch:room-1:supervised_launch-1"), null);
  launch.cleanup();
});

test("an actionable reconnect block keeps a calm cadence through errors and can still resolve", async () => {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let reads = 0;
  let unsubscribed = 0;
  const blocked = entry({
    workspacePath: "/tmp/worktree",
    providerPid: 42,
    observedState: "recovering",
    condition: "coordination_blocked",
    lastError: "durable execution generation remains live without an attachable provider handle",
  });
  const ready = entry({
    workspacePath: "/tmp/worktree",
    providerPid: 42,
    observedState: "working",
    condition: "none",
    agentSessionId: "agent-1",
    agentSessionBindingState: "active",
    workplaceLiveness: { state: "reachable", observedAt: "2026-07-18T00:00:02.000Z", detail: null },
  });
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: memorySessionStorage(),
      setTimeout: (callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => {
            reads += 1;
            if (reads === 1) return [blocked];
            if (reads === 2) throw new Error("daemon temporarily unavailable");
            return [ready];
          },
          onLaunchEvent: () => () => { unsubscribed += 1; },
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  launch.complete(blocked);
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();

  assert.equal(launch.view.value?.status, "blocked");
  assert.equal(launch.view.value?.recovery, null);
  assert.equal(unsubscribed, 0, "blocked recovery remains subscribed to real lifecycle evidence");
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 4_000, "a blocked card uses the calm live-region cadence");

  timers.shift()!.callback();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();

  assert.equal(launch.view.value?.status, "blocked");
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 4_000, "a daemon read error does not accelerate blocked polling");

  timers.shift()!.callback();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();

  assert.equal(launch.view.value?.ready, true);
  assert.equal(unsubscribed, 1);
  launch.cleanup();
});

test("a pre-durable blocked event is terminal and releases its event subscription", async () => {
  let emitEvent: ((event: DesktopLaunchEvent) => void) | null = null;
  let unsubscribed = 0;
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [],
          onLaunchEvent: (listener: (event: DesktopLaunchEvent) => void) => {
            emitEvent = listener;
            return () => { unsubscribed += 1; };
          },
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  assert.ok(emitEvent);
  emitEvent!({
    launchId: "launch-1",
    entryId: null,
    roomIdentifier: "room-1",
    provider: "codex",
    sequence: 1,
    type: "launch.blocked",
    at: "2026-07-18T00:00:00.000Z",
    detail: "Background agent management is unavailable.",
    recovery: "reconnect",
    durable: false,
  });
  await nextTick();

  assert.equal(launch.view.value?.status, "blocked");
  assert.equal(unsubscribed, 1);
  launch.cleanup();
});

test("failed creation recovery preserves the provider's actionable blocked event", async () => {
  const blockedEvent: DesktopLaunchEvent = {
    launchId: "launch-1",
    entryId: null,
    roomIdentifier: "room-1",
    provider: "codex",
    sequence: 2,
    type: "launch.blocked",
    at: "2026-07-18T00:00:00.000Z",
    detail: "Choose a project folder before starting Codex.",
    recovery: "choose_project",
    durable: false,
  };
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => { throw new Error("daemon unavailable"); },
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [blockedEvent],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  await launch.recoverFailedCreation(new Error("create failed"));
  await nextTick();

  assert.equal(launch.view.value?.status, "blocked");
  assert.equal(launch.view.value?.failureDetail, blockedEvent.detail);
  assert.equal(launch.view.value?.recovery, "choose_project");
  assert.match(launch.conflictLookupError.value || "", /daemon unavailable/);
  launch.cleanup();
});

test("durable manifest truth wins over a post-save terminal launch event", async () => {
  for (const desiredState of ["running", "paused", "stopped"] as const) {
    const durableEntry = entry({
      desiredState,
      observedState: desiredState === "stopped" ? "stopped" : "starting",
    });
    Object.assign(globalThis, {
      window: {
        crypto: { randomUUID: () => "launch-1" },
        sessionStorage: memorySessionStorage(),
        setTimeout: () => 1,
        clearTimeout: () => undefined,
        letagentsDesktop: {
          supervisor: {
            listAgents: async () => [durableEntry],
            onLaunchEvent: () => () => undefined,
            getLaunchEvents: async () => [{
              launchId: "launch-1",
              entryId: durableEntry.id,
              roomIdentifier: "room-1",
              provider: "codex",
              sequence: 3,
              type: "launch.failed",
              at: "2026-07-18T00:00:00.000Z",
              detail: "Activation acknowledgement timed out.",
              recovery: "retry",
              durable: true,
            } satisfies DesktopLaunchEvent],
          },
        },
      },
    });
    const launch = useSupervisedAgentLaunch({
      open: () => true,
      roomIdentifier: () => "room-1",
      roomLabel: () => "Room one",
      providerId: () => "codex",
      authCommand: () => null,
      authCommandForProvider: () => null,
      currentVersion: () => 0,
      isCurrentRequest: () => true,
      onChooseRepo: () => undefined,
      onCopyAuthCommand: () => undefined,
      onRetry: () => undefined,
      onMessage: () => undefined,
    });

    launch.begin();
    await launch.recoverFailedCreation(new Error("activation timed out"));

    assert.equal(launch.conflict.value?.id, durableEntry.id, `${desiredState} claim remains attached`);
    assert.equal(launch.conflict.value?.desiredState, desiredState);
    if (desiredState === "paused") {
      assert.equal(launch.view.value?.failed, true);
      assert.equal(launch.view.value?.recovery, null);
    }
    launch.cleanup();
  }
});

test("explicit recovery activates a paused durable ownership claim", async () => {
  const paused = entry({ desiredState: "paused", observedState: "starting" });
  const running = entry({ desiredState: "running", observedState: "starting" });
  let activations = 0;
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [paused],
          resumeOwnershipTransfer: async () => { activations += 1; return running; },
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();
  assert.equal(launch.recoveryCandidate.value?.desiredState, "paused");
  await launch.recoverDetectedLaunch();

  assert.equal(activations, 1);
  assert.equal(launch.conflict.value?.desiredState, "running");
  launch.cleanup();
});

test("recovery ownership failures are visible and keep supervised Start fenced", async () => {
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: { listAgents: async () => { throw new Error("socket closed"); } },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();

  assert.equal(launch.recoveryScanStatus.value, "error");
  assert.match(launch.conflictLookupError.value || "", /socket closed/);
  assert.match(launch.conflictLookupError.value || "", /start a new supervised agent/);
  launch.cleanup();
});

test("a failed passive recovery check does not fence starting a new supervised agent", () => {
  assert.equal(recoveryScanAllowsNewLaunch("idle"), false);
  assert.equal(recoveryScanAllowsNewLaunch("checking"), false);
  assert.equal(recoveryScanAllowsNewLaunch("ready"), true);
  assert.equal(recoveryScanAllowsNewLaunch("error"), true);
});

test("the shared supervised start policy preserves authoritative live fences", () => {
  const base = {
    providerId: "claude-code" as const,
    scanStatus: "error" as const,
    hasActiveLaunch: false,
    hasRecoveryCandidate: false,
    recoveringCandidate: false,
    supportsConcurrentAgents: false,
  };
  assert.equal(canStartNewSupervisedLaunch(base), true);
  assert.equal(canStartNewSupervisedLaunch({ ...base, hasRecoveryCandidate: true }), false);
  assert.equal(canStartNewSupervisedLaunch({
    ...base,
    providerId: "open-model",
    supportsConcurrentAgents: true,
    hasRecoveryCandidate: true,
  }), true);
  assert.equal(canStartNewSupervisedLaunch({ ...base, hasActiveLaunch: true }), false);
  assert.equal(canStartNewSupervisedLaunch({ ...base, recoveringCandidate: true }), false);
});

test("a stalled recovery scan times out into an actionable retry instead of disabling Start forever", async () => {
  const timers: Array<() => void> = [];
  const never = deferred<DesktopSupervisorManifestEntry[]>();
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: { listAgents: () => never.promise },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
    recoveryScanTimeoutMs: 1,
  });

  const scan = launch.detectRecoverableLaunch();
  assert.equal(launch.recoveryScanStatus.value, "checking");
  assert.equal(launch.detectingRecovery.value, true);
  timers.shift()!();
  await scan;

  assert.equal(launch.recoveryScanStatus.value, "error");
  assert.equal(launch.detectingRecovery.value, false);
  assert.match(launch.conflictLookupError.value || "", /took too long/i);
  assert.match(launch.conflictLookupError.value || "", /Check again/i);

  window.letagentsDesktop!.supervisor.listAgents = async () => [];
  await launch.detectRecoverableLaunch();
  assert.equal(launch.recoveryScanStatus.value, "ready", "Check again can recover after the stalled request");
  never.resolve([entry()]);
  await Promise.resolve();
  assert.equal(launch.recoveryCandidate.value, null, "the late first response cannot overwrite the retry");
  launch.cleanup();
});

test("a recovery candidate arriving during a hung scan cannot be overwritten by its timeout", async () => {
  const timers: Array<() => void> = [];
  const pending = deferred<DesktopSupervisorManifestEntry[]>();
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      clearTimeout: () => undefined,
      letagentsDesktop: { supervisor: { listAgents: () => pending.promise } },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
    recoveryScanTimeoutMs: 1,
  });

  const scan = launch.detectRecoverableLaunch();
  assert.equal(launch.recoveryScanStatus.value, "checking");
  launch.offerRecoveryCandidate(entry());
  assert.equal(launch.recoveryCandidate.value?.id, "supervised_launch-1");
  assert.equal(launch.recoveryScanStatus.value, "ready");
  assert.equal(launch.detectingRecovery.value, false);
  timers.shift()!();
  await scan;
  assert.equal(launch.recoveryScanStatus.value, "ready");
  assert.equal(launch.detectingRecovery.value, false);
  assert.equal(launch.conflictLookupError.value, null);
  assert.equal(launch.recoveryCandidate.value?.id, "supervised_launch-1");
  launch.cleanup();
});

test("ambiguous create recovery resumes polling from the recovered running entry", async () => {
  let reads = 0;
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => {
            reads += 1;
            return [entry()];
          },
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  await launch.recoverFailedCreation();
  await Promise.resolve();

  assert.equal(launch.creationRequestId.value, null);
  assert.equal(launch.conflict.value?.id, "supervised_launch-1");
  assert.ok(reads >= 2, "recovery lookup is followed by active runtime polling");
  launch.cleanup();
});

test("missing create recovery becomes a safe retryable terminal state", async () => {
  let unsubscribed = 0;
  let uuid = 0;
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => `launch-${++uuid}` },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [],
          onLaunchEvent: () => () => { unsubscribed += 1; },
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  await launch.recoverFailedCreation();
  await nextTick();

  assert.equal(launch.view.value?.failed, true);
  assert.equal(launch.view.value?.recovery, "retry");
  assert.equal(unsubscribed, 1);
  launch.dismiss();
  assert.equal(launch.begin(), "launch-2", "dismiss starts the next attempt with a fresh launch identity");
  launch.cleanup();
});

test("failed creation recovery folds an existing stopped entry into a terminal state", async () => {
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [entry({ desiredState: "stopped", observedState: "stopped" })],
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  await launch.recoverFailedCreation();

  assert.equal(launch.conflict.value?.desiredState, "stopped");
  assert.equal(launch.view.value?.stopped, true);
  launch.cleanup();
});

test("a runtime that disappears becomes a dismissible terminal failure", async () => {
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [],
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  launch.complete(entry());
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();

  assert.equal(launch.conflict.value, null);
  assert.equal(launch.view.value?.failed, true);
  assert.equal(launch.view.value?.recovery, "retry");
});

test("explicit supervised stop performs deterministic terminal cleanup", async () => {
  let unsubscribed = 0;
  const messages: Array<string | null> = [];
  const observedStop = deferred<DesktopSupervisorManifestEntry[]>();
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: () => observedStop.promise,
          setDesiredState: async () => entry({ desiredState: "stopped", observedState: "stopping" }),
          onLaunchEvent: () => () => { unsubscribed += 1; },
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: (message) => { messages.push(message); },
  });

  launch.begin();
  launch.complete(entry());
  await launch.stop();

  assert.equal(launch.conflict.value?.observedState, "stopping");
  assert.equal(launch.view.value?.status, "stopping");
  assert.equal(launch.view.value?.stopped, false);
  assert.equal(launch.stoppingEntryId.value, "supervised_launch-1");
  assert.equal(unsubscribed, 0, "persisting stop intent does not yet prove the provider is fenced");
  assert.equal(messages.some((message) => message?.startsWith("Stopping ")), false, "the card solely owns the cancelling announcement");

  observedStop.resolve([entry({ desiredState: "stopped", observedState: "stopped" })]);
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();

  assert.equal(launch.view.value, null);
  assert.equal(launch.conflict.value, null);
  assert.equal(launch.stoppingEntryId.value, null);
  assert.equal(unsubscribed, 1);
  assert.match(messages.at(-1) ?? "", /is stopped/);
});

test("a failed supervised stop exits Cancelling and remains retryable", async () => {
  const pendingRefresh = deferred<DesktopSupervisorManifestEntry[]>();
  const messages: Array<string | null> = [];
  let stopRequests = 0;
  let unsubscribed = 0;
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: () => pendingRefresh.promise,
          setDesiredState: async () => {
            stopRequests += 1;
            return entry({
              desiredState: "stopped",
              observedState: "failed",
              lastError: "provider did not exit",
            });
          },
          onLaunchEvent: () => () => { unsubscribed += 1; },
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: (message) => { messages.push(message); },
  });

  launch.begin();
  launch.complete(entry());
  await launch.stop();
  await nextTick();

  assert.equal(launch.view.value?.status, "failed");
  assert.equal(launch.view.value?.stopFailed, true);
  assert.equal(launch.view.value?.recovery, null, "the launch retry action must not replace a failed stop");
  assert.equal(launch.stoppingEntryId.value, null);
  assert.equal(unsubscribed, 1, "a failed stop is terminal for active polling");
  assert.equal(messages.at(-1), null, "failure detail is owned by the live card, not duplicated globally");

  await launch.stop();
  assert.equal(stopRequests, 2, "the conflict action can retry the same stop request");
  launch.cleanup();
});

test("reopening restores an unfinished stop and keeps the launch fence visible", async () => {
  const observedStop = deferred<DesktopSupervisorManifestEntry[]>();
  let reads = 0;
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: () => {
            reads += 1;
            return reads === 1
              ? Promise.resolve([entry({ desiredState: "stopped", observedState: "stopping" })])
              : observedStop.promise;
          },
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();
  assert.equal(launch.conflict.value?.observedState, "stopping");
  assert.equal(launch.stoppingEntryId.value, "supervised_launch-1");
  assert.equal(launch.view.value?.status, "stopping");

  observedStop.resolve([entry({ desiredState: "stopped", observedState: "stopped" })]);
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();

  assert.equal(launch.conflict.value, null);
  assert.equal(launch.stoppingEntryId.value, null);
});

test("reopening restores a failed stop with Retry stop enabled", async () => {
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [entry({
            desiredState: "stopped",
            observedState: "failed",
            lastError: "provider did not exit",
          })],
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();

  assert.equal(launch.view.value?.stopFailed, true);
  assert.equal(launch.stoppingEntryId.value, null);
  launch.cleanup();
});

test("an attached launch adopts stop intent published after local stop state was lost", async () => {
  const timers: Array<() => void> = [];
  let reads = 0;
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: memorySessionStorage(),
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => {
            reads += 1;
            return [entry({
              desiredState: "stopped",
              observedState: reads === 1 ? "stopping" : "stopped",
            })];
          },
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  launch.complete(entry());
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();

  assert.equal(launch.stoppingEntryId.value, "supervised_launch-1");
  assert.equal(launch.view.value?.status, "stopping");
  assert.equal(timers.length, 1);

  timers.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();

  assert.equal(launch.conflict.value, null);
  assert.equal(launch.stoppingEntryId.value, null);
});

test("a missing entry during stop does not poison the next launch controls", async () => {
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-next" },
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [],
          setDesiredState: async () => entry({ desiredState: "stopped", observedState: "stopping" }),
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  launch.complete(entry());
  await launch.stop();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  assert.equal(launch.stoppingEntryId.value, null);

  launch.dismiss();
  launch.begin();
  launch.complete(entry({ id: "supervised_launch-next" }));
  assert.equal(launch.stoppingEntryId.value, null);
  launch.cleanup();
});

test("recovery detection is passive and explicit recovery revalidates stale terminal state", async () => {
  let reads = 0;
  let subscribed = 0;
  const replayEvents = deferred<DesktopLaunchEvent[]>();
  Object.assign(globalThis, {
    window: {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => {
            reads += 1;
            return reads === 1
              ? [entry({ observedState: "failed", condition: "runtime_error" })]
              : [entry({
                  observedState: "working",
                  workspacePath: "/tmp/worktree",
                  providerPid: 42,
                  agentSessionId: "agent-1",
                  agentSessionBindingState: "active",
                  workplaceLiveness: { state: "reachable", observedAt: "2026-07-18T00:00:02.000Z", detail: null },
                  nativeLiveness: { state: "working", observedAt: "2026-07-18T00:00:02.000Z", detail: null },
                })];
          },
          getLaunchEvents: () => replayEvents.promise,
          onLaunchEvent: () => {
            subscribed += 1;
            return () => undefined;
          },
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => "codex login --device-auth",
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();

  assert.equal(reads, 1);
  assert.equal(subscribed, 0, "opening the modal must not subscribe to the previous launch");
  assert.equal(launch.recoveryCandidate.value?.observedState, "failed");
  assert.equal(launch.conflict.value, null);
  assert.equal(launch.view.value, null, "passive recovery metadata does not mount the live launch island");

  await launch.recoverDetectedLaunch();

  assert.equal(subscribed, 1);
  assert.equal(reads, 2, "Recover performs one authoritative revalidation");
  assert.equal(launch.recoveryCandidate.value, null);
  assert.equal(launch.conflict.value?.observedState, "working");
  assert.equal(launch.view.value?.ready, true);
  const terminalView = launch.view.value;
  replayEvents.resolve([{
    launchId: "launch-1",
    entryId: "supervised_launch-1",
    roomIdentifier: "room-1",
    provider: "codex",
    sequence: 1,
    type: "launch.failed",
    at: "2026-07-18T00:00:01.000Z",
    detail: "Late replay",
    recovery: "retry",
    durable: true,
  }]);
  await Promise.resolve();
  await nextTick();
  assert.equal(launch.view.value, terminalView, "terminal unsubscribe invalidates an in-flight replay");
});

test("recovery discovery ignores an established agent whose current liveness degraded", async () => {
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [entry({
            observedState: "working",
            workspacePath: "/tmp/worktree",
            providerPid: 42,
            agentSessionId: "agent-1",
            agentSessionBindingState: "active",
            workplaceLiveness: { state: "stale", observedAt: "2026-07-18T00:00:02.000Z", detail: null },
            readyReachedAt: "2026-07-18T00:00:03.000Z",
          })],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();

  assert.equal(launch.recoveryCandidate.value, null);
  assert.equal(launch.recoveryScanStatus.value, "ready");
  launch.cleanup();
});

test("reopening after explicit recovery automatically restores the same live launch", async () => {
  const open = ref(true);
  const providerId = ref<"codex" | "claude-code">("codex");
  let subscribed = 0;
  let unsubscribed = 0;
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [entry()],
          getLaunchEvents: async () => [],
          onLaunchEvent: () => {
            subscribed += 1;
            return () => { unsubscribed += 1; };
          },
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId,
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();
  assert.equal(launch.recoveryCandidate.value?.id, "supervised_launch-1");
  await launch.recoverDetectedLaunch();
  assert.equal(launch.conflict.value?.id, "supervised_launch-1");

  open.value = false;
  await nextTick();
  assert.equal(launch.view.value, null, "closing detaches the live UI");
  assert.ok(unsubscribed >= 1, "closing removes the launch event subscription");

  open.value = true;
  await nextTick();
  await launch.detectRecoverableLaunch();

  assert.equal(launch.recoveryCandidate.value, null, "the user is not asked to recover the same launch twice");
  assert.equal(launch.conflict.value?.id, "supervised_launch-1");
  assert.equal(launch.view.value?.ready, false);
  assert.equal(launch.view.value?.failed, false);
  assert.ok(subscribed >= 2, "reopening reattaches the live launch subscription");

  providerId.value = "claude-code";
  launch.resetActiveLaunch();
  await nextTick();
  assert.equal(launch.recoveryCandidate.value, null, "another provider never inherits Codex recovery UI");
  providerId.value = "codex";
  await nextTick();
  await Promise.resolve();
  await nextTick();
  assert.equal(launch.recoveryCandidate.value, null, "returning to its provider restores the attached launch");
  assert.equal(launch.conflict.value?.id, "supervised_launch-1");
});

test("a remounted modal restores its remembered launch ahead of newer entries", async () => {
  const remembered = entry({
    id: "supervised_remembered",
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  const newer = entry({
    id: "supervised_newer",
    createdAt: "2026-07-18T00:01:00.000Z",
  });
  let entries = [remembered];
  const storage = memorySessionStorage();
  Object.assign(globalThis, {
    window: {
      sessionStorage: storage,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => entries,
          getLaunchEvents: async () => [],
          onLaunchEvent: () => () => undefined,
        },
      },
    },
  });
  const createLaunch = () => useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  const firstMount = createLaunch();
  await firstMount.detectRecoverableLaunch();
  await firstMount.recoverDetectedLaunch();
  assert.equal(firstMount.conflict.value?.id, remembered.id);
  firstMount.cleanup();

  entries = [newer, remembered];
  const secondMount = createLaunch();
  await secondMount.detectRecoverableLaunch();

  assert.equal(secondMount.recoveryCandidate.value, null);
  assert.equal(secondMount.conflict.value?.id, remembered.id);
  secondMount.cleanup();
});

test("closing before supervised creation resolves still restores the requested launch", async () => {
  const storage = memorySessionStorage();
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "pending-launch" },
      sessionStorage: storage,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [entry({ id: "supervised_pending-launch" })],
          getLaunchEvents: async () => [],
          onLaunchEvent: () => () => undefined,
        },
      },
    },
  });
  const createLaunch = () => useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  const firstMount = createLaunch();
  firstMount.begin();
  firstMount.cleanup();

  const secondMount = createLaunch();
  await secondMount.detectRecoverableLaunch();

  assert.equal(secondMount.recoveryCandidate.value, null);
  assert.equal(secondMount.conflict.value?.id, "supervised_pending-launch");
  secondMount.cleanup();
});

test("recovery discovery only offers the selected provider's launch", async () => {
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [
            entry({ id: "supervised_claude", provider: "claude-code", createdAt: "2026-07-18T00:01:00.000Z" }),
            entry({ id: "supervised_codex", provider: "codex" }),
          ],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();

  assert.equal(launch.recoveryCandidate.value?.id, "supervised_codex");
});

test("a late result from another provider cannot block current recovery discovery", async () => {
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => [entry({ id: "supervised_claude", provider: "claude-code" })],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "claude-code",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.offerRecoveryCandidate(entry({ id: "supervised_codex", provider: "codex" }));
  assert.equal(launch.recoveryCandidate.value, null);
  await launch.detectRecoverableLaunch();
  assert.equal(launch.recoveryCandidate.value?.id, "supervised_claude");
});

test("provider switching restarts an in-flight recovery scan for the selected provider", async () => {
  const firstScan = deferred<DesktopSupervisorManifestEntry[]>();
  const providerId = ref<"codex" | "claude-code">("codex");
  let reads = 0;
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => {
            reads += 1;
            return reads === 1
              ? firstScan.promise
              : [entry({ id: "supervised_claude", provider: "claude-code" })];
          },
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId,
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  const staleScan = launch.detectRecoverableLaunch();
  providerId.value = "claude-code";
  await nextTick();
  firstScan.resolve([entry({ id: "supervised_codex" })]);
  await staleScan;
  await Promise.resolve();
  await nextTick();

  assert.equal(launch.recoveryCandidate.value?.id, "supervised_claude");
});

test("provider switching demotes an active unfinished launch back to a recovery candidate", () => {
  Object.assign(globalThis, {
    window: {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: { supervisor: {} },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.complete(entry({ observedState: "failed", condition: "runtime_error" }));
  launch.resetActiveLaunch();

  assert.equal(launch.view.value, null);
  assert.equal(launch.conflict.value, null);
  assert.equal(launch.recoveryCandidate.value?.id, "supervised_launch-1");
});

test("closing during explicit recovery discards the stale response", async () => {
  const recoveryRead = deferred<DesktopSupervisorManifestEntry[]>();
  const open = ref(true);
  let reads = 0;
  Object.assign(globalThis, {
    window: {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: () => {
            reads += 1;
            return reads === 1 ? Promise.resolve([entry()]) : recoveryRead.promise;
          },
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();
  const recovery = launch.recoverDetectedLaunch();
  open.value = false;
  await nextTick();
  recoveryRead.resolve([entry()]);
  await recovery;

  assert.equal(launch.recoveryCandidate.value, null);
  assert.equal(launch.conflict.value, null);
  assert.equal(launch.view.value, null);
});

test("provider switching cancels an in-flight recovery while preserving its candidate", async () => {
  const recoveryRead = deferred<DesktopSupervisorManifestEntry[]>();
  let reads = 0;
  Object.assign(globalThis, {
    window: {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: () => {
            reads += 1;
            return reads === 1 ? Promise.resolve([entry()]) : recoveryRead.promise;
          },
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();
  const recovery = launch.recoverDetectedLaunch();
  launch.resetActiveLaunch();
  recoveryRead.resolve([entry()]);
  await recovery;

  assert.equal(launch.recoveryCandidate.value?.id, "supervised_launch-1");
  assert.equal(launch.conflict.value, null);
  assert.equal(launch.view.value, null);
});

test("provider changes cannot strand an in-flight explicit recovery", async () => {
  const recoveryRead = deferred<DesktopSupervisorManifestEntry[]>();
  const providerId = ref<"codex" | "claude-code">("codex");
  let reads = 0;
  Object.assign(globalThis, {
    window: {
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => {
            reads += 1;
            if (reads === 1) return [entry()];
            if (reads === 2) return recoveryRead.promise;
            return [];
          },
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId,
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();
  const recovery = launch.recoverDetectedLaunch();
  providerId.value = "claude-code";
  await nextTick();
  recoveryRead.resolve([entry()]);
  await recovery;
  await nextTick();

  assert.equal(launch.recoveringCandidate.value, false);
  assert.equal(launch.conflict.value, null);
  assert.equal(launch.recoveryCandidate.value, null);
});

test("a transient recovery lookup error keeps the candidate retryable", async () => {
  let reads = 0;
  Object.assign(globalThis, {
    window: {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => {
            reads += 1;
            if (reads === 2) throw new Error("daemon unavailable");
            return [entry({ observedState: "failed", condition: "runtime_error" })];
          },
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();
  await launch.recoverDetectedLaunch();
  assert.equal(launch.recoveryCandidate.value?.id, "supervised_launch-1");
  assert.match(launch.conflictLookupError.value ?? "", /Could not refresh/);

  await launch.recoverDetectedLaunch();
  assert.equal(launch.recoveryCandidate.value, null);
  assert.equal(launch.view.value?.failed, true);
});

test("a create result arriving after provider reset becomes a passive candidate", () => {
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: { supervisor: {} },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  launch.resetActiveLaunch();
  launch.offerRecoveryCandidate(entry());

  assert.equal(launch.view.value, null);
  assert.equal(launch.recoveryCandidate.value?.id, "supervised_launch-1");
});

test("an ambiguously rejected create can recover its durable entry passively", async () => {
  Object.assign(globalThis, {
    window: {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: { listAgents: async () => [entry()] },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 1,
    isCurrentRequest: () => false,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.offerAmbiguousCreationCandidate("launch-1", "room-1");

  assert.equal(launch.view.value, null);
  assert.equal(launch.conflict.value, null);
  assert.equal(launch.recoveryCandidate.value?.id, "supervised_launch-1");
});

test("an authoritatively absent ambiguous create clears its pending attachment", async () => {
  const storage = memorySessionStorage();
  const open = ref(true);
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: storage,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: { supervisor: { listAgents: async () => [] } },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  open.value = false;
  await nextTick();
  await launch.offerAmbiguousCreationCandidate("launch-1", "room-1");

  assert.equal(storage.getItem("letagents:add-agent:attached-launch:room-1:supervised_launch-1"), null);
});

test("an older absent lookup cannot clear a newer retry's attachment", async () => {
  const absentLookup = deferred<DesktopSupervisorManifestEntry[]>();
  const storage = memorySessionStorage();
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "launch-1" },
      sessionStorage: storage,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: { supervisor: { listAgents: () => absentLookup.promise } },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  launch.begin();
  launch.resetActiveLaunch();
  const staleLookup = launch.offerAmbiguousCreationCandidate("launch-1", "room-1");
  launch.begin();
  absentLookup.resolve([]);
  await staleLookup;

  assert.equal(storage.getItem("letagents:add-agent:attached-launch:room-1:supervised_launch-1"), "1");
  launch.cleanup();
});

test("an ambiguous create lookup cannot cancel an explicit recovery", async () => {
  const recoveryRead = deferred<DesktopSupervisorManifestEntry[]>();
  let reads = 0;
  Object.assign(globalThis, {
    window: {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          listAgents: async () => {
            reads += 1;
            if (reads === 2) return recoveryRead.promise;
            if (reads === 3) return [entry({ id: "supervised_other", createdAt: "2026-07-18T01:00:00.000Z" })];
            return [entry({ observedState: "failed", condition: "runtime_error" })];
          },
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });

  await launch.detectRecoverableLaunch();
  const recovery = launch.recoverDetectedLaunch();
  await launch.offerAmbiguousCreationCandidate("other", "room-1");
  assert.equal(launch.recoveryCandidate.value?.id, "supervised_launch-1");
  recoveryRead.resolve([entry({ observedState: "failed", condition: "runtime_error" })]);
  await recovery;

  assert.equal(launch.recoveringCandidate.value, false);
  assert.equal(launch.recoveryCandidate.value, null);
  assert.equal(launch.view.value?.failed, true);
});

test("recovered launches use their own provider's authentication command", () => {
  let copiedCommand: string | null = null;
  Object.assign(globalThis, {
    window: { setTimeout: () => 1, clearTimeout: () => undefined, letagentsDesktop: { supervisor: {} } },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => "codex login --device-auth",
    authCommandForProvider: (providerId) => providerId === "claude-code" ? "claude auth login" : null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: (command) => { copiedCommand = command; },
    onRetry: () => undefined,
    onMessage: () => undefined,
  });
  launch.complete(entry({
    provider: "claude-code",
    observedState: "failed",
    condition: "auth_required",
  }));

  launch.handleRecover("sign_in");

  assert.equal(copiedCommand, "claude auth login");
});

test("copying an auth recovery command advances the card to an explicit retry", () => {
  let copiedCommand: string | null = null;
  let retries = 0;
  Object.assign(globalThis, {
    window: { setTimeout: () => 1, clearTimeout: () => undefined, letagentsDesktop: { supervisor: {} } },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => "codex login --device-auth",
    authCommandForProvider: () => "codex login --device-auth",
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: (command) => { copiedCommand = command; },
    onRetry: () => { retries += 1; },
    onMessage: () => undefined,
  });
  launch.complete(entry({
    observedState: "failed",
    condition: "auth_blocked",
  }));

  assert.equal(launch.view.value?.recovery, "sign_in");
  launch.handleRecover("sign_in");
  assert.equal(copiedCommand, "codex login --device-auth");
  assert.equal(launch.view.value?.recovery, "retry");

  launch.handleRecover("retry");
  assert.equal(retries, 1);
});

test("recovered launches never fall back to another provider's authentication command", () => {
  let copiedCommand: string | null = null;
  let retries = 0;
  Object.assign(globalThis, {
    window: { setTimeout: () => 1, clearTimeout: () => undefined, letagentsDesktop: { supervisor: {} } },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    authCommand: () => "codex login --device-auth",
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: (command) => { copiedCommand = command; },
    onRetry: () => { retries += 1; },
    onMessage: () => undefined,
  });
  launch.complete(entry({
    provider: "provider-not-in-catalog",
    observedState: "failed",
    condition: "auth_required",
  }));

  launch.handleRecover("sign_in");

  assert.equal(copiedCommand, null);
  assert.equal(retries, 1);
});

test("a ready Codex card can be released for another request without stopping its durable agent", () => {
  const requestIds = ["codex-request-one", "codex-request-two"];
  let stopCalls = 0;
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => requestIds.shift()! },
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
          setDesiredState: async () => { stopCalls += 1; },
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: () => "codex",
    supportsConcurrentAgents: () => true,
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });
  assert.equal(launch.begin(), "codex-request-one");
  launch.complete(entry({
    provider: "codex",
    observedState: "working",
    workspacePath: "/tmp/worktree",
    providerPid: 42,
    agentSessionId: "agent-1",
    agentSessionBindingState: "active",
    workplaceLiveness: { state: "reachable", observedAt: "2026-07-18T00:00:02.000Z", detail: null },
  }));

  assert.equal(launch.view.value?.ready, true);
  launch.dismissReadyLaunchForAnother();
  assert.equal(launch.view.value, null);
  assert.equal(stopCalls, 0, "Add another only clears local attachment state");
  assert.equal(launch.begin(), "codex-request-two");
  launch.cleanup();
});

test("only providers with isolated supervised runtimes offer Add another", () => {
  const ready = entry({
    observedState: "working",
    workspacePath: "/tmp/worktree",
    providerPid: 42,
    agentSessionId: "agent-1",
    agentSessionBindingState: "active",
    workplaceLiveness: { state: "reachable", observedAt: "2026-07-18T00:00:02.000Z", detail: null },
  });
  assert.equal(canAddAnotherSupervisedAgent({
    providerId: "codex", entry: ready, supportsConcurrentAgents: true,
  }), true);
  assert.equal(canAddAnotherSupervisedAgent({
    providerId: "claude-code", entry: { ...ready, provider: "claude-code" }, supportsConcurrentAgents: true,
  }), true);
  assert.equal(canAddAnotherSupervisedAgent({
    providerId: "open-model", entry: { ...ready, provider: "open-model" }, supportsConcurrentAgents: true,
  }), true);
  assert.equal(canAddAnotherSupervisedAgent({
    providerId: "codex", entry: entry(), supportsConcurrentAgents: true,
  }), false);
});

test("a deferred name lookup persists the complete Start-click snapshot", async () => {
  const nameLookup = deferred<DesktopSupervisorManifestEntry[]>();
  let createdInput: Record<string, unknown> | null = null;
  const client = {
    listAgents: () => nameLookup.promise,
    createAgent: async (input: Record<string, unknown>) => {
      createdInput = input;
      return entry({
        id: "supervised_snapshot",
        displayName: String(input.displayName),
        provider: String(input.providerId),
      });
    },
  };
  const form = {
    providerId: "codex",
    providerName: "Codex",
    roomIdentifier: "room-before",
    repoRootPath: "/repo-before",
    charter: "Investigate the failure.",
    permissionProfileId: "read-only",
    launchPolicy: { profile: "read-only" },
    model: "gpt-5.6",
  };
  const request = createSupervisedAgentFromSnapshot(client as never, {
    creationRequestId: "request-snapshot",
    ...form,
  }, () => true);

  // These represent editable controls changing while listAgents is pending.
  form.providerId = "claude-code";
  form.providerName = "Claude Code";
  form.roomIdentifier = "room-after";
  form.repoRootPath = "/repo-after";
  form.charter = "Do something else.";
  form.permissionProfileId = "full-access";
  form.launchPolicy = { profile: "full-access" };
  form.model = "other-model";
  nameLookup.resolve([]);
  await request;

  assert.equal(createdInput?.creationRequestId, "request-snapshot");
  assert.equal(createdInput?.providerId, "codex");
  assert.equal(createdInput?.roomIdentifier, "room-before");
  assert.equal(createdInput?.displayName, "CloudSignal");
  assert.equal(createdInput?.repoRootPath, "/repo-before");
  assert.equal(createdInput?.charter, "Investigate the failure.");
  assert.equal(createdInput?.permissionProfileId, "read-only");
  assert.deepEqual(createdInput?.launchPolicy, { profile: "read-only" });
  assert.equal(createdInput?.model, "gpt-5.6");
});

test("Claude and Open Model creation use the same friendly codename contract as Codex", async () => {
  for (const provider of [
    { id: "claude-code", name: "Claude Code", model: "claude-sonnet", permissionProfileId: "read_only" },
    { id: "open-model", name: "Open Model", model: "qwen/agent-model", permissionProfileId: "full_access" },
  ] as const) {
    let createdInput: Record<string, unknown> | null = null;
    await createSupervisedAgentFromSnapshot({
      listAgents: async () => [entry({ displayName: "GardenSignal" })],
      createAgent: async (input: Record<string, unknown>) => {
        createdInput = input;
        return entry({
          id: `supervised_${provider.id}`,
          displayName: String(input.displayName),
          provider: String(input.providerId),
        });
      },
    } as never, {
      creationRequestId: `${provider.id}-request`,
      providerId: provider.id,
      providerName: provider.name,
      roomIdentifier: "room-1",
      repoRootPath: "/repo",
      charter: "Investigate the task.",
      permissionProfileId: provider.permissionProfileId,
      launchPolicy: null,
      model: provider.model,
    }, () => true);

    assert.equal(createdInput?.providerId, provider.id);
    assert.match(String(createdInput?.displayName), /^[A-Z][A-Za-z]+$/);
    assert.doesNotMatch(String(createdInput?.displayName), /claude|open model|supervised agent/i);
    assert.notEqual(createdInput?.displayName, "GardenSignal");
  }
});

test("modal close or provider invalidation during name lookup fences durable creation", async () => {
  for (const invalidation of ["modal close", "provider switch"]) {
    const nameLookup = deferred<DesktopSupervisorManifestEntry[]>();
    let current = true;
    let createCalls = 0;
    const request = createSupervisedAgentFromSnapshot({
      listAgents: () => nameLookup.promise,
      createAgent: async () => {
        createCalls += 1;
        return entry();
      },
    }, {
      creationRequestId: `request-${invalidation}`,
      providerId: "codex",
      providerName: "Codex",
      roomIdentifier: "room-1",
      repoRootPath: "/repo",
      charter: "Keep working.",
      permissionProfileId: null,
      launchPolicy: null,
      model: null,
    }, () => current);

    current = false;
    nameLookup.resolve([]);
    assert.equal(await request, null);
    assert.equal(createCalls, 0, `${invalidation} must prevent createAgent`);
  }
});

test("switching away from Codex revokes the shared Add-another eligibility and handler", async () => {
  const selectedProviderId = ref<"codex" | "claude-code">("codex");
  Object.assign(globalThis, {
    window: {
      crypto: { randomUUID: () => "codex-request" },
      sessionStorage: memorySessionStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      letagentsDesktop: {
        supervisor: {
          onLaunchEvent: () => () => undefined,
          getLaunchEvents: async () => [],
        },
      },
    },
  });
  const launch = useSupervisedAgentLaunch({
    open: () => true,
    roomIdentifier: () => "room-1",
    roomLabel: () => "Room one",
    providerId: selectedProviderId,
    supportsConcurrentAgents: () => selectedProviderId.value === "codex",
    authCommand: () => null,
    authCommandForProvider: () => null,
    currentVersion: () => 0,
    isCurrentRequest: () => true,
    onChooseRepo: () => undefined,
    onCopyAuthCommand: () => undefined,
    onRetry: () => undefined,
    onMessage: () => undefined,
  });
  launch.begin();
  launch.complete(entry({
    observedState: "working",
    workspacePath: "/tmp/worktree",
    providerPid: 42,
    agentSessionId: "agent-1",
    agentSessionBindingState: "active",
    workplaceLiveness: { state: "reachable", observedAt: "2026-07-18T00:00:02.000Z", detail: null },
  }));
  assert.equal(launch.canAddAnotherSupervisedAgent.value, true);

  selectedProviderId.value = "claude-code";
  await nextTick();
  assert.equal(launch.canAddAnotherSupervisedAgent.value, false);
  launch.dismissReadyLaunchForAnother();
  assert.equal(launch.view.value?.ready, true, "revoked handler must preserve the Codex card");
  launch.cleanup();
});
