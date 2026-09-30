import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { AGENT_SESSION_ENDED_ADVICE } from "../../shared/request-headers.js";

// A real MCP process against a room that answers as the hosted one does.
async function harness() {
  const temp = mkdtempSync(join(tmpdir(), "letagents-name-recovery-"));
  const statePath = join(temp, "state.json");
  const storagePath = join(temp, "storage.json");
  writeFileSync(storagePath, JSON.stringify({ mode: "cloud", roomOverrides: {} }));
  writeFileSync(statePath, JSON.stringify({ auth: { token: "owner-test-token",
    source: "device_flow", stored_at: new Date().toISOString() } }));

  const sessions = new Map<string, Record<string, any>>();
  const registrations: Record<string, any>[] = [];
  const ended = new Set<string>();
  // Whether the room gives a held name twice, as it never does; a fake that
  // does lets one process hold two workers under one name.
  const namesUnique = { value: true };
  // What the room answers a request made for an ended session with.
  const refusal = { status: 401, error: AGENT_SESSION_ENDED_ADVICE };
  // Leases the room says the next registration has taken up.
  const adoptedNext: Array<Record<string, string>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, "http://localhost");
    const reply = (value: unknown, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/agents/me") return reply({ account: { id: "owner-id", login: "owner" }, agents: [] });
    if (url.pathname === "/agents") return reply({ canonical_key: `owner/${body.name}`, ...body });
    if (url.pathname.endsWith("/agent-sessions")) {
      registrations.push(body);
      const prior = sessions.get(body.agent_instance_id);
      const now = new Date().toISOString();
      // As the room does: a name another worker lives under is not given twice.
      const taken = namesUnique.value && [...sessions.values()].some((other) => other.agent_instance_id !== body.agent_instance_id
        && !ended.has(other.session_id) && other.display_name.toLowerCase() === String(body.display_name).toLowerCase());
      const displayName = prior?.display_name ?? (taken ? `Substitute${sessions.size + 1}` : body.display_name);
      const session = { session_id: prior?.session_id ?? `session_${sessions.size + 1}`, session_token: body.connection_token,
        agent_key: body.actor_key, agent_instance_id: body.agent_instance_id, session_kind: "worker", room_id: url.pathname.split("/")[2],
        display_name: displayName, actor_label: `${displayName} | Owner | Agent`, owner_label: "Owner", ide_label: "Agent",
        runtime: body.runtime, created_at: prior?.created_at ?? now, updated_at: now, last_seen_at: now, ended_at: null };
      sessions.set(body.agent_instance_id, session);
      ended.delete(session.session_id);
      const adopted = adoptedNext.splice(0);
      return reply(adopted.length > 0 ? { ...session, adopted_task_leases: adopted } : session, 201);
    }
    if (/\/agent-sessions\/[^/]+\/process/.test(url.pathname)) return reply({ error: "Not found" }, 404);
    if (url.pathname.endsWith("/messages") && req.method === "POST") {
      if (ended.has(body.agent_session_id)) return reply({ error: refusal.error }, refusal.status);
      return reply({ id: "msg_1", sender: body.sender, text: body.text, timestamp: new Date().toISOString() }, 201);
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
    const client = new Client({ name: "worker-name-recovery-test", version: "1" });
    clients.push(client);
    await client.connect(transport);
    return client;
  };
  const attempt = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    return { failed: Boolean(result.isError), text };
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await attempt(client, name, args);
    assert.equal(result.failed, false, result.text);
    return JSON.parse(result.text);
  };
  const close = async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    server.closeAllConnections?.();
    server.close();
    rmSync(temp, { recursive: true, force: true });
  };
  return { openClient, attempt, call, close, registrations, ended, refusal, adoptedNext, namesUnique,
    state: () => JSON.parse(readFileSync(statePath, "utf8")) };
}

