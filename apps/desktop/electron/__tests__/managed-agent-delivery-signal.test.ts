import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS,
  DESKTOP_DELIVERY_SIGNAL_MAX_BACKOFF_MS,
  DESKTOP_DELIVERY_SIGNAL_MAX_TRANSIENT_FAILURES,
  DESKTOP_DELIVERY_PAUSE_REPAIR_MS,
  createDesktopDeliverySignalGuard,
  createDesktopDeliverySignalLane,
  isTerminalDesktopDeliverySignalStatus,
} from "../main/agents/managed-agent-delivery-signal.js";

const SESSION = "agent_session_claude";

test("a fresh session may send immediately", () => {
  const guard = createDesktopDeliverySignalGuard();
  assert.deepEqual(guard.beforeSend(SESSION, 0), { action: "send" });
});

test("a 404 is terminal: the session never signals again (the pause-spam bug)", () => {
  const guard = createDesktopDeliverySignalGuard();

  // The very first failing response the production storm saw was a 404.
  assert.equal(guard.recordFailure(SESSION, 404, 0).terminal, true);
  assert.equal(guard.isTerminal(SESSION), true);

  // Every subsequent attempt — including the ~8/second the worker used to fire —
  // is refused, no matter how far the clock advances.
  for (const now of [0, 1, 125, 1_000, 60_000, 86_400_000]) {
    assert.deepEqual(guard.beforeSend(SESSION, now), { action: "skip", reason: "terminal" });
  }
});

test("410 Gone is also terminal", () => {
  const guard = createDesktopDeliverySignalGuard();
  assert.equal(guard.recordFailure(SESSION, 410, 0).terminal, true);
  assert.deepEqual(guard.beforeSend(SESSION, 999_999), { action: "skip", reason: "terminal" });
});

test("transient failures back off exponentially instead of hammering", () => {
  const guard = createDesktopDeliverySignalGuard();

  // First transient failure (null status ~ network error) → base backoff.
  assert.equal(guard.recordFailure(SESSION, null, 0).terminal, false);
  assert.deepEqual(guard.beforeSend(SESSION, 0), { action: "skip", reason: "backoff" });
  assert.deepEqual(guard.beforeSend(SESSION, DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS - 1), {
    action: "skip",
    reason: "backoff",
  });
  // Once the window elapses the caller may retry.
  assert.deepEqual(guard.beforeSend(SESSION, DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS), { action: "send" });

  // Second failure doubles the delay.
  assert.equal(guard.recordFailure(SESSION, 503, DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS).terminal, false);
  const secondReady = DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS + DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS * 2;
  assert.deepEqual(guard.beforeSend(SESSION, secondReady - 1), { action: "skip", reason: "backoff" });
  assert.deepEqual(guard.beforeSend(SESSION, secondReady), { action: "send" });
});

test("backoff is capped and the run gives up after the failure cap", () => {
  const guard = createDesktopDeliverySignalGuard();
  let now = 0;
  let lastTerminal = false;
  // Feed exactly the cap's worth of transient failures.
  for (let attempt = 1; attempt <= DESKTOP_DELIVERY_SIGNAL_MAX_TRANSIENT_FAILURES; attempt += 1) {
    lastTerminal = guard.recordFailure(SESSION, 500, now).terminal;
    now += DESKTOP_DELIVERY_SIGNAL_MAX_BACKOFF_MS; // always retry as late as allowed
  }
  // The final failure crosses the cap and becomes terminal — no infinite retry.
  assert.equal(lastTerminal, true);
  assert.deepEqual(guard.beforeSend(SESSION, now), { action: "skip", reason: "terminal" });
});

test("backoff never exceeds the ceiling", () => {
  const guard = createDesktopDeliverySignalGuard();
  // Drive up to one below the give-up cap so the entry stays non-terminal.
  let now = 0;
  for (let attempt = 1; attempt < DESKTOP_DELIVERY_SIGNAL_MAX_TRANSIENT_FAILURES; attempt += 1) {
    guard.recordFailure(SESSION, 500, now);
    now += DESKTOP_DELIVERY_SIGNAL_MAX_BACKOFF_MS;
  }
  // Even after many doublings, one max-backoff step is always enough to retry.
  assert.deepEqual(guard.beforeSend(SESSION, now), { action: "send" });
});

test("a success clears backoff bookkeeping", () => {
  const guard = createDesktopDeliverySignalGuard();
  guard.recordFailure(SESSION, 503, 0);
  assert.deepEqual(guard.beforeSend(SESSION, 0), { action: "skip", reason: "backoff" });
  guard.recordSuccess(SESSION);
  assert.deepEqual(guard.beforeSend(SESSION, 0), { action: "send" });
});

