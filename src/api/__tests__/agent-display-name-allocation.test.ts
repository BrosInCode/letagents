import assert from "node:assert/strict";
import test from "node:test";

import {
  agentDisplayNameKey,
  allocateAgentDisplayName,
  isNameHeldByAnotherAgent,
  nameComesFreeAtMs,
  resolveSupervisedWorkerDisplayName,
  selectReleasableNameHolders,
  type RoomWorkerNameHolder,
} from "../rooms/agent-display-name-allocation.js";
import {
  AGENT_DELIVERY_LINGERS_MS,
  AGENT_PROCESS_EXITED,
  AGENT_PROCESS_GONE_AFTER_MS,
  AGENT_WITHOUT_EVIDENCE_GONE_AFTER_MS,
  agentProcessGoneSoonAtMs,
  hasAgentProcessExited,
  AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS,
  isAgentProcessGone,
} from "../../shared/agent-presence.js";

function holder(
  input: Partial<RoomWorkerNameHolder> & Pick<RoomWorkerNameHolder, "agent_key" | "display_name">,
): RoomWorkerNameHolder {
  return {
    session_id: `session_${input.agent_key}`,
    agent_instance_id: `daemon:${input.agent_key}`,
    assigned_base_display_name: input.display_name,
    created_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    ...input,
  };
}

function resolve(input: {
  requested: string;
  agent_key: string;
  holders: RoomWorkerNameHolder[];
  additionally_held?: string[];
}) {
  return resolveSupervisedWorkerDisplayName({
    requested_display_name: input.requested,
    agent_key: input.agent_key,
    agent_instance_id: `daemon:${input.agent_key}`,
    holders: input.holders,
    additionally_held: input.additionally_held,
  });
}

test("names that answer to the same mention are the same name", () => {
  assert.equal(agentDisplayNameKey("FieldMeadow"), agentDisplayNameKey("fieldmeadow"));
  assert.equal(agentDisplayNameKey("FieldMeadow"), agentDisplayNameKey("Field Meadow"));
  assert.notEqual(agentDisplayNameKey("FieldMeadow"), agentDisplayNameKey("FieldMeadow 1"));
});

test("a held name yields a deterministic codename, never a numbered variant", () => {
  const isHeld = (name: string) => agentDisplayNameKey(name) === "reviewer";
  const first = allocateAgentDisplayName({ base_display_name: "Reviewer", agent_key: "owner/a", is_held: isHeld });
  const again = allocateAgentDisplayName({ base_display_name: "Reviewer", agent_key: "owner/a", is_held: isHeld });
  const other = allocateAgentDisplayName({ base_display_name: "Reviewer", agent_key: "owner/b", is_held: isHeld });
  assert.ok(first && again && other);
  assert.match(first.display_name, /^[A-Za-z]+$/);
  assert.equal(first.display_name, again.display_name, "one identity converges on one replacement");
  assert.notEqual(first.display_name, other.display_name, "identities do not share a replacement");
  assert.deepEqual(
    allocateAgentDisplayName({ base_display_name: "Reviewer", agent_key: "owner/a", is_held: () => false }),
    { display_name: "Reviewer", collision_offset: 0 },
  );
  assert.equal(
    allocateAgentDisplayName({ base_display_name: "Reviewer", agent_key: "owner/a", is_held: () => true }),
    null,
    "the scan is bounded",
  );
});

test("a supervised worker keeps a free name and yields a held one", () => {
  const holders = [holder({ agent_key: "owner/holder", display_name: "FieldMeadow" })];
  assert.deepEqual(
    resolve({ requested: "CedarPeak", agent_key: "owner/new", holders }),
    { display_name: "CedarPeak", reassigned: false },
  );
  const reassigned = resolve({ requested: "fieldmeadow", agent_key: "owner/new", holders });
  assert.ok(reassigned?.reassigned);
  assert.notEqual(agentDisplayNameKey(reassigned.display_name), agentDisplayNameKey("FieldMeadow"));
});

