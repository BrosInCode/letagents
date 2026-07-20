import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_API_URL ??= "http://127.0.0.1:39999";

const {
  getWorkerBearerRuntime,
  requireValidWorkerBearerRuntime,
  WorkerBearerRuntimeConfigurationError,
} = await import("../server/runtime/worker-bearer.js");
const { ApiError, apiCall, setOwnerAuthStoreLoaderForTest } = await import("../server/runtime/api.js");
const { agentSessionCredentials } = await import("../server/runtime/agent-sessions.js");
const { registerAgentSessionTools } = await import("../server/tools/agent-sessions.js");
const {
  getCurrentRoomPayload,
  setRoomInspectionOwnerAuthStoreLoaderForTest,
} = await import("../server/tools/rooms/inspection-tools.js");
const { rememberRoom, toRoomState } = await import("../server/runtime/room-state.js");
const { autoJoinFromContext } = await import("../server/runtime/rooms.js");
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
  values: {
    bearer?: string | undefined;
    owner?: string | undefined;
    apiUrl?: string | null;
    boundedTurns?: string | undefined;
  },
  callback: () => T | Promise<T>,
): Promise<T> | T {
  const previousBearer = process.env.LETAGENTS_AGENT_SESSION_BEARER;
  const previousOwner = process.env.LETAGENTS_TOKEN;
  const previousApiUrl = process.env.LETAGENTS_API_URL;
  const previousBoundedTurns = process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS;
  if (values.bearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
  else process.env.LETAGENTS_AGENT_SESSION_BEARER = values.bearer;
  if (values.owner === undefined) delete process.env.LETAGENTS_TOKEN;
  else process.env.LETAGENTS_TOKEN = values.owner;
  if (values.apiUrl === null) delete process.env.LETAGENTS_API_URL;
  else if (values.apiUrl !== undefined) process.env.LETAGENTS_API_URL = values.apiUrl;
  if (values.boundedTurns === undefined) delete process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS;
  else process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS = values.boundedTurns;
  return Promise.resolve(callback()).finally(() => {
    if (previousBearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
    else process.env.LETAGENTS_AGENT_SESSION_BEARER = previousBearer;
    if (previousOwner === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = previousOwner;
    if (previousApiUrl === undefined) delete process.env.LETAGENTS_API_URL;
    else process.env.LETAGENTS_API_URL = previousApiUrl;
    if (previousBoundedTurns === undefined) delete process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS;
    else process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS = previousBoundedTurns;
  });
}

test("worker bearer mode uses the worker Authorization header without owner credentials", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    setOwnerAuthStoreLoaderForTest(async () => assert.fail("worker bearer mode must not load saved auth"));
    try {
      globalThis.fetch = async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer worker-secret");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      assert.deepEqual(await apiCall("/rooms/room_1/messages"), { ok: true });
    } finally {
      setOwnerAuthStoreLoaderForTest(null);
    }
  });
  globalThis.fetch = originalFetch;
});

test("worker bearer mode overwrites every caller Authorization header variant", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    globalThis.fetch = async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer worker-secret");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await apiCall("/rooms/room_1/messages", {
      headers: { authorization: "Bearer attacker-controlled" },
    });
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

