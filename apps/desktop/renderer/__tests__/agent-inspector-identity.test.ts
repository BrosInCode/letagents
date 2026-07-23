import assert from "node:assert/strict";
import test from "node:test";
import type {
  DesktopManagedAgentSession,
  DesktopSupervisorManifestEntry,
} from "../../electron/ipc-types";
import {
  isCurrentAgentInspectorOperation,
  isCurrentAgentInspectorSupervisorUpdate,
  participantAgentInspectorRequest,
  resolveAgentInspectorManagedSessions,
  resolveAgentInspectorSelection,
  resolveSupervisorEntryId,
  supervisedAgentInspectorRequest,
  type AgentInspectorOperationContext,
  type AgentInspectorOperationToken,
  type SupervisorEntriesResource,
} from "../src/domain/agent-inspector-identity";
import type {
  AgentInspectorSelection,
  AgentModalTarget,
} from "../src/components/desktop/content/desktop-chat-message/types";

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_garden",
    roomId: "room_a",
    displayName: "GardenSignal",
    agentKey: "owner/garden-signal",
    provider: "codex",
    model: null,
    charter: "Help",
    desiredState: "running",
    observedState: "idle",
    condition: "none",
    permissionProfileId: null,
    deliveryMode: "daemon_inbox",
    createdBy: "EmmyMay",
    createdAt: "2026-07-22T10:00:00.000Z",
    workspacePath: null,
    workAttemptId: null,
    agentSessionId: "session_current",
    agentSessionBindingState: "historical",
    bindingUpdatedAt: null,
    executionGenerationId: null,
    providerContinuationId: null,
    providerPid: null,
    workplaceLiveness: { state: "unknown", observedAt: null, detail: null },
    nativeLiveness: { state: "unknown", observedAt: null, detail: null },
    restartCount: 0,
    lastTerminal: null,
    activity: [],
    turnControl: null,
    ...overrides,
  };
}

function target(overrides: Partial<AgentModalTarget> = {}): AgentModalTarget {
  return {
    actorLabel: "GardenSignal",
    displayName: "GardenSignal",
    ownerAttribution: "EmmyMay's agent",
    ideLabel: "Codex",
    sender: "GardenSignal",
    agentKey: "owner/garden-signal",
    agentSessionId: "session_current",
    ...overrides,
  };
}

function managedSession(overrides: Partial<DesktopManagedAgentSession> = {}): DesktopManagedAgentSession {
  return {
    id: "managed_garden",
    providerId: "codex",
    runtime: "codex",
    roomIdentifier: "room_a",
    roomDisplayName: null,
    repoRootPath: "/tmp/repo",
    repoBranch: null,
    status: "running",
    deliveryMode: "desktop_events",
    permissionProfileId: "full_access",
    permissionProfile: {
      id: "full_access",
      label: "Full access",
      description: "Trusted local access.",
      status: "available",
      risk: "high",
      detail: null,
      isDefault: true,
    },
    canStop: true,
    agentSessionId: "session_current",
    actorLabel: "GardenSignal",
    agentKey: "owner/garden-signal",
    displayName: "GardenSignal",
    ownerLabel: "EmmyMay",
    ideLabel: "Codex",
    reasoningSessionId: null,
    activeWork: null,
    pendingPermissionRequests: [],
    startedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:00:00.000Z",
    lastError: null,
    supervisorEntryId: null,
    ...overrides,
  };
}

function externalSelection(overrides: Partial<AgentModalTarget> = {}): AgentInspectorSelection {
  return { ...target(overrides), kind: "external" };
}

function resource(
  state: SupervisorEntriesResource["state"],
  data: DesktopSupervisorManifestEntry[],
  error = "daemon unavailable",
): SupervisorEntriesResource {
  return state === "error"
    ? { state, roomIdentifier: "room_a", updatedAt: "2026-07-22T10:00:00.000Z", data, error }
    : state === "ready"
      ? { state, roomIdentifier: "room_a", updatedAt: "2026-07-22T10:00:00.000Z", data, error: null }
      : { state, roomIdentifier: "room_a", updatedAt: null, data, error: null };
}

test("a stale session resolves through one exact stable agent key", () => {
  const selection = resolveAgentInspectorSelection(
    resource("ready", [entry()]),
    participantAgentInspectorRequest(target({ agentSessionId: "session_stale" })),
    "room_a",
  );
  assert.equal(selection.kind, "supervised");
  assert.equal(selection.kind === "supervised" ? selection.supervisorEntryId : null, "supervised_garden");
});

