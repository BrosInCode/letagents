import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { readFileSync } from "node:fs";

import {
  buildContractSnapshot,
  buildGeneratedFiles,
  emitContractDeclarations,
  findBreakingChanges,
  readBaseSnapshot,
  readSnapshot,
  staleDeclarations,
  staleGeneratedFiles,
  staleSnapshotAreas,
} from "./build-api-contracts.mjs";
import { defineMethod, toJsonSchema } from "../shared/api/core.mjs";
import { API_METHODS } from "../shared/api/index.mjs";
import { PAGE_MANIFEST_SCRIPT_TYPE } from "../shared/api/manifest.mjs";
import {
  PAGE_AREA_HELPERS,
  PAGE_AREA_WATCHES,
  PAGE_CHANGE_RESOURCES,
  PAGE_CONFIRMED_METHODS,
  PAGE_THEME_TOKEN_NAMES,
  PAGE_WATCH_LIMITS,
  PAGE_WATCHABLE_READS,
  pageMethods,
  pageReference,
} from "../shared/api/page-reference.mjs";

test("the checked-in contract declarations match the contract", () => {
  const stale = staleDeclarations(emitContractDeclarations());
  assert.deepEqual(stale, [], `Stale declarations: ${stale.join(", ")}. Run node scripts/build-api-contracts.mjs.`);
});

test("the checked-in contract snapshot matches the contract", async () => {
  const stale = staleSnapshotAreas(await buildContractSnapshot());
  assert.deepEqual(stale, [], `Stale snapshot areas: ${stale.join(", ")}. Run node scripts/build-api-contracts.mjs.`);
});

test("the generated agent tool list and page reference match the contract", async () => {
  const stale = staleGeneratedFiles(await buildGeneratedFiles());
  assert.deepEqual(stale, [], `Stale files: ${stale.join(", ")}. Run node scripts/build-api-contracts.mjs.`);
});

test("the page reference names every method a page can call, and no page management", () => {
  const reference = pageReference();
  const callable = pageMethods();
  assert.ok(callable.length >= 14);
  for (const method of callable) assert.ok(reference.includes(`\`${method.name}(`), method.name);
  for (const method of API_METHODS.filter((m) => m.area === "pages" || m.capability === "rooms.admin")) {
    assert.equal(reference.includes(`\`${method.name}(`), false, `${method.name} is not for pages`);
  }
  assert.ok(reference.includes(`<script type="${PAGE_MANIFEST_SCRIPT_TYPE}">`));
  for (const words of ["ui.open", "ui.copy", "ui.theme", "ui.context", "No network", "data:", "declined"]) assert.ok(reference.includes(words), words);
});

test("the page reference names the theme variables the desktop sets", () => {
  // Read as text: the desktop module imports Electron.
  const policy = readFileSync(new URL("../apps/desktop/electron/main/pages/page-policy.ts", import.meta.url), "utf8");
  const light = policy.slice(policy.indexOf("light: {"), policy.indexOf("dark: {"));
  assert.deepEqual([...light.matchAll(/"(--la-[a-z-]+)":/g)].map((match) => match[1]), [...PAGE_THEME_TOKEN_NAMES]);
});

/**
 * A desktop source file as text: the preload runs sandboxed and main imports
 * Electron, so neither can import the shared tables or be imported here.
 * @param {string} file
 */
function desktopSource(file) {
  return readFileSync(new URL(`../apps/desktop/electron/${file}`, import.meta.url), "utf8");
}

/**
 * The text of the statement that declares `name`, up to its closing `;`.
 * @param {string} source
 * @param {string} name
 */
function declaration(source, name) {
  const start = source.indexOf(`const ${name}`);
  assert.ok(start >= 0, `no ${name}`);
  return source.slice(start, source.indexOf(";\n", start));
}

