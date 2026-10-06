import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { toAgentReadableMessages } from "../../mcp/server/runtime/messages.js";
const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const rooms = url ? await import("../db.js") : null;
const store = url ? await import("../db/messages/link-previews.js") : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? "Set TEST_DB_URL for PostgreSQL integration tests." : false };
let sequence = 0;
async function fixture() { return rooms!.createProjectWithName(`previews-${Date.now()}-${++sequence}`); }
async function event(roomId: string, input: Record<string, unknown> = {}) {
  return rooms!.insertGitHubRoomEvent({ room_id: roomId, event_type: "pull_request", action: "opened",
    idempotency_key: `preview-${Date.now()}-${++sequence}`, github_object_id: "1",
    github_object_url: "https://github.com/org/repo/pull/1", title: "Stored title", state: "open",
    provider_event_at: "2026-10-02T00:00:00Z", metadata: { draft: false, body: "Secret body" }, ...input });
}
test("latest provider snapshot wins despite out-of-order arrival; other lanes and incomplete objects never leak", options, async () => {
  const room = await fixture(), other = await fixture();
  await event(room.id, { state: "closed", metadata: { merged: true }, provider_event_at: "2026-10-02T02:00:00Z" });
  await event(room.id); // older event arrives later
  await event(other.id, { title: "Other room", github_object_id: "2", github_object_url: "https://github.com/secret/repo/pull/2" });
  await event(room.id, { github_object_id: "3", github_object_url: "https://github.com/org/repo/pull/3", title: null });
  await event(room.id, { github_object_id: "4", github_object_url: "https://github.com/org/repo/pull/4", state: null });
  await event(room.id, { event_type: "pull_request_review", state: "approved", github_object_id: "5", github_object_url: "https://github.com/org/repo/pull/5" });
  const previews = await store!.getMessageLinkPreviews(room.id, [1,2,3,4,5].map(number => ({ kind: "pull", number })));
  assert.deepEqual(previews, [{ kind: "pull", number: 1, url: "https://github.com/org/repo/pull/1", repository: "org/repo", title: "Stored title", state: "merged" }]);
  assert.deepEqual(await store!.getMessageLinkPreviews(room.id, [{ kind: "issue", number: 1 }]), []);
});
test("draft PRs and real issues use complete snapshots; malformed stored links and PR-shaped issues are absent", options, async () => {
  const room = await fixture();
  await event(room.id, { metadata: { draft: true } });
  await event(room.id, { event_type: "issue", github_object_id: "2", github_object_url: "https://github.com/org/repo/issues/2", state: "closed" });
  await event(room.id, { event_type: "issue", github_object_id: "3", github_object_url: "https://github.com/org/repo/issues/3", metadata: { is_pull_request: true } });
  await event(room.id, { github_object_id: "4", github_object_url: "javascript:alert(1)" });
  const previews = await store!.getMessageLinkPreviews(room.id, [{ kind: "pull", number: 1 }, { kind: "issue", number: 2 }, { kind: "issue", number: 3 }, { kind: "pull", number: 4 }]);
  assert.deepEqual(previews.map(p => [p.number, p.state]).sort(), [[1, "draft"], [2, "closed"]]);
});
test("preview reads and later stored snapshots leave history, single, thread and MCP reads unchanged", options, async () => {
  const room = await fixture();
  await rooms!.addMessage(room.id, "Ada", "https://github.com/org/repo/pull/1", { source: "browser" });
  await rooms!.addMessage(room.id, "Grace", "Reply", { source: "browser", thread_root_message_id: "msg_1" });
  const read = async () => ({ history: await rooms!.getMessages(room.id), single: await rooms!.getMessageById(room.id, "msg_1"), thread: await rooms!.getMessageThread(room.id, "msg_1") });
  const before = await read(), agentBefore = toAgentReadableMessages(before.history.messages);
  await event(room.id);
  assert.equal((await store!.getMessageLinkPreviews(room.id, [{ kind: "pull", number: 1 }]))[0]?.state, "open");
  await event(room.id, { state: "closed", provider_event_at: "2026-10-02T01:00:00Z" });
  assert.equal((await store!.getMessageLinkPreviews(room.id, [{ kind: "pull", number: 1 }]))[0]?.state, "closed");
  assert.deepEqual(await read(), before);
  assert.deepEqual(toAgentReadableMessages((await read()).history.messages), agentBefore);
});
