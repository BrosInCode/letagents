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

test("a lane that is not observing yet asks for a one-second hold, so its owner is not left on Starting", async (t) => {
  const { clock, requests, ask, idle } = harness(t);
  await ask({ observing: false });
  await ask({ observing: false });
  assert.deepEqual(requests.map((request) => request.timeout), [1_000, 1_000]);
  assert.deepEqual(requests[0], { origin: "https://letagents.test", timeout: 1_000, after: "msg_42", authorization: "Bearer worker-secret" });
  assert.equal(clock.now, 2_000, "an idle room answers after the short hold, not after 25 s");
  // The short answers prove nothing about the path: the first long poll is still the 50 s probe.
  assert.deepEqual(await idle(1), [50_000]);
});

test("the idle polls of an observing lane go to 50 s in one step and stay there", async (t) => {
  const { clock, idle } = harness(t);
  assert.deepEqual(await idle(3), [50_000, 50_000, 50_000]);
  const from = clock.now;
  assert.equal((await idle(36)).length, 36);
  assert.equal(clock.now - from, 30 * MINUTE, "36 requests in 30 idle minutes; 72 at the 25 s hold");
});

test("a message that arrives during a long hold is answered at once and proves the time it took", async (t) => {
  const { script, ask, idle } = harness(t);
  script.push({ openMs: 27_000, body: { messages: [{ id: "msg_43" }] } });
  assert.deepEqual(await ask(), { messages: [{ id: "msg_43" }] });
  // The path ends a request after 30 s: the poll is asked again with the 27 s that the message proved.
  script.push({ openMs: 30_000, status: 504 });
  assert.deepEqual(await idle(1), [50_000, 27_000]);
});

for (const [name, cut] of [
  ["HTTP 504 from a proxy", { openMs: 30_000, status: 504 }],
  ["a closed connection", { openMs: 30_000, error: new TypeError("fetch failed") }],
  ["no answer before the poll's own deadline", { openMs: 70_000, error: new DOMException("The operation was aborted due to timeout", "TimeoutError") }],
] as const) {
  test(`a probe cut by ${name} is asked again once, with the same cursor and bearer, and nothing is thrown`, async (t) => {
    const { clock, requests, script, ask, idle } = harness(t);
    script.push(cut, { openMs: 2_000, body: { messages: [{ id: "msg_43" }] } });
    assert.deepEqual(await ask(), { messages: [{ id: "msg_43" }] }, "the caller gets the answer of the second request");
    assert.deepEqual(requests, [
      { origin: "https://letagents.test", timeout: 50_000, after: "msg_42", authorization: "Bearer worker-secret" },
      { origin: "https://letagents.test", timeout: 25_000, after: "msg_42", authorization: "Bearer worker-secret" },
    ]);
    assert.deepEqual(await idle(3), [25_000, 25_000, 25_000], "the hold stays where the path is proven");
    clock.now += 10 * MINUTE;
    script.push(cut);
    assert.deepEqual(await idle(2), [50_000, 25_000, 25_000], "after the cool-down one probe, cut and asked again");
    clock.now += 10 * MINUTE;
    assert.deepEqual(await idle(1), [25_000], "the second cool-down is longer");
    clock.now += 10 * MINUTE;
    assert.deepEqual(await idle(2), [50_000, 50_000], "the limit is gone: the hold reaches the target");
  });
}

test("a failure that a 25 s poll would have met too is thrown as before, and the hold learns nothing", async (t) => {
  const { requests, script, ask, idle } = harness(t);
  script.push({ openMs: 3_000, status: 503 });
  await assert.rejects(ask(), (error: unknown) => !(error instanceof SupervisedRoomAuthorizationError)
    && error instanceof Error && error.message === "Supervised room poll failed with HTTP 503.");
  script.push({ openMs: 40, error: new TypeError("fetch failed") });
  await assert.rejects(ask(), /fetch failed/);
  // The lane's next poll is its confirming one, with the short first-answer hold.
  script.push({ openMs: 30_000, status: 502 });
  await assert.rejects(ask({ observing: false }), /HTTP 502/);
  assert.deepEqual(requests.map((request) => request.timeout), [50_000, 50_000, 1_000], "no failure was asked again");
  assert.deepEqual(await idle(1), [50_000], "and no cool-down started");
  // Now 50 s is proven, and an early failure does not take the proof away:
  script.push({ openMs: 3_000, status: 503 });
  await assert.rejects(ask(), /HTTP 503/);
  // the cut that follows is the cut of a proven hold, so the poll after it probes at once.
  script.push({ openMs: 40_000, status: 504 });
  assert.deepEqual(await idle(2), [50_000, 25_000, 50_000]);
});

