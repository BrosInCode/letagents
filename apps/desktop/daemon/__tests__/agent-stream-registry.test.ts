import assert from "node:assert/strict";
import test from "node:test";

import { AgentStreamRegistry } from "../agent-stream-registry.js";
import type { DaemonActivityEvent } from "../types.js";

test("an unknown stream preserves the caller cursor and does not invent a generation", async () => {
  const registry = new AgentStreamRegistry();

  assert.deepEqual(await registry.watch({ entryId: "missing", afterSequence: 17, waitMs: 0 }), {
    sequence: 17,
    stream_generation: 0,
    dropped_events: 0,
    events: [],
    ended: false,
  });
});

test("push projects only inspector event fields and starts generation one", async () => {
  const registry = new AgentStreamRegistry();
  registry.push("agent", activity(91, ""));

  assert.deepEqual(await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 }), {
    sequence: 1,
    stream_generation: 1,
    dropped_events: 0,
    events: [{
      sequence: 1,
      observed_at: "2026-08-26T12:00:00.000Z",
      kind: "assistant_text_delta",
      method: "provider.stream",
      summary: null,
      payload: { index: 91 },
    }],
    ended: false,
  });
});

test("reset advances the generation and cursor boundary without replaying an older turn", async () => {
  const registry = new AgentStreamRegistry();
  registry.push("agent", activity(1));
  registry.push("agent", activity(2));
  registry.reset("agent");

  assert.deepEqual(await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 }), {
    sequence: 2,
    stream_generation: 2,
    dropped_events: 0,
    events: [],
    ended: false,
  });

  registry.push("agent", activity(3));
  const next = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.equal(next.sequence, 3);
  assert.equal(next.stream_generation, 2);
  assert.deepEqual(next.events.map((event) => event.payload), [{ index: 3 }]);

  const fresh = new AgentStreamRegistry();
  fresh.reset("agent");
  assert.equal((await fresh.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 })).stream_generation, 1);
});

test("overflow reports dropped events and a capped ended stream remains drainable", async () => {
  const registry = new AgentStreamRegistry({ bufferLimit: 3, maxBatch: 2 });
  for (let index = 1; index <= 5; index += 1) registry.push("agent", activity(index));
  registry.end("agent");

  const first = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.equal(first.sequence, 4, "cursor stops at the last delivered event, not the producer high-water mark");
  assert.equal(first.dropped_events, 2);
  assert.deepEqual(first.events.map((event) => event.sequence), [3, 4]);
  assert.equal(first.ended, false, "a capped response must drain before reporting ended");

  const second = await registry.watch({ entryId: "agent", afterSequence: first.sequence, waitMs: 0 });
  assert.equal(second.sequence, 5);
  assert.equal(second.dropped_events, 0);
  assert.deepEqual(second.events.map((event) => event.sequence), [5]);
  assert.equal(second.ended, true);

  registry.push("agent", activity(6));
  assert.deepEqual(
    (await registry.watch({ entryId: "agent", afterSequence: 5, waitMs: 0 })).events,
    [],
    "ended streams reject later events",
  );
});

test("a replacement watch releases the previous poll and the next event wakes the replacement", async () => {
  const registry = new AgentStreamRegistry();
  const firstWatch = registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 1_000 });
  const replacementWatch = registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 1_000 });

  assert.deepEqual(await firstWatch, {
    sequence: 0,
    stream_generation: 0,
    dropped_events: 0,
    events: [],
    ended: false,
  });

  registry.push("agent", activity(1));
  const replacement = await replacementWatch;
  assert.equal(replacement.sequence, 1);
  assert.deepEqual(replacement.events.map((event) => event.payload), [{ index: 1 }]);
});

test("reset and end wake a drained watch with their updated generation state", async () => {
  const registry = new AgentStreamRegistry();
  registry.push("agent", activity(1));
  await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });

  const resetWatch = registry.watch({ entryId: "agent", afterSequence: 1, waitMs: 1_000 });
  registry.reset("agent");
  const reset = await resetWatch;
  assert.equal(reset.sequence, 1);
  assert.equal(reset.stream_generation, 2);
  assert.equal(reset.ended, false);

  const endWatch = registry.watch({ entryId: "agent", afterSequence: 1, waitMs: 1_000 });
  registry.end("agent");
  const ended = await endWatch;
  assert.equal(ended.sequence, 1);
  assert.equal(ended.stream_generation, 2);
  assert.equal(ended.ended, true);
});

