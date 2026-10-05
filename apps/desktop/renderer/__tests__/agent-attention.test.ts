import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, effectScope, nextTick, ref, type Ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
import { createKnowledgeRecord } from "../../../../shared/room-knowledge.mjs";
import type { DesktopBoardIntentSummary, DesktopRoomAgentDeliveryReceipt, DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import type { DesktopNeedsYou } from "../../electron/ipc-types/knowledge.js";
import type { DesktopHostApproval, HostApprovalSelection } from "../../shared/host-approvals";
import { AGENT_ATTENTION_GRACE_MS, BOARD_INTENT_ATTENTION_DELAY_MS, buildAgentAttentionItems, trackAgentAttention, type AgentAttentionItem } from "../src/components/desktop/content/room-inbox/agent-attention";
import { buildUniversalInbox, filterUniversalInbox, inboxCategoryLabel, inboxNavigationIntent } from "../src/components/desktop/content/room-inbox/universal";
import { HOST_APPROVAL_BLOCKED_GRACE_MS, hostApprovalStopsTurn } from "../src/components/desktop/content/room-chat/host-approval-presentation";
import { decideHostApproval, hostApprovalRoom, hostApprovalRooms, refreshHostApprovals, resetHostApprovals } from "../src/components/desktop/content/room-chat/host-approvals";
import { useAgentAttention } from "../src/composables/useAgentAttention";
import { useNeedsYouSignal } from "../src/composables/useNeedsYouSignal";

const NOW = Date.parse("2026-09-30T16:30:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function approval(overrides: Partial<DesktopHostApproval> = {}): DesktopHostApproval {
  return { id: "presentation-1", presentation: { agentId: "supervised_copper", displayName: "CopperRidge", provider: "open-model",
    title: "Run a command", details: JSON.stringify({ permission: "bash", patterns: ["pwd && git status"] }), denyScope: "session_pending",
    alwaysAllow: { agentId: "supervised_copper", accountId: "acct", projectId: "proj", projectName: "year-dots", sourceRepoPath: "/src/year-dots",
      canonicalSourcePath: "/src/year-dots", repository: "EmmyMay/year-dots", remoteUrl: "https://github.com/EmmyMay/year-dots.git",
      provider: "open-model", toolId: "bash", toolLabel: "Bash", policySha256: "sha" } },
    status: "pending", detail: null, retryDecision: null, dismissKey: null, ...overrides };
}

function receipt(sourceMessageId: string, state: DesktopRoomAgentDeliveryReceipt["state"], updatedAt: string): DesktopRoomAgentDeliveryReceipt {
  return { inboxItemId: `inbox_${sourceMessageId}`, sourceMessageId, fifoSequence: 1, replyClientMessageId: `reply_${sourceMessageId}`,
    canonicalMessageId: null, state, attemptCount: 1, providerTurnId: "turn_1", blockedByMessageId: null, error: null,
    failureCode: null, terminalReason: null, updatedAt, timeline: [] };
}

function agent(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_copper", roomId: "room-a", displayName: "CopperRidge", agentKey: "emmymay/copper", provider: "open-model",
    model: "deepseek", charter: "Build the app.", desiredState: "running", observedState: "working", condition: "none", lastError: null,
    permissionProfileId: null, deliveryMode: "daemon_inbox", createdBy: "EmmyMay", createdAt: at(3_600_000), workspacePath: "/tmp/copper",
    workAttemptId: "attempt_1", agentSessionId: "session_1", agentSessionBindingState: "active", bindingUpdatedAt: at(10_000),
    executionGenerationId: "generation_1", providerContinuationId: "continuation_1", providerPid: 123,
    workplaceLiveness: { state: "healthy", observedAt: at(10_000), detail: null },
    nativeLiveness: { state: "healthy", observedAt: at(10_000), detail: null },
    restartCount: 0, lastTerminal: null, activity: [],
    roomAgentState: {
      connection: { state: "connected", observedAt: at(10_000), detail: null },
      ingress: { state: "observing", observedAt: at(10_000), detail: null },
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    },
    deliveryReceipts: [], lastTurnControlSequence: 0, turnControl: null, ...overrides,
  };
}

