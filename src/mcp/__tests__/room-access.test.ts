import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-room-access-"));
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_API_URL = "http://127.0.0.1:39998";
process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
process.env.LETAGENTS_CHAT_STORAGE = "cloud";
delete process.env.LETAGENTS_TOKEN;
delete process.env.LETAGENTS_AGENT_SESSION_BEARER;

const {
  repoCollaboratorRequiredBody,
  roomMembershipRequiredBody,
} = await import("../../../shared/room-membership.mjs");
const { AGENT_SESSION_ENDED_ERROR } = await import("../../shared/request-headers.js");
const { ApiError, RoomAccessRefusedError, apiCall } = await import("../server/runtime/api.js");
const { clearPendingDeviceAuth, getStoredAuth, saveAgentSession, setStoredAuth } = await import("../local-state.js");
const { registerTools } = await import("../server/register-tools.js");
const { rememberRoom, shutdownRuntime, toRoomState } = await import("../server/runtime/room-state.js");
const { SseClient, SseRoomAccessRefusedError } = await import("../sse-client.js");
const { holdProcessConnection, releaseProcessConnection } = await import("../server/runtime/process-connection.js");
const { pinAttachmentWorkingFolder } = await import("../server/runtime/message-attachments.js");

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  shutdownRuntime();
  clearPendingDeviceAuth();
});

type Handler = (input: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ text: string }> }>;

function handlers(profile: "autonomous_mcp_worker" | "interactive_desktop" = "autonomous_mcp_worker"): Map<string, Handler> {
  const found = new Map<string, Handler>();
  registerTools({
    tool(name: string, ...registration: unknown[]) {
      found.set(name, registration.at(-1) as Handler);
      return {};
    },
  } as unknown as McpServer, profile);
  return found;
}

