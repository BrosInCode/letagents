import assert from "node:assert/strict";
import test from "node:test";

import {
  agentInspectorTurnControlActionId,
  agentInspectorTurnControlActionIdIfCurrent,
  agentInspectorTurnControlFenceMatches,
  agentInspectorActionStateForEntry,
  clearAgentInspectorActionStateIfMatching,
  agentInspectorOverallState,
  projectAgentInspector,
  projectAgentInspectorTurnControl,
} from "../src/domain/agent-inspector";
import type { AgentInspectorActionState } from "../src/domain/agent-inspector";
import { isCurrentAgentInspectorSupervisorUpdate } from "../src/domain/agent-inspector-identity";
import {
  foldSupervisorActivityPush,
  mergeSupervisorEntriesPoll,
  supervisorEntriesResourceFreshness,
  supervisorStateSubscriptionNeedsRepair,
  SUPERVISOR_ACTIVITY_CAP,
} from "../src/domain/supervisor-entries-resource";
import {
  isProjectedSupervisedActivityParticipant,
  supervisedActivityIdentity,
} from "../src/domain/room-agent-delivery";
import { roomMentionCandidates } from "../src/domain/participants";
import type {
  DesktopParticipantSummary,
  DesktopRoomAgentDeliveryReceipt,
  DesktopSupervisorActivityEvent,
  DesktopSupervisorManifestEntry,
  DesktopTaskSummary,
} from "../../electron/ipc-types";