test("a chat that lost its worker_id has it back by saying so, and is handed nobody else's", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const client = await h.openClient();
    const first = await h.call(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Juniper", registration_key: "chat-a-first-key" });
    assert.equal(first.name_notice, undefined);

    // A chat registers as new under a name this process holds. It may be a
    // chat of its own, so it is registered as any chat would be. It is told
    // that the name is held here, and is not handed the worker that holds it.
    const lost = await h.call(client, "register_agent_session",
      { room_id: "room_shared", display_name: "juniper", registration_key: "chat-a-second-key" });
    assert.notEqual(lost.worker_id, first.worker_id);
    assert.match(lost.name_notice, /recover_lost_worker/);
    assert.equal(JSON.stringify(lost).includes(first.worker_id), false, "a handle is not given for the asking of a name");

    // It says that it is that worker and lost its handle, and has it back.
    const before = h.registrations.length;
    const recovered = await h.call(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Juniper", recover_lost_worker: true });
    assert.equal(recovered.worker_id, first.worker_id);
    assert.equal(recovered.agent_session.session_id, first.agent_session.session_id);
    assert.equal(recovered.agent_session.display_name, "Juniper");
    assert.equal(h.registrations.length, before, "it is the worker this process holds; the room is not asked");
    await h.call(client, "send_message", { worker_id: recovered.worker_id, room_id: "room_shared", text: "back" });

    // Nothing is recovered that is not there to recover, or that is not
    // plainly the one worker meant.
    const none = await h.attempt(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Nobody", recover_lost_worker: true });
    assert.equal(none.failed, true);
    assert.match(none.text, /no worker named/);
    const withKey = await h.attempt(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Juniper", recover_lost_worker: true, registration_key: "chat-e-key" });
    assert.equal(withKey.failed, true);
    const unnamed = await h.attempt(client, "register_agent_session", { room_id: "room_shared", recover_lost_worker: true });
    assert.equal(unnamed.failed, true);
    // The worker that asked for "Juniper" and was given another name is
    // recovered by the name it was given, which is the name it knows.
    assert.notEqual(lost.agent_session.display_name.toLowerCase(), "juniper");
    const substitute = await h.call(client, "register_agent_session",
      { room_id: "room_shared", display_name: lost.agent_session.display_name, recover_lost_worker: true });
    assert.equal(substitute.worker_id, lost.worker_id);
    // Were two workers here living under one name, neither would be chosen.
    h.namesUnique.value = false;
    const twin = await h.call(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Juniper", registration_key: "chat-twin-key" });
    assert.equal(twin.agent_session.display_name, "Juniper");
    const both = await h.attempt(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Juniper", recover_lost_worker: true });
    assert.equal(both.failed, true, both.text);
    assert.match(both.text, /more than one/);
    assert.equal(both.text.includes(first.worker_id), false);
    await h.call(client, "disconnect_agent_session", { worker_id: twin.worker_id, room_id: "room_shared" });
    h.namesUnique.value = true;

    // Another chat under a name of its own, and one that gives no name, are
    // told nothing: there is nothing to tell them.
    const other = await h.call(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Cedar", registration_key: "chat-b-key" });
    assert.equal(other.name_notice, undefined);
    const nameless = await h.call(client, "register_agent_session",
      { room_id: "room_shared", registration_key: "chat-c-key" });
    assert.equal(nameless.name_notice, undefined);
    // Nor is the same chat, registering with the key it registered under.
    const again = await h.call(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Juniper", registration_key: "chat-a-first-key" });
    assert.equal(again.worker_id, first.worker_id);
    assert.equal(again.name_notice, undefined);

    // A process that does not hold the worker has nothing to recover and
    // nothing to tell: the name is the room's to decide.
    const elsewhere = await h.openClient();
    const fresh = await h.call(elsewhere, "register_agent_session",
      { room_id: "room_shared", display_name: "Juniper", registration_key: "chat-d-key" });
    assert.equal(fresh.name_notice, undefined);
    const notHere = await h.attempt(elsewhere, "register_agent_session",
      { room_id: "room_shared", display_name: "Cedar", recover_lost_worker: true });
    assert.equal(notHere.failed, true);
    // A worker that was disconnected is no longer held, and is not recovered.
    await h.call(client, "disconnect_agent_session", { worker_id: other.worker_id, room_id: "room_shared" });
    const gone = await h.attempt(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Cedar", recover_lost_worker: true });
    assert.equal(gone.failed, true);
  } finally {
    await h.close();
  }
});

test("a worker told its session has ended starts another instead of answering from the old one", { timeout: 60_000 }, async () => {
  const h = await harness();
  try {
    const client = await h.openClient();
    const worker = await h.call(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Juniper", registration_key: "chat-a-first-key" });
    const sessionId: string = worker.agent_session.session_id;
    await h.call(client, "send_message", { worker_id: worker.worker_id, room_id: "room_shared", text: "hello" });

    // The room ended the session: its name passed on while it was quiet.
    h.ended.add(sessionId);
    const refused = await h.attempt(client, "send_message", { worker_id: worker.worker_id, room_id: "room_shared", text: "still here" });
    assert.equal(refused.failed, true);
    assert.match(refused.text, /register_agent_session/);
    assert.ok(h.state().agent_sessions[sessionId].ended_at, "the session is recorded as ended");

    // The room says what the session takes up again, and the agent is told.
    h.adoptedNext.push({ lease_id: "tl_1", task_id: "task_7", kind: "work" });
    const before = h.registrations.length;
    const again = await h.call(client, "register_agent_session", { worker_id: worker.worker_id, room_id: "room_shared" });
    assert.equal(h.registrations.length, before + 1, "the room is asked, not the local record");
    assert.equal(again.worker_id, worker.worker_id);
    assert.match(again.resumed_work, /task_7 \(work\)/);
    assert.equal(JSON.stringify(h.state()).includes("adopted_task_leases"), false, "it is said, not stored");
    await h.call(client, "send_message", { worker_id: worker.worker_id, room_id: "room_shared", text: "back" });

    // Only that answer ends a session here. The same words on another
    // refusal, or another refusal in other words, leave it as it is.
    const kept = await h.call(client, "register_agent_session",
      { room_id: "room_shared", display_name: "Rowan", registration_key: "chat-b-key" });
    h.ended.add(kept.agent_session.session_id);
    for (const answer of [{ status: 403, error: AGENT_SESSION_ENDED_ADVICE }, { status: 401, error: "Invalid agent session credentials." }]) {
      Object.assign(h.refusal, answer);
      const denied = await h.attempt(client, "send_message", { worker_id: kept.worker_id, room_id: "room_shared", text: "hello" });
      assert.equal(denied.failed, true);
      assert.equal(h.state().agent_sessions[kept.agent_session.session_id].ended_at ?? null, null);
    }
  } finally {
    await h.close();
  }
});
