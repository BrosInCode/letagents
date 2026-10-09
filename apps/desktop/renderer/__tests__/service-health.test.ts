import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopSupervisorManifestEntry, DesktopSupervisorServiceSnapshot } from "../../electron/ipc-types";
import type { DesktopHostApproval } from "../../shared/host-approvals";
import { projectServiceHealth, SERVICE_HEALTH_EVENT_LIMIT, updateServiceEvents } from "../src/domain/service-health";

function entry(id: string, overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return { id, roomId: "room_a", displayName: id, provider: "codex", model: null, charter: "",
    desiredState: "running", observedState: "idle", condition: "none", permissionProfileId: null,
    deliveryMode: "daemon_inbox", createdBy: "owner", createdAt: "2026-10-09T10:00:00Z",
    workspacePath: null, workAttemptId: null, agentSessionId: null, agentSessionBindingState: "none",
    bindingUpdatedAt: "2026-10-09T12:00:00Z", executionGenerationId: null, providerContinuationId: null,
    providerPid: null, workplaceLiveness: { state: "unknown", observedAt: null, detail: null },
    nativeLiveness: { state: "unknown", observedAt: null, detail: null }, restartCount: 0,
    lastTerminal: null, activity: [], lastTurnControlSequence: 0, turnControl: null,
    roomAgentState: { connection: { state: "connected", observedAt: null, detail: null },
      ingress: { state: "observing", observedAt: null, detail: null },
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null } }, ...overrides };
}
function snapshot(entries: DesktopSupervisorManifestEntry[] = []): DesktopSupervisorServiceSnapshot {
  return { observedAt: "2026-10-09T12:00:00Z", status: { healthy: true, protocolVersion: 1,
    implementationVersion: "test-version", generation: 1, pid: 12, startedAt: "2026-10-09T11:00:00Z",
    recoveryDiagnostics: null, capabilities: { roomDeliveryRetry: false, providerContinuationRepair: false,
      roomDeliverySkip: false, agentInspectorDetail: true, agentInspectorSettings: true, agentRoomMove: true,
      agentLifecycle: true, agentStateSubscription: true } }, state: { daemonGeneration: 1, sequence: 1, entries } };
}

test("health counts every room including paused and stopped agents and surfaces owner attention first", () => {
  const entries = Array.from({ length: 205 }, (_, index) => entry(`agent_${index}`, {
    roomId: index % 2 ? "room_b" : "room_a", desiredState: index < 36 ? "running" : index < 66 ? "paused" : "stopped",
    observedState: index < 36 ? "idle" : index < 66 ? "paused" : "stopped",
  }));
  entries[12]!.observedState = "failed";
  entries[12]!.lastError = "Provider exited. token=private-token";
  const health = projectServiceHealth(snapshot(entries), { roomNames: new Map([["room_b", "Second room"]]) });
  assert.deepEqual(health.counts, { total: 205, running: 36, paused: 30, stopped: 139, needsAttention: 1 });
  assert.equal(health.agents[0]?.entryId, "agent_12");
  assert.equal(health.agents.find(agent => agent.entryId === "agent_1")?.roomName, "Second room");
  assert.equal(health.agents[0]?.detail, "Provider exited. token=[REDACTED]");
  assert.equal(health.agents[0]?.lastActivityAt, null, "binding refresh is not agent activity");
  assert.equal(health.agents[0]?.approvalsWaiting, null, "unread approvals are not zero approvals");
});