test("of two live workers sharing a name only the newer one is renamed", () => {
  const older = holder({ agent_key: "owner/older", display_name: "FieldMeadow", created_at: "2026-01-01T00:00:00.000Z" });
  const newer = holder({ agent_key: "owner/newer", display_name: "FieldMeadow", created_at: "2026-01-02T00:00:00.000Z" });
  const holders = [older, newer];
  assert.deepEqual(
    resolve({ requested: "FieldMeadow", agent_key: older.agent_key, holders }),
    { display_name: "FieldMeadow", reassigned: false },
  );
  assert.equal(resolve({ requested: "FieldMeadow", agent_key: newer.agent_key, holders })?.reassigned, true);

  // Sessions created in the same instant still name exactly one keeper.
  const twinA = holder({ agent_key: "owner/a", display_name: "OwlSolar", session_id: "session_1" });
  const twinB = holder({ agent_key: "owner/b", display_name: "OwlSolar", session_id: "session_2" });
  const outcomes = [twinA, twinB].map((twin) =>
    resolve({ requested: "OwlSolar", agent_key: twin.agent_key, holders: [twinA, twinB] })?.reassigned);
  assert.deepEqual(outcomes, [false, true]);
});

test("an assigned name outlives the holder that caused it", () => {
  const renamed = holder({
    agent_key: "owner/renamed",
    display_name: "CedarPeak",
    assigned_base_display_name: "FieldMeadow",
    created_at: "2026-01-02T00:00:00.000Z",
  });
  // The holder of "FieldMeadow" has gone offline. A supervisor that never
  // adopted "CedarPeak" asks for "FieldMeadow" again: taking it now would
  // hand one agent's name to another while people still address the first.
  assert.deepEqual(
    resolve({ requested: "FieldMeadow", agent_key: renamed.agent_key, holders: [renamed] }),
    { display_name: "CedarPeak", reassigned: true },
  );
  // Asking for anything else is a new request and is judged on its own.
  assert.deepEqual(
    resolve({ requested: "MapleRidge", agent_key: renamed.agent_key, holders: [renamed] }),
    { display_name: "MapleRidge", reassigned: false },
  );
});

test("a name another agent's key answers to is held, whatever that agent is called", () => {
  // Mention routing matches the last segment of an agent key, and a key
  // cannot be renamed away, so only the newcomer can resolve the ambiguity.
  const legacy = holder({ agent_key: "EmmyMay/owlsolar", display_name: "GraniteHarbor" });
  assert.equal(isNameHeldByAnotherAgent({
    display_name: "OwlSolar", agent_key: "owner/new", own_sessions: [], holders: [legacy],
  }), true);
  const established = holder({
    agent_key: "owner/established", display_name: "OwlSolar", created_at: "2025-01-01T00:00:00.000Z",
  });
  assert.equal(
    resolve({ requested: "OwlSolar", agent_key: established.agent_key, holders: [legacy, established] })?.reassigned,
    true,
    "seniority does not outrank a key",
  );
});

test("an offline durable worker keeps its name reserved", () => {
  const offline = holder({
    agent_key: "owner/worker-1", agent_instance_id: "worker_1", display_name: "FieldMeadow",
    ended_at: "2026-01-03T00:00:00.000Z",
  });
  assert.equal(resolve({ requested: "FieldMeadow", agent_key: "owner/new", holders: [offline] })?.reassigned, true);
});

test("a name lost to a concurrent claim is not offered again", () => {
  const first = resolve({ requested: "FieldMeadow", agent_key: "owner/new", holders: [] });
  assert.deepEqual(first, { display_name: "FieldMeadow", reassigned: false });
  const second = resolve({ requested: "FieldMeadow", agent_key: "owner/new", holders: [], additionally_held: ["FieldMeadow"] });
  assert.ok(second?.reassigned);
  assert.notEqual(second.display_name, "FieldMeadow");
});

const nowMs = Date.parse("2026-01-01T12:00:00.000Z");
const ago = (ms: number) => new Date(nowMs - ms).toISOString();

