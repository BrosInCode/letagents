import assert from "node:assert/strict";
import test from "node:test";
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerAgentAskRoutes } = await import("../routes/agent-asks.js");
const { requiredAgentSessionRouteCapability } = await import("../request/agent-session-route-capabilities.js");

const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
const ID = "ask_12345678-1234-4234-8234-123456789abc";

function row(extra: Record<string, unknown> = {}) {
  return { id: ID, state: "open", room_id: "room", asker_account_id: "sam", giver_account_id: null, provider_id: "claude-code",
    model: "claude-opus-5-5", model_label: "Claude Opus 5.5", amount_percent: null, note: "auth fix", expires_at: "later",
    given_model_label: null, given_amount_percent: null, ended_reason: null, created_at: "c", updated_at: "u", ...extra };
}

function harness(ask: Record<string, unknown> | null = row(), extra: Record<string, unknown> = {}) {
  const routes: any[] = []; const calls: any[] = [];
  const app = Object.fromEntries(["get", "post"].map(method => [method, (path: any, handler: any) => routes.push({ method, path, handler })]));
  registerAgentAskRoutes(app as any, {
    resolveCanonicalRoomRequestId: async () => "room", resolveRoomOrReply: async () => ({ id: "room" }),
    requireParticipant: async () => true,
  } as any, {
    create: async (input: any) => { calls.push(["create", input]); return extra.limit ? { error: "ask_limit" } : { ask: row(), token: TOKEN, error: null }; },
    byToken: async () => ask, byId: async () => ask, listRoom: async () => [], listAccount: async () => [],
    cancel: async () => row({ state: "cancelled" }), claim: async (_a: any, who: string) => { calls.push(["claim", who]); return row({ state: "claimed", giver_account_id: who }); },
    release: async () => row(), authority: async () => { throw new Error("ask_not_claimed"); }, joined: async () => row({ state: "active" }),
    accept: async () => row({ state: "active" }), decline: async () => row(), end: async (_a: any, reason: string) => { calls.push(["end", reason]); return row({ state: "ended" }); },
    name: async (id: string | null) => id === "sam" ? "Sam" : "John", isAdmin: async () => false, room: async () => ({ display_name: "feat-auth" }),
  } as any);
  async function request(method: string, path: string, body: any = {}, auth: string | null = "session", account = "john") {
    const route = routes.find(r => r.method === method && (r.path instanceof RegExp ? r.path.test(path)
      : new RegExp(`^${r.path.replace(/:[a-z]+/g, "[^/]+")}$`).test(path)));
    assert.ok(route, `${method} ${path}`);
    const params = route.path instanceof RegExp ? Object.fromEntries(path.match(route.path)!.slice(1).map((v: string, i: number) => [i, v]))
      : Object.fromEntries((route.path.match(/:[a-z]+/g) ?? []).map((name: string) => [name.slice(1), path.split("/")[route.path.split("/").indexOf(name)]]));
    const req = { params, body, query: {}, authKind: auth, sessionAccount: auth ? { account_id: account } : undefined, headers: {}, protocol: "https", get: () => "letagents.chat" };
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(value: any) { this.body = value; return this; } };
    await route.handler(req, res);
    return res;
  }
  return { request, calls };
}

test("only signed-in people can ask, claim or act; agent tokens are refused", async () => {
  for (const auth of [null, "owner_token", "agent_session"]) {
    const h = harness();
    assert.equal((await h.request("post", "/rooms/room/agent-asks", { provider_id: "claude-code", model: "claude-opus-5-5" }, auth)).code, auth ? 403 : 401);
    assert.equal((await h.request("post", `/agent-asks/link/${TOKEN}/claim`, {}, auth)).code, auth ? 403 : 401);
    assert.deepEqual(h.calls, []);
  }
  assert.equal(requiredAgentSessionRouteCapability("POST", "/rooms/room/agent-asks"), null);
});

