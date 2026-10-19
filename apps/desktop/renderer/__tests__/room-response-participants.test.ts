import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopRoomAgentReceiptState, DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import { RoomResponseParticipants, mergeRoomResponseParticipants } from "../src/domain/room-response-participants";
import { collapseWorkIndicators, workIndicatorSupersededByAgentMessage } from "../src/domain/managed-agents";

type Input = Parameters<RoomResponseParticipants["update"]>[0];
function agent(n: number): DesktopSupervisorManifestEntry {
  return {
    id: `entry-${n}`, roomId: "room", agentKey: `owner/${n}`, agentSessionId: `session-${n}`,
    displayName: `Agent ${n}`, agentSessionBindingState: "active", desiredState: "running", condition: "none",
    roomAgentState: { connection: { state: "connected" }, ingress: { state: "observing" },
      inbox: { state: "empty" }, turn: { state: "idle" } }, deliveryReceipts: [],
  } as DesktopSupervisorManifestEntry;
}
let arrival = 0;
function message(id: string, entries: DesktopSupervisorManifestEntry[]): Input["messages"][number] {
  return { id, liveArrival: ++arrival, timestamp: "2026-10-14T14:00:00.000Z", accountAgentRouting: {
    version: 1, authority: "receipts", recipientAgentKeys: entries.map(entry => entry.agentKey!),
    recipientSessions: entries.map(entry => ({ agentKey: entry.agentKey!, agentSessionId: entry.agentSessionId! })),
  } };
}
function fixture(count = 8) {
  const tracker = new RoomResponseParticipants();
  const entries = Array.from({ length: count }, (_, n) => agent(n));
  const input: Input = { roomIdentifier: "room", loading: false, messages: [], entries, presence: [], fresh: true };
  tracker.update(input);
  const run = () => tracker.update(input);
  return { tracker, entries, input, run };
}
function finish(entry: DesktopSupervisorManifestEntry, id: string, state: DesktopRoomAgentReceiptState) {
  entry.deliveryReceipts = [{ sourceMessageId: id, state } as NonNullable<typeof entry.deliveryReceipts>[number]];
}

test("all eight exact recipients appear before any native turn, and silent/failed/cancelled outcomes retire them", () => {
  const { input, entries, run } = fixture();
  input.messages = [message("new", entries)];
  const rows = run();
  assert.equal(rows.length, 8);
  assert.equal(collapseWorkIndicators(rows, 0).visible.length, 8);
  assert.ok(rows.every(row => row.summary === "Thinking" && row.awaitingRoomTurn && !row.waitsForBackgroundWork));
  const outcomes = ["acknowledged", "acknowledged_no_reply", "acknowledged_failed", "cancelled_by_user"] as const;
  entries.forEach((entry, n) => finish(entry, "new", outcomes[n % outcomes.length]!));
  assert.deepEqual(run(), []);
  entries.forEach(entry => { entry.deliveryReceipts = []; });
  assert.deepEqual(run(), [], "pruning receipts cannot resurrect completed participants");
});

test("history, older pagination, room changes and replaced snapshots do not claim new participation", () => {
  const { input, entries, tracker, run } = fixture();
  input.loading = true; input.messages = [message("old", entries)]; run();
  input.loading = false; assert.deepEqual(run(), []);
  input.messages = [{ ...message("older", entries), liveArrival: undefined }, ...input.messages]; assert.deepEqual(run(), []);
  input.messages = [...input.messages, { ...message("replacement", entries), liveArrival: undefined }]; assert.deepEqual(run(), []);
  input.messages = [...input.messages, message("live", entries)]; assert.equal(run().length, 8);
  input.roomIdentifier = "another"; assert.deepEqual(run(), []);
  input.roomIdentifier = "room"; assert.deepEqual(tracker.update(input), []);
});