function activity(sequence: number, overrides: Partial<DesktopSupervisorActivityEvent> = {}): DesktopSupervisorActivityEvent {
  return {
    observedAt: `2026-07-23T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    sequence,
    provider: "codex",
    kind: "notification",
    method: "item/reasoning/summaryTextDelta",
    summary: `Progress ${sequence}`,
    status: "working",
    payload: null,
    payloadTruncated: false,
    payloadRedacted: true,
    durablePayloadRef: null,
    ...overrides,
  };
}

function receipt(
  sourceMessageId: string,
  state: DesktopRoomAgentDeliveryReceipt["state"],
  overrides: Partial<DesktopRoomAgentDeliveryReceipt> = {},
): DesktopRoomAgentDeliveryReceipt {
  return {
    inboxItemId: `inbox_${sourceMessageId}`,
    sourceMessageId,
    replyClientMessageId: `reply_${sourceMessageId}`,
    canonicalMessageId: null,
    state,
    attemptCount: 1,
    providerTurnId: "turn_1",
    blockedByMessageId: null,
    error: null,
    failureCode: null,
    updatedAt: "2026-07-23T10:00:05.000Z",
    timeline: [],
    ...overrides,
  };
}

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_1",
    roomId: "focus_1",
    displayName: "GardenSignal",
    agentKey: "emmymay/gardensignal",
    provider: "codex",
    model: "gpt-5.6",
    charter: "Investigate failures.",
    desiredState: "running",
    observedState: "working",
    condition: "none",
    lastError: null,
    permissionProfileId: null,
    deliveryMode: "daemon_inbox",
    createdBy: "EmmyMay",
    createdAt: "2026-07-23T09:00:00.000Z",
    workspacePath: "/tmp/garden-signal",
    workAttemptId: "attempt_1",
    agentSessionId: "session_1",
    agentSessionBindingState: "active",
    bindingUpdatedAt: "2026-07-23T09:00:00.000Z",
    executionGenerationId: "generation_1",
    providerContinuationId: "continuation_1",
    providerPid: 123,
    workplaceLiveness: { state: "healthy", observedAt: "2026-07-23T10:00:00.000Z", detail: null },
    nativeLiveness: { state: "healthy", observedAt: "2026-07-23T10:00:00.000Z", detail: null },
    restartCount: 0,
    lastTerminal: null,
    activity: [],
    roomAgentState: {
      connection: { state: "connected", observedAt: "2026-07-23T10:00:00.000Z", detail: null },
      ingress: { state: "observing", observedAt: "2026-07-23T10:00:00.000Z", detail: null },
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    },
    deliveryReceipts: [],
    turnControl: null,
    ...overrides,
  };
}

function task(id: string, status: string, overrides: Partial<DesktopTaskSummary> = {}): DesktopTaskSummary {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    status,
    assignee: null,
    assigneeAgentKey: "emmymay/gardensignal",
    createdBy: null,
    prUrl: null,
    workflowArtifacts: [],
    workflowRefs: [],
    activeLeases: [],
    activeLocks: [],
    stalePromptState: null,
    createdAt: null,
    updatedAt: "2026-07-23T10:00:00.000Z",
    ...overrides,
  };
}

test("truthful state requires all listening authorities and preserves reconnecting", () => {
  assert.equal(agentInspectorOverallState(entry()), "listening");
  assert.equal(agentInspectorOverallState(entry({ providerPid: null })), "disconnected");
  assert.equal(agentInspectorOverallState(entry({
    providerPid: null,
    roomAgentState: {
      ...entry().roomAgentState!,
      connection: { state: "reconnecting", observedAt: null, detail: null },
      ingress: { state: "backoff", observedAt: null, detail: "Gateway timeout" },
    },
  })), "reconnecting");
});

test("overall state follows the complete product precedence table", () => {
  const withRoom = (overrides: Partial<NonNullable<DesktopSupervisorManifestEntry["roomAgentState"]>>) => {
    const current = entry().roomAgentState!;
    return entry({ roomAgentState: { ...current, ...overrides } });
  };
  const cases: Array<[string, DesktopSupervisorManifestEntry, ReturnType<typeof agentInspectorOverallState>]> = [
    ["retired", entry({ desiredState: "stopped", condition: "auth_blocked" }), "retired"],
    ["paused", entry({ desiredState: "paused", condition: "auth_blocked" }), "paused"],
    ["condition blocked", entry({ condition: "auth_blocked" }), "needs_attention"],
    ["credential waiting", withRoom({ inbox: { state: "waiting_for_desktop_credentials", pendingCount: 0, blockedByMessageId: null, detail: null } }), "needs_attention"],
    ["ingress blocked", withRoom({ ingress: { state: "blocked", observedAt: null, detail: null } }), "needs_attention"],
    ["reconnecting", withRoom({ connection: { state: "reconnecting", observedAt: null, detail: null } }), "reconnecting"],
    ["active turn", withRoom({ turn: { state: "responding", inboxItemId: "inbox_1", sourceMessageId: "message_1", providerTurnId: "turn_1", detail: null } }), "responding"],
    ["listening", entry(), "listening"],
    ["starting", entry({ providerPid: null, observedState: "starting" }), "starting"],
    ["disconnected", entry({ providerPid: null, observedState: "working" }), "disconnected"],
    ["missing axes", entry({ roomAgentState: null }), "disconnected"],
    ["unknown binding", entry({ agentSessionBindingState: "none" }), "disconnected"],
  ];
  for (const [label, candidate, expected] of cases) {
    assert.equal(agentInspectorOverallState(candidate), expected, label);
  }
});

test("durable entries remain inspectable before room state exists", () => {
  const projection = projectAgentInspector(entry({
    observedState: "starting",
    roomAgentState: null,
  }), { roomId: "focus_1" });
  assert.ok(projection);
  assert.equal(projection.overallState, "starting");
  assert.equal(projection.readiness.find((fact) => fact.key === "inbox")?.value, "Unavailable");
  assert.equal(projection.readiness.find((fact) => fact.key === "inbox")?.tone, "offline");
});

test("Now uses only sanitized activity observed after the exact turn_started event", () => {
  const delivery = receipt("message_1", "awaiting_result", {
    timeline: [{ phase: "turn_started", observedAt: "2026-07-23T10:00:02.000Z", detail: null }],
  });
  const responding = entry({
    activity: [
      activity(1, { summary: "Old work" }),
      activity(3, { method: "thread/read", summary: "Raw provider event" }),
      activity(4, { summary: "Checking the workspace" }),
    ],
    deliveryReceipts: [delivery],
    roomAgentState: {
      ...entry().roomAgentState!,
      turn: { state: "responding", inboxItemId: delivery.inboxItemId, sourceMessageId: "message_1", providerTurnId: "turn_1", detail: null },
    },
  });
  assert.match(projectAgentInspector(responding, { roomId: "focus_1" })?.now?.summary ?? "", /Checking the workspace/);

  const withoutStart = entry({ ...responding, deliveryReceipts: [receipt("message_1", "awaiting_result")] });
  assert.equal(projectAgentInspector(withoutStart, { roomId: "focus_1" })?.now, null);

  const rawOnly = entry({
    ...responding,
    activity: [
      activity(4, { kind: "provider_event", summary: "Raw provider payload" }),
      activity(5, { kind: "usage", summary: "Used 500 tokens" }),
      activity(6, { method: "account/rateLimits/updated", summary: "Rate limit updated" }),
    ],
  });
  assert.equal(projectAgentInspector(rawOnly, { roomId: "focus_1" })?.now?.summary, "Working on the room message");

  const detailedFallback = entry({
    ...responding,
    activity: [activity(1, { kind: "provider_event", summary: "opaque provider notification" })],
    roomAgentState: {
      ...responding.roomAgentState!,
      turn: { state: "responding", inboxItemId: delivery.inboxItemId, sourceMessageId: "message_1", providerTurnId: "turn_1", detail: "Reviewing the latest room context" },
    },
  });
  assert.equal(projectAgentInspector(detailedFallback, { roomId: "focus_1" })?.now?.summary, "Reviewing the latest room context");

  const finished = entry({ ...responding, roomAgentState: { ...responding.roomAgentState!, turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null } } });
  assert.equal(projectAgentInspector(finished, { roomId: "focus_1" })?.now, null, "completion clears active Now instead of retaining a stale progress echo");
});

test("delivery progress follows durable turn phases without duplicating the thinking surface", () => {
  const withTurn = (state: "dispatching" | "responding" | "retrying" | "publishing") => projectAgentInspector(entry({
    deliveryReceipts: state === "responding"
      ? [receipt("message_1", "awaiting_result", {
        timeline: [{ phase: "turn_started", observedAt: "2026-07-23T10:00:02.000Z", detail: null }],
      })]
      : [],
    roomAgentState: {
      ...entry().roomAgentState!,
      turn: {
        state,
        inboxItemId: "inbox_message_1",
        sourceMessageId: "message_1",
        providerTurnId: state === "dispatching" ? null : "turn_1",
        detail: null,
      },
    },
  }), { roomId: "focus_1" });

  assert.deepEqual(withTurn("dispatching")?.deliveryProgress, {
    phase: "starting",
    label: "Starting delivery",
    detail: "Handing the room message to the agent.",
    sourceMessageId: "message_1",
    requestedLocally: false,
  });
  assert.equal(withTurn("responding")?.deliveryProgress, null, "the existing Now surface owns live model progress");
  assert.equal(withTurn("retrying")?.deliveryProgress?.phase, "recovering");
  assert.equal(withTurn("publishing")?.deliveryProgress?.phase, "publishing");
  assert.equal(projectAgentInspector(entry(), { roomId: "focus_1" })?.deliveryProgress, null);

  const respondingWhileReconnecting = entry({
    roomAgentState: {
      ...entry().roomAgentState!,
      ingress: { state: "backoff", observedAt: null, detail: "Gateway timeout" },
      turn: {
        state: "responding",
        inboxItemId: "inbox_message_1",
        sourceMessageId: "message_1",
        providerTurnId: "turn_1",
        detail: null,
      },
    },
  });
  assert.equal(
    projectAgentInspector(respondingWhileReconnecting, { roomId: "focus_1" })?.deliveryProgress?.phase,
    "responding",
    "delivery stays visible when another health axis owns the overall state",
  );
});

test("a pending retry remains projectable after the Inspector closes and reopens", () => {
  const blocked = entry({
    deliveryReceipts: [receipt("message_1", "blocked", {
      attemptCount: 0,
      providerTurnId: null,
      error: "Delivery failed",
    })],
    roomAgentState: {
      ...entry().roomAgentState!,
      inbox: { state: "blocked", pendingCount: 1, blockedByMessageId: "message_1", detail: "Delivery failed" },
      turn: { state: "failed", inboxItemId: "inbox_message_1", sourceMessageId: "message_1", providerTurnId: null, detail: "Delivery failed" },
    },
  });
  const options = {
    roomId: "focus_1",
    deliveryRetryingKeys: new Set(["supervised_1:message_1"]),
  };
  const beforeClose = projectAgentInspector(blocked, options);
  const afterReopen = projectAgentInspector(blocked, options);

  assert.deepEqual(afterReopen?.deliveryProgress, beforeClose?.deliveryProgress);
  assert.deepEqual(afterReopen?.deliveryProgress, {
    phase: "starting",
    label: "Retrying delivery",
    detail: "Checking the blocked message and safely resuming its delivery.",
    sourceMessageId: "message_1",
    requestedLocally: true,
  });
});

test("turn control is available only for the exact responding provider turn", () => {
  const responding = entry({
    roomAgentState: {
      ...entry().roomAgentState!,
      turn: { state: "responding", inboxItemId: "inbox_1", sourceMessageId: "message_1", providerTurnId: "turn_1", detail: null },
    },
  });
  const control = projectAgentInspectorTurnControl(responding);
  assert.ok(control);
  assert.equal(control.status, "ready");
  assert.equal(control.canStop, true);
  assert.equal(control.canCorrect, true);
  assert.equal(projectAgentInspector(responding, { roomId: "focus_1" })?.actions.find((action) => action.kind === "stop_turn")?.available, true);

  const openModelControl = projectAgentInspectorTurnControl({
    ...responding,
    provider: "open-model",
  });
  assert.equal(openModelControl?.capability, "native_interrupt");
  assert.equal(openModelControl?.canStop, true);
  assert.equal(openModelControl?.canCorrect, true);

  const uncheckpointed = projectAgentInspectorTurnControl(entry({
    roomAgentState: {
      ...entry().roomAgentState!,
      turn: { state: "responding", inboxItemId: "inbox_1", sourceMessageId: "message_1", providerTurnId: null, detail: null },
    },
  }));
  assert.ok(uncheckpointed);
  assert.equal(uncheckpointed.canStop, false, "a turn without its provider checkpoint cannot be interrupted");
  assert.equal(uncheckpointed.canCorrect, false);
});

test("an uncertain durable control gates new actions until a verified outcome is recorded", () => {
  const uncertain = entry({
    turnControl: {
      actionId: "control_1",
      workAttemptId: "attempt_1",
      executionGenerationId: "generation_1",
      hasCorrection: true,
      status: "uncertain",
      capability: "native_interrupt",
      interrupted: null,
      resumed: null,
      state: null,
      stages: ["delivered"],
      error: "The provider connection closed before confirming the result.",
      recordedAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:00:01.000Z",
    },
  });
  const control = projectAgentInspectorTurnControl(uncertain);
  assert.ok(control);
  assert.equal(control.status, "uncertain");
  assert.equal(control.canStop, false);
  assert.equal(control.canCorrect, false);
  assert.equal(control.canResolve, true);

  const staleJournal = projectAgentInspectorTurnControl(entry({
    turnControl: { ...uncertain.turnControl!, executionGenerationId: "generation_old" },
  }));
  assert.ok(staleJournal);
  assert.equal(staleJournal.canResolve, false, "the operator cannot settle an outcome for a different generation");
});

test("turn-control completions are fenced to exact agent, room, work, generation, daemon, and provider turn", () => {
  const current = entry({
    roomAgentState: {
      ...entry().roomAgentState!,
      turn: { state: "responding", inboxItemId: "inbox_1", sourceMessageId: "message_1", providerTurnId: "turn_1", detail: null },
    },
  });
  const fence = {
    entryId: "supervised_1",
    roomId: "focus_1",
    workAttemptId: "attempt_1",
    executionGenerationId: "generation_1",
    providerTurnId: "turn_1",
    inboxItemId: "inbox_1",
    sourceMessageId: "message_1",
    daemonGeneration: 7,
  };
  assert.equal(agentInspectorTurnControlFenceMatches(fence, current, 7), true);
  assert.equal(agentInspectorTurnControlFenceMatches(fence, entry({ roomId: "other_room" }), 7), false);
  assert.equal(agentInspectorTurnControlFenceMatches(fence, entry({ workAttemptId: "attempt_2" }), 7), false);
  assert.equal(agentInspectorTurnControlFenceMatches(fence, entry({ executionGenerationId: "generation_2" }), 7), false);
  assert.equal(agentInspectorTurnControlFenceMatches(fence, current, 8), false);
  assert.equal(agentInspectorTurnControlFenceMatches(fence, entry({
    roomAgentState: { ...current.roomAgentState!, turn: { ...current.roomAgentState!.turn, providerTurnId: "turn_2" } },
  }), 7), false);
  assert.equal(agentInspectorTurnControlFenceMatches(fence, entry({
    roomAgentState: { ...current.roomAgentState!, turn: { ...current.roomAgentState!.turn, providerTurnId: null } },
  }), 7), false, "a new responding turn without a checkpoint must not inherit the old turn's control request");
  assert.equal(agentInspectorTurnControlFenceMatches(fence, entry({
    roomAgentState: { ...current.roomAgentState!, turn: { state: "failed", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null } },
  }), 7), false, "a missing checkpoint is only a completion proof for a genuinely idle turn");
  assert.equal(agentInspectorTurnControlFenceMatches(fence, entry({
    roomAgentState: { ...current.roomAgentState!, turn: { ...current.roomAgentState!.turn, inboxItemId: "inbox_2", sourceMessageId: "message_2" } },
  }), 7), false, "a matching provider turn id still cannot cross a different causal room item");
  assert.equal(agentInspectorTurnControlFenceMatches(fence, entry({
    roomAgentState: { ...current.roomAgentState!, turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null } },
  }), 7), true, "a stop is allowed to leave the same session idle");
});

test("lost Inspector control responses retry the same exact durable action id", async () => {
  const base = {
    entryId: "supervised_1",
    roomId: "focus_1",
    workAttemptId: "attempt_1",
    executionGenerationId: "generation_1",
    providerTurnId: "turn_1",
    inboxItemId: "inbox_1",
    sourceMessageId: "message_1",
    correction: "Use the smaller dataset.",
  };
  const first = await agentInspectorTurnControlActionId(base);
  const retryAfterLostResponse = await agentInspectorTurnControlActionId({ ...base });
  assert.equal(first, retryAfterLostResponse, "a retry reaches the existing durable journal action, not a second native effect");
  assert.notEqual(first, await agentInspectorTurnControlActionId({ ...base, correction: "Use the full dataset." }));
  assert.notEqual(first, await agentInspectorTurnControlActionId({ ...base, providerTurnId: "turn_2" }));
  assert.notEqual(first, await agentInspectorTurnControlActionId({ ...base, executionGenerationId: "generation_2" }));
  assert.notEqual(first, await agentInspectorTurnControlActionId({ ...base, sourceMessageId: "message_2", inboxItemId: "inbox_2" }));
});

test("a supervisor push advancing the turn while the action digest yields prevents the native IPC effect", async () => {
  let resolveDigest: (value: string) => void = () => undefined;
  const deferredDigest = new Promise<string>((resolve) => { resolveDigest = resolve; });
  const fence = {
    entryId: "supervised_1",
    roomId: "focus_1",
    workAttemptId: "attempt_1",
    executionGenerationId: "generation_1",
    providerTurnId: "turn_1",
    inboxItemId: "inbox_1",
    sourceMessageId: "message_1",
    daemonGeneration: 7,
  };
  let supervisorPushedEntry = entry({
    roomAgentState: {
      ...entry().roomAgentState!,
      turn: { state: "responding", inboxItemId: "inbox_1", sourceMessageId: "message_1", providerTurnId: "turn_1", detail: null },
    },
  });
  let actionState: AgentInspectorActionState | null = {
    operationId: "operation_1",
    entryId: "supervised_1",
    kind: "stop_turn" as const,
    status: "running" as const,
    message: "Stopping the current turn…",
  };
  const submitted: string[] = [];
  const pendingActionId = agentInspectorTurnControlActionIdIfCurrent(
    deferredDigest,
    () => agentInspectorTurnControlFenceMatches(fence, supervisorPushedEntry, 7),
  )
    .then((actionId) => {
      if (actionId) submitted.push(actionId);
      return actionId;
    });

  // This mirrors a supervisor push: the selected entry advances while the
  // asynchronous WebCrypto digest is unresolved.
  supervisorPushedEntry = entry({
    roomAgentState: {
      ...supervisorPushedEntry.roomAgentState!,
      turn: { state: "responding", inboxItemId: "inbox_2", sourceMessageId: "message_2", providerTurnId: "turn_2", detail: null },
    },
  });
  resolveDigest("inspector-turn:deferred");

  assert.equal(await pendingActionId, null);
  actionState = clearAgentInspectorActionStateIfMatching(actionState, "operation_1");
  assert.deepEqual(submitted, [], "the stale action must not reach controlTurn IPC");
  assert.equal(actionState, null, "the rejected operation must not strand the Inspector in a running state");
  assert.equal(agentInspectorActionStateForEntry(actionState, "supervised_1")?.status === "running", false, "turn controls are re-enabled once the stale action is discarded");
});

test("Activity suppresses only exact supervised identity, including a sessionless entry", () => {
  const identity = supervisedActivityIdentity([
    entry({ id: "supervised_one", agentKey: "emmymay/gardensignal", agentSessionId: "session_historical", agentSessionBindingState: "historical" }),
    entry({ id: "supervised_two", agentKey: "emmymay/mapleridge", agentSessionId: null, agentSessionBindingState: "none" }),
    entry({ id: "other_room", roomId: "other_room", agentKey: "emmymay/other", agentSessionId: "session_other" }),
  ], "focus_1");

  assert.equal(isProjectedSupervisedActivityParticipant(identity, {
    key: "desktop-supervisor-agent:supervised_two",
    agentKey: null,
    agentSessionId: null,
  }), true, "the canonical supervisor participant key suppresses a sessionless supervised agent");
  assert.equal(isProjectedSupervisedActivityParticipant(identity, {
    key: "agent:session_historical",
    agentKey: null,
    agentSessionId: "session_historical",
  }), true, "the retained historical binding suppresses a stale presence echo");
  assert.equal(isProjectedSupervisedActivityParticipant(identity, {
    key: "agent:another-session",
    agentKey: "emmymay/gardensignal",
    agentSessionId: "another-session",
  }), true, "the exact canonical agent key is sufficient when presence rotates its session");
  assert.equal(isProjectedSupervisedActivityParticipant(identity, {
    key: "agent:unrelated",
    agentKey: "another/gardensignal",
    agentSessionId: "unrelated",
  }), false, "same display labels never suppress an unrelated agent");
  assert.equal(isProjectedSupervisedActivityParticipant(identity, {
    key: "agent:session_other",
    agentKey: "emmymay/other",
    agentSessionId: "session_other",
  }), false, "a supervisor entry from another room cannot suppress this room's roster");
});

test("Assigned work excludes terminal historical assignments while retaining exact active work", () => {
  const activeLease = {
    id: "lease_1",
    kind: "work",
    holderLabel: "GardenSignal",
    agentKey: "emmymay/gardensignal",
    agentSessionId: "session_1",
    status: "active",
    updatedAt: null,
  };
  const activeEntry = entry({
    roomAgentState: {
      ...entry().roomAgentState!,
      task: { state: "working", taskId: "explicit", title: "Explicit" },
    },
  });
  const projection = projectAgentInspector(activeEntry, {
    roomId: "focus_1",
    tasks: [
      task("done", "done"),
      task("cancelled", "cancelled"),
      task("assigned", "in_progress"),
      task("leased", "done", { assigneeAgentKey: null, activeLeases: [activeLease] }),
      task("explicit", "done", { assigneeAgentKey: null }),
    ],
  });
  assert.deepEqual(projection?.assignedWork.map((candidate) => candidate.id), ["assigned", "leased", "explicit"]);
});

test("stale resources preserve last-good facts but disable state-dependent actions", () => {
  const blocked = entry({ deliveryReceipts: [receipt("message_1", "blocked")] });
  const mentionMap = new Map([[blocked.id, "agent:emmymay/gardensignal"]]);
  const fresh = projectAgentInspector(blocked, { roomId: "focus_1", deliveryRetryAvailable: true, mentionInsertTextByEntryId: mentionMap });
  assert.equal(fresh?.actions.find((action) => action.kind === "retry_delivery")?.available, true);

  const ambiguous = projectAgentInspector(entry({
    deliveryReceipts: [receipt("message_1", "blocked"), receipt("message_2", "blocked")],
  }), { roomId: "focus_1", deliveryRetryAvailable: true });
  assert.equal(ambiguous?.actions.find((action) => action.kind === "retry_delivery")?.available, false);

  const stale = projectAgentInspector(blocked, {
    roomId: "focus_1",
    deliveryRetryAvailable: true,
    resourceFreshness: "stale",
    mentionInsertTextByEntryId: mentionMap,
  });
  assert.equal(stale?.resourceFreshness, "stale");
  assert.equal(stale?.actions.find((action) => action.kind === "mention")?.available, true);
  assert.equal(stale?.actions.find((action) => action.kind === "pause")?.available, false);
  assert.equal(stale?.actions.find((action) => action.kind === "retry_delivery")?.available, false);

  const active = entry({
    roomAgentState: {
      ...entry().roomAgentState!,
      turn: { state: "responding", inboxItemId: "inbox_1", sourceMessageId: "message_1", providerTurnId: "turn_1", detail: null },
    },
  });
  const staleActive = projectAgentInspector(active, { roomId: "focus_1", resourceFreshness: "stale" });
  assert.equal(staleActive?.turnControl?.canStop, false);
  assert.equal(staleActive?.turnControl?.canCorrect, false);
  assert.match(staleActive?.turnControl?.detail ?? "", /Live supervisor state/);
});

test("missing-conversation recovery is actionable only before a provider turn starts", () => {
  const missing = receipt("message_missing", "blocked", {
    attemptCount: 0,
    providerTurnId: null,
    failureCode: "provider_continuation_missing",
    error: "The saved provider conversation is unavailable.",
  });
  const recoverable = projectAgentInspector(entry({ deliveryReceipts: [missing] }), {
    roomId: "focus_1",
    continuationRepairAvailable: true,
    roomDeliverySkipAvailable: true,
  });
  assert.equal(recoverable?.continuationRecovery?.state, "failed");
  assert.equal(recoverable?.continuationRecovery?.canRestore, true);
  assert.equal(recoverable?.continuationRecovery?.canSkip, true);
  assert.equal(recoverable?.actions.find((action) => action.kind === "restore_conversation")?.sourceMessageId, "message_missing");

  const restoring = projectAgentInspector(entry({
    roomAgentState: {
      ...entry().roomAgentState!,
      inbox: { state: "restoring_conversation", pendingCount: 1, blockedByMessageId: "message_missing", detail: null },
      turn: { state: "idle", inboxItemId: missing.inboxItemId, sourceMessageId: missing.sourceMessageId, providerTurnId: null, detail: null },
    },
    deliveryReceipts: [{ ...missing, state: "restoring_conversation" }],
  }), {
    roomId: "focus_1",
    continuationRepairAvailable: true,
    roomDeliverySkipAvailable: true,
  });
  assert.equal(restoring?.overallLabel, "Restoring conversation");
  assert.equal(restoring?.continuationRecovery?.state, "restoring");
  assert.equal(restoring?.continuationRecovery?.canRestore, false);
  assert.equal(restoring?.continuationRecovery?.canSkip, false);

  const ambiguous = projectAgentInspector(entry({
    deliveryReceipts: [{ ...missing, attemptCount: 1, providerTurnId: "turn_started" }],
  }), {
    roomId: "focus_1",
    continuationRepairAvailable: true,
    roomDeliverySkipAvailable: true,
  });
  assert.equal(ambiguous?.continuationRecovery?.canRestore, false, "started provider work cannot enter the replacement-conversation lane");
  assert.equal(ambiguous?.continuationRecovery?.canSkip, false, "started provider work can never be silently released");
});

test("the shell resource folds exact pushes and preserves capped activity across polls", () => {
  const first = entry({ activity: Array.from({ length: SUPERVISOR_ACTIVITY_CAP }, (_, index) => activity(index + 1)) });
  const other = entry({ id: "supervised_2", activity: [] });
  const pushed = foldSupervisorActivityPush([first, other], "focus_1", { entryId: first.id, event: activity(201) });
  assert.equal(pushed[0]?.activity.length, SUPERVISOR_ACTIVITY_CAP);
  assert.equal(pushed[0]?.activity[0]?.sequence, 2);
  assert.equal(pushed[1], other);
  assert.equal(foldSupervisorActivityPush(pushed, "focus_1", { entryId: first.id, event: activity(201) }), pushed);
  assert.equal(foldSupervisorActivityPush(pushed, "another_room", { entryId: first.id, event: activity(202) }), pushed);
  assert.equal(foldSupervisorActivityPush(pushed, "focus_1", { entryId: "missing", event: activity(202) }), pushed);

  const outOfOrder = foldSupervisorActivityPush(
    [entry({ activity: [activity(3)] })],
    "focus_1",
    { entryId: first.id, event: activity(2) },
  );
  assert.deepEqual(outOfOrder[0]?.activity.map((event) => event.sequence), [2, 3]);

  const merged = mergeSupervisorEntriesPoll(pushed, [entry({ activity: [activity(150)] })], "focus_1");
  assert.equal(merged[0]?.activity.at(-1)?.sequence, 201);
  assert.equal(new Set(merged[0]?.activity.map((event) => event.sequence)).size, merged[0]?.activity.length);
});

test("an activity push arriving during a poll survives the authoritative poll snapshot", () => {
  const beforePoll = entry({ providerPid: 123, activity: [activity(10)] });
  const afterPush = foldSupervisorActivityPush(
    [beforePoll],
    "focus_1",
    { entryId: beforePoll.id, event: activity(12) },
  );
  const afterPoll = mergeSupervisorEntriesPoll(
    afterPush,
    [entry({ providerPid: 456, activity: [activity(10), activity(11)] })],
    "focus_1",
  );
  assert.equal(afterPoll[0]?.providerPid, 456, "poll remains authoritative for non-activity fields");
  assert.deepEqual(afterPoll[0]?.activity.map((event) => event.sequence), [10, 11, 12]);
});

test("retained supervisor data stays fresh during reconciliation", () => {
  assert.equal(supervisorEntriesResourceFreshness("loading"), "stale");
  assert.equal(supervisorEntriesResourceFreshness("refreshing"), "fresh");
  assert.equal(supervisorEntriesResourceFreshness("ready"), "fresh");
  assert.equal(supervisorEntriesResourceFreshness("error"), "stale");
});

test("a registered state subscription still falls back to repair polling when snapshots stop", () => {
  assert.equal(supervisorStateSubscriptionNeedsRepair({
    active: false,
    lastSnapshotAtMs: null,
    nowMs: 100_000,
  }), true);
  assert.equal(supervisorStateSubscriptionNeedsRepair({
    active: true,
    lastSnapshotAtMs: null,
    nowMs: 100_000,
  }), true, "registration alone is not proof that state is flowing");
  assert.equal(supervisorStateSubscriptionNeedsRepair({
    active: true,
    lastSnapshotAtMs: 50_000,
    nowMs: 100_000,
    staleAfterMs: 60_000,
  }), false);
  assert.equal(supervisorStateSubscriptionNeedsRepair({
    active: true,
    lastSnapshotAtMs: 40_000,
    nowMs: 100_000,
    staleAfterMs: 60_000,
  }), true);
});

test("switching agents hides the previous action and fences its late completion", () => {
  const action = {
    operationId: "operation_a",
    entryId: "supervised_a",
    kind: "pause" as const,
    status: "running" as const,
    message: "Pausing this agent…",
  };
  assert.equal(agentInspectorActionStateForEntry(action, "supervised_a"), action);
  assert.equal(agentInspectorActionStateForEntry(action, "supervised_b"), null);
  assert.equal(isCurrentAgentInspectorSupervisorUpdate({
    entry: entry({ id: "supervised_a" }),
    roomIdentifier: "focus_1",
    inspectorRequestVersion: 4,
  }, "focus_1", 5), false);
});

test("duplicate supervised names resolve to exact canonical agent mentions", () => {
  const participant = (
    participantKey: string,
    agentKey: string,
  ): DesktopParticipantSummary => ({
    participantKey,
    kind: "agent",
    displayName: "GardenSignal",
    actorLabel: null,
    agentKey,
    githubLogin: null,
    ownerLabel: "EmmyMay",
    ideLabel: "Codex",
    hiddenAt: null,
    activityState: "active",
    lastSeenAt: "2026-07-23T10:00:00.000Z",
    lastRoomActivityAt: null,
    lastLiveHeartbeatAt: null,
    sourceFlags: ["delivery"],
  });
  const candidates = roomMentionCandidates([
    participant("desktop-supervisor-agent:one", "emmymay/gardensignal"),
    participant("desktop-supervisor-agent:two", "another/gardensignal"),
  ], "GardenSignal", 6);
  assert.deepEqual(candidates.map((candidate) => candidate.insertText), [
    "agent:emmymay/gardensignal",
    "agent:another/gardensignal",
  ]);
});