test("a proven hold that is cut early is asked again at the floor, and a probe that is cut too leaves the floor in place", async (t) => {
  const { requests, script, ask, idle } = harness(t);
  await idle(1);
  // The path changed: a proxy now ends a request after 40 s.
  script.push({ openMs: 40_000, status: 504 });
  assert.deepEqual(await ask(), { messages: [] });
  assert.deepEqual(requests.slice(1).map((request) => request.timeout), [50_000, 25_000]);
  script.push({ openMs: 40_000, status: 504 });
  assert.deepEqual(await idle(2), [50_000, 25_000, 25_000], "the probe to 50 s is cut and asked again, so 25 s stays");
});

test("a second failure is thrown: one poll asks at most twice", async (t) => {
  const { requests, script, ask } = harness(t);
  // A message after 30 s proves 30 s, so a poll that is asked again holds above the floor.
  script.push({ openMs: 30_000, body: { messages: [{ id: "msg_43" }] } });
  await ask();
  // Each of the two failures comes late enough to be asked again. Only the first one is.
  script.push({ openMs: 40_000, status: 504 }, { openMs: 28_000, status: 502 });
  await assert.rejects(ask(), (error: unknown) => error instanceof Error && error.message === "Supervised room poll failed with HTTP 502.");
  assert.deepEqual(requests.map((request) => request.timeout), [50_000, 50_000, 30_000]);
});

for (const status of [401, 403] as const) {
  test(`HTTP ${status} is a refused bearer whenever it comes: thrown, not asked again, and the hold learns nothing`, async (t) => {
    const { requests, script, ask, idle } = harness(t);
    script.push({ openMs: 30_000, status });
    await assert.rejects(ask(), (error: unknown) => error instanceof SupervisedRoomAuthorizationError && error.status === status);
    assert.equal(requests.length, 1);
    assert.deepEqual(await idle(1), [50_000], "a cut probe would have started a cool-down at 25 s");
  });
}

test("a poll that its caller aborts is rejected with the abort and the hold learns nothing", async (t) => {
  const { requests, script, ask, idle } = harness(t);
  const stop = new AbortController();
  script.push({ openMs: 30_000, abort: stop });
  await assert.rejects(ask({ signal: stop.signal }), (error: unknown) => error === stop.signal.reason);
  assert.equal(requests.length, 1);
  assert.deepEqual(await idle(1), [50_000], "a cut probe would have started a cool-down at 25 s");
});

test("each room server has its own hold, shared by every agent that polls it", async (t) => {
  const { requests, script, ask, idle } = harness(t);
  // The path to the first server ends a request after 30 s.
  script.push({ openMs: 30_000, status: 504 });
  assert.deepEqual(await idle(2), [50_000, 25_000, 25_000]);
  await ask({ apiUrl: "https://rooms.example" });
  assert.deepEqual(requests.at(-1), { origin: "https://rooms.example", timeout: 50_000, after: "msg_42", authorization: "Bearer worker-secret" });
  assert.deepEqual(await idle(1), [25_000]);
});

test("a local room's poll stays the 25 s request it was, and no hold is kept for it", async () => {
  const clock = { now: 0 };
  const requests: Array<{ url: string; authorization: string }> = [];
  let failNext = false;
  const poll = supervisedRoomPoll({
    nowMs: () => clock.now,
    // The local room is served in this process, not over fetch.
    request: async (url, init) => {
      requests.push({ url, authorization: (init?.headers as Record<string, string>).authorization });
      if (failNext) {
        failNext = false;
        clock.now += 90_000;
        throw new Error("local room failed");
      }
      // It reads the room again after half a second and answers, whatever hold was asked.
      clock.now += 500;
      return new Response(JSON.stringify({ room_id: "local-room", messages: [] }));
    },
  });
  const ask = (observing: boolean) => poll({
    roomId: "local-room", apiUrl: "letagents-local://rooms", bearer: "worker-secret",
    afterMessageId: "msg_7", observing, signal: new AbortController().signal,
  });
  assert.deepEqual(await ask(false), { room_id: "local-room", messages: [] });
  await ask(true);
  await ask(true);
  // For a room server this failure, after 90 s, would be learned from and asked again.
  failNext = true;
  await assert.rejects(ask(true), /local room failed/);
  await ask(true);
  assert.deepEqual(requests, Array.from({ length: 5 }, () => ({
    url: "letagents-local://rooms/rooms/local-room/messages/poll?timeout=25000&after=msg_7",
    authorization: "Bearer worker-secret",
  })));
});