function blockedAgent(blockedAt: string): DesktopSupervisorManifestEntry {
  const base = agent();
  return agent({
    roomAgentState: { ...base.roomAgentState!, inbox: { state: "blocked", pendingCount: 19, blockedByMessageId: "msg_38",
      detail: "The provider completed, but its final answer is still unreadable. The same turn was re-read and was not rerun." } },
    deliveryReceipts: [receipt("msg_12", "acknowledged", at(7_200_000)), receipt("msg_38", "blocked", blockedAt)],
  });
}

function intent(overrides: Partial<DesktopBoardIntentSummary> = {}): DesktopBoardIntentSummary {
  return { id: "bi_1", taskId: "task_7", actionType: "task_claim", status: "pending",
    proposerActorLabel: "SummitMisty | EmmyMay's agent | Cursor", payload: { task_id: "task_7" },
    createdAt: at(BOARD_INTENT_ATTENTION_DELAY_MS + 60_000), expiresAt: at(-86_400_000), ...overrides };
}

const record = createKnowledgeRecord("room-a", "attention", { client_id: "request-0001", category: "decision", title: "Promote me to Board Manager", body: "I need to accept tasks." }, { id: "worker", label: "SparrowOtter", kind: "agent" });
function needsYou(overrides: Partial<DesktopNeedsYou> = {}): DesktopNeedsYou {
  return { rooms: [{ roomIdentifier: "room-a", displayName: "fern-reef", records: [], tasks: [], truncated: false }],
    failures: [], limited: false, signedOut: false, cloudUnavailable: false, ...overrides };
}

function installApprovals(list: (room: string) => DesktopHostApproval[], decisions: Array<{ id: string; decision: HostApprovalSelection }> = []) {
  let reads = 0;
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    listHostApprovals: async (room: string) => { reads += 1; return { available: true, approvals: list(room), error: null }; },
    decideHostApproval: async (input: { id: string; decision: HostApprovalSelection }) => { decisions.push(input); return "decision_sent"; },
  } } } });
  return { reads: () => reads, decisions };
}

beforeEach(() => { resetHostApprovals(); });

/** The composable owns a clock; run it in a scope the test can stop. */
function withAttention<T>(data: Ref<DesktopNeedsYou | null>, run: (attention: ReturnType<typeof useAgentAttention>) => Promise<T> | T): Promise<T> {
  const scope = effectScope();
  const attention = scope.run(() => useAgentAttention(data))!;
  return (async () => { try { return await run(attention); } finally { scope.stop(); } })();
}
const responding = (overrides: Partial<DesktopSupervisorManifestEntry> = {}) => {
  const base = agent(overrides);
  return { ...base, roomAgentState: { ...base.roomAgentState!, turn: { ...base.roomAgentState!.turn, state: "responding" as const } } };
};