test("display names and actor labels never resolve supervised identity", () => {
  const selection = resolveAgentInspectorSelection(
    resource("ready", [entry({ agentKey: "owner/other", agentSessionId: "session_other" })]),
    participantAgentInspectorRequest(target({ agentKey: null, agentSessionId: null })),
    "room_a",
  );
  assert.equal(selection.kind, "external");
});

test("same-label peers cannot cross-bind and generic provider keys are ignored", () => {
  const peers = [
    entry({ id: "one", agentKey: "owner/one", agentSessionId: "one" }),
    entry({ id: "two", agentKey: "owner/two", agentSessionId: "two" }),
  ];
  assert.equal(resolveAgentInspectorSelection(
    resource("ready", peers),
    participantAgentInspectorRequest(target({ agentKey: null, agentSessionId: null })),
    "room_a",
  ).kind, "external");
  assert.deepEqual(
    resolveSupervisorEntryId([entry({ agentKey: "codex" })], { agentKey: "codex", agentSessionId: null }),
    { state: "unmatched" },
  );
});

test("conflicting and duplicate stable identities fail closed", () => {
  const conflict = resolveAgentInspectorSelection(
    resource("ready", [
      entry({ id: "session_owner", agentKey: "owner/a", agentSessionId: "session_a" }),
      entry({ id: "key_owner", agentKey: "owner/b", agentSessionId: "session_b" }),
    ]),
    participantAgentInspectorRequest(target({ agentSessionId: "session_a", agentKey: "owner/b" })),
    "room_a",
  );
  assert.equal(conflict.kind, "unavailable");
  assert.equal(conflict.kind === "unavailable" ? conflict.unavailableReason : null, "ambiguous");

  assert.deepEqual(resolveSupervisorEntryId([
    entry({ id: "one" }),
    entry({ id: "two" }),
  ], { agentSessionId: "session_current", agentKey: null }), { state: "ambiguous" });
});

test("loading, refreshing, and failures never classify an unresolved participant as external", () => {
  const request = participantAgentInspectorRequest(target({ agentKey: null, agentSessionId: null }));
  assert.equal(resolveAgentInspectorSelection(resource("loading", []), request, "room_a").kind, "resolving");
  assert.equal(resolveAgentInspectorSelection(resource("refreshing", []), request, "room_a").kind, "resolving");
  const failed = resolveAgentInspectorSelection(resource("error", [entry()]), request, "room_a");
  assert.equal(failed.kind, "unavailable");
  assert.equal(failed.kind === "unavailable" ? failed.unavailableReason : null, "load_error");
});

test("a refresh failure retains and resolves an exact last-known supervised identity", () => {
  const selection = resolveAgentInspectorSelection(
    resource("error", [entry()]),
    participantAgentInspectorRequest(target()),
    "room_a",
  );
  assert.equal(selection.kind, "supervised");
});

test("direct Activity selections require the exact entry id and resource room", () => {
  const garden = entry();
  const request = supervisedAgentInspectorRequest(garden, { ownerAttribution: "EmmyMay's agent" });
  assert.equal(resolveAgentInspectorSelection(resource("ready", [garden]), request, "room_a").kind, "supervised");
  assert.equal(resolveAgentInspectorSelection(resource("ready", [garden]), request, "room_b").kind, "resolving");
  const missing = resolveAgentInspectorSelection(resource("ready", []), request, "room_a");
  assert.equal(missing.kind, "unavailable");
  assert.equal(missing.kind === "unavailable" ? missing.unavailableReason : null, "missing");
});

test("a retained direct request follows resource loss and recovery without identity inference", () => {
  const garden = entry();
  const request = supervisedAgentInspectorRequest(garden);
  assert.equal(resolveAgentInspectorSelection(resource("ready", [garden]), request, "room_a").kind, "supervised");
  assert.equal(resolveAgentInspectorSelection(resource("refreshing", []), request, "room_a").kind, "resolving");
  const missing = resolveAgentInspectorSelection(resource("ready", []), request, "room_a");
  assert.equal(missing.kind, "unavailable");
  assert.equal(missing.kind === "unavailable" ? missing.unavailableReason : null, "missing");
  assert.equal(resolveAgentInspectorSelection(resource("ready", [garden]), request, "room_a").kind, "supervised");
});

test("control-bearing managed sessions require one agreeing exact identity", () => {
  const garden = managedSession();
  assert.deepEqual(
    resolveAgentInspectorManagedSessions([garden], externalSelection()),
    [garden],
  );

  const sessionOwner = managedSession({ id: "session_owner", agentKey: "owner/a" });
  const keyOwner = managedSession({ id: "key_owner", agentSessionId: "session_b" });
  assert.deepEqual(resolveAgentInspectorManagedSessions(
    [sessionOwner, keyOwner],
    externalSelection({ agentSessionId: "session_current", agentKey: "owner/garden-signal" }),
  ), []);
});

