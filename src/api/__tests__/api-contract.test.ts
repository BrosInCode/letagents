import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { ApiActor, actorKey } from "../../../shared/api/actor.mjs";
import { CAPABILITIES, CAPABILITY_NAMES, isCapabilityName } from "../../../shared/api/capabilities.mjs";
import {
  API_AREAS,
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  ApiError,
  defineMethod,
  methodMayReturn,
  queryBool,
  queryInputProblems,
  queryInt,
  toJsonSchema,
} from "../../../shared/api/core.mjs";
import { API_METHODS, assertUniqueMethods, getApiMethod } from "../../../shared/api/index.mjs";
import { parsePageManifest } from "../../../shared/api/manifest.mjs";

const spec = {
  name: "rooms.example",
  area: "rooms",
  kind: "read",
  capability: "rooms.read",
  description: "An example read.",
  path: "/rooms/:room/examples/:exampleId",
  input: z.strictObject({ exampleId: z.string() }),
  output: z.object({ id: z.string() }),
  rateClass: "read",
} as const;

test("defineMethod fills the HTTP verb from the kind and freezes the method", () => {
  const read = defineMethod(spec);
  assert.equal(read.httpMethod, "GET");
  assert.equal(read.response, "json");
  assert.equal(defineMethod({ ...spec, response: "stream" }).response, "stream");
  assert.deepEqual(read.errors, []);
  assert.ok(Object.isFrozen(read));
  const intent = defineMethod({ ...spec, name: "rooms.propose", kind: "intent", path: "/rooms/:room/examples/:exampleId/proposals" });
  assert.equal(intent.httpMethod, "POST");
});

test("defineMethod refuses a method that the server could not route or check", () => {
  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ name: "getRoom" }, /look like "<area>\.<verb>"/],
    [{ name: "tasks.get" }, /must start with its area, "rooms\."/],
    [{ area: "tickets", name: "tickets.get" }, /unknown area/],
    [{ capability: "rooms.write" }, /unknown capability "rooms\.write"/],
    [{ description: " " }, /a description is required/],
    [{ rateClass: "burst" }, /unknown rate class/],
    [{ path: "/examples/:exampleId" }, /must start with "\/rooms\/:room"/],
    [{ path: "/rooms/:room/examples/:id" }, /":id" must be a field of the input object/],
    [{ httpMethod: "POST" }, /a read is a GET/],
    [{ errors: ["teapot"] }, /unknown error code "teapot"/],
    [{ response: "html" }, /unknown response kind "html"/],
    [{ input: { parse() {} } }, /must be zod schemas/],
  ];
  for (const [change, message] of refused) {
    assert.throws(() => defineMethod({ ...spec, ...change } as never), message, JSON.stringify(change));
  }
});

test("every method in the contract is unique, described and has JSON Schema for MCP", () => {
  assert.ok(API_METHODS.length > 0);
  assert.equal(getApiMethod("rooms.get")?.capability, "rooms.read");
  for (const method of API_METHODS) {
    assert.ok(API_AREAS.includes(method.area));
    const schema = toJsonSchema(method);
    assert.equal(schema.input.type, "object", `${method.name} input is an object`);
    assert.ok(schema.output);
  }
  const read = defineMethod(spec);
  assert.throws(() => assertUniqueMethods([read, read]), /Two API methods are named "rooms\.example"/);
  assert.throws(
    () => assertUniqueMethods([read, defineMethod({ ...spec, name: "rooms.other", path: "/rooms/:room/examples/:exampleId" })]),
    /"rooms\.example" and "rooms\.other" overlap/,
  );
  // A fixed segment where another route has a parameter: "search" is also an example id.
  const search = defineMethod({ ...spec, name: "rooms.search", path: "/rooms/:room/examples/search", input: z.strictObject({}) });
  assert.throws(() => assertUniqueMethods([read, search]), /overlap: GET \/rooms\/:room\/examples\/:exampleId and \/rooms\/:room\/examples\/search/);
  // Another verb, another length or another fixed segment does not overlap.
  assertUniqueMethods([read, defineMethod({ ...search, name: "rooms.searchPost", kind: "intent", httpMethod: "POST" })]);
  assertUniqueMethods([read, defineMethod({ ...search, name: "rooms.searchAll", path: "/rooms/:room/examples/search/all" })]);
  assertUniqueMethods([read, defineMethod({ ...search, name: "rooms.searchOther", path: "/rooms/:room/searches/:exampleId", input: spec.input })]);
});