test("startup approvals stay silent even when the composer already started their listing", async () => {
  for (const composerStarted of [false, true]) {
    resetHostApprovals();
    const pending: Array<(value: { available: boolean; approvals: DesktopHostApproval[]; error: null }) => void> = [];
    Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
      listHostApprovals: () => new Promise(resolve => pending.push(resolve)),
    } } } });
    const current = ref<DesktopNeedsYou | null>(null);
    const scope = effectScope();
    let plays = 0;
    const { attention, signal } = scope.run(() => {
      const attention = useAgentAttention(current);
      const signal = useNeedsYouSignal(current, attention.items, {
        account: () => 'account', activeRoom: () => 'room-a', inboxRooms: () => null, ready: () => attention.approvalsReady.value,
      }, { play: () => { plays++; }, stop() {}, dispose() {} });
      return { attention, signal };
    })!;
    try {
      await attention.refreshApprovals();
      assert.equal(attention.approvalsReady.value, false, 'a coalesced request read cannot arm an empty startup snapshot');
      current.value = needsYou({ agents: [responding()] }); await nextTick();
      const composer = composerStarted ? refreshHostApprovals('room-a') : Promise.resolve();
      const startup = attention.refreshApprovals();
      await nextTick();
      assert.equal(pending.length, 1, 'both surfaces await the same listing');
      assert.equal(attention.approvalsReady.value, false);
      pending.shift()!({ available: true, approvals: [approval()], error: null });
      await Promise.all([startup, composer]); await nextTick();
      assert.equal(attention.approvalsReady.value, true);
      assert.deepEqual(signal.value, { count: 1, pulse: true });
      assert.equal(plays, 0, 'existing approvals arriving after the request baseline are silent');
      const fresh = attention.refreshApprovals();
      pending.shift()!({ available: true, approvals: [approval({ id: 'new-request' })], error: null });
      await fresh; await nextTick();
      assert.equal(plays, 1, 'a later new approval chimes');
      const oldAccount = attention.refreshApprovals();
      current.value = null; resetHostApprovals();
      pending.shift()!({ available: true, approvals: [approval()], error: null });
      await oldAccount; await nextTick();
      assert.equal(attention.approvalsReady.value, false, 'a stale account read cannot arm the new session');
    } finally { scope.stop(); }
  }
});

test("only live tool requests, stuck agents and long-waiting board requests need the owner", () => {
  const rooms = new Map([["room-a", { approvals: [
    approval(),
    approval({ id: "recorded", status: "decision_recorded", retryDecision: "deny" }),
    ...(["decision_sent", "uncertain", "unavailable", "resolved", "request_closed"] as const).map(status => approval({ id: status, status })),
  ], firstSeenAt: { "presentation-1": at(60_000), recorded: at(30_000) }, stale: false }]]);
  const paused = { ...blockedAgent(at(600_000)), id: "supervised_paused", desiredState: "paused" as const };
  const items = buildAgentAttentionItems({
    approvalRooms: rooms,
    agents: [blockedAgent(at(600_000)), { ...agent(), id: "supervised_online" }, paused, { ...blockedAgent(at(600_000)), id: "supervised_retired", desiredState: "stopped" }],
    rooms: [{ roomIdentifier: "room-a", boardIntents: [
      intent(),
      intent({ id: "bi_fresh", createdAt: at(BOARD_INTENT_ATTENTION_DELAY_MS - 60_000) }),
      intent({ id: "bi_expired", expiresAt: at(1_000) }),
      intent({ id: "bi_decided", status: "approved" }),
    ] }],
    nowMs: NOW,
  });
  assert.deepEqual(items.map(item => item.key), [
    JSON.stringify(["room-a", "approval", "presentation-1"]),
    JSON.stringify(["room-a", "approval", "recorded"]),
    JSON.stringify(["room-a", "agent", "supervised_copper"]),
    JSON.stringify(["room-a", "board-intent", "bi_1"]),
  ]);
  assert.equal(items[0].timestamp, at(60_000), "an approval is dated by when this desktop first listed it");
});

