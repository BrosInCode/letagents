import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function until<T>(read: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

test("a process holds its connection open, learns when its session is ended, and says when it exits", { timeout: 90_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "letagents-process-connection-"));
  const statePath = join(temp, "state.json");
  const storagePath = join(temp, "storage.json");
  writeFileSync(storagePath, JSON.stringify({ mode: "cloud", roomOverrides: {} }));
  writeFileSync(statePath, JSON.stringify({ auth: { token: "owner-test-token",
    source: "device_flow", stored_at: new Date().toISOString() } }));

  const sessions = new Map<string, Record<string, any>>();
  const registrations: Record<string, any>[] = [];
  const held = new Map<string, ServerResponse>();
  const opened: Array<{ session_id: string; token: string | undefined }> = [];
  const exits: Array<{ session_id: string; connection_id: unknown }> = [];
  let processConnection: "served" | "unknown" | "refused" = "served";
  let refusals = 0;
  let busyRegistrations = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, "http://localhost");
    const reply = (value: unknown, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/agents/me") return reply({ account: { id: "owner-id", login: "owner" }, agents: [] });
    if (url.pathname === "/agents") return reply({ canonical_key: `owner/${body.name}`, ...body });
    if (url.pathname.endsWith("/agent-sessions")) {
      if (busyRegistrations > 0) {
        busyRegistrations -= 1;
        res.setHeader("Retry-After", "1");
        return reply({ error: "Agent session registration is busy. Retry shortly." }, 503);
      }
      registrations.push(body);
      const prior = sessions.get(body.agent_instance_id);
      const now = new Date().toISOString();
      const session = { session_id: prior?.session_id ?? `session_${sessions.size + 1}`, session_token: body.connection_token,
        agent_key: body.actor_key, agent_instance_id: body.agent_instance_id, session_kind: "worker", room_id: url.pathname.split("/")[2],
        display_name: body.display_name, actor_label: `${body.display_name} | Owner | Agent`, owner_label: "Owner", ide_label: "Agent",
        runtime: body.runtime, created_at: prior?.created_at ?? now, updated_at: now, last_seen_at: now, ended_at: null };
      sessions.set(body.agent_instance_id, session);
      return reply(session, 201);
    }
    const process = url.pathname.match(/\/agent-sessions\/([^/]+)\/process(\/exit)?$/);
    if (process) {
      const sessionId = decodeURIComponent(process[1]!);
      if (processConnection === "unknown") return reply({ error: "Not found" }, 404);
      if (processConnection === "refused" && !process[2]) {
        refusals += 1;
        return reply({ error: "Invalid agent session credentials." }, 401);
      }
      if (process[2]) { exits.push({ session_id: sessionId, connection_id: body.process_connection_id }); return reply({ recorded: true }); }
      const session = [...sessions.values()].find((candidate) => candidate.session_id === sessionId);
      if (!session || session.ended_at) return reply({ error: "Agent session has ended.", code: "agent_session_ended" }, 410);
      opened.push({ session_id: sessionId, token: req.headers["x-letagents-agent-session-token"] as string | undefined });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: open\ndata: {"connection_id":"00000000-0000-4000-8000-00000000000${opened.length}"}\n\n`);
      held.set(sessionId, res);
      return;
    }
    if (url.pathname.endsWith("/messages")) return reply({ messages: [], room_id: "room_shared" });
    if (url.pathname.endsWith("/tasks")) return reply({ tasks: [] });
    return reply({});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  const openClient = async () => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/mcp/server.ts")], cwd: temp,
      env: { PATH: process.env.PATH!, LETAGENTS_API_URL: apiUrl, LETAGENTS_STATE_PATH: statePath,
        LETAGENTS_CHAT_STORAGE_SETTINGS_PATH: storagePath, LETAGENTS_LOCAL_CHAT_DB: join(temp, "chat.sqlite"),
        LETAGENTS_EXECUTION_PROFILE: "autonomous_mcp_worker" }, stderr: "pipe" });
    transport.stderr?.resume();
    const client = new Client({ name: "process-connection-test", version: "1" });
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));

  try {
    const first = await openClient();
    const registered = await call(first.client, "register_agent_session",
      { room_id: "room_shared", display_name: "Juniper", registration_key: "chat-a-random-key" });
    const sessionId: string = registered.agent_session.session_id;

    // The connection is opened for the session just registered, with the
    // session's own credential.
    await until(() => opened.length === 1, "the process connection to open");
    assert.equal(opened[0]!.session_id, sessionId);
    assert.ok(opened[0]!.token, "the connection proves which session it is for");

    // The connection drops. The process is still there, so it reopens it.
    held.get(sessionId)!.destroy();
    await until(() => opened.length === 2, "the process connection to reopen");

    // The room ends the session. The process stops treating it as its own,
    // so registering again asks the room instead of answering from memory.
    const session = [...sessions.values()].find((candidate) => candidate.session_id === sessionId)!;
    session.ended_at = new Date().toISOString();
    held.get(sessionId)!.end("event: ended\ndata: {}\n\n");
    await until(() => state().agent_sessions?.[sessionId]?.ended_at, "the session to be marked ended locally");
    const before = registrations.length;
    session.ended_at = null;
    const again = await call(first.client, "register_agent_session", { worker_id: registered.worker_id, room_id: "room_shared" });
    assert.equal(registrations.length, before + 1, "the room is asked, not the local record");
    assert.equal(again.agent_session.session_id, sessionId);
    await until(() => opened.length === 3, "the connection to open for the renewed session");

    // Each registration names the machine it came from, and the same machine
    // names itself the same way every time.
    const hosts = registrations.map((registration) => registration.process_host_id);
    assert.match(hosts[0], /^phost_[0-9a-f]{32}$/);
    assert.deepEqual(new Set(hosts).size, 1);

    // The host closes the process. It says it is leaving before it goes.
    await first.client.close();
    await until(() => exits.length === 1, "the exit to be announced");
    assert.deepEqual(exits[0], { session_id: sessionId, connection_id: "00000000-0000-4000-8000-000000000003" },
      "it speaks for the connection it held, not for the session");

    // A room server that predates the connection answers 404. That says
    // nothing about the session, so the process keeps it, and asks again
    // only much later, in case the server has been replaced by then.
    processConnection = "unknown";
    const second = await openClient();
    const older = await call(second.client, "register_agent_session",
      { room_id: "room_shared", display_name: "Cedar", registration_key: "chat-b-random-key" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    assert.equal(state().agent_sessions?.[older.agent_session.session_id]?.ended_at ?? null, null);
    assert.equal(opened.length, 3, "a server that does not know the route is not asked again at once");
    // The server is replaced by one that knows it, and the process is asked
    // for again at the next of its long intervals.
    processConnection = "served";
    await until(() => opened.some((connection) => connection.session_id === older.agent_session.session_id),
      "the connection to open once the route is known", 20_000);
    await call(second.client, "register_agent_session", { worker_id: older.worker_id, room_id: "room_shared" });
    await second.client.close();

    // A room that is busy for a moment is asked again, not reported to the
    // agent as a failure. And a room that refuses the connection has said
    // nothing about the session: the process keeps it, and asks again later.
    processConnection = "refused";
    busyRegistrations = 1;
    const third = await openClient();
    const refused = await call(third.client, "register_agent_session",
      { room_id: "room_shared", display_name: "Rowan", registration_key: "chat-c-random-key" });
    const refusedSessionId: string = refused.agent_session.session_id;
    await until(() => refusals >= 2, "a refused connection to be asked for again", 15_000);
    assert.equal(state().agent_sessions?.[refusedSessionId]?.ended_at ?? null, null);

    // The room serves it again, and the process is there to take it up.
    processConnection = "served";
    await until(() => opened.some((connection) => connection.session_id === refusedSessionId),
      "the connection to open once it is served", 20_000);

    // The host stops the process with a signal. It still says it is leaving.
    third.transport.pid && process.kill(third.transport.pid, "SIGTERM");
    await until(() => exits.some((exit) => exit.session_id === refusedSessionId), "the exit to be announced on a signal");
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    for (const response of held.values()) response.destroy();
    server.closeAllConnections?.();
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