test("the page reference names every use(area) helper the desktop preload offers, and only those", () => {
  const preload = desktopSource("page-preload.cts");
  const areas = Object.fromEntries([...declaration(preload, "AREAS").matchAll(/^ {2}(\w+): \{(.*)\},$/gm)].map(([, area, body]) => [
    area,
    Object.fromEntries([...body.matchAll(/(\w+): "([\w.]+)"/g)].map(([, local, method]) => [local, method])),
  ]));
  assert.deepEqual(areas, PAGE_AREA_HELPERS);
  const watches = Object.fromEntries([...declaration(preload, "AREA_WATCHES").matchAll(/^ {2}(\w+): \["(\w+)", "([\w.]+)"\],$/gm)]
    .map(([, area, local, method]) => [area, [local, method]]));
  assert.deepEqual(watches, PAGE_AREA_WATCHES);

  const reference = pageReference();
  const callable = new Set(pageMethods().map((method) => method.name));
  for (const [area, local] of Object.entries(PAGE_AREA_HELPERS)) {
    assert.ok(reference.includes(`\`use("${area}")\``), area);
    for (const [name, method] of Object.entries(local)) {
      assert.ok(callable.has(method), `use("${area}").${name} calls ${method}, which a page cannot call`);
      assert.match(reference, new RegExp(`use\\("${area}"\\)\`:[^\\n]*\`${name}\``), `use("${area}").${name}`);
    }
  }
  const collection = preload.slice(preload.indexOf("function collection("), preload.indexOf("function area("));
  for (const [, local] of collection.matchAll(/^ {4}(\w+): /gm)) assert.ok(reference.includes(`\`${local}(`), `collection ${local}`);
  for (const words of ["use(\"data\").collection(scope, name)", "cb(result, error)", "letagents.watch(", "letagents.events.onChange("]) {
    assert.ok(reference.includes(words), words);
  }
});

test("the page reference states the desktop's watch, change and confirm rules", () => {
  const watch = desktopSource("main/pages/page-watch.ts");
  const watchable = [...declaration(watch, "PAGE_WATCHABLE_METHODS").matchAll(/^ {2}"([\w.]+)": \{ resources: \[[^\]]*\], pollMs: ([\d_]+|null) \}/gm)];
  assert.deepEqual(watchable.map(([, method]) => method), [...PAGE_WATCHABLE_READS]);
  for (const [, method, poll] of watchable) {
    const expected = method.startsWith("work_items.") ? String(PAGE_WATCH_LIMITS.workItemPollMs) : "null";
    assert.equal(poll.replaceAll("_", ""), expected, method);
  }
  assert.match(watch, new RegExp(`PAGE_WATCH_DEBOUNCE_MS = ${PAGE_WATCH_LIMITS.debounceMs};`));
  assert.match(watch, new RegExp(`MAX_PAGE_WATCHES = ${PAGE_WATCH_LIMITS.maxWatches};`));
  assert.deepEqual([...declaration(watch, "PAGE_RELAY_RESOURCES").matchAll(/"(\w+)"/g)].map(([, resource]) => resource), [...PAGE_CHANGE_RESOURCES]);
  const confirmed = declaration(desktopSource("main/pages/page-bridge.ts"), "CONFIRMED_METHODS");
  assert.deepEqual([...confirmed.matchAll(/^ {2}"([\w.]+)":/gm)].map(([, method]) => method), [...PAGE_CONFIRMED_METHODS]);
});

test("the agents flag is checked against the method kind, and a removed or changed flag breaks the contract", () => {
  const base = { area: "rooms", capability: "rooms.read", description: "x", path: "/rooms/:room/x", input: z.strictObject({}), output: z.object({}) };
  assert.throws(() => defineMethod({ ...base, name: "rooms.x", kind: "read", rateClass: "read", agents: "write" }), /agents: "read" is for a read/);
  assert.throws(() => defineMethod({ ...base, name: "rooms.y", kind: "write", rateClass: "write", agents: "read" }), /agents: "read" is for a read/);
  assert.throws(() => defineMethod({ ...base, name: "rooms.z", kind: "read", rateClass: "read", agents: "maybe" }), /unknown agent access/);
  assert.equal(defineMethod({ ...base, name: "rooms.w", kind: "read", rateClass: "read" }).agents, undefined);
  const flagged = snapshotOf(z.object({}), z.object({}), { agents: "read" });
  assert.deepEqual(findBreakingChanges(snapshotOf(z.object({}), z.object({})), flagged), [], "adding the flag is an addition");
  assert.deepEqual(findBreakingChanges(flagged, snapshotOf(z.object({}), z.object({}))), ["rooms.example: agents changed from \"read\" to null."]);
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
