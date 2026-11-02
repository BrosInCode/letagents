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
  describeUnsupportedProviderAutoJoin,
  joinRoomIdentifier,
  joinRoomIdentifierWithoutImplicitGitRefCreate,
  normalizeJoinSessionMode,
} = await import("../server/runtime/rooms.js");
const { ApiError } = await import("../server/runtime/api.js");
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
