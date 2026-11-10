// Contract of the legacy `/projects/:id/messages*` routes, as released clients
// (the MCP npm package, older desktops) see them through the real API app and
// a real database. Each assertion pins an exact status, body key set or SSE
// frame. Runs only when TEST_DB_URL is set.

import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;

const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const rooms = testDatabaseUrl ? await import("../db/rooms.js") : null;
const roomMembers = testDatabaseUrl ? await import("../db/room-members.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;

const MEMBER_SESSION = "legacy_contract_member_session";
const OUTSIDER_SESSION = "legacy_contract_outsider_session";
const MEMBER_OWNER_TOKEN = "legacy_contract_member_owner_token";

let server: Server | null = null;
let baseUrl = "";
let codeRoomId = "";
let namedRoomId = "";

const skip = !testDatabaseUrl;

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    const member = await accountSessions!.upsertAccount({
      provider: "github", provider_user_id: "legacy-contract-member", login: "legacy-member", display_name: "Legacy Member",
    });
    const outsider = await accountSessions!.upsertAccount({
      provider: "github", provider_user_id: "legacy-contract-outsider", login: "legacy-outsider", display_name: "Legacy Outsider",
    });
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    await accountSessions!.createSession(member.id, MEMBER_SESSION, expires);
    await accountSessions!.createSession(outsider.id, OUTSIDER_SESSION, expires);
    await ownerTokens!.createOwnerToken({
      accountId: member.id, githubUserId: "legacy-contract-member", token: MEMBER_OWNER_TOKEN,
    });
    const codeRoom = await rooms!.createProject();
    codeRoomId = codeRoom.id;
    const namedRoom = await rooms!.createProjectWithName("legacy-contract-room");
    namedRoomId = namedRoom.id;
    await rooms!.createRoomAlias(namedRoomId, "legacy-contract-alias");
    for (const roomId of [codeRoomId, namedRoomId]) {
      await roomMembers!.recordRoomCreator(roomId, member.id);
    }
    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.after(async () => {
    routesModule!.closeApiRouteEventBroker();
    server?.closeAllConnections();
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
    await dbClient!.pool.end();
  });
}

async function api(
  route: string,
  options: { token?: string | null; method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Headers; body: any }> {
  const token = options.token === undefined ? MEMBER_SESSION : options.token;
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, body };
}

