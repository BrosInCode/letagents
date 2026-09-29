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
