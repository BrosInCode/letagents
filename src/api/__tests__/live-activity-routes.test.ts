import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { Project, ReasoningSession } from "../db.js";
import type { RoomReasoningRouteDeps, RoomReasoningStore } from "../routes/rooms/reasoning.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomReasoningRoutes } = await import("../routes/rooms/reasoning.js");
const { requiredAgentSessionRouteCapability } = await import("../request/agent-session-route-capabilities.js");
const { reasoningStreamFrame } = await import("../routes/rooms/messages/stream.js");
const { cleanupStaleLiveActivityOnce, LIVE_ACTIVITY_RETENTION_MS } = await import("../server/live-activity-cleanup.js");

const ROOM = "github.com/brosincode/letagents";
type Handler = (req: unknown, res: ReturnType<typeof response>) => Promise<void>;

function project(): Project {
  return {
    id: ROOM, code: null, display_name: "LetAgents", name: ROOM, kind: "main", parent_room_id: null,
    focus_key: null, source_task_id: null, focus_status: null, focus_parent_visibility: null,
    focus_activity_scope: null, focus_github_event_routing: null, concluded_at: null,
    conclusion_summary: null, conclusion_details: null, created_at: "2026-10-18 00:00:00+00",
  };
}

function response() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
}

function liveSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    state: "working",
    started_at: "2026-10-18T10:00:00.000Z",
    ended_at: null,
    request_message_id: "msg_42",
    omitted_earlier: false,
    entries: [
      { kind: "note", id: "e1", text: "Checking the failing test first." },
      { kind: "action", id: "e2", headline: "Ran a shell command", status: "completed", tool: "shell", count: 1 },
    ],
    ...overrides,
  };
}

function session(overrides: Partial<ReasoningSession> = {}): ReasoningSession {
  return {
    id: "rs_live", room_id: ROOM, task_id: null, anchor_message_id: "msg_42", actor_label: "Ada | Codex",
    agent_key: "agent_ada", kind: "live", status: "working", summary: "Ran a shell command",
    latest_payload: { summary: "Ran a shell command" }, created_at: "2026-10-18T10:00:00.000Z",
    updated_at: "2026-10-18T10:00:03.000Z", closed_at: null, ...overrides,
  };
}

const worker = { actor_label: "Ada | Codex", agent_key: "agent_ada", session_kind: "worker" };

function routes(options: {
  store?: Partial<RoomReasoningStore>;
  identity?: { ok: true; identity: unknown } | { ok: false; status: number; error: string } | null;
  participant?: boolean;
} = {}) {
  const handlers = new Map<string, Handler>();
  const events = new EventEmitter();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  events.on("reasoning:updated", (payload) => emitted.push({ name: "reasoning:updated", payload }));
  events.on("reasoning:removed", (payload) => emitted.push({ name: "reasoning:removed", payload }));
  const unused = async () => { throw new Error("not invoked"); };
  const app = Object.fromEntries(["get", "post", "patch", "delete"].map((method) => [
    method,
    (path: RegExp, handler: Handler) => handlers.set(`${method} ${path.toString()}`, handler),
  ]));
  const deps: RoomReasoningRouteDeps = {
    reasoningEvents: events,
    resolveCanonicalRoomRequestId: async (roomId) => roomId,
    resolveRoomOrReply: async () => project(),
    requireParticipant: (async (_req: unknown, res: ReturnType<typeof response>) => {
      if (options.participant === false) { res.status(403).json({ error: "Not a room participant." }); return false; }
      return true;
    }) as never,
    requireWorkerIdentity: (async () => options.identity === undefined
      ? { ok: true, identity: worker } : options.identity) as never,
    reasoningStore: {
      appendReasoningSessionUpdate: unused as never,
      createLiveActivitySession: unused as never,
      createReasoningSession: unused as never,
      deleteLiveActivitySessions: unused as never,
      getReasoningSessionById: unused as never,
      getReasoningSessionUpdates: unused as never,
      getReasoningSessions: (async () => []) as never,
      updateLiveActivitySession: unused as never,
      updateReasoningSession: unused as never,
      ...options.store,
    },
  };
  registerRoomReasoningRoutes(app as never, deps);
  const call = async (key: string, req: Record<string, unknown>) => {
    const handler = handlers.get(key);
    assert.ok(handler, key);
    const res = response();
    await handler({ params: { 0: ROOM, 1: "rs_live" }, query: {}, authKind: "agent_session", ...req }, res);
    return res;
  };
  return { call, emitted };
}

const CREATE = "post /^\\/rooms\\/(.+)\\/reasoning-sessions$/";
const UPDATE = "post /^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)\\/updates$/";
const LIST = "get /^\\/rooms\\/(.+)\\/reasoning-sessions$/";
const WITHDRAW = "delete /^\\/rooms\\/(.+)\\/live-activity$/";