test("a GET or DELETE input takes numbers and booleans only through queryInt and queryBool", () => {
  const withInput = (input: z.ZodType, httpMethod?: "DELETE" | "POST") =>
    defineMethod({ ...spec, name: "rooms.query", path: "/rooms/:room/query", kind: httpMethod === "POST" ? "intent" : httpMethod ? "write" : "read", httpMethod, input });
  assert.deepEqual(queryInputProblems(withInput(z.strictObject({
    a: z.number(), b: z.coerce.number().optional(), c: z.boolean().default(false), d: z.array(z.number()), e: z.string(),
  }))), [
    'rooms.query: the query field "a" is a plain number; use queryInt() or queryBool().',
    'rooms.query: the query field "b" is a plain number; use queryInt() or queryBool().',
    'rooms.query: the query field "c" is a plain boolean; use queryInt() or queryBool().',
    'rooms.query: the query field "d" is a plain number; use queryInt() or queryBool().',
  ]);
  assert.equal(queryInputProblems(withInput(z.strictObject({ n: z.number() }), "DELETE")).length, 1);
  assert.deepEqual(queryInputProblems(withInput(z.strictObject({ n: z.number() }), "POST")), [], "a JSON body keeps its numbers");
  const fine = z.strictObject({ limit: queryInt({ min: 1, max: 100, default: 20 }), open: queryBool().optional(), all: queryBool({ default: false }) });
  assert.deepEqual(queryInputProblems(withInput(fine)), []);
  assert.deepEqual(fine.parse({ limit: "5", open: "true" }), { limit: 5, open: true, all: false });
  assert.deepEqual(fine.parse({ limit: 5, open: false, all: true }), { limit: 5, open: false, all: true });
  assert.equal(fine.safeParse({ limit: "5.5" }).success, false);
  assert.equal(fine.safeParse({ open: "1" }).success, false);
  for (const method of API_METHODS) assert.deepEqual(queryInputProblems(method), [], method.name);
});

test("the capability registry has every capability the plan names, with a label and a default policy", () => {
  assert.deepEqual([...CAPABILITY_NAMES].sort(), [
    "agents.read", "data.page", "data.room", "data.viewer", "git.read", "jobs.read", "jobs.start", "memory.read", "messages.post",
    "messages.read", "people.read", "planning.read", "rooms.read", "tasks.propose", "tasks.read", "tickets.propose", "work_items.read",
  ]);
  for (const name of CAPABILITY_NAMES) assert.ok(CAPABILITIES[name].label.length > 10, name);
  // The plan's default table.
  assert.equal(CAPABILITIES["tasks.read"].defaultPolicy, "allow");
  assert.equal(CAPABILITIES["data.room"].defaultPolicy, "allow");
  assert.equal(CAPABILITIES["tasks.propose"].policyRule, "board_manager_mode");
  assert.equal(CAPABILITIES["tickets.propose"].policyRule, "own_tracker_connection");
  assert.equal(CAPABILITIES["jobs.start"].defaultPolicy, "confirm");
  assert.equal(CAPABILITIES["messages.post"].defaultPolicy, "confirm");
  assert.deepEqual(CAPABILITY_NAMES.filter((name) => CAPABILITIES[name].writeLike).sort(), ["jobs.start", "messages.post", "tasks.propose", "tickets.propose"]);
  assert.equal(isCapabilityName("tasks.read"), true);
  assert.equal(isCapabilityName("toString"), false);
});

