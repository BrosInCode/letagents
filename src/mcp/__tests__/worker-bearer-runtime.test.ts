import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_API_URL ??= "http://127.0.0.1:39999";

const {
  getWorkerBearerRuntime,
  requireValidWorkerBearerRuntime,
  WorkerBearerRuntimeConfigurationError,
} = await import("../server/runtime/worker-bearer.js");
const {
  ApiError,
  SupervisedWorkerCredentialError,
  apiCall,
  setOwnerAuthStoreLoaderForTest,
  setSupervisedCredentialBorrowerForTest,
} = await import("../server/runtime/api.js");
const { agentSessionCredentials } = await import("../server/runtime/agent-sessions.js");
const { registerAgentSessionTools } = await import("../server/tools/agent-sessions.js");
const {
  getCurrentRoomPayload,
  registerRoomInspectionTools,
  setRoomInspectionOwnerAuthStoreLoaderForTest,
} = await import("../server/tools/rooms/inspection-tools.js");
const roomState = await import("../server/runtime/room-state.js");
const { getFallbackProjectId, rememberRoom, runWithCurrentSupervisedRoom, toRoomState } = roomState;
const { roomScopedApiCall } = await import("../server/runtime/room-api.js");
const { autoJoinFromContext } = await import("../server/runtime/rooms.js");
const { registerSendMessageTool } = await import("../server/tools/messages/send-tool.js");
const { registerWaitForMessagesTool } = await import("../server/tools/messages/wait-tool.js");
const { profileAwareToolServer } = await import("../server/supervised-tool-facade.js");
const { registerDeviceAuthTools } = await import("../server/tools/onboarding/device-auth-tools.js");
const { registerRoomJoinTools } = await import("../server/tools/rooms/join-tools.js");

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
    executionProfile?: string | undefined;
    supervisorRoomId?: string | undefined;
    supervisorAgentSessionId?: string | undefined;
  },
  callback: () => T | Promise<T>,
): Promise<T> | T {
  const previousBearer = process.env.LETAGENTS_AGENT_SESSION_BEARER;
  const previousOwner = process.env.LETAGENTS_TOKEN;
  const previousApiUrl = process.env.LETAGENTS_API_URL;
  const previousBoundedTurns = process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS;
  const previousExecutionProfile = process.env.LETAGENTS_EXECUTION_PROFILE;
  const previousSupervisorCoordinates = Object.fromEntries([
    "LETAGENTS_SUPERVISOR_ENTRY_ID",
    "LETAGENTS_SUPERVISOR_DAEMON_SOCKET",
    "LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID",
    "LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID",
    "LETAGENTS_SUPERVISOR_AGENT_SESSION_ID",
    "LETAGENTS_SUPERVISOR_ROOM_ID",
    "LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME",
    "LETAGENTS_SUPERVISOR_PROVIDER",
  ].map((key) => [key, process.env[key]]));
  if (values.bearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
  else process.env.LETAGENTS_AGENT_SESSION_BEARER = values.bearer;
  if (values.owner === undefined) delete process.env.LETAGENTS_TOKEN;
  else process.env.LETAGENTS_TOKEN = values.owner;
  if (values.apiUrl === null) delete process.env.LETAGENTS_API_URL;
  else if (values.apiUrl !== undefined) process.env.LETAGENTS_API_URL = values.apiUrl;
  if (values.boundedTurns === undefined) delete process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS;
  else process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS = values.boundedTurns;
  const executionProfile = values.executionProfile ?? (values.boundedTurns === "1" ? "supervised_room_turn" : undefined);
  if (executionProfile === undefined) delete process.env.LETAGENTS_EXECUTION_PROFILE;
  else process.env.LETAGENTS_EXECUTION_PROFILE = executionProfile;
  if (values.supervisorRoomId) {
    process.env.LETAGENTS_SUPERVISOR_ENTRY_ID = "entry_exact";
    process.env.LETAGENTS_SUPERVISOR_DAEMON_SOCKET = "/tmp/letagents-test-daemon.sock";
    process.env.LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID = "attempt_exact";
    process.env.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID = "generation_exact";
    process.env.LETAGENTS_SUPERVISOR_AGENT_SESSION_ID = values.supervisorAgentSessionId ?? "session_exact";
    process.env.LETAGENTS_SUPERVISOR_ROOM_ID = values.supervisorRoomId;
    process.env.LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME = "Exact Worker";
    process.env.LETAGENTS_SUPERVISOR_PROVIDER = "cursor";
  }
  return Promise.resolve(callback()).finally(() => {
    if (previousBearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
    else process.env.LETAGENTS_AGENT_SESSION_BEARER = previousBearer;
    if (previousOwner === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = previousOwner;
    if (previousApiUrl === undefined) delete process.env.LETAGENTS_API_URL;
    else process.env.LETAGENTS_API_URL = previousApiUrl;
    if (previousBoundedTurns === undefined) delete process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS;
    else process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS = previousBoundedTurns;
    if (previousExecutionProfile === undefined) delete process.env.LETAGENTS_EXECUTION_PROFILE;
    else process.env.LETAGENTS_EXECUTION_PROFILE = previousExecutionProfile;
    for (const [key, value] of Object.entries(previousSupervisorCoordinates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

test("bounded supervised calls borrow the current credential for every request and ignore owner auth", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: undefined, owner: "owner-secret", boundedTurns: "1" }, async () => {
    const borrowed = ["rotated-worker-one", "rotated-worker-two"];
    const observed: string[] = [];
    setOwnerAuthStoreLoaderForTest(async () => assert.fail("bounded supervised calls must not load owner auth"));
    setSupervisedCredentialBorrowerForTest(async () => {
      const credential = borrowed.shift();
      assert.ok(credential, "each request borrows exactly once");
      return { state: "available", credential };
    });
    try {
      globalThis.fetch = async (_url, init) => {
        observed.push(new Headers(init?.headers).get("authorization") || "");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      await apiCall("/rooms/room_1/messages");
      await apiCall("/rooms/room_1/messages");
      assert.deepEqual(observed, ["Bearer rotated-worker-one", "Bearer rotated-worker-two"]);
    } finally {
      setSupervisedCredentialBorrowerForTest(null);
      setOwnerAuthStoreLoaderForTest(null);
    }
  });
  globalThis.fetch = originalFetch;
});

test("bounded supervised calls fail closed before fetch for deferred, stale, or absent context", async () => {
  const originalFetch = globalThis.fetch;
  for (const result of [
    { state: "deferred", code: "SUPERVISED_CREDENTIAL_UNAVAILABLE" } as const,
    { state: "stale", code: "SUPERVISED_CREDENTIAL_STALE" } as const,
  ]) {
    await withAuthEnv({ bearer: undefined, owner: "owner-secret", boundedTurns: "1" }, async () => {
      globalThis.fetch = async () => assert.fail("unavailable supervised credentials must fail before fetch");
      setOwnerAuthStoreLoaderForTest(async () => assert.fail("unavailable supervised credentials must not read owner auth"));
      setSupervisedCredentialBorrowerForTest(async () => result);
      try {
        await assert.rejects(() => apiCall("/rooms/room_1/messages"), (error: unknown) =>
          error instanceof SupervisedWorkerCredentialError && error.code === result.code,
        );
      } finally {
        setSupervisedCredentialBorrowerForTest(null);
        setOwnerAuthStoreLoaderForTest(null);
      }
    });
  }
  await withAuthEnv({ bearer: undefined, owner: "owner-secret", boundedTurns: "1" }, async () => {
    globalThis.fetch = async () => assert.fail("missing supervised context must fail before fetch");
    setOwnerAuthStoreLoaderForTest(async () => assert.fail("missing supervised context must not read owner auth"));
    try {
      await assert.rejects(() => apiCall("/rooms/room_1/messages"), SupervisedWorkerCredentialError);
    } finally {
      setOwnerAuthStoreLoaderForTest(null);
    }
  });
  globalThis.fetch = originalFetch;
});

test("interleaved supervised API calls keep exact room routes and never use ambient project fallback", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; originRoom: string | null }> = [];
  try {
    await withAuthEnv({ bearer: undefined, owner: undefined, boundedTurns: "1" }, async () => {
      rememberRoom(toRoomState({
        room_id: "ambient-room",
        project_id: "ambient-project",
        joined_via: "join_room",
      }));
      assert.equal(getFallbackProjectId(), null);
      setSupervisedCredentialBorrowerForTest(async () => ({ state: "available", credential: "exact-bearer" }));
      globalThis.fetch = async (url, init) => {
        requests.push({
          url: String(url),
          originRoom: new Headers(init?.headers).get("x-letagents-origin-room-id"),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      const call = (roomId: string) => runWithCurrentSupervisedRoom(roomId, () => roomScopedApiCall({
        room_id: roomId,
        project_id: "ambient-project",
        room_path: (id) => `/rooms/${id}/messages`,
        project_path: (id) => `/projects/${id}/messages`,
        options: { headers: { "X-LetAgents-Origin-Room-Id": "ambient-room" } },
      }));
      await Promise.all([call("source-room"), call("destination-room")]);
    });
    assert.deepEqual(requests.map((request) => request.originRoom).sort(), ["destination-room", "source-room"]);
    assert.ok(requests.some((request) => request.url.endsWith("/rooms/source-room/messages")));
    assert.ok(requests.some((request) => request.url.endsWith("/rooms/destination-room/messages")));
    assert.equal(requests.some((request) => request.url.includes("/projects/ambient-project")), false);
  } finally {
    setSupervisedCredentialBorrowerForTest(null);
    globalThis.fetch = originalFetch;
  }
});

test("a missing supervised room route cannot fall back to an ambient project route", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    await withAuthEnv({ bearer: undefined, owner: undefined, boundedTurns: "1" }, async () => {
      setSupervisedCredentialBorrowerForTest(async () => ({ state: "available", credential: "exact-bearer" }));
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response("Not Found", { status: 404 });
      };
      await assert.rejects(
        () => runWithCurrentSupervisedRoom("exact-room", () => roomScopedApiCall({
          room_id: "exact-room",
          project_id: "ambient-project",
          room_path: (id) => `/rooms/${id}/messages`,
          project_path: (id) => `/projects/${id}/messages`,
        })),
        (error: unknown) => error instanceof ApiError && error.status === 404,
      );
    });
    assert.equal(fetchCount, 1);
  } finally {
    setSupervisedCredentialBorrowerForTest(null);
    globalThis.fetch = originalFetch;
  }
});

test("bounded supervised turns reject a fixed bearer instead of bypassing daemon rotation", async () => {
  await withAuthEnv({ bearer: "worker-secret", owner: undefined, boundedTurns: "1" }, async () => {
    assert.deepEqual(getWorkerBearerRuntime(), {
      mode: "invalid",
      error: "Daemon-supervised bounded turns refuse LETAGENTS_AGENT_SESSION_BEARER; credentials must be borrowed from the exact supervisor generation.",
    });
  });
});

test("supervised runtime flags fail closed when only one half is configured", async () => {
  await withAuthEnv({ boundedTurns: "1", executionProfile: "autonomous_mcp_worker" }, async () => {
    assert.deepEqual(getWorkerBearerRuntime(), {
      mode: "invalid",
      error: "LETAGENTS_EXECUTION_PROFILE=supervised_room_turn and LETAGENTS_SUPERVISED_BOUNDED_TURNS=1 must be configured together.",
    });
  });
  await withAuthEnv({ boundedTurns: undefined, executionProfile: "supervised_room_turn" }, async () => {
    assert.deepEqual(getWorkerBearerRuntime(), {
      mode: "invalid",
      error: "LETAGENTS_EXECUTION_PROFILE=supervised_room_turn and LETAGENTS_SUPERVISED_BOUNDED_TURNS=1 must be configured together.",
    });
  });
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

test("custodial polling borrows authority and cannot fall back to owner or environment bearer", async () => {
  for (const credentials of [{ owner: "owner-secret" }, { bearer: "worker-secret" }]) {
    await withAuthEnv({ ...credentials, executionProfile: "supervised_mcp_polling" }, async () => {
      assert.equal(getWorkerBearerRuntime().mode, "invalid");
      assert.throws(requireValidWorkerBearerRuntime, /Custodial polling refuses/);
    });
  }
  const originalFetch = globalThis.fetch;
  try {
    await withAuthEnv({ executionProfile: "supervised_mcp_polling", supervisorRoomId: "room_exact" }, async () => {
      assert.equal(getWorkerBearerRuntime().mode, "supervised");
      setOwnerAuthStoreLoaderForTest(async () => { throw new Error("must not load owner auth"); });
      setSupervisedCredentialBorrowerForTest(async () => ({ state: "stale", code: "SUPERVISED_CREDENTIAL_STALE" }));
      globalThis.fetch = async () => assert.fail("stale borrowed authority must fail before HTTP");
      await assert.rejects(apiCall("/rooms/room_exact/messages"), SupervisedWorkerCredentialError);
      setSupervisedCredentialBorrowerForTest(async () => ({ state: "available", credential: "borrowed-exact" }));
      globalThis.fetch = async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer borrowed-exact");
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      };
      await runWithCurrentSupervisedRoom("room_exact", () => roomScopedApiCall({
        room_id: "room_exact", project_id: null, room_path: () => "/rooms/room_exact/messages", project_path: () => "unused",
      }));
    });
  } finally {
    globalThis.fetch = originalFetch;
    setOwnerAuthStoreLoaderForTest(null);
    setSupervisedCredentialBorrowerForTest(null);
  }
});

test("custodial wait acknowledges input before polling, defaults to durable cursor and gates response", async () => {
  const root = mkdtempSync(join(tmpdir(), "custodial-wait-"));
  const socketPath = join(root, "daemon.sock");
  const phases: string[] = [];
  const acknowledgements: string[] = [];
  let rejectRelease = false;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      let result: unknown;
      let ok = true;
      if (request.method === "daemon.negotiate") result = { protocol_version: 2, generation: 17, pid: 123, started_at: "now", capabilities: { custodialPollingV1: true } };
      else if (request.method === "supervisor.authorize_custodial_polling") {
        phases.push(request.params.phase);
        ok = !(rejectRelease && request.params.phase === "release");
        result = { status: "authorized", contract: "custodial_polling_v1", room_id: "room_exact", agent_session_id: "session_exact", room_cursor: "msg_7", configuration_revision: 3 };
      } else if (request.method === "supervisor.checkpoint_worker_cursor") {
        phases.push("ack"); acknowledgements.push(request.params.room_cursor); result = { checkpointed: true };
      } else throw new Error(`Unexpected request ${request.method}`);
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok, result })}\n`);
    });
  });
  const originalFetch = globalThis.fetch;
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await withAuthEnv({ executionProfile: "supervised_mcp_polling", supervisorRoomId: "room_exact" }, async () => {
      process.env.LETAGENTS_SUPERVISOR_DAEMON_SOCKET = socketPath;
      process.env.LETAGENTS_SUPERVISOR_PROVIDER = "codex";
      setOwnerAuthStoreLoaderForTest(async () => { throw new Error("owner auth forbidden"); });
      setSupervisedCredentialBorrowerForTest(async () => ({ state: "available", credential: "exact-worker" }));
      globalThis.fetch = async (url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer exact-worker");
        if (String(url).includes("/messages/poll?")) {
          phases.push("poll");
          assert.equal(new URL(String(url)).searchParams.get("after"), acknowledgements.at(-1));
          return new Response(JSON.stringify({ room_id: "room_exact", messages: [], last_observed_message_id: "msg_99" }), { status: 200 });
        }
        return new Response(null, { status: 204 });
      };
      const wait = toolHandler((recorder) => registerWaitForMessagesTool(profileAwareToolServer(recorder, "supervised_mcp_polling")), "wait_for_messages");
      await wait({});
      assert.deepEqual(phases, ["before", "ack", "poll", "release"]);
      assert.deepEqual(acknowledgements, ["msg_7"], "response msg_99 must never be checkpointed");
      phases.length = 0;
      rejectRelease = true;
      await assert.rejects(wait({ after_message_id: "msg_8" }), /stale/);
      assert.deepEqual(phases, ["before", "ack", "poll", "release"]);
      assert.deepEqual(acknowledgements, ["msg_7", "msg_8"]);
    });
  } finally {
    globalThis.fetch = originalFetch;
    setOwnerAuthStoreLoaderForTest(null); setSupervisedCredentialBorrowerForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervised bounded turns refuse wait_for_messages before any local or network work", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: undefined, owner: "owner-secret", boundedTurns: "1" }, async () => {
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

test("bounded supervised turns disable owner onboarding before any local owner access", async () => {
  const originalFetch = globalThis.fetch;
  await withAuthEnv({ bearer: undefined, owner: "owner-secret", boundedTurns: "1" }, async () => {
    globalThis.fetch = async () => assert.fail("bounded onboarding guard must run before fetch");
    const startDeviceAuth = toolHandler(registerDeviceAuthTools, "start_device_auth");
    const result = await startDeviceAuth({});
    assert.deepEqual(JSON.parse(result.content[0]!.text), {
      success: false,
      error: "supervised_bounded_mode",
      message: "This owner-auth onboarding tool is disabled during a daemon-supervised bounded turn.",
    });
  });
  globalThis.fetch = originalFetch;
});

test("supervised registration and message sends use the exact context room before local storage", async () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalStatePath = process.env.LETAGENTS_STATE_PATH;
  const originalChatStorage = process.env.LETAGENTS_CHAT_STORAGE;
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-supervised-register-"));
  try {
    writeFileSync(join(tempDir, ".letagents-supervisor-context.json"), JSON.stringify({
      version: 1, provider: "codex", entry_id: "entry_exact", room_id: "room_exact",
      work_attempt_id: "attempt_exact", execution_generation_id: "generation_exact",
      agent_session_id: "session_exact", agent_display_name: "Exact worker",
    }));
    writeFileSync(join(tempDir, ".letagents-work-attempt.json"), JSON.stringify({
      version: 1, work_attempt_id: "attempt_exact",
    }));
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "ambient_local_room" }));
    process.chdir(tempDir);
    process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
    process.env.LETAGENTS_CHAT_STORAGE = "local";
    await withAuthEnv({ bearer: undefined, owner: "owner-secret", boundedTurns: "1" }, async () => {
      await runWithCurrentSupervisedRoom("room_exact", async () => {
        const register = toolHandler(registerAgentSessionTools, "register_agent_session");
        const registration = JSON.parse((await register({})).content[0]!.text);
        assert.equal(registration.success, true);
        assert.equal(registration.agent_session_id, "session_exact");
        assert.equal(registration.agent_session.room_id, "room_exact");
        await assert.rejects(() => register({ room_id: "ambient_local_room" }), /registered for room_exact/);

        const requests: string[] = [];
        setSupervisedCredentialBorrowerForTest(async () => ({ state: "available", credential: "daemon-only" }));
        globalThis.fetch = async (url, init) => {
          requests.push(String(url));
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer daemon-only");
          if (String(url).endsWith("/presence")) return new Response(null, { status: 204 });
          return new Response(JSON.stringify({ id: "msg_exact", text: "sent" }), { status: 200 });
        };
        const send = toolHandler(registerSendMessageTool, "send_message");
        await send({ room_id: "room_exact", text: "cloud only", agent_session_id: "session_exact" });
        const requestCountBeforeMismatch = requests.length;
        await assert.rejects(
          () => send({ room_id: "ambient_local_room", text: "blocked", agent_session_id: "session_exact" }),
          /authorized for room_exact, not ambient_local_room/,
        );
        assert.equal(requests.length, requestCountBeforeMismatch, "an explicit room mismatch must fail before tool network traffic");
        assert.ok(requests.some((url) => url.endsWith("/rooms/room_exact/messages")), "local storage cannot bypass the exact cloud route");
        setSupervisedCredentialBorrowerForTest(null);
      });
    });
  } finally {
    setSupervisedCredentialBorrowerForTest(null);
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalStatePath === undefined) delete process.env.LETAGENTS_STATE_PATH;
    else process.env.LETAGENTS_STATE_PATH = originalStatePath;
    if (originalChatStorage === undefined) delete process.env.LETAGENTS_CHAT_STORAGE;
    else process.env.LETAGENTS_CHAT_STORAGE = originalChatStorage;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bounded supervised tools bind the exact daemon room without joining ambient repository context", async () => {
  const originalCwd = process.cwd();
  const originalStatePath = process.env.LETAGENTS_STATE_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-bounded-autojoin-"));
  try {
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "ambient-room" }));
    process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
    process.chdir(tempDir);
    rememberRoom(toRoomState({ room_id: "stale-or-ambient-room", joined_via: "join_room", is_local: true }));
    await withAuthEnv({
      bearer: undefined,
      owner: "owner-secret",
      boundedTurns: "1",
      supervisorRoomId: "exact-supervisor-room",
    }, async () => {
      await autoJoinFromContext();
      assert.equal(roomState.currentRoom?.room_id, "stale-or-ambient-room", "startup must not trust ambient or launch-time room state");
      await runWithCurrentSupervisedRoom("exact-supervisor-room", async () => {
        assert.equal(roomState.currentRoom?.room_id, "stale-or-ambient-room", "per-call authority must not mutate process-global room state");

        const currentRoom = await getCurrentRoomPayload();
        assert.equal(currentRoom.connected, true);
        assert.equal(currentRoom.room_id, "exact-supervisor-room");
        assert.equal(currentRoom.room_binding, "daemon_supervised");
        assert.equal(currentRoom.joined_via, null);
        assert.equal(currentRoom.is_local, null);
        assert.equal("agent_prompt" in currentRoom, false, "an exact supervised binding must not ask the provider to join");

        const checkRepo = toolHandler(registerRoomInspectionTools, "check_repo");
        const repo = JSON.parse((await checkRepo({ cwd: tempDir })).content[0]!.text);
        assert.equal(repo.current_room.room_id, "exact-supervisor-room");
        assert.equal(repo.current_room.joined_via, null);
        assert.equal(repo.current_room.is_local, null);
        assert.equal(repo.current_room_scope, "daemon_supervised_exact_room");
        assert.equal(repo.warning, null);
        assert.equal(repo.join_hint, null);
      });
    });
  } finally {
    process.chdir(originalCwd);
    if (originalStatePath === undefined) delete process.env.LETAGENTS_STATE_PATH;
    else process.env.LETAGENTS_STATE_PATH = originalStatePath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bounded supervised room joins cannot select an ambient local room", async () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalStatePath = process.env.LETAGENTS_STATE_PATH;
  const originalChatStorage = process.env.LETAGENTS_CHAT_STORAGE;
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-bounded-room-join-"));
  try {
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "ambient_local_room" }));
    process.chdir(tempDir);
    process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
    process.env.LETAGENTS_CHAT_STORAGE = "local";
    rememberRoom(toRoomState({ room_id: "exact-supervisor-room", joined_via: "join_room", is_local: true }));
    await withAuthEnv({ bearer: undefined, owner: "owner-secret", boundedTurns: "1" }, async () => {
      globalThis.fetch = async () => assert.fail("bounded room joins must fail before network");
      const joinRoom = toolHandler(registerRoomJoinTools, "join_room");
      await assert.rejects(() => joinRoom({ name: "ambient_local_room" }), /Room joins and creation are disabled/);
      assert.equal(roomState.currentRoom?.room_id, "exact-supervisor-room");
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalStatePath === undefined) delete process.env.LETAGENTS_STATE_PATH;
    else process.env.LETAGENTS_STATE_PATH = originalStatePath;
    if (originalChatStorage === undefined) delete process.env.LETAGENTS_CHAT_STORAGE;
    else process.env.LETAGENTS_CHAT_STORAGE = originalChatStorage;
    rmSync(tempDir, { recursive: true, force: true });
  }
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
        return new Response(JSON.stringify({ messages: [], last_observed_message_id: "msg_2" }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    };
    const wait = toolHandler(registerWaitForMessagesTool, "wait_for_messages");
    const result = await wait({ room_id: "room_ordinary", after_message_id: "msg_1", timeout: 1 });
    assert.match(result.content[0]!.text, /messages/);
    assert.equal(JSON.parse(result.content[0]!.text).last_observed_message_id, "msg_2");
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
  const locator = "github.com/brosincode/letagents/focus/git:branch:Y29kZXgvY2Fub25pY2Fs";
  try {
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: locator }));
    process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
    process.chdir(tempDir);
    await withAuthEnv({ bearer: "worker-secret", owner: undefined }, async () => {
      globalThis.fetch = async (url) => {
        const requestUrl = String(url);
        requests.push(requestUrl);
        if (requestUrl.endsWith(`/rooms/resolve/${encodeURIComponent(locator)}`)) {
          return new Response(JSON.stringify({
            canonical_room_id: "focus_37",
            room_exists: true,
          }), { status: 200 });
        }
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
    assert.ok(requests.some((url) => url.includes("/rooms/focus_37/messages")));
    assert.ok(requests.some((url) => url.endsWith(`/rooms/resolve/${encodeURIComponent(locator)}`)));
    assert.ok(!requests.some((url) => url.includes("/join?create=false")));
    // No-cursor wait autobinds to the configured room and reads its bounded
    // recent tail (before=/limit=), not the long-poll endpoint.
    assert.ok(requests.some((url) =>
      url.includes("/rooms/focus_37/messages?") && url.includes("before=") && url.includes("limit=")
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