test("only an agent's own worker session can start a live session", async () => {
  const human = routes({ identity: null });
  const byHuman = await human.call(CREATE, { authKind: "session", body: { kind: "live", summary: "Working", live: liveSnapshot() } });
  assert.equal(byHuman.statusCode, 403);

  const controller = routes({ identity: { ok: true, identity: { ...worker, session_kind: "controller" } } });
  const byController = await controller.call(CREATE, { body: { kind: "live", summary: "Working", live: liveSnapshot() } });
  assert.equal(byController.statusCode, 403);
});

test("a live session stores the bounded snapshot under the worker's own agent and replaces its older ones", async () => {
  let stored: Record<string, unknown> | null = null;
  const { call, emitted } = routes({
    store: {
      createLiveActivitySession: (async (input: Record<string, unknown>) => {
        stored = input;
        return { session: session(), update: { id: "ru_1" }, removed_session_ids: ["rs_old"] };
      }) as never,
    },
  });
  const res = await call(CREATE, {
    body: {
      kind: "live", summary: "Ran a shell command", agent_key: "someone_else", goal: "kept out",
      live: liveSnapshot({ entries: [{ kind: "update", id: "e1", text: "Line one\nline two" }] }),
    },
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(stored, {
    room_id: ROOM,
    actor_label: "Ada | Codex",
    agent_key: "agent_ada",
    snapshot: {
      summary: "Ran a shell command",
      status: "working",
      live: { ...liveSnapshot(), entries: [{ kind: "update", id: "e1", text: "Line one\nline two" }] },
    },
  });
  assert.deepEqual(emitted.map((event) => event.name), ["reasoning:removed", "reasoning:updated"]);
  assert.deepEqual(emitted[0]!.payload, { projectId: ROOM, session_id: "rs_old", kind: "live" });
});

test("the server refuses live snapshots outside the stored shape and bounds", async () => {
  const { call } = routes({ store: { createLiveActivitySession: (async () => { throw new Error("must not store"); }) as never } });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["tool input", { entries: [{ kind: "action", id: "e1", headline: "Ran a shell command", status: "completed", tool: "shell", input: { command: "ls" } }] }],
    ["tool output", { entries: [{ kind: "action", id: "e1", headline: "Ran a shell command", status: "completed", tool: "shell", output: "secret" }] }],
    ["long text", { entries: [{ kind: "note", id: "e1", text: "x".repeat(1_201) }] }],
    ["multi-line headline", { entries: [{ kind: "action", id: "e1", headline: "Ran\nrm -rf", status: "completed", tool: "shell" }] }],
    ["unknown tool kind", { entries: [{ kind: "action", id: "e1", headline: "Ran", status: "completed", tool: "bash" }] }],
    ["too many entries", { entries: Array.from({ length: 61 }, (_, index) => ({ kind: "note", id: `e${index}`, text: "note" })) }],
    ["unknown key", { error: "Full error body" }],
    ["control characters", { entries: [{ kind: "note", id: "e1", text: "bell\u0007" }] }],
    ["an ended turn without its end", { state: "ended", ended_at: null }],
    ["a request reference that is text", { request_message_id: "please fix the build" }],
  ];
  for (const [label, overrides] of cases) {
    const res = await call(CREATE, { body: { kind: "live", summary: "Working", live: liveSnapshot(overrides) } });
    assert.equal(res.statusCode, 400, label);
  }
  const bigText = "y".repeat(1_100);
  const tooLarge = await call(CREATE, {
    body: { kind: "live", summary: "Working", live: liveSnapshot({ entries: Array.from({ length: 40 }, (_, index) => ({ kind: "note", id: `e${index}`, text: bigText })) }) },
  });
  assert.equal(tooLarge.statusCode, 400, "snapshot bytes");
  const longSummary = await call(CREATE, { body: { kind: "live", summary: "s".repeat(201), live: liveSnapshot() } });
  assert.equal(longSummary.statusCode, 400, "summary");
});

test("reasoning sessions cannot carry a live snapshot", async () => {
  const { call } = routes({ identity: null, store: { createReasoningSession: (async () => { throw new Error("must not store"); }) as never } });
  const res = await call(CREATE, { authKind: "session", body: { actor_label: "Ada", summary: "Plan", live: liveSnapshot() } });
  assert.equal(res.statusCode, 400);
  const badKind = await call(CREATE, { authKind: "session", body: { actor_label: "Ada", summary: "Plan", kind: "other" } });
  assert.equal(badKind.statusCode, 400);
});

test("a live snapshot update is scoped to the worker's agent, and a gone session is reported", async () => {
  let updateInput: Record<string, unknown> | null = null;
  const live = routes({
    store: {
      updateLiveActivitySession: (async (input: Record<string, unknown>) => {
        updateInput = input;
        return { session: session(), update: null };
      }) as never,
    },
  });
  const res = await live.call(UPDATE, { body: { summary: "Edited a file", live: liveSnapshot({ state: "ended", ended_at: "2026-10-18T10:05:00.000Z" }) } });
  assert.equal(res.statusCode, 201);
  assert.equal((updateInput as { agent_key?: string } | null)?.agent_key, "agent_ada");
  assert.equal((updateInput as { snapshot?: { status?: string } } | null)?.snapshot?.status, "idle");
  assert.deepEqual(live.emitted.map((event) => event.name), ["reasoning:updated"]);

  const gone = routes({ store: { updateLiveActivitySession: (async () => null) as never } });
  assert.equal((await gone.call(UPDATE, { body: { summary: "Edited a file", live: liveSnapshot() } })).statusCode, 404);

  const human = routes({ identity: null });
  assert.equal((await human.call(UPDATE, { authKind: "session", body: { summary: "Edited a file", live: liveSnapshot() } })).statusCode, 403);
});

test("reasoning lists leave live sessions out unless asked for them", async () => {
  const kinds: unknown[] = [];
  const { call } = routes({
    store: { getReasoningSessions: (async (_room: string, options: { kind?: string }) => { kinds.push(options.kind); return []; }) as never },
  });
  await call(LIST, { authKind: "session" });
  await call(LIST, { authKind: "session", query: { kind: "live" } });
  await call(LIST, { authKind: "session", query: { kind: "anything" } });
  assert.deepEqual(kinds, ["reasoning", "live", "reasoning"]);
});

test("a reader who may not read the room gets no live session, listed or by id", async () => {
  const touched: string[] = [];
  const { call } = routes({
    participant: false,
    store: {
      getReasoningSessions: (async () => { touched.push("list"); return [session()]; }) as never,
      getReasoningSessionById: (async () => { touched.push("get"); return session(); }) as never,
      getReasoningSessionUpdates: (async () => { touched.push("updates"); return []; }) as never,
    },
  });
  const list = await call(LIST, { authKind: "session", query: { kind: "live" } });
  assert.equal(list.statusCode, 403);
  const detail = await call("get /^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)$/", { authKind: "session" });
  assert.equal(detail.statusCode, 403);
  assert.deepEqual(touched, [], "storage is never read for a non-participant");
});

test("withdrawing removes every live session of the worker's agent and tells the room", async () => {
  let deleted: unknown = null;
  const { call, emitted } = routes({
    store: { deleteLiveActivitySessions: (async (input: unknown) => { deleted = input; return ["rs_a", "rs_b"]; }) as never },
  });
  const res = await call(WITHDRAW, { body: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { room_id: ROOM, removed: 2 });
  assert.deepEqual(deleted, { room_id: ROOM, agent_key: "agent_ada" });
  assert.deepEqual(emitted.map((event) => event.payload), [
    { projectId: ROOM, session_id: "rs_a", kind: "live" },
    { projectId: ROOM, session_id: "rs_b", kind: "live" },
  ]);

  const human = routes({ identity: null });
  assert.equal((await human.call(WITHDRAW, { authKind: "session", body: {} })).statusCode, 403);
});

test("a worker bearer may withdraw its live activity, and nothing else under that path", () => {
  assert.equal(requiredAgentSessionRouteCapability("DELETE", `/rooms/${ROOM}/live-activity`), "coordination.self_write");
  assert.equal(requiredAgentSessionRouteCapability("DELETE", `/api/rooms/${ROOM}/live-activity`), "coordination.self_write");
  assert.equal(requiredAgentSessionRouteCapability("DELETE", `/rooms/${ROOM}/live-activity/rs_1`), null);
  assert.equal(requiredAgentSessionRouteCapability("DELETE", `/rooms/${ROOM}/reasoning-sessions/rs_1`), null);
});

test("live sessions stream under their own event names", () => {
  assert.equal(reasoningStreamFrame(ROOM, { kind: "reasoning_updated", roomId: ROOM, session: session(), update: null }).name, "live_activity_update");
  assert.equal(reasoningStreamFrame(ROOM, { kind: "reasoning_updated", roomId: ROOM, session: session({ kind: "reasoning" }), update: null }).name, "reasoning_update");
  assert.deepEqual(reasoningStreamFrame(ROOM, { kind: "reasoning_removed", roomId: ROOM, sessionId: "rs_live", sessionKind: "live" }), {
    name: "live_activity_remove",
    data: { room_id: ROOM, session_id: "rs_live" },
  });
  assert.equal(reasoningStreamFrame(ROOM, { kind: "reasoning_removed", roomId: ROOM, sessionId: "rs_1", sessionKind: "reasoning" }).name, "reasoning_remove");
});

test("the retention sweep removes live sessions idle past the retention in batches and tells each room", async () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const calls: Array<{ updated_before: string; limit: number }> = [];
  const removed: unknown[] = [];
  let batch = 0;
  const result = await cleanupStaleLiveActivityOnce({
    now: () => now,
    deleteStale: async (input) => {
      calls.push(input);
      batch += 1;
      return batch === 1
        ? Array.from({ length: input.limit }, (_, index) => ({ id: `rs_${index}`, room_id: ROOM }))
        : [{ id: "rs_last", room_id: "other-room" }];
    },
    removed: (input) => removed.push(input),
  });
  assert.equal(result.deleted, 101);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.updated_before, new Date(now - LIVE_ACTIVITY_RETENTION_MS).toISOString());
  assert.deepEqual(removed.at(-1), { room_id: "other-room", session_id: "rs_last" });
});
