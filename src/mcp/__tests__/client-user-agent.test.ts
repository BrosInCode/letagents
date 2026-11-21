import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { letagentsUserAgent, withUserAgent } from "../../../shared/client-user-agent.mjs";
import { MCP_USER_AGENT } from "../client-identity.js";
import { SseClient } from "../sse-client.js";

test("the client User-Agent names the client, its version and the platform", () => {
  assert.equal(letagentsUserAgent("Desktop", "0.1.140", "darwin", "arm64"), "LetAgents-Desktop/0.1.140 (darwin; arm64)");
  assert.equal(letagentsUserAgent("Daemon", "2.0.283", "win32", "x64"), "LetAgents-Daemon/2.0.283 (win32; x64)");
  // A version that cannot be read is "0", and nothing a header or a log parser could misread is kept.
  assert.equal(letagentsUserAgent("MCP", "", "linux", "x64"), "LetAgents-MCP/0 (linux; x64)");
  assert.equal(letagentsUserAgent("MCP", null, "linux", "x64"), "LetAgents-MCP/0 (linux; x64)");
  assert.equal(
    letagentsUserAgent("M C\r\nP", "1.2.3-beta+4 (x)\r\nX-Evil: 1", "dar win", "arm/64"),
    "LetAgents-MCP/1.2.3-beta+4xX-Evil1 (darwin; arm64)",
  );
  assert.match(letagentsUserAgent("Desktop", "1.0.0"), /^LetAgents-Desktop\/1\.0\.0 \([A-Za-z0-9._+-]+; [A-Za-z0-9._+-]+\)$/);
});

test("withUserAgent adds the header in the caller's own header shape and keeps a chosen one", () => {
  const agent = "LetAgents-Daemon/1.0.0 (darwin; arm64)";

  const plain = { authorization: "Bearer x" };
  assert.deepEqual(withUserAgent(plain, agent), { authorization: "Bearer x", "User-Agent": agent });
  assert.deepEqual(plain, { authorization: "Bearer x" }, "the caller's object is not changed");
  assert.deepEqual(withUserAgent(undefined, agent), { "User-Agent": agent });

  const pairs: Array<[string, string]> = [["accept", "application/json"]];
  assert.deepEqual(withUserAgent(pairs, agent), [["accept", "application/json"], ["User-Agent", agent]]);
  assert.equal(pairs.length, 1);

  const headers = new Headers({ accept: "application/json" });
  const added = withUserAgent(headers, agent) as Headers;
  assert.equal(added.get("user-agent"), agent);
  assert.equal(added.get("accept"), "application/json");
  assert.equal(headers.has("user-agent"), false);

  // A caller that chose a User-Agent keeps it, whatever the case of the name.
  const chosen = { "user-agent": "custom/1" };
  assert.equal(withUserAgent(chosen, agent), chosen);
  const chosenHeaders = new Headers({ "User-Agent": "custom/1" });
  assert.equal(withUserAgent(chosenHeaders, agent), chosenHeaders);
  const chosenPairs: Array<[string, string]> = [["USER-AGENT", "custom/1"]];
  assert.equal(withUserAgent(chosenPairs, agent), chosenPairs);
});

test("the MCP client sends its package version as its User-Agent", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(MCP_USER_AGENT, letagentsUserAgent("MCP", manifest.version));
  assert.match(MCP_USER_AGENT, /^LetAgents-MCP\/\d+\.\d+\.\d+/);

  const originalFetch = globalThis.fetch;
  let seen: Headers | null = null;
  let requested!: () => void;
  const request = new Promise<void>((resolve) => { requested = resolve; });
  globalThis.fetch = (async (_input, init) => {
    seen ??= new Headers(init?.headers);
    requested();
    return new Response("", { status: 200 });
  }) as typeof fetch;
  const client = new SseClient("https://example.test", () => "token_1");
  try {
    client.subscribe({ roomId: "room_agent" }, () => undefined);
    await request;
    assert.equal(seen!.get("User-Agent"), MCP_USER_AGENT);
    assert.equal(seen!.get("Authorization"), "Bearer token_1");
  } finally {
    client.unsubscribeAll();
    globalThis.fetch = originalFetch;
  }
});