test("a session that offers no evidence is believed gone only after a long silence, and only if it can recover", () => {
  const observer = { now_ms: nowMs, process_host_id: "host_a" };
  const silent = (msAgo: number) => ({ process_seen_at: null, last_seen_at: ago(msAgo), agent_heard_at: ago(msAgo) });
  const hour = AGENT_WITHOUT_EVIDENCE_GONE_AFTER_MS;
  const month = 30 * 24 * 3_600_000;
  assert.ok(hour > AGENT_PROCESS_GONE_AFTER_MS, "silence is believed later than evidence is");

  // An older client that starts a new session when told its old one is over.
  const legacy = { agent_instance_id: "8f14e45f-ceea-467f-a0e6-6f5b5f0e3a1c" };
  assert.equal(isAgentProcessGone({ ...silent(AGENT_PROCESS_GONE_AFTER_MS), ...legacy }, observer), false);
  assert.equal(isAgentProcessGone({ ...silent(hour - 1), ...legacy }, observer), false);
  assert.equal(isAgentProcessGone({ ...silent(hour), ...legacy }, observer), true);
  assert.equal(isAgentProcessGone({ ...silent(month), ...legacy, delivery_connected: true }, observer), false,
    "it is waiting for messages on a connection that is open now");
  // The server's bookkeeping is not the agent, but with no other evidence it
  // is read the cautious way: any sign at all keeps the session.
  assert.equal(isAgentProcessGone({ ...silent(month), ...legacy, last_seen_at: ago(60_000) }, observer), false);

  // An older client that cannot: its worker answers from the session it
  // holds until its process is restarted. It is never taken for gone.
  const durable = { agent_instance_id: `worker_${"a".repeat(32)}` };
  assert.equal(isAgentProcessGone({ ...silent(hour), ...durable }, observer), false);
  assert.equal(isAgentProcessGone({ ...silent(month), ...durable }, observer), false);
  // The same worker on a client that knows of process connections, which
  // has not opened one: it is told when its session ends, and starts another.
  assert.equal(isAgentProcessGone({ ...silent(hour - 1), ...durable, process_host_id: "host_a" }, observer), false);
  assert.equal(isAgentProcessGone({ ...silent(hour), ...durable, process_host_id: "host_a" }, observer), true);
  // And one that has disconnected: nothing is ended by letting its name go.
  assert.equal(isAgentProcessGone({ ...silent(AGENT_PROCESS_GONE_AFTER_MS - 1), ...durable, ended_at: ago(AGENT_PROCESS_GONE_AFTER_MS - 1) }, observer), false);
  assert.equal(isAgentProcessGone({ ...silent(AGENT_PROCESS_GONE_AFTER_MS), ...durable, ended_at: ago(AGENT_PROCESS_GONE_AFTER_MS) }, observer), true);
});

test("a process is known to have exited only on its own word or its machine's, never for being silent", () => {
  const here = { now_ms: nowMs, process_host_id: "host_a" };
  const elsewhere = { now_ms: nowMs, process_host_id: "host_b" };
  const month = 30 * 24 * 3_600_000;
  const closed = (msAgo: number) => ({
    process_seen_at: ago(msAgo), process_disconnected_at: ago(msAgo), last_seen_at: ago(msAgo),
    agent_heard_at: ago(msAgo), process_host_id: "host_a", process_connection_id: "closed-connection",
  });
  const exited = { ...closed(1_000), process_connection_id: AGENT_PROCESS_EXITED };

  assert.equal(hasAgentProcessExited(exited, elsewhere), true);
  assert.equal(hasAgentProcessExited(closed(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS), here), true);
  assert.equal(hasAgentProcessExited(closed(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS - 1), here), false);
  // Everything that lets a name pass on for silence says nothing here.
  assert.equal(hasAgentProcessExited(closed(month), elsewhere), false);
  assert.equal(isAgentProcessGone(closed(month), elsewhere), true);
  assert.equal(hasAgentProcessExited({ process_seen_at: ago(month), last_seen_at: ago(month), agent_heard_at: ago(month) }, here), false);
  assert.equal(hasAgentProcessExited({ process_seen_at: null, last_seen_at: ago(month), agent_heard_at: ago(month),
    agent_instance_id: "8f14e45f-ceea-467f-a0e6-6f5b5f0e3a1c" }, here), false);
  // And what refutes the one refutes the other.
  assert.equal(hasAgentProcessExited({ ...exited, agent_heard_at: ago(500) }, elsewhere), false);
  assert.equal(hasAgentProcessExited({ ...exited, delivery_connected: true }, elsewhere), false);
  // A connection that closed after the session ended was let go of, not lost.
  const letGo = { ...closed(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS), ended_at: ago(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS + 1_000) };
  assert.equal(hasAgentProcessExited(letGo, here), false);
  assert.equal(hasAgentProcessExited({ ...letGo, ended_at: ago(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS - 1_000) }, here), true,
    "one that closed before the end was lost");
});