test("an Open Model request its agent waits on that cannot be decided here needs the owner after the grace", () => {
  const unanswerable = (id: string, changes: Partial<DesktopHostApproval> = {}) => approval({ id, status: "unavailable",
    detail: "This request cannot currently be matched to an active room turn. Decisions are disabled until it can be verified.",
    presentation: { ...approval().presentation, title: "Approval unavailable",
      details: JSON.stringify({ id: "per_1", sessionID: "ses_1", permission: "edit", patterns: ["src/app.mjs"], metadata: {}, always: [] }) },
    ...changes });
  const blocking = unanswerable("blocking");
  const record = unanswerable("record", { dismissKey: "record-key" });
  const observer = unanswerable("observer", { presentation: { ...blocking.presentation,
    details: "Pending approval requests cannot currently be checked for this agent." } });
  const codex = unanswerable("codex", { presentation: { ...blocking.presentation, provider: "codex", denyScope: "request",
    details: JSON.stringify({ method: "item/fileChange/requestApproval", params: {} }) } });
  const rooms = (seenAt: string) => new Map([["room-a", { approvals: [blocking, record, observer, codex],
    firstSeenAt: { blocking: seenAt, record: seenAt, observer: seenAt, codex: seenAt }, stale: false }]]);

  assert.deepEqual(buildAgentAttentionItems({ approvalRooms: rooms(at(HOST_APPROVAL_BLOCKED_GRACE_MS - 5_000)), nowMs: NOW }), [],
    "a request matched to its turn within the grace never reaches the Inbox");
  const items = buildAgentAttentionItems({ approvalRooms: rooms(at(HOST_APPROVAL_BLOCKED_GRACE_MS)), nowMs: NOW });
  assert.deepEqual(items.map(item => item.key), [JSON.stringify(["room-a", "approval", "blocking"])]);
  const [inboxItem] = filterUniversalInbox(buildUniversalInbox(needsYou(), [], items), "needs-you", [], {});
  assert.equal(inboxItem.title, "CopperRidge · Approval unavailable");
  assert.deepEqual(inboxNavigationIntent(inboxItem, "room"), { roomIdentifier: "room-a", approvals: true },
    "it opens the room's approval card, which offers to stop the turn");

  // Stopping the agent's turn cancels the request only in the session it waits in.
  const seen = at(HOST_APPROVAL_BLOCKED_GRACE_MS);
  assert.equal(hostApprovalStopsTurn(blocking, seen, NOW, "ses_1"), true);
  assert.equal(hostApprovalStopsTurn(blocking, seen, NOW, "ses_after_repair"), false, "the agent moved to another session");
  assert.equal(hostApprovalStopsTurn(blocking, seen, NOW, null), false);
  assert.equal(hostApprovalStopsTurn(blocking, at(HOST_APPROVAL_BLOCKED_GRACE_MS - 5_000), NOW, "ses_1"), false, "still within the grace");
  assert.equal(hostApprovalStopsTurn(record, seen, NOW, "ses_1"), false, "a durable record stops nothing");
});

test("a stuck agent waits out a brief recovery, and a blocked queue is dated by the message that stopped it", () => {
  const coordinationBlocked = agent({ condition: "coordination_blocked" });
  const firstSeen = { supervised_copper: at(AGENT_ATTENTION_GRACE_MS - 5_000) };
  assert.equal(buildAgentAttentionItems({ agents: [coordinationBlocked], agentFirstSeenAt: firstSeen, nowMs: NOW }).length, 0,
    "a state that clears within one refresh never reaches the Inbox");
  assert.equal(buildAgentAttentionItems({ agents: [coordinationBlocked], agentFirstSeenAt: { supervised_copper: at(AGENT_ATTENTION_GRACE_MS) }, nowMs: NOW }).length, 1);

  const [stuck] = buildAgentAttentionItems({ agents: [blockedAgent(at(1_800_000))], agentFirstSeenAt: {}, nowMs: NOW });
  assert.equal(stuck.kind, "agent_attention");
  assert.equal(stuck.timestamp, at(1_800_000), "the blocked receipt, not the agent's live heartbeat, dates the item");
  const [inboxItem] = filterUniversalInbox(buildUniversalInbox(needsYou(), [], [stuck]), "needs-you", [], {});
  assert.equal(inboxItem.title, "CopperRidge · Needs attention");
  assert.match(inboxItem.body, /final answer is still unreadable/);
  assert.equal(inboxCategoryLabel(inboxItem.category), "Stuck agent");
});