async function send(roomId: string, text: string, extra: Record<string, unknown> = {}) {
  const response = await api(`/projects/${encodeURIComponent(roomId)}/messages`, {
    method: "POST", body: { sender: "Legacy Member", text, ...extra },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as { id: string; [key: string]: unknown };
}

const ids = (body: { messages?: Array<{ id: string }> }) => (body.messages ?? []).map((message) => message.id);

/** Opens an SSE response and reads frames until `until` accepts the frames read so far. */
async function readSse(
  route: string,
  options: { token?: string; headers?: Record<string, string>; until: (frames: string[]) => boolean; onOpen?: () => Promise<void> },
): Promise<{ status: number; headers: Headers; frames: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Authorization: `Bearer ${options.token ?? MEMBER_SESSION}`, Accept: "text/event-stream", ...options.headers },
    signal: controller.signal,
  });
  const frames: string[] = [];
  if (!response.ok || !response.body) {
    clearTimeout(timer);
    return { status: response.status, headers: response.headers, frames: [await response.text()] };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let opened = false;
  try {
    while (!options.until(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.startsWith(":")) continue;
        frames.push(frame);
      }
      if (!opened && frames.length > 0 && options.onOpen) {
        opened = true;
        await options.onOpen();
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { status: response.status, headers: response.headers, frames };
}

function frameData(frame: string): Record<string, unknown> {
  const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
  return JSON.parse(data) as Record<string, unknown>;
}

test("legacy routes resolve a room id, a join code in any case and a room alias", { skip }, async () => {
  const byId = await api(`/projects/${codeRoomId}/messages`);
  assert.equal(byId.status, 200);
  assert.deepEqual(Object.keys(byId.body), ["project_id", "messages", "has_more"]);
  assert.equal(byId.body.project_id, codeRoomId);

  const byLowerCode = await api(`/projects/${codeRoomId.toLowerCase()}/messages`);
  assert.equal(byLowerCode.status, 200);
  assert.equal(byLowerCode.body.project_id, codeRoomId);

  const byAlias = await api(`/projects/legacy-contract-alias/messages`);
  assert.equal(byAlias.status, 200);
  assert.equal(byAlias.body.project_id, namedRoomId);

  // Only join codes are case-insensitive; a room name is matched exactly.
  const byUpperName = await api(`/projects/LEGACY-CONTRACT-ROOM/messages`);
  assert.equal(byUpperName.status, 404);
  assert.deepEqual(byUpperName.body, { error: "Project not found" });
});

test("legacy routes answer a missing room with 404 Project not found", { skip }, async () => {
  for (const [method, route] of [
    ["GET", "/projects/legacy-missing-room/messages"],
    ["POST", "/projects/legacy-missing-room/messages"],
    ["GET", "/projects/legacy-missing-room/messages/poll?timeout=10"],
    ["GET", "/projects/legacy-missing-room/messages/stream"],
    ["GET", "/projects/ZZZZ-9999/messages"],
  ] as const) {
    const response = await api(route, { method, ...(method === "POST" ? { body: { sender: "A", text: "x" } } : {}) });
    assert.equal(response.status, 404, `${method} ${route}`);
    assert.deepEqual(response.body, { error: "Project not found" }, `${method} ${route}`);
  }
});

test("legacy routes refuse a caller without sign-in (401) and a signed-in non-member (403)", { skip }, async () => {
  for (const route of [
    `/projects/${codeRoomId}/messages`,
    `/projects/${codeRoomId}/messages/poll?timeout=10`,
    `/projects/${codeRoomId}/messages/stream`,
  ]) {
    const anonymous = await api(route, { token: null });
    assert.equal(anonymous.status, 401, route);
    assert.equal(anonymous.body.code, "NOT_AUTHENTICATED", route);
    const outsider = await api(route, { token: OUTSIDER_SESSION });
    assert.equal(outsider.status, 403, route);
    assert.equal(outsider.body.code, "ROOM_MEMBERSHIP_REQUIRED", route);
    assert.equal(outsider.body.room_id, codeRoomId, route);
  }
  const post = await api(`/projects/${codeRoomId}/messages`, {
    method: "POST", token: OUTSIDER_SESSION, body: { sender: "Outsider", text: "hi" },
  });
  assert.equal(post.status, 403);
});

test("legacy send returns the created message without a room id", { skip }, async () => {
  const response = await api(`/projects/${namedRoomId}/messages`, {
    method: "POST", body: { sender: "Legacy Member", text: "contract send" },
  });
  assert.equal(response.status, 201);
  assert.match(response.body.id, /^msg_\d+$/);
  assert.equal(response.body.sender, "Legacy Member");
  assert.equal(response.body.text, "contract send");
  assert.equal(response.body.source, "browser");
  assert.equal("room_id" in response.body, false);
  assert.equal("project_id" in response.body, false);
  assert.equal("account_agent_routing" in response.body, false);
  assert.equal(response.body.thread_root_id, response.body.id);
});

test("legacy send threading and client message ids", { skip }, async () => {
  const root = await send(namedRoomId, "thread root");
  const reply = await send(namedRoomId, "thread reply", { thread_root_id: root.id });
  assert.equal(reply.thread_root_id, reply.id, "the legacy send ignores thread_root_id");
  const firstCopy = await send(namedRoomId, "deduplicated?", { client_message_id: "legacy-contract-client-id" });
  const secondCopy = await send(namedRoomId, "deduplicated?", { client_message_id: "legacy-contract-client-id" });
  assert.notEqual(firstCopy.id, secondCopy.id, "the legacy send ignores client_message_id");
});

test("legacy send rejects a missing text, a non-string text and an unknown prompt kind with 400", { skip }, async () => {
  const route = `/projects/${namedRoomId}/messages`;
  const missing = await api(route, { method: "POST", body: { sender: "Legacy Member" } });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: "sender and text or attachments are required" });
  const blank = await api(route, { method: "POST", body: { sender: "Legacy Member", text: "   " } });
  assert.equal(blank.status, 400);
  assert.deepEqual(blank.body, { error: "sender and text or attachments are required" });
  const numeric = await api(route, { method: "POST", body: { sender: "Legacy Member", text: 7 } });
  assert.equal(numeric.status, 400);
  assert.deepEqual(numeric.body, { error: "sender and text or attachments are required" });
  const kind = await api(route, { method: "POST", body: { sender: "Legacy Member", text: "x", agent_prompt_kind: "join" } });
  assert.equal(kind.status, 400);
  assert.deepEqual(kind.body, { error: "agent_prompt_kind must be one of: inline, auto" });
});

