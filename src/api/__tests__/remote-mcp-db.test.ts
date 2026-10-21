import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Full API app on a scratch database; the remote MCP server runs in process.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
// API and MCP tools share this process, so one cap applies to both.
process.env.LETAGENTS_POLL_MAX_MS = "1500";
process.env.LETAGENTS_REMOTE_MCP_MAX_SESSIONS_PER_ACCOUNT = "3";
process.env.LETAGENTS_REMOTE_MCP_MAX_IN_FLIGHT_PER_ACCOUNT = "3";

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the DB-backed remote MCP tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const remoteSessionsDb = testDatabaseUrl ? await import("../db/remote-mcp-sessions.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const surface = await import("../../mcp/server/remote-tool-surface.js");
const stateCrypto = await import("../remote-mcp/state-crypto.js");

let server: Server | null = null;
let baseUrl = "";
const TOKEN_A = "remote_mcp_owner_token_a";
const TOKEN_B = "remote_mcp_owner_token_b";

async function createOwner(suffix: string, token: string) {
  const account = await accountSessions!.upsertAccount({
    provider: "github", provider_user_id: `remote-mcp-${suffix}`, login: `remote-mcp-${suffix}`, display_name: `Remote ${suffix}`,
  });
  return ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: `remote-mcp-${suffix}`, token });
}

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    await createOwner("a", TOKEN_A);
    await createOwner("b", TOKEN_B);
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

function sessions() {
  return routesModule!.remoteMcpSessionsForTest()!;
}

if (testDatabaseUrl) {
  // No request may stay counted once a test's clients are done with it.
  test.afterEach(async () => {
    for (let i = 0; i < 100 && sessions().stats().inFlight > 0; i += 1) await new Promise((done) => setTimeout(done, 20));
    assert.equal(sessions().stats().inFlight, 0, "in-flight requests leaked past the test");
  });
}

async function connect(token = TOKEN_A): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "Claude", version: "1" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
  try {
    return { ...JSON.parse(text), isError: result.isError };
  } catch {
    return { raw: text, isError: result.isError };
  }
}

function rawPost(token: string, sessionId: string, body: unknown) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId, "Mcp-Protocol-Version": "2025-06-18",
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

async function stdioToolNames(): Promise<string[]> {
  const temp = mkdtempSync(join(tmpdir(), "letagents-remote-parity-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/mcp/server.ts")],
    cwd: temp,
    env: { PATH: process.env.PATH!, HOME: temp, LETAGENTS_API_URL: "http://127.0.0.1:9",
      LETAGENTS_STATE_PATH: join(temp, "state.json"), LETAGENTS_EXECUTION_PROFILE: "autonomous_mcp_worker" },
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-parity", version: "1" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test("the real API refuses an unknown owner token without echoing it", { skip, timeout: 30_000 }, async () => {
  const response = await rawPost("not-a-real-owner-token", "x", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes("not-a-real-owner-token"), false);
});

test("HTTP exposes exactly the remote allow list; stdio has nothing unclassified", { skip, timeout: 60_000 }, async () => {
  const [stdioNames, remote] = await Promise.all([stdioToolNames(), connect()]);
  try {
    const { tools } = await remote.client.listTools();
    const httpNames = tools.map((tool) => tool.name).sort();
    assert.deepEqual(httpNames, [...surface.REMOTE_ALLOWED_TOOLS].sort());
    assert.deepEqual(stdioNames.filter((name) => !surface.isRemoteExcludedTool(name)), httpNames);
    for (const tool of tools) assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, "cwd"), false, tool.name);
    const flood = await remote.client.callTool({ name: "send_message",
      arguments: { text: "x", reply_to: Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [`k${i}`, i])) } });
    assert.match(JSON.stringify(flood.content), /more than the maximum of 10000 elements/);
  } finally {
    await remote.client.close();
  }
});