test("Needs you counts an approval once when the chat composer lists it too, and a decision in the Inbox clears both", async () => {
  const listed = [approval()];
  const ipc = installApprovals(room => (room === "room-a" ? listed : []));
  const data = ref<DesktopNeedsYou | null>(needsYou({ agents: [agent()] }));
  await withAttention(data, async (attention) => {
  // The open room's composer and the Inbox poll both list the same presentation.
  await refreshHostApprovals("room-a");
  await attention.refreshApprovals();
  assert.equal(ipc.reads(), 2);
  assert.equal(attention.items.value.length, 1);
  assert.equal(attention.countForRoom("room-a"), 1);
  assert.equal(attention.countForRoom("room-b"), 0);
  const inbox = buildUniversalInbox(data.value, [], attention.items.value);
  assert.equal(filterUniversalInbox(inbox, "needs-you", [], {}).length, 1);
  assert.equal(filterUniversalInbox(inbox, "needs-you", ["room-b"], {}).length, 0);
  assert.equal(filterUniversalInbox(inbox, "needs-you", [], {})[0].title, "CopperRidge · Run a command");

  await decideHostApproval("room-a", "presentation-1", "allow_once");
  assert.deepEqual(ipc.decisions, [{ id: "presentation-1", decision: "allow_once" }]);
  assert.equal(hostApprovalRoom("room-a").approvals[0].status, "decision_sent", "the composer card reads the same decided record");
  assert.equal(attention.items.value.length, 0);
  assert.equal(attention.countForRoom("room-a"), 0);
  });
});

test("the Inbox re-lists only rooms with an agent mid-turn or an approval still showing, four at a time", async () => {
  const seen: string[] = [];
  let open = 0; let peak = 0;
  let oldRoomAsking = true;
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    listHostApprovals: async (room: string) => {
      seen.push(room); open += 1; peak = Math.max(peak, open);
      await new Promise(resolve => setImmediate(resolve));
      open -= 1;
      return { available: true, approvals: room.startsWith("room-old") && oldRoomAsking ? [approval({ id: "old" })] : [], error: null };
    },
  } } } });
  await refreshHostApprovals("room-old");
  await refreshHostApprovals("room-old-of-another-account");
  seen.length = 0; peak = 0;
  oldRoomAsking = false;
  const busyRooms = Array.from({ length: 8 }, (_, index) => responding({ id: `busy_${index}`, roomId: `room-busy-${index}`, provider: "codex" }));
  const accountRooms = [...busyRooms.map(entry => entry.roomId), "room-old", "room-idle", "room-paused", "room-cursor"]
    .map(roomIdentifier => ({ roomIdentifier, displayName: roomIdentifier, records: [], tasks: [], truncated: false }));
  const data = ref<DesktopNeedsYou | null>(needsYou({ rooms: accountRooms, agents: [
    responding({ id: "elsewhere", roomId: "room-of-another-account", provider: "codex" }),
    ...busyRooms,
    agent({ id: "idle", roomId: "room-idle", provider: "claude-code" }),
    { ...responding({ id: "paused", roomId: "room-paused", provider: "open-model" }), desiredState: "paused" as const, roomAgentState: agent().roomAgentState },
    responding({ id: "cursor", roomId: "room-cursor", provider: "cursor" }),
  ] }));
  await withAttention(data, attention => attention.refreshApprovals());
  assert.deepEqual(seen.sort(), [...busyRooms.map(entry => entry.roomId), "room-old"].sort(),
    "idle, paused, non-approval and other accounts' agents are not asked");
  assert.ok(peak <= 4, `at most four listings at once (saw ${peak})`);
  assert.equal(hostApprovalRooms().get("room-old")?.approvals.length, 0, "an approval that went away leaves the count");
});

test("approvals whose listing failed are not counted, while a failed decision stays visible with its reason", async () => {
  let available = true;
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    listHostApprovals: async () => available ? { available: true, approvals: [approval()], error: null }
      : { available: false, approvals: [], error: "Host approval signing was not enrolled." },
    decideHostApproval: async () => { throw new Error("Error invoking remote method: Error: Refresh the approval before deciding; this request cannot currently be sent."); },
  } } } });
  await withAttention(ref<DesktopNeedsYou | null>(needsYou()), async (attention) => {
    await refreshHostApprovals("room-a");
    assert.equal(attention.countForRoom("room-a"), 1);
    await decideHostApproval("room-a", "presentation-1", "allow_once");
    assert.equal(hostApprovalRoom("room-a").error, "This request changed. Refresh approvals to see its current state.");
    assert.equal(attention.countForRoom("room-a"), 1, "the owner still sees what failed and can refresh it");
    available = false;
    await refreshHostApprovals("room-a");
    assert.equal(hostApprovalRoom("room-a").approvals.length, 1, "the composer keeps the card, disabled");
    assert.equal(attention.countForRoom("room-a"), 0, "main dropped these presentations, so the badge and Inbox drop them too");
    available = true;
    await refreshHostApprovals("room-a");
    assert.equal(attention.countForRoom("room-a"), 1);
  });
});