test("the moment a process will be taken for gone is known only when it is moments away", () => {
  const here = { now_ms: nowMs, process_host_id: "host_a" };
  const elsewhere = { now_ms: nowMs, process_host_id: "host_b" };
  const closed = (msAgo: number) => ({
    process_seen_at: ago(msAgo), process_disconnected_at: ago(msAgo), last_seen_at: ago(msAgo),
    agent_heard_at: ago(msAgo), process_host_id: "host_a", process_connection_id: "closed-connection",
  });
  const at = (msAgo: number, after: number) => nowMs - msAgo + after;

  // Its connection closed three seconds ago, on this machine.
  assert.equal(agentProcessGoneSoonAtMs(closed(3_000), here), at(3_000, AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS));
  assert.equal(agentProcessGoneSoonAtMs(closed(3_000), elsewhere), null, "from elsewhere only a long silence would show it");
  // It said it was exiting, and was waiting for messages when it did: the
  // room still holds that request as open, for a known while.
  const exited = { ...closed(3_000), process_connection_id: AGENT_PROCESS_EXITED };
  assert.equal(agentProcessGoneSoonAtMs({ ...exited, delivery_connected: true }, elsewhere), at(3_000, AGENT_DELIVERY_LINGERS_MS));
  assert.equal(agentProcessGoneSoonAtMs({ ...closed(3_000), delivery_connected: true }, here),
    at(3_000, AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS));
  // The agent made a call after its connection closed: it is there.
  assert.equal(agentProcessGoneSoonAtMs({ ...closed(3_000), agent_heard_at: ago(1_000) }, here), null);
  // Still connected, or never connected: nothing is about to happen.
  assert.equal(agentProcessGoneSoonAtMs({ ...closed(3_000), process_disconnected_at: null }, here), null);
  assert.equal(agentProcessGoneSoonAtMs({ ...closed(3_000), process_seen_at: null }, here), null);
});

test("a name is waited for only when everyone holding it is about to be gone", () => {
  const closing = {
    display_name: "MossDawn", owner_account_id: "acct_me", supervisor_grant_id: null, process_host_id: "host_a",
    process_seen_at: ago(3_000), process_disconnected_at: ago(3_000), process_connection_id: "closed-connection",
    last_seen_at: ago(3_000), agent_heard_at: ago(3_000),
  };
  const ask = (holders: RoomWorkerNameHolder[]) => nameComesFreeAtMs({
    display_name: "MossDawn", owner_account_id: "acct_me", agent_key: "me/mossdawn",
    agent_instance_id: "process-2", process_host_id: "host_a", holders, now_ms: nowMs,
  });
  const old = holder({ ...closing, agent_key: "me/mossdawn", session_id: "old", agent_instance_id: "process-1" });
  const freeAt = nowMs - 3_000 + AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS;

  assert.equal(ask([]), null, "nobody holds it");
  assert.equal(ask([old]), freeAt);
  assert.equal(ask([old, holder({ ...closing, agent_key: "me/other-name", session_id: "other", display_name: "CedarPeak" })]), freeAt);
  assert.equal(ask([holder({ ...closing, agent_key: "me/mossdawn", session_id: "self", agent_instance_id: "process-2" })]), null,
    "its own session holds nothing against it");
  // Anyone else holding the name settles it: there is nothing to wait for.
  assert.equal(ask([old, holder({ ...closing, agent_key: "me/alive", session_id: "alive", process_disconnected_at: null })]), null);
  assert.equal(ask([old, holder({ ...closing, agent_key: "you/theirs", session_id: "theirs", owner_account_id: "acct_you" })]), null);
  assert.equal(ask([old, holder({ ...closing, agent_key: "me/supervised", session_id: "supervised", supervisor_grant_id: "grant_1" })]), null);
  // One that is gone already is not waited for.
  assert.equal(ask([holder({ ...closing, agent_key: "me/gone", session_id: "gone",
    process_disconnected_at: ago(60_000), agent_heard_at: ago(60_000), last_seen_at: ago(60_000) })]), null);
});

