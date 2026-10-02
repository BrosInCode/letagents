import assert from "node:assert/strict";
import test from "node:test";
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerMessageLinkPreviewRoutes } = await import("../routes/rooms/messages/link-previews.js");

function harness({ denied = false, project = { id: "repo" }, fail = false }: { denied?: boolean; project?: any; fail?: boolean } = {}) {
  let handler: Function; const queries: unknown[] = [];
  registerMessageLinkPreviewRoutes({ post(_path: unknown, fn: Function) { handler = fn; } } as never, {
    resolveCanonicalRoomRequestId: async () => project.id,
    resolveRoomOrReply: async () => project,
    requireParticipant: async (_req: unknown, res: any) => { if (denied) res.status(403).json({ error: "Forbidden" }); return !denied; },
    getMessageLinkPreviews: async (...args: unknown[]) => { queries.push(args); if (fail) throw Error("secret"); return []; },
  } as never);
  return { queries, async request(body: unknown) {
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    await handler({ params: { 0: "alias" }, body }, res); return res;
  } };
}
test("the room gate runs before queries, and client URLs/repos cannot affect lookup", async () => {
  const denied = harness({ denied: true }); assert.equal((await denied.request({ references: [{ kind: "pull", number: 1 }] })).code, 403); assert.deepEqual(denied.queries, []);
  const api = harness();
  for (const body of [null, {}, { urls: ["https://evil/"] }, { references: [], repository: "secret/repo" }, { references: [{ kind: "pull", number: 1, repository: "secret/repo" }] }, { references: Array.from({ length: 51 }, () => ({ kind: "pull", number: 1 })) }]) assert.equal((await api.request(body)).code, 400);
  assert.deepEqual(api.queries, []);
  assert.deepEqual((await api.request({ references: [{ kind: "pull", number: 1 }, { kind: "pull", number: 1 }] })).body, { room_id: "repo", previews: [] });
  assert.deepEqual(api.queries, [["repo", [{ kind: "pull", number: 1 }]]]);
});
test("previews use exactly the Events lane for inherited, isolated and generated focus rooms", async () => {
  for (const [settings, lane] of [
    [{ focus_github_event_routing: "task_and_branch" }, "parent"],
    [{ focus_github_event_routing: "all_parent_repo" }, "parent"],
    [{ focus_github_event_routing: "focus_owned_only" }, "focus_1"],
    [{ focus_key: "git:branch:dGVzdA", focus_github_event_routing: "task_and_branch" }, "focus_1"],
  ] as const) {
    const api = harness({ project: { id: "focus_1", kind: "focus", parent_room_id: "parent", ...settings } });
    await api.request({ references: [{ kind: "issue", number: 7 }] });
    assert.deepEqual(api.queries, [[lane, [{ kind: "issue", number: 7 }]]]);
  }
});
test("storage failures are opaque", async (t) => {
  t.mock.method(console, "error", () => {});
  const result = await harness({ fail: true }).request({ references: [] });
  assert.equal(result.code, 500); assert.doesNotMatch(JSON.stringify(result.body), /secret/);
});
