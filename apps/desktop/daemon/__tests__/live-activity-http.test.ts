import assert from "node:assert/strict";
import test from "node:test";
import { createLiveActivitySession, updateLiveActivitySession, withdrawLiveActivity } from "../cloud-http.js";

const target = { apiUrl: "https://letagents.test", roomId: "github.com/acme/app", bearer: "worker-only" };
const body = { summary: "Ran a shell command", live: { version: 1 } };

async function withFetch(respond: (url: string, init: RequestInit) => Response, run: (calls: Array<{ url: string; init: RequestInit }>) => Promise<void>) {
  const prior = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer worker-only");
    assert.equal(init?.redirect, "error", "the worker bearer never follows a redirect");
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = prior; }
}

test("live activity requests use the worker bearer on the room's own routes", async () => {
  await withFetch(() => new Response(JSON.stringify({ session: { id: "rs_1", kind: "live" } }), { status: 201 }), async (calls) => {
    assert.equal(await createLiveActivitySession({ ...target, body }), "rs_1");
    assert.equal(calls[0]!.url, "https://letagents.test/rooms/github.com/acme/app/reasoning-sessions");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { kind: "live", ...body });
  });
  await withFetch((url) => new Response("{}", { status: url.endsWith("/rs_gone/updates") ? 404 : 201 }), async (calls) => {
    assert.equal(await updateLiveActivitySession({ ...target, sessionId: "rs_1", body }), true);
    assert.equal(await updateLiveActivitySession({ ...target, sessionId: "rs_gone", body }), false, "a removed session is reported as gone");
    assert.equal(calls[0]!.url, "https://letagents.test/rooms/github.com/acme/app/reasoning-sessions/rs_1/updates");
  });
  await withFetch((url, init) => new Response("{}", { status: init.method === "DELETE" && url.includes("acme/old") ? 404 : 200 }), async (calls) => {
    await withdrawLiveActivity(target);
    await withdrawLiveActivity({ ...target, roomId: "github.com/acme/old" });
    assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [
      ["DELETE", "https://letagents.test/rooms/github.com/acme/app/live-activity"],
      ["DELETE", "https://letagents.test/rooms/github.com/acme/old/live-activity"],
    ], "a server without the route has nothing to remove");
  });
  // An older server refuses a worker bearer on a route it does not know: it never stored a live session.
  await withFetch(() => new Response(JSON.stringify({ error: "This worker bearer is not authorized for the requested route." }), { status: 403 }), async () => {
    await withdrawLiveActivity(target);
    await assert.rejects(createLiveActivitySession({ ...target, body }), /HTTP 403/);
  });
  // Any other refusal (the agent left a private room, for example) leaves the removal pending.
  await withFetch(() => new Response(JSON.stringify({ error: "Not a room participant." }), { status: 403 }), async () => {
    await assert.rejects(withdrawLiveActivity(target), /HTTP 403/);
  });
  await withFetch(() => new Response("{}", { status: 500 }), async () => {
    await assert.rejects(withdrawLiveActivity(target), /HTTP 500/);
  });
});

test("an older server that keeps the snapshot as a reasoning session gets it closed and is reported as unsupported", async () => {
  await withFetch((url, init) => init.method === "PATCH"
    ? new Response("{}", { status: 200 })
    : new Response(JSON.stringify({ session: { id: "rs_old" } }), { status: 201 }), async (calls) => {
    await assert.rejects(createLiveActivitySession({ ...target, body }), (error: unknown) => (error as { unsupported?: boolean }).unsupported === true);
    assert.deepEqual(calls.map((call) => call.init.method), ["POST", "PATCH"]);
    assert.equal(calls[1]!.url, "https://letagents.test/rooms/github.com/acme/app/reasoning-sessions/rs_old");
    assert.ok(Object.hasOwn(JSON.parse(String(calls[1]!.init.body)), "closed_at"));
  });
});
