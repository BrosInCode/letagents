import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import { z } from "zod";

import { ApiError, defineMethod, queryBool, queryInt } from "../../../shared/api/core.mjs";
import type { ApiCallerIdentifier, ApiRoomAccessResolver } from "../v1/context.js";

// The shared /api/v1 pipeline with stand-in caller and room steps: no database.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerApiV1Routes } = await import("../v1/router.js");
const { defineRoute, defineStreamRoute, withStatus } = await import("../v1/route.js");
const { createCapabilityCheck } = await import("../v1/capability.js");
type ApiActionRecord = import("../v1/actions.js").ApiActionRecord;

// The real capability check with the room policy stubbed: writes are denied in room "closed".
const checkCapability = createCapabilityCheck({
  resolvePolicy: async (roomId, capability) => {
    const mode = roomId === "closed" ? "deny" as const : "approve" as const;
    return { capability, mode, configured: mode, source: "room", rule: null };
  },
});
const recorded: ApiActionRecord[] = [];
const { createApiRateLimiter } = await import("../v1/rate-limit.js");
const { API_V1_ROUTES } = await import("../v1/areas.js");

const echo = defineMethod({
  name: "tasks.echo",
  area: "tasks",
  kind: "read",
  capability: "tasks.read",
  description: "Echoes its input.",
  path: "/rooms/:room/echo/:taskId",
  input: z.strictObject({ taskId: z.string(), limit: queryInt({ min: 1, max: 5, default: 2 }), full: queryBool().optional() }),
  output: z.object({ room: z.string(), taskId: z.string(), limit: z.number(), full: z.boolean().optional() }),
  errors: ["not_found"],
  rateClass: "read",
});
const propose = defineMethod({
  name: "tasks.proposeExample",
  area: "tasks",
  kind: "intent",
  capability: "tasks.propose",
  description: "Takes a JSON body.",
  path: "/rooms/:room/proposals",
  input: z.object({ title: z.string().min(1) }),
  output: z.object({ title: z.string() }),
  rateClass: "intent",
});
const watch = defineMethod({
  name: "tasks.watch",
  area: "tasks",
  kind: "read",
  capability: "tasks.read",
  description: "Streams task changes.",
  path: "/rooms/:room/watch",
  response: "stream",
  input: z.strictObject({ since: queryInt({ min: 0, max: 100 }).optional() }),
  output: z.object({ resource: z.string() }),
  rateClass: "read",
});