test("two surfaces deciding the same approval at once send one decision", async () => {
  const decisions: unknown[] = [];
  const pending: Array<() => void> = [];
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    listHostApprovals: async () => ({ available: true, approvals: [approval()], error: null }),
    decideHostApproval: async (input: unknown) => { decisions.push(input); await new Promise<void>(resolve => { pending.push(resolve); }); return "decision_sent"; },
  } } } });
  await refreshHostApprovals("room-a");
  const composer = decideHostApproval("room-a", "presentation-1", "allow_once");
  const inbox = decideHostApproval("room-a", "presentation-1", "deny");
  await new Promise(resolve => setImmediate(resolve));
  for (const release of pending) release();
  await Promise.all([composer, inbox]);
  assert.deepEqual(decisions, [{ id: "presentation-1", decision: "allow_once" }]);
});

test("only the account's rooms and local rooms reach the Inbox", () => {
  const approvalRooms = new Map([
    ["room-a", { approvals: [approval()], firstSeenAt: {}, stale: false }],
    ["room-of-another-account", { approvals: [approval({ id: "other" })], firstSeenAt: {}, stale: false }],
    ["local_7f3a", { approvals: [approval({ id: "local" })], firstSeenAt: {}, stale: false }],
  ]);
  const items = buildAgentAttentionItems({ approvalRooms, agents: [{ ...blockedAgent(at(600_000)), roomId: "left-room" }], accountRooms: new Set(["room-a"]), nowMs: NOW });
  assert.deepEqual(items.map(item => item.roomIdentifier), ["room-a", "local_7f3a"]);
});

test("a capped room list does not hide approvals in rooms past the cap", async () => {
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    listHostApprovals: async () => ({ available: true, approvals: [approval()], error: null }),
  } } } });
  await refreshHostApprovals("room-101");
  await withAttention(ref<DesktopNeedsYou | null>(needsYou({ limited: true })), attention => {
    assert.equal(attention.countForRoom("room-101"), 1);
  });
  await withAttention(ref<DesktopNeedsYou | null>(needsYou()), attention => {
    assert.equal(attention.countForRoom("room-101"), 0, "a complete room list does drop it");
  });
});

test("a flapping agent keeps its start time, and the clock surfaces it without waiting for new data", async (context) => {
  const stuck = agent({ condition: "coordination_blocked" });
  const recovered = agent();
  let seen = trackAgentAttention({}, [stuck], NOW);
  seen = trackAgentAttention(seen, [recovered], NOW + 60_000);
  seen = trackAgentAttention(seen, [stuck], NOW + 120_000);
  assert.equal(seen.supervised_copper.since, new Date(NOW).toISOString(), "one clear sample does not restart the grace");
  seen = trackAgentAttention(seen, [recovered], NOW + 180_000);
  assert.ok(seen.supervised_copper, "a short recovery is remembered");
  assert.equal(trackAgentAttention(seen, [recovered], NOW + 360_000).supervised_copper, undefined, "staying clear forgets it");
  const afterGap = trackAgentAttention({ supervised_copper: { since: at(3_600_000), lastSeen: at(1_800_000) } }, [stuck], NOW);
  assert.equal(afterGap.supervised_copper.since, new Date(NOW).toISOString(), "a start time not seen for half an hour is not reused");

  context.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const data = ref<DesktopNeedsYou | null>(needsYou({ agents: [stuck] }));
  await withAttention(data, (attention) => {
    assert.equal(attention.items.value.length, 0, "inside the grace");
    context.mock.timers.tick(AGENT_ATTENTION_GRACE_MS);
    assert.equal(attention.items.value.length, 1, "shown once the grace passes, before the next refresh");
  });
});

