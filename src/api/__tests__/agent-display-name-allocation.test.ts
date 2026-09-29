import assert from "node:assert/strict";
import test from "node:test";

import {
  agentDisplayNameKey,
  allocateAgentDisplayName,
  isNameHeldByAnotherAgent,
  resolveSupervisedWorkerDisplayName,
  type RoomWorkerNameHolder,
} from "../rooms/agent-display-name-allocation.js";

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
