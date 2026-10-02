import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Express } from "express";
import { requiredAgentSessionRouteCapability } from "../request/agent-session-route-capabilities.js";
import { parseRoomResourceInvalidation } from "../../../shared/room-resource-invalidation.mjs";
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomMessageRoutes } = await import("../routes/rooms/messages/index.js");
const { createRoomEventBroker, MESSAGE_CREATED_EVENT_KINDS } = await import("../server/room-event-broker.js");
const room = "github.com/org/repo";
type Auth = "session" | "owner_token" | "agent_session" | null;
function harness(options: { denied?: boolean; resolutionError?: boolean; failure?: unknown; result?: string } = {}) {
  const routes: Array<{ method: string; path: RegExp | string; handler: Function }> = [];
  const pins = new Set<number>();
  const invalidated: string[] = [];
  const writes: any[] = [];
  const app = Object.fromEntries(["get", "post", "put", "delete"].map((method) => [method,
    (path: RegExp | string, handler: Function) => routes.push({ method, path, handler })])) as unknown as Express;
  registerRoomMessageRoutes(app, {
    emitProjectMessage: () => { throw Error("Pins must not emit messages"); },
    resolveCanonicalRoomRequestId: async (id: string) => { if (options.resolutionError) throw Error("secret database detail"); return id; },
    resolveRoomOrReply: async (id: string) => ({ id }),
    requireParticipant: async (_req: any, res: any) => {
      if (options.denied) { res.status(403).json({ error: "Forbidden" }); return false; }
      return true;
    },
    queueMessagePinInvalidation: (id: string) => invalidated.push(id),
    messagePinStore: {
      list: async () => { if (options.failure) throw options.failure; return []; },
      set: async (target: any) => {
        writes.push(target);
        if (options.failure) throw options.failure;
        if (options.result) return options.result;
        const changed = pins.has(target.messageNumber) !== target.pinned;
        if (target.pinned) pins.add(target.messageNumber); else pins.delete(target.messageNumber);
        return changed ? "changed" : "unchanged";
      },
    },
  } as any);
  async function request(method: string, path: string, auth: Auth = "session") {
    const matching = routes.filter((r) => r.method === method && (r.path instanceof RegExp ? r.path.test(path) : r.path === path));
    assert.equal(matching.length, 1, `${method} ${path} must match exactly once`);
    const route = matching[0]!;
    const req = { params: Object.fromEntries(path.match(route.path)!.slice(1).map((v, i) => [i, decodeURIComponent(v)])),
      authKind: auth ?? undefined, sessionAccount: auth === "session" || auth === "owner_token" ? { account_id: "person" } : null, headers: {}, query: {} };
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    await route.handler(req, res);
    return res;
  }
  return { request, routes, invalidated, writes };
}
const path = (id = "msg_1") => `/rooms/${room}/messages/${id}/pin`;
test("idempotent human writes only invalidate actual committed changes", async () => {
  const api = harness();
  for (const [method, changed] of [["put", true], ["put", false], ["delete", true], ["delete", false]] as const) {
    const response = await api.request(method, path());
    assert.deepEqual(response.body, { room_id: room, message_id: "msg_1", changed });
  }
  assert.deepEqual(api.invalidated, [room, room]);
  assert.deepEqual((await api.request("get", `/rooms/${encodeURIComponent(room)}/messages/pins`)).body, { room_id: room, pins: [] });
});
test("worker credentials, owner tokens with account data, and anonymous callers cannot pin", async () => {
  const api = harness();
  for (const auth of ["owner_token", "agent_session", null] as const) {
    for (const method of ["put", "delete"]) {
      const result = await api.request(method, path(), auth);
      assert.equal(result.code, auth ? 403 : 401);
      assert.equal(result.body.code, "person_required");
    }
  }
  assert.equal(api.writes.length, 0);
  assert.equal(requiredAgentSessionRouteCapability("PUT", path()), null);
  assert.equal(requiredAgentSessionRouteCapability("DELETE", path()), null);
});
test("access denial stops both reads and writes; invalid ids cannot reach storage", async () => {
  const denied = harness({ denied: true });
  assert.equal((await denied.request("get", `/rooms/${room}/messages/pins`)).code, 403);
  assert.equal((await denied.request("put", path())).code, 403);
  assert.deepEqual(denied.writes, []);
  const api = harness();
  for (const id of ["msg_0", "msg_01", "msg_2147483648", "pending", "msg_x"]) assert.equal((await api.request("put", path(id))).code, 400);
  assert.deepEqual(api.writes, []);
});
test("the limit, missing message, nested lock timeout and resolution failures have bounded errors", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const [result, code] of [["pin_limit", 409], ["message_not_found", 404]] as const) {
    const api = harness({ result }); const response = await api.request("put", path());
    assert.equal(response.code, code); assert.equal(response.body.code, result); assert.deepEqual(api.invalidated, []);
  }
  const busy = await harness({ failure: { cause: { code: "55P03" } } }).request("put", path());
  assert.equal(busy.code, 503); assert.equal(busy.body.code, "pin_busy");
  for (const method of ["get", "put"]) {
    const result = await harness({ resolutionError: true }).request(method, method === "get" ? `/rooms/${room}/messages/pins` : path());
    assert.equal(result.code, 500); assert.doesNotMatch(JSON.stringify(result.body), /secret/);
  }
});
test("pins do not shadow any existing message route", () => {
  const api = harness();
  for (const suffix of ["pins", "reactions", "msg_1", "poll", "stream", "threads", "msg_1/thread"]) {
    const url = `/rooms/${room}/messages/${suffix}`;
    assert.equal(api.routes.filter((r) => r.method === "get" && (r.path instanceof RegExp ? r.path.test(url) : r.path === url)).length, 1, suffix);
  }
});
test("the room stream sends only a pin pointer and never wakes message-only subscribers", async () => {
  assert.deepEqual(parseRoomResourceInvalidation({ room_id: room, resource: "message_pins" }), { status: "supported", pointer: { room_id: room, resource: "message_pins" } });
  const quiet = () => new EventEmitter();
  const messagePinEvents = quiet();
  const broker = createRoomEventBroker({ messageEvents: quiet(), taskEvents: quiet(), githubRoomEvents: quiet(),
    reasoningEvents: quiet(), rentalActivityEvents: quiet(), messageInfoEvents: quiet(), messagePinEvents }, { instanceId: "pins" });
  const all = broker.subscribe(room); const messages = broker.subscribe(room, { kinds: MESSAGE_CREATED_EVENT_KINDS });
  messagePinEvents.emit("message_pins:invalidated", { projectId: room });
  const event = await all.next();
  assert.equal(event?.type, "event");
  if (event?.type === "event") assert.deepEqual(event.envelope.event, { kind: "resource_invalidated", resource: "message_pins", roomId: room });
  assert.equal(await Promise.race([messages.next().then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]), false);
  all.close(); messages.close(); broker.close();
});
