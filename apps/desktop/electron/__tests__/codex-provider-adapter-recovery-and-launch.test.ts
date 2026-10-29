import "./isolated-home.js";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexProviderAdapter, codexMcpWorkplaceConfigOverrides } from "../main/agents/codex-provider-adapter.js";
import { CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE, writeCodexSupervisorBridgeContext } from "../main/agents/codex-supervisor-bridge-context.js";
import { ProviderContinuationMissingError } from "../main/agents/provider-adapter.js";
import { LETAGENTS_MCP_RUNTIME_VERSION } from "../main/agents/letagents-mcp-runtime.js";
import { assertProviderHandle, custodialRuntimeContract, createHarness, spawnRequest, flush } from "./codex-provider-adapter.fixture.js";
import { supervisedAgentsOnly } from "./platform.js";

test("a hard runtime failure prevents bounded room-turn dispatch across the durable callback", async () => {
  for (const failureTiming of ["before", "during-callback"] as const) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.requests.length = 0;
    const failRuntime = async () => {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
    };
    if (failureTiming === "before") await failRuntime();

    await assert.rejects(adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-${failureTiming}`,
      actionId: `action-${failureTiming}`,
      sourceMessage: {},
      activation: {},
    }, {
      beforeNativeDispatch: failureTiming === "during-callback" ? failRuntime : async () => {},
      checkpointTurnStarted: async () => {},
    }), /runtime is unavailable/);

    assert.equal(handle.observedState(), "failed");
    assert.equal(client.requests.some((request) => request.method === "turn/start"), false,
      `${failureTiming}: no native work starts after hard runtime failure`);
  }
});

test("Codex bounded room turn consumes a fast exact terminal cached before its waiter", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-fast" } });
      return { turn: { id: "turn-fast" } } as T;
    }
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-fast", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "LETAGENTS_NO_ROOM_REPLY" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  assert.deepEqual(await adapter.runRoomTurn!(handle, { inboxItemId: "inbox-fast", actionId: "action-fast", sourceMessage: {}, activation: {} }, {
    beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {},
  }), { turnId: "turn-fast", outcome: "no_reply", text: null, evidence: "transcript" });
});

test("Codex bounded room turn preserves an unreadable completed result without throwing", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-empty" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-empty", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "  " }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, { inboxItemId: "inbox-empty", actionId: "action-empty", sourceMessage: {}, activation: {} }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush(); client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-empty" } });
  assert.deepEqual(await pending, { turnId: "turn-empty", outcome: "unreadable", text: null, evidence: "none" });
});

test("Codex retains stream-only terminal evidence until the daemon durably checkpoints it", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-stream-checkpoint" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-stream-checkpoint", status: "completed" }] } } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-stream-checkpoint", actionId: "action-stream-checkpoint", sourceMessage: {}, activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {},
    checkpointTerminalResult: async () => { throw new Error("SQLite checkpoint unavailable"); },
  });
  await flush();
  client.emit({ method: "item/agentMessage/delta", params: { threadId: handle.providerContinuationId, turnId: "turn-stream-checkpoint", itemId: "answer", delta: "Retained answer" } });
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-stream-checkpoint" } });
  await assert.rejects(pending, /SQLite checkpoint unavailable/);
  let checkpointed: unknown = null;
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, {
    inboxItemId: "inbox-stream-checkpoint", providerTurnId: "turn-stream-checkpoint",
  }, {
    checkpointTerminalResult: async (result) => { checkpointed = result; },
  }), { turnId: "turn-stream-checkpoint", outcome: "reply", text: "Retained answer", evidence: "stream" });
  assert.deepEqual(checkpointed, { turnId: "turn-stream-checkpoint", outcome: "reply", text: "Retained answer", evidence: "stream" });
});

test("Codex bounded room turn does not treat a sentinel with extra text as no-reply", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-sentinel-extra" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-sentinel-extra", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "LETAGENTS_NO_ROOM_REPLY\nextra" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, { inboxItemId: "inbox-sentinel-extra", actionId: "action-sentinel-extra", sourceMessage: {}, activation: {} }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush(); client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-sentinel-extra" } });
  assert.deepEqual(await pending, { turnId: "turn-sentinel-extra", outcome: "reply", text: "LETAGENTS_NO_ROOM_REPLY\nextra", evidence: "transcript" });
});

test("Codex reports an exact missing conversation as a typed pre-turn failure", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      throw new Error(`thread not found: ${handle.providerContinuationId}`);
    }
    return originalRequest<T>(method, params);
  };
  let checkpointedTurn = false;

  await assert.rejects(
    adapter.runRoomTurn!(handle, {
      inboxItemId: "inbox-missing-thread",
      actionId: "action-missing-thread",
      sourceMessage: {},
      activation: {},
    }, {
      beforeNativeDispatch: async () => {},
      checkpointTurnStarted: async () => { checkpointedTurn = true; },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderContinuationMissingError);
      assert.equal(error.providerFailureCode, "provider_continuation_missing");
      assert.equal(error.providerContinuationId, "thread-1");
      return true;
    },
  );
  assert.equal(checkpointedTurn, false, "a missing thread never creates durable evidence that a model turn began");
  assert.equal(handle.providerContinuationId, "thread-1");
  assert.equal(handle.pid, 4100);
});

test("Codex repairs a readable-but-not-runnable conversation on the same app-server process", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const resumesBefore = client.threadResumeCounts.get("thread-1") ?? 0;
  const readsBefore = client.requests.filter((request) =>
    request.method === "thread/read"
    && (request.params as { threadId?: string } | undefined)?.threadId === "thread-1").length;
  client.markThreadMissing("thread-1");
  const checkpointed: string[] = [];

  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }, {
    checkpointReplacement: async (continuation) => {
      assert.equal(handle.providerContinuationId, "thread-1", "the live handle cannot move before the durable checkpoint");
      checkpointed.push(continuation);
    },
  });

  assert.equal(result.handle, handle, "repair retains the sole process/stream owner");
  // The result also holds the way to tell the provider that its lines are recorded. This repair has no line.
  const { noticesRecorded, ...repaired } = result;
  assert.equal(typeof noticesRecorded, "function");
  assert.deepEqual(repaired, {
    handle,
    outcome: "replaced",
    previousProviderContinuationId: "thread-1",
    replacementProviderContinuationId: "thread-1-replacement-1",
  });
  assert.deepEqual(checkpointed, ["thread-1-replacement-1"]);
  assert.deepEqual(harness.sleeps, [1_000, 2_000, 4_000], "probes occur at absolute 0s, 1s, 3s, and 7s");
  assert.equal((client.threadResumeCounts.get("thread-1") ?? 0) - resumesBefore, 4);
  assert.equal(
    client.requests.filter((request) =>
      request.method === "thread/read"
      && (request.params as { threadId?: string } | undefined)?.threadId === "thread-1").length - readsBefore,
    0,
    "metadata readability is not accepted as execution readiness",
  );
  assert.equal(client.requests.filter((request) => request.method === "thread/start").length, 2);
  assert.equal(harness.launches.length, 1, "repair must not launch another app-server");
  assert.equal(handle.pid, 4100);
  assert.deepEqual(handle.providerConnection, {
    kind: "codex_app_server",
    url: "ws://127.0.0.1:4700",
    pid: 4100,
    processIdentity: "fake-process-4100-birth-1",
  });
  assert.equal(handle.workAttemptId, spawnRequest().workAttemptId);
  assert.equal(handle.providerContinuationId, "thread-1-replacement-1");
});

test("Codex continuation repair cannot replace authority after runtime failure wins the checkpoint race", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  client.markThreadMissing("thread-1");

  await assert.rejects(adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
  }, {
    checkpointReplacement: async () => {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
    },
  }), /lost exact provider authority/);
  assert.equal(handle.observedState(), "failed");
  assert.equal(handle.providerContinuationId, "thread-1", "failed repair cannot install its replacement");
});

test("Codex reuses a conversation that materializes during the grace window", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  client.markThreadMissing("thread-1", 2);
  let checkpoints = 0;

  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
  }, {
    checkpointReplacement: async () => { checkpoints += 1; },
  });

  assert.equal(result.outcome, "rematerialized");
  assert.equal(result.replacementProviderContinuationId, "thread-1");
  assert.equal(handle.providerContinuationId, "thread-1");
  assert.deepEqual(harness.sleeps, [1_000, 2_000]);
  assert.equal(checkpoints, 0);
  assert.equal(client.requests.filter((request) => request.method === "thread/start").length, 1);
});

test("Codex force-replaces a continuation that already failed after rematerialization", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const checkpointed: string[] = [];

  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    forceReplacement: true,
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
  }, {
    checkpointReplacement: async (continuation) => { checkpointed.push(continuation); },
  });

  assert.equal(result.outcome, "replaced");
  assert.equal(result.replacementProviderContinuationId, "thread-1-replacement-1");
  assert.equal(handle.providerContinuationId, "thread-1-replacement-1");
  assert.deepEqual(checkpointed, ["thread-1-replacement-1"]);
  assert.equal(client.threadResumeCounts.get("thread-1") ?? 0, 0, "a disproven rematerialization is never probed again");
  assert.deepEqual(harness.sleeps, []);
});

test("Codex resumes a checkpointed replacement after a repair crash without creating another thread", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const checkpointed: string[] = [];

  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "thread-1",
    checkpointedReplacementProviderContinuationId: "thread-checkpointed-replacement",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: spawnRequest().launchPolicy,
  }, {
    checkpointReplacement: async (continuation) => { checkpointed.push(continuation); },
  });

  assert.equal(result.outcome, "replaced");
  assert.equal(result.replacementProviderContinuationId, "thread-checkpointed-replacement");
  assert.equal(handle.providerContinuationId, "thread-checkpointed-replacement");
  assert.deepEqual(checkpointed, ["thread-checkpointed-replacement"]);
  assert.deepEqual(harness.sleeps, []);
  assert.equal(harness.clients[0]!.requests.filter((request) => request.method === "thread/start").length, 1);
});

test("Codex room-turn recovery reattaches only the persisted exact active turn and never starts another", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-recover", status, items: [{ type: "agentMessage", phase: "final", text: "Recovered reply." }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const startsBefore = client.requests.filter((request) => request.method === "turn/start").length;
  const pending = adapter.recoverRoomTurn!(handle, { inboxItemId: "inbox-recover", providerTurnId: "turn-recover" });
  await flush();
  client.emit({ method: "turn/completed", params: { threadId: "other-thread", turnId: "turn-recover" } });
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "other-turn" } });
  await flush(); status = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-recover" } });
  assert.deepEqual(await pending, { turnId: "turn-recover", outcome: "reply", text: "Recovered reply.", evidence: "transcript" });
  assert.equal(client.requests.filter((request) => request.method === "turn/start").length, startsBefore);
});

test("Codex room-turn recovery returns already-terminal exact output without starting a turn", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-done", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Already durable." }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const startsBefore = client.requests.filter((request) => request.method === "turn/start").length;
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, { inboxItemId: "inbox-done", providerTurnId: "turn-done" }), { turnId: "turn-done", outcome: "reply", text: "Already durable.", evidence: "transcript" });
  assert.equal(client.requests.filter((request) => request.method === "turn/start").length, startsBefore);
});

test("Codex room-turn recovery treats an already-failed turn as idle runtime evidence", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.emit({ method: "turn/started", params: {
    threadId: handle.providerContinuationId,
    turnId: "turn-already-failed",
    turn: { id: "turn-already-failed", status: "inProgress" },
  } });
  await flush();
  assert.equal(handle.observedState(), "working", "the recovery assertion must prove a working-to-idle transition");
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [{ id: "turn-already-failed", status: "failed" }],
    } } as T;
    return originalRequest<T>(method, params);
  };

  assert.equal((await adapter.recoverRoomTurn!(handle, {
    inboxItemId: "inbox-already-failed", providerTurnId: "turn-already-failed",
  })).outcome, "failed");
  assert.equal(handle.observedState(), "idle");
  assert.equal(harness.launches[0]?.alive, true);
  assert.deepEqual(harness.signals, []);
});

test("a runtime failure during recovery cannot be cleared by an active or terminal turn", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
      return { thread: {
        id: handle.providerContinuationId,
        turns: [{ id: "turn-recovery-runtime-failure", status, items: [
          { type: "agentMessage", phase: "final", text: "Recovered after runtime failure." },
        ] }],
      } } as T;
    }
    return originalRequest<T>(method, params);
  };

  const pending = adapter.recoverRoomTurn!(handle, {
    inboxItemId: "inbox-recovery-runtime-failure",
    providerTurnId: "turn-recovery-runtime-failure",
  });
  await flush();
  assert.equal(handle.observedState(), "failed");
  status = "completed";
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId,
    turnId: "turn-recovery-runtime-failure",
    turn: { id: "turn-recovery-runtime-failure", status: "completed" },
  } });
  assert.deepEqual(await pending, {
    turnId: "turn-recovery-runtime-failure", outcome: "reply",
    text: "Recovered after runtime failure.", evidence: "transcript",
  });
  assert.equal(handle.observedState(), "failed");
});

test("Codex room-turn recovery rejects missing and unknown exact turns as ambiguous", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-unknown", status: "mystery" }] } } as T;
    return originalRequest<T>(method, params);
  };
  await assert.rejects(adapter.recoverRoomTurn!(handle, { inboxItemId: "missing", providerTurnId: "turn-missing" }), /cannot find/);
  await assert.rejects(adapter.recoverRoomTurn!(handle, { inboxItemId: "unknown", providerTurnId: "turn-unknown" }), /unknown exact turn state/);
});

test("Codex retirement detaches only its waiter so a successor recovers the same exact turn", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-retired" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-retired", status, items: [{ type: "agentMessage", phase: "final", text: "successor reply" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const controller = new AbortController();
  const old = adapter.runRoomTurn!(handle, { inboxItemId: "old", actionId: "old", sourceMessage: {}, activation: {} }, {
    beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {}, detachSignal: controller.signal,
  });
  await flush(); controller.abort();
  await assert.rejects(old, /observation detached/);
  const successor = adapter.recoverRoomTurn!(handle, { inboxItemId: "successor", providerTurnId: "turn-retired" });
  await flush(); status = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-retired" } });
  assert.deepEqual(await successor, { turnId: "turn-retired", outcome: "reply", text: "successor reply", evidence: "transcript" });
  assert.equal(handle.pid, 4100); assert.equal(handle.providerContinuationId, "thread-1");
  assert.equal(client.requests.filter((request) => request.method === "turn/interrupt").length, 0);
});

test("Codex caches a terminal racing observer detach for successor recovery", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-race", status, items: [{ type: "agentMessage", phase: "final", text: "raced" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const controller = new AbortController();
  const old = adapter.recoverRoomTurn!(handle, { inboxItemId: "old-race", providerTurnId: "turn-race" }, { detachSignal: controller.signal });
  await flush(); controller.abort(); await assert.rejects(old, /observation detached/);
  status = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-race" } });
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, { inboxItemId: "next-race", providerTurnId: "turn-race" }), { turnId: "turn-race", outcome: "reply", text: "raced", evidence: "transcript" });
});

test("Codex supervised launch passes only its daemon generation binding to the MCP child", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({
    supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
  }));
  assert.deepEqual(harness.launchOptions[0]?.options.env, {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: spawnRequest().workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "execution_exact",
    LETAGENTS_SUPERVISOR_PROVIDER: "codex",
    LETAGENTS_EXECUTION_PROFILE: "interactive_desktop",
  });
  assert.deepEqual(harness.supervisorBridgeContexts, [{
    cwd: "/tmp/letagents-work-attempt",
    context: {
      entry_id: "manifest_exact",
      room_id: "focus_37",
      work_attempt_id: spawnRequest().workAttemptId,
      execution_generation_id: "execution_exact",
    },
  }]);
});

test("Codex resumed bounded launch supplies only the exact non-secret worker route to the MCP bridge", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest({
    deliveryMode: "daemon_inbox",
    supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_1" },
  });
  const first = await adapter.spawn(request);
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
  }, request);
  const expectedEnvironment = {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: spawnRequest().workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "execution_exact",
    LETAGENTS_SUPERVISOR_PROVIDER: "codex",
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    LETAGENTS_TOKEN: "", LETAGENTS_AGENT_SESSION_BEARER: "", LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "",
    LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "agent_session_exact",
    LETAGENTS_SUPERVISOR_ROOM_ID: "focus_37",
    LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "LanternSparrow",
  };
  assert.deepEqual(harness.launchOptions.map((launch) => launch.options.env), [expectedEnvironment, expectedEnvironment],
    "fresh and resumed bounded app-server launches share the credential-scrubbing marker");
  const expectedBridgeContext = {
    entry_id: "manifest_exact",
    room_id: "focus_37",
    work_attempt_id: spawnRequest().workAttemptId,
    execution_generation_id: "execution_exact",
    agent_session_id: "agent_session_exact",
    agent_display_name: "LanternSparrow",
  };
  assert.deepEqual(harness.supervisorBridgeContexts.map(({ context }) => context), [expectedBridgeContext, expectedBridgeContext]);
  for (const launch of harness.launchOptions) {
    const override = launch.options.configOverrides[0]!;
    assert.ok(override.includes('command = ' + JSON.stringify(process.execPath)));
    assert.ok(override.includes('/verified/runtime/dist/mcp/server.js'));
    for (const [name, value] of Object.entries(expectedEnvironment)) {
      assert.ok(override.includes(`${JSON.stringify(name)} = ${JSON.stringify(value)}`), `${name} crosses the MCP environment filter`);
    }
    assert.ok(override.includes('"LETAGENTS_TOKEN" = ""'));
    assert.ok(override.includes('"LETAGENTS_AGENT_SESSION_BEARER" = ""'));
    assert.ok(override.includes('"LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID" = ""'));
    assert.ok(override.includes('env_vars = []'));
    assert.ok(override.includes('default_tools_approval_mode = "writes"'), "reads need no additional prompt; unmarked and write tools still do");
    for (const name of custodialRuntimeContract.profiles.cursor_supervised_room_turn.tools.filter(name => name !== "complete_room_turn")) {
      const mode = name === "set_reply_thread" ? "approve" : "writes";
      assert.ok(override.includes(`${JSON.stringify(name)} = { approval_mode = "${mode}" }`), `${name} overrides inherited native prompt/approve policies`);
    }
    assert.ok(!override.includes("complete_room_turn"), "pinned Cursor profile excludes its completion hook for Codex");
    assert.ok(override.includes(`enabled_tools = ${JSON.stringify(custodialRuntimeContract.profiles.cursor_supervised_room_turn.tools.filter((tool) => tool !== "complete_room_turn"))}, disabled_tools = []`));
  }
  assert.doesNotMatch(JSON.stringify(harness.launchOptions), /session-secret|authorization/);
});

test("Codex bounded local launch probes and configures the same exact local tool route", async () => {
  const { letAgentsRuntimeContract } = await import(new URL("../../../../src/mcp/server/runtime-contract.ts", import.meta.url).href);
  const harness = createHarness();
  let probedRoute: string | undefined;
  harness.dependencies.readMcpRuntimeContract = async (_entryPath, apiUrl) => {
    probedRoute = apiUrl; return letAgentsRuntimeContract(apiUrl);
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox",
    supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "session_exact", roomCursor: "msg_1", apiUrl: "letagents-local://rooms" },
  }));
  assert.equal(probedRoute, "letagents-local://rooms");
  const config = harness.launchOptions[0]!.options.configOverrides!.join("\n");
  const names = letAgentsRuntimeContract(probedRoute).profiles.cursor_supervised_room_turn.tools.filter((name: string) => name !== "complete_room_turn");
  assert.ok(config.includes(`enabled_tools = ${JSON.stringify(names)}`));
  assert.ok(config.includes('"LETAGENTS_API_URL" = "letagents-local://rooms"'));
  assert.doesNotMatch(config, /register_task_close_intent|join_room|get_room_memory|complete_room_turn/);
});

test("Codex bounded launches reject missing or unsafe managed MCP tool contracts before launch", async () => {
  for (const tools of [null, ["get_board"], ["claim_task", "get_board", "read_messages", "send_message", "register_agent_session"]]) {
    const harness = createHarness();
    harness.dependencies.readMcpRuntimeContract = async () => ({ format: 1, profiles: { cursor_supervised_room_turn: { tools } } });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    await assert.rejects(adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox",
      supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact",
    })), /does not support Codex supervised room tools/);
    assert.equal(harness.launchOptions.length, 0);
    assert.equal(harness.supervisorBridgeContexts.length, 0);
  }
});

test("explicit custodial activation dispatches once after intent and checkpoints its exact native ID", async () => {
  for (const scenario of ["success", "recovered", "recovered_session_mismatch", "changed_session", "wrong_receipt", "active", "unknown", "lost_ack", "bad_id", "checkpoint_failure", "detached", "legacy"] as const) {
    const harness = createHarness();
    let adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest({ configurationRevision: 4,
      pollingContract: scenario === "legacy" ? undefined : "custodial_polling_v1", deliveryMode: scenario === "legacy" ? "daemon_inbox" : "mcp_polling",
      supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact",
      supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_41", apiUrl: "https://letagents.chat" },
    });
    let handle = await adapter.spawn(request);
    assert.equal(handle.custodyLaunchAgentSessionId, scenario === "legacy" ? undefined : "agent_session_exact");
    if (scenario === "recovered" || scenario === "recovered_session_mismatch") {
      adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
      const attached = await adapter.attach({ workAttemptId: handle.workAttemptId,
        providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection!, launchPolicy: request.launchPolicy });
      assertProviderHandle(attached);
      handle = attached;
    }
    const client = harness.clients.at(-1)!;
    const original = client.request.bind(client);
    const events: string[] = [];
    let starts = 0;
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "thread/read") return { thread: { id: handle.providerContinuationId, status: "idle", turns:
        scenario === "unknown" ? undefined : scenario === "active" ? [{ id: "active", status: "inProgress" }] : [] } } as T;
      if (method === "turn/start") {
        starts++;
        events.push("rpc");
        const prompt = JSON.stringify(params);
        assert.match(prompt, /agent_session_exact/);
        assert.match(prompt, /msg_41/);
        assert.match(prompt, /before processing/);
        assert.doesNotMatch(prompt, /LOCAL_CODEX_ROOM_|join_code|Hard stop deadline/);
        if (scenario === "lost_ack") throw new Error("lost acknowledgement");
        return { turn: { id: scenario === "bad_id" ? "" : "native-activation" } } as T;
      }
      return original<T>(method, params);
    };
    const controller = new AbortController();
    const activate = adapter.activateCustodialPolling(handle, {
      operationId: "activation-1", roomId: request.roomId, cwd: request.cwd, agentDisplayName: "GardenPoint",
      workerSession: { agentSessionId: scenario === "changed_session" ? "session_rotated" : "agent_session_exact", roomCursor: "msg_41" },
      launchReceipt: { contract: "custodial_polling_v1", agentSessionId: scenario === "changed_session" || scenario === "recovered_session_mismatch" ? "session_rotated" : "agent_session_exact", configurationRevision: scenario === "wrong_receipt" ? 5 : 4, workAttemptId: handle.workAttemptId,
        providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection! },
    }, { detachSignal: controller.signal,
      beforeNativeDispatch: async () => { events.push("intent"); if (scenario === "detached") controller.abort(); },
      checkpointTurnStarted: async id => { assert.equal(id, "native-activation"); events.push("checkpoint"); if (scenario === "checkpoint_failure") throw new Error("checkpoint failed"); },
    });
    if (scenario === "success" || scenario === "recovered") {
      assert.deepEqual(await activate, { providerTurnId: "native-activation" });
      assert.deepEqual(events, ["intent", "rpc", "checkpoint"]);
    } else await assert.rejects(activate);
    assert.equal(starts, ["success", "recovered", "lost_ack", "bad_id", "checkpoint_failure"].includes(scenario) ? 1 : 0, scenario);
    if (scenario === "success") {
      for (const status of ["inProgress", "completed", "failed", "interrupted", "cancelled", "future"] as const) {
        client.request = async <T>(method: string): Promise<T> => {
          assert.equal(method, "thread/read", "inspection never starts, resumes, or interrupts");
          return { thread: { id: handle.providerContinuationId, turns: [
            { id: "native-activation", status }, { id: "latest-unrelated", status: "completed" },
          ] } } as T;
        };
        assert.deepEqual(await adapter.inspectCustodialPollingActivation(handle, "native-activation"),
          status === "inProgress" ? { state: "active" } : status === "future" ? { state: "unknown" }
            : { state: "terminal", outcome: status === "cancelled" ? "interrupted" : status });
        assert.deepEqual(await adapter.inspectCustodialPollingActivation(handle, "missing-exact"), { state: "unknown" });
      }
      client.request = async () => { throw new Error("connection lost"); };
      assert.deepEqual(await adapter.inspectCustodialPollingActivation(handle, "native-activation"), { state: "unknown" });
    }
    harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
  }
});

test("Codex custodial polling verifies its exact MCP runtime and leaves fresh and resumed threads idle", async () => {
  const harness = createHarness();
  const request = spawnRequest({
    pollingContract: "custodial_polling_v1", deliveryMode: "mcp_polling",
    supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_41", apiUrl: "https://letagents.chat" },
  });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  assert.equal(first.observedState(), "idle");
  harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  const second = await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume({
    workAttemptId: request.workAttemptId, providerContinuationId: first.providerContinuationId!,
  }, { ...request, supervisorExecutionGenerationId: "execution_successor" });
  assert.equal(second.observedState(), "idle");
  assert.equal(second.providerContinuationId, first.providerContinuationId);
  assert.deepEqual(harness.mcpRuntimeProbes, ["/verified/runtime/dist/mcp/server.js", "/verified/runtime/dist/mcp/server.js"]);
  for (const [index, launch] of harness.launchOptions.entries()) {
    assert.equal(harness.clients[index]!.requests.some((call) => call.method === "turn/start"), false);
    const env = launch.options.env!;
    assert.equal(env.LETAGENTS_EXECUTION_PROFILE, "supervised_mcp_polling");
    assert.equal(env.LETAGENTS_SUPERVISED_BOUNDED_TURNS, "");
    assert.equal(env.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID, "");
    assert.equal(env.LETAGENTS_TOKEN, "");
    assert.equal(env.LETAGENTS_AGENT_SESSION_BEARER, "");
    assert.equal(env.LETAGENTS_API_URL, "https://letagents.chat");
    assert.equal(env.LETAGENTS_SUPERVISOR_AGENT_SESSION_ID, "agent_session_exact");
    assert.equal(env.LETAGENTS_SUPERVISOR_ROOM_ID, request.roomId);
    assert.equal(env.LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID, index ? "execution_successor" : "execution_exact");
    assert.equal(launch.options.configOverrides.length, 1, "pin the MCP executable, custody coordinates and advertised tools together");
    const override = launch.options.configOverrides[0]!;
    assert.ok(override.startsWith("mcp_servers.letagents={ "));
    assert.ok(override.includes('default_tools_approval_mode = "writes"'));
    assert.ok(!override.includes('approval_mode = "approve"'), "polling never receives a bounded-control exemption");
    for (const name of custodialRuntimeContract.profiles.supervised_mcp_polling.tools) {
      assert.ok(override.includes(`${JSON.stringify(name)} = { approval_mode = "writes" }`));
    }
    assert.ok(override.includes(`command = ${JSON.stringify(process.execPath)}`));
    assert.ok(override.includes('args = ["/verified/runtime/dist/mcp/server.js"]'));
    assert.ok(override.includes("env_vars = [], enabled = true"));
    assert.ok(override.includes(`enabled_tools = ${JSON.stringify(custodialRuntimeContract.profiles.supervised_mcp_polling.tools)}, disabled_tools = []`));
    for (const [key, value] of Object.entries({ ...env, ELECTRON_RUN_AS_NODE: "1" })) {
      assert.ok(override.includes(`${JSON.stringify(key)} = ${JSON.stringify(value)}`), `exact MCP env ${key}`);
    }
    assert.doesNotMatch(override, /npx|interactive_desktop/);
  }
});

test("Codex custodial polling fails closed on old runtime contracts and incomplete authority before native launch", async () => {
  const request = spawnRequest({
    pollingContract: "custodial_polling_v1", deliveryMode: "mcp_polling",
    supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_41", apiUrl: "https://letagents.chat" },
  });
  for (const report of [
    { format: 1, profiles: { cursor_supervised_room_turn: { tools: ["complete_room_turn"] } } },
    { ...custodialRuntimeContract, format: 2 },
    { format: 1, profiles: { supervised_mcp_polling: { contract: "custodial_polling_v1", tools: ["read_messages", "send_message"] } } },
    { format: 1, profiles: { supervised_mcp_polling: { contract: "custodial_polling_v1", tools: [...custodialRuntimeContract.profiles.supervised_mcp_polling.tools, "register_agent_session"] } } },
  ]) {
    const harness = createHarness();
    harness.dependencies.readMcpRuntimeContract = async () => report;
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    await assert.rejects(adapter.preflightCustodialPolling({}), /does not support custodial_polling_v1/);
    await assert.rejects(adapter.spawn(request), /does not support custodial_polling_v1/);
    assert.deepEqual(harness.launches, []);
    assert.deepEqual(harness.signals, []);
    assert.deepEqual(harness.supervisorBridgeContexts, []);
  }
  for (const patch of [
    { deliveryMode: "daemon_inbox" as const }, { supervisorSocketPath: undefined },
    { supervisorWorkerSession: undefined },
    { supervisorWorkerSession: { ...request.supervisorWorkerSession!, apiUrl: undefined } },
    { supervisorWorkerSession: { ...request.supervisorWorkerSession!, apiUrl: "https://user:secret@example.test" } },
  ]) {
    const harness = createHarness();
    await assert.rejects(new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn({ ...request, ...patch }), /coordinates|API origin/);
    assert.deepEqual(harness.launches, []);
    assert.deepEqual(harness.mcpRuntimeProbes, []);
  }
});

test("Codex custodial polling reads the selected built executable contract without owner environment or fallback", { skip: supervisedAgentsOnly }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-codex-contract-"));
  const entry = join(directory, "dist", "mcp", "server.js");
  const previousDev = process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
  const previousToken = process.env.LETAGENTS_TOKEN;
  process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = "http://127.0.0.1:5174";
  process.env.LETAGENTS_TOKEN = "contract-probe-owner-canary";
  try {
    await mkdir(join(directory, "dist", "mcp"), { recursive: true });
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "letagents", version: LETAGENTS_MCP_RUNTIME_VERSION, type: "module" }));
    const request = spawnRequest({
      pollingContract: "custodial_polling_v1", deliveryMode: "mcp_polling", devMcpServerEntryPath: entry,
      supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock",
      supervisorExecutionGenerationId: "execution_exact",
      supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_41", apiUrl: "https://letagents.chat" },
    });
    const harness = createHarness();
    const { resolveMcpRuntime: _resolve, readMcpRuntimeContract: _read, ...nativeDependencies } = harness.dependencies;
    const adapter = new CodexProviderAdapter({ dependencies: nativeDependencies });
    await writeFile(entry, `process.stdout.write(${JSON.stringify(JSON.stringify({ format: 1, profiles: {} }))});`);
    await assert.rejects(adapter.preflightCustodialPolling({ devMcpServerEntryPath: entry }), /does not support custodial_polling_v1/);
    await assert.rejects(adapter.spawn(request), /does not support custodial_polling_v1/, "a matching package version cannot replace contract proof");
    assert.equal(harness.launches.length, 0);
    await writeFile(entry, "throw new Error('contract-probe-owner-canary');");
    await assert.rejects(adapter.preflightCustodialPolling({ devMcpServerEntryPath: entry }), (error: unknown) => error instanceof Error
      && /contract could not be read/.test(error.message) && /Exit: 1; signal: none; killed: false; elapsed: \d+ms; output: 0 bytes\./.test(error.message)
      && !error.message.includes("contract-probe-owner-canary") && !error.message.includes(entry));
    await assert.rejects(adapter.spawn(request), (error: unknown) => error instanceof Error
      && /contract could not be read/.test(error.message) && !error.message.includes("contract-probe-owner-canary"));
    for (const source of ["process.exit(1)", "process.stdout.write('not JSON')", "process.stdout.write('x'.repeat(70000))", "process.kill(process.pid, 'SIGKILL')"]) {
      await writeFile(entry, source);
      await assert.rejects(adapter.preflightCustodialPolling({ devMcpServerEntryPath: entry }), (error: unknown) =>
        error instanceof Error && !(error as Error & { transientProviderStart?: boolean }).transientProviderStart);
    }
    // A healthy child can finish while the parent's event loop is delayed.
    // Deadline cleanup must not misdiagnose its discarded output as malformed.
    for (const [completion, expected] of [
      [`process.stdout.write(${JSON.stringify(JSON.stringify(custodialRuntimeContract))})`, "deadline"],
      ["process.exit(1)", "failure"],
    ]) {
      const probeStartedFile = join(directory, "probe-started");
      const probeReleaseFile = join(directory, "probe-release");
      await rm(probeStartedFile, { force: true });
      await rm(probeReleaseFile, { force: true });
      await writeFile(entry, `import { writeFileSync, existsSync } from 'node:fs';
        writeFileSync(${JSON.stringify(probeStartedFile)}, 'started');
        const release = setInterval(() => {
          if (!existsSync(${JSON.stringify(probeReleaseFile)})) return;
          clearInterval(release);
          ${completion};
        }, 5);`);
      const delayedProbe = adapter.preflightCustodialPolling({ devMcpServerEntryPath: entry });
      const delayedProbeAssertion = assert.rejects(delayedProbe, (error: unknown) =>
        error instanceof Error && (expected === "deadline"
          ? (error as Error & { transientProviderStart?: boolean }).transientProviderStart === true
            && /deadline/.test(error.message) && !/malformed/.test(error.message)
          : !(error as Error & { transientProviderStart?: boolean }).transientProviderStart));
      const childStartDeadline = Date.now() + 5_000;
      while (!(await readFile(probeStartedFile, "utf8").catch(() => ""))) {
        assert.ok(Date.now() < childStartDeadline, "contract probe child must start before blocking its parent");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      writeFileSync(probeReleaseFile, "release");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8_200);
      await delayedProbeAssertion;
    }

    const descendantPidFile = join(directory, "probe-child.pid");
    await writeFile(entry, `import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2] });
      writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));
      setInterval(() => {}, 1000);`);
    const probeStartedAt = Date.now();
    try {
      await assert.rejects(adapter.preflightCustodialPolling({ devMcpServerEntryPath: entry }), (error: unknown) =>
        error instanceof Error && (error as Error & { transientProviderStart?: boolean }).transientProviderStart === true
        && /signal: SIGKILL/.test(error.message) && !error.message.includes(entry));
      assert.ok(Date.now() - probeStartedAt < 15_000, "inherited output pipes must not extend the eight-second probe deadline to the descendant's lifetime");
    } finally {
      const descendantPid = Number(await readFile(descendantPidFile, "utf8").catch(() => "0"));
      if (Number.isSafeInteger(descendantPid) && descendantPid > 1) {
        try { process.kill(descendantPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    // A fresh probe must actually read the repaired executable after timeout.
    await writeFile(entry, [
      "if (process.argv[2] !== '--letagents-runtime-contract' || process.env.LETAGENTS_TOKEN) process.exit(2);",
      `process.stdout.write(${JSON.stringify(JSON.stringify(custodialRuntimeContract))});`,
    ].join("\n"));
    await adapter.preflightCustodialPolling({ devMcpServerEntryPath: entry });
    assert.deepEqual(harness.launches, [], "preflight never launches a provider");
    assert.deepEqual(harness.signals, []);
    assert.deepEqual(harness.supervisorBridgeContexts, []);
    const handle = await adapter.spawn(request);
    assert.equal(handle.observedState(), "idle");
    assert.equal(harness.clients[0]!.requests.some((call) => call.method === "turn/start"), false);
    assert.ok(harness.launchOptions[0]!.options.configOverrides[0]!.includes(JSON.stringify(await realpath(entry))), "launch uses the resolver's canonical executable");
    await writeFile(entry, [
      "if (process.env.LETAGENTS_API_URL !== 'letagents-local://rooms' || process.env.LETAGENTS_TOKEN || process.env.LETAGENTS_SUPERVISOR_ENTRY_ID) process.exit(2);",
      `process.stdout.write(${JSON.stringify(JSON.stringify(custodialRuntimeContract))});`,
    ].join("\n"));
    const localHarness = createHarness();
    const { resolveMcpRuntime: _localResolve, readMcpRuntimeContract: _localRead, ...localDependencies } = localHarness.dependencies;
    const localAdapter = new CodexProviderAdapter({ dependencies: localDependencies });
    await localAdapter.spawn({ ...request, deliveryMode: "daemon_inbox", pollingContract: undefined,
      supervisorWorkerSession: { ...request.supervisorWorkerSession!, apiUrl: "letagents-local://rooms" },
    });
    assert.equal(localHarness.launches.length, 1, "credential-free contract subprocess receives the same local route as native MCP");
  } finally {
    if (previousDev === undefined) delete process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL;
    else process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL = previousDev;
    if (previousToken === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex supervised launch fails closed before app-server start when bridge coordinates are partial", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(
    adapter.spawn(spawnRequest({ supervisorEntryId: "manifest_exact" })),
    /coordinates are incomplete/,
  );
  assert.deepEqual(harness.supervisorBridgeContexts, []);
  assert.deepEqual(harness.launchOptions, []);
});

test("Codex supervisor bridge context is owner-only, atomic, and contains no worker credential", { skip: supervisedAgentsOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-supervisor-context-"));
  try {
    const base = {
      entry_id: "manifest_exact",
      room_id: "focus_37",
      work_attempt_id: spawnRequest().workAttemptId,
    };
    await writeCodexSupervisorBridgeContext(root, { ...base, execution_generation_id: "generation_first" });
    await writeCodexSupervisorBridgeContext(root, { ...base, execution_generation_id: "generation_resumed" });

    const path = join(root, CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE);
    const encoded = await readFile(path, "utf8");
    assert.equal(JSON.parse(encoded).execution_generation_id, "generation_resumed");
    assert.doesNotMatch(encoded, /session_token|session-secret|authorization/i);
    assert.doesNotMatch(encoded, /socket_path/, "repo-controlled context cannot select the credential transport");
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), [CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE], "atomic rewrite leaves no temporary context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex dev MCP entry override adds exact command/args/cwd overrides when devMcpServerEntryPath is supplied", { skip: supervisedAgentsOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-dev-mcp-entry-"));
  try {
    const quotedDirectory = join(root, 'path with spaces and "quotes"');
    await mkdir(quotedDirectory);
    const entryPath = join(quotedDirectory, "server.js");
    await writeFile(entryPath, "// stub");
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    await adapter.spawn(spawnRequest({ devMcpServerEntryPath: entryPath }));
    assert.deepEqual(harness.launchOptions[0]?.options.configOverrides, [
      ...codexMcpWorkplaceConfigOverrides(spawnRequest().cwd),
      `mcp_servers.letagents.command=${JSON.stringify("node")}`,
      `mcp_servers.letagents.args=${JSON.stringify([entryPath])}`,
    ]);
    assert.equal(
      harness.launchOptions[0]?.options.configOverrides.some((value) =>
        /token|authorization|bearer|password/i.test(value),
      ),
      false,
      "dev entry override must not inject any credential",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex dev MCP entry override fails closed for relative, missing, and non-file inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-dev-mcp-invalid-"));
  try {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: "relative/path/server.js" })),
      /must be absolute/,
      "relative path must fail closed",
    );
    assert.deepEqual(harness.launchOptions, [], "no app-server launch on relative path");

    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: join(root, "nonexistent.js") })),
      /does not exist/,
      "missing file must fail closed",
    );

    const dirPath = join(root, "subdir");
    await mkdir(dirPath);
    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: dirPath })),
      /must be a regular built file/,
      "directory must fail closed",
    );

    const symlinkTarget = join(root, "target.js");
    await writeFile(symlinkTarget, "// target");
    const symlinkPath = join(root, "link.js");
    await symlink(symlinkTarget, symlinkPath);
    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: symlinkPath })),
      /must be a regular built file/,
      "symlink must fail closed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex dev MCP entry is absent by default and does not affect the baseline cwd-only override", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest());
  assert.deepEqual(
    harness.launchOptions[0]?.options.configOverrides,
    codexMcpWorkplaceConfigOverrides(spawnRequest().cwd),
    "baseline spawn must produce only the cwd override",
  );
});
