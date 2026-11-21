import assert from "node:assert/strict";
import test from "node:test";

import { DAEMON_USER_AGENT } from "../client-identity.js";
import { roomRequest } from "../local-room-runtime.js";
import { DAEMON_IMPLEMENTATION_VERSION } from "../types.js";

test("every daemon request to a room server names the daemon and its build", async () => {
  assert.ok(DAEMON_USER_AGENT.startsWith(`LetAgents-Daemon/${DAEMON_IMPLEMENTATION_VERSION} (`), DAEMON_USER_AGENT);

  const previous = globalThis.fetch;
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const signal = AbortSignal.timeout(5_000);
    await roomRequest("https://rooms.example.test/rooms/a/messages/poll?timeout=1", {
      headers: { authorization: "Bearer worker" },
      signal,
    });
    // The caller's headers keep their shape and values; only the User-Agent is added.
    assert.deepEqual(seen[0]!.init?.headers, { authorization: "Bearer worker", "User-Agent": DAEMON_USER_AGENT });
    assert.equal(seen[0]!.init?.signal, signal);

    await roomRequest("https://rooms.example.test/rooms/a/join", { method: "POST", body: "{}" });
    assert.deepEqual(seen[1]!.init?.headers, { "User-Agent": DAEMON_USER_AGENT });
    assert.equal(seen[1]!.init?.method, "POST");

    await roomRequest("https://rooms.example.test/rooms/a");
    assert.equal(new Headers(seen[2]!.init?.headers).get("user-agent"), DAEMON_USER_AGENT);
  } finally {
    globalThis.fetch = previous;
  }
});
