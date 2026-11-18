import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The MCP tools made from the LetAgents API contract, as the npm package wires
// them: one tool per method flagged `agents`, calling /api/v1 in the agent's room.
const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "letagents-api-tools-")));
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_API_URL = "http://127.0.0.1:39997";
process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
process.env.LETAGENTS_CHAT_STORAGE = "cloud";
process.env.LETAGENTS_TOKEN = "owner-token";
delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
delete process.env.LETAGENTS_EXECUTION_PROFILE;

const originalFetch = globalThis.fetch;
const { registerApiTools, apiMethodRequest } = await import("../server/tools/api-tools.js");
const { registerPageTools, readPageFile, PUBLISH_PAGE_DESCRIPTION } = await import("../server/tools/page-tools.js");
const { pinAttachmentWorkingFolder } = await import("../server/runtime/message-attachments.js");
const { REMOTE_ALLOWED_TOOLS, REMOTE_STRIPPED_INPUT_FIELDS, isRemoteExcludedTool } = await import("../server/remote-tool-surface.js");
const { SUPERVISED_READ_ONLY_TOOLS } = await import("../../../shared/supervised-read-tools.mjs");
const { CODEX_READ_ONLY_ROOM_TOOLS } = await import("../../../shared/codex-read-only-room-tools.mjs");
const { API_AGENT_TOOLS, API_AGENT_READ_TOOLS } = await import("../../../shared/api-agent-tools.mjs");
const { agentToolMethods, agentToolName, HAND_WRITTEN_AGENT_TOOLS } = await import("../../../shared/api/agent-tools.mjs");
const { getApiMethod } = await import("../../../shared/api/index.mjs");
const { toJsonSchema } = await import("../../../shared/api/core.mjs");
const { pageReference } = await import("../../../shared/api/page-reference.mjs");

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

type Registered = { description: string; schema: Record<string, unknown>; handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };

function registered(register: (server: McpServer) => void): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  register({ tool(name: string, description: string, schema: Record<string, unknown>, handler: Registered["handler"]) {
    tools.set(name, { description, schema, handler });
  } } as unknown as McpServer);
  return tools;
}

type Request = { method: string; path: string; search: string; body: unknown; authorization: string | null };

function fakeApi(answer: (request: Request) => { status: number; body: unknown }): Request[] {
  const requests: Request[] = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const request = {
      method: init?.method ?? "GET",
      path: parsed.pathname,
      search: parsed.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get("Authorization"),
    };
    requests.push(request);
    const { status, body } = answer(request);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return requests;
}