test("legacy list pages forward, backward and from the latest message", { skip }, async () => {
  const room = await rooms!.createProject();
  const member = await accountSessions!.getSessionAccountByToken(MEMBER_SESSION);
  await roomMembers!.recordRoomCreator(room.id, member!.account_id);
  const sent = [];
  for (let index = 1; index <= 5; index += 1) sent.push((await send(room.id, `page ${index}`)).id);
  const base = `/projects/${room.id}/messages`;

  const first = await api(`${base}?limit=2`);
  assert.deepEqual(Object.keys(first.body), ["project_id", "messages", "has_more"]);
  assert.deepEqual(ids(first.body), sent.slice(0, 2));
  assert.equal(first.body.has_more, true);

  const after = await api(`${base}?after=${sent[2]}`);
  assert.deepEqual(ids(after.body), sent.slice(3));
  assert.equal(after.body.has_more, false);

  const latest = await api(`${base}?before=latest&limit=2`);
  assert.deepEqual(Object.keys(latest.body), ["project_id", "messages", "has_more", "has_older"]);
  assert.deepEqual(ids(latest.body), sent.slice(3));
  assert.equal(latest.body.has_more, true);
  assert.equal(latest.body.has_older, true);

  const before = await api(`${base}?before=${sent[2]}&limit=5`);
  assert.deepEqual(ids(before.body), sent.slice(0, 2));
  assert.equal(before.body.has_older, false);

  const zeroLimit = await api(`${base}?limit=0`);
  assert.deepEqual(ids(zeroLimit.body), sent);

  // The legacy list never validated its cursors: a malformed cursor reads as no cursor.
  const badAfter = await api(`${base}?after=not-a-cursor`);
  assert.equal(badAfter.status, 200);
  assert.deepEqual(ids(badAfter.body), sent);
  const badBefore = await api(`${base}?before=not-a-cursor&limit=2`);
  assert.equal(badBefore.status, 200);
  assert.deepEqual(ids(badBefore.body), sent.slice(3));
  // Both cursors: `before` wins and `after` is ignored.
  const both = await api(`${base}?after=${sent[0]}&before=${sent[2]}`);
  assert.equal(both.status, 200);
  assert.deepEqual(ids(both.body), sent.slice(0, 2));
  // `context_only` is a modern-only read; the legacy list ignores it.
  const context = await api(`${base}?context_only=true&before=latest&limit=1`);
  assert.equal(context.status, 200);
  assert.deepEqual(Object.keys(context.body), ["project_id", "messages", "has_more", "has_older"]);

  // A person's list carries no account routing overlay on the legacy path.
  assert.ok(first.body.messages.every((message: Record<string, unknown>) => !("account_agent_routing" in message)));

  // An owner token (the MCP client) reads the same page.
  const owner = await api(`${base}?limit=2`, { token: MEMBER_OWNER_TOKEN });
  assert.equal(owner.status, 200);
  assert.deepEqual(ids(owner.body), sent.slice(0, 2));
});

