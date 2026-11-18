import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// read_attachment as the remote endpoint runs it: inside the API process, in a
// session scope whose requests go in process. The scope's dispatch stands in
// for the API; a local server stands in for object storage.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_CHAT_STORAGE = "cloud";
const { registerReadAttachmentTool, READ_ATTACHMENT_LIMITS } = await import("../server/tools/messages/read-attachment-tool.js");
const { runInSessionScope } = await import("../server/runtime/session-scope.js");
type Scope = import("../server/runtime/session-scope.js").McpSessionScope;

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>;
let handler: Handler | null = null;
registerReadAttachmentTool({ tool(_name: string, _description: string, _schema: unknown, callback: Handler) { handler = callback; } } as unknown as McpServer);

// Storage: /ok answers at once, /fail answers 500, /hold waits until released.
const held: ServerResponse[] = [];
const storage = createServer((req, res) => {
  if (req.url === "/hold") { held.push(res); return; }
  if (req.url === "/fail") { res.writeHead(500); res.end(); return; }
  res.writeHead(200, { "Content-Type": "text/plain" }); res.end("hello from storage");
});
storage.listen(0, "127.0.0.1");
await once(storage, "listening");
const STORAGE = `http://127.0.0.1:${(storage.address() as { port: number }).port}`;
test.after(() => { for (const res of held) res.end(); storage.close(); });

const FILES: Record<string, { name: string; size: number; path: string }> = {
  att_1: { name: "small.txt", size: 18, path: "/ok" },
  att_2: { name: "big.log", size: 3 * 1024 * 1024, path: "/ok" },
  att_3: { name: "slow.txt", size: 18, path: "/hold" },
  att_4: { name: "broken.txt", size: 18, path: "/fail" },
};

function scope(accountId: string): Scope {
  return {
    sessionId: `session-${accountId}`, accountId, agentInstanceId: `instance-${accountId}`, clientName: "Grok", implicit: false,
    // The public origin is this machine here, so the local storage server is allowed (production: https://letagents.chat).
    publicBaseUrl: "http://127.0.0.1:1",
    dispatch: async (path: string) => {
      if (path.startsWith("/rooms/room_1/messages/msg_1?") || path === "/rooms/room_1/messages/msg_1") {
        return Response.json({ message: { id: "msg_1", sender: "Emmy", attachments: Object.entries(FILES).map(([id, f]) => ({
          id, filename: f.name, content_type: "text/plain", byte_size: f.size })) } });
      }
      const match = /^\/rooms\/room_1\/messages\/msg_1\/attachments\/(att_\d+)$/.exec(path);
      if (match) return new Response(null, { status: 302, headers: { Location: `${STORAGE}${FILES[match[1]!]!.path}` } });
      return Response.json({ error: "not found" }, { status: 404 });
    },
    state: { local: {}, currentRoom: null, fullPromptDelivered: false, pinnedConnections: {} },
    dirty: false, memory: new Map(), persist: async () => undefined,
  };
}

const read = (accountId: string, attachmentId: string) => runInSessionScope(scope(accountId),
  () => handler!({ room_id: "room_1", message_id: "msg_1", attachment_id: attachmentId }));
const header = (answer: Awaited<ReturnType<Handler>>) => JSON.parse(answer.content[0]!.text!);

test("over the remote endpoint a text file is read only up to 2 MB, since each page downloads it again inside the server", async () => {
  assert.equal(READ_ATTACHMENT_LIMITS.remoteTextBytes, 2 * 1024 * 1024);
  const answer = header(await read("acct_a", "att_2"));
  assert.equal(answer.code, "too_large");
  assert.match(answer.message, /"big.log" is 3\.0 MB, more than the 2\.0 MB/);
  assert.equal(header(await read("acct_a", "att_1")).kind, "text", "a small file is read in process");
});

test("one account reads at most two files at once, and others still get theirs", async () => {
  const first = read("acct_busy", "att_3");
  const second = read("acct_busy", "att_3");
  while (held.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  const third = header(await read("acct_busy", "att_1"));
  assert.deepEqual([third.code, third.message], ["busy", "Too many files are being read at once. Try again in a moment."]);
  assert.equal(header(await read("acct_other", "att_1")).kind, "text", "another account is not held back");
  for (const res of held.splice(0)) { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("released"); }
  assert.deepEqual([header(await first).kind, header(await second).kind], ["text", "text"]);
  assert.equal(header(await read("acct_busy", "att_1")).kind, "text", "the slots come back when the downloads end");
});

test("failed downloads give their slots back", async () => {
  for (let index = 0; index < READ_ATTACHMENT_LIMITS.concurrentDownloads + 2; index++) {
    assert.equal(header(await read("acct_fail", "att_4")).code, "attachment_unavailable");
  }
  assert.equal(header(await read("acct_fail", "att_1")).kind, "text");
});
