import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  getWorkerBearerRuntime,
  requireValidWorkerBearerRuntime,
  WorkerBearerRuntimeConfigurationError,
} = await import("../server/runtime/worker-bearer.js");
const { ApiError, apiCall, setOwnerAuthStoreLoaderForTest } = await import("../server/runtime/api.js");
const { agentSessionCredentials } = await import("../server/runtime/agent-sessions.js");
const { registerAgentSessionTools } = await import("../server/tools/agent-sessions.js");
const { registerSendMessageTool } = await import("../server/tools/messages/send-tool.js");
const { registerWaitForMessagesTool } = await import("../server/tools/messages/wait-tool.js");
const { registerDeviceAuthTools } = await import("../server/tools/onboarding/device-auth-tools.js");

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

function withAuthEnv<T>(
  values: { bearer?: string | undefined; owner?: string | undefined },
  callback: () => T | Promise<T>,
): Promise<T> | T {
  const previousBearer = process.env.LETAGENTS_AGENT_SESSION_BEARER;
  const previousOwner = process.env.LETAGENTS_TOKEN;
  if (values.bearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
  else process.env.LETAGENTS_AGENT_SESSION_BEARER = values.bearer;
  if (values.owner === undefined) delete process.env.LETAGENTS_TOKEN;
  else process.env.LETAGENTS_TOKEN = values.owner;
  return Promise.resolve(callback()).finally(() => {
    if (previousBearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
    else process.env.LETAGENTS_AGENT_SESSION_BEARER = previousBearer;
    if (previousOwner === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = previousOwner;
  });
}

test("worker bearer mode uses the worker Authorization header without owner credentials", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    setOwnerAuthStoreLoaderForTest(async () => assert.fail("worker bearer mode must not load saved auth"));
    try {
      globalThis.fetch = async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer worker-secret");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      assert.deepEqual(await apiCall("/rooms/room_1/messages"), { ok: true });
    } finally {
      setOwnerAuthStoreLoaderForTest(null);
    }
  });
  globalThis.fetch = originalFetch;
});

test("worker bearer mode rejects dual owner credentials before an API request", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: "owner-secret" }, async () => {
    globalThis.fetch = async () => assert.fail("dual credentials must fail before fetch");
    assert.deepEqual(getWorkerBearerRuntime(), {
      mode: "invalid",
      error: "Worker bearer mode refuses LETAGENTS_TOKEN. Remove the owner token from this process before starting the worker.",
    });
    assert.throws(() => requireValidWorkerBearerRuntime(), WorkerBearerRuntimeConfigurationError);
    await assert.rejects(() => apiCall("/rooms/room_1/messages"), WorkerBearerRuntimeConfigurationError);
  });
  globalThis.fetch = originalFetch;
});

test("blank worker bearer does not activate worker mode", async () => {
  await withAuthEnv({ bearer: "  ", owner: undefined }, async () => {
    assert.deepEqual(getWorkerBearerRuntime(), { mode: "owner" });
  });
});

test("worker bearer mode omits persisted session credentials from room payloads", async () => {
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    assert.deepEqual(agentSessionCredentials({
      session_id: "agent_session_owner",
      session_token: "owner-session-secret",
    } as never), {});
  });
});

test("worker bearer mode preserves server scope errors for owner routes", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "owner access required" }), { status: 403 });
    await assert.rejects(
      () => apiCall("/admin/owner-only"),
      (error: unknown) => error instanceof ApiError && error.status === 403 && /owner access required/.test(error.body),
    );
  });
  globalThis.fetch = originalFetch;
});

test("worker bearer mode disables owner-auth onboarding tools without API traffic", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    globalThis.fetch = async () => assert.fail("worker onboarding guard must run before fetch");
    const startDeviceAuth = toolHandler(registerDeviceAuthTools, "start_device_auth");
    const result = await startDeviceAuth({});
    assert.deepEqual(JSON.parse(result.content[0]!.text), {
      success: false,
      error: "worker_bearer_mode",
      message: "This owner-auth onboarding tool is disabled while LETAGENTS_AGENT_SESSION_BEARER is configured.",
    });
  });
  globalThis.fetch = originalFetch;
});

test("worker bearer mode runs the room register, send, and wait loop without session credentials", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | null }> = [];
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      requests.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body,
      });
      if (String(url).endsWith("/agent-sessions")) assert.fail("worker bearer registration must not call the owner registration route");
      if (String(url).endsWith("/presence")) return new Response(null, { status: 204 });
      if (String(url).includes("/messages/poll")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      return new Response(JSON.stringify({ id: "msg_1", text: "hello" }), { status: 200 });
    };

    const register = toolHandler(registerAgentSessionTools, "register_agent_session");
    const send = toolHandler(registerSendMessageTool, "send_message");
    const wait = toolHandler(registerWaitForMessagesTool, "wait_for_messages");
    const registration = JSON.parse((await register({ room_id: "room_1" })).content[0]!.text);
    assert.equal(registration.success, true);
    assert.equal(registration.worker_bearer_mode, true);
    assert.equal(registration.agent_session_id, "worker_bearer");
    const sendResult = await send({ room_id: "room_1", text: "hello", agent_session_id: registration.agent_session_id });
    const waitResult = await wait({ room_id: "room_1", timeout: 1, agent_session_id: registration.agent_session_id });

    assert.match(sendResult.content[0]!.text, /msg_1/);
    assert.match(waitResult.content[0]!.text, /messages/);
    const messageRequest = requests.find((request) => request.url.endsWith("/rooms/room_1/messages"));
    const pollRequest = requests.find((request) => request.url.includes("/rooms/room_1/messages/poll"));
    assert.ok(messageRequest);
    assert.ok(pollRequest);
    for (const request of [messageRequest, pollRequest]) {
      assert.equal(request.headers.Authorization, "Bearer worker-secret");
      assert.equal(request.body?.agent_session_id, undefined);
      assert.equal(request.body?.agent_session_token, undefined);
    }
  });
  globalThis.fetch = originalFetch;
});
