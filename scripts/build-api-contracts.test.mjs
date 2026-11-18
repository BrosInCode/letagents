import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import {
  buildContractSnapshot,
  emitContractDeclarations,
  findBreakingChanges,
  readBaseSnapshot,
  readSnapshot,
  staleDeclarations,
  staleSnapshotAreas,
} from "./build-api-contracts.mjs";
import { toJsonSchema } from "../shared/api/core.mjs";

test("the checked-in contract declarations match the contract", () => {
  const stale = staleDeclarations(emitContractDeclarations());
  assert.deepEqual(stale, [], `Stale declarations: ${stale.join(", ")}. Run node scripts/build-api-contracts.mjs.`);
});

test("the checked-in contract snapshot matches the contract", async () => {
  const stale = staleSnapshotAreas(await buildContractSnapshot());
  assert.deepEqual(stale, [], `Stale snapshot areas: ${stale.join(", ")}. Run node scripts/build-api-contracts.mjs.`);
});

test("the contract has no breaking change against the snapshot", async () => {
  assert.deepEqual(findBreakingChanges(readSnapshot(), await buildContractSnapshot()), []);
});

// The checked-in snapshot can be refreshed with --allow-breaking; the one on
// the base branch cannot be changed from a feature branch.
test("the contract has no breaking change against the base branch's snapshot", async (t) => {
  const base = readBaseSnapshot();
  if ("missing" in base) {
    t.skip(base.missing);
    return;
  }
  assert.deepEqual(findBreakingChanges(base.snapshot, await buildContractSnapshot()), []);
});

test("the base snapshot is read from git, and a missing ref is reported, not thrown", () => {
  const head = readBaseSnapshot("HEAD");
  assert.ok("snapshot" in head && head.snapshot.rooms["rooms.get"]);
  const missing = readBaseSnapshot("refs/heads/no-such-branch-for-api-contracts");
  assert.match("missing" in missing ? missing.missing : "", /is not in this clone/);
});

// A one-method snapshot from zod schemas, the way the build script stores it.
function snapshotOf(input, output, extra = {}) {
  const schemas = { ...toJsonSchema({ input, output }), ...(extra.schemas ?? {}) };
  delete extra.schemas;
  return {
    rooms: {
      "rooms.example": { kind: "read", capability: "rooms.read", httpMethod: "GET", path: "/rooms/:room", rateClass: "read", ...extra, ...schemas },
    },
  };
}

const baseInput = z.object({ q: z.string().max(100), limit: z.number().int().min(1).max(50).optional(), state: z.enum(["open", "closed"]).optional() });
const baseOutput = z.object({ id: z.string(), title: z.string(), state: z.enum(["open", "closed"]), url: z.string().nullable() });
const before = snapshotOf(baseInput, baseOutput);

test("additions pass: a new method, a new optional input field, a new output field, a new enum value", () => {
  const after = snapshotOf(
    baseInput.extend({ cursor: z.string().optional(), state: z.enum(["open", "closed", "draft"]).optional() }),
    baseOutput.extend({ labels: z.array(z.string()), state: z.enum(["open", "closed", "draft"]) }),
  );
  after.rooms["rooms.other"] = after.rooms["rooms.example"];
  assert.deepEqual(findBreakingChanges(before, after), []);
});

test("a removed method or a changed route breaks the contract", () => {
  assert.deepEqual(findBreakingChanges(before, { rooms: {} }), ["rooms.example: the method was removed."]);
  assert.deepEqual(findBreakingChanges(before, snapshotOf(baseInput, baseOutput, { path: "/rooms/:room/x" })), [
    'rooms.example: path changed from "/rooms/:room" to "/rooms/:room/x".',
  ]);
});

test("a removed field breaks the contract, in input and in output", () => {
  const after = snapshotOf(baseInput.omit({ limit: true }), baseOutput.omit({ title: true }));
  assert.deepEqual(findBreakingChanges(before, after), [
    "rooms.example input.limit: the field was removed.",
    "rooms.example output.title: the field was removed.",
  ]);
});

test("a narrowed input breaks the contract: new required field, tighter limit, fewer enum values, other type", () => {
  const after = snapshotOf(
    baseInput.extend({ q: z.string().max(50), limit: z.string().optional(), state: z.enum(["open"]).optional(), room: z.string() }),
    baseOutput,
  );
  assert.deepEqual(findBreakingChanges(before, after), [
    "rooms.example input.q: maxLength was lowered to 50.",
    "rooms.example input.limit: the type integer is no longer accepted.",
    'rooms.example input.state: the values ["closed"] are no longer accepted.',
    "rooms.example input.room: a new required field.",
  ]);
});

test("an output field that becomes optional, nullable or another type breaks the contract", () => {
  const after = snapshotOf(baseInput, baseOutput.extend({ id: z.string().optional(), title: z.string().nullable(), state: z.number() }));
  assert.deepEqual(findBreakingChanges(before, after), [
    "rooms.example output.id: is no longer always present.",
    "rooms.example output.title: can now be null.",
    "rooms.example output.state: the type number is now returned.",
  ]);
});

test("widening an input and narrowing an output pass", () => {
  const after = snapshotOf(
    baseInput.extend({ q: z.string().max(200).optional(), state: z.string().optional() }),
    baseOutput.extend({ url: z.string(), state: z.enum(["open"]) }),
  );
  assert.deepEqual(findBreakingChanges(before, after), []);
});

test("a changed rate class or response kind breaks the contract; a snapshot without a response kind means json", () => {
  assert.deepEqual(findBreakingChanges(before, snapshotOf(baseInput, baseOutput, { rateClass: "search" })), [
    'rooms.example: rateClass changed from "read" to "search".',
  ]);
  assert.deepEqual(findBreakingChanges(before, snapshotOf(baseInput, baseOutput, { response: "json" })), []);
  assert.deepEqual(findBreakingChanges(before, snapshotOf(baseInput, baseOutput, { response: "stream" })), [
    'rooms.example: response changed from "json" to "stream".',
  ]);
});

test("references into $defs are followed, recursive ones too", () => {
  const output = (taskProperties, required) => ({
    type: "object",
    properties: { task: { $ref: "#/$defs/Task" } },
    required: ["task"],
    $defs: { Task: { type: "object", properties: { ...taskProperties, parent: { anyOf: [{ $ref: "#/$defs/Task" }, { type: "null" }] } }, required } },
  });
  const old = snapshotOf(baseInput, baseOutput, { schemas: { output: output({ id: { type: "string" }, title: { type: "string" } }, ["id", "title", "parent"]) } });
  const added = snapshotOf(baseInput, baseOutput, { schemas: { output: output({ id: { type: "string" }, title: { type: "string" }, url: { type: "string" } }, ["id", "title", "parent", "url"]) } });
  const removed = snapshotOf(baseInput, baseOutput, { schemas: { output: output({ id: { type: "string" } }, ["id", "parent"]) } });
  assert.deepEqual(findBreakingChanges(old, added), []);
  assert.deepEqual(findBreakingChanges(old, removed), ["rooms.example output.task.title: the field was removed."]);
});