test("same labels and duplicate durable identities never expose managed controls or permissions", () => {
  const permission = {
    id: "permission_1",
    providerId: "codex" as const,
    sessionId: "session_current",
    title: "Run command",
    toolName: "shell",
    toolUseId: null,
    description: "Run a destructive command.",
    inputSummary: "rm -rf /tmp/example",
    decisionReason: null,
    roomMessageId: null,
    requestedAt: "2026-07-22T10:00:00.000Z",
  };
  const peers = [
    managedSession({ id: "one", pendingPermissionRequests: [permission] }),
    managedSession({ id: "two", pendingPermissionRequests: [permission] }),
  ];
  assert.deepEqual(resolveAgentInspectorManagedSessions(
    peers,
    externalSelection({ agentKey: null, agentSessionId: "session_current" }),
  ), []);
  assert.deepEqual(resolveAgentInspectorManagedSessions(
    peers,
    externalSelection({ agentKey: null, agentSessionId: null }),
  ), []);

  const supervisedPeers = peers.map((session) => ({ ...session, supervisorEntryId: "supervised_garden" }));
  assert.deepEqual(resolveAgentInspectorManagedSessions(
    supervisedPeers,
    { ...target(), kind: "supervised", supervisorEntryId: "supervised_garden" },
  ), []);
});

test("late supervisor actions cannot update a different room or Inspector request", () => {
  const update = {
    entry: entry(),
    roomIdentifier: "room_a",
    inspectorRequestVersion: 4,
  };
  assert.equal(isCurrentAgentInspectorSupervisorUpdate(update, "room_a", 4), true);
  assert.equal(isCurrentAgentInspectorSupervisorUpdate(update, "room_b", 4), false);
  assert.equal(isCurrentAgentInspectorSupervisorUpdate(update, "room_a", 5), false);
  assert.equal(isCurrentAgentInspectorSupervisorUpdate({
    ...update,
    entry: entry({ roomId: "room_b" }),
  }, "room_a", 4), false);
});

test("an old control promise cannot mutate or unlock a newer Inspector operation", async () => {
  const oldContext: AgentInspectorOperationContext = {
    modalStateVersion: 1,
    roomIdentifier: "room_a",
    inspectorRequestVersion: 4,
  };
  const newContext: AgentInspectorOperationContext = {
    modalStateVersion: 2,
    roomIdentifier: "room_b",
    inspectorRequestVersion: 5,
  };
  const oldOperation: AgentInspectorOperationToken = {
    operationId: "old-operation",
    entryId: "supervised_garden",
    providerActionId: "action_shared",
    context: oldContext,
  };
  const newOperation: AgentInspectorOperationToken = {
    operationId: "new-operation",
    entryId: "supervised_garden",
    providerActionId: "action_shared",
    context: newContext,
  };

  let currentOperation: AgentInspectorOperationToken | null = oldOperation;
  let currentContext = oldContext;
  const writes: string[] = [];
  let resolveOld!: (value: string) => void;
  const oldResult = new Promise<string>((resolve) => { resolveOld = resolve; });
  const settle = async (promise: Promise<string>, operation: AgentInspectorOperationToken) => {
    try {
      const value = await promise;
      if (isCurrentAgentInspectorOperation(operation, currentOperation, currentContext, true)) {
        writes.push(value);
      }
    } catch {
      if (isCurrentAgentInspectorOperation(operation, currentOperation, currentContext, true)) {
        writes.push("error");
      }
    } finally {
      if (isCurrentAgentInspectorOperation(operation, currentOperation, currentContext, true)) {
        currentOperation = null;
      }
    }
  };

  const staleSuccess = settle(oldResult, oldOperation);
  currentOperation = newOperation;
  currentContext = newContext;
  resolveOld("stale success");
  await staleSuccess;
  assert.deepEqual(writes, []);
  assert.equal(currentOperation, newOperation);

  const oldRejectedOperation = { ...oldOperation, operationId: "old-rejection" };
  let rejectOld!: (error: Error) => void;
  const oldRejection = new Promise<string>((_resolve, reject) => { rejectOld = reject; });
  const staleFailure = settle(oldRejection, oldRejectedOperation);
  rejectOld(new Error("stale failure"));
  await staleFailure;
  assert.deepEqual(writes, []);
  assert.equal(currentOperation, newOperation);
});