test("agent attention sorts with human requests in Needs you and opens where the owner can act", () => {
  const items: AgentAttentionItem[] = buildAgentAttentionItems({
    approvalRooms: new Map([["room-a", { approvals: [approval()], firstSeenAt: { "presentation-1": at(60_000) }, stale: false }]]),
    agents: [blockedAgent(at(1_800_000))],
    rooms: [{ roomIdentifier: "room-a", boardIntents: [intent({ createdAt: at(300_000) })] }],
    nowMs: NOW,
  });
  const data = needsYou({ rooms: [{ roomIdentifier: "room-a", displayName: "fern-reef", truncated: false, tasks: [],
    records: [{ ...record, created_at: at(900_000) }] }] });
  const needs = filterUniversalInbox(buildUniversalInbox(data, [], items), "needs-you", [], {});
  assert.deepEqual(needs.map(item => item.category), ["agent_attention", "board_intent", "tool_approval", "decision"],
    "blocked agent work leads, longest-waiting first; requests follow");
  assert.ok(needs.every(item => item.roomName === "fern-reef"));

  const [agentItem, intentItem, approvalItem] = needs;
  assert.deepEqual(inboxNavigationIntent(agentItem), { roomIdentifier: "room-a", taskId: undefined, agentEntryId: "supervised_copper" });
  assert.deepEqual(inboxNavigationIntent(intentItem), { roomIdentifier: "room-a", taskId: undefined, boardRequests: true });
  assert.deepEqual(inboxNavigationIntent(approvalItem, "room"), { roomIdentifier: "room-a", approvals: true });
  assert.equal(intentItem.title, "Claim task_7");
  assert.equal(intentItem.actor, "SummitMisty");
});

test("the Inbox offers the composer card's approval actions and copy", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/InboxView.vue")).default;
    const [item] = buildAgentAttentionItems({ approvalRooms: new Map([["room-a", { approvals: [approval({ presentation: { ...approval().presentation, details: '{"permission":"bash","patterns":["<script>x()</script>"]}' } })], firstSeenAt: {}, stale: false }]]), nowMs: NOW });
    const html = await renderToString(createSSRApp(component, { data: needsYou(), attention: [item], loading: false, error: "" }));
    for (const copy of ["Tool approval", "CopperRidge · Run a command", "Deny", "Allow once", "Always allow Bash in year-dots",
      "Deny applies to all pending permissions for this agent."]) assert.ok(html.includes(copy), copy);
    assert.match(html, /&lt;script&gt;x\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>x\(\)/);
    const [stuck] = buildAgentAttentionItems({ agents: [blockedAgent(at(1_800_000))], nowMs: NOW });
    const stuckHtml = await renderToString(createSSRApp(component, { data: needsYou(), attention: [stuck], loading: false, error: "" }));
    assert.match(stuckHtml, /Open diagnostics/);
    const [waiting] = buildAgentAttentionItems({ rooms: [{ roomIdentifier: "room-a", boardIntents: [intent()] }], nowMs: NOW });
    const waitingHtml = await renderToString(createSSRApp(component, { data: needsYou(), attention: [waiting], loading: false, error: "" }));
    assert.match(waitingHtml, /Review request/);
    assert.match(waitingHtml, /Board request/);
  } finally { await vite.close(); }
});

