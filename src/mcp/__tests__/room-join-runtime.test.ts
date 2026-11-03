import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RoomState } from "../server/runtime/room-state.js";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-room-join-runtime-"));
process.env.LETAGENTS_API_URL = "http://127.0.0.1:39999";
process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
process.env.LETAGENTS_CHAT_STORAGE = "cloud";
delete process.env.LETAGENTS_TOKEN;

const originalFetch = globalThis.fetch;
const {
  autoJoinFromContext,
  buildJoinResponse,
  createInviteRoom,
  describeUnsupportedProviderAutoJoin,
  joinRoomIdentifier,
  joinRoomIdentifierWithoutImplicitGitRefCreate,
  normalizeJoinSessionMode,
} = await import("../server/runtime/rooms.js");
const { ApiError } = await import("../server/runtime/api.js");
const { ensureLocalWorkerAgentSession, requireWorkerAgentSession } = await import("../server/runtime/agent-sessions.js");
const { shutdownRuntime } = await import("../server/runtime/room-state.js");

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

test.afterEach(() => {
  shutdownRuntime();
});

test("a join with session_mode live fails with the 0.12.46 removal message, and current is the only mode", () => {
  assert.throws(() => normalizeJoinSessionMode("live"), /session_mode 'live' was removed in letagents 0\.12\.46/);
  assert.throws(() => normalizeJoinSessionMode(" LIVE "), /removed/);
  for (const value of [undefined, null, "", "current", "CURRENT"]) {
    assert.equal(normalizeJoinSessionMode(value), "current");
  }
  assert.throws(() => normalizeJoinSessionMode("foo"), /Unknown session_mode 'foo'\. Use 'current'/);
});

test("a current join answers with the room and starts no local agent process", async () => {
  const room: RoomState = {
    room_id: "room_current",
    project_id: null,
    code: "ROOM-CURRENT",
    display_name: "Current Room",
    joined_via: "join_room",
    joined_at: "2026-06-30T00:00:00.000Z",
    last_seen_at: "2026-06-30T00:00:00.000Z",
  };

  const response = await buildJoinResponse({
    joined: {
      room,
      response: { room_id: room.room_id, display_name: room.display_name },
    },
    room_identifier: "focus_28",
    joined_via: "join_room",
    session_mode: "current",
  });

  assert.equal(response.room_id, "room_current");
  assert.equal(response.session_mode, "current");
  for (const removed of ["local_codex_session", "local_codex_session_started", "local_codex_session_reused"]) {
    assert.equal(removed in response, false, removed);
  }
});

const CONTROLLER_ONLY_NEXT_STEP =
  "You joined as this account's controller and can read the room. To post as an agent, call register_agent_session "
  + "with this room_id and a random registration_key generated once for this chat, keep the returned worker_id, "
  + "and pass worker_id to send_message, send_thread_message and wait_for_messages.";

function joinedRoom(roomId: string): RoomState {
  return {
    room_id: roomId,
    project_id: null,
    code: null,
    display_name: roomId,
    joined_via: "join_room",
    joined_at: "2026-06-30T00:00:00.000Z",
    last_seen_at: "2026-06-30T00:00:00.000Z",
  };
}

function joinResponseFor(roomId: string): Promise<Record<string, unknown>> {
  return buildJoinResponse({
    joined: { room: joinedRoom(roomId), response: { room_id: roomId, display_name: roomId } },
    room_identifier: roomId,
    joined_via: "join_room",
    session_mode: "current",
  });
}

async function withEnv<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("a join response says the chat is a controller until it registers a worker", async () => {
  const response = await joinResponseFor("room_controller_only");

  assert.equal(response.worker_status, "controller_only");
  assert.equal(response.next_step, CONTROLLER_ONLY_NEXT_STEP);
  // The fields that were there before stay as they were.
  assert.equal(response.room_id, "room_controller_only");
  assert.equal(response.joined_via, "join_room");
  assert.equal(response.session_mode, "current");
  assert.equal(response.agent_prompt_kind, "join");
  assert.ok(response.agent_identity);
});

test("a join response adds no controller note once this chat holds a worker for the room", async () => {
  await ensureLocalWorkerAgentSession("room_with_worker", { sessionKind: "worker" });

  const response = await joinResponseFor("room_with_worker");

  assert.equal("worker_status" in response, false);
  assert.equal("next_step" in response, false);
  assert.equal(response.room_id, "room_with_worker");
});

test("a controller session does not count as a worker in the join response", async () => {
  await ensureLocalWorkerAgentSession("room_with_controller", { sessionKind: "controller" });

  const response = await joinResponseFor("room_with_controller");

  assert.equal(response.worker_status, "controller_only");
});

test("a join response adds no controller note where a worker identity is already supplied", async () => {
  // A worker bearer is a server-side worker session for this process.
  const workerBearer = await withEnv("LETAGENTS_AGENT_SESSION_BEARER", "worker-bearer-test", () =>
    joinResponseFor("room_worker_bearer")
  );
  assert.equal("worker_status" in workerBearer, false);
  assert.equal("next_step" in workerBearer, false);

  // A local room starts its local worker on the first write.
  const localRoom = await withEnv("LETAGENTS_CHAT_STORAGE", "local", () => joinResponseFor("room_local_storage"));
  assert.equal("worker_status" in localRoom, false);
  assert.equal("next_step" in localRoom, false);
});

