import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_API_URL ??= "http://127.0.0.1:39999";

const { registerAgentSessionTools } = await import("../server/tools/agent-sessions.js");
const { getStoredAgentSession } = await import("../local-state.js");

function toolHandler(
  register: (server: McpServer) => void,
  name: string,
): (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> {
  let handler: ((input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | null = null;
  register({ tool(toolName: string, _description: string, _schema: unknown, callback: unknown) {
    if (toolName === name) handler = callback as typeof handler;
  } } as unknown as McpServer);
  assert.ok(handler, `missing ${name} handler`);
  return handler;
}

// End-to-end wire + persistence round-trip for the stable-base signal:
// the register tool must EMIT requested_base_display_name in the hosted
// registration body, PERSIST the server-confirmed assigned base into local
// session state, and REPLAY that base when re-registering with a decorated
// prior label. A pure-resolver unit test cannot catch a broken request body,
// response mapping, or local-state replay — this test exercises all three.
test("register_agent_session emits, persists, and replays the stable base signal", async () => {
  const originalFetch = globalThis.fetch;
  const originalStatePath = process.env.LETAGENTS_STATE_PATH;
  const originalOwner = process.env.LETAGENTS_TOKEN;
  const originalBearer = process.env.LETAGENTS_AGENT_SESSION_BEARER;
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-base-wire-"));
  process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
  process.env.LETAGENTS_TOKEN = "owner-token";
  delete process.env.LETAGENTS_AGENT_SESSION_BEARER;

  const registrationBodies: Array<Record<string, unknown>> = [];
  let sessionCounter = 0;
  try {
    globalThis.fetch = async (url, init) => {
      const requestUrl = String(url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      if (requestUrl.endsWith("/agents/me")) {
        return new Response(JSON.stringify({ account: { login: "owner" }, agents: [] }), { status: 200 });
      }
      if (requestUrl.endsWith("/agents") && init?.method === "POST") {
        return new Response(JSON.stringify({
          canonical_key: "owner/wirefox",
          name: "wirefox",
          display_name: "WireFox",
        }), { status: 200 });
      }
      if (requestUrl.endsWith("/rooms/room_wire/agent-sessions") && init?.method === "POST") {
        registrationBodies.push(body ?? {});
        sessionCounter += 1;
        const requestedBase = typeof body?.requested_base_display_name === "string"
          ? body.requested_base_display_name
          : null;
        const requestedName = typeof body?.display_name === "string" ? body.display_name : "WireFox";
        // First allocation simulates a live collision: the server decorates
        // the label but records the base it allocated from.
        const displayName = sessionCounter === 1 ? `${requestedName} 2` : requestedName;
        return new Response(JSON.stringify({
          session_id: `agent_session_wire_${sessionCounter}`,
          session_token: `token_${sessionCounter}`,
          room_id: "room_wire",
          session_kind: "worker",
          runtime: "test",
          actor_label: `${displayName} | Owner | Agent`,
          agent_key: "owner/wirefox",
          agent_instance_id: typeof body?.agent_instance_id === "string" ? body.agent_instance_id : null,
          display_name: displayName,
          assigned_base_display_name: requestedBase,
          owner_label: "Owner",
          ide_label: "Agent",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          ended_at: null,
        }), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const register = toolHandler(registerAgentSessionTools, "register_agent_session");

    // 1. First registration with an explicit custom name: the wire body must
    //    declare that name as its own base.
    const first = JSON.parse((await register({ room_id: "room_wire", display_name: "MistyMorrow" })).content[0]!.text);
    assert.equal(first.success, true);
    assert.equal(registrationBodies.length, 1);
    assert.equal(registrationBodies[0]!.display_name, "MistyMorrow");
    assert.equal(
      registrationBodies[0]!.requested_base_display_name,
      "MistyMorrow",
      "wire body must carry the declared stable base",
    );

    // 2. The server-confirmed base is persisted into local session state even
    //    though the assigned label was decorated ("MistyMorrow 2").
    const storedFirst = getStoredAgentSession(first.agent_session_id);
    assert.ok(storedFirst, "registered session is stored locally");
    assert.equal(storedFirst!.display_name, "MistyMorrow 2");
    assert.equal(
      storedFirst!.requested_base_display_name,
      "MistyMorrow",
      "local state records the allocation base, not the decorated label",
    );

    // 3. Re-registering while replaying the decorated prior label reuses the
    //    recorded base on the wire, so the server can converge it.
    const second = JSON.parse((await register({ room_id: "room_wire", display_name: "MistyMorrow 2" })).content[0]!.text);
    assert.equal(second.success, true);
    assert.equal(registrationBodies.length, 2);
    assert.equal(registrationBodies[1]!.display_name, "MistyMorrow 2");
    assert.equal(
      registrationBodies[1]!.requested_base_display_name,
      "MistyMorrow",
      "replaying the decorated prior label declares the ORIGINAL base",
    );

    // 4. A deliberate different name (numeric-ending rename) declares itself
    //    as its own base — never reduced to the prior base.
    const third = JSON.parse((await register({ room_id: "room_wire", display_name: "MistyMorrow 47" })).content[0]!.text);
    assert.equal(third.success, true);
    assert.equal(registrationBodies.length, 3);
    assert.equal(
      registrationBodies[2]!.requested_base_display_name,
      "MistyMorrow 47",
      "a deliberate rename is its own base on the wire",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStatePath === undefined) delete process.env.LETAGENTS_STATE_PATH;
    else process.env.LETAGENTS_STATE_PATH = originalStatePath;
    if (originalOwner === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = originalOwner;
    if (originalBearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
    else process.env.LETAGENTS_AGENT_SESSION_BEARER = originalBearer;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