async function call(name: string, input: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const handler = handlers().get(name);
  assert.ok(handler, `${name} is registered`);
  const result = await handler(input, { requestId: `request_${name}` });
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

const pendingRequest = {
  id: "jr_1",
  state: "pending" as const,
  created_at: "2026-11-04T08:00:00.000Z",
  decided_at: null,
  retry_after: null,
};
const membershipRefusal = roomMembershipRequiredBody({
  room_id: "room_secret",
  display_name: "Secret Room",
  join_request: pendingRequest,
});

/**
 * A server where every room route refuses, as PR 5 will for a non-member.
 * Presence updates are best effort, so they succeed; the stream refuses too.
 */
function refusingServer(body: Record<string, unknown>, status = 403) {
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    requests.push({ method: init?.method ?? "GET", path: parsed.pathname, authorization: new Headers(init?.headers).get("authorization") });
    if (parsed.pathname.endsWith("/presence")) return new Response(null, { status: 204 });
    if (parsed.pathname === "/auth/device/start") {
      return json({ request_id: "device_1", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    }
    return json(body, status);
  };
  return requests;
}

function withEnv<T>(values: Record<string, string | undefined>, callback: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return callback().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function assertMembershipResult(result: Record<string, any>, name: string, nextStep = "request_room_access") {
  assert.deepEqual({
    success: result.success,
    error: result.error,
    next_step: result.next_step,
    room_id: result.room_id,
    display_name: result.display_name,
    join_request: result.join_request,
  }, {
    success: false,
    error: "membership_required",
    next_step: nextStep,
    room_id: "room_secret",
    display_name: "Secret Room",
    join_request: pendingRequest,
  }, `${name}: ${JSON.stringify(result)}`);
  assert.match(result.message, /Only members can open this room/, name);
  assert.match(result.message, nextStep === "request_room_access" ? /waiting for a room admin/ : /Tell your user/, name);
  assert.match(result.message, /Do not retry this room/, name);
}

test("a members-only 403 becomes a refusal error that keeps the server's facts", async () => {
  refusingServer(membershipRefusal);
  await assert.rejects(() => apiCall("/rooms/room_secret/messages"), (error: unknown) => {
    assert.ok(error instanceof RoomAccessRefusedError);
    assert.ok(error instanceof ApiError, "callers that check ApiError status still work");
    assert.equal(error.status, 403);
    assert.equal(error.refusal, "membership_required");
    assert.equal(error.roomId, "room_secret");
    assert.equal(error.displayName, "Secret Room");
    assert.deepEqual(error.joinRequest, pendingRequest);
    return true;
  });

  refusingServer({ error: "Private repo access required", code: "PRIVATE_REPO_NO_ACCESS" });
  await assert.rejects(() => apiCall("/rooms/github.com%2Fo%2Fp/messages"), (error: unknown) =>
    error instanceof ApiError && !(error instanceof RoomAccessRefusedError) && error.status === 403);
});

test("a 403 never clears the saved sign-in; only a 401 for the saved token does", async () => {
  const saved = () => setStoredAuth({ token: "saved-token", stored_at: new Date().toISOString(), source: "device_flow" });

  saved();
  const requests = refusingServer(membershipRefusal);
  await assert.rejects(() => apiCall("/rooms/room_secret/messages"), RoomAccessRefusedError);
  assert.equal(requests[0]!.authorization, "Bearer saved-token");
  assert.equal(getStoredAuth()?.token, "saved-token", "a members-only refusal keeps the sign-in");

  refusingServer(repoCollaboratorRequiredBody({ room_id: "github.com/o/p" }));
  await assert.rejects(() => apiCall("/rooms/github.com/o/p/messages"), RoomAccessRefusedError);
  assert.equal(getStoredAuth()?.token, "saved-token", "a repository refusal keeps the sign-in");

  refusingServer({ error: AGENT_SESSION_ENDED_ERROR }, 401);
  await assert.rejects(() => apiCall("/rooms/room_secret/messages"), ApiError);
  assert.equal(getStoredAuth()?.token, "saved-token", "an ended agent session says nothing about the owner token");

  await withEnv({ LETAGENTS_TOKEN: "env-token" }, async () => {
    const envRequests = refusingServer({ error: "The bearer credential is invalid or expired. Reconnect with a current credential." }, 401);
    await assert.rejects(() => apiCall("/rooms/room_secret/messages"), ApiError);
    assert.equal(envRequests[0]!.authorization, "Bearer env-token");
  });
  assert.equal(getStoredAuth()?.token, "saved-token", "a rejected LETAGENTS_TOKEN does not delete the unused saved token");

  refusingServer({ error: "The bearer credential is invalid or expired. Reconnect with a current credential." }, 401);
  await assert.rejects(() => apiCall("/rooms/room_secret/messages"), ApiError);
  assert.equal(getStoredAuth(), null, "a rejected saved token is forgotten");
});

test("every room tool answers a members-only refusal with the same result", async () => {
  const project = join(tempDir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, "note.txt"), "hello");
  pinAttachmentWorkingFolder(project, project);
  // A worker credential acts for an agent, which cannot ask to join itself.
  await withEnv({ LETAGENTS_AGENT_SESSION_BEARER: "worker-secret" }, async () => {
    rememberRoom(toRoomState({ room_id: "room_secret", display_name: "Secret Room", joined_via: "join_room" }));
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["read_messages", {}, /^\/rooms\/room_secret\/messages$/],
      ["wait_for_messages", { after_message_id: "msg_1", timeout: 1000 }, /^\/rooms\/room_secret\/messages\/poll$/],
      ["send_message", { text: "hello" }, /^\/rooms\/room_secret\/messages$/],
      ["send_thread_message", { thread_parent_id: "msg_1", text: "hello" }, /^\/rooms\/room_secret\/messages\/msg_1/],
      ["send_message", { text: "with a file", attachments: ["note.txt"] }, /^\/rooms\/room_secret\/attachments/],
      ["react_to_message", { message_id: "msg_1", emoji: "👍" }, /^\/rooms\/room_secret\/messages\/msg_1\/reactions/],
      ["get_board", {}, /^\/rooms\/room_secret\/tasks/],
      ["claim_task", { task_id: "task_1" }, /^\/rooms\/room_secret\/tasks\/task_1/],
      ["list_wake_rules", {}, /^\/rooms\/room_secret\/wake-rules/],
      ["get_room_memory", {}, /^\/rooms\/room_secret\//],
      ["get_room_history_summary", {}, /^\/rooms\/room_secret\/history-summary$/],
    ];
    for (const [name, input, route] of cases) {
      const requests = refusingServer(membershipRefusal);
      assertMembershipResult(await call(name, input), name, "ask_your_user");
      assert.ok(requests.some((request) => route.test(request.path)), `${name} asked ${route}: ${JSON.stringify(requests)}`);
    }
  });

  // The account's own client can ask.
  rememberRoom(toRoomState({ room_id: "room_secret", display_name: "Secret Room", joined_via: "join_room" }));
  for (const name of ["read_messages", "get_board"]) {
    refusingServer(membershipRefusal);
    assertMembershipResult(await call(name), name);
  }
});

test("the join tools answer both refusals with a next step", async () => {
  for (const [name, input] of [
    ["join_room", { name: "room_secret" }],
    ["join_code", { code: "ABCD-1234" }],
    ["join_project", { code: "ABCD-1234" }],
  ] as const) {
    refusingServer(membershipRefusal);
    assertMembershipResult(await call(name, input), name);
  }

  refusingServer(repoCollaboratorRequiredBody({ room_id: "github.com/acme/site" }));
  const repo = await call("join_room", { name: "github.com/acme/site" });
  assert.equal(repo.success, false);
  assert.equal(repo.error, "repo_collaborator_required");
  assert.equal(repo.next_step, "ask_repo_admin");
  assert.equal(repo.room_id, "github.com/acme/site");
  assert.match(repo.message, /Ask a repository admin to add you on GitHub/);
});

test("resume_room_session answers a refusal for the saved room", async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  rememberRoom(toRoomState({ room_id: "room_secret", display_name: "Secret Room", joined_via: "join_room" }));
  shutdownRuntime();
  refusingServer(membershipRefusal);
  assertMembershipResult(await call("resume_room_session", { room_id: "room_secret" }), "resume_room_session");
});

test("wait_for_messages asks once and returns on a refusal instead of polling again", async () => {
  await withEnv({ LETAGENTS_AGENT_SESSION_BEARER: "worker-secret" }, async () => {
    rememberRoom(toRoomState({ room_id: "room_secret", display_name: "Secret Room", joined_via: "join_room" }));
    const requests = refusingServer(membershipRefusal);
    assertMembershipResult(await call("wait_for_messages", { after_message_id: "msg_1", timeout: 1000 }), "wait_for_messages", "ask_your_user");
    assert.equal(requests.filter((request) => request.path.endsWith("/messages/poll")).length, 1);
  });
});

test("a room without a repository that needs sign-in starts the device flow like a repo room", async () => {
  const unauthenticated = {
    error: "auth_required",
    code: "NOT_AUTHENTICATED",
    message: "Authentication is required",
    room_id: "room_adhoc",
  };
  for (const [name, input] of [["join_room", { name: "room_adhoc" }], ["join_code", { code: "WXYZ-9876" }]] as const) {
    clearPendingDeviceAuth();
    const requests = refusingServer(unauthenticated, 401);
    const result = await call(name, input);
    assert.equal(result.success, false, name);
    assert.equal(result.error, "auth_required", name);
    assert.equal(result.next_step, "poll_device_auth", name);
    assert.equal(result.pending_device_auth.user_code, "ABCD-EFGH", name);
    assert.equal("request_id" in result.pending_device_auth, false, `${name}: whoever polls the request id receives the token`);
    assert.match(result.message, /requires sign-in\. Device flow started/, name);
    assert.ok(requests.some((request) => request.path === "/auth/device/start"), name);
  }

  rememberRoom(toRoomState({ room_id: "room_adhoc", display_name: "Ad hoc", joined_via: "join_code" }));
  clearPendingDeviceAuth();
  refusingServer(unauthenticated, 401);
  const read = await call("read_messages", {});
  assert.equal(read.error, "auth_required");
  assert.equal(read.room_id, "room_adhoc");
});

test("a saved sign-in the room rejects starts the device flow in the same call", async () => {
  setStoredAuth({ token: "revoked-token", stored_at: new Date().toISOString(), source: "device_flow" });
  rememberRoom(toRoomState({ room_id: "room_adhoc", display_name: "Ad hoc", joined_via: "join_code" }));
  clearPendingDeviceAuth();
  const requests = refusingServer({ error: "The bearer credential is invalid or expired. Reconnect with a current credential." }, 401);
  const read = await call("read_messages", {});
  assert.equal(read.error, "auth_required", JSON.stringify(read));
  assert.equal(read.next_step, "poll_device_auth");
  assert.equal(getStoredAuth(), null);
  const start = requests.find((request) => request.path === "/auth/device/start");
  assert.ok(start, "the device flow started");
  assert.equal(start.authorization, null, "without the rejected token");
});

test("calls that meet a rejected saved token at the same time all start the device flow", async () => {
  setStoredAuth({ token: "revoked-token", stored_at: new Date().toISOString(), source: "device_flow" });
  rememberRoom(toRoomState({ room_id: "room_adhoc", display_name: "Ad hoc", joined_via: "join_code" }));
  clearPendingDeviceAuth();
  refusingServer({ error: "The bearer credential is invalid or expired. Reconnect with a current credential." }, 401);
  const results = await Promise.all([call("read_messages", {}), call("get_board", {})]);
  assert.deepEqual(results.map((result) => result.error), ["auth_required", "auth_required"], JSON.stringify(results));
});

test("initialize_repo keeps the config and gives the next step when the room refuses the auto-join", async () => {
  for (const [body, status, expected] of [
    [membershipRefusal, 403, "membership_required"],
    [{ error: "auth_required", code: "NOT_AUTHENTICATED", room_id: "room_secret" }, 401, "auth_required"],
  ] as const) {
    const repo = mkdtempSync(join(tempDir, "repo-"));
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    clearPendingDeviceAuth();
    refusingServer(body, status);
    const result = await call("initialize_repo", { cwd: repo, room: "room_secret" });
    assert.equal(result.success, true, "the config was written");
    assert.equal(result.joined, false);
    assert.equal(result.join_refused?.error, expected, JSON.stringify(result));
  }
});

test("the room stream stops on a refusal instead of reconnecting", async () => {
  let streams = 0;
  globalThis.fetch = async () => {
    streams += 1;
    return json(membershipRefusal, 403);
  };
  const client = new SseClient("http://127.0.0.1:39998");
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.at(-1)); };
  try {
    client.subscribe({ roomId: "room_secret" }, () => {});
    const subscription = (client as unknown as { subscriptions: Map<string, { promise: Promise<void> }> })
      .subscriptions.get("room_secret");
    assert.ok(subscription);
    await Promise.race([
      subscription.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("the stream kept reconnecting")), 3_000)),
    ]);
  } finally {
    console.error = originalError;
    client.unsubscribeAll();
  }
  assert.equal(streams, 1);
  assert.ok(errors.some((error) => error instanceof SseRoomAccessRefusedError));
});

