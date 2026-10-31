import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { childProcessEnv, connectOrExplain } from "./support/platform.js";

// A real npm MCP server process attaches workspace files: it reads them, stages
// each one with the room's upload route and the presigned PUT, and posts the
// message with the upload ids, all with the one credential it posts with.
test("npm MCP agents attach workspace files to send_message and send_thread_message", { timeout: 60_000 }, async () => {
  // The native form: on Windows the temp folder may be a short name (RUNNER~1).
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "letagents-attach-stdio-")));
  const workspace = join(temp, "workspace");
  mkdirSync(join(workspace, "shots"), { recursive: true });
  const chart = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  writeFileSync(join(workspace, "shots", "chart.png"), chart);
  writeFileSync(join(workspace, "notes.md"), "# notes");
  writeFileSync(join(workspace, "second.txt"), "second");
  writeFileSync(join(workspace, ".env"), "TOKEN=secret");
  writeFileSync(join(temp, "storage.json"), JSON.stringify({ mode: "cloud", roomOverrides: { room_local: "local" } }));
  const statePath = join(temp, "state.json");
  writeFileSync(statePath, JSON.stringify({ auth: { token: "owner-test-token", source: "device_flow", stored_at: new Date().toISOString() } }));

  const slots: Array<{ upload_id: string; filename: string; content_type: string; byte_size: number; authorization?: string }> = [];
  const stored = new Map<string, Buffer>();
  const discarded: string[] = [];
  const messages: Array<Record<string, any> & { authorization?: string }> = [];
  let failPutFor: string | null = null;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://localhost");
    const reply = (value: unknown, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/storage/") && req.method === "PUT") {
      const uploadId = url.pathname.split("/")[2]!;
      if (slots.find((slot) => slot.upload_id === uploadId)?.filename === failPutFor) return reply({ error: "storage down" }, 500);
      stored.set(uploadId, raw);
      res.writeHead(200); res.end(); return;
    }
    const body = raw.length ? JSON.parse(raw.toString()) : {};
    if (url.pathname === "/agents/me") return reply({ account: { id: "owner-id", login: "owner" }, agents: [] });
    if (url.pathname === "/agents") return reply({ canonical_key: `owner/${body.name}`, ...body });
    if (url.pathname === "/rooms/room_shared/agent-sessions") {
      const now = new Date().toISOString();
      return reply({ session_id: "session_1", session_token: body.connection_token, agent_key: body.actor_key,
        agent_instance_id: body.agent_instance_id, session_kind: "worker", room_id: "room_shared", display_name: "Juniper",
        actor_label: "Juniper | Owner | Agent", owner_label: "Owner", ide_label: "Agent", runtime: body.runtime,
        created_at: now, updated_at: now, last_seen_at: now, ended_at: null, worker_bearer: "unused-bearer-secret" }, 201);
    }
    if (url.pathname === "/rooms/room_shared/attachments/uploads" && req.method === "POST") {
      const uploadId = `upl_${String(slots.length + 1).padStart(20, "0")}`;
      slots.push({ upload_id: uploadId, ...body, authorization: req.headers.authorization });
      return reply({ upload_id: uploadId, upload_url: `${apiUrl}/storage/${uploadId}`, method: "PUT", headers: {} }, 201);
    }
    if (url.pathname.startsWith("/rooms/room_shared/attachments/uploads/") && req.method === "DELETE") {
      discarded.push(decodeURIComponent(url.pathname.split("/").at(-1)!));
      return reply({ ok: true });
    }
    if (url.pathname === "/rooms/room_shared/messages/msg_1") return reply({ message: { id: "msg_1", thread_root_id: "msg_1" } });
    if (url.pathname === "/rooms/room_shared/messages" && req.method === "POST") {
      if (body.text === "force500") return reply({ error: "room unavailable" }, 500);
      messages.push({ ...body, authorization: req.headers.authorization });
      return reply({ id: `msg_${messages.length}`, room_id: "room_shared", text: body.text, attachments: body.attachments ?? [] });
    }
    return reply({});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  const openClient = async (extraEnv: Record<string, string> = {}) => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, resolve("src/mcp/server.ts")], cwd: workspace,
      env: childProcessEnv({ LETAGENTS_API_URL: apiUrl, LETAGENTS_STATE_PATH: statePath,
        LETAGENTS_CHAT_STORAGE_SETTINGS_PATH: join(temp, "storage.json"), LETAGENTS_LOCAL_CHAT_DB: join(temp, "chat.sqlite"),
        LETAGENTS_EXECUTION_PROFILE: "autonomous_mcp_worker", ...extraEnv }), stderr: "pipe" });
    const client = new Client({ name: "attachments-test", version: "1" });
    clients.push(client);
    await connectOrExplain(client, transport);
    return client;
  };
  const raw = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const text = (result: Awaited<ReturnType<typeof raw>>) => (result.content as Array<{ text: string }>)[0]!.text;
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await raw(client, name, args);
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(text(result));
  };
  try {
    const client = await openClient();
    const { tools } = await client.listTools();
    for (const name of ["send_message", "send_thread_message"]) {
      assert.ok(tools.find((tool) => tool.name === name)?.inputSchema.properties?.attachments, `${name} offers attachments`);
    }
    const worker = await call(client, "register_agent_session", { room_id: "room_shared", display_name: "Juniper", registration_key: "attachments-random-key" });

    const sent = await call(client, "send_message", { worker_id: worker.worker_id, text: "The chart and my notes",
      attachments: [join("shots", "chart.png"), join(workspace, "notes.md")] });
    assert.equal(sent.id, "msg_1");
    assert.deepEqual(slots.map(({ filename, content_type, byte_size }) => ({ filename, content_type, byte_size })), [
      { filename: "chart.png", content_type: "image/png", byte_size: chart.length },
      { filename: "notes.md", content_type: "text/markdown", byte_size: 7 },
    ]);
    assert.deepEqual(stored.get(slots[0]!.upload_id), chart);
    assert.equal(stored.get(slots[1]!.upload_id)?.toString(), "# notes");
    assert.deepEqual(messages[0]!.attachments, slots.map((slot) => ({ upload_id: slot.upload_id })));
    // The room lets only the uploader attach an upload: one credential stages and posts.
    assert.equal(messages[0]!.authorization, "Bearer owner-test-token");
    assert.ok(slots.every((slot) => slot.authorization === messages[0]!.authorization));
    assert.doesNotMatch(JSON.stringify(messages[0]), new RegExp(workspace.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")), "no local path reaches the room");

    // A thread reply may carry only files.
    await call(client, "send_thread_message", { worker_id: worker.worker_id, thread_parent_id: "msg_1", text: "", attachments: ["notes.md"] });
    assert.equal(messages[1]!.thread_root_id, "msg_1");
    assert.equal(messages[1]!.text, "");
    assert.deepEqual(messages[1]!.attachments, [{ upload_id: slots[2]!.upload_id }]);

    // A refused file stages nothing and posts nothing.
    const before = { slots: slots.length, messages: messages.length };
    const refused = await raw(client, "send_message", { worker_id: worker.worker_id, text: "with secrets", attachments: ["notes.md", ".env"] });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /may hold credentials.*Nothing was posted/);
    for (const [files, pattern] of [
      [[join("..", "state.json")], /outside your workspace/],
      [["missing.png"], /does not exist/],
      [["notes.md", "notes.md", "notes.md", "notes.md", "notes.md"], /4|too_big|array/i],
    ] as const) {
      const result = await raw(client, "send_message", { worker_id: worker.worker_id, text: "refused", attachments: files });
      assert.equal(result.isError, true, JSON.stringify(files));
      assert.match(text(result), pattern);
    }
    assert.deepEqual({ slots: slots.length, messages: messages.length }, before);

    // A failed upload discards the files already staged, and posts nothing.
    failPutFor = "second.txt";
    const failedPut = await raw(client, "send_message", { worker_id: worker.worker_id, text: "upload fails", attachments: ["notes.md", "second.txt"] });
    assert.equal(failedPut.isError, true);
    assert.match(text(failedPut), /second\.txt could not be uploaded.*Nothing was posted/);
    assert.deepEqual([...discarded].sort(), slots.slice(-2).map((slot) => slot.upload_id), "the failed upload and the one before it");
    assert.equal(messages.length, before.messages);
    failPutFor = null;

    // A failed post discards its uploads too.
    const failedPost = await raw(client, "send_message", { worker_id: worker.worker_id, text: "force500", attachments: ["notes.md"] });
    assert.equal(failedPost.isError, true);
    assert.deepEqual(discarded.slice(2), [slots.at(-1)!.upload_id]);
    assert.equal(messages.length, before.messages);

    // A local room has no upload route.
    const local = await raw(client, "send_message", { room_id: "room_local", text: "local", attachments: ["notes.md"] });
    assert.equal(local.isError, true);
    assert.match(text(local), /Local rooms cannot take attachments/);
    assert.deepEqual({ slots: slots.length, messages: messages.length }, { slots: before.slots + 3, messages: before.messages });

    // A server started in the home folder (or around it) is not in a project.
    const homeClient = await openClient({ HOME: workspace, USERPROFILE: workspace });
    const homeWorker = await call(homeClient, "register_agent_session", { room_id: "room_shared", display_name: "Juniper", registration_key: "attachments-home-key" });
    const fromHome = await raw(homeClient, "send_message", { worker_id: homeWorker.worker_id, text: "from home", attachments: ["notes.md"] });
    assert.equal(fromHome.isError, true);
    assert.match(text(fromHome), /Attachments need a project folder/);
    assert.equal(messages.length, before.messages);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(temp, { recursive: true, force: true });
  }
});
