import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import { z } from "zod";

import { ApiError, defineMethod } from "../../../shared/api/core.mjs";
import type { ApiActorResolver } from "../v1/context.js";

// The shared /api/v1 pipeline with a stand-in actor resolver: no database.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerApiV1Routes } = await import("../v1/router.js");
const { defineRoute } = await import("../v1/route.js");
const { createApiRateLimiter } = await import("../v1/rate-limit.js");
const { API_V1_ROUTES } = await import("../v1/areas.js");
const { createCapabilityCheck } = await import("../v1/capability.js");
type ApiActionRecord = import("../v1/actions.js").ApiActionRecord;

const echo = defineMethod({
  name: "tasks.echo",
  area: "tasks",
  kind: "read",
  capability: "tasks.read",
  description: "Echoes its input.",
  path: "/rooms/:room/echo/:taskId",
  input: z.strictObject({ taskId: z.string(), limit: z.coerce.number().int().min(1).max(5).default(2) }),
  output: z.object({ room: z.string(), taskId: z.string(), limit: z.number() }),
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

let mode: "ok" | "conflict" | "not_found" | "bad_output" | "crash" = "ok";
const routes = [
  defineRoute(echo, (input, call) => {
    if (mode === "not_found") throw new ApiError("not_found", "No such task.");
    if (mode === "conflict") throw new ApiError("conflict", "Not in the contract.");
    if (mode === "crash") throw new Error("database is down: secret detail");
    if (mode === "bad_output") return { room: call.actor.roomId, taskId: input.taskId } as never;
    return { room: call.actor.roomId, taskId: input.taskId, limit: input.limit };
  }),
  defineRoute(propose, (input) => ({ title: input.title })),
];

const resolveActor: ApiActorResolver = async (req, roomParam) => {
  if (req.headers["x-test-user"] === undefined) throw new ApiError("unauthenticated", "Sign in to LetAgents to use the API.");
  if (roomParam === "elsewhere") throw new ApiError("not_participant", "You are not a participant in this room.");
  if (roomParam === "waiting") throw new ApiError("pending_approval", "This page version waits for a room admin.");
  return {
    actor: {
      principal: { kind: "person", id: String(req.headers["x-test-user"]) },
      ...(req.headers["x-test-via"] ? { via: { kind: "page" as const, id: String(req.headers["x-test-via"]) } } : {}),
      roomId: roomParam,
    },
    room: { id: roomParam } as never,
    access: { kind: "membership", accessRoomId: roomParam },
    account: null,
  };
};

// The room policy without a database: "proposals" is denied in room "closed".
const recorded: ApiActionRecord[] = [];
const checkCapability = createCapabilityCheck({
  resolvePolicy: async (roomId, capability) => {
    const mode = roomId === "closed" ? "deny" as const : "approve" as const;
    return { capability, mode, configured: mode, source: "room", rule: null };
  },
});

let server: Server;
let base = "";
let now = 0;
test.before(async () => {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  registerApiV1Routes(app, {
    routes,
    resolveActor,
    checkCapability,
    recordAction: async (record) => { recorded.push(record); },
    rateLimiter: createApiRateLimiter({ now: () => now, classes: { read: { limit: 3, windowMs: 10_000 }, search: { limit: 1, windowMs: 1 }, write: { limit: 1, windowMs: 1 }, post: { limit: 1, windowMs: 1 }, intent: { limit: 100, windowMs: 1 }, job: { limit: 1, windowMs: 1 } } }),
    checkOutput: true,
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
  assert.deepEqual(await call(`/rooms/${room}/echo/task_7?limit=4`), {
    status: 200, body: { room: "github.com/BrosInCode/letagents", taskId: "task_7", limit: 4 }, retryAfter: null,
  });
  assert.deepEqual((await call("/rooms/r1/echo/task_7")).body, { room: "r1", taskId: "task_7", limit: 2 });
});

test("bad input is a 400 in the one error shape, naming the field", async () => {
  assert.deepEqual(await call("/rooms/r1/echo/task_7?limit=9"), {
    status: 400, body: { code: "invalid_input", message: "limit: Too big: expected number to be <=5" }, retryAfter: null,
  });
  assert.equal((await call("/rooms/r1/echo/task_7?lmit=1")).body.message, 'Unrecognized key: "lmit"');
  const post = (body: string) => call("/rooms/r1/proposals", { method: "POST", body, headers: { "content-type": "application/json" } });
  assert.deepEqual((await post('{"title":"Ship it"}')).body, { title: "Ship it" });
  assert.deepEqual((await post('{"title":""}')).body.code, "invalid_input");
  assert.deepEqual(await post("[1]"), { status: 400, body: { code: "invalid_input", message: "The request body must be a JSON object." }, retryAfter: null });
  assert.deepEqual(await post("{oops"), { status: 400, body: { code: "invalid_input", message: "The request body is not valid JSON." }, retryAfter: null });
  assert.deepEqual((await post(JSON.stringify({ title: "x".repeat(2000) }))).body.code, "too_large");
});

test("the actor resolver's refusals pass through: no sign-in 401, another room 403, any other code as is", async () => {
  assert.deepEqual(await call("/rooms/r1/echo/t", { user: null }), {
    status: 401, body: { code: "unauthenticated", message: "Sign in to LetAgents to use the API." }, retryAfter: null,
  });
  assert.equal((await call("/rooms/elsewhere/echo/t")).status, 403);
  // Pipeline refusals need no listing in the method's errors; only handler refusals do.
  assert.deepEqual((await call("/rooms/waiting/proposals", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).body, {
    code: "pending_approval", message: "This page version waits for a room admin.",
  });
});

test("every route checks the capability: today a person passes and a delegated caller does not", async () => {
  assert.equal((await call("/rooms/r1/echo/t")).status, 200);
  assert.deepEqual(await call("/rooms/r1/echo/t", { via: "page_1" }), {
    status: 403, body: { code: "not_granted", message: 'This caller does not hold the "tasks.read" capability.' }, retryAfter: null,
  });
});

test("a write consults the room policy: deny refuses it, approve passes to the handler", async () => {
  const post = (room: string) => call(`/rooms/${room}/proposals`, { user: "acct_policy", method: "POST", body: '{"title":"a"}', headers: { "content-type": "application/json" } });
  assert.equal((await post("r1")).status, 200);
  assert.deepEqual((await post("closed")).body, {
    code: "not_granted", message: 'This room does not allow "tasks.propose" through the LetAgents API.',
  });
});

test("writes are recorded with their actor and outcome; reads and refusals before the rate limit are not", async () => {
  recorded.length = 0;
  await call("/rooms/r1/echo/t", { user: "acct_audit" });
  const post = (room: string, body: string) => call(`/rooms/${room}/proposals`, { user: "acct_audit", method: "POST", body, headers: { "content-type": "application/json" } });
  await post("r1", '{"title":"a"}');
  await post("r1", '{"title":""}');
  await post("closed", '{"title":"a"}');
  assert.deepEqual(recorded.map(({ actor, method, capability, target, outcome }) => ({ principal: actor.principal.id, method, capability, target, outcome })), [
    { principal: "acct_audit", method: "tasks.proposeExample", capability: "tasks.propose", target: null, outcome: "ok" },
    { principal: "acct_audit", method: "tasks.proposeExample", capability: "tasks.propose", target: null, outcome: "invalid_input" },
  ]);
});

test("the rate limit counts per actor and per class, and says when to retry", async () => {
  for (let i = 0; i < 3; i += 1) assert.equal((await call("/rooms/r1/echo/t", { user: "acct_rate" })).status, 200);
  now += 4_000;
  assert.deepEqual(await call("/rooms/r1/echo/t", { user: "acct_rate" }), {
    status: 429, body: { code: "rate_limited", message: "Too many calls. Wait and try again.", retryAfterMs: 6_000 }, retryAfter: "6",
  });
  assert.equal((await call("/rooms/r1/echo/t", { user: "acct_other" })).status, 200);
  assert.equal((await call("/rooms/r1/proposals", { user: "acct_rate", method: "POST", body: '{"title":"a"}', headers: { "content-type": "application/json" } })).status, 200);
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
    assert.match(String(quiet.mock.calls.at(-1)?.arguments[1]), /tasks\.echo returned output that does not match its contract/);
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