let mode: "ok" | "conflict" | "not_found" | "bad_output" | "crash" = "ok";
const routes = [
  defineRoute(echo, (input, call) => {
    if (mode === "not_found") throw new ApiError("not_found", "No such task.");
    if (mode === "conflict") throw new ApiError("conflict", "Not in the contract.");
    if (mode === "crash") throw new Error("database is down: secret detail");
    if (mode === "bad_output") return { room: call.actor.roomId, taskId: input.taskId } as never;
    // A field the output schema does not name never leaves the server.
    return { room: call.actor.roomId, taskId: input.taskId, limit: input.limit, full: input.full, secret: "token" } as never;
  }),
  defineRoute(propose, (input) => withStatus(201, { title: input.title })),
  defineStreamRoute(watch, async (input, call, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ resource: "tasks", room: call.actor.roomId, since: input.since ?? null })}\n\n`);
    if (mode === "crash") throw new Error("stream broke");
    res.end();
  }),
];

const identifyCaller: ApiCallerIdentifier = async (req) => {
  if (req.headers["x-test-user"] === undefined) return null;
  return {
    principal: { kind: "person", id: String(req.headers["x-test-user"]) },
    ...(req.headers["x-test-via"] ? { via: { kind: "page" as const, id: String(req.headers["x-test-via"]) } } : {}),
    account: null,
  };
};
let roomLookups = 0;
const resolveRoomAccess: ApiRoomAccessResolver = async (caller, roomParam) => {
  roomLookups += 1;
  if (roomParam === "elsewhere") throw new ApiError("not_participant", "You are not a participant in this room.");
  if (roomParam === "waiting") throw new ApiError("pending_approval", "This page version waits for a room admin.");
  return {
    actor: { principal: caller.principal, ...(caller.via ? { via: caller.via } : {}), roomId: roomParam },
    room: { id: roomParam } as never,
    access: { kind: "membership", accessRoomId: roomParam },
  };
};
const capabilityInputs: unknown[] = [];

let server: Server;
let base = "";
let now = 0;
test.before(async () => {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  registerApiV1Routes(app, {
    routes,
    identifyCaller,
    resolveRoomAccess,
    checkCapability: async (actor, method, input, call) => {
      capabilityInputs.push(input);
      await checkCapability(actor, method, input, call);
    },
    recordAction: async (record) => { recorded.push(record); },
    rateLimiter: createApiRateLimiter({ now: () => now, classes: { read: { limit: 3, windowMs: 10_000 }, search: { limit: 1, windowMs: 1 }, write: { limit: 1, windowMs: 1 }, post: { limit: 1, windowMs: 1 }, intent: { limit: 100, windowMs: 1 }, job: { limit: 1, windowMs: 1 } } }),
    strictContract: true,
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
test.after(() => server.close());
test.beforeEach(() => {
  mode = "ok";
  now += 60_000;
});

async function call(path: string, init: RequestInit & { user?: string | null; via?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.user !== null) headers.set("x-test-user", init.user ?? "acct_ada");
  if (init.via) headers.set("x-test-via", init.via);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
}

test("a read takes its input from the query and its path, and a room id with slashes arrives decoded", async () => {
  const room = encodeURIComponent("github.com/BrosInCode/letagents");
  assert.deepEqual(await call(`/rooms/${room}/echo/task_7?limit=4&full=true`), {
    status: 200, body: { room: "github.com/BrosInCode/letagents", taskId: "task_7", limit: 4, full: true }, retryAfter: null,
  });
  assert.deepEqual((await call("/rooms/r1/echo/task_7")).body, { room: "r1", taskId: "task_7", limit: 2 });
  // The capability check sees the parsed input, after the path params are merged.
  assert.deepEqual(capabilityInputs.at(-1), { taskId: "task_7", limit: 2 });
});

test("query numbers and booleans take only their exact text forms", async () => {
  assert.equal((await call("/rooms/r1/echo/t?limit=abc")).body.message, "limit: Expected a whole number from 1 to 5.");
  assert.equal((await call("/rooms/r1/echo/t?limit=")).body.message, "limit: Expected a whole number from 1 to 5.");
  assert.equal((await call("/rooms/r1/echo/t?full=yes")).body.message, "full: Expected true or false.");
  assert.equal((await call("/rooms/r1/echo/t?full=false", { user: "acct_query" })).body.full, false);
});

test("a JSON handler may answer 201, and the stream route hands over the response after the same checks", async () => {
  const created = await call("/rooms/r1/proposals", { method: "POST", body: '{"title":"Ship it"}', headers: { "content-type": "application/json" } });
  assert.deepEqual(created, { status: 201, body: { title: "Ship it" }, retryAfter: null });
  const res = await fetch(`${base}/rooms/r1/watch?since=3`, { headers: { "x-test-user": "acct_stream" } });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), `data: ${JSON.stringify({ resource: "tasks", room: "r1", since: 3 })}\n\n`);
  assert.deepEqual((await call("/rooms/r1/watch?since=-1")).body.code, "invalid_input");
  assert.equal((await call("/rooms/r1/watch", { via: "page_1" })).body.code, "not_granted");
  const quiet = test.mock.method(console, "error", () => {});
  try {
    mode = "crash";
    const broken = await fetch(`${base}/rooms/r1/watch`, { headers: { "x-test-user": "acct_stream" } });
    assert.equal(broken.status, 200, "the stream had started; it just ends");
    assert.match(await broken.text(), /^data: /);
  } finally {
    quiet.mock.restore();
  }
  assert.throws(() => defineRoute(watch as never, () => ({}) as never), /stream method; use defineStreamRoute/);
  assert.throws(() => defineStreamRoute(echo as never, async () => {}), /JSON method; use defineRoute/);
});

test("bad input is a 400 in the one error shape, naming the field", async () => {
  assert.deepEqual(await call("/rooms/r1/echo/task_7?limit=9"), {
    status: 400, body: { code: "invalid_input", message: "limit: Too big: expected number to be <=5" }, retryAfter: null,
  });
  assert.equal((await call("/rooms/r1/echo/task_7?lmit=1")).body.message, 'Unrecognized key: "lmit"');
  const post = (body: string) => call("/rooms/r1/proposals", { method: "POST", body, headers: { "content-type": "application/json" } });
  assert.deepEqual((await post('{"title":""}')).body.code, "invalid_input");
  assert.deepEqual(await post("[1]"), { status: 400, body: { code: "invalid_input", message: "The request body must be a JSON object." }, retryAfter: null });
  assert.deepEqual(await post("{oops"), { status: 400, body: { code: "invalid_input", message: "The request body is not valid JSON." }, retryAfter: null });
  assert.deepEqual((await post(JSON.stringify({ title: "x".repeat(2000) }))).body.code, "too_large");
});

test("caller and room refusals pass through: no sign-in 401, another room 403, any other code as is", async () => {
  assert.deepEqual(await call("/rooms/r1/echo/t", { user: null }), {
    status: 401, body: { code: "unauthenticated", message: "Sign in to LetAgents to use the API." }, retryAfter: null,
  });
  assert.equal((await call("/rooms/elsewhere/echo/t")).status, 403);
  // Pipeline refusals need no listing in the method's errors; only handler refusals do.
  assert.deepEqual((await call("/rooms/waiting/proposals", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).body, {
    code: "pending_approval", message: "This page version waits for a room admin.",
  });
});

test("every route checks the capability: a person and an agent pass reads, also through remote MCP; a page needs its grant", async () => {
  assert.equal((await call("/rooms/r1/echo/t")).status, 200);
  // No page grant on the request: the page holds nothing.
  assert.deepEqual(await call("/rooms/r1/echo/t", { via: "page_1" }), {
    status: 403, body: { code: "not_granted", message: 'This caller does not hold the "tasks.read" capability.' }, retryAfter: null,
  });
  const person = { kind: "person" as const, id: "acct_ada" };
  await checkCapability({ principal: person, via: { kind: "integration", id: "remote-mcp" }, roomId: "r1" }, echo, {}, {} as never);
  await checkCapability({ principal: { kind: "agent", id: "a/b" }, roomId: "r1" }, echo, {}, {} as never);
  const page = { principal: person, via: { kind: "page" as const, id: "page_1", version: 2 }, roomId: "r1" };
  const grant = { grant_id: "pgt_1", room_id: "r1", page_id: "page_1", page_version: 2, capabilities: ["tasks.read"], expires_at: "" };
  await checkCapability(page, echo, {}, { req: { pageGrant: grant } } as never);
  // The grant binds one page version in one room.
  for (const other of [{ page_version: 1 }, { room_id: "r2" }, { page_id: "page_2" }, { capabilities: ["rooms.read"] }]) {
    await assert.rejects(checkCapability(page, echo, {}, { req: { pageGrant: { ...grant, ...other } } } as never), /does not hold the "tasks.read" capability/);
  }
});

test("the policy covers every policy capability: deny refuses reads too; confirm or approve pass only to intents and jobs", async () => {
  const example = { area: "data", description: "An example.", path: "/rooms/:room/data-example", input: z.strictObject({}), output: z.object({}) } as const;
  const dataRead = defineMethod({ ...example, name: "data.readExample", kind: "read", capability: "data.room", rateClass: "read" });
  const dataWrite = defineMethod({ ...example, name: "data.writeExample", kind: "write", capability: "data.page", rateClass: "write" });
  const job = defineMethod({ ...example, area: "jobs", name: "jobs.startExample", kind: "job", capability: "jobs.start", rateClass: "job" });
  const person = (roomId: string) => ({ principal: { kind: "person" as const, id: "acct_ada" }, roomId });
  const fresh = () => ({ req: {} }) as never;
  await assert.rejects(checkCapability(person("closed"), dataRead, {}, fresh()), /does not allow "data\.room"/);
  await assert.rejects(checkCapability(person("r1"), dataWrite, {}, fresh()), /"data\.page" needs a room admin's approval, which this method cannot wait for/);
  await checkCapability(person("r1"), job, {}, fresh());
  // Room administration is a person's own: no agent, no page, no integration.
  const admin = defineMethod({ ...example, area: "rooms", name: "rooms.adminExample", kind: "write", capability: "rooms.admin", rateClass: "write" });
  await checkCapability(person("r1"), admin, {}, fresh());
  for (const actor of [
    { principal: { kind: "agent" as const, id: "a/b" }, roomId: "r1" },
    { ...person("r1"), via: { kind: "integration" as const, id: "remote-mcp" } },
    { ...person("r1"), via: { kind: "page" as const, id: "page_1", version: 1 } },
  ]) {
    await assert.rejects(checkCapability(actor, admin, {}, fresh()), /acting for themselves/);
  }
});

test("a write consults the room policy: deny refuses it, approve passes to the handler", async () => {
  const post = (room: string) => call(`/rooms/${room}/proposals`, { user: "acct_policy", method: "POST", body: '{"title":"a"}', headers: { "content-type": "application/json" } });
  assert.equal((await post("r1")).status, 201);
  assert.deepEqual((await post("closed")).body, {
    code: "not_granted", message: 'This room does not allow "tasks.propose" through the LetAgents API.',
  });
});

test("writes, intents and jobs are recorded with their actor and outcome, refusals after the room check included; reads are not", async () => {
  recorded.length = 0;
  await call("/rooms/r1/echo/t", { user: "acct_audit" });
  const post = (room: string, body: string) => call(`/rooms/${room}/proposals`, { user: "acct_audit", method: "POST", body, headers: { "content-type": "application/json" } });
  await post("r1", '{"title":"a"}');
  await post("r1", '{"title":""}');
  await post("closed", '{"title":"a"}');
  await post("elsewhere", '{"title":"a"}');
  assert.deepEqual(recorded.map(({ actor, method, capability, target, outcome }) => ({ principal: actor.principal.id, room: actor.roomId, method, capability, target, outcome })), [
    { principal: "acct_audit", room: "r1", method: "tasks.proposeExample", capability: "tasks.propose", target: null, outcome: "ok" },
    { principal: "acct_audit", room: "r1", method: "tasks.proposeExample", capability: "tasks.propose", target: null, outcome: "invalid_input" },
    { principal: "acct_audit", room: "closed", method: "tasks.proposeExample", capability: "tasks.propose", target: null, outcome: "not_granted" },
  ]);
});

test("the rate limit counts per actor and per class, and says when to retry", async () => {
  for (let i = 0; i < 3; i += 1) assert.equal((await call("/rooms/r1/echo/t", { user: "acct_rate" })).status, 200);
  now += 4_000;
  const lookups = roomLookups;
  assert.deepEqual(await call("/rooms/r1/echo/t", { user: "acct_rate" }), {
    status: 429, body: { code: "rate_limited", message: "Too many calls. Wait and try again.", retryAfterMs: 6_000 }, retryAfter: "6",
  });
  assert.equal(roomLookups, lookups, "a limited call does no room lookup");
  // One budget per caller across rooms.
  assert.equal((await call("/rooms/r2/echo/t", { user: "acct_rate" })).status, 429);
  assert.equal((await call("/rooms/r1/echo/t", { user: "acct_other" })).status, 200);
  assert.equal((await call("/rooms/r1/proposals", { user: "acct_rate", method: "POST", body: '{"title":"a"}', headers: { "content-type": "application/json" } })).status, 201);
});

test("handler errors: a listed code passes, an unlisted code or a crash is an internal error with no detail", async () => {
  // A fresh actor per call keeps the read limit out of this test.
  let caller = 0;
  const request = (path: string) => call(path, { user: `acct_errors_${caller++}` });
  mode = "not_found";
  assert.deepEqual((await request("/rooms/r1/echo/t")).body, { code: "not_found", message: "No such task." });
  const quiet = test.mock.method(console, "error", () => {});
  try {
    mode = "conflict";
    assert.deepEqual(await request("/rooms/r1/echo/t"), {
      status: 500, body: { code: "internal", message: "The server could not complete this call. Please retry." }, retryAfter: null,
    });
    mode = "crash";
    assert.equal(JSON.stringify((await request("/rooms/r1/echo/t")).body).includes("secret"), false);
    mode = "bad_output";
    assert.equal((await request("/rooms/r1/echo/t")).status, 500);
    assert.match(String(quiet.mock.calls.at(-1)?.arguments[1]), /Contract mismatch: tasks\.echo returned output that does not match its contract/);
  } finally {
    quiet.mock.restore();
  }
});

test("an unknown path under /api/v1 is a 404 in the error shape", async () => {
  assert.deepEqual(await call("/rooms/r1/nothing-here"), {
    status: 404, body: { code: "not_found", message: "No LetAgents API method answers GET /api/v1/rooms/r1/nothing-here." }, retryAfter: null,
  });
});

test("the mount list holds every route once, each for a contract method", () => {
  const names = API_V1_ROUTES.map((route) => route.method.name);
  assert.ok(names.includes("rooms.get"));
  assert.equal(new Set(names).size, names.length);
});

test("the rate limiter drops the oldest window when it is full", () => {
  let t = 0;
  const limiter = createApiRateLimiter({ now: () => t, maxEntries: 2, classes: { read: { limit: 1, windowMs: 1_000 } } as never });
  assert.equal(limiter.take("a", "read").allowed, true);
  assert.equal(limiter.take("a", "read").allowed, false);
  t = 10;
  assert.equal(limiter.take("b", "read").allowed, true);
  assert.equal(limiter.take("c", "read").allowed, true);
  assert.equal(limiter.size, 2);
  // "a" was the oldest window and was dropped, so it starts again.
  assert.equal(limiter.take("a", "read").allowed, true);
  assert.equal(limiter.take("c", "read").allowed, false, "c stays limited");
});