test("the error shape has a status for every code and survives a round trip", () => {
  for (const code of API_ERROR_CODES) assert.equal(typeof API_ERROR_HTTP_STATUS[code], "number", code);
  const error = new ApiError("rate_limited", "Too many calls.", { retryAfterMs: 1500 });
  assert.equal(error.status, 429);
  assert.deepEqual(error.toBody(), { code: "rate_limited", message: "Too many calls.", retryAfterMs: 1500 });
  assert.deepEqual(ApiError.fromBody(error.toBody()).toBody(), error.toBody());
  assert.deepEqual(new ApiError("not_found", "Gone.").toBody(), { code: "not_found", message: "Gone." });
  assert.equal(ApiError.fromBody({ error: "old shape" }).code, "internal");
  const method = defineMethod({ ...spec, errors: ["not_found"] });
  assert.equal(methodMayReturn(method, "not_found"), true);
  assert.equal(methodMayReturn(method, "rate_limited"), true);
  assert.equal(methodMayReturn(method, "conflict"), false);
});

test("an actor has a principal, an optional via and a room; each via is its own actor for limits", () => {
  const person = ApiActor.parse({ principal: { kind: "person", id: "acct_1", login: "ada" }, roomId: "room-1" });
  const viaPage = ApiActor.parse({ ...person, via: { kind: "page", id: "page_9", version: 3 } });
  assert.notEqual(actorKey(person), actorKey(viaPage));
  assert.equal(ApiActor.safeParse({ principal: { kind: "robot", id: "x" }, roomId: "r" }).success, false);
  assert.equal(ApiActor.safeParse({ ...person, via: { kind: "page", id: "p", version: 0 } }).success, false);
});

test("the Schedule Hub manifest from the plan parses, with defaults filled in", () => {
  const parsed = parsePageManifest(`{ "api": 1,
    "title": "Schedule Hub",
    "surfaces": ["room.tab"],
    "capabilities": ["work_items.read", "planning.read", "data.page", "data.viewer", "jobs.start"],
    "workItemFields": ["customfield_10027"],
    "collections": { "page": ["mos_items", "leave"], "viewer": ["prefs"] },
    "owner": "room" }`);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.manifest.collections, { page: ["mos_items", "leave"], viewer: ["prefs"] });
  const minimal = parsePageManifest({ api: 1, title: "Review queue", surfaces: ["room.tab"] });
  assert.ok(minimal.ok);
  assert.deepEqual(minimal.manifest, {
    api: 1, title: "Review queue", surfaces: ["room.tab"], capabilities: [], workItemFields: [], collections: {}, owner: "room",
  });
});

test("a wrong manifest gets one error per problem, with the field path", () => {
  const parsed = parsePageManifest({
    api: 2, title: "  ", surfaces: [], capabilities: ["tickets.write", "git.read", "git.read"], collections: { team: [] }, theme: "dark",
  });
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.ok ? [] : parsed.errors, [
    { path: "api", message: "\"api\" must be 1, the API version this page was written for." },
    { path: "title", message: "A title is required." },
    { path: "surfaces", message: "Name at least one surface, for example \"room.tab\"." },
    { path: "capabilities[0]", message: `Unknown capability "tickets.write". Known capabilities: ${CAPABILITY_NAMES.join(", ")}.` },
    { path: "capabilities", message: "Capabilities must not repeat." },
    { path: "collections", message: "Unrecognized key: \"team\". Known keys: viewer, page, room." },
    { path: "", message: "Unrecognized key: \"theme\". Known keys: api, title, surfaces, capabilities, workItemFields, collections, owner." },
  ]);
  const needsCapability = parsePageManifest({
    api: 1, title: "Notes", surfaces: ["room.tab"], collections: { room: ["notes"] }, workItemFields: ["customfield_1"],
  });
  assert.deepEqual(needsCapability.ok ? [] : needsCapability.errors, [
    { path: "collections.room", message: "Collections in the \"room\" scope need the \"data.room\" capability." },
    { path: "workItemFields", message: "workItemFields needs the \"work_items.read\" capability." },
  ]);
  assert.deepEqual(parsePageManifest("[1]"), { ok: false, errors: [{ path: "", message: "The manifest must be a JSON object." }] });
  assert.equal(parsePageManifest("{nope").ok, false);
});
