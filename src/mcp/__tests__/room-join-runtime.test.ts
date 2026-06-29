import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-room-join-runtime-"));
process.env.LETAGENTS_API_URL = "http://127.0.0.1:39999";
process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
process.env.LETAGENTS_CHAT_STORAGE = "cloud";
delete process.env.LETAGENTS_TOKEN;

const originalFetch = globalThis.fetch;
const {
  joinRoomIdentifier,
  joinRoomIdentifierWithoutImplicitGitRefCreate,
} = await import("../server/runtime/rooms.js");

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
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