test("a created room says the chat is a controller until it registers a worker", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ id: "proj_created", code: "ABCD-1234", display_name: "Created room" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const created = await createInviteRoom();

  assert.equal(created.room.room_id, "ABCD-1234");
  assert.equal(created.response.room_id, "ABCD-1234");
  assert.equal(created.response.worker_status, "controller_only");
  assert.equal(created.response.next_step, CONTROLLER_ONLY_NEXT_STEP);
  assert.ok(created.response.agent_identity);
});

test("the missing-worker error names worker_id first and keeps agent_session_id as the older spelling", () => {
  assert.throws(
    () => requireWorkerAgentSession("room_no_worker", null),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "A registered worker identity is required for this write action. "
          + "Call register_agent_session for this room first (room_id plus a random registration_key), "
          + "then pass the returned worker_id to this tool. Older clients may pass agent_session_id instead."
      );
      assert.ok(error.message.indexOf("worker_id") < error.message.indexOf("agent_session_id"));
      return true;
    }
  );
});

test("a controller session is refused for a write action with a message about worker identity", async () => {
  const controller = await ensureLocalWorkerAgentSession("room_refuse_controller", { sessionKind: "controller" });

  assert.throws(
    () => requireWorkerAgentSession("room_refuse_controller", controller.session_id),
    /A worker identity \(not a controller\) is required for this write action\./
  );
});