test("worker bearer mode requires an explicit valid API URL", async () => {
  await withAuthEnv({ bearer: "worker-secret", owner: undefined, apiUrl: null }, async () => {
    assert.deepEqual(getWorkerBearerRuntime(), {
      mode: "invalid",
      error: "Worker bearer mode requires an explicit LETAGENTS_API_URL.",
    });
  });
  await withAuthEnv({ bearer: "worker-secret", owner: undefined, apiUrl: "http://example.test" }, async () => {
    assert.deepEqual(getWorkerBearerRuntime(), {
      mode: "invalid",
      error: "Worker bearer mode requires HTTPS unless LETAGENTS_API_URL uses an exact loopback host.",
    });
  });
  await withAuthEnv({ bearer: "worker-secret", owner: undefined, apiUrl: "not a URL" }, async () => {
    assert.deepEqual(getWorkerBearerRuntime(), {
      mode: "invalid",
      error: "Worker bearer mode requires LETAGENTS_API_URL to be a valid HTTP(S) URL.",
    });
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

test("worker bearer mode keeps room inspection off saved owner auth and local Codex data", async () => {
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    rememberRoom(toRoomState({ room_id: "room_inspection", joined_via: "join_room", is_local: true }));
    setRoomInspectionOwnerAuthStoreLoaderForTest(async () => assert.fail("worker room inspection must not load saved auth"));
    try {
      const result = await getCurrentRoomPayload();
      assert.deepEqual(result.auth, {
        source: "worker_bearer",
        expires_at: null,
        account: null,
      });
      assert.equal(result.current_local_codex_session, null);
      assert.equal(result.local_codex_session_count, 0);
    } finally {
      setRoomInspectionOwnerAuthStoreLoaderForTest(null);
    }
  });
});

test("worker bearer mode disables local Codex session orchestration", async () => {
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    const start = toolHandler(registerAgentSessionTools, "start_local_codex_session");
    assert.deepEqual(JSON.parse((await start({ room: "room_1" })).content[0]!.text), {
      success: false,
      error: "worker_bearer_mode",
      message: "Local Codex session orchestration is disabled while LETAGENTS_AGENT_SESSION_BEARER is configured.",
    });
  });
});

test("supervised bounded turns refuse wait_for_messages before any local or network work", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined, boundedTurns: "1" }, async () => {
    globalThis.fetch = async () => assert.fail("bounded wait guard must run before fetch");
    const wait = toolHandler(registerWaitForMessagesTool, "wait_for_messages");
    const result = await wait({ room_id: "room_supervised", after_message_id: "msg_1" });
    assert.deepEqual(JSON.parse(result.content[0]!.text), {
      success: false,
      error: "supervised_bounded_delivery",
      message: "wait_for_messages is disabled because supervised room delivery is owned by the desktop daemon.",
    });
  });
  globalThis.fetch = originalFetch;
});

test("ordinary worker bearer mode retains wait_for_messages when bounded delivery is off", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined, boundedTurns: "0" }, async () => {
    const requests: string[] = [];
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      requests.push(requestUrl);
      if (requestUrl.endsWith("/presence")) return new Response(null, { status: 204 });
      if (requestUrl.includes("/messages/poll")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    };
    const wait = toolHandler(registerWaitForMessagesTool, "wait_for_messages");
    const result = await wait({ room_id: "room_ordinary", after_message_id: "msg_1", timeout: 1 });
    assert.match(result.content[0]!.text, /messages/);
    assert.ok(requests.some((url) => url.includes("/rooms/room_ordinary/messages/poll")));
  });
  globalThis.fetch = originalFetch;
});