test("a process connection that a members-only room refuses is let go, so a new registration holds it again", async () => {
  const opened: string[] = [];
  globalThis.fetch = async (url) => {
    opened.push(new URL(String(url)).pathname);
    return json(membershipRefusal, 403);
  };
  const now = new Date().toISOString();
  // Saved, as a registration saves it: a session the state file no longer has
  // is let go for that reason alone.
  const session = saveAgentSession({
    session_id: "session_refused",
    session_token: "token_refused",
    room_id: "room_secret",
    session_kind: "worker",
    runtime: "test",
    actor_label: "Refused | Owner | Agent",
    agent_key: "owner/refused",
    agent_instance_id: "instance_refused",
    display_name: "Refused",
    owner_label: "Owner",
    ide_label: "Agent",
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    ended_at: null,
  }, false);
  try {
    holdProcessConnection(session);
    const deadline = Date.now() + 2_000;
    while (opened.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A held connection would make this a no-op until its next retry.
    holdProcessConnection(session);
    while (opened.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(opened.length, 2, "the refused connection was released at once");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(opened.length, 2, "and not retried");
  } finally {
    releaseProcessConnection(session.session_id);
  }
});

function membershipServer(routes: {
  membership: () => Response;
  joinRequest?: () => Response;
}) {
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (path === "/auth/device/start") {
      return json({ request_id: "device_2", user_code: "WXYZ-ABCD", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    }
    if (method === "GET" && path.endsWith("/membership")) return routes.membership();
    if (method === "POST" && path.endsWith("/join-requests") && routes.joinRequest) return routes.joinRequest();
    return json({ error: "unexpected" }, 500);
  };
  return requests;
}

const state = (overrides: Record<string, unknown> = {}) => ({
  room_id: "room_secret",
  access_room_id: "room_secret",
  display_name: "Secret Room",
  managed_by: "letagents",
  member: false,
  role: null,
  join_request: null,
  ...overrides,
});

test("request_room_access asks once, then reports the pending request without asking again", async () => {
  let requested = false;
  const requests = membershipServer({
    membership: () => json(state({ join_request: requested ? pendingRequest : null })),
    joinRequest: () => {
      requested = true;
      return json({ join_request: pendingRequest }, 201);
    },
  });
  const first = await call("request_room_access", { room_id: "room_secret" });
  assert.equal(first.success, true);
  assert.equal(first.state, "pending");
  assert.equal(first.requested_now, true);
  assert.equal(first.next_step, "wait_for_room_admin");
  assert.deepEqual(first.join_request, pendingRequest);
  assert.match(first.message, /You asked to join/);

  const again = await call("request_room_access", { room_id: "room_secret" });
  assert.equal(again.state, "pending");
  assert.equal(again.requested_now, false);
  assert.deepEqual(requests, [
    "GET /rooms/room_secret/membership",
    "POST /rooms/room_secret/join-requests",
    "GET /rooms/room_secret/membership",
  ]);
});

test("request_room_access reports member, declined, cooldown, GitHub roles and old servers", async () => {
  membershipServer({ membership: () => json(state({ member: true, role: "member" })) });
  const member = await call("request_room_access", { room_id: "room_secret" });
  assert.deepEqual([member.success, member.state, member.role, member.next_step], [true, "member", "member", "join_room"]);

  const retryAfter = new Date(Date.now() + 3_600_000).toISOString();
  const declined = { ...pendingRequest, state: "declined", decided_at: "2026-11-04T09:00:00.000Z", retry_after: retryAfter };
  let requests = membershipServer({ membership: () => json(state({ join_request: declined })) });
  const refused = await call("request_room_access", { room_id: "room_secret" });
  assert.deepEqual([refused.success, refused.state, refused.retry_after, refused.next_step],
    [false, "declined", retryAfter, "wait_until_retry_after"]);
  assert.match(refused.message, new RegExp(`after ${retryAfter}`));
  assert.deepEqual(requests, ["GET /rooms/room_secret/membership"], "a declined request inside its wait is not sent again");

  membershipServer({
    membership: () => json(state()),
    joinRequest: () => json({ error: "room_join_request_cooldown", code: "ROOM_JOIN_REQUEST_COOLDOWN",
      join_request: { ...declined, retry_after: null }, retry_after: retryAfter }, 429),
  });
  const cooldown = await call("request_room_access", { room_id: "room_secret" });
  assert.deepEqual([cooldown.state, cooldown.retry_after], ["declined", retryAfter]);

  // This computer's clock runs ahead of the server's: the server's answer wins.
  const pastHere = new Date(Date.now() - 60_000).toISOString();
  membershipServer({
    membership: () => json(state()),
    joinRequest: () => json({ error: "room_join_request_cooldown", code: "ROOM_JOIN_REQUEST_COOLDOWN",
      join_request: { ...declined, retry_after: pastHere }, retry_after: pastHere }, 429),
  });
  const skewed = await call("request_room_access", { room_id: "room_secret" });
  assert.equal(skewed.next_step, "wait_until_retry_after");
  assert.match(skewed.message, /ask again with request_room_access after/, "the text says to wait, too");

  membershipServer({
    membership: () => json(state()),
    joinRequest: () => json({ error: "room_already_member", code: "ROOM_ALREADY_MEMBER" }, 409),
  });
  assert.equal((await call("request_room_access", { room_id: "room_secret" })).state, "member");

  membershipServer({
    membership: () => json(state({ join_request: { ...declined, retry_after: new Date(Date.now() - 1_000).toISOString() } })),
    joinRequest: () => json({ join_request: { ...pendingRequest, id: "jr_2" } }, 201),
  });
  const askedAgain = await call("request_room_access", { room_id: "room_secret" });
  assert.deepEqual([askedAgain.state, askedAgain.join_request.id], ["pending", "jr_2"], "after the wait it asks again");

  requests = membershipServer({ membership: () => json(state({ managed_by: "github", member: null, room_id: "github.com/acme/site" })) });
  const github = await call("request_room_access", { room_id: "github.com/acme/site" });
  assert.deepEqual([github.success, github.state, github.next_step], [false, "github_roles", "ask_repo_admin"]);
  assert.deepEqual(requests, ["GET /rooms/github.com/acme/site/membership"]);

  membershipServer({ membership: () => new Response("Cannot GET /rooms/room_secret/membership", { status: 404 }) });
  assert.equal((await call("request_room_access", { room_id: "room_secret" })).error, "room_access_requests_unsupported");

  membershipServer({ membership: () => json({ error: "Private repo access required", code: "PRIVATE_REPO_NO_ACCESS" }, 403) });
  const privateRepo = await call("request_room_access", { room_id: "github.com/acme/secret" });
  assert.deepEqual([privateRepo.state, privateRepo.next_step], ["github_roles", "ask_repo_admin"]);

  membershipServer({ membership: () => json({ error: "Room not found", code: "ROOM_NOT_FOUND" }, 404) });
  assert.equal((await call("request_room_access", { room_id: "room_missing" })).error, "room_not_found",
    "a missing room is not an old server");

  membershipServer({
    membership: () => json(state()),
    joinRequest: () => json({ error: "Too many requests", code: "RATE_LIMITED" }, 429),
  });
  assert.equal((await call("request_room_access", { room_id: "room_secret" })).error, "rate_limited");
});

test("request_room_access defaults to the room that last refused, and still works where the route is gated", async () => {
  await withEnv({ LETAGENTS_AGENT_SESSION_BEARER: "worker-secret" }, async () => {
    rememberRoom(toRoomState({ room_id: "room_open", display_name: "Open", joined_via: "join_room" }));
    refusingServer(roomMembershipRequiredBody({ room_id: "room_secret", display_name: "Secret Room", join_request: null }));
    assert.equal((await call("read_messages", { room_id: "room_secret" })).error, "membership_required");
    const disabled = await call("request_room_access", {});
    assert.equal(disabled.error, "worker_bearer_mode", "a worker credential cannot ask for the account");
  });

  const requests = membershipServer({
    membership: () => json(roomMembershipRequiredBody({ room_id: "room_secret", display_name: "Secret Room", join_request: null }), 403),
    joinRequest: () => json({ join_request: pendingRequest }, 201),
  });
  const result = await call("request_room_access", {});
  assert.equal(result.state, "pending");
  assert.equal(result.room_id, "room_secret");
  assert.deepEqual(requests, ["GET /rooms/room_secret/membership", "POST /rooms/room_secret/join-requests"]);
});

test("request_room_access with no sign-in starts the device flow", async () => {
  membershipServer({ membership: () => json({ error: "auth_required", code: "NOT_AUTHENTICATED", room_id: "room_secret" }, 401) });
  const result = await call("request_room_access", { room_id: "room_secret" });
  assert.deepEqual([result.error, result.next_step], ["auth_required", "poll_device_auth"]);
});

test("request_room_access is offered to the account's own MCP tools, not to supervised agents", () => {
  assert.ok(handlers("autonomous_mcp_worker").has("request_room_access"));
  assert.ok(handlers("interactive_desktop").has("request_room_access"));
  for (const profile of ["supervised_room_turn", "supervised_mcp_polling"] as const) {
    const names = new Set<string>();
    registerTools({ tool(name: string) { names.add(name); return {}; } } as unknown as McpServer, profile, "codex");
    assert.equal(names.has("request_room_access"), false, profile);
  }
  let schema: Record<string, unknown> | null = null;
  registerTools({
    tool(name: string, ...registration: unknown[]) {
      if (name === "request_room_access") schema = registration.at(-2) as Record<string, unknown>;
      return {};
    },
  } as unknown as McpServer, "autonomous_mcp_worker");
  assert.ok(schema && "room_id" in schema);
  assert.equal("worker_id" in schema!, false, "asking is for the account, so no worker handle is offered");
});

test("poll_device_auth keeps the new sign-in and says the auto-joined room refused it", async () => {
  writeFileSync(process.env.LETAGENTS_STATE_PATH!, JSON.stringify({
    pending_device_auth: {
      request_id: "device_3", user_code: "QQQQ-RRRR", verification_uri: "https://github.com/login/device",
      interval_seconds: 5, expires_at: new Date(Date.now() + 600_000).toISOString(),
      started_at: new Date().toISOString(), suggested_room_id: "room_secret",
    },
  }));
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/device/poll/device_3") {
      return json({ status: "authorized", letagents_token: "fresh-token", account: { id: "acct_1", login: "newcomer" } });
    }
    if (path.endsWith("/presence")) return new Response(null, { status: 204 });
    return json(membershipRefusal, 403);
  };
  const result = await call("poll_device_auth", { auto_join: true });
  assert.equal(result.success, true);
  assert.equal(result.status, "authorized");
  assert.equal(result.auto_joined_room, null);
  assert.equal(result.auto_join_refused.error, "membership_required");
  assert.equal(getStoredAuth()?.token, "fresh-token");
});
