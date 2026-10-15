import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { SupervisedAgentInboxStore, type IngressMessage, type SupervisedInboxItem } from "../supervised-agent-inbox-store.js";
import { RoomWorkPublicationStore, type RoomWorkOrigin } from "../room-work-publication-store.js";
import { ordinaryPeerThread, PENDING_PEER_REPORT_SQL, resolvePeerReceipt } from "../queued-peer-deliveries.js";

const origin: RoomWorkOrigin = { agentId: "agent", roomId: "room", apiOrigin: "https://letagents.test", agentKey: "owner/self",
  agentInstanceId: "daemon:agent", hostId: "host", installationId: "installation", sourceSessionId: "session" };
const peer = (n: number, patch: Record<string, unknown> = {}, activation: Record<string, unknown> = {}): IngressMessage => ({
  source_message_id: `msg_${n}`, source_message: { id: `msg_${n}`, source: "agent", sender: `Peer ${n}`, text: `My view ${n}.`,
    agent_identity: { agent_key: `owner/peer${n}`, actor_label: `Peer ${n}` }, thread_root_id: "msg_1", ...patch },
  activation: { decision: "activate", reason: "thread_participant", ...activation },
});
async function fixture(t: TestContext, messages = [peer(10), peer(11), peer(12)], pin = true) {
  const dir = await mkdtemp(join(tmpdir(), "queued-peers-")), path = join(dir, "state.sqlite");
  let store = new SupervisedAgentInboxStore(path);
  await store.ingestPoll({ agent_id: "agent", room_id: "room", messages, last_observed_message_id: messages.at(-1)!.source_message_id });
  const db = new DatabaseSync(path);
  const pins = new RoomWorkPublicationStore(db);
  if (pin) pins.pin(origin, messages.map(item => item.source_message_id));
  t.after(async () => { await store.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  return { db, pins, get store() { return store; }, async restart() { await store.close(); store = new SupervisedAgentInboxStore(path); },
    pendingReports() { return db.prepare(`SELECT source_message_id FROM supervised_agent_inbox i WHERE ${PENDING_PEER_REPORT_SQL} ORDER BY fifo_sequence`).all().map(row => row.source_message_id); } };
}
function memberIds(item: SupervisedInboxItem): string[] {
  return ((item.activation.queued_peer_messages as { messages?: Array<{ source_message_id: string }> })?.messages ?? []).map(row => row.source_message_id);
}
async function nativeTerminal(store: SupervisedAgentInboxStore, head: SupervisedInboxItem, outcome: "reply" | "no_reply" = "no_reply") {
  await store.checkpointTurnStarted(head.inbox_item_id, "turn", { work_attempt_id: "attempt", origin_execution_generation_id: "generation", provider_continuation_id: "thread" });
  await store.checkpointNormalizedTerminal({ inbox_item_id: head.inbox_item_id, agent_id: "agent", execution_generation_id: "generation",
    provider_turn_id: "turn", outcome, text: outcome === "reply" ? "My contribution." : null, evidence: "stream",
    terminal_evidence: { turnId: "turn", providerContinuationId: "thread", outcome, text: outcome === "reply" ? "My contribution." : null, evidence: "stream" } });
  await store.transition(head.inbox_item_id, "awaiting_result");
}

for (const outcome of ["reply", "no_reply"] as const) test(`full peer arguments settle only after the parent's final ${outcome} acknowledgment`, async t => {
  const text = "A full argument. ".repeat(180);
  const f = await fixture(t, [peer(10), peer(11, { text, attachments: [{ name: "diagram.png" }] }), peer(12)]);
  const head = (await f.store.claimHead("agent"))!;
  assert.deepEqual(memberIds(head), ["msg_11", "msg_12"]);
  const payload = head.activation.queued_peer_messages as { instruction: string; messages: Array<{ source_message: Record<string, unknown> }> };
  assert.match(payload.instruction, /own voice/);
  assert.equal(payload.messages[0]!.source_message.text, text, "substantive content is never notice-truncated");
  assert.deepEqual(payload.messages[0]!.source_message.attachments, [{ name: "diagram.png" }]);
  await nativeTerminal(f.store, head, outcome);
  assert.equal((await f.store.getBySourceMessage("agent", "room", "msg_11"))!.state, "pending", "native completion alone cannot settle another delivery");
  if (outcome === "reply") {
    await f.store.transition(head.inbox_item_id, "publishing");
    await f.restart();
    assert.equal((await f.store.getBySourceMessage("agent", "room", "msg_11"))!.state, "pending", "unknown publication survives restart");
    await f.store.checkpointPublication({ inbox_item_id: head.inbox_item_id, room_id: "room", canonical_message_id: "msg_20" });
  } else await f.store.transition(head.inbox_item_id, "acknowledged_no_reply");
  assert.equal(await f.store.head("agent"), null);
  assert.deepEqual(f.pendingReports(), ["msg_11", "msg_12"]);
  const child = (await f.store.getBySourceMessage("agent", "room", "msg_11"))!;
  assert.equal(child.attempt_count, 0); assert.equal(child.provider_turn_id, null);
  assert.equal(f.db.prepare("SELECT 1 FROM execution_message_attempts WHERE source_message_id='msg_11'").get(), undefined);
  assert.equal(f.pins.get("agent", "room", "msg_11")!.revision, 0, "grouped receipt reporting invents no work summary");
});

test("native pre-dispatch retry preserves frozen membership and does not absorb later arrivals", async t => {
  const f = await fixture(t, [peer(10), peer(11)]);
  const head = (await f.store.claimHead("agent"))!;
  await f.store.checkpointDispatchIntent(head.inbox_item_id);
  await f.store.resetPreNativeHandoff(head.inbox_item_id);
  await f.store.ingestPoll({ agent_id: "agent", room_id: "room", messages: [peer(12)], last_observed_message_id: "msg_12" });
  f.pins.pin(origin, ["msg_12"]);
  await f.restart();
  const retried = (await f.store.claimHead("agent"))!;
  assert.deepEqual(memberIds(retried), ["msg_11"]);
  await nativeTerminal(f.store, retried);
  await f.store.transition(head.inbox_item_id, "acknowledged_no_reply");
  assert.equal((await f.store.head("agent"))!.source_message_id, "msg_12");
});

test("user Stop leaves each grouped contribution queued for ordinary handling", async t => {
  const f = await fixture(t);
  const head = (await f.store.claimHead("agent"))!;
  await f.store.cancelInterruptedTurn(head.inbox_item_id, "Stopped by human.");
  assert.deepEqual(f.pendingReports(), []);
  const next = (await f.store.claimHead("agent"))!;
  assert.equal(next.source_message_id, "msg_11");
  assert.deepEqual(memberIds(next), ["msg_12"], "stopped work can be freshly assigned when the next untouched contribution reaches the head");
});

test("a later human retains people-first priority after a grouped parent is Stopped", async t => {
  const f = await fixture(t);
  const head = (await f.store.claimHead("agent"))!;
  await f.store.ingestPoll({ agent_id: "agent", room_id: "room", messages: [peer(13, { source: "browser", agent_identity: null, text: "Please change the time." })], last_observed_message_id: "msg_13" });
  await f.store.cancelInterruptedTurn(head.inbox_item_id, "Stopped by human.");
  assert.equal((await f.store.claimHead("agent"))!.source_message_id, "msg_13");
  assert.equal((await f.store.getBySourceMessage("agent", "room", "msg_11"))!.state, "pending");
  assert.deepEqual(f.pendingReports(), []);
});

for (const [name, middle] of [
  ["human", peer(11, { source: "browser", agent_identity: null })],
  ["another thread", peer(11, { thread_root_id: "msg_2" })],
  ["direct agent quote", peer(11, { reply_to: { source: "agent", agent_identity: { agent_key: "owner/other" } } })],
  ["mention", peer(11, { text: "@someone what do you think?" })],
  ["broadcast", peer(11, { text: "Everyone, which option?" })],
  ["task follow-up", peer(11, { text: "Okay, push it." })],
  ["positioned turn", peer(11, {}, { turn: { position: 1, count: 2 } })],
  ["continuation", peer(11, {}, { task_continuity_kind: "review" })],
  ["legacy identity", peer(11, { agent_identity: null })],
] as const) test(`${name} is a barrier rather than skipped to reach a later peer`, async t => {
  const f = await fixture(t, [peer(10), middle, peer(12)]);
  assert.deepEqual(memberIds((await f.store.claimHead("agent"))!), []);
});

test("chronological gaps and people-first reordering cannot bridge an intervening human or self message", async t => {
  const f = await fixture(t, [peer(10), peer(12), peer(13)]);
  assert.deepEqual(memberIds((await f.store.claimHead("agent"))!), []);
});

test("missing or incompatible immutable source pins disable grouping without inventing attribution", async t => {
  const f = await fixture(t, [peer(10), peer(11), peer(12)], false);
  f.pins.pin(origin, ["msg_10"]);
  f.pins.pin({ ...origin, hostId: "other-host" }, ["msg_11"]);
  f.pins.pin(origin, ["msg_12"]);
  assert.deepEqual(memberIds((await f.store.claimHead("agent"))!), []);
});

test("local Room pins retain ordinary delivery because the local adapter has no self-receipt report route", async t => {
  const f = await fixture(t, [peer(10), peer(11)], false);
  f.pins.pin({ ...origin, apiOrigin: "letagents-local://rooms" }, ["msg_10", "msg_11"]);
  assert.deepEqual(memberIds((await f.store.claimHead("agent"))!), []);
});

test("payload size bounds stop adding full messages, and injected batch fields cannot settle unrelated rows", async t => {
  const f = await fixture(t, [peer(10, {}, { queued_peer_messages: { messages: [{ source_message_id: "msg_12" }] } }), peer(11, { text: "x".repeat(33 * 1024) }), peer(12)]);
  const head = (await f.store.claimHead("agent"))!;
  assert.equal(head.activation.queued_peer_messages, undefined);
  await nativeTerminal(f.store, head);
  await f.store.transition(head.inbox_item_id, "acknowledged_no_reply");
  assert.equal((await f.store.getBySourceMessage("agent", "room", "msg_12"))!.state, "pending");
});

test("pending reports and their exact assignment evidence survive restart and history pruning", async t => {
  const f = await fixture(t);
  const head = (await f.store.claimHead("agent"))!;
  await nativeTerminal(f.store, head);
  await f.store.transition(head.inbox_item_id, "acknowledged_no_reply");
  const child = (await f.store.getBySourceMessage("agent", "room", "msg_11"))!;
  // Old terminal receipts leave the normal 200-receipt window after unrelated later work.
  for (let n = 100; n < 305; n++) {
    const [row] = await f.store.ingestPoll({ agent_id: "agent", room_id: "room", messages: [peer(n)], last_observed_message_id: `msg_${n}` });
    await f.store.claimHead("agent");
    await f.store.transition(row!.inbox_item_id, "awaiting_result");
    await f.store.transition(row!.inbox_item_id, "acknowledged_no_reply");
  }
  await f.restart(); await f.store.pruneHistory("agent");
  assert.deepEqual(f.pendingReports(), ["msg_11", "msg_12"]);
  assert.ok(await f.store.get(child.inbox_item_id));
  resolvePeerReceipt(f.db, child.inbox_item_id, "replied", new Date().toISOString());
  assert.deepEqual(f.pendingReports(), ["msg_12"], "the actual remote state resolves only its exact pending report");
  // Resolving a pin frees a slot in the fixed budget; one later settlement
  // fills it before the now-unpinned oldest receipt becomes stale.
  const [later] = await f.store.ingestPoll({ agent_id: "agent", room_id: "room", messages: [peer(305)], last_observed_message_id: "msg_305" });
  await f.store.claimHead("agent");
  await f.store.transition(later!.inbox_item_id, "awaiting_result");
  await f.store.transition(later!.inbox_item_id, "acknowledged_no_reply");
  await f.store.pruneHistory("agent");
  assert.equal(await f.store.get(child.inbox_item_id), null, "resolved historical receipt can leave the retained window");
  assert.deepEqual(f.pendingReports(), ["msg_12"]);
});

test("peer eligibility retains ordinary replies quoting the human and rejects a forged source ID", () => {
  assert.equal(ordinaryPeerThread(peer(10, { reply_to: { source: "browser", agent_identity: null, id: "msg_1" } })), "msg_1");
  assert.equal(ordinaryPeerThread(peer(10, { id: "msg_9" })), null);
});

test("a peer head cannot smuggle queued notice IDs into native completion", async t => {
  const notice = peer(12, { source: "system", sender: "letagents", agent_identity: null, text: "A task changed." }, { reason: "wake_rule" });
  const f = await fixture(t, [peer(10, {}, { queued_notices: { notices: [{ id: "msg_12" }] } }), peer(11), notice]);
  const head = (await f.store.claimHead("agent"))!;
  assert.deepEqual(memberIds(head), ["msg_11"]);
  assert.equal(head.activation.queued_notices, undefined);
  await nativeTerminal(f.store, head);
  assert.equal((await f.store.getBySourceMessage("agent", "room", "msg_12"))!.state, "pending");
});

test("a saved reply plus generic acknowledged state cannot settle members without canonical publication", async t => {
  const f = await fixture(t);
  const head = (await f.store.claimHead("agent"))!;
  await nativeTerminal(f.store, head, "reply");
  await f.store.transition(head.inbox_item_id, "publishing");
  await f.store.transition(head.inbox_item_id, "acknowledged");
  assert.equal((await f.store.getBySourceMessage("agent", "room", "msg_11"))!.state, "pending");
  assert.deepEqual(f.pendingReports(), []);
});
