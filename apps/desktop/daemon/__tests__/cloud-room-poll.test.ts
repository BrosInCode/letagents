import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { supervisedRoomPoll } from "../cloud-http.js";
import { SupervisedRoomAuthorizationError } from "../supervised-agent-delivery.js";

const MINUTE = 60_000;

/** How one request ends. By default it stays open for the hold it asked for and gets an empty page. */
type Step = { openMs?: number; status?: number; body?: unknown; error?: unknown; abort?: AbortController };

/** The production poll with a clock that the stubbed server moves: no test waits for a real hold. */
function harness(t: TestContext) {
  const clock = { now: 0 };
  const requests: Array<{ origin: string; timeout: number; after: string | null; authorization: string }> = [];
  const script: Step[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const timeout = Number(parsed.searchParams.get("timeout"));
    requests.push({ origin: parsed.origin, timeout, after: parsed.searchParams.get("after"),
      authorization: (init?.headers as Record<string, string>).authorization });
    const step = script.shift() ?? {};
    clock.now += step.openMs ?? timeout;
    if (step.abort) { step.abort.abort(); throw step.abort.signal.reason; }
    if (step.error) throw step.error;
    return new Response(JSON.stringify(step.body ?? { messages: [] }), { status: step.status ?? 200 });
  });
  const poll = supervisedRoomPoll({ nowMs: () => clock.now });
  const ask = (input: { observing?: boolean; apiUrl?: string; signal?: AbortSignal } = {}) => poll({
    roomId: "github.com/example/repo", apiUrl: input.apiUrl ?? "https://letagents.test", bearer: "worker-secret",
    afterMessageId: "msg_42", observing: input.observing ?? true, signal: input.signal ?? new AbortController().signal,
  });
  /** Idle polls of an observing lane; returns the holds they asked for. */
  const idle = async (count: number): Promise<number[]> => {
    const from = requests.length;
    for (let index = 0; index < count; index += 1) await ask();
    return requests.slice(from).map((request) => request.timeout);
  };
  return { clock, requests, script, ask, idle };
}

test("a lane that is not observing yet asks for the floor hold, as every poll did before", async (t) => {
  const { requests, ask } = harness(t);
  await ask({ observing: false });
  await ask({ observing: false });
  assert.deepEqual(requests.map((request) => request.timeout), [25_000, 25_000]);
  assert.deepEqual(requests[0], { origin: "https://letagents.test", timeout: 25_000, after: "msg_42", authorization: "Bearer worker-secret" });
});

test("the idle polls of an observing lane climb to 150 s and stay there", async (t) => {
  const { clock, idle } = harness(t);
  assert.deepEqual(await idle(5), [50_000, 100_000, 150_000, 150_000, 150_000]);
  const from = clock.now;
  assert.equal((await idle(12)).length, 12);
  assert.equal(clock.now - from, 30 * MINUTE, "12 requests in 30 idle minutes; 72 at the 25 s hold");
});

test("a message that arrives during a long hold is answered at once and proves the time it took", async (t) => {
  const { script, ask, idle } = harness(t);
  await idle(1);
  script.push({ openMs: 70_000, body: { messages: [{ id: "msg_43" }] } });
  assert.deepEqual(await ask(), { messages: [{ id: "msg_43" }] });
  assert.deepEqual(await idle(1), [140_000]);
});

for (const [name, cut] of [
  ["HTTP 504 from a proxy", { openMs: 60_000, status: 504 }],
  ["a closed connection", { openMs: 60_000, error: new TypeError("fetch failed") }],
  ["no answer before the poll's own deadline", { openMs: 120_000, error: new DOMException("The operation was aborted due to timeout", "TimeoutError") }],
] as const) {
  test(`a probe cut by ${name} is asked again once, with the same cursor and bearer, and nothing is thrown`, async (t) => {
    const { clock, requests, script, ask, idle } = harness(t);
    await idle(1);
    script.push(cut, { openMs: 2_000, body: { messages: [{ id: "msg_43" }] } });
    assert.deepEqual(await ask(), { messages: [{ id: "msg_43" }] }, "the caller gets the answer of the second request");
    assert.deepEqual(requests.slice(1), [
      { origin: "https://letagents.test", timeout: 100_000, after: "msg_42", authorization: "Bearer worker-secret" },
      { origin: "https://letagents.test", timeout: 50_000, after: "msg_42", authorization: "Bearer worker-secret" },
    ]);
    assert.deepEqual(await idle(3), [50_000, 50_000, 50_000], "the hold stays where the path is proven");
    clock.now += 10 * MINUTE;
    script.push(cut);
    assert.deepEqual(await idle(2), [100_000, 50_000, 50_000], "after the cool-down one probe, cut and asked again");
    clock.now += 10 * MINUTE;
    assert.deepEqual(await idle(1), [50_000], "the second cool-down is longer");
    clock.now += 10 * MINUTE;
    assert.deepEqual(await idle(2), [100_000, 150_000], "the limit is gone: the hold climbs again");
  });
}

