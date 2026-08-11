import assert from "node:assert/strict";
import test from "node:test";

import { CodexTurnLifecycleObserver } from "../main/agents/codex-turn-lifecycle.js";

test("Codex lifecycle observer retains a terminal edge that races waiter setup", async () => {
  const observer = new CodexTurnLifecycleObserver();
  observer.observe({
    method: "turn/completed",
    params: { threadId: "thread_1", turnId: "turn_1" },
  });

  assert.deepEqual(await observer.waitForTurn("thread_1", "turn_1", 5), {
    kind: "terminal",
    status: "completed",
  });
});

test("Codex lifecycle observer correlates activity and terminal edges exactly", async () => {
  const observer = new CodexTurnLifecycleObserver();
  const activity = observer.waitForTurn("thread_1", "turn_1", 50);
  observer.observe({
    method: "item/started",
    params: { threadId: "thread_1", turnId: "turn_1", item: { id: "item_1" } },
  });
  assert.deepEqual(await activity, { kind: "activity" });

  const terminal = observer.waitForTurn("thread_1", "turn_1", 50);
  observer.observe({
    method: "turn/completed",
    params: { threadId: "other_thread", turnId: "turn_1" },
  });
  observer.observe({
    method: "turn/interrupted",
    params: { threadId: "thread_1", turnId: "turn_1" },
  });
  assert.deepEqual(await terminal, { kind: "terminal", status: "interrupted" });
});

test("Codex lifecycle observer has a bounded watchdog and connection-loss settlement", async () => {
  const watchdogObserver = new CodexTurnLifecycleObserver();
  assert.deepEqual(await watchdogObserver.waitForTurn("thread_1", "turn_1", 5), {
    kind: "watchdog",
  });

  const disconnectedObserver = new CodexTurnLifecycleObserver();
  const pending = disconnectedObserver.waitForTurn("thread_1", "turn_1", 50);
  disconnectedObserver.notifyDisconnect();
  assert.deepEqual(await pending, { kind: "disconnect" });
  assert.deepEqual(await disconnectedObserver.waitForTurn("thread_1", "turn_2", 50), {
    kind: "disconnect",
  });
});
