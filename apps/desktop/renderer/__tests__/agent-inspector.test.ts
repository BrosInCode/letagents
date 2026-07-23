import assert from "node:assert/strict";
import test from "node:test";

import {
  agentInspectorActionStateForEntry,
  agentInspectorOverallState,
  projectAgentInspector,
} from "../src/domain/agent-inspector";
import { projectAgentInspectorsWhenEnabled } from "../src/domain/agent-inspector-feature";
import { isCurrentAgentInspectorSupervisorUpdate } from "../src/domain/agent-inspector-identity";
import {
  foldSupervisorActivityPush,
  mergeSupervisorEntriesPoll,
  SUPERVISOR_ACTIVITY_CAP,
} from "../src/domain/supervisor-entries-resource";
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
    state,
    attemptCount: 1,
    providerTurnId: "turn_1",
    blockedByMessageId: null,
    error: null,
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

test("the disabled foundation does not evaluate its new projection", () => {
  const throwingOptions = Object.defineProperty({}, "roomId", {
    get(): never { throw new Error("projection evaluated while disabled"); },
  });
  assert.deepEqual(projectAgentInspectorsWhenEnabled(
    false,
    [entry()],
    throwingOptions as Parameters<typeof projectAgentInspectorsWhenEnabled>[2],
  ), []);
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