test("an acknowledged pause is edge-triggered until the session resumes", () => {
  const guard = createDesktopDeliverySignalGuard();
  const acknowledgedAt = Date.now();
  assert.deepEqual(guard.beforeStateChange(SESSION, "room_closed", acknowledgedAt), { action: "send" });
  guard.recordSuccess(SESSION, "room_closed", acknowledgedAt);
  assert.deepEqual(guard.beforeStateChange(SESSION, "room_closed", acknowledgedAt + 30_000), {
    action: "skip",
    reason: "unchanged",
  });
  assert.deepEqual(
    guard.beforeStateChange(SESSION, "room_closed", acknowledgedAt + DESKTOP_DELIVERY_PAUSE_REPAIR_MS),
    { action: "send" },
    "a slow repair signal confirms the paused state without 30-second write churn",
  );

  // The active heartbeat is deliberately not state-deduplicated: it renews
  // durable liveness and also acknowledges the resume edge.
  guard.recordSuccess(SESSION);
  assert.deepEqual(guard.beforeStateChange(SESSION, "room_closed", acknowledgedAt + 60_000), { action: "send" });
});

test("a failed pause remains retryable because only acknowledged states are deduplicated", () => {
  const guard = createDesktopDeliverySignalGuard();
  assert.deepEqual(guard.beforeStateChange(SESSION, "room_closed", 0), { action: "send" });
  guard.recordFailure(SESSION, 503, 0);
  assert.deepEqual(guard.beforeStateChange(SESSION, "room_closed", 0), {
    action: "skip",
    reason: "backoff",
  });
  assert.deepEqual(
    guard.beforeStateChange(SESSION, "room_closed", DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS),
    { action: "send" },
  );
});

test("a resume waits behind an on-wire pause and stale pause completion cannot mutate resumed state", async () => {
  const lane = createDesktopDeliverySignalLane();
  const pauseGeneration = lane.advance();
  let releasePause!: () => void;
  const pauseGate = new Promise<void>((resolve) => { releasePause = resolve; });
  let pauseStarted!: () => void;
  const pauseStart = new Promise<void>((resolve) => { pauseStarted = resolve; });
  const effects: string[] = [];
  const pause = lane.run(pauseGeneration, "room_closed", async (isCurrent) => {
    pauseStarted();
    await pauseGate;
    if (isCurrent()) effects.push("pause:ack");
  });
  await pauseStart;

  const resumeGeneration = lane.advance();
  const resume = lane.run(resumeGeneration, "active", async (isCurrent) => {
    effects.push("resume:wire");
    if (isCurrent()) effects.push("resume:ack");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(effects, [], "the resume cannot overtake the server-side pause mutation");

  releasePause();
  await Promise.all([pause, resume]);
  assert.deepEqual(effects, ["resume:wire", "resume:ack"]);
});

test("a stale 404 cannot terminate a resumed generation", async () => {
  const lane = createDesktopDeliverySignalLane();
  const pauseGeneration = lane.advance();
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  let failureStarted!: () => void;
  const failureStart = new Promise<void>((resolve) => { failureStarted = resolve; });
  let terminal = false;
  const pause = lane.run(pauseGeneration, "room_closed", async (isCurrent) => {
    failureStarted();
    await failureGate;
    if (isCurrent()) terminal = true;
  });
  await failureStart;

  const resumeGeneration = lane.advance();
  const resume = lane.run(resumeGeneration, "active", async () => undefined);
  releaseFailure();
  await Promise.all([pause, resume]);
  assert.equal(terminal, false);
});

test("concurrent ticks coalesce one identical signal request", async () => {
  const lane = createDesktopDeliverySignalLane();
  const generation = lane.advance();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = () => lane.run(generation, "room_closed", async () => {
    calls += 1;
    await gate;
  });
  const first = send();
  const second = send();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
});

test("reset lets a resumed session signal again after a terminal stop", () => {
  const guard = createDesktopDeliverySignalGuard();
  guard.recordFailure(SESSION, 404, 0);
  assert.equal(guard.isTerminal(SESSION), true);
  guard.reset(SESSION);
  assert.equal(guard.isTerminal(SESSION), false);
  assert.deepEqual(guard.beforeSend(SESSION, 0), { action: "send" });
});

test("failure bookkeeping is isolated per session", () => {
  const guard = createDesktopDeliverySignalGuard();
  guard.recordFailure("session_a", 404, 0);
  assert.deepEqual(guard.beforeSend("session_a", 0), { action: "skip", reason: "terminal" });
  assert.deepEqual(guard.beforeSend("session_b", 0), { action: "send" });
});

test("terminal status classification", () => {
  assert.equal(isTerminalDesktopDeliverySignalStatus(404), true);
  assert.equal(isTerminalDesktopDeliverySignalStatus(410), true);
  assert.equal(isTerminalDesktopDeliverySignalStatus(500), false);
  assert.equal(isTerminalDesktopDeliverySignalStatus(401), false);
  assert.equal(isTerminalDesktopDeliverySignalStatus(null), false);
});