test("legacy poll: backlog, limit, live wake and timeout bodies", { skip }, async () => {
  const room = await rooms!.createProject();
  const member = await accountSessions!.getSessionAccountByToken(MEMBER_SESSION);
  await roomMembers!.recordRoomCreator(room.id, member!.account_id);
  const sent = [];
  for (let index = 1; index <= 4; index += 1) sent.push((await send(room.id, `poll ${index}`)).id);
  const base = `/projects/${room.id}/messages/poll`;

  const limited = await api(`${base}?after=${sent[0]}&limit=1&timeout=1000`);
  assert.equal(limited.status, 200);
  assert.deepEqual(ids(limited.body), [sent[1]]);
  assert.equal(limited.body.has_more, true);
  assert.equal(limited.body.project_id, room.id);

  const noCursor = await api(`${base}?timeout=1000`);
  assert.equal(noCursor.status, 200);
  assert.deepEqual(ids(noCursor.body), sent);

  const badCursor = await api(`${base}?after=not-a-cursor&timeout=1000`);
  assert.equal(badCursor.status, 200);
  assert.deepEqual(ids(badCursor.body), sent);

  const wake = api(`${base}?after=${sent[3]}&timeout=5000`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const fifth = await send(room.id, "poll 5");
  const woken = await wake;
  assert.equal(woken.status, 200);
  assert.deepEqual(Object.keys(woken.body), ["project_id", "messages", "has_more"]);
  assert.deepEqual(ids(woken.body), [fifth.id]);
  assert.equal(woken.body.has_more, false);
  assert.equal("room_id" in woken.body.messages[0], false);

  const ownerBacklog = await api(`${base}?after=${sent[2]}&timeout=1000`, { token: MEMBER_OWNER_TOKEN });
  assert.equal(ownerBacklog.status, 200);
  assert.deepEqual(ids(ownerBacklog.body), [sent[3], fifth.id]);
});

test("legacy poll backlog and timeout bodies (cursor fields)", { skip }, async () => {
  const room = await rooms!.createProject();
  const member = await accountSessions!.getSessionAccountByToken(MEMBER_SESSION);
  await roomMembers!.recordRoomCreator(room.id, member!.account_id);
  const sent = [];
  for (let index = 1; index <= 3; index += 1) sent.push((await send(room.id, `cursor ${index}`)).id);
  const base = `/projects/${room.id}/messages/poll`;

  const backlog = await api(`${base}?after=${sent[0]}&timeout=1000`);
  assert.equal(backlog.status, 200);
  assert.deepEqual(ids(backlog.body), sent.slice(1));
  assert.deepEqual(Object.keys(backlog.body), ["project_id", "messages", "has_more", "last_observed_message_id"]);
  assert.equal(backlog.body.last_observed_message_id, sent[2]);

  const timedOut = await api(`${base}?after=${sent[2]}&timeout=50`);
  assert.equal(timedOut.status, 200);
  assert.deepEqual(timedOut.body, { project_id: room.id, messages: [], has_more: false });
});

test("legacy SSE stream: headers, room_sync frame, message frames and replay", { skip }, async () => {
  const room = await rooms!.createProject();
  const member = await accountSessions!.getSessionAccountByToken(MEMBER_SESSION);
  await roomMembers!.recordRoomCreator(room.id, member!.account_id);
  const route = `/projects/${room.id}/messages/stream`;
  let first: { id: string } | null = null;
  const opened = await readSse(route, {
    until: (frames) => frames.length >= 2,
    onOpen: async () => { first = await send(room.id, "stream 1"); },
  });
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("content-type"), "text/event-stream");
  assert.equal(opened.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(opened.headers.get("x-accel-buffering"), "no");
  const [sync, message] = opened.frames;
  assert.match(sync!, /^event: room_sync\ndata: /);
  const syncData = frameData(sync!);
  assert.deepEqual(Object.keys(syncData), ["project_id", "event_cursor", "gap"]);
  assert.equal(syncData.project_id, room.id);
  assert.equal(syncData.gap, false);
  // A room with no broker events yet has no event cursor.
  assert.equal(syncData.event_cursor, null);

  const lines = message!.split("\n");
  assert.match(lines[0]!, /^id: \S+$/);
  assert.match(lines[1]!, /^data: /);
  assert.equal(lines.length, 2, "a message frame has no event name");
  const messageData = frameData(message!);
  assert.equal(messageData.id, first!.id);
  assert.equal("room_id" in messageData, false);
  assert.equal("routing_pass" in messageData, false);
  const messageCursor = lines[0]!.slice(4);

  // Reconnect from the message's cursor while a second message is sent: the
  // stream continues after the cursor, and room_sync reports that cursor.
  let second: { id: string } | null = null;
  const resumed = await readSse(route, {
    headers: { "Last-Event-ID": messageCursor },
    until: (frames) => frames.length >= 2,
    onOpen: async () => { second = await send(room.id, "stream 2"); },
  });
  const resumedSync = frameData(resumed.frames[0]!);
  assert.deepEqual(resumedSync, { project_id: room.id, event_cursor: messageCursor, gap: false });
  assert.equal(frameData(resumed.frames[1]!).id, second!.id);

  // A cursor in the event_cursor query parameter replays what came after it.
  const queryReplay = await readSse(`${route}?event_cursor=${encodeURIComponent(messageCursor)}`, {
    until: (frames) => frames.length >= 2,
  });
  assert.equal(frameData(queryReplay.frames[0]!).gap, false);
  assert.equal(frameData(queryReplay.frames[1]!).id, second!.id);

  // An unknown cursor is a gap.
  const unknown = await readSse(route, {
    headers: { "Last-Event-ID": "not-a-cursor" },
    until: (frames) => frames.length >= 1,
  });
  assert.deepEqual(Object.keys(frameData(unknown.frames[0]!)), ["project_id", "event_cursor", "gap"]);
  assert.equal(frameData(unknown.frames[0]!).gap, true);

  // The legacy stream ignores an `after` message cursor.
  const missingAfter = await readSse(`${route}?after=msg_999999`, { until: (frames) => frames.length >= 1 });
  const missingAfterSync = frameData(missingAfter.frames[0]!);
  assert.deepEqual(Object.keys(missingAfterSync), ["project_id", "event_cursor", "gap"]);
  assert.equal(missingAfterSync.gap, false);
});