test("health shows pending messages, unique current approvals, and retained activity without payloads", () => {
  const busy = entry("busy");
  busy.roomAgentState!.inbox.pendingCount = 3;
  busy.activity.push({ observedAt: "2026-10-09T11:30:00Z", sequence: 1, provider: "codex",
    kind: "notification", method: "turn/complete", summary: "Finished", status: "idle",
    payload: { secret: "do-not-copy" }, payloadRedacted: false, payloadTruncated: false, durablePayloadRef: "private" });
  const approved = entry("approved");
  const approval: DesktopHostApproval = { id: "approval", requestKey: "request", status: "pending",
    detail: null, dismissKey: null, retryDecision: null,
    presentation: { agentId: approved.id, displayName: approved.displayName, provider: "codex",
      title: "Run a command", details: "private command", denyScope: "request" } };
  const health = projectServiceHealth(snapshot([busy, approved]), {
    approvals: [approval, { ...approval, id: "re-presented" }, { ...approval, requestKey: "resolved", status: "resolved" }],
    approvalRooms: new Set(["room_a"]),
  });
  assert.equal(health.agents[0]?.entryId, approved.id);
  assert.equal(health.agents[0]?.approvalsWaiting, 1);
  assert.equal(health.agents[1]?.messagesWaiting, 3);
  assert.equal(health.agents[1]?.lastActivityAt, "2026-10-09T11:30:00Z");
  assert.doesNotMatch(JSON.stringify(health), /do-not-copy|private command|durablePayloadRef/);
  assert.equal(projectServiceHealth(snapshot([entry("unknown", { roomId: "room_b", roomAgentState: null })]),
    { approvals: [], approvalRooms: new Set(["room_a"]) }).agents[0]?.approvalsWaiting, null);
  assert.equal(projectServiceHealth(snapshot([entry("unknown", { roomAgentState: null })])).agents[0]?.messagesWaiting, null);
});

test("recovery is a current observed count, not invented restart completion progress", () => {
  const health = projectServiceHealth(snapshot([
    entry("recovering", { observedState: "recovering" }), entry("working", { observedState: "working" }),
    entry("starting", { observedState: "starting" }), entry("paused", { desiredState: "paused", observedState: "recovering" }),
  ]));
  assert.equal(health.service.recoveryLabel, "1 of 3 running agents is recovering.");
  assert.equal(projectServiceHealth(snapshot([entry("working")])).service.recoveryLabel, null);
});

test("unavailable and mismatched snapshots never claim an empty or current fleet", () => {
  const observation = snapshot([entry("old")]);
  observation.state!.daemonGeneration = 2;
  assert.equal(projectServiceHealth(observation).counts, null);
  observation.status = null;
  assert.deepEqual(projectServiceHealth(observation), { service: {
    stateLabel: "Not connected", version: null, startedAt: null, recoveryLabel: null,
  }, counts: null, agents: [] });
  assert.equal(projectServiceHealth(snapshot()).counts?.total, 0, "a confirmed empty fleet remains distinguishable");
});

test("service events report starts and observed connection changes, stay bounded, and ignore agent payloads", () => {
  const first = snapshot();
  let events = updateServiceEvents(null, first);
  assert.equal(events[0]?.summary, "Background service started.");
  assert.deepEqual(updateServiceEvents(first, first, events), events, "heartbeats do not duplicate events");
  const restarted = snapshot();
  restarted.status!.generation = 2;
  restarted.status!.startedAt = "2026-10-09T11:59:00Z";
  events = updateServiceEvents(first, restarted, events);
  assert.equal(events[0]?.summary, "Background service restarted.");
  const offline = { ...restarted, status: null, state: null, observedAt: "2026-10-09T12:01:00Z" };
  events = updateServiceEvents(restarted, offline, events);
  assert.equal(events[0]?.summary, "Lost contact with the background service.");
  const reconnected = { ...restarted, observedAt: "2026-10-09T12:02:00Z" };
  events = updateServiceEvents(offline, reconnected, events);
  assert.equal(events[0]?.summary, "Connected to the background service.");
  const many = Array.from({ length: 40 }, (_, index) => ({ id: String(index), observedAt: first.observedAt, summary: "Observed event" }));
  assert.equal(updateServiceEvents(first, first, many).length, SERVICE_HEALTH_EVENT_LIMIT);
});