test("late Jev routing applies to a live message; optimistic sends do not move the canonical boundary", () => {
  const { input, entries, run } = fixture();
  input.messages = [{ id: "pending", timestamp: "", outgoing: { status: "pending", attachmentCount: 0, error: null } }];
  assert.deepEqual(run(), []);
  input.messages = [{ id: "new", liveArrival: ++arrival, timestamp: "" }]; assert.deepEqual(run(), []);
  input.messages = [{ ...message("new", entries), liveArrival: input.messages[0]!.liveArrival }]; assert.equal(run().length, 8);
});

test("exact sessions, successors and unique entries prevent same-name or stale-session claims", () => {
  const { input, entries, run } = fixture(2);
  entries[1]!.displayName = entries[0]!.displayName;
  const msg = message("new", entries);
  input.messages = [msg];
  entries[0]!.agentSessionId = "new-session";
  assert.deepEqual(run().map(row => row.id), [entries[1]!.id]);
  if (msg.accountAgentRouting?.authority === "receipts") msg.accountAgentRouting.recipientSessions[0]!.successorAgentSessionId = "new-session";
  assert.equal(run().length, 2);
  input.entries = [...entries, { ...entries[0]!, id: "ambiguous" }];
  assert.deepEqual(run().map(row => row.id), [entries[1]!.id]);
});

test("readiness and actual retry/compaction controls take precedence", () => {
  const { input, entries, run } = fixture(1);
  input.messages = [message("new", entries)];
  const rows = run();
  input.fresh = false; assert.deepEqual(run(), []); input.fresh = true;
  const entry = entries[0]!;
  entry.desiredState = "paused"; assert.deepEqual(run(), []); entry.desiredState = "running";
  entry.roomAgentState!.connection.state = "disconnected"; assert.deepEqual(run(), []);
  entry.roomAgentState!.connection.state = "connected";
  entry.roomAgentState!.ingress.state = "backoff"; assert.deepEqual(run(), []);
  entry.roomAgentState!.ingress.state = "observing";
  finish(entry, "new", "blocked"); assert.deepEqual(run(), []);
  const retry = { ...rows[0]!, id: `${entries[0]!.id}:waiting`, summary: "Trying again", awaitingRoomTurn: undefined, waiting: true as const };
  assert.deepEqual(mergeRoomResponseParticipants([retry], rows), [retry]);
});

test("finishing A, or publishing A after B arrived, cannot erase participation in B", () => {
  const { input, entries, run } = fixture(1);
  input.messages = [message("A", entries)]; run();
  input.messages = [...input.messages, message("B", entries)]; run();
  finish(entries[0]!, "A", "acknowledged_no_reply");
  const rows = run();
  assert.equal(rows[0]!.sourceMessageId, "B");
  assert.equal(workIndicatorSupersededByAgentMessage(rows[0]!, [
    { id: "B", agentIdentity: null },
    { id: "reply-to-A", agentIdentity: { agentSessionId: entries[0]!.agentSessionId } as never },
  ]), false);
  finish(entries[0]!, "B", "acknowledged"); assert.deepEqual(run(), []);
});


test("completed recipients stay finished across an authorized successor after receipt pruning", () => {
  const { input, entries, run } = fixture(1);
  const msg = message("new", entries); input.messages = [msg]; run();
  finish(entries[0]!, "new", "acknowledged_no_reply"); assert.deepEqual(run(), []);
  entries[0]!.deliveryReceipts = []; entries[0]!.agentSessionId = "successor";
  if (msg.accountAgentRouting?.authority === "receipts") msg.accountAgentRouting.recipientSessions[0]!.successorAgentSessionId = "successor";
  assert.deepEqual(run(), []);
});

test("pending B survives the retirement of actual A in the same render", () => {
  const { input, entries, run } = fixture(1);
  input.messages = [message("B", entries)]; const pending = run();
  const actual = { ...pending[0]!, awaitingRoomTurn: undefined, sourceMessageId: "A" };
  assert.deepEqual(mergeRoomResponseParticipants([actual], pending), [actual]);
  const messages = [
    { id: "A", agentIdentity: null }, { id: "B", agentIdentity: null },
    { id: "reply-A", agentIdentity: { agentSessionId: actual.agentSessionId } as never },
  ];
  assert.deepEqual(mergeRoomResponseParticipants([actual], pending, messages), pending);
});