test("a stuck or recovered agent shows in Needs you on the supervisor push, between Needs you reads", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  let push: ((entries: DesktopSupervisorManifestEntry[]) => void) | null = null;
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    onLiveAgents: (callback: (entries: DesktopSupervisorManifestEntry[]) => void) => { push = callback; return () => { push = null; }; },
  } } } });
  const data = ref<DesktopNeedsYou | null>(needsYou({ agents: [blockedAgent(at(600_000))] }));
  await withAttention(data, (attention) => {
    assert.equal(attention.items.value.length, 1, "stuck, as the last read reported");
    push!([agent()]);
    assert.equal(attention.items.value.length, 0, "recovered as soon as the push says so");
    push!([blockedAgent(at(600_000))]);
    assert.equal(attention.items.value.length, 1);
    data.value = needsYou({ agents: [] });
    assert.equal(attention.items.value.length, 0, "a newer read still replaces what was pushed");
  });
  assert.equal(push, null, "the push subscription ends with the scope");
});

test("board requests name the agent, not its full sender label", () => {
  const [claim] = buildAgentAttentionItems({ rooms: [{ roomIdentifier: "room-a", boardIntents: [intent({
    payload: { task_id: "task_6", assignee: "LunarAmber | EmmyMay's agent | Open Model" } })] }], nowMs: NOW });
  const [item] = buildUniversalInbox(needsYou(), [], [claim]);
  assert.equal(item.title, "Assign task_6 to LunarAmber");
  const [handoff] = buildAgentAttentionItems({ rooms: [{ roomIdentifier: "room-a", boardIntents: [intent({ actionType: "task_override",
    payload: { task_id: "task_6", action: "handoff", target_actor_key: "FieldTrail | EmmyMay's agent | Cursor" } })] }], nowMs: NOW });
  assert.equal(buildUniversalInbox(needsYou(), [], [handoff])[0].title, "Hand off task_6 to FieldTrail");
});

test("a board request sent to people needs the owner at once and says a person decides it", () => {
  const fresh = at(30_000);
  const items = buildAgentAttentionItems({ rooms: [{ roomIdentifier: "room-a", boardIntents: [
    intent({ id: "bi_own", createdAt: fresh, escalatedAt: fresh, proposerActorLabel: "HarborMarsh | EmmyMay's agent | Codex",
      payload: { task_id: "task_1", assignee: "HarborMarsh | EmmyMay's agent | Codex" } }),
    intent({ id: "bi_waiting", createdAt: fresh }),
    intent({ id: "bi_older_server", createdAt: fresh, escalatedAt: undefined }),
  ] }], nowMs: NOW });
  assert.deepEqual(items.map(item => item.key), [JSON.stringify(["room-a", "board-intent", "bi_own"])],
    "only the escalated request skips the manager's turn");
  const [item] = buildUniversalInbox(needsYou(), [], items);
  assert.equal(item.title, "Assign task_1 to HarborMarsh");
  assert.match(item.body, /Waiting for a person to decide/);
  assert.doesNotMatch(item.body, /Board Manager decision/);
  const [waiting] = buildUniversalInbox(needsYou(), [], buildAgentAttentionItems({ rooms: [{ roomIdentifier: "room-a", boardIntents: [intent()] }], nowMs: NOW }));
  assert.match(waiting.body, /Waiting for a Board Manager decision/);
});

test("a request its agent waits on is timed by request, so its grace survives a new presentation", () => {
  // An expired live request keeps its reference, so main gives it a request key.
  const waiting = approval({ id: "presentation-2", requestKey: "request-a", status: "unavailable",
    detail: "This approval has expired. No new decision can be sent from this card.",
    presentation: { ...approval().presentation, title: "Run a command",
      details: JSON.stringify({ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] }) } });
  const items = buildAgentAttentionItems({ nowMs: NOW, approvalRooms: new Map([["room-a", { approvals: [waiting],
    firstSeenAt: { "request-a": at(HOST_APPROVAL_BLOCKED_GRACE_MS + 60_000) }, stale: false }]]) });
  assert.deepEqual(items.map(item => item.key), [JSON.stringify(["room-a", "approval", "request-a"])]);
  assert.equal(items[0].timestamp, at(HOST_APPROVAL_BLOCKED_GRACE_MS + 60_000), "first seen when the request was, not this presentation");
});
