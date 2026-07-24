import assert from "node:assert/strict";
import test from "node:test";
import type {
  DesktopManagedAgentSession,
  DesktopSupervisorManifestEntry,
} from "../../electron/ipc-types";
import {
  agentInspectorRequestResetKey,
  isCurrentAgentInspectorOperation,
  isCurrentAgentInspectorSupervisorUpdate,
  participantAgentInspectorRequest,
  parseSupervisedReplyPublicationIdentity,
  resolvingAgentInspectorRequest,
  resolveAgentInspectorManagedSessions,
  resolveAgentInspectorSelection,
  resolveSupervisorEntryId,
  resolveSupervisorEntryIdFromLegacyAuthenticatedActor,
  resolveSupervisorEntryIdFromPublicationIdentity,
  resolveSupervisorEntryIdForPublishedMessage,
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
    messageId: null,
    clientMessageId: null,
    messageSource: null,
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

test("a historical server-authenticated supervised actor resolves to one exact local manifest entry", () => {
  const desktopCreatedEntry = entry({ createdBy: "desktop" });
  const historicalTarget = target({
    messageId: "msg_agent_reply",
    clientMessageId: null,
    messageSource: "agent",
    actorLabel: "GardenSignal | EmmyMay's agent | Supervisor Worker",
    sender: "GardenSignal | EmmyMay's agent | Supervisor Worker",
    agentKey: null,
    agentSessionId: null,
  });
  assert.deepEqual(
    resolveSupervisorEntryIdFromLegacyAuthenticatedActor([desktopCreatedEntry], historicalTarget, "room_a"),
    { state: "matched", entryId: "supervised_garden" },
  );
  const selection = resolveAgentInspectorSelection(
    resource("ready", [desktopCreatedEntry]),
    participantAgentInspectorRequest(historicalTarget),
    "room_a",
  );
  assert.equal(selection.kind, "supervised");
  assert.equal(selection.kind === "supervised" ? selection.supervisorEntryId : null, "supervised_garden");
});

test("legacy actor recovery rejects non-agent sources, generic labels, foreign rooms, and collisions", () => {
  const exactActor = target({
    messageSource: "agent",
    actorLabel: "GardenSignal | EmmyMay's agent | Supervisor Worker",
    sender: "GardenSignal | EmmyMay's agent | Supervisor Worker",
    agentKey: null,
    agentSessionId: null,
  });
  assert.deepEqual(
    resolveSupervisorEntryIdFromLegacyAuthenticatedActor([entry()], {
      ...exactActor,
      messageSource: "system",
    }, "room_a"),
    { state: "unmatched" },
  );
  assert.deepEqual(
    resolveSupervisorEntryIdFromLegacyAuthenticatedActor([entry()], {
      ...exactActor,
      actorLabel: "GardenSignal",
    }, "room_a"),
    { state: "unmatched" },
  );
  assert.deepEqual(
    resolveSupervisorEntryIdFromLegacyAuthenticatedActor([entry()], exactActor, "room_b"),
    { state: "unmatched" },
  );
  assert.deepEqual(
    resolveSupervisorEntryIdFromLegacyAuthenticatedActor([
      entry({ id: "one" }),
      entry({ id: "two" }),
    ], exactActor, "room_a"),
    { state: "ambiguous" },
  );
});

test("an exact-message lookup keeps the Inspector resolving instead of flashing external", () => {
  const selection = resolveAgentInspectorSelection(
    resource("ready", [entry()]),
    resolvingAgentInspectorRequest(target({
      messageId: "msg_agent_reply",
      clientMessageId: null,
      agentKey: null,
      agentSessionId: null,
    })),
    "room_a",
  );
  assert.equal(selection.kind, "resolving");
});

test("a Chat reply with no embedded agent identity resolves through its exact durable publication", () => {
  const garden = entry({
    agentKey: "owner/garden-signal",
    agentSessionId: "session_current",
    deliveryReceipts: [{
      inboxItemId: "inbox_1",
      sourceMessageId: "msg_human",
      canonicalMessageId: "msg_agent_reply",
      replyClientMessageId: "supervised-room:supervised_garden:msg_human:reply:v1",
      state: "acknowledged",
      attemptCount: 1,
      providerTurnId: "turn_1",
      blockedByMessageId: null,
      error: null,
      updatedAt: "2026-07-22T10:01:00.000Z",
      timeline: [],
    }],
  });
  const selection = resolveAgentInspectorSelection(
    resource("ready", [garden]),
    participantAgentInspectorRequest(target({
      messageId: "msg_agent_reply",
      clientMessageId: "supervised-room:supervised_garden:msg_human:reply:v1",
      agentKey: null,
      agentSessionId: null,
    })),
    "room_a",
  );
  assert.equal(selection.kind, "supervised");
  assert.equal(selection.kind === "supervised" ? selection.supervisorEntryId : null, garden.id);
});

test("a pruned historical reply resolves from the validated daemon publication identity", () => {
  const garden = entry({
    deliveryReceipts: [],
  });
  const historicalTarget = target({
    messageId: "msg_agent_reply",
    clientMessageId: "supervised-room:supervised_garden:room_a:msg_human:reply:v1",
    actorLabel: "GardenSignal | EmmyMay's agent | Supervisor Worker",
    sender: "GardenSignal | EmmyMay's agent | Supervisor Worker",
    agentKey: null,
    agentSessionId: null,
  });

  assert.deepEqual(
    resolveSupervisorEntryIdFromPublicationIdentity([garden], historicalTarget, "room_a"),
    { state: "matched", entryId: garden.id },
  );
  const selection = resolveAgentInspectorSelection(
    resource("ready", [garden]),
    participantAgentInspectorRequest(historicalTarget),
    "room_a",
  );
  assert.equal(selection.kind, "supervised");
  assert.equal(selection.kind === "supervised" ? selection.supervisorEntryId : null, garden.id);
});

test("historical publication recovery rejects forged, foreign-room, and mismatched actor roles or names", () => {
  const garden = entry({ deliveryReceipts: [] });
  assert.equal(parseSupervisedReplyPublicationIdentity("some-client-id"), null);
  assert.equal(
    parseSupervisedReplyPublicationIdentity("supervised-room:supervised_garden:room_a:not-a-message:reply:v1"),
    null,
  );

  for (const historicalTarget of [
    target({
      clientMessageId: "supervised-room:supervised_garden:room_b:msg_human:reply:v1",
      actorLabel: "GardenSignal | EmmyMay's agent | Supervisor Worker",
    }),
    target({
      clientMessageId: "supervised-room:supervised_garden:room_a:msg_human:reply:v1",
      actorLabel: "OtherAgent | EmmyMay's agent | Supervisor Worker",
    }),
    target({
      clientMessageId: "supervised-room:supervised_garden:room_a:msg_human:reply:v1",
      actorLabel: "GardenSignal | EmmyMay's agent | Codex",
    }),
  ]) {
    assert.deepEqual(
      resolveSupervisorEntryIdFromPublicationIdentity([garden], historicalTarget, "room_a"),
      { state: "unmatched" },
    );
  }
});

test("publication identity is exact, collision-safe, and must agree with embedded identity", () => {
  const receipt = {
    inboxItemId: "inbox_1",
    sourceMessageId: "msg_human",
    canonicalMessageId: "msg_agent_reply",
    replyClientMessageId: "supervised-room:garden:msg_human:reply:v1",
    state: "acknowledged" as const,
    attemptCount: 1,
    providerTurnId: "turn_1",
    blockedByMessageId: null,
    error: null,
    updatedAt: "2026-07-22T10:01:00.000Z",
    timeline: [],
  };
  const garden = entry({ id: "garden", agentKey: "owner/garden", agentSessionId: "session_garden", deliveryReceipts: [receipt] });
  const sameName = entry({ id: "same_name", agentKey: "owner/other", agentSessionId: "session_other", deliveryReceipts: [] });
  assert.deepEqual(
    resolveSupervisorEntryIdForPublishedMessage([garden, sameName], {
      messageId: "msg_agent_reply",
      clientMessageId: null,
    }),
    { state: "matched", entryId: "garden" },
  );

  const disagreement = resolveAgentInspectorSelection(
    resource("ready", [garden, sameName]),
    participantAgentInspectorRequest(target({
      messageId: "msg_agent_reply",
      clientMessageId: "supervised-room:garden:msg_human:reply:v1",
      agentKey: "owner/other",
      agentSessionId: "session_other",
    })),
    "room_a",
  );
  assert.equal(disagreement.kind, "unavailable");
  assert.equal(disagreement.kind === "unavailable" ? disagreement.unavailableReason : null, "ambiguous");

  assert.deepEqual(
    resolveSupervisorEntryIdForPublishedMessage([
      garden,
      entry({ id: "duplicate", deliveryReceipts: [receipt] }),
    ], {
      messageId: "msg_agent_reply",
      clientMessageId: "supervised-room:garden:msg_human:reply:v1",
    }),
    { state: "ambiguous" },
  );
});

test("a rotated historical session resolves from its durable reply client message id", () => {
  const historicalReplyClientMessageId = "supervised-room:supervised_garden:msg_human:reply:v1";
  const garden = entry({
    agentSessionId: "session_rotated",
    deliveryReceipts: [{
      inboxItemId: "inbox_1",
      sourceMessageId: "msg_human",
      canonicalMessageId: null,
      replyClientMessageId: historicalReplyClientMessageId,
      state: "acknowledged",
      attemptCount: 1,
      providerTurnId: "turn_1",
      blockedByMessageId: null,
      error: null,
      updatedAt: "2026-07-22T10:01:00.000Z",
      timeline: [],
    }],
  });

  const selection = resolveAgentInspectorSelection(
    resource("ready", [garden]),
    participantAgentInspectorRequest(target({
      messageId: "msg_agent_reply",
      clientMessageId: historicalReplyClientMessageId,
      agentKey: null,
      agentSessionId: "session_historical",
    })),
    "room_a",
  );

  assert.equal(selection.kind, "supervised");
  assert.equal(selection.kind === "supervised" ? selection.supervisorEntryId : null, garden.id);
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

test("a new exact request resets operations even when its presentation is unchanged", async () => {
  const samePresentation = {
    ...target(),
    kind: "supervised" as const,
    supervisorEntryId: "supervised_garden",
  };
  assert.notEqual(
    agentInspectorRequestResetKey(samePresentation, 10),
    agentInspectorRequestResetKey(samePresentation, 11),
  );

  const oldContext: AgentInspectorOperationContext = {
    modalStateVersion: 10,
    roomIdentifier: "room_a",
    inspectorRequestVersion: 10,
  };
  const newContext: AgentInspectorOperationContext = {
    modalStateVersion: 11,
    roomIdentifier: "room_a",
    inspectorRequestVersion: 11,
  };
  const oldOperation: AgentInspectorOperationToken = {
    operationId: "old",
    entryId: "supervised_garden",
    providerActionId: "action_old",
    context: oldContext,
  };
  const newOperation: AgentInspectorOperationToken = {
    operationId: "new",
    entryId: "supervised_garden",
    providerActionId: "action_new",
    context: newContext,
  };

  let activeOperation: AgentInspectorOperationToken | null = oldOperation;
  // The authoritative request-key watcher resets the stale lock, allowing the
  // same visible agent to begin a control under the new request.
  activeOperation = null;
  assert.equal(activeOperation, null);
  activeOperation = newOperation;

  let resolveOld!: () => void;
  const oldPromise = new Promise<void>((resolve) => { resolveOld = resolve; });
  let staleWrites = 0;
  const settleOld = (async () => {
    await oldPromise;
    if (isCurrentAgentInspectorOperation(oldOperation, activeOperation, newContext, true)) {
      staleWrites += 1;
      activeOperation = null;
    }
  })();
  resolveOld();
  await settleOld;

  assert.equal(staleWrites, 0);
  assert.equal(activeOperation, newOperation);
});