test("join_room, register, send_message and read_messages round-trip in process", { skip, timeout: 60_000 }, async () => {
  const { client } = await connect();
  try {
    const joined = await call(client, "join_room", { name: "remote-mcp-round-trip" });
    assert.equal(joined.isError, undefined, JSON.stringify(joined));
    const roomId = String(joined.room_id);
    const worker = await call(client, "register_agent_session",
      { room_id: roomId, display_name: "Remote Claude", runtime: "claude-app" });
    assert.ok(worker.agent_session_id, JSON.stringify(worker));
    assert.equal(worker.agent_session.repo_branch, null, "no git ran on the API server");
    assert.equal(worker.agent_session.host_kind, "remote_mcp");
    const text = `hello from the in-process endpoint ${Date.now()}`;
    const sent = await call(client, "send_message", { room_id: roomId, agent_session_id: worker.agent_session_id, text });
    assert.equal(sent.isError, undefined, JSON.stringify(sent));
    const read = await call(client, "read_messages", { room_id: roomId });
    assert.equal(JSON.stringify(read).includes(text), true);
  } finally {
    await client.close();
  }
});

test("two sessions with different tokens cannot see each other's room state", { skip, timeout: 60_000 }, async () => {
  const a = await connect(TOKEN_A);
  const b = await connect(TOKEN_B);
  try {
    await call(a.client, "join_room", { name: "remote-mcp-isolation-a" });
    const roomA = await call(a.client, "get_current_room");
    assert.equal(roomA.room_id, "remote-mcp-isolation-a", JSON.stringify(roomA));
    const roomB = await call(b.client, "get_current_room");
    assert.notEqual(roomB.room_id, "remote-mcp-isolation-a", "B does not inherit A's room");
    const readB = await call(b.client, "read_messages");
    assert.equal(JSON.stringify(readB).includes("remote-mcp-isolation-a"), false, "B's default room is not A's");
    const crossed = await rawPost(TOKEN_B, a.transport.sessionId!, { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    assert.equal(crossed.status, 404, "B's token cannot use A's session id");
  } finally {
    await Promise.all([a.client.close(), b.client.close()]);
  }
});

test("a session survives a restart by reloading its state from the table", { skip, timeout: 60_000 }, async () => {
  const { client, transport } = await connect();
  try {
    const joined = await call(client, "join_room", { name: "remote-mcp-reload" });
    const worker = await call(client, "register_agent_session",
      { room_id: joined.room_id, display_name: "Reloaded Claude", runtime: "claude-app" });
    const row = await remoteSessionsDb!.getRemoteMcpSession(transport.sessionId!);
    assert.equal(row?.room_id, "remote-mcp-reload");
    assert.equal(row?.worker_session_id, worker.agent_session_id);
    const stored = JSON.stringify(row?.state);
    assert.equal(stored.includes("session_token") || stored.includes("remote-mcp-reload"), false,
      "the saved state is sealed with a key from the owner token");
    assert.equal((row?.state as { v?: unknown }).v, 1);

    sessions().dropLoaded(); // what a restart, or another replica, starts from
    const room = await call(client, "get_current_room");
    assert.equal(room.room_id, "remote-mcp-reload", "the joined room came back from Postgres");
    const sent = await call(client, "send_message",
      { room_id: joined.room_id, agent_session_id: worker.agent_session_id, text: "still here after reload" });
    assert.equal(sent.isError, undefined, `the worker connection came back too: ${JSON.stringify(sent)}`);

    // A durable worker handle is held by the session, so it reloads as well.
    const handle = await call(client, "register_agent_session",
      { room_id: joined.room_id, display_name: "Handle Claude", registration_key: "remote-reload-key" });
    assert.ok(handle.worker_id, JSON.stringify(handle));
    sessions().dropLoaded();
    const viaHandle = await call(client, "send_message",
      { room_id: joined.room_id, worker_id: handle.worker_id, text: "handle survives reload" });
    assert.equal(viaHandle.isError, undefined, JSON.stringify(viaHandle));
  } finally {
    await client.close();
  }
});

test("wait_for_messages in process is capped by LETAGENTS_POLL_MAX_MS", { skip, timeout: 60_000 }, async () => {
  const { client } = await connect();
  try {
    await call(client, "join_room", { name: "remote-mcp-long-poll" });
    const started = Date.now();
    const waited = await client.callTool({ name: "wait_for_messages", arguments: { timeout: 60_000 } });
    const elapsed = Date.now() - started;
    assert.notEqual(waited.isError, true, JSON.stringify(waited.content));
    assert.ok(elapsed >= 1_000, `the call really long-polled (${elapsed} ms)`);
    assert.ok(elapsed < 15_000, `a 60 s request returned after ${elapsed} ms under a 1.5 s cap`);
  } finally {
    await client.close();
  }
});

test("DELETE removes the session, and the account cap replaces the oldest", { skip, timeout: 60_000 }, async () => {
  const first = await connect();
  const id = first.transport.sessionId!;
  await first.transport.terminateSession();
  assert.equal(await remoteSessionsDb!.getRemoteMcpSession(id), null);
  assert.equal((await rawPost(TOKEN_A, id, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404);

  const opened = [];
  for (let i = 0; i < 4; i += 1) opened.push(await connect());
  const ids = opened.map((connection) => connection.transport.sessionId!);
  const remaining = await Promise.all(ids.map((sessionId) => remoteSessionsDb!.getRemoteMcpSession(sessionId)));
  assert.equal(remaining.filter(Boolean).length, 3, "the cap of 3 holds");
  assert.equal(remaining[0], null, "the least recently used session was replaced");
  for (const connection of opened) await connection.client.close().catch(() => undefined);
});

test("revoking the owner token refuses its requests and the sweep deletes its sessions", { skip, timeout: 60_000 }, async () => {
  const created = await createOwner("revoked", "remote_mcp_token_to_revoke");
  const { client, transport } = await connect("remote_mcp_token_to_revoke");
  await ownerTokens!.deleteOwnerTokenById(created.token_id);
  const refused = await rawPost("remote_mcp_token_to_revoke", transport.sessionId!, { jsonrpc: "2.0", id: 9, method: "tools/list" });
  assert.equal(refused.status, 401);
  await sessions().sweep();
  assert.equal(await remoteSessionsDb!.getRemoteMcpSession(transport.sessionId!), null);
  await client.close().catch(() => undefined);
});

test("an account's in-flight requests are capped", { skip, timeout: 60_000 }, async () => {
  await createOwner("in-flight", "remote_mcp_token_in_flight");
  const { client, transport } = await connect("remote_mcp_token_in_flight");
  try {
    await call(client, "join_room", { name: "remote-mcp-in-flight" });
    const waits = Array.from({ length: 3 }, () => client.callTool({ name: "wait_for_messages", arguments: { timeout: 60_000 } }));
    await new Promise((done) => setTimeout(done, 300));
    const refused = await rawPost("remote_mcp_token_in_flight", transport.sessionId!,
      { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "get_current_room", arguments: {} } });
    assert.equal(refused.status, 429, "a fourth request in flight is refused");
    await Promise.all(waits);
    // A slot is free by the time its response arrives: the very next call fits.
    assert.equal(sessions().stats().inFlight, 0, "the polls' slots were released before their responses arrived");
    const after = await call(client, "get_current_room");
    assert.equal(after.room_id, "remote-mcp-in-flight", "requests are served again once the polls end");
    assert.equal(sessions().stats().inFlight, 0, "a call's slot is released before its response arrives");
    for (let round = 0; round < 5; round += 1) {
      const burst = await Promise.all(Array.from({ length: 3 }, () => call(client, "get_current_room")));
      assert.deepEqual(burst.map((result) => result.room_id), Array(3).fill("remote-mcp-in-flight"),
        `back-to-back bursts at the cap are never refused (round ${round})`);
    }
  } finally {
    await client.close();
  }
});

test("a save that races another replica's save merges instead of losing either", { skip, timeout: 60_000 }, async () => {
  await createOwner("merge", "remote_mcp_token_merge");
  const { client, transport } = await connect("remote_mcp_token_merge");
  const sessionId = transport.sessionId!;
  try {
    await call(client, "join_room", { name: "remote-mcp-merge-first" });
    const row = await remoteSessionsDb!.getRemoteMcpSession(sessionId);
    const key = stateCrypto.deriveRemoteMcpStateKey("remote_mcp_token_merge", sessionId);
    const theirs = stateCrypto.openRemoteMcpState(row!.state, key, { sessionId, accountId: row!.account_id }) as Record<string, any>;
    theirs.local.room_sessions = { ...theirs.local.room_sessions, "other-replica-room": {
      room_id: "other-replica-room", joined_via: "join_room", joined_at: "2026-10-21T00:00:00Z", last_seen_at: "2099-01-01T00:00:00Z" } };
    // Another replica saved a newer version this process has not seen.
    await dbClient!.pool.query("UPDATE remote_mcp_sessions SET state = $1, version = version + 1 WHERE session_id = $2",
      [JSON.stringify(stateCrypto.sealRemoteMcpState(theirs, key, { sessionId, accountId: row!.account_id })), sessionId]);

    await call(client, "join_room", { name: "remote-mcp-merge-second" });
    const saved = await remoteSessionsDb!.getRemoteMcpSession(sessionId);
    const merged = stateCrypto.openRemoteMcpState(saved!.state, key, { sessionId, accountId: row!.account_id }) as Record<string, any>;
    assert.ok(merged.local.room_sessions["other-replica-room"], "the other replica's change survived");
    assert.equal(merged.currentRoom.room_id, "remote-mcp-merge-second", "this process's change survived");
    assert.ok(saved!.version > row!.version + 1);
  } finally {
    await client.close();
  }
});

test("concurrent sessions keep their own room, worker and instance, also within one account", { skip, timeout: 60_000 }, async () => {
  await createOwner("iso-c", "remote_mcp_token_iso_c");
  await createOwner("iso-d", "remote_mcp_token_iso_d");
  const a = await connect("remote_mcp_token_iso_c");
  const b = await connect("remote_mcp_token_iso_d");
  const a2 = await connect("remote_mcp_token_iso_c");
  try {
    await call(a.client, "join_room", { name: "remote-mcp-iso-a" });
    // A long-polls while B and A's second session join and register.
    const waiting = a.client.callTool({ name: "wait_for_messages", arguments: { timeout: 60_000 } });
    const [joinedB, joinedA2] = await Promise.all([
      call(b.client, "join_room", { name: "remote-mcp-iso-b" }),
      call(a2.client, "join_room", { name: "remote-mcp-iso-a2" }),
    ]);
    const [workerB, workerA2] = await Promise.all([
      call(b.client, "register_agent_session", { room_id: joinedB.room_id, display_name: "Iso B" }),
      call(a2.client, "register_agent_session", { room_id: joinedA2.room_id, display_name: "Iso A2" }),
    ]);
    await waiting;
    const workerA = await call(a.client, "register_agent_session", { room_id: "remote-mcp-iso-a", display_name: "Iso A" });
    assert.equal((await call(a.client, "get_current_room")).room_id, "remote-mcp-iso-a");
    assert.equal((await call(b.client, "get_current_room")).room_id, "remote-mcp-iso-b");
    assert.equal((await call(a2.client, "get_current_room")).room_id, "remote-mcp-iso-a2");
    const instances = [workerA, workerB, workerA2].map((worker) => worker.agent_session?.agent_instance_id);
    assert.equal(new Set(instances).size, 3, `each session is its own agent instance: ${JSON.stringify(instances)}`);
    const rows = await Promise.all([a, b, a2].map((c) => remoteSessionsDb!.getRemoteMcpSession(c.transport.sessionId!)));
    assert.deepEqual(rows.map((row) => row?.room_id), ["remote-mcp-iso-a", "remote-mcp-iso-b", "remote-mcp-iso-a2"]);
    assert.equal(new Set(rows.map((row) => row?.agent_instance_id)).size, 3);
  } finally {
    await Promise.all([a.client.close(), b.client.close(), a2.client.close()]);
  }
});

test("a long-poll keeps its session alive through the idle sweep", { skip, timeout: 60_000 }, async () => {
  await createOwner("idle", "remote_mcp_token_idle");
  const { client, transport } = await connect("remote_mcp_token_idle");
  const sessionId = transport.sessionId!;
  const age = "UPDATE remote_mcp_sessions SET last_seen_at = now() - interval '2 days' WHERE session_id = $1";
  try {
    await call(client, "join_room", { name: "remote-mcp-idle" });
    const waiting = client.callTool({ name: "wait_for_messages", arguments: { timeout: 60_000 } });
    await new Promise((done) => setTimeout(done, 300));
    // As if the poll had run for hours: only the in-flight mark protects it.
    await dbClient!.pool.query(age, [sessionId]);
    await sessions().sweep();
    assert.ok(await remoteSessionsDb!.getRemoteMcpSession(sessionId), "a session with a request in flight is not swept");
    await waiting;
    assert.equal((await call(client, "get_current_room")).room_id, "remote-mcp-idle", "the room survived the poll");
    const row = await remoteSessionsDb!.getRemoteMcpSession(sessionId);
    assert.ok(Date.parse(row!.last_seen_at) > Date.now() - 60_000, "a request refreshes last_seen");
    await dbClient!.pool.query(age, [sessionId]);
    await sessions().sweep();
    assert.equal(await remoteSessionsDb!.getRemoteMcpSession(sessionId), null, "an idle session is swept");
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("an in-process call re-resolves its owner token: rechecks pass until revocation", { skip, timeout: 60_000 }, async (t) => {
  const express = (await import("express")).default;
  const { registerHttpMiddleware } = await import("../http/middleware.js");
  const { resolveRequestAuth } = await import("../request/auth.js");
  const { InProcessDispatcher } = await import("../remote-mcp/in-process-dispatch.js");
  const rooms = await import("../db/rooms.js");
  const access = await import("../rooms/access.js");
  const { createServer } = await import("node:http");

  // A public repository room: rechecks consult GitHub, served by a stub.
  const github = createServer((req, res) => {
    const found = req.url?.toLowerCase().startsWith("/repos/brosincode/remote-mcp-public");
    res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(found ? { private: false, owner: { login: "BrosInCode" } } : { message: "Not Found" }));
  });
  github.listen(0, "127.0.0.1");
  await once(github, "listening");
  const previousBaseUrl = process.env.GITHUB_API_BASE_URL;
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  t.after(() => {
    if (previousBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
    else process.env.GITHUB_API_BASE_URL = previousBaseUrl;
    github.close();
  });

  const project = await rooms.createProjectWithName("github.com/brosincode/remote-mcp-public");
  assert.equal(access.isRepoBackedProject(project), true);
  const token = "remote_mcp_token_recheck";
  const created = await createOwner("recheck", token);
  const account = await ownerTokens!.getOwnerTokenAccountByToken(token);

  // The route checks once, waits for the test, then checks again (a live recheck).
  const steps = { firstChecked: () => {}, gate: Promise.resolve() };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  app.get("/recheck", async (req, res) => {
    const first = await access.reauthorizeGitRoomParticipant(req as never, project);
    steps.firstChecked();
    await steps.gate;
    const second = await access.reauthorizeGitRoomParticipant(req as never, project);
    res.json({ first, second });
  });
  const dispatch = new InProcessDispatcher(app).bind({
    account: account!, tokenHash: stateCrypto.hashRemoteMcpToken(token), remoteMcpSessionId: "recheck-session",
  });
  const arm = () => {
    const firstChecked = new Promise<void>((done) => { steps.firstChecked = done; });
    let release!: () => void;
    steps.gate = new Promise<void>((done) => { release = done; });
    return { firstChecked, release };
  };

  // A repository-access invalidation: the live check runs again and still passes.
  const kept = arm();
  const keptResponse = dispatch("/recheck", {});
  await kept.firstChecked;
  kept.release();
  assert.deepEqual(await (await keptResponse).json(), { first: true, second: true });

  // Revocation while the request is open: the next live check fails.
  const ended = arm();
  const endedResponse = dispatch("/recheck", {});
  await ended.firstChecked;
  await ownerTokens!.deleteOwnerTokenById(created.token_id);
  ended.release();
  assert.deepEqual(await (await endedResponse).json(), { first: true, second: false });
  assert.equal((await dispatch("/recheck", {})).status, 401, "a revoked session's new in-process calls are refused");
});

test("merging two saves keeps an ended agent session ended", { skip }, async () => {
  const { mergeSessionStates } = await import("../remote-mcp/sessions.js");
  const live = { session_id: "s1", room_id: "r", session_token: "t", ended_at: null } as never;
  const ended = { session_id: "s1", room_id: "r", session_token: "t", ended_at: "2026-10-21T00:00:00Z" } as never;
  const base = { currentRoom: null, fullPromptDelivered: false };
  for (const prefer of ["ours", "theirs"] as const) {
    const merged = mergeSessionStates(
      { ...base, local: { agent_sessions: { s1: live } }, pinnedConnections: { s1: live } },
      { ...base, local: { agent_sessions: { s1: ended } }, pinnedConnections: { s1: ended } },
      prefer,
    );
    assert.equal((merged.local.agent_sessions!.s1 as { ended_at: string | null }).ended_at, "2026-10-21T00:00:00Z", prefer);
    assert.equal(merged.pinnedConnections.s1!.ended_at, "2026-10-21T00:00:00Z", prefer);
  }
});

test("a Git-room long-poll survives a repo-access invalidation and ends when the token is revoked", { skip, timeout: 90_000 }, async (t) => {
  const { createServer } = await import("node:http");
  const { clearGitHubRepoAccessCacheForRoom } = await import("../github/repo-access.js");
  const roomName = "github.com/brosincode/remote-mcp-live";
  // A public repository: GitHub answers through a stub.
  const github = createServer((req, res) => {
    const found = req.url?.toLowerCase().startsWith("/repos/brosincode/remote-mcp-live");
    res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(found
      ? { private: false, full_name: "BrosInCode/remote-mcp-live", owner: { login: "BrosInCode" }, default_branch: "main" }
      : { message: "Not Found" }));
  });
  github.listen(0, "127.0.0.1");
  await once(github, "listening");
  const previous = { base: process.env.GITHUB_API_BASE_URL, cap: process.env.LETAGENTS_POLL_MAX_MS };
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  // A longer cap so "still waiting" and "ended early" are far apart.
  process.env.LETAGENTS_POLL_MAX_MS = "6000";
  t.after(() => {
    if (previous.base === undefined) delete process.env.GITHUB_API_BASE_URL;
    else process.env.GITHUB_API_BASE_URL = previous.base;
    process.env.LETAGENTS_POLL_MAX_MS = previous.cap;
    github.close();
  });

  const token = "remote_mcp_token_live_git";
  const created = await createOwner("live-git", token);
  const { client } = await connect(token);
  try {
    const joined = await call(client, "join_room", { name: roomName });
    assert.equal(joined.isError, undefined, JSON.stringify(joined));
    const roomId = String(joined.room_id);

    const poll = async () => {
      const started = Date.now();
      const result = await client.callTool({ name: "wait_for_messages", arguments: { room_id: roomId, timeout: 60_000 } });
      return { elapsed: Date.now() - started, result };
    };

    // Still valid: an invalidation re-checks the session and the poll goes on.
    const kept = poll();
    await new Promise((done) => setTimeout(done, 700));
    clearGitHubRepoAccessCacheForRoom(roomName);
    const keptResult = await kept;
    assert.notEqual(keptResult.result.isError, true, JSON.stringify(keptResult.result.content));
    assert.ok(keptResult.elapsed >= 5_000, `the poll kept waiting after the invalidation (${keptResult.elapsed} ms)`);

    // Revoked: the next invalidation ends the open poll early.
    const ended = poll();
    await new Promise((done) => setTimeout(done, 700));
    await ownerTokens!.deleteOwnerTokenById(created.token_id);
    clearGitHubRepoAccessCacheForRoom(roomName);
    const endedResult = await ended.catch((error: unknown) => ({ elapsed: 0, result: { isError: true, content: [String(error)] } }));
    assert.ok(endedResult.elapsed < 4_000, `the poll ended soon after revocation (${endedResult.elapsed} ms)`);
    assert.notEqual(JSON.stringify(endedResult.result.content).includes("remote-mcp-live\",\"messages\":[{"), true);
  } finally {
    await client.close().catch(() => undefined);
  }
});