test("worker bearer startup binds its configured room locally for omitted-room tools", async () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalStatePath = process.env.LETAGENTS_STATE_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-worker-bearer-"));
  const requests: string[] = [];
  try {
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "room_autobind" }));
    process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
    process.chdir(tempDir);
    await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
      globalThis.fetch = async (url) => {
        const requestUrl = String(url);
        requests.push(requestUrl);
        assert.doesNotMatch(requestUrl, /\/(?:join|projects)(?:\/|$)/, "worker auto-bind must not join or create");
        if (requestUrl.includes("room_outside_scope")) {
          return new Response(JSON.stringify({ error: "worker bearer room scope mismatch" }), { status: 403 });
        }
        if (requestUrl.endsWith("/presence")) return new Response(null, { status: 204 });
        if (requestUrl.includes("/messages/poll")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
        // No-cursor wait_for_messages now reads the bounded recent tail
        // (GET /messages?before=…&limit=…) instead of long-polling /messages/poll.
        if (requestUrl.includes("/messages?") && requestUrl.includes("before=")) {
          return new Response(JSON.stringify({ messages: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: "msg_autobind", text: "hello" }), { status: 200 });
      };
      await autoJoinFromContext();

      const register = toolHandler(registerAgentSessionTools, "register_agent_session");
      const send = toolHandler(registerSendMessageTool, "send_message");
      const wait = toolHandler(registerWaitForMessagesTool, "wait_for_messages");
      const registration = JSON.parse((await register({})).content[0]!.text);
      assert.equal(registration.success, true);
      await send({ text: "hello", agent_session_id: registration.agent_session_id });
      await wait({ timeout: 1, agent_session_id: registration.agent_session_id });
      await assert.rejects(
        () => send({ room_id: "room_outside_scope", text: "outside", agent_session_id: registration.agent_session_id }),
        (error: unknown) => error instanceof ApiError && error.status === 403,
      );
    });
    assert.ok(requests.some((url) => url.includes("/rooms/room_autobind/messages")));
    // No-cursor wait autobinds to the configured room and reads its bounded
    // recent tail (before=/limit=), not the long-poll endpoint.
    assert.ok(requests.some((url) =>
      url.includes("/rooms/room_autobind/messages?") && url.includes("before=") && url.includes("limit=")
    ));
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalStatePath === undefined) delete process.env.LETAGENTS_STATE_PATH;
    else process.env.LETAGENTS_STATE_PATH = originalStatePath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("worker bearer mode runs the room register, send, and wait loop without session credentials", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | null }> = [];
    globalThis.fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      requests.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body,
      });
      if (String(url).endsWith("/agent-sessions")) assert.fail("worker bearer registration must not call the owner registration route");
      if (String(url).endsWith("/presence")) return new Response(null, { status: 204 });
      if (String(url).includes("/messages/poll")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      // No-cursor wait_for_messages now reads the bounded recent tail
      // (GET /messages?before=…&limit=…) instead of long-polling /messages/poll.
      if (String(url).includes("/messages?") && String(url).includes("before=")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
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
    // No-cursor wait reads the bounded recent tail (before=/limit=) instead of
    // long-polling /messages/poll.
    const tailRequest = requests.find((request) =>
      request.url.includes("/rooms/room_1/messages?") &&
      request.url.includes("before=") &&
      request.url.includes("limit=")
    );
    assert.ok(messageRequest);
    assert.ok(tailRequest);
    for (const request of [messageRequest, tailRequest]) {
      assert.equal(request.headers.authorization, "Bearer worker-secret");
      assert.equal(request.body?.agent_session_id, undefined);
      assert.equal(request.body?.agent_session_token, undefined);
    }
  });
  globalThis.fetch = originalFetch;
});

test("no-cursor wait returns a non-empty tail immediately but long-polls an empty tail", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
    const wait = toolHandler(registerWaitForMessagesTool, "wait_for_messages");

    // Non-empty tail: return the bounded recent tail immediately and NEVER hit
    // the long-poll endpoint (this is the dump-bug fix).
    const tailRequests: string[] = [];
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      tailRequests.push(requestUrl);
      if (requestUrl.endsWith("/presence")) return new Response(null, { status: 204 });
      if (requestUrl.includes("/messages/poll")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      if (requestUrl.includes("/messages?") && requestUrl.includes("before=")) {
        return new Response(JSON.stringify({ messages: [{ id: "msg_recent", text: "recent" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    };
    const tailResult = await wait({ room_id: "room_tail", timeout: 1 });
    assert.match(tailResult.content[0]!.text, /msg_recent/);
    assert.ok(
      tailRequests.some((url) => url.includes("/rooms/room_tail/messages?") && url.includes("before=")),
      "non-empty tail must probe the bounded tail endpoint",
    );
    assert.ok(
      !tailRequests.some((url) => url.includes("/messages/poll")),
      "non-empty tail must NOT long-poll",
    );

    // Empty tail: fall through to the /messages/poll long-poll so a worker
    // looping in a quiet room blocks instead of busy-spinning.
    const emptyRequests: string[] = [];
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      emptyRequests.push(requestUrl);
      if (requestUrl.endsWith("/presence")) return new Response(null, { status: 204 });
      if (requestUrl.includes("/messages/poll")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      if (requestUrl.includes("/messages?") && requestUrl.includes("before=")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    };
    await wait({ room_id: "room_quiet", timeout: 1 });
    assert.ok(
      emptyRequests.some((url) => url.includes("/rooms/room_quiet/messages?") && url.includes("before=")),
      "empty tail still probes the tail endpoint first",
    );
    assert.ok(
      emptyRequests.some((url) => url.includes("/rooms/room_quiet/messages/poll")),
      "empty tail must fall through to the long-poll endpoint",
    );
  });
  globalThis.fetch = originalFetch;
});