test("a process is gone only on evidence, never for being quiet", () => {
  const here = { now_ms: nowMs, process_host_id: "host_a" };
  const elsewhere = { now_ms: nowMs, process_host_id: "host_b" };
  const month = 30 * 24 * 3_600_000;

  // Connected, and busy or waiting: the agent itself was last seen long ago.
  assert.equal(isAgentProcessGone({ process_seen_at: ago(20_000), last_seen_at: ago(month), process_host_id: "host_a" }, here), false);
  // Active, though its connection has not been seen for the whole window.
  assert.equal(isAgentProcessGone(
    { process_seen_at: ago(AGENT_PROCESS_GONE_AFTER_MS), last_seen_at: ago(60_000), process_host_id: "host_a" }, elsewhere), false);

  const closed = (msAgo: number) => ({
    process_seen_at: ago(msAgo), process_disconnected_at: ago(msAgo), last_seen_at: ago(msAgo), process_host_id: "host_a",
  });
  assert.equal(isAgentProcessGone(closed(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS - 1), here), false, "it may be reopening");
  assert.equal(isAgentProcessGone(closed(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS), here), true);
  assert.equal(isAgentProcessGone(closed(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS), elsewhere), false,
    "another machine cannot tell a closed connection from a laptop asleep");
  assert.equal(isAgentProcessGone(closed(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS), { now_ms: nowMs, process_host_id: null }), false);
  assert.equal(isAgentProcessGone({ ...closed(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS), process_host_id: null }, { now_ms: nowMs, process_host_id: null }), false,
    "two unknown machines are not the same machine");
  assert.equal(isAgentProcessGone(closed(AGENT_PROCESS_GONE_AFTER_MS - 1), elsewhere), false);
  assert.equal(isAgentProcessGone(closed(AGENT_PROCESS_GONE_AFTER_MS), elsewhere), true);
  // The server moved `last_seen_at` afterwards, closing the agent's delivery
  // lease. The agent itself did nothing after its connection closed.
  const bookkept = { ...closed(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS), last_seen_at: ago(1_000) };
  assert.equal(isAgentProcessGone(bookkept, here), false, "with one time recorded, it is read the cautious way");
  assert.equal(isAgentProcessGone({ ...bookkept, agent_heard_at: ago(AGENT_PROCESS_GONE_ON_SAME_HOST_AFTER_MS) }, here), true);
  assert.equal(isAgentProcessGone({ ...bookkept, agent_heard_at: ago(2_000) }, here), false, "the agent made a call since");
  // It is waiting for messages on a connection that is open now.
  assert.equal(isAgentProcessGone({ ...closed(AGENT_PROCESS_GONE_AFTER_MS), delivery_connected: true }, here), false);
  // It said it was exiting. There is nothing to wait for, from anywhere.
  assert.equal(isAgentProcessGone({ ...closed(0), process_connection_id: AGENT_PROCESS_EXITED }, elsewhere), true);
});

test("a name passes on only from a session of the same owner whose process is gone", () => {
  const gone = {
    display_name: "MossDawn", owner_account_id: "acct_me", supervisor_grant_id: null, process_host_id: "host_a",
    process_seen_at: ago(AGENT_PROCESS_GONE_AFTER_MS), process_disconnected_at: null, last_seen_at: ago(AGENT_PROCESS_GONE_AFTER_MS),
  };
  const holders = [
    holder({ ...gone, agent_key: "me/gone", session_id: "gone" }),
    holder({ ...gone, agent_key: "me/respelled", session_id: "respelled", display_name: "moss dawn" }),
    holder({ ...gone, agent_key: "me/offline-durable", session_id: "offline-durable", ended_at: ago(AGENT_PROCESS_GONE_AFTER_MS) }),
    holder({ ...gone, agent_key: "me/mossdawn", session_id: "own-other-process", agent_instance_id: "process-1" }),
    holder({ ...gone, agent_key: "legacy/mossdawn", session_id: "keyed" }),
    // None of these give up the name.
    holder({ ...gone, agent_key: "me/quiet", session_id: "quiet", process_seen_at: ago(20_000) }),
    holder({ ...gone, agent_key: "me/older-client", session_id: "older-client", process_seen_at: null,
      agent_instance_id: `worker_${"a".repeat(32)}`, process_host_id: null }),
    holder({ ...gone, agent_key: "you/theirs", session_id: "theirs", owner_account_id: "acct_you" }),
    holder({ ...gone, agent_key: "me/supervised", session_id: "supervised", supervisor_grant_id: "grant_1" }),
    holder({ ...gone, agent_key: "me/other-name", session_id: "other-name", display_name: "CedarPeak" }),
    holder({ ...gone, agent_key: "me/mossdawn", session_id: "self", agent_instance_id: "process-2" }),
    holder({ ...gone, agent_key: "me/unknown-owner", session_id: "unknown-owner", owner_account_id: null }),
  ];
  const released = selectReleasableNameHolders({
    display_name: "MossDawn", owner_account_id: "acct_me", agent_key: "me/mossdawn",
    agent_instance_id: "process-2", process_host_id: "host_b", holders, now_ms: nowMs,
  });
  assert.deepEqual(
    released.map((entry) => entry.session_id).sort(),
    ["gone", "keyed", "offline-durable", "own-other-process", "respelled"],
  );
});
