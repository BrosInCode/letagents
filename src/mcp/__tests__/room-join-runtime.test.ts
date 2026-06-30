import assert from "node:assert/strict";
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
  buildJoinResponse,
  joinRoomIdentifier,
  joinRoomIdentifierWithoutImplicitGitRefCreate,
} = await import("../server/runtime/rooms.js");
const {
  registerManagedAgentProvider,
  resetManagedAgentProvidersForTest,
} = await import("../managed-agent-providers.js");

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

test.afterEach(() => {
  resetManagedAgentProvidersForTest();
});

test("live joins dispatch through the default managed-agent provider while preserving Codex fields", async () => {
  const calls: Array<Record<string, unknown>> = [];
  registerManagedAgentProvider(
    {
      id: "codex",
      displayName: "Codex",
      responseKeys: {
        localSession: "local_codex_session",
        localSessionStarted: "local_codex_session_started",
        localSessionReused: "local_codex_session_reused",
      },
      getCurrentLiveSessionPayload: () => null,
      startLocalSession: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return {
          session: {
            session_id: "session_live",
            room_id: input.room_id,
            room_identifier: input.room_identifier,
            cwd: input.cwd,
          },
          reused: false,
        };
      },
      inspectLocalSession: async () => null,
      stopLocalSession: async () => null,
      toPublicLiveSession: (session) => session as Record<string, unknown>,
    },
    { replace: true, setDefault: true }
  );

  const room: RoomState = {
    room_id: "room_live",
    project_id: null,
    code: "ROOM-LIVE",
    display_name: "Live Room",
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
    session_mode: "live",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.room_id, "room_live");
  assert.equal(calls[0]?.room_identifier, "focus_28");
  assert.equal(calls[0]?.room_code, "ROOM-LIVE");
  assert.equal(calls[0]?.room_display_name, "Live Room");
  assert.equal(calls[0]?.joined_via, "join_room");
  assert.equal(calls[0]?.cwd, process.cwd());
  assert.deepEqual(response.local_codex_session, {
    session_id: "session_live",
    room_id: "room_live",
    room_identifier: "focus_28",
    cwd: process.cwd(),
  });
  assert.equal(response.local_codex_session_started, true);
  assert.equal(response.local_codex_session_reused, false);
});

test("joinRoomIdentifier can request an existing-only room join", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method,
    });
    return new Response(JSON.stringify({
      room_id: "git-room:github.com:brosincode/letagents:branch:Y29kZXg",
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
    "git-room:github.com:brosincode/letagents:branch:Y29kZXg",
    "git-remote",
    { allowCreate: false }
  );

  assert.equal(
    calls[0]?.url,
    "http://127.0.0.1:39999/rooms/git-room%3Agithub.com%3Abrosincode/letagents%3Abranch%3AY29kZXg/join?create=false"
  );
  assert.equal(calls[0]?.method, "POST");
  assert.equal(joined.room.room_id, "git-room:github.com:brosincode/letagents:branch:Y29kZXg");
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
      "git-room:github.com:brosincode/letagents:branch:bWlzc2luZw",
      "git-remote",
      { allowCreate: false }
    ),
    /API error 404/
  );

  assert.deepEqual(calls, [
    "http://127.0.0.1:39999/rooms/git-room%3Agithub.com%3Abrosincode/letagents%3Abranch%3AbWlzc2luZw/join?create=false",
  ]);
});

test("generated git ref joins use existing-only room joins", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method,
    });
    return new Response(JSON.stringify({
      room_id: "git-room:github.com:brosincode/letagents:branch:ZmVhdHVyZQ",
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
    "git-room:github.com:brosincode/letagents:branch:ZmVhdHVyZQ",
    "git-remote"
  );

  assert.equal(
    calls[0]?.url,
    "http://127.0.0.1:39999/rooms/git-room%3Agithub.com%3Abrosincode/letagents%3Abranch%3AZmVhdHVyZQ/join?create=false"
  );
  assert.equal(calls[0]?.method, "POST");
  assert.equal(joined.room.room_id, "git-room:github.com:brosincode/letagents:branch:ZmVhdHVyZQ");
});

test("missing generated git ref joins reject without legacy creation when fallback is disabled", async () => {
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
      "git-room:github.com:brosincode/letagents:branch:bWlzc2luZw",
      "git-remote"
    ),
    /ROOM_NOT_FOUND/
  );

  assert.deepEqual(calls, [
    "http://127.0.0.1:39999/rooms/git-room%3Agithub.com%3Abrosincode/letagents%3Abranch%3AbWlzc2luZw/join?create=false",
  ]);
});

test("missing generated git ref joins can fall back to the repo room", async () => {
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
    "git-room:github.com:brosincode/letagents:branch:bWlzc2luZw",
    "git-remote",
    { fallbackToRepo: true }
  );

  assert.deepEqual(
    calls.slice(0, 2).map((call) => call.url),
    [
      "http://127.0.0.1:39999/rooms/git-room%3Agithub.com%3Abrosincode/letagents%3Abranch%3AbWlzc2luZw/join?create=false",
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
