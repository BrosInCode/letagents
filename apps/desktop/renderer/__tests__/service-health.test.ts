import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopSupervisorManifestEntry, DesktopSupervisorServiceSnapshot } from "../../electron/ipc-types";
import type { DesktopHostApproval } from "../../shared/host-approvals";
import { projectServiceHealth, SERVICE_HEALTH_EVENT_LIMIT, updateServiceEvents } from "../src/domain/service-health";
import { filterSettingsAgents, settingsAgentRows, settingsAgentRooms } from "../src/domain/settings-agents";
import type { DesktopAccountRoomEntry, DesktopRoomLiveMetadata } from "../../electron/ipc-types";

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

test("Agents settings merges exact identities, filters joined rooms and preserves retired agents", () => {
  const rooms = settingsAgentRooms([
    { roomIdentifier: "room_a", name: "Main", displayName: "Main", archived: false, focusRooms: [
      { roomIdentifier: "room_b", name: "Design", displayName: "Design" },
    ] },
    { roomIdentifier: "archived", name: "Archived", displayName: "Archived", archived: true, focusRooms: [] },
  ] as DesktopAccountRoomEntry[]);
  assert.deepEqual(rooms.map(room => room.id), ["room_a", "room_b"]);
  const participants = [
    { participantKey: "local", kind: "agent", displayName: "Shared name", actorLabel: "local actor", agentKey: "owner/local", ideLabel: "Codex", hiddenAt: null },
    { participantKey: "external", kind: "agent", displayName: "Shared name", actorLabel: "remote actor", agentKey: "other/remote", ideLabel: "Cursor", hiddenAt: null, activityState: "active" },
    { participantKey: "retired-echo", kind: "agent", displayName: "Retired agent", actorLabel: "retired actor", agentKey: "owner/retired", ideLabel: "Codex", hiddenAt: null, activityState: "offline" },
    { participantKey: "paused-echo", kind: "agent", displayName: "Paused agent", actorLabel: "paused actor", agentKey: "owner/paused", ideLabel: "Codex", hiddenAt: null, activityState: "offline" },
    { participantKey: "human", kind: "human", displayName: "Human" },
    { participantKey: "hidden", kind: "agent", displayName: "Hidden", hiddenAt: "2026-11-03" },
  ];
  const input = { rooms, entries: [
    entry("local", { displayName: "Shared name", agentKey: "owner/local", charter: "Polish navigation" }),
    entry("paused", { roomId: "room_b", desiredState: "paused", observedState: "paused" }),
    entry("retired", { agentKey: "owner/retired", desiredState: "stopped", observedState: "stopped" }),
    entry("paused-local", { agentKey: "owner/paused", desiredState: "paused", observedState: "paused" }),
    entry("outside", { roomId: "not-joined" }),
  ], supervisorFresh: true, metadata: new Map([["room_a", { participants, presence: [] } as unknown as DesktopRoomLiveMetadata]]), staleRooms: new Set<string>(), approvals: [] };
  const rows = settingsAgentRows(input);
  assert.equal(rows.length, 5, "canonical identity deduplicates paused/retired echoes without presence; identical names do not merge external agents");
  assert.deepEqual(filterSettingsAgents(rows, "all", "room_b", "").map(row => row.id), ["paused"]);
  assert.deepEqual(filterSettingsAgents(rows, "all", "", "NAVIGATION").map(row => row.id), ["local"]);
  assert.deepEqual(filterSettingsAgents(rows, "retired", "", "").map(row => row.id), ["retired"]);
  assert.equal(filterSettingsAgents(rows, "all", "", "").length, 4);
  const external = filterSettingsAgents(rows, "external", "", "Cursor")[0]!;
  assert.equal(external.request.kind, "participant");
  assert.equal(external.request.target.agentKey, "other/remote");
  assert.equal(rows.find(row => row.id === "local")!.request.kind, "supervised");
  const stale = settingsAgentRows({ ...input, supervisorFresh: false, staleRooms: new Set(["room_a"]) });
  assert.equal(stale.find(row => row.id === "local")!.status, "Status unavailable");
  assert.equal(filterSettingsAgents(stale, "external", "", "").length, 0, "a service failure must not reclassify unknown agents as external");
});

test("Agents settings surfaces approval and recovery needs without exposing approval payloads", () => {
  const approval: DesktopHostApproval = { id: "approval", requestKey: "request", status: "pending", detail: null, dismissKey: null, retryDecision: null,
    presentation: { agentId: "waiting", displayName: "Waiting", provider: "codex", title: "Run", details: "private command", denyScope: "request" } };
  const rows = settingsAgentRows({ rooms: [{ id: "room_a", name: "Main" }], entries: [entry("idle"), entry("waiting"), entry("failed", { observedState: "failed" })],
    supervisorFresh: true, metadata: new Map(), staleRooms: new Set(), approvals: [approval, { ...approval, id: "echo" }] });
  assert.equal(rows.find(row => row.id === "waiting")!.approvals, 1);
  assert.equal(rows.find(row => row.id === "waiting")!.status, "Approval needed");
  assert.deepEqual(new Set(filterSettingsAgents(rows, "attention", "", "").map(row => row.id)), new Set(["failed", "waiting"]));
  assert.equal(rows.at(-1)!.id, "idle");
  assert.doesNotMatch(JSON.stringify(rows), /private command/);
});