test("a failure that a 25 s poll would have met too is thrown as before", async (t) => {
  const { requests, script, ask, idle } = harness(t);
  await idle(3);
  script.push({ openMs: 3_000, status: 503 });
  await assert.rejects(ask(), (error: unknown) => !(error instanceof SupervisedRoomAuthorizationError)
    && error instanceof Error && error.message === "Supervised room poll failed with HTTP 503.");
  script.push({ openMs: 40, error: new TypeError("fetch failed") });
  await assert.rejects(ask(), /fetch failed/);
  assert.equal(requests.length, 5, "neither failure was asked again");
  // The lane's next poll is its confirming one; the proof is untouched.
  script.push({ openMs: 30_000, status: 502 });
  await assert.rejects(ask({ observing: false }), /HTTP 502/);
  assert.deepEqual(await idle(1), [150_000]);
});

test("a proven hold that is cut early is asked again at the floor, and the hold is proven again", async (t) => {
  const { requests, script, ask, idle } = harness(t);
  await idle(3);
  // The path changed: a proxy now ends a request after 60 s.
  script.push({ openMs: 60_000, status: 504 });
  assert.deepEqual(await ask(), { messages: [] });
  assert.deepEqual(requests.slice(3).map((request) => request.timeout), [150_000, 25_000]);
  script.push({}, { openMs: 60_000, status: 504 });
  assert.deepEqual(await idle(3), [50_000, 100_000, 50_000, 50_000], "50 s is proven, the probe to 100 s is cut, 50 s stays");
});

test("a second failure is thrown: one poll asks at most twice", async (t) => {
  const { requests, script, ask, idle } = harness(t);
  await idle(1);
  script.push({ openMs: 60_000, status: 504 }, { openMs: 15, status: 502 });
  await assert.rejects(ask(), (error: unknown) => error instanceof Error && error.message === "Supervised room poll failed with HTTP 502.");
  assert.equal(requests.length, 3);
});

for (const status of [401, 403] as const) {
  test(`HTTP ${status} is a refused bearer whenever it comes: thrown, not asked again, and the hold learns nothing`, async (t) => {
    const { requests, script, ask, idle } = harness(t);
    await idle(1);
    script.push({ openMs: 70_000, status });
    await assert.rejects(ask(), (error: unknown) => error instanceof SupervisedRoomAuthorizationError && error.status === status);
    assert.equal(requests.length, 2);
    assert.deepEqual(await idle(1), [100_000]);
  });
}

test("a poll that its caller aborts is rejected with the abort and the hold learns nothing", async (t) => {
  const { requests, script, ask, idle } = harness(t);
  await idle(1);
  const stop = new AbortController();
  script.push({ openMs: 70_000, abort: stop });
  await assert.rejects(ask({ signal: stop.signal }), (error: unknown) => error === stop.signal.reason);
  assert.equal(requests.length, 2);
  assert.deepEqual(await idle(1), [100_000]);
});

test("each room server has its own hold, shared by every agent that polls it", async (t) => {
  const { requests, ask, idle } = harness(t);
  await idle(3);
  await ask({ apiUrl: "https://rooms.example" });
  assert.deepEqual(requests.at(-1), { origin: "https://rooms.example", timeout: 50_000, after: "msg_42", authorization: "Bearer worker-secret" });
  assert.deepEqual(await idle(1), [150_000]);
});