test("joinRoomIdentifier can request an existing-only room join", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method,
    });
    return new Response(JSON.stringify({
      room_id: "focus_37",
      display_name: "Branch: codex",
      git_room: {
        provider: "github",
        ref: { type: "branch", name: "codex" },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const joined = await joinRoomIdentifier(
    "github.com/brosincode/letagents/focus/git:branch:Y29kZXg",
    "git-remote",
    { allowCreate: false }
  );

  assert.equal(
    calls[0]?.url,
    "http://127.0.0.1:39999/rooms/github.com/brosincode/letagents/focus/git%3Abranch%3AY29kZXg/join?create=false"
  );
  assert.equal(calls[0]?.method, "POST");
  assert.equal(joined.room.room_id, "focus_37");
  assert.equal(joined.room.joined_via, "git-remote");
});

test("existing-only joins do not fall back to legacy room creation on 404", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "Room not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };

  await assert.rejects(
    joinRoomIdentifier(
      "github.com/brosincode/letagents/focus/git:branch:bWlzc2luZw",
      "git-remote",
      { allowCreate: false }
    ),
    /API error 404/
  );

  assert.deepEqual(calls, [
    "http://127.0.0.1:39999/rooms/github.com/brosincode/letagents/focus/git%3Abranch%3AbWlzc2luZw/join?create=false",
  ]);
});

test("contextual git ref joins use existing-only room joins", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method,
    });
    return new Response(JSON.stringify({
      room_id: "focus_38",
      display_name: "Branch: feature",
      git_room: {
        provider: "github",
        ref: { type: "branch", name: "feature" },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const joined = await joinRoomIdentifierWithoutImplicitGitRefCreate(
    "github.com/brosincode/letagents/focus/git:branch:ZmVhdHVyZQ",
    "git-remote"
  );

  assert.equal(
    calls[0]?.url,
    "http://127.0.0.1:39999/rooms/github.com/brosincode/letagents/focus/git%3Abranch%3AZmVhdHVyZQ/join?create=false"
  );
  assert.equal(calls[0]?.method, "POST");
  assert.equal(joined.room.room_id, "focus_38");
});

test("missing contextual git ref joins reject without room creation when fallback is disabled", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "Room not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };

  await assert.rejects(
    joinRoomIdentifierWithoutImplicitGitRefCreate(
      "github.com/brosincode/letagents/focus/git:branch:bWlzc2luZw",
      "git-remote"
    ),
    /ROOM_NOT_FOUND/
  );

  assert.deepEqual(calls, [
    "http://127.0.0.1:39999/rooms/github.com/brosincode/letagents/focus/git%3Abranch%3AbWlzc2luZw/join?create=false",
  ]);
});

test("missing contextual git ref joins can fall back to the repo room", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method,
    });
    const requestUrl = String(url);
    if (requestUrl.includes("branch%3AbWlzc2luZw/join?create=false")) {
      return new Response(JSON.stringify({ error: "Room not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      room_id: "github.com/brosincode/letagents",
      display_name: "BrosInCode/letagents",
      git_room: {
        provider: "github",
        repository: { full_name: "BrosInCode/letagents" },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const joined = await joinRoomIdentifierWithoutImplicitGitRefCreate(
    "github.com/brosincode/letagents/focus/git:branch:bWlzc2luZw",
    "git-remote",
    { fallbackToRepo: true }
  );

  assert.deepEqual(
    calls.slice(0, 2).map((call) => call.url),
    [
      "http://127.0.0.1:39999/rooms/github.com/brosincode/letagents/focus/git%3Abranch%3AbWlzc2luZw/join?create=false",
      "http://127.0.0.1:39999/rooms/github.com/brosincode/letagents/join",
    ]
  );
  assert.equal(calls[1]?.method, "POST");
  assert.equal(joined.room.room_id, "github.com/brosincode/letagents");
});

test("non-generated room joins keep normal create-capable behavior", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method,
    });
    return new Response(JSON.stringify({
      room_id: "focus_27",
      display_name: "focus_27",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const joined = await joinRoomIdentifierWithoutImplicitGitRefCreate(
    "focus_27",
    "join_room"
  );

  assert.equal(calls[0]?.url, "http://127.0.0.1:39999/rooms/focus_27/join");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(joined.room.room_id, "focus_27");
});

function unsupportedProviderError(roomId: string): InstanceType<typeof ApiError> {
  return new ApiError(403, JSON.stringify({
    error: "unsupported_repo_provider",
    code: "UNSUPPORTED_REPO_PROVIDER",
    message: "Repo rooms are supported for github.com repositories only",
    room_id: roomId,
  }));
}

test("the auto-join failure for an unsupported provider names the host and the .letagents.json workaround", () => {
  const fromRemote = describeUnsupportedProviderAutoJoin(
    unsupportedProviderError("github-work/acme/app"),
    "git-remote"
  );
  assert.ok(fromRemote);
  assert.match(fromRemote, /Auto-join failed/);
  assert.match(fromRemote, /host 'github-work'/);
  assert.match(fromRemote, /from the git remote/);
  assert.match(fromRemote, /not a supported provider/);
  assert.match(fromRemote, /\.letagents\.json file with a room field/);
  assert.match(fromRemote, /"room": "github\.com\/owner\/repo"/);

  const fromConfig = describeUnsupportedProviderAutoJoin(
    unsupportedProviderError("gitlab.com/team/project"),
    "config"
  );
  assert.ok(fromConfig);
  assert.match(fromConfig, /host 'gitlab\.com'/);
  assert.match(fromConfig, /room field in \.letagents\.json/);
  assert.match(fromConfig, /not a supported provider/);
});

test("the unsupported-provider message ignores every other auto-join failure", () => {
  assert.equal(describeUnsupportedProviderAutoJoin(new Error("boom"), "git-remote"), null);
  assert.equal(describeUnsupportedProviderAutoJoin(new ApiError(500, "oops"), "git-remote"), null);
  assert.equal(
    describeUnsupportedProviderAutoJoin(
      new ApiError(403, JSON.stringify({ code: "PRIVATE_REPO_NO_ACCESS", room_id: "github.com/o/r" })),
      "git-remote"
    ),
    null
  );
  assert.equal(
    describeUnsupportedProviderAutoJoin(
      new ApiError(401, JSON.stringify({ code: "UNSUPPORTED_REPO_PROVIDER", room_id: "x/y/z" })),
      "git-remote"
    ),
    null
  );
});

async function autoJoinWithRemote(remote: string, respond: (url: string) => Response): Promise<{
  requestedUrls: string[];
  logged: string[];
}> {
  const originalCwd = process.cwd();
  const originalConsoleError = console.error;
  const repoDir = mkdtempSync(join(tmpdir(), "letagents-auto-join-remote-"));
  const requestedUrls: string[] = [];
  const logged: string[] = [];
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repoDir });
    process.chdir(repoDir);

    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return respond(String(url));
    };
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };

    await autoJoinFromContext();
  } finally {
    console.error = originalConsoleError;
    process.chdir(originalCwd);
    rmSync(repoDir, { recursive: true, force: true });
  }
  return { requestedUrls, logged };
}

test("auto-join from a git remote that uses an SSH config alias reports the unsupported provider", async () => {
  const { requestedUrls, logged } = await autoJoinWithRemote(
    "git@github-work:acme/app.git",
    () => new Response(JSON.stringify({
      error: "unsupported_repo_provider",
      code: "UNSUPPORTED_REPO_PROVIDER",
      message: "Repo rooms are supported for github.com repositories only",
      room_id: "github-work/acme/app",
    }), { status: 403, headers: { "Content-Type": "application/json" } })
  );

  assert.deepEqual(requestedUrls, ["http://127.0.0.1:39999/rooms/github-work/acme/app/join"]);
  assert.equal(logged.length, 1, logged.join("\n"));
  assert.match(logged[0], /host 'github-work'/);
  assert.match(logged[0], /not a supported provider/);
  assert.match(logged[0], /\.letagents\.json file with a room field/);
  assert.doesNotMatch(logged[0], /API error 403/);
});

test("auto-join through ssh.github.com:443 asks for the real github.com room", async () => {
  const { requestedUrls } = await autoJoinWithRemote(
    "ssh://git@ssh.github.com:443/BrosInCode/LetAgents.git",
    () => new Response(JSON.stringify({
      room_id: "github.com/brosincode/letagents",
      display_name: "BrosInCode/letagents",
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  );

  assert.equal(requestedUrls[0], "http://127.0.0.1:39999/rooms/github.com/brosincode/letagents/join");
});