test("asking accepts only listed models and amounts, and returns a link", async () => {
  const h = harness();
  const ok = await h.request("post", "/rooms/room/agent-asks", { provider_id: "claude-code", model: "claude-opus-5-5", amount_percent: 10, note: " auth " });
  assert.equal(ok.code, 201);
  assert.equal(ok.body.link, `https://letagents.chat/ask/${TOKEN}`);
  assert.equal(h.calls[0][1].note, "auth");
  for (const body of [{ provider_id: "claude-code", model: "gpt-9" }, { provider_id: "claude-code", model: "claude-opus-5-5", amount_percent: 0 },
    { provider_id: "claude-code", model: "claude-opus-5-5", extra: true }]) {
    assert.equal((await h.request("post", "/rooms/room/agent-asks", body)).code, 400);
  }
  const full = await harness(row(), { limit: true }).request("post", "/rooms/room/agent-asks", { provider_id: "codex", model: null });
  assert.equal(full.code, 409);
  assert.match(full.body.error, /5 open requests/);
});

test("anonymous previews hide the note and room; signed-in previews show them", async () => {
  const h = harness();
  const anon = await h.request("get", `/agent-asks/link/${TOKEN}`, {}, null);
  assert.equal(anon.body.ask.asker, "Sam");
  assert.equal(anon.body.ask.note, undefined);
  const signed = await h.request("get", `/agent-asks/link/${TOKEN}`);
  assert.equal(signed.body.ask.note, "auth fix");
  assert.equal(signed.body.ask.room_display_name, "feat-auth");
});

test("unusable links tell the giver exactly why", async () => {
  const cases: Array<[Record<string, unknown>, number, string]> = [
    [{ state: "expired" }, 410, "This request expired."],
    [{ state: "cancelled" }, 410, "Sam cancelled this request."],
    [{ state: "claimed", giver_account_id: "ada" }, 409, "Someone is adding this agent right now."],
    [{ state: "active", giver_account_id: "ada" }, 409, "Someone already helped Sam. Thanks for offering."],
  ];
  for (const [state, code, error] of cases) {
    const result = await harness(row(state)).request("post", `/agent-asks/link/${TOKEN}/claim`);
    assert.equal(result.code, code); assert.equal(result.body.error, error);
  }
  const ok = harness();
  assert.equal((await ok.request("post", `/agent-asks/link/${TOKEN}/claim`)).code, 200);
  assert.deepEqual(ok.calls, [["claim", "john"]]);
});

test("store errors become plain sentences", async () => {
  const result = await harness(row({ state: "claimed", giver_account_id: "john" })).request("post", `/agent-asks/link/${TOKEN}/launch-authority`, {
    host_id: "h", installation_id: "i", agent_key: "john/helper", provider_id: "claude-code", model: "claude-opus-5-5", model_label: "Opus", amount_percent: 10,
  });
  assert.equal(result.code, 409);
  assert.equal(result.body.error, "This request is no longer reserved for you. Open the link again.");
});

test("an agreement is an agreement: the giver can only end it when the amount is used", async () => {
  const giving = row({ state: "active", giver_account_id: "john" });
  const h = harness(giving);
  assert.equal((await h.request("post", `/agent-asks/link/${TOKEN}/end`, { reason: "removed" })).code, 403);
  assert.equal((await h.request("post", `/agent-asks/link/${TOKEN}/end`, { reason: "amount_used" })).code, 200);
  assert.equal((await harness(giving).request("post", `/agent-asks/link/${TOKEN}/end`, { reason: "amount_used" }, "session", "ada")).code, 403);
  assert.deepEqual(h.calls, [["end", "amount_used"]]);
});

test("only the asker (or a room admin, for remove) can act on an ask", async () => {
  const h = harness(row({ state: "on_hold", giver_account_id: "john" }));
  assert.equal((await h.request("post", `/agent-asks/${ID}/accept`, {}, "session", "john")).code, 403);
  assert.equal((await h.request("post", `/agent-asks/${ID}/accept`, {}, "session", "sam")).code, 200);
  assert.equal((await h.request("post", `/agent-asks/${ID}/remove`, {}, "session", "john")).code, 403);
});
