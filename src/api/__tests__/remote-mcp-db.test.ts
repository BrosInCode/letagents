import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Full API app on a scratch database, real MCP children over streamable HTTP.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
// The child inherits the API's cap; keep it short so the cap is observable.
process.env.LETAGENTS_POLL_MAX_MS = "1500";

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the DB-backed remote MCP tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;

let server: Server | null = null;
let baseUrl = "";
const TOKEN = "remote_mcp_owner_token_for_tests";

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    const account = await accountSessions!.upsertAccount({
      provider: "github", provider_user_id: "remote-mcp-1", login: "remote-mcp-owner", display_name: "Remote MCP",
    });
    await ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: "remote-mcp-1", token: TOKEN });
    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.after(async () => {
    routesModule!.closeApiRouteEventBroker();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    await dbClient!.pool.end();
  });
}

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: "Claude", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((part) => part.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

test("the real API refuses a revoked or unknown owner token on /mcp", { skip, timeout: 30_000 }, async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer not-a-real-owner-token", "Content-Type": "application/json",
      Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
  });
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.equal(text.includes("not-a-real-owner-token"), false, "the error does not echo the token");
});

test("join_room, send_message and read_messages round-trip over HTTP", { skip, timeout: 90_000 }, async () => {
  const client = await connect();
  try {
    const joined = payload(await client.callTool({ name: "join_room", arguments: { name: "remote-mcp-round-trip" } }));
    assert.equal(joined.error, undefined, JSON.stringify(joined));
    const roomId = String(joined.room_id ?? joined.room?.room_id ?? "");
    assert.ok(roomId, `join_room returned a room id: ${JSON.stringify(joined)}`);

    // Writes need a registered worker, exactly as with the npm package.
    const worker = payload(await client.callTool({ name: "register_agent_session",
      arguments: { room_id: roomId, display_name: "Remote Claude", runtime: "claude-app" } }));
    assert.ok(worker.agent_session_id, `register_agent_session returned a session: ${JSON.stringify(worker)}`);

    const text = `hello from the remote endpoint ${Date.now()}`;
    const sent = payload(await client.callTool({ name: "send_message",
      arguments: { room_id: roomId, agent_session_id: worker.agent_session_id, text } }));
    assert.equal(sent.error, undefined, JSON.stringify(sent));

    const read = await client.callTool({ name: "read_messages", arguments: { room_id: roomId } });
    const body = JSON.stringify(read.content);
    assert.equal(body.includes(text), true, "read_messages returns the message sent over HTTP");
  } finally {
    await client.close();
  }
});

test("wait_for_messages over HTTP is capped by LETAGENTS_POLL_MAX_MS", { skip, timeout: 90_000 }, async () => {
  const client = await connect();
  try {
    payload(await client.callTool({ name: "join_room", arguments: { name: "remote-mcp-long-poll" } }));
    const first = payload(await client.callTool({ name: "read_messages", arguments: {} }));
    assert.deepEqual(first.messages, [], "a new room has nothing to return at once");
    const started = Date.now();
    const waited = await client.callTool({ name: "wait_for_messages",
      arguments: { timeout: 60_000 } });
    const elapsed = Date.now() - started;
    assert.notEqual(waited.isError, true, JSON.stringify(waited.content));
    assert.ok(elapsed >= 1_000, `the call really long-polled (${elapsed} ms)`);
    assert.ok(elapsed < 15_000, `a 60 s request returned after ${elapsed} ms under a 1.5 s cap`);
  } finally {
    await client.close();
  }
});

test("revoking the owner token refuses its requests and closes its sessions", { skip, timeout: 90_000 }, async () => {
  const revocable = "remote_mcp_token_to_revoke";
  const account = await accountSessions!.upsertAccount({
    provider: "github", provider_user_id: "remote-mcp-2", login: "remote-mcp-revoked", display_name: "Revoked",
  });
  const created = await ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: "remote-mcp-2", token: revocable });
  const client = await connect(revocable);
  const transport = client.transport as StreamableHTTPClientTransport;
  const sessions = routesModule!.remoteMcpSessionsForTest()!;
  const before = sessions.size;
  await ownerTokens!.deleteOwnerTokenById(created.token_id);

  const refused = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${revocable}`, "Mcp-Session-Id": transport.sessionId!,
      "Mcp-Protocol-Version": "2025-06-18", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
  });
  assert.equal(refused.status, 401, "the middleware refuses the revoked token on its open session");

  sessions.sweep();
  for (let i = 0; i < 100 && sessions.size >= before; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(sessions.size, before - 1, "the sweep closed the revoked token's session");
  await client.close().catch(() => undefined);
});
