import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const root = await mkdtemp(join(tmpdir(), "letagents-supervised-registration-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
const daemonDir = join(home, ".letagents");
const socketPath = join(daemonDir, "daemon.sock");
await Promise.all([mkdir(daemonDir, { recursive: true }), mkdir(workspace, { recursive: true })]);

process.env.HOME = home;
process.env.LETAGENTS_API_URL = "https://letagents.test";
process.env.LETAGENTS_TOKEN = "owner-token";
process.env.LETAGENTS_AGENT_NAME = "registration-worker";
process.env.LETAGENTS_AGENT_OWNER_LABEL = "Test Owner";
process.env.LETAGENTS_STATE_PATH = join(root, "mcp-state.json");

const { getStoredAgentSession } = await import("../local-state.js");
const { registerAgentSessionTools } = await import("../server/tools/agent-sessions.js");

type ToolHandler = (
  input: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }> }>;

function registrationHandler(): ToolHandler {
  let handler: ToolHandler | null = null;
  registerAgentSessionTools({
    tool(name: string, _description: string, _schema: unknown, callback: unknown) {
      if (name === "register_agent_session") handler = callback as ToolHandler;
    },
  } as unknown as McpServer);
  assert.ok(handler, "register_agent_session should be registered");
  return handler;
}

test.after(async () => {
  delete process.env.HOME;
  delete process.env.LETAGENTS_API_URL;
  delete process.env.LETAGENTS_TOKEN;
  delete process.env.LETAGENTS_AGENT_NAME;
  delete process.env.LETAGENTS_AGENT_OWNER_LABEL;
  delete process.env.LETAGENTS_STATE_PATH;
  await rm(root, { recursive: true, force: true });
});

test("register_agent_session persists its validated supervised cwd for later bridge calls", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  const daemon = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, any>;
      requests.push(request);
      const result = request.method === "daemon.negotiate"
        ? { protocol_version: 2 }
        : { accepted: true };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });

  try {
    await Promise.all([
      writeFile(join(workspace, ".letagents-supervisor-context.json"), JSON.stringify({
        version: 1,
        provider: "codex",
        entry_id: "supervised_exact",
        room_id: "focus_37",
        work_attempt_id: "attempt_exact",
        execution_generation_id: "generation_exact",
      })),
      writeFile(join(workspace, ".letagents-work-attempt.json"), JSON.stringify({
        version: 1,
        work_attempt_id: "attempt_exact",
      })),
      new Promise<void>((resolve, reject) => {
        daemon.once("error", reject);
        daemon.listen(socketPath, resolve);
      }),
    ]);

    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/agents/me") {
        return jsonResponse({
          account: { login: "test-owner", display_name: "Test Owner" },
          agents: [],
        });
      }
      if (path === "/agents" && init?.method === "POST") {
        return jsonResponse({
          canonical_key: "test-owner/registration-worker",
          display_name: "Registration Worker",
          owner_label: "Test Owner",
        });
      }
      if (path === "/rooms/focus_37/agent-sessions" && init?.method === "POST") {
        return jsonResponse({
          session_id: "agent_session_registered",
          session_token: "worker-secret",
          room_id: "focus_37",
          session_kind: "worker",
          runtime: "codex",
          actor_label: "Registration Worker | Test Owner's agent | Agent",
          agent_key: "test-owner/registration-worker",
          agent_instance_id: "instance_exact",
          display_name: "Registration Worker",
          owner_label: "Test Owner",
          ide_label: "Agent",
          created_at: "2026-07-16T00:00:00.000Z",
          updated_at: "2026-07-16T00:00:00.000Z",
          last_seen_at: "2026-07-16T00:00:00.000Z",
        });
      }
      assert.fail(`unexpected API request: ${init?.method ?? "GET"} ${path}`);
    };

    const response = await registrationHandler()({
      room_id: "focus_37",
      session_kind: "worker",
      runtime: "codex",
      display_name: "Registration Worker",
      cwd: workspace,
    });
    const parsed = JSON.parse(response.content[0]?.text ?? "{}") as Record<string, any>;
    assert.equal(parsed.success, true);
    assert.equal(parsed.agent_session_id, "agent_session_registered");
    assert.equal(parsed.agent_session?.supervisor_context_cwd, undefined,
      "the private route must not enter the tool response");

    const stored = getStoredAgentSession("agent_session_registered");
    assert.equal(stored?.supervisor_context_cwd, await realpath(workspace));
    assert.equal(stored?.session_token, "worker-secret");
    assert.doesNotMatch(await readFile(process.env.LETAGENTS_STATE_PATH!, "utf8"), /daemon\.sock/,
      "only the validated cwd route is durable; the daemon socket is canonical");

    const bind = requests.find((request) => request.method === "supervisor.bind_worker_session");
    assert.deepEqual(bind?.params, {
      entry_id: "supervised_exact",
      room_id: "focus_37",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      agent_session_id: "agent_session_registered",
      agent_session_token: "worker-secret",
      api_url: "https://letagents.test",
    });
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