test("delete wakes a watcher, erases the transcript, and lets a reused id start fresh", async () => {
  const registry = new AgentStreamRegistry();
  registry.push("agent", activity(1));
  const watch = registry.watch({ entryId: "agent", afterSequence: 1, waitMs: 1_000 });

  registry.delete("agent");
  assert.deepEqual(await watch, {
    sequence: 1,
    stream_generation: 0,
    dropped_events: 0,
    events: [],
    ended: false,
  });

  registry.push("agent", activity(2));
  const recreated = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.equal(recreated.sequence, 1);
  assert.equal(recreated.stream_generation, 1);
  assert.deepEqual(recreated.events.map((event) => event.payload), [{ index: 2 }]);
});

test("watch normalizes its timeout and suppresses polling during handoff", async () => {
  let scheduled: { callback: () => void; delay: number } | null = null;
  const setFakeTimeout = ((callback: () => void, delay?: number) => {
    scheduled = { callback, delay: delay ?? 0 };
    return { fake: true } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearFakeTimeout = (() => undefined) as typeof clearTimeout;
  const registry = new AgentStreamRegistry({
    setTimeout: setFakeTimeout,
    clearTimeout: clearFakeTimeout,
  });

  const defaulted = registry.watch({ entryId: "agent", afterSequence: 0, waitMs: Number.NaN });
  assert.equal(scheduled === null ? null : scheduled.delay, 25_000);
  const defaultCallback = scheduled === null ? null : scheduled.callback;
  assert.ok(defaultCallback);
  defaultCallback();
  await defaulted;

  scheduled = null;
  const capped = registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 90_000 });
  assert.equal(scheduled === null ? null : scheduled.delay, 30_000);
  const cappedCallback = scheduled === null ? null : scheduled.callback;
  assert.ok(cappedCallback);
  cappedCallback();
  await capped;

  const handoffRegistry = new AgentStreamRegistry({
    isHandoffScheduled: () => true,
    setTimeout: (() => {
      throw new Error("handoff must not register a timer");
    }) as typeof setTimeout,
  });
  assert.deepEqual(await handoffRegistry.watch({ entryId: "agent", afterSequence: 4, waitMs: 1_000 }), {
    sequence: 4,
    stream_generation: 0,
    dropped_events: 0,
    events: [],
    ended: false,
  });
});

test("a latest value takes the place of the one before it and carries its key", async () => {
  let now = 1_000;
  const registry = new AgentStreamRegistry({ now: () => now, latestIntervalMs: 0 });
  registry.push("agent", activity(1));
  registry.pushLatest("agent", "output:call-1", activity(2));
  registry.push("agent", activity(3));
  now += 1;
  registry.pushLatest("agent", "output:call-1", activity(4));

  const batch = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.deepEqual(batch.events.map((event) => [event.sequence, event.latest_key ?? null]), [[1, null], [3, null], [4, "output:call-1"]]);
  assert.equal(batch.dropped_events, 0, "a replaced latest value is not a loss");
  assert.equal(registry.retainedAfter("agent", 0).dropped, false);
});