async function connected(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "api-tools-test", version: "1" });
  register(server);
  const client = new Client({ name: "api-tools-reader", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

test("every method flagged for agents is one generated tool, named after it, with the contract's input and the room", () => {
  const tools = registered((server) => registerApiTools(server));
  const methods = agentToolMethods();
  assert.ok(methods.length >= 14, "the merged reads are flagged");
  assert.deepEqual([...tools.keys()], methods.map(agentToolName));
  assert.deepEqual([...tools.keys()], API_AGENT_TOOLS.map((tool) => tool.name), "the generated list is current");
  for (const method of methods) {
    const tool = tools.get(agentToolName(method))!;
    const fields = Object.keys((method.input as unknown as { shape: Record<string, unknown> }).shape);
    assert.deepEqual(Object.keys(tool.schema), [...fields, "room_id"], method.name);
    assert.equal(Object.hasOwn(tool.schema, "room"), false, `${method.name} takes its room from the agent`);
    assert.ok(tool.description.startsWith(method.description), method.name);
    assert.match(tool.description, new RegExp(`LetAgents API method ${method.name.replace(".", "\\.")}`));
    for (const code of method.errors.filter((error) => error !== "not_found")) assert.match(tool.description, new RegExp(code), method.name);
  }
  assert.equal(agentToolName({ name: "git.pullRequests" }), "api_git_pull_requests");
  assert.equal(agentToolName({ name: "work_items.history" }), "api_work_items_history");
});

test("a method with a hand-written tool gets no generated one", () => {
  const names = new Set(registered((server) => registerApiTools(server)).keys());
  for (const [method, tool] of Object.entries(HAND_WRITTEN_AGENT_TOOLS)) {
    assert.equal(names.has(agentToolName({ name: method })), false, `${method} is ${tool}`);
  }
  assert.equal(getApiMethod("jobs.get")?.agents, "read", "agents may read a job; get_job is its tool");
});

test("the advertised JSON Schema is the contract's input schema, plus room_id", async () => {
  const client = await connected((server) => registerApiTools(server));
  const { tools } = await client.listTools();
  for (const method of agentToolMethods()) {
    const listed = tools.find((tool) => tool.name === agentToolName(method));
    assert.ok(listed, method.name);
    const { room_id: room, ...properties } = listed.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual(room, { type: "string", description: "Exact room ID. Defaults to this worker’s room." });
    const contract = toJsonSchema(method).input as { properties: Record<string, unknown>; required?: string[] };
    assert.deepEqual(properties, contract.properties, method.name);
    assert.deepEqual(listed.inputSchema.required ?? [], contract.required ?? [], method.name);
  }
});

test("a generated read calls /api/v1 in the agent's room with the agent's credential and answers compact JSON", async () => {
  const page = { tasks: [{ id: "task_7", title: "Ship" }], nextAfter: null };
  const requests = fakeApi(() => ({ status: 200, body: page }));
  const client = await connected((server) => registerApiTools(server));

  const result = await client.callTool({ name: "api_tasks_list", arguments: { room_id: "github.com/acme/app", status: "done", limit: "20" } });
  assert.equal((result.content as Array<{ text: string }>)[0]!.text, JSON.stringify(page));
  assert.deepEqual(requests.at(-1), {
    method: "GET", path: "/api/v1/rooms/github.com%2Facme%2Fapp/tasks", search: "?status=done&limit=20",
    body: undefined, authorization: "Bearer owner-token",
  });

  await callTool(client, "api_tasks_get", { room_id: "design-lounge", taskId: "task_7" });
  assert.equal(requests.at(-1)!.path, "/api/v1/rooms/design-lounge/tasks/task_7");

  await callTool(client, "api_work_items_search", { room_id: "design-lounge", query: "status = Done", fields: ["customfield_1", "customfield_2"] });
  assert.equal(requests.at(-1)!.search, "?query=status+%3D+Done&limit=50&fields=customfield_1&fields=customfield_2",
    "arrays go as repeated fields, the way the server reads a query");
});

test("a generated write sends its path fields in the path and the rest as the JSON body", async () => {
  const doc = { collection: "notes", docId: "n1", data: { text: "hi" }, revision: 1 };
  const requests = fakeApi(() => ({ status: 200, body: doc }));
  const client = await connected((server) => registerApiTools(server));
  assert.deepEqual(await callTool(client, "api_data_set", {
    room_id: "design-lounge", scope: "room", collection: "notes", docId: "n1", data: { text: "hi" },
  }), doc);
  assert.deepEqual(requests.at(-1), {
    method: "PUT", path: "/api/v1/rooms/design-lounge/data/room/notes/n1", search: "",
    body: { data: { text: "hi" } }, authorization: "Bearer owner-token",
  });
  const del = apiMethodRequest(getApiMethod("data.delete")!, { scope: "room", collection: "notes", docId: "n1", ifRevision: 3 });
  assert.deepEqual(del, { path: "/data/room/notes/n1?ifRevision=3", init: { method: "DELETE" } });
  assert.throws(() => apiMethodRequest(getApiMethod("tasks.get")!, { taskId: "../people" }), /without slashes/);
});

test("a refusal keeps the API's code and message; other answers get a code from their status", async () => {
  const client = await connected((server) => registerApiTools(server));
  fakeApi(() => ({ status: 409, body: { code: "conflict", message: "The document changed since revision 2." } }));
  assert.deepEqual(await callTool(client, "api_data_update", { room_id: "r", scope: "room", collection: "notes", docId: "n1", data: {}, ifRevision: 2 }),
    { success: false, error: "conflict", message: "The document changed since revision 2." });
  fakeApi(() => ({ status: 429, body: { code: "rate_limited", message: "Too many calls. Wait and try again.", retryAfterMs: 4000 } }));
  assert.deepEqual(await callTool(client, "api_rooms_get", { room_id: "r" }),
    { success: false, error: "rate_limited", message: "Too many calls. Wait and try again.", retryAfterMs: 4000 });
  fakeApi(() => ({ status: 403, body: { error: "This credential may not use this route." } }));
  assert.deepEqual(await callTool(client, "api_data_delete", { room_id: "r", scope: "room", collection: "notes", docId: "n1" }),
    { success: false, error: "not_granted", message: "This credential may not use this route." });
});

test("generated reads are read-only for every agent kind; writes are journaled; all reach remote agents", () => {
  const reads = API_AGENT_TOOLS.filter((tool) => tool.access === "read").map((tool) => tool.name);
  const writes = API_AGENT_TOOLS.filter((tool) => tool.access === "write").map((tool) => tool.name);
  assert.deepEqual([...API_AGENT_READ_TOOLS], reads);
  assert.ok(writes.includes("api_data_set"));
  for (const name of reads) {
    assert.ok(SUPERVISED_READ_ONLY_TOOLS.has(name), `${name} skips the effect journal`);
    assert.ok(CODEX_READ_ONLY_ROOM_TOOLS.has(name), `a Read-only Codex agent may use ${name}`);
  }
  for (const name of writes) {
    assert.equal(SUPERVISED_READ_ONLY_TOOLS.has(name), false, `${name} goes through the effect journal`);
    assert.equal(CODEX_READ_ONLY_ROOM_TOOLS.has(name), false, `a Read-only Codex agent may not use ${name}`);
  }
  for (const name of [...reads, ...writes, "list_pages", "read_page", "read_page_diagnostics"]) {
    assert.ok(REMOTE_ALLOWED_TOOLS.includes(name), `${name} reaches remote agents`);
  }
  for (const method of agentToolMethods()) {
    const fields = Object.keys((method.input as unknown as { shape: Record<string, unknown> }).shape);
    assert.deepEqual(fields.filter((field) => REMOTE_STRIPPED_INPUT_FIELDS.includes(field)), [], `${method.name} keeps its input remotely`);
  }
  for (const name of ["list_pages", "read_page", "read_page_diagnostics"]) {
    assert.ok(SUPERVISED_READ_ONLY_TOOLS.has(name) && CODEX_READ_ONLY_ROOM_TOOLS.has(name), name);
  }
  assert.ok(isRemoteExcludedTool("publish_page"), "publish_page reads a local file");
  assert.equal(SUPERVISED_READ_ONLY_TOOLS.has("publish_page"), false);
});

test("the page tools: publish_page only where files can be read, and its description is the page reference", () => {
  const local = registered((server) => registerPageTools(server, { publish: true }));
  assert.deepEqual([...local.keys()], ["list_pages", "read_page", "read_page_diagnostics", "publish_page"]);
  assert.deepEqual(Object.keys(local.get("publish_page")!.schema), ["path", "page_id", "draft", "room_id"]);
  assert.ok(local.get("publish_page")!.description.endsWith(pageReference()));
  assert.equal(PUBLISH_PAGE_DESCRIPTION.endsWith(pageReference()), true);
  const supervised = registered((server) => registerPageTools(server, { publish: false }));
  assert.deepEqual([...supervised.keys()], ["list_pages", "read_page", "read_page_diagnostics"]);
});

test("page tools call the pages methods, or say the server has no pages yet", async () => {
  const requests = fakeApi(() => ({ status: 200, body: { pages: [] } }));
  const tools = registered((server) => registerPageTools(server, { publish: true }));
  const result = JSON.parse((await tools.get("list_pages")!.handler({ room_id: "design-lounge", surface: "room.tab" })).content[0]!.text);
  if (getApiMethod("pages.list")) {
    assert.deepEqual(result, { pages: [] });
    assert.deepEqual({ path: requests.at(-1)!.path, search: requests.at(-1)!.search }, { path: "/api/v1/rooms/design-lounge/pages", search: "?surface=room.tab" });
  } else {
    assert.deepEqual(result, { success: false, error: "This LetAgents version has no room pages yet (no pages.list in its API)." });
    assert.equal(requests.length, 0);
  }
});

/** Run `check` with the server pinned to `folder` as it starts. */
async function startedIn(folder: string, check: () => Promise<void>): Promise<void> {
  const prior = process.cwd();
  try {
    process.chdir(folder);
    pinAttachmentWorkingFolder();
    await check();
  } finally {
    process.chdir(prior);
  }
}

test("publish_page reads the page with the attachment file guard: in the workspace, HTML, UTF-8, at most 2 MB", async () => {
  const project = join(tempDir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, "desk.html"), "<!doctype html><title>Desk</title>");
  writeFileSync(join(project, "notes.txt"), "not a page");
  writeFileSync(join(project, "big.html"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  writeFileSync(join(project, "latin1.html"), Buffer.from([0x3c, 0x70, 0x3e, 0xe9]));
  writeFileSync(join(project, ".env"), "SECRET=1");
  writeFileSync(join(tempDir, "outside.html"), "<p>outside</p>");
  await startedIn(project, async () => {
    assert.equal(await readPageFile("desk.html"), "<!doctype html><title>Desk</title>");
    await assert.rejects(readPageFile("notes.txt"), /not an \.html file\. Nothing was published\./);
    await assert.rejects(readPageFile("big.html"), /larger than 2 MB/);
    await assert.rejects(readPageFile("latin1.html"), /not UTF-8/);
    await assert.rejects(readPageFile(".env"), /may hold credentials/);
    await assert.rejects(readPageFile("../outside.html"), /outside|workspace/);
  });
  const prior = process.env.LETAGENTS_EXECUTION_PROFILE;
  try {
    process.env.LETAGENTS_EXECUTION_PROFILE = "supervised_room_turn";
    await assert.rejects(readPageFile("desk.html"), /Desktop room agents cannot publish a page from a file yet/);
  } finally {
    if (prior === undefined) delete process.env.LETAGENTS_EXECUTION_PROFILE;
    else process.env.LETAGENTS_EXECUTION_PROFILE = prior;
  }
});
