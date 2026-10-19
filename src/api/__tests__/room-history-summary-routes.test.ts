import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import { requiredAgentSessionRouteCapability } from "../request/agent-session-route-capabilities.js";
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomHistorySummaryRoutes } = await import("../routes/rooms/history-summary.js");

const room = "github.com/org/repo";
type Auth = "session" | "agent_session";

function harness(options: { role?: "admin" | "participant"; configured?: boolean } = {}) {
  const role = options.role ?? "admin";
  const routes: Array<{ method: string; path: RegExp; handler: Function }> = [];
  const enabled = new Map<string, boolean>();
  const started: string[] = [];
  const viewLines: number[] = [];
  const app = Object.fromEntries(["get", "put"].map((method) => [method,
    (path: RegExp, handler: Function) => routes.push({ method, path, handler })])) as unknown as Express;
  registerRoomHistorySummaryRoutes(app, {
    resolveCanonicalRoomRequestId: async (id) => id,
    resolveRoomOrReply: async (id) => ({ id, parent_room_id: null } as any),
    requireParticipant: async () => true,
    requireAdmin: async (req, res) => {
      if (req.authKind === "agent_session") { res.status(403).json({ error: "Worker bearers cannot perform owner or admin actions." }); return false; }
      if (role !== "admin") { res.status(403).json({ error: "Admin privileges required" }); return false; }
      return true;
    },
    resolveProjectRole: async () => role,
    summarizerConfigured: () => options.configured ?? true,
    settings: {
      getRoomHistorySummaryEnabled: async (id) => enabled.get(id) ?? true,
      setRoomHistorySummaryEnabled: async (id, value) => { enabled.set(id, value); },
    },
    history: {
      startOrWakeRoomHistory: async (id) => { started.push(id); },
      readRoomHistoryStatus: async () => ({ state: "ready", summarized_messages: 3, pending_lines: 0, retry_at: null, last_error: null }),
      readRoomHistoryView: async (_id, maxLines) => {
        viewLines.push(maxLines);
        return { lines: [{ node: "1:0", level: 1, first_message_id: "msg_1", last_message_id: "msg_2", first_at: "a", last_at: "b",
          messages: 2, text: "Emmy and Ada agreed the plan.", pending: false }], omitted_older_lines: 0, covered_through_message_id: "msg_2" };
      },
      readRoomHistoryExpansion: async (_id, level, idx) => level === 9 ? null
        : { lines: [], message: { id: `msg_${idx + 1}`, sender: "Emmy", text: "hello", timestamp: "a", thread_root_id: null } },
    },
  });
  async function request(method: string, path: string, body: any = {}, auth: Auth = "session", query: Record<string, string> = {}) {
    const route = routes.find((candidate) => candidate.method === method && candidate.path.test(path));
    assert.ok(route, `${method} ${path} is routed`);
    const matches = path.match(route.path)!;
    const req = { params: Object.fromEntries(matches.slice(1).map((value, i) => [i, value])), body, query, authKind: auth,
      sessionAccount: auth === "agent_session" ? null : { account_id: "human-1", login: "Emmy" }, headers: {} };
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; },
      setHeader() { return this; }, json(payload: any) { this.body = payload; return this; } };
    await route.handler(req, res);
    return res;
  }
  return { request, started, viewLines };
}

test("history summaries are on by default, and only a person who is an admin turns them off", async () => {
  const api = harness();
  const initial = await api.request("get", `/rooms/${room}/history-summary/setting`);
  assert.equal(initial.body.enabled, true);
  assert.equal(initial.body.state, "ready");
  assert.equal(initial.body.can_manage, true);
  assert.deepEqual(api.started, [room], "reading the setting starts the room's summary");
  assert.equal((await api.request("put", `/rooms/${room}/history-summary/setting`, { enabled: false }, "agent_session")).code, 403);
  assert.equal((await harness({ role: "participant" }).request("put", `/rooms/${room}/history-summary/setting`, { enabled: false })).code, 403);
  assert.equal((await api.request("put", `/rooms/${room}/history-summary/setting`, { enabled: "no" })).code, 400);
  const off = await api.request("put", `/rooms/${room}/history-summary/setting`, { enabled: false });
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.state, "off");
  // Off: the view is empty and expanding is refused.
  const view = await api.request("get", `/rooms/${room}/history-summary`);
  assert.equal(view.body.state, "off");
  assert.deepEqual(view.body.lines, []);
  assert.equal((await api.request("get", `/rooms/${room}/history-summary/nodes/0:0`)).code, 409);
});

test("without a summarizer key the setting says so and nothing starts", async () => {
  const api = harness({ configured: false });
  const setting = await api.request("get", `/rooms/${room}/history-summary/setting`);
  assert.equal(setting.body.state, "unavailable");
  assert.deepEqual(api.started, []);
  assert.deepEqual((await api.request("get", `/rooms/${room}/history-summary`)).body.lines, []);
});

test("the view and the expansion are read by people and agents alike", async () => {
  const api = harness();
  const view = await api.request("get", `/rooms/${room}/history-summary`, {}, "agent_session", { max_lines: "40" });
  assert.equal(view.body.lines[0].node, "1:0");
  assert.equal(view.body.covered_through_message_id, "msg_2");
  assert.match(view.body.note, /lossy summary/);
  assert.deepEqual(api.viewLines, [40]);
  await api.request("get", `/rooms/${room}/history-summary`, {}, "session", { max_lines: "100000" });
  assert.equal(api.viewLines.at(-1), 400, "the line budget is clamped");
  const leaf = await api.request("get", `/rooms/${room}/history-summary/nodes/0:4`);
  assert.equal(leaf.body.node, "0:4");
  assert.equal(leaf.body.message.id, "msg_5");
  assert.equal((await api.request("get", `/rooms/${room}/history-summary/nodes/9:0`)).code, 404);
});

test("a worker bearer may read the summary with message read access, and nothing else of it", () => {
  for (const path of [`/rooms/${room}/history-summary`, `/rooms/${room}/history-summary/setting`, `/rooms/${room}/history-summary/nodes/3:12`]) {
    assert.equal(requiredAgentSessionRouteCapability("GET", path), "messages.read", path);
  }
  assert.equal(requiredAgentSessionRouteCapability("PUT", `/rooms/${room}/history-summary/setting`), null);
  assert.equal(requiredAgentSessionRouteCapability("GET", `/rooms/${room}/history-summary/nodes/abc`), null);
});