test("latest values are paced per key and the last value of a burst is always sent", async () => {
  let now = 0;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const registry = new AgentStreamRegistry({
    now: () => now,
    latestIntervalMs: 250,
    setTimeout: ((callback: () => void, delay?: number) => {
      timers.push({ callback, delay: delay ?? 0 });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  registry.pushLatest("agent", "output:a", activity(1));
  now = 50;
  registry.pushLatest("agent", "output:a", activity(2));
  registry.pushLatest("agent", "output:a", activity(3));
  registry.pushLatest("agent", "output:b", activity(10));

  let batch = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.deepEqual(batch.events.map((event) => (event.payload as { index: number }).index), [1, 10], "the first value of a key goes at once");
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 200, "the next value waits for the rest of the interval");

  now = 250;
  timers[0]!.callback();
  batch = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.deepEqual(batch.events.map((event) => (event.payload as { index: number }).index), [10, 3], "only the last value of the burst replaces the first");

  now = 300;
  registry.pushLatest("agent", "output:a", activity(4));
  registry.dropLatest("agent", "output:a");
  timers.at(-1)!.callback();
  batch = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.deepEqual(batch.events.map((event) => (event.payload as { index: number }).index), [10, 3], "a dropped value never arrives");

  registry.pushLatest("agent", "output:a", activity(5), { immediate: true });
  batch = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.deepEqual(batch.events.map((event) => (event.payload as { index: number }).index), [10, 5], "an immediate value skips the pace");
});

test("the size limit keeps a sticky latest value and still reports what it evicted", async () => {
  const registry = new AgentStreamRegistry({ bufferLimit: 3, latestIntervalMs: 0 });
  registry.pushLatest("agent", "background:task-1", activity(1), { sticky: true });
  for (let index = 2; index <= 6; index += 1) registry.push("agent", activity(index));

  const batch = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.deepEqual(batch.events.map((event) => event.sequence), [1, 5, 6]);
  assert.equal(batch.dropped_events, 3, "events 2, 3 and 4 were evicted; the kept background value was not");
  assert.equal(registry.retainedAfter("agent", 0).dropped, true);

  registry.pushLatest("agent", "background:task-1", activity(7), { sticky: true, immediate: true });
  const replaced = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.deepEqual(replaced.events.map((event) => event.sequence), [5, 6, 7]);
});

test("the room's read of the feed leaves out latest values, so a kept background value cannot hide an eviction", () => {
  const registry = new AgentStreamRegistry({ bufferLimit: 3, latestIntervalMs: 0 });
  registry.pushLatest("agent", "background:task-1", activity(1), { sticky: true });
  registry.push("agent", activity(2));
  registry.pushLatest("agent", "output:call-1", activity(3));
  for (let index = 4; index <= 6; index += 1) registry.push("agent", activity(index));
  const retained = registry.retainedAfter("agent", 0);
  assert.deepEqual(retained.events.map((event) => event.sequence), [5, 6], "the room window starts after the evicted events");
  assert.equal(retained.dropped, true);
});

test("reset and end cancel latest values that wait for their turn", async () => {
  const timers: Array<() => void> = [];
  const registry = new AgentStreamRegistry({
    now: () => 0,
    setTimeout: ((callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  registry.pushLatest("agent", "output:a", activity(1));
  registry.pushLatest("agent", "output:a", activity(2));
  registry.reset("agent");
  timers.forEach((callback) => callback());
  const batch = await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 });
  assert.deepEqual(batch.events, [], "a value from before the reset never arrives");
  assert.equal(batch.dropped_events, 0);
});

test("running background commands come from their newest values, and only a start or an end calls back", async () => {
  const changes: string[] = [];
  const registry = new AgentStreamRegistry({ latestIntervalMs: 0, onBackgroundCommandsChange: (entryId) => changes.push(entryId) });
  const background = (status: string, output = "") => ({ ...activity(0), method: "item/backgroundCommand/updated",
    payload: { taskId: "task-1", toolUseId: "toolu_1", command: "npm run dev", status, output, startedAt: "2026-11-08T22:00:00.000Z" } });
  registry.pushLatest("agent", "background:task-1", background("running"), { sticky: true });
  assert.deepEqual(registry.runningBackgroundCommands("agent"), [{ task_id: "task-1", tool_use_id: "toolu_1", command: "npm run dev", started_at: "2026-11-08T22:00:00.000Z" }]);
  assert.deepEqual(changes, ["agent"], "a start calls back");
  registry.pushLatest("agent", "background:task-1", background("running", "ready\n"), { sticky: true });
  assert.deepEqual(changes, ["agent"], "new output is not a change of the agent's state");

  const first = await registry.watchBackgroundCommands({ entryId: "agent", afterVersion: 0, waitMs: 0 });
  assert.equal(first.commands.length, 1);
  assert.equal((first.commands[0] as { output: string }).output, "ready\n");
  const waiting = registry.watchBackgroundCommands({ entryId: "agent", afterVersion: first.version, waitMs: 1_000 });
  registry.pushLatest("agent", "background:task-1", background("stopped"), { immediate: true });
  const after = await waiting;
  assert.ok(after.version > first.version, "a new value wakes the watch");
  assert.deepEqual(after.commands, [], "the strip reads only commands that run");
  assert.deepEqual(registry.runningBackgroundCommands("agent"), []);
  assert.deepEqual(changes, ["agent", "agent"], "an end calls back");

  registry.pushLatest("agent", "background:task-2", { ...background("running"), payload: { ...background("running").payload, taskId: "task-2" } }, { sticky: true });
  registry.end("agent");
  assert.deepEqual(registry.runningBackgroundCommands("agent"), [], "a feed that ended runs nothing");
  assert.deepEqual(changes, ["agent", "agent", "agent", "agent"]);
  assert.equal((await registry.watchBackgroundCommands({ entryId: "agent", afterVersion: 0, waitMs: 0 })).ended, true);
});

test("a running command whose end was lost ends as lost, and a real end that comes later still takes its place", async () => {
  const changes: string[] = [];
  const registry = new AgentStreamRegistry({ latestIntervalMs: 0, onBackgroundCommandsChange: (entryId) => changes.push(entryId) });
  const background = (status: string) => ({ ...activity(0), method: "item/backgroundCommand/updated",
    payload: { taskId: "task-1", toolUseId: "toolu_1", command: "npm run dev", status, output: "ready\n", exitCode: null,
      startedAt: "2026-11-08T22:00:00.000Z", endedAt: null } });
  registry.pushLatest("agent", "background:task-1", background("running"), { sticky: true });
  assert.equal(registry.endLostBackgroundCommand("agent", "unknown", "2026-11-09T16:00:00.000Z"), false, "only a command the feed shows");

  assert.equal(registry.endLostBackgroundCommand("agent", "task-1", "2026-11-09T16:00:00.000Z"), true);
  assert.deepEqual(registry.runningBackgroundCommands("agent"), [], "the row leaves the strip");
  assert.deepEqual(changes, ["agent", "agent"], "the agent's state no longer lists it");
  const feed = async () => (await registry.watch({ entryId: "agent", afterSequence: 0, waitMs: 0 })).events.filter((event) => event.latest_key === "background:task-1");
  const ended = await feed();
  assert.deepEqual(ended.map((event) => event.payload), [{ taskId: "task-1", toolUseId: "toolu_1", command: "npm run dev", status: "lost",
    output: "ready\n", exitCode: null, startedAt: "2026-11-08T22:00:00.000Z", endedAt: "2026-11-09T16:00:00.000Z" }]);
  assert.equal(registry.endLostBackgroundCommand("agent", "task-1", "2026-11-09T16:00:01.000Z"), false, "an ended command is not ended again");

  registry.pushLatest("agent", "background:task-1", background("stopped"), { immediate: true });
  assert.deepEqual((await feed()).map((event) => (event.payload as { status: string }).status), ["stopped"]);
});

test("the background watch returns a busy running command even after many commands ended, and bounds its waiters", async () => {
  let pendingTimers = 0;
  const registry = new AgentStreamRegistry({
    latestIntervalMs: 0,
    setTimeout: (() => { pendingTimers += 1; return pendingTimers as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    clearTimeout: (() => { pendingTimers -= 1; }) as typeof clearTimeout,
  });
  const background = (taskId: string, status: string) => ({ ...activity(0), method: "item/backgroundCommand/updated",
    payload: { taskId, command: `run ${taskId}`, status, output: "" } });
  registry.pushLatest("agent", "background:server", background("server", "running"), { sticky: true });
  for (let index = 0; index < 20; index += 1) registry.pushLatest("agent", `background:job-${index}`, background(`job-${index}`, "completed"), { immediate: true });
  registry.pushLatest("agent", "background:server", background("server", "running"), { sticky: true, immediate: true });
  const read = await registry.watchBackgroundCommands({ entryId: "agent", afterVersion: -1, waitMs: 0 });
  assert.deepEqual(read.commands.map((command) => (command as { taskId: string }).taskId), ["server"]);

  const waits = Array.from({ length: 10 }, () => registry.watchBackgroundCommands({ entryId: "agent", afterVersion: read.version, waitMs: 25_000 }));
  // The two oldest of ten waiting watches were released to keep eight.
  const released = await Promise.race([Promise.all(waits.slice(0, 2)), new Promise((resolve) => setImmediate(() => resolve("still waiting")))]);
  assert.notEqual(released, "still waiting");
  registry.delete("agent");
  await Promise.all(waits);
});

function activity(index: number, summary = `event-${index}`): DaemonActivityEvent {
  return {
    observed_at: "2026-08-26T12:00:00.000Z",
    sequence: index,
    provider: "codex",
    kind: "assistant_text_delta",
    method: "provider.stream",
    summary,
    status: "working",
    payload: { index },
    payload_truncated: false,
    payload_redacted: true,
    durable_payload_ref: null,
  };
}
