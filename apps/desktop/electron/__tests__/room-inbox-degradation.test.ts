import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";
createElectronTestEnv({ prefix: 'letagents-universal-inbox-', paths: ['state', 'chatStorage', 'localChatDb', 'localProfile'] });
const { DesktopApiError } = await import("../main/auth.js");
const { loadSource } = await import("../main/rooms/snapshot/fetch-data.js");
const { isMissingThreadRouteError } = await import("../main/rooms/messages.js");
const { getDesktopInboxUpdates } = await import("../main/rooms/inbox.js");

test("loadSource returns ready state and data when the source resolves", async () => {
  const result = await loadSource(Promise.resolve({ tasks: [{ id: "task_1" }] }), {
    tasks: [],
  });

  assert.equal(result.state.status, "ready");
  assert.equal(result.state.error, null);
  assert.deepEqual(result.data, { tasks: [{ id: "task_1" }] });
});

test("loadSource falls back to the provided value and records the error message", async () => {
  const fallback = { tasks: [] as Array<{ id: string }> };
  const result = await loadSource(
    Promise.reject(new DesktopApiError(500, { error: "boom", message: "server exploded" })),
    fallback,
  );

  assert.equal(result.state.status, "error");
  assert.equal(result.state.error, "server exploded");
  // Failed source degrades to the fallback rather than blanking or throwing.
  assert.deepEqual(result.data, fallback);
});

test("loadSource stringifies non-Error rejections", async () => {
  const result = await loadSource(Promise.reject("nope"), null);

  assert.equal(result.state.status, "error");
  assert.equal(result.state.error, "nope");
  assert.equal(result.data, null);
});

test("isMissingThreadRouteError only swallows a bare 404 from an older server", () => {
  // Older server without the threads route: bare 404, no machine-readable code.
  assert.equal(isMissingThreadRouteError(new DesktopApiError(404, null)), true);
  assert.equal(
    isMissingThreadRouteError(new DesktopApiError(404, { error: "not available" })),
    true,
  );
});

test("isMissingThreadRouteError surfaces a coded 404 as a real error", () => {
  // A 404 that identifies a specific room must NOT be masked as an empty inbox.
  assert.equal(
    isMissingThreadRouteError(
      new DesktopApiError(404, { error: "Room not found", code: "ROOM_NOT_FOUND" }),
    ),
    false,
  );
});

test("isMissingThreadRouteError surfaces auth, server, and non-API errors", () => {
  assert.equal(isMissingThreadRouteError(new DesktopApiError(401, { error: "auth_required" })), false);
  assert.equal(isMissingThreadRouteError(new DesktopApiError(500, { error: "boom" })), false);
  assert.equal(isMissingThreadRouteError(new Error("offline")), false);
  assert.equal(isMissingThreadRouteError(null), false);
});

test('universal updates load bounded sources, include unassigned completions and preserve partial failures', async () => {
  const prior = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    let payload: unknown = {};
    if (url.includes('/tasks?status=done')) payload = { tasks: Array.from({ length: 7 }, (_, index) => ({ id: `task_${index + 1}`, title: `Completed ${index + 1}`, status: 'done', assignee: index ? 'same-agent' : null })), has_more: true };
    else if (url.includes('/tasks?status=merged')) payload = { tasks: [], has_more: false };
    else if (url.includes('/messages/threads')) payload = { threads: [], has_more: false, unread_thread_count: 0 };
    else if (url.includes('/presence?')) return new Response(JSON.stringify({ error: 'presence unavailable' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    else if (url.includes('/events?')) payload = { events: [], has_more: false };
    else if (url.includes('/reasoning-sessions')) payload = { sessions: [] };
    else throw new Error(`Unexpected inbox fetch: ${url}`);
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const updates = await getDesktopInboxUpdates('github.com/test/inbox');
    assert.equal(updates.tasks.length, 7, 'includes an unassigned task and all six completions by one agent');
    assert.equal(updates.tasks[0].assignee, null);
    assert.equal(updates.limited, true);
    assert.deepEqual(updates.unavailable, ['Agents']);
    assert.equal(calls.length, 6);
    assert.ok(calls.some(url => url.includes('filter=unread') && url.includes('limit=75')));
    assert.ok(calls.filter(url => url.includes('/tasks?')).every(url => url.includes('limit=200') && url.includes('order=recent')));
    assert.ok(calls.every(url => !url.includes('/messages?') && !url.includes('/activity-history')), 'does not fetch transcripts or participant snippets');
  } finally { globalThis.fetch = prior; }
});
