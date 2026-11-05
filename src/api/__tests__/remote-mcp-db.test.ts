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
// The suite opens many short sessions; the growth test needs a small worker bound.
process.env.LETAGENTS_REMOTE_MCP_SESSIONS_PER_MINUTE = "1000";
process.env.LETAGENTS_REMOTE_MCP_MAX_CREDENTIAL_WORKERS = "4";

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
/** A second owner token of account A: another credential, so another credential state. */
const TOKEN_A2 = "remote_mcp_owner_token_a_second";
const TOKEN_B = "remote_mcp_owner_token_b";

async function createOwner(suffix: string, token: string) {
  const account = await accountSessions!.upsertAccount({
    provider: "github", provider_user_id: `remote-mcp-${suffix}`, login: `remote-mcp-${suffix}`, display_name: `Remote ${suffix}`,
  });
  // A GitHub token too, so a public repository room can check the person's role.
  return ownerTokens!.createOwnerToken({
    accountId: account.id, githubUserId: `remote-mcp-${suffix}`, token, providerAccessToken: `github-token-${suffix}`,
  });
}

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    await createOwner("a", TOKEN_A);
    await createOwner("a", TOKEN_A2);
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

/** The tool result inside a streamed (SSE) MCP response, parsed like `call` parses it. */
async function toolResultOf(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  const message = JSON.parse(data.at(-1) ?? "{}") as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }; error?: unknown };
  if (message.error) return { rpcError: message.error };
  const part = message.result?.content?.find((entry) => entry.type === "text")?.text ?? "";
  try {
    return { ...JSON.parse(part), isError: message.result?.isError };
  } catch {
    return { raw: part, isError: message.result?.isError };
  }
}

