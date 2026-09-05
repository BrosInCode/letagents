import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Real MCP processes and schemas; the HTTP fixture controls response loss and
// response ordering. The companion DB tests verify server auth and allocation.
test("worker handles isolate chats on shared MCP, survive process loss, and fence delayed replies", { timeout: 30_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "letagents-worker-stdio-"));
  const statePath = join(temp, "state.json");
  const storagePath = join(temp, "storage.json");
  writeFileSync(storagePath, JSON.stringify({ mode: "cloud", roomOverrides: { room_local: "local" } }));
  writeFileSync(statePath, JSON.stringify({ auth: { token: "owner-test-token",
    source: "device_flow", stored_at: new Date().toISOString() } }));
  const sessions = new Map<string, Record<string, any>>();
  const registrations: Record<string, any>[] = [];
  const messages: Record<string, any>[] = [];
  const clients: Client[] = [];
  let dropRegistration = false;
  let directoryFailure: "unavailable" | "offline" | "malformed" | null = null;
  let holdDisconnect = false;
  let releaseDisconnect: (() => void) | undefined;
  let disconnectArrived: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, "http://localhost");
    const reply = (value: unknown, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/agents/me") {
      if (directoryFailure === "unavailable") return reply({ error: "temporarily unavailable" }, 503);
      if (directoryFailure === "offline") { res.destroy(); return; }
      if (directoryFailure === "malformed") return reply({});
      return reply({ account: { id: "owner-id", login: "owner" }, agents: [] });
    }
    if (url.pathname === "/agents") return reply({ canonical_key: `owner/${body.name}`, ...body });
    if (url.pathname.endsWith("/agent-sessions")) {
      registrations.push(body);
      const key = `${url.pathname}:${body.agent_instance_id}`;
      const prior = sessions.get(key);
      if (prior && prior.session_token !== body.connection_token && prior.session_token !== body.replace_agent_session_token) {
        return reply({ error: "predecessor proof rejected" }, 409);
      }
      const now = new Date().toISOString();
      const sameName = [...sessions.values()].filter((s) => s.display_name.startsWith(body.display_name)).length;
      const displayName = prior?.display_name ?? `${body.display_name}${sameName ? ` ${sameName}` : ""}`;
      const session = { session_id: prior?.session_id ?? `session_${sessions.size + 1}`, session_token: body.connection_token,
        agent_key: body.actor_key, agent_instance_id: body.agent_instance_id, session_kind: "worker", room_id: url.pathname.split("/")[2],
        display_name: displayName, actor_label: `${displayName} | Owner | Agent`, owner_label: "Owner", ide_label: "Agent", runtime: body.runtime,
        created_at: prior?.created_at ?? now, updated_at: now, last_seen_at: now, ended_at: null };
      sessions.set(key, session);
      if (dropRegistration) { dropRegistration = false; res.destroy(); return; }
      return reply({ ...session, worker_bearer: "unused-bearer-secret" }, 201);
    }
    if (url.pathname.endsWith("/disconnect")) {
      const session = [...sessions.values()].find((s) => s.session_id === body.agent_session_id);
      if (!session || session.session_token !== body.agent_session_token) return reply({ error: "stale connection" }, 401);
      const ended = { ...session, ended_at: new Date().toISOString() };
      sessions.set([...sessions.keys()].find((key) => sessions.get(key) === session)!, ended);
      if (holdDisconnect) {
        holdDisconnect = false;
        await new Promise<void>((resolveReply) => { releaseDisconnect = resolveReply; disconnectArrived?.(); });
      }
      return reply({ agent_session: ended });
    }
    if (url.pathname.endsWith("/messages") && req.method === "POST") {
      const session = [...sessions.values()].find((s) => s.session_id === body.agent_session_id);
      if (body.text === "force401" || !session || session.ended_at || session.session_token !== body.agent_session_token) {
        return reply({ error: "stale worker credential" }, 401);
      }
      messages.push(body);
      return reply({ id: `msg_${messages.length}`, room_id: session.room_id, text: body.text, sender: body.sender });
    }
    if (url.pathname.endsWith("/messages")) return reply({ messages: [], room_id: "room_shared" });
    if (url.pathname.endsWith("/tasks")) return reply({ tasks: [] });
    return reply({});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const openClient = async () => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/mcp/server.ts")], cwd: temp,
      env: { PATH: process.env.PATH!, LETAGENTS_API_URL: apiUrl, LETAGENTS_STATE_PATH: statePath,
        LETAGENTS_CHAT_STORAGE_SETTINGS_PATH: storagePath, LETAGENTS_LOCAL_CHAT_DB: join(temp, "chat.sqlite"),
        LETAGENTS_EXECUTION_PROFILE: "autonomous_mcp_worker" }, stderr: "pipe" });
    transport.stderr?.resume();
    const client = new Client({ name: "identity-test", version: "1" });
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  };
  const raw = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await raw(client, name, args);
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    const first = await openClient();
    const tools = await first.client.listTools();
    assert.ok((await raw(first.client, "register_agent_session", { registration_key: "missing-room" })).isError);
    assert.ok(tools.tools.find((t) => t.name === "get_board")?.inputSchema.properties?.worker_id);
    assert.equal(tools.tools.find((t) => t.name === "assign_board_manager")?.inputSchema.properties?.worker_id, undefined);
    const create = { room_id: "room_shared", display_name: "Juniper", registration_key: "chat-a-random-key" };
    const [one, duplicate] = await Promise.all([call(first.client, "register_agent_session", create), call(first.client, "register_agent_session", create)]);
    assert.equal(one.worker_id, duplicate.worker_id);
    assert.equal(registrations.length, 1, "same-process concurrent retries converge");
    const two = await call(first.client, "register_agent_session", { ...create, registration_key: "chat-b-random-key" });
    assert.notEqual(one.worker_id, two.worker_id);
    assert.notEqual(one.agent_session.agent_key, two.agent_session.agent_key);
    await Promise.all([one, two].map((w, i) => call(first.client, "send_message", { worker_id: w.worker_id, text: `chat-${i}` })));
    assert.equal(new Set(messages.map((m) => m.agent_session_id)).size, 2);
    assert.doesNotMatch(JSON.stringify(one), /session_token|owner-test-token|unused-bearer-secret/);
    assert.doesNotMatch(readFileSync(statePath, "utf8"), /unused-bearer-secret/);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);

    directoryFailure = "unavailable";
    const second = await openClient();
    const savedWorkers = state().mcp_workers;
    const savedSessions = state().agent_sessions;
    const registrationCount = registrations.length;
    for (const failure of ["unavailable", "offline", "malformed"] as const) {
      directoryFailure = failure;
      for (const args of [
        { worker_id: one.worker_id, room_id: "room_shared" },
        create,
        { ...create, registration_key: "new-chat-during-outage", room_id: "room_local" },
      ]) {
        const failed = await raw(second.client, "register_agent_session", args);
        assert.ok(failed.isError);
        assert.match(JSON.stringify(failed), /Could not verify your LetAgents account/);
        assert.match(JSON.stringify(failed), /same worker_id or registration_key/);
        assert.doesNotMatch(JSON.stringify(failed), /Unknown worker_id/);
      }
      assert.deepEqual(state().mcp_workers, savedWorkers, "account lookup failure cannot create a local identity");
      assert.deepEqual(state().agent_sessions, savedSessions, "account lookup failure cannot rotate a saved session");
      assert.equal(state().auth.token, "owner-test-token");
      assert.equal(registrations.length, registrationCount);
    }
    directoryFailure = null;
    assert.ok((await raw(second.client, "send_message", { worker_id: one.worker_id, text: "before explicit reconnect" })).isError);
    const resumed = await call(second.client, "register_agent_session", { worker_id: one.worker_id, room_id: "room_shared" });
    assert.equal(resumed.agent_session.session_id, one.agent_session.session_id);
    assert.equal(resumed.agent_session.display_name, one.agent_session.display_name);
    assert.ok((await raw(first.client, "send_message", { worker_id: one.worker_id, text: "stale" })).isError);
    assert.ok((await raw(first.client, "send_message", { agent_session_id: one.agent_session.session_id, room_id: "room_shared", text: "stale legacy id" })).isError);
    await call(first.client, "send_message", { worker_id: two.worker_id, text: "other chat still works" });
    assert.ok((await raw(second.client, "send_message", { worker_id: one.worker_id, text: "force401" })).isError);
    assert.equal(state().auth.token, "owner-test-token", "a worker 401 must not log out the shared owner");
    await call(second.client, "get_board", { worker_id: one.worker_id });
    await call(second.client, "read_messages", { worker_id: one.worker_id });
    assert.ok((await raw(second.client, "set_agent_name", { worker_id: one.worker_id, name: "Misleading rename" })).isError);

    // Server ends a connection, but its response arrives after another process
    // resumes it. The old response must not end the replacement in local state.
    holdDisconnect = true;
    const arrived = new Promise<void>((resolveArrived) => { disconnectArrived = resolveArrived; });
    const ending = raw(second.client, "disconnect_agent_session", { worker_id: one.worker_id });
    await arrived;
    const third = await openClient();
    await call(third.client, "register_agent_session", { worker_id: one.worker_id, room_id: "room_shared" });
    releaseDisconnect!();
    assert.ok((await ending).isError, "the delayed old connection cannot return as current");
    assert.equal(state().agent_sessions[one.agent_session.session_id].ended_at, null);
    await call(third.client, "send_message", { worker_id: one.worker_id, text: "successor survives delayed end" });

    // Kill the actual MCP process, then explicitly recover the same chat.
    process.kill(third.transport.pid!, "SIGKILL");
    const fourth = await openClient();
    const afterCrash = await call(fourth.client, "register_agent_session", { worker_id: one.worker_id, room_id: "room_shared" });
    assert.equal(afterCrash.agent_session.display_name, one.agent_session.display_name);
    assert.equal(afterCrash.agent_session.session_id, one.agent_session.session_id);
    dropRegistration = true;
    const lostCreate = { ...create, registration_key: "chat-c-lost-response" };
    assert.ok((await raw(fourth.client, "register_agent_session", lostCreate)).isError);
    const recovered = await call(fourth.client, "register_agent_session", lostCreate);
    assert.equal(sessions.size, 3, "uncertain registration retries never create another identity");
    await call(fourth.client, "send_message", { worker_id: recovered.worker_id, text: "recovered" });
    await call(fourth.client, "register_agent_session", { worker_id: recovered.worker_id, room_id: "room_other" });
    assert.ok((await raw(fourth.client, "send_message", { worker_id: recovered.worker_id, text: "ambiguous room" })).isError);
    assert.ok((await raw(fourth.client, "send_message", { worker_id: `worker_${"0".repeat(32)}`, text: "unknown handle" })).isError);

    const localCreate = { room_id: "room_local", display_name: "Cedar", registration_key: "local-chat-a" };
    const localOne = await call(first.client, "register_agent_session", localCreate);
    const localTwo = await call(first.client, "register_agent_session", { ...localCreate, registration_key: "local-chat-b" });
    assert.notEqual(localOne.agent_session.display_name, localTwo.agent_session.display_name);
    await call(second.client, "register_agent_session", { worker_id: localOne.worker_id, room_id: "room_local" });
    assert.ok((await raw(first.client, "send_message", { room_id: "room_local", agent_session_id: localOne.agent_session.session_id, text: "stale local writer" })).isError);
    assert.ok((await raw(first.client, "disconnect_agent_session", { room_id: "room_local", agent_session_id: localOne.agent_session.session_id })).isError);
    await call(second.client, "send_message", { worker_id: localOne.worker_id, text: "local successor" });
    await call(first.client, "send_message", { worker_id: localTwo.worker_id, text: "local sibling" });
    await call(second.client, "disconnect_agent_session", { worker_id: localOne.worker_id });
    const localResumed = await call(second.client, "register_agent_session", { worker_id: localOne.worker_id, room_id: "room_local" });
    assert.equal(localResumed.agent_session.display_name, localOne.agent_session.display_name);
    assert.equal(localResumed.agent_session.session_id, localOne.agent_session.session_id);

    const baseline = await call(first.client, "send_message", { worker_id: localTwo.worker_id, text: "baseline for waiting poll" });
    const waiting = raw(second.client, "wait_for_messages", { worker_id: localOne.worker_id, after_message_id: baseline.id, timeout: 1500 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await call(first.client, "register_agent_session", { worker_id: localOne.worker_id, room_id: "room_local" });
    await call(first.client, "send_message", { worker_id: localTwo.worker_id, text: "@Cedar new update after replacement" });
    assert.ok((await waiting).isError, "an already waiting predecessor must not deliver successor messages");

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const database = new DatabaseSync(join(temp, "chat.sqlite"));
    try {
      database.exec("BEGIN IMMEDIATE");
      const blockedWrite = raw(first.client, "send_message", { worker_id: localOne.worker_id, text: "stale writer blocked on SQLite" });
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      await call(second.client, "register_agent_session", { worker_id: localOne.worker_id, room_id: "room_local" });
      database.exec("COMMIT");
      assert.ok((await blockedWrite).isError);
      assert.equal(database.prepare("SELECT count(*) AS n FROM local_chat_messages WHERE text = ?").get("stale writer blocked on SQLite").n, 0,
        "a writer waiting for SQLite must recheck its generation before committing");
    } finally {
      database.close();
    }
  } finally {
    releaseDisconnect?.();
    await Promise.allSettled(clients.map((client) => client.close()));
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(temp, { recursive: true, force: true });
  }
});