function statelessPost(token: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

function toolCall(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
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

test("a new session of the same credential starts from the earlier session's room and worker handle", { skip, timeout: 60_000 }, async () => {
  // ChatGPT's connector opens a new session for every tool call. The worker it
  // registered in one call must answer in the next.
  const first = await connect();
  let joined: Record<string, any>;
  let handle: Record<string, any>;
  try {
    joined = await call(first.client, "join_room", { name: "remote-mcp-credential" });
    handle = await call(first.client, "register_agent_session",
      { room_id: joined.room_id, display_name: "Per-call Dot", registration_key: "credential-key-1", runtime: "dot" });
    assert.ok(handle.worker_id, JSON.stringify(handle));
  } finally {
    await first.client.close();
  }
  sessions().dropLoaded(); // another replica, or this one after a restart

  const second = await connect();
  try {
    assert.notEqual(second.transport.sessionId, first.transport.sessionId);
    const room = await call(second.client, "get_current_room");
    assert.notEqual(room.room_id, "remote-mcp-credential", "a new chat never inherits another chat's joined room");
    const sent = await call(second.client, "send_message",
      { room_id: joined.room_id, worker_id: handle.worker_id, text: "sent from the next session" });
    assert.equal(sent.isError, undefined, `the worker handle came along: ${JSON.stringify(sent)}`);
    const recovered = await call(second.client, "register_agent_session",
      { room_id: joined.room_id, display_name: "Per-call Dot", recover_lost_worker: true });
    assert.equal(recovered.worker_id, handle.worker_id, `a chat that lost its worker_id gets it back: ${JSON.stringify(recovered)}`);
  } finally {
    await second.client.close();
  }

  // A live credential survives the sweep; only a revoked one goes.
  await sessions().sweep();
  assert.ok(await remoteSessionsDb!.getRemoteMcpCredential(stateCrypto.hashRemoteMcpToken(TOKEN_A)), "the credential state outlives the sweep");

  // Another credential of the same account has its own state.
  const other = await connect(TOKEN_A2);
  try {
    const refused = await call(other.client, "send_message",
      { room_id: joined.room_id, worker_id: handle.worker_id, text: "not mine" });
    assert.equal(refused.isError, true, JSON.stringify(refused));
    assert.match(String(refused.raw ?? JSON.stringify(refused)), /Unknown worker_id/);
  } finally {
    await other.client.close();
  }
});

test("requests without a session id run in the credential's implicit session, which the next one reuses", { skip, timeout: 60_000 }, async () => {
  const first = await statelessPost(TOKEN_A, toolCall(1, "join_room", { name: "remote-mcp-stateless" }));
  assert.equal(first.status, 200, await first.clone().text());
  const sessionId = first.headers.get("mcp-session-id");
  assert.ok(sessionId, "the implicit session has an id, which the client may ignore");
  const joined = await toolResultOf(first);
  assert.equal(joined.room_id, "remote-mcp-stateless", JSON.stringify(joined));
  assert.equal((await remoteSessionsDb!.getRemoteMcpSession(sessionId!))?.client_name, "stateless");

  // ChatGPT's connector sends every call without a session id, so its
  // User-Agent product is the only hint of the client: the answer's wake-up
  // text is written for ChatGPT, and the full header is kept nowhere.
  const registered = await statelessPost(TOKEN_A, toolCall(2, "register_agent_session",
    { room_id: joined.room_id, display_name: "Stateless Dot", registration_key: "stateless-key-1", runtime: "dot" }),
    { "User-Agent": "openai-mcp/1.0.0 (secret build 42)" });
  assert.equal(registered.headers.get("mcp-session-id"), sessionId, "the implicit session is reused");
  const handle = await toolResultOf(registered);
  assert.ok(handle.worker_id, JSON.stringify(handle));
  assert.equal(handle.wake_up?.status, "polling_only", JSON.stringify(handle.wake_up));
  assert.match(String(handle.wake_up?.how), /^Ask your person to say: Watch the LetAgents room remote-mcp-stateless/);
  assert.equal((await remoteSessionsDb!.getRemoteMcpSession(sessionId!))?.client_name, "stateless", "the hint is not stored");

  sessions().dropLoaded();
  const sent = await statelessPost(TOKEN_A, toolCall(3, "send_message",
    { room_id: joined.room_id, worker_id: handle.worker_id, text: "hello without a session id" }));
  assert.equal(sent.headers.get("mcp-session-id"), sessionId);
  const result = await toolResultOf(sent);
  assert.equal(result.isError, undefined, JSON.stringify(result));

  // A stateful client of the same credential starts from the same worker state, in its own session.
  const stateful = await connect();
  let later: Record<string, any>;
  try {
    assert.notEqual(stateful.transport.sessionId, sessionId);
    const viaHandle = await call(stateful.client, "send_message",
      { room_id: joined.room_id, worker_id: handle.worker_id, text: "same worker, stateful session" });
    assert.equal(viaHandle.isError, undefined, JSON.stringify(viaHandle));
    // ... and a worker it registers is usable by the next session-less call at once.
    later = await call(stateful.client, "register_agent_session",
      { room_id: joined.room_id, display_name: "Later Dot", registration_key: "stateless-key-2", runtime: "dot" });
    assert.ok(later.worker_id, JSON.stringify(later));
  } finally {
    await stateful.client.close();
  }
  const fromLater = await statelessPost(TOKEN_A, toolCall(4, "send_message",
    { room_id: joined.room_id, worker_id: later.worker_id, text: "registered elsewhere, sent without a session id" }));
  assert.equal(fromLater.headers.get("mcp-session-id"), sessionId, "still the one implicit session");
  const fromLaterResult = await toolResultOf(fromLater);
  assert.equal(fromLaterResult.isError, undefined, `the implicit session re-read the credential state: ${JSON.stringify(fromLaterResult)}`);
});

test("parallel requests without a session id never lose a worker", { skip, timeout: 120_000 }, async () => {
  // ChatGPT may run several tool calls of one turn at once, all without a
  // session id. Each registration must survive the others' folds and refreshes.
  const token = "remote_mcp_owner_token_parallel";
  await createOwner("parallel", token);
  const roomId = (await toolResultOf(await statelessPost(token, toolCall(1, "join_room", { name: "remote-mcp-parallel" })))).room_id;
  assert.ok(roomId);
  const parallel = Number(process.env.LETAGENTS_REMOTE_MCP_MAX_IN_FLIGHT_PER_ACCOUNT);
  // This test registers more workers than the suite's small credential bound (the bound is read per call).
  const boundBefore = process.env.LETAGENTS_REMOTE_MCP_MAX_CREDENTIAL_WORKERS;
  process.env.LETAGENTS_REMOTE_MCP_MAX_CREDENTIAL_WORKERS = "64";
  const handles: string[] = [];
  for (let round = 0; round < 4; round += 1) {
    const results = await Promise.all(Array.from({ length: parallel }, (_, i) => statelessPost(token,
      toolCall(10 + round * parallel + i, "register_agent_session",
        { room_id: roomId, display_name: `Parallel ${round}-${i}`, registration_key: `parallel-key-${round}-${i}`, runtime: "dot" }))
      .then(toolResultOf)));
    for (const result of results) {
      assert.ok(result.worker_id, `every parallel registration answered a worker_id: ${JSON.stringify(result)}`);
      handles.push(result.worker_id);
    }
  }
  sessions().dropLoaded();
  try {
    for (const [i, workerId] of handles.entries()) {
      const sent = await toolResultOf(await statelessPost(token, toolCall(100 + i, "send_message",
        { room_id: roomId, worker_id: workerId, text: `parallel worker ${i} reporting` })));
      assert.equal(sent.isError, undefined, `worker ${i} of ${handles.length} is still known: ${JSON.stringify(sent)}`);
    }
  } finally {
    process.env.LETAGENTS_REMOTE_MCP_MAX_CREDENTIAL_WORKERS = boundBefore;
  }
});

test("parallel first requests without a session id share one implicit session", { skip, timeout: 60_000 }, async () => {
  const token = "remote_mcp_owner_token_race";
  await createOwner("race", token);
  const parallel = Number(process.env.LETAGENTS_REMOTE_MCP_MAX_IN_FLIGHT_PER_ACCOUNT);
  const responses = await Promise.all(Array.from({ length: parallel }, (_, i) => statelessPost(token, toolCall(1 + i, "get_current_room"))));
  const ids = new Set(responses.map((response) => response.headers.get("mcp-session-id")));
  assert.deepEqual(responses.map((response) => response.status), Array.from({ length: parallel }, () => 200));
  assert.equal(ids.size, 1, `one implicit session for all of them: ${[...ids].join(", ")}`);
  const rows = await dbClient!.pool.query("SELECT count(*)::int AS n FROM remote_mcp_sessions WHERE token_hash = $1 AND implicit",
    [stateCrypto.hashRemoteMcpToken(token)]);
  assert.equal(rows.rows[0].n, 1);
});

test("the session cap is per credential: one sign-in's churn leaves another's sessions alone", { skip, timeout: 60_000 }, async () => {
  const keeper = await connect(TOKEN_A);
  const keeperId = keeper.transport.sessionId!;
  await keeper.client.close();
  const cap = Number(process.env.LETAGENTS_REMOTE_MCP_MAX_SESSIONS_PER_ACCOUNT);
  const churn = [];
  for (let i = 0; i < cap + 1; i += 1) churn.push(await connect(TOKEN_A2));
  const churnIds = churn.map((connection) => connection.transport.sessionId!);
  for (const connection of churn) await connection.client.close().catch(() => undefined);
  assert.ok(await remoteSessionsDb!.getRemoteMcpSession(keeperId), "the other sign-in's session was not replaced");
  const remaining = await Promise.all(churnIds.map((id) => remoteSessionsDb!.getRemoteMcpSession(id)));
  assert.equal(remaining.filter(Boolean).length, cap, "the churning sign-in holds exactly its cap");
  assert.equal(remaining[0], null, "its least recently used session went");
});

test("a registration key reused in another room gives a worker that posts in that room", { skip, timeout: 60_000 }, async () => {
  // Seen in production: a chat registered with its key in room A one day and in
  // room B the next. The handle came back with a new agent session in B, but
  // every send_message with it answered "no current connection in this process".
  const token = "remote_mcp_owner_token_two_rooms";
  await createOwner("two-rooms", token);
  const step = async <T,>(run: (client: Client) => Promise<T>): Promise<T> => {
    const { client } = await connect(token);
    try {
      return await run(client);
    } finally {
      await client.close();
      sessions().dropLoaded();
    }
  };
  const key = "pinger-key-kept-across-rooms";
  const roomA = await step((client) => call(client, "join_room", { name: "remote-mcp-two-rooms-a" }));
  const inA = await step((client) => call(client, "register_agent_session",
    { room_id: roomA.room_id, display_name: "Pinger", registration_key: key, runtime: "dot" }));
  assert.ok(inA.worker_id, JSON.stringify(inA));
  const sentA = await step((client) => call(client, "send_message", { room_id: roomA.room_id, worker_id: inA.worker_id, text: "pinging A" }));
  assert.equal(sentA.isError, undefined, JSON.stringify(sentA));

  // The next day, the same key in room B: one session joins B, registers and posts.
  const roomB = await step((client) => call(client, "join_room", { name: "remote-mcp-two-rooms-b" }));
  const inB = await step(async (client) => {
    await call(client, "join_room", { name: "remote-mcp-two-rooms-b" });
    const registered = await call(client, "register_agent_session",
      { room_id: roomB.room_id, display_name: "Pinger", registration_key: key, runtime: "dot" });
    assert.equal(registered.isError, undefined, JSON.stringify(registered));
    assert.equal(registered.worker_id, inA.worker_id, "one key is one worker handle, bound in both rooms");
    assert.equal(registered.agent_session.room_id, roomB.room_id);
    const sent = await call(client, "send_message", { worker_id: registered.worker_id, text: "pinging B from the joined room" });
    assert.equal(sent.isError, undefined, `the worker posts in the room this session joined: ${JSON.stringify(sent)}`);
    return registered;
  });
  // In a fresh session (no joined room) the worker posts where room_id says, in both rooms.
  for (const [room, text] of [[roomB, "pinging B by room_id"], [roomA, "pinging A again"]] as const) {
    const sent = await step((client) => call(client, "send_message", { room_id: room.room_id, worker_id: inB.worker_id, text }));
    assert.equal(sent.isError, undefined, JSON.stringify(sent));
  }
  // Without a room_id and without a joined room, the answer names the rooms and asks for one.
  const ambiguous = await step((client) => call(client, "send_message", { worker_id: inB.worker_id, text: "where?" }));
  assert.equal(ambiguous.isError, true, JSON.stringify(ambiguous));
  assert.match(String(ambiguous.raw), /registered in 2 rooms/);
  assert.match(String(ambiguous.raw), /Pass room_id/);
  // A reconnect by worker_id in B keeps the worker usable in B.
  const back = await step((client) => call(client, "register_agent_session", { room_id: roomB.room_id, worker_id: inB.worker_id, runtime: "dot" }));
  assert.equal(back.isError, undefined, JSON.stringify(back));
  const sentAfter = await step((client) => call(client, "send_message", { room_id: roomB.room_id, worker_id: inB.worker_id, text: "pinging B after reconnect" }));
  assert.equal(sentAfter.isError, undefined, JSON.stringify(sentAfter));
  // A room the worker never registered in says so, and what to do.
  const roomC = await step((client) => call(client, "join_room", { name: "remote-mcp-two-rooms-c" }));
  const elsewhere = await step((client) => call(client, "send_message", { room_id: roomC.room_id, worker_id: inB.worker_id, text: "not here" }));
  assert.equal(elsewhere.isError, true, JSON.stringify(elsewhere));
  assert.match(String(elsewhere.raw), /not registered in room/);
  assert.match(String(elsewhere.raw), /call register_agent_session\(worker_id, room_id "remote-mcp-two-rooms-c"\) first/);
  const inRoomB = await step((client) => call(client, "read_messages", { room_id: roomB.room_id }));
  const textsB = JSON.stringify(inRoomB);
  for (const text of ["pinging B from the joined room", "pinging B by room_id", "pinging B after reconnect"]) {
    assert.equal(textsB.includes(text), true, `room B has "${text}"`);
  }
  assert.equal(textsB.includes("pinging A"), false, "nothing for A landed in B");
});

test("a worker ended in one per-call session registers again in the next", { skip, timeout: 60_000 }, async () => {
  // ChatGPT's flow when liveness or the agent ends a worker session: each
  // step is a new MCP session. The ended session's token is the proof the
  // next registration of the same worker presents, so the credential keeps it.
  const token = "remote_mcp_owner_token_reregister";
  await createOwner("reregister", token);
  const step = async <T,>(run: (client: Client) => Promise<T>): Promise<T> => {
    const { client } = await connect(token);
    try {
      return await run(client);
    } finally {
      await client.close();
      sessions().dropLoaded();
    }
  };
  const joined = await step((client) => call(client, "join_room", { name: "remote-mcp-reregister" }));
  const handle = await step((client) => call(client, "register_agent_session",
    { room_id: joined.room_id, display_name: "Returning Dot", registration_key: "reregister-key", runtime: "dot" }));
  assert.ok(handle.worker_id, JSON.stringify(handle));
  const first = await step((client) => call(client, "send_message", { room_id: joined.room_id, worker_id: handle.worker_id, text: "first life" }));
  assert.equal(first.isError, undefined, JSON.stringify(first));
  const ended = await step((client) => call(client, "disconnect_agent_session", { room_id: joined.room_id, worker_id: handle.worker_id }));
  assert.equal(ended.isError, undefined, JSON.stringify(ended));
  const again = await step((client) => call(client, "register_agent_session", { room_id: joined.room_id, worker_id: handle.worker_id, runtime: "dot" }));
  assert.equal(again.isError, undefined, `the same worker registers again from a new session: ${JSON.stringify(again)}`);
  assert.equal(again.worker_id, handle.worker_id);
  const second = await step((client) => call(client, "send_message", { room_id: joined.room_id, worker_id: handle.worker_id, text: "second life" }));
  assert.equal(second.isError, undefined, JSON.stringify(second));
});

test("two parallel re-registrations of one worker leave it usable, whichever one the server refuses", { skip, timeout: 60_000 }, async () => {
  // Separate per-call sessions do not share the stdio process's in-flight
  // map, so both reach the server. The refused one must not leave a prepared
  // operation behind that blocks the worker for every later session.
  const token = "remote_mcp_owner_token_double";
  await createOwner("double", token);
  const step = async <T,>(run: (client: Client) => Promise<T>): Promise<T> => {
    const { client } = await connect(token);
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  };
  const joined = await step((client) => call(client, "join_room", { name: "remote-mcp-double" }));
  const handle = await step((client) => call(client, "register_agent_session",
    { room_id: joined.room_id, display_name: "Doubled Dot", registration_key: "double-key", runtime: "dot" }));
  assert.ok(handle.worker_id, JSON.stringify(handle));
  await step((client) => call(client, "disconnect_agent_session", { room_id: joined.room_id, worker_id: handle.worker_id }));
  sessions().dropLoaded();
  const [a, b] = await Promise.all([
    step((client) => call(client, "register_agent_session", { room_id: joined.room_id, worker_id: handle.worker_id, runtime: "dot" })),
    step((client) => call(client, "register_agent_session", { room_id: joined.room_id, worker_id: handle.worker_id, runtime: "dot" })),
  ]);
  assert.ok([a, b].some((result) => result.isError === undefined), `at least one re-registration succeeds: ${JSON.stringify([a, b])}`);
  sessions().dropLoaded();
  const sent = await step((client) => call(client, "send_message", { room_id: joined.room_id, worker_id: handle.worker_id, text: "still here after the race" }));
  if (sent.isError) {
    // The winner's connection may have been replaced by the loser's attempt; an explicit reconnect must then work.
    const again = await step((client) => call(client, "register_agent_session", { room_id: joined.room_id, worker_id: handle.worker_id, runtime: "dot" }));
    assert.equal(again.isError, undefined, `a later re-registration is not blocked by a leftover prepared operation: ${JSON.stringify(again)}`);
    const resent = await step((client) => call(client, "send_message", { room_id: joined.room_id, worker_id: handle.worker_id, text: "here after the reconnect" }));
    assert.equal(resent.isError, undefined, JSON.stringify(resent));
  }
});

test("an out-of-date session reloaded after a restart does not write over a worker's newer binding", { skip, timeout: 60_000 }, async () => {
  const token = "remote_mcp_owner_token_reload";
  await createOwner("reload", token);
  const one = await connect(token);
  const joined = await call(one.client, "join_room", { name: "remote-mcp-reload-stale" });
  const handle = await call(one.client, "register_agent_session",
    { room_id: joined.room_id, display_name: "Rotating Dot", registration_key: "reload-key", runtime: "dot" });
  assert.ok(handle.worker_id, JSON.stringify(handle));
  // A second session of the same sign-in starts from the same worker binding...
  const two = await connect(token);
  await call(two.client, "join_room", { name: "remote-mcp-reload-stale" });
  // ...then the first session ends the worker and registers it again, so its token rotates.
  await call(one.client, "disconnect_agent_session", { room_id: joined.room_id, worker_id: handle.worker_id });
  const rotated = await call(one.client, "register_agent_session", { room_id: joined.room_id, worker_id: handle.worker_id, runtime: "dot" });
  assert.equal(rotated.isError, undefined, JSON.stringify(rotated));
  await one.client.close();
  // A restart (or another replica) reloads the out-of-date second session, which then saves something unrelated.
  sessions().dropLoaded();
  const unrelated = await call(two.client, "join_room", { name: "remote-mcp-reload-other" });
  assert.equal(unrelated.isError, undefined, JSON.stringify(unrelated));
  await two.client.close();
  sessions().dropLoaded();
  const fresh = await connect(token);
  try {
    const sent = await call(fresh.client, "send_message", { room_id: joined.room_id, worker_id: handle.worker_id, text: "after the rotation and the reload" });
    assert.equal(sent.isError, undefined, `the rotated binding survived the stale session's save: ${JSON.stringify(sent)}`);
  } finally {
    await fresh.client.close();
  }
});

test("the credential state stays bounded as per-call sessions keep registering workers", { skip, timeout: 120_000 }, async () => {
  const token = "remote_mcp_owner_token_growth";
  await createOwner("growth", token);
  const maxWorkers = Number(process.env.LETAGENTS_REMOTE_MCP_MAX_CREDENTIAL_WORKERS);
  let roomId = "";
  const handles: string[] = [];
  for (let i = 0; i < maxWorkers + 3; i += 1) {
    const { client } = await connect(token); // a new session per call, as ChatGPT does
    try {
      if (!roomId) roomId = (await call(client, "join_room", { name: "remote-mcp-growth" })).room_id;
      const handle = await call(client, "register_agent_session",
        { room_id: roomId, display_name: `Growth ${i}`, registration_key: `growth-key-${i}`, runtime: "dot" });
      assert.ok(handle.worker_id, JSON.stringify(handle));
      handles.push(handle.worker_id);
    } finally {
      await client.close();
    }
    sessions().dropLoaded();
  }
  const row = await remoteSessionsDb!.getRemoteMcpCredential(stateCrypto.hashRemoteMcpToken(token));
  assert.ok(row, "the credential row exists");
  const state = stateCrypto.openRemoteMcpState(row!.state, stateCrypto.deriveRemoteMcpCredentialStateKey(token),
    { sessionId: stateCrypto.REMOTE_MCP_CREDENTIAL_BINDING, accountId: row!.account_id }) as {
      local: { mcp_workers?: Record<string, unknown>; agent_sessions?: Record<string, unknown>; agent_identities?: unknown; agent_identity?: unknown };
      currentRoom: unknown; fullPromptDelivered: boolean; pinnedConnections: Record<string, unknown>;
    };
  assert.equal(Object.keys(state.local.mcp_workers ?? {}).length, maxWorkers, "only the most recently seen workers are kept");
  assert.ok(Object.keys(state.local.agent_sessions ?? {}).length <= maxWorkers);
  assert.ok(Object.keys(state.pinnedConnections).length <= maxWorkers);
  assert.equal(state.local.agent_identities, undefined, "per-instance identities are not kept");
  assert.equal(state.local.agent_identity, undefined);
  assert.equal(state.currentRoom, null, "no joined room is kept");
  assert.equal(state.fullPromptDelivered, false);
  assert.ok(Object.hasOwn(state.local.mcp_workers ?? {}, handles.at(-1)!), "the newest worker is kept");
  assert.equal(Object.hasOwn(state.local.mcp_workers ?? {}, handles[0]!), false, "the oldest worker was dropped");

  // The newest handle still works from yet another new session.
  const { client } = await connect(token);
  try {
    const sent = await call(client, "send_message", { room_id: roomId, worker_id: handles.at(-1)!, text: "still bounded, still working" });
    assert.equal(sent.isError, undefined, JSON.stringify(sent));
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
  await call(client, "join_room", { name: "remote-mcp-revoked" });
  const credentialHash = stateCrypto.hashRemoteMcpToken("remote_mcp_token_to_revoke");
  assert.ok(await remoteSessionsDb!.getRemoteMcpCredential(credentialHash), "a call that changed state wrote the credential state");
  await ownerTokens!.deleteOwnerTokenById(created.token_id);
  const refused = await rawPost("remote_mcp_token_to_revoke", transport.sessionId!, { jsonrpc: "2.0", id: 9, method: "tools/list" });
  assert.equal(refused.status, 401);
  await sessions().sweep();
  assert.equal(await remoteSessionsDb!.getRemoteMcpSession(transport.sessionId!), null);
  assert.equal(await remoteSessionsDb!.getRemoteMcpCredential(credentialHash), null, "the credential state went with the token");
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
    // The caller's own role: a public repository room needs triage or more.
    const role = req.headers.authorization ? { permissions: { pull: true, triage: true } } : {};
    res.end(JSON.stringify(found ? { private: false, owner: { login: "BrosInCode" }, ...role } : { message: "Not Found" }));
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
      ? { private: false, full_name: "BrosInCode/remote-mcp-live", owner: { login: "BrosInCode" }, default_branch: "main",
        ...(req.headers.authorization ? { permissions: { pull: true, triage: true } } : {}) }
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
