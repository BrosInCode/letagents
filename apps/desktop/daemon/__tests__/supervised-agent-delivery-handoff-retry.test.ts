import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { type ProviderActionHandle, type ProviderActionPort } from "../provider-action-port.js";
import { SupervisorDaemon } from "../main.js";
import { ManifestStore } from "../manifest-store.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import {
  agent,
  currentAuthority,
  provider,
  deferred,
  waitForAsync,
  installCursorCompletionProjectionFixture,
  daemonRequest,
  installExactTestProviderBirth,
  enqueue,
  ingest,
} from "./helpers/supervised-agent-delivery-fixture.js";
import { testDaemonEndpoint } from "./helpers/daemon-fixture.js";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";

test("SupervisorDaemon stop fences and drains its production-owned delivery before releasing stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-delivery-drain-"));
  let daemon: SupervisorDaemon | null = null;
  try {
    const entered = deferred<void>(); const release = deferred<{ messages: Array<Record<string, unknown>> }>(); let aborted = false;
    daemon = new SupervisorDaemon({
      lockPath: join(root, "daemon.lock"), ...testDaemonEndpoint(root), manifestPath: join(root, "manifest.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    }, "darwin", provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), false, 60_000, undefined, {}, {
      poll: ({ signal }) => new Promise((resolve) => {
        entered.resolve(); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); release.promise.then(resolve);
      }),
      publish: async () => { throw new Error("must not publish"); },
    });
    const internals = daemon as unknown as {
      putManifestEntry(entry: Record<string, unknown>): Promise<void>;
      startSupervisedDelivery(entryId: string): Promise<void>;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      store: ManifestStore;
      manifestGeneration: number;
      providerStreams: {
        install(
          entryId: string,
          handle: ProviderActionHandle,
          executionGenerationId: string,
          mayStartDelivery: () => boolean,
        ): Promise<void>;
      };
    };
    await daemon.start();
    await internals.putManifestEntry({
      id: "stone", room_id: "room", display_name: "Stone", provider: "codex", model: null, charter: "supervised test", desired_state: "running", observed_state: "working", condition: "none", permission_profile_id: null,
      delivery_mode: "daemon_inbox",
      created_by: "test", created_at: new Date().toISOString(), workspace_path: root, work_attempt_id: "attempt",
      provider_ref: { work_attempt_id: "attempt", provider_continuation_id: "thread", provider_connection: agent.providerConnection, execution_generation_id: "generation-1" },
    });
    const exactHandle = { ...agent.handle, appliedConfigurationRevision: 1 };
    await installExactTestProviderBirth(internals, "stone", exactHandle, "generation-1");
    await internals.workerBindings.bind({ entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "generation-1", agent_session_id: "session-1", agent_session_token: "memory", api_url: "https://letagents.test" });
    void internals.startSupervisedDelivery("stone"); await entered.promise;
    let stopped = false; const stopping = daemon.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(aborted, true, "stop fences the live delivery before closing worker storage");
    assert.equal(stopped, false, "stop waits for the in-flight poll to settle");
    release.resolve({ messages: [] });
    await stopping;
    daemon = null;
  } finally {
    await daemon?.stop().catch(() => undefined);
    await removeTestDirectory(root);
  }
});

test("SupervisorDaemon stop detaches an unresolved provider turn without retaining the daemon", async () => {
  // Keep the Unix-socket path below macOS's short sockaddr_un limit.
  const root = await mkdtemp(join(tmpdir(), "la-sud-"));
  let daemon: SupervisorDaemon | null = null;
  const late = deferred<{ turnId: string; outcome: "reply"; text: string }>();
  try {
    const entered = deferred<void>(); let published = 0; let providerStops = 0;
    const port = provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("turn:daemon-stop-live");
      entered.resolve();
      return late.promise;
    });
    (port as unknown as { stop: ProviderActionPort["stop"] }).stop = async () => {
      providerStops += 1;
      return { endedAt: "", exitCode: null, signal: null, terminalCause: "stopped", providerContinuationId: null };
    };
    const paths = {
      lockPath: join(root, "daemon.lock"), ...testDaemonEndpoint(root), manifestPath: join(root, "manifest.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    };
    daemon = new SupervisorDaemon(paths, "darwin", port, false, 60_000, undefined, {}, {
      poll: async () => ({}), publish: async () => { published += 1; },
    });
    const internals = daemon as unknown as {
      putManifestEntry(entry: Record<string, unknown>): Promise<void>;
      liveHandles: Map<string, typeof agent.handle>;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      supervisedInbox: SupervisedAgentInboxStore;
      supervisedDelivery: SupervisedAgentDelivery;
    };
    await daemon.start();
    await internals.putManifestEntry({
      id: agent.agentId, room_id: agent.roomId, display_name: "Stone", provider: agent.provider, model: null, charter: "test", desired_state: "running", observed_state: "working", condition: "none", permission_profile_id: null,
      delivery_mode: "daemon_inbox",
      created_by: "test", created_at: new Date().toISOString(), work_attempt_id: agent.handle.workAttemptId,
      provider_ref: { work_attempt_id: agent.handle.workAttemptId, provider_continuation_id: agent.handle.providerContinuationId, provider_connection: agent.providerConnection, execution_generation_id: agent.executionGenerationId },
    });
    internals.liveHandles.set(agent.agentId, agent.handle);
    await internals.workerBindings.bind({ entry_id: agent.agentId, room_id: agent.roomId, work_attempt_id: agent.handle.workAttemptId, execution_generation_id: agent.executionGenerationId, agent_session_id: agent.agentSessionId, agent_session_token: agent.bearer, api_url: agent.apiUrl });
    await internals.supervisedDelivery.pump(agent); await ingest(internals.supervisedInbox);
    void internals.supervisedDelivery.pump(agent); await entered.promise;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        daemon.stop(),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("daemon stop did not retire the provider await within one second")), 1_000); }),
      ]);
      daemon = null;
    } finally { if (timeout) clearTimeout(timeout); }
    assert.equal(providerStops, 0);
    late.resolve({ turnId: "late", outcome: "reply", text: "must not publish" });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(published, 0, "late provider output is fenced after daemon return");
  } finally {
    late.resolve({ turnId: "cleanup", outcome: "reply", text: "cleanup" });
    await daemon?.stop().catch(() => undefined);
    await removeTestDirectory(root);
  }
});

test("handoff during a provider turn drains it and prevents post-turn publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-turn-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "reply"; text: string }>(); let published = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { entered.resolve(); return release.promise; }), { poll: async () => ({}), publish: async () => { published += 1; } }, currentAuthority);
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise;
    const drain = delivery.fenceAndDrain(); release.resolve({ turnId: "turn", outcome: "reply", text: "late" });
    await drain; await pump;
    assert.equal(published, 0);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching");
    await store.close();
  } finally { await removeTestDirectory(root); }
});

test("handoff drains a non-Cursor turn through its late exact checkpoint and the successor recovers it", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-late-turn-checkpoint-"));
  const lateResult = deferred<{ turnId: string; outcome: "no_reply"; text: null }>();
  const authorityCheckEntered = deferred<void>();
  const releaseAuthorityCheck = deferred<void>();
  let pauseAuthorityCheck = false;
  let store: SupervisedAgentInboxStore | undefined;
  let retiring: SupervisedAgentDelivery | undefined;
  let successor: SupervisedAgentDelivery | undefined;
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const claudeAgent = { ...agent, provider: "claude-code" };
    retiring = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      pauseAuthorityCheck = true;
      await options?.checkpointTurnStarted?.("claude:late-durable-turn");
      return lateResult.promise;
    }), {
      poll: async () => ({}),
      publish: async () => { throw new Error("must not publish"); },
    }, async () => {
      if (pauseAuthorityCheck) {
        authorityCheckEntered.resolve();
        await releaseAuthorityCheck.promise;
      }
      return true;
    });
    await retiring.pump(claudeAgent);
    await ingest(store);
    const pump = retiring.pump(claudeAgent);
    await authorityCheckEntered.promise;

    let drained = false;
    const drain = retiring.fenceAndDrain().then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false, "retirement waits while the admitted provider turn has no durable recovery key");

    releaseAuthorityCheck.resolve();
    await Promise.all([drain, pump]);
    const interrupted = (await store.receipts(claudeAgent.agentId))[0]!;
    assert.equal(interrupted.state, "dispatching");
    assert.equal(interrupted.provider_turn_id, "claude:late-durable-turn");
    await store.normalizeStartupRecovery(claudeAgent.agentId);
    assert.equal((await store.receipts(claudeAgent.agentId))[0]?.state, "pending");

    const recoveredTurns: string[] = [];
    successor = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("the successor must not redispatch a new model turn"); },
      async (_handle, request) => {
        recoveredTurns.push(request.providerTurnId);
        return { turnId: request.providerTurnId, outcome: "no_reply", text: null };
      },
    ), {
      poll: async () => ({}),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    await successor.pump(claudeAgent);
    assert.deepEqual(recoveredTurns, ["claude:late-durable-turn"]);
    assert.equal((await store.receipts(claudeAgent.agentId))[0]?.state, "acknowledged_no_reply");
  } finally {
    releaseAuthorityCheck.resolve();
    lateResult.resolve({ turnId: "claude:late-durable-turn", outcome: "no_reply", text: null });
    await successor?.fenceAndDrain().catch(() => undefined);
    await retiring?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await removeTestDirectory(root);
  }
});

test("handoff waits for pre-native provider cleanup before releasing the delivery drain", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-pre-native-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const cursorAgent = { ...agent, provider: "cursor" };
    const entered = deferred<void>();
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      entered.resolve();
      await new Promise<void>((resolve) => {
        const detach = () => {
          cleanupStarted.resolve();
          void releaseCleanup.promise.then(resolve);
        };
        if (options?.detachSignal?.aborted) detach();
        else options?.detachSignal?.addEventListener("abort", detach, { once: true });
      });
      throw Object.assign(
        new Error("pre-native provider cleanup completed after handoff"),
        { roomTurnRecoveryOutcome: "not_dispatched" as const },
      );
    }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(cursorAgent); await ingest(store);
    const pump = delivery.pump(cursorAgent); await entered.promise;

    let drained = false;
    const drain = delivery.fenceAndDrain().then(() => { drained = true; });
    await cleanupStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false, "handoff cannot release authority while pre-native cleanup is incomplete");

    releaseCleanup.resolve();
    await drain; await pump;
    assert.equal(
      (await store.receipts(cursorAgent.agentId))[0]?.state,
      "pending",
      "proven-not-dispatched handoff cleanup returns the FIFO head to pending",
    );
    await store.close();
  } finally { await removeTestDirectory(root); }
});

test("Cursor Stop and handoff retain an atomically prepared turn until idle compensation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-prepared-retirement-"));
  try {
    for (const retirement of ["stop", "handoff"] as const) {
      const store = new SupervisedAgentInboxStore(join(root, `${retirement}.sqlite`));
      const recordCompletion = installCursorCompletionProjectionFixture(store);
      let continuation = `cursor-pending:${retirement}`;
      let connection = { kind: "cursor_cli" as const, pid: null as number | null, processIdentity: null as string | null };
      const cursorAgent = {
        ...agent,
        provider: "cursor",
        providerContinuationId: continuation,
        providerConnection: connection,
        handle: {
          workAttemptId: agent.workAttemptId,
          get pid() { return connection.pid; },
          get providerContinuationId() { return continuation; },
          get providerConnection() { return connection; },
          observedState: "idle" as const,
        },
      };
      const prepared = deferred<void>();
      const exactTurnId = `cursor:prepared:${retirement}`;
      const retiring = new SupervisedAgentDelivery(
        store,
        provider(async (_handle, _request, options) => {
          await options?.beforeNativeDispatch?.();
          connection = { kind: "cursor_cli", pid: retirement === "stop" ? 91_001 : 91_002, processIdentity: `wrapper:${retirement}` };
          await options?.checkpointPreparedTurn?.({
            providerTurnId: exactTurnId,
            providerContinuationId: continuation,
            providerConnection: connection,
          });
          prepared.resolve();
          await new Promise<void>((resolve) => {
            const abort = () => resolve();
            if (options?.detachSignal?.aborted) abort();
            else options?.detachSignal?.addEventListener("abort", abort, { once: true });
          });
          connection = { kind: "cursor_cli", pid: null, processIdentity: null };
          throw Object.assign(new Error("prepared wrapper reaped before native release"), {
            roomTurnRecoveryOutcome: "not_dispatched" as const,
          });
        }),
        { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } },
        currentAuthority,
        0,
        async () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async ({ agent: activeAgent, inboxItemId, providerTurnId, providerConnection }) => {
          await store.checkpointTurnStarted(inboxItemId, providerTurnId, {
            work_attempt_id: activeAgent.workAttemptId,
            origin_execution_generation_id: activeAgent.executionGenerationId,
            provider_continuation_id: activeAgent.providerContinuationId!,
          });
          activeAgent.providerConnection = providerConnection;
        },
      );
      await retiring.pump(cursorAgent);
      await ingest(store);
      const pump = retiring.pump(cursorAgent);
      await prepared.promise;
      await Promise.all([
        retirement === "stop" ? retiring.stop(cursorAgent.agentId) : retiring.fenceAndDrain(),
        pump,
      ]);

      const retained = (await store.receipts(cursorAgent.agentId))[0]!;
      assert.equal(retained.state, "dispatching");
      assert.equal(
        retained.provider_turn_id,
        exactTurnId,
        "retirement cannot tear the exact turn away from its committed wrapper identity",
      );

      let recoveries = 0;
      let redispatches = 0;
      const successor = new SupervisedAgentDelivery(
        store,
        provider(
          async (_handle, _request, options) => {
            redispatches += 1;
            await options?.beforeNativeDispatch?.();
            await options?.checkpointTurnStarted?.(`cursor:redispatched:${retirement}`);
            options?.markDurableTurnStarted?.();
            const providerTurnId = `cursor:redispatched:${retirement}`;
            recordCompletion(providerTurnId, { outcome: "no_reply" });
            const raw = { turnId: providerTurnId, outcome: "no_reply" as const, text: null };
            return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
          },
          async () => {
            recoveries += 1;
            throw Object.assign(new Error("durable wrapper journal proves no native dispatch"), {
              roomTurnRecoveryOutcome: "not_dispatched" as const,
            });
          },
        ),
        { poll: async () => ({}), publish: async () => { throw new Error("no reply must not publish"); } },
        currentAuthority,
        0,
        async () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        async ({ agent: activeAgent, providerContinuationId, providerConnection }) => {
          activeAgent.providerContinuationId = providerContinuationId;
          activeAgent.providerConnection = providerConnection;
        },
      );
      await successor.pump(cursorAgent);
      const settled = (await store.receipts(cursorAgent.agentId))[0]!;
      assert.equal(recoveries, 1, "the successor inspects the retained exact turn before any redispatch");
      assert.equal(redispatches, 1, "only proven-not-dispatched recovery admits a fresh turn");
      assert.equal(settled.state, "acknowledged_no_reply");
      assert.equal(settled.provider_turn_id, `cursor:redispatched:${retirement}`);
      await successor.fenceAndDrain();
      await store.close();
    }
  } finally { await removeTestDirectory(root); }
});

test("Cursor handoff restores a claimed FIFO head when retirement wins before provider entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-pre-entry-handoff-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const cursorAgent = { ...agent, provider: "cursor" };
    let providerTurns = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      providerTurns += 1;
      throw new Error("provider must not be entered after clean retirement");
    }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(cursorAgent); await ingest(store);
    const observedContext = store.observedContext.bind(store);
    const contextEntered = deferred<void>();
    const releaseContext = deferred<void>();
    (store as unknown as {
      observedContext(agentId: string, roomId: string, limit?: number): ReturnType<typeof store.observedContext>;
    }).observedContext = async (agentId, roomId, limit) => {
      contextEntered.resolve();
      await releaseContext.promise;
      return observedContext(agentId, roomId, limit);
    };

    const pump = delivery.pump(cursorAgent);
    await contextEntered.promise;
    const drain = delivery.fenceAndDrain();
    releaseContext.resolve();
    await drain; await pump;

    assert.equal(providerTurns, 0);
    assert.equal(
      (await store.receipts(cursorAgent.agentId))[0]?.state,
      "pending",
      "a clean pre-entry handoff cannot leave a no-turn dispatching claim",
    );
    await store.close();
  } finally { await removeTestDirectory(root); }
});

test("Cursor handoff restores an evidence-free pre-native retry backoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-retry-handoff-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const cursorAgent = { ...agent, provider: "cursor" };
    const retryEntered = deferred<void>();
    const releaseRetry = deferred<void>();
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      throw new Error("Cursor preflight failed before a wrapper existed");
    }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 50, async () => {
      retryEntered.resolve();
      await releaseRetry.promise;
    });
    await delivery.pump(cursorAgent); await ingest(store);
    const pump = delivery.pump(cursorAgent);
    await retryEntered.promise;
    assert.equal((await store.receipts(cursorAgent.agentId))[0]?.state, "retryable");

    const drain = delivery.fenceAndDrain();
    releaseRetry.resolve();
    await drain; await pump;

    assert.equal(
      (await store.receipts(cursorAgent.agentId))[0]?.state,
      "pending",
      "clean retirement during pre-native backoff cannot become a blocked startup ambiguity",
    );
    await store.close();
  } finally { await removeTestDirectory(root); }
});

test("Cursor handoff detaches immediately after the exact durable wrapper milestone", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-durable-detach-"));
  let late: ReturnType<typeof deferred<{ turnId: string; outcome: "reply"; text: string }>> | null = null;
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const cursorAgent = { ...agent, provider: "cursor" };
    const entered = deferred<void>();
    late = deferred<{ turnId: string; outcome: "reply"; text: string }>();
    let published = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("cursor:durable-wrapper");
      options?.markDurableTurnStarted?.();
      entered.resolve();
      return late!.promise;
    }), { poll: async () => ({}), publish: async () => { published += 1; } }, currentAuthority);
    await delivery.pump(cursorAgent); await ingest(store);
    const pump = delivery.pump(cursorAgent); await entered.promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivery.fenceAndDrain(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("durable Cursor turn retained the retiring daemon")),
            1_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.equal((await store.receipts(cursorAgent.agentId))[0]?.provider_turn_id, "cursor:durable-wrapper");
    assert.equal(published, 0);

    late.resolve({ turnId: "cursor:durable-wrapper", outcome: "reply", text: "must not publish" });
    await pump;
    assert.equal(published, 0);
    await store.close();
  } finally {
    late?.resolve({ turnId: "cursor:durable-wrapper", outcome: "reply", text: "cleanup" });
    await removeTestDirectory(root);
  }
});

test("handoff retires an unresolved provider turn without stopping it, and late settlement cannot commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-unresolved-turn-"));
  let store: SupervisedAgentInboxStore | null = null;
  let delivery: SupervisedAgentDelivery | null = null;
  let late: ReturnType<typeof deferred<{ turnId: string; outcome: "reply"; text: string }>> | null = null;
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); late = deferred<{ turnId: string; outcome: "reply"; text: string }>();
    let providerStops = 0; let published = 0;
    const port = provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("turn:unresolved-live");
      entered.resolve();
      return late!.promise;
    });
    (port as unknown as { stop: ProviderActionPort["stop"] }).stop = async () => {
      providerStops += 1;
      return { endedAt: "", exitCode: null, signal: null, terminalCause: "stopped", providerContinuationId: null };
    };
    delivery = new SupervisedAgentDelivery(store, port, {
      poll: async () => ({}), publish: async () => { published += 1; },
    }, currentAuthority);
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivery.fenceAndDrain(),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("handoff did not retire the provider await within one second")), 1_000); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
    assert.equal(providerStops, 0, "retirement never stops or interrupts the provider process");
    assert.equal((await store.receipts(agent.agentId))[0]?.provider_turn_id, "turn:unresolved-live");
    late.resolve({ turnId: "late", outcome: "reply", text: "must not publish" });
    await pump;
    await Promise.resolve();
    assert.equal(published, 0, "a late provider resolution cannot publish after authority retirement");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", "a late result cannot checkpoint or acknowledge");
    await store.close(); store = null;
    let newTurns = 0; const recoveredTurns: string[] = [];
    const reopened = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const successor = new SupervisedAgentDelivery(reopened, provider(
      async () => {
        newTurns += 1;
        throw new Error("a persisted exact turn must not rerun automatically");
      },
      async (_handle, request) => {
        recoveredTurns.push(request.providerTurnId);
        return { turnId: request.providerTurnId, outcome: "no_reply", text: null };
      },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await successor.pump(agent);
    assert.equal(newTurns, 0);
    assert.deepEqual(recoveredTurns, ["turn:unresolved-live"]);
    assert.equal((await reopened.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
    await successor.fenceAndDrain();
    await reopened.close();
  } finally {
    late?.resolve({ turnId: "cleanup", outcome: "reply", text: "cleanup" });
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await removeTestDirectory(root);
  }
});

test("a late provider rejection after handoff is observed and cannot commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-late-rejection-"));
  let store: SupervisedAgentInboxStore | null = null;
  let delivery: SupervisedAgentDelivery | null = null;
  let late: ReturnType<typeof deferred<{ turnId: string; outcome: "reply"; text: string }>> | null = null;
  const unhandled: unknown[] = [];
  const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", observeUnhandled);
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); late = deferred<{ turnId: string; outcome: "reply"; text: string }>();
    let published = 0;
    delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("turn:late-rejection");
      entered.resolve();
      return late!.promise;
    }), {
      poll: async () => ({}), publish: async () => { published += 1; },
    }, currentAuthority);
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivery.fenceAndDrain(),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("handoff did not retire the provider await within one second")), 1_000); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
    late.reject(new Error("late provider failure"));
    await pump;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "the detached provider rejection is already observed");
    assert.equal(published, 0, "a late rejection cannot publish");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", "a late rejection cannot mutate the ambiguous receipt");
    assert.equal((await store.receipts(agent.agentId))[0]?.provider_turn_id, "turn:late-rejection");
  } finally {
    // Resolve if an assertion failed before the provider attached its observer.
    late?.resolve({ turnId: "cleanup", outcome: "reply", text: "cleanup" });
    process.off("unhandledRejection", observeUnhandled);
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await removeTestDirectory(root);
  }
});

test("handoff during publication aborts and drains the publication without acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-publish-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); const release = deferred<void>(); let aborted = false;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "turn", outcome: "reply", text: "answer" })), {
      poll: async () => ({}),
      publish: ({ signal }) => new Promise<void>((resolve) => { entered.resolve(); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); release.promise.then(resolve); }),
    }, currentAuthority);
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise;
    const drain = delivery.fenceAndDrain(); release.resolve();
    await drain; await pump;
    assert.equal(aborted, true);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "publishing");
    await store.close();
  } finally { await removeTestDirectory(root); }
});

test("a stale generation after a provider await cannot publish or acknowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-stale-generation-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "reply"; text: string }>(); let current = true; let published = 0; const seen: unknown[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { entered.resolve(); return release.promise; }), { poll: async () => ({}), publish: async () => { published += 1; } }, async (authority) => { seen.push(authority); return current; }, 50, async () => {});
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise; current = false; release.resolve({ turnId: "turn", outcome: "reply", text: "late" }); await pump;
    assert.equal(published, 0);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching");
    assert.deepEqual(seen.at(-1), {
      agentId: "stone", roomId: "room", provider: "codex", apiUrl: "https://letagents.test", agentSessionId: "session-1", bearer: "memory",
      workAttemptId: "attempt", executionGenerationId: "generation-1", daemonGeneration: 1,
      providerContinuationId: "thread", providerConnection: agent.providerConnection, handle: agent.handle,
    });
    await store.close();
  } finally { await removeTestDirectory(root); }
});

test("a desired stop, API-origin rotation, or handle replacement after a provider await cannot publish", async () => {
  for (const stale of ["desired-stop", "api-origin", "handle-replacement"] as const) {
    const root = await mkdtemp(join(tmpdir(), `letagents-delivery-${stale}-`));
    try {
      const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
      const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
      let desiredRunning = true; let currentApiUrl = agent.apiUrl; let currentHandle = agent.handle; let published = 0;
      const delivery = new SupervisedAgentDelivery(store, provider(async () => { entered.resolve(); return release.promise; }), {
        poll: async () => ({}), publish: async () => { published += 1; },
      }, async (authority) => desiredRunning && authority.apiUrl === currentApiUrl && authority.handle === currentHandle);
      await delivery.pump(agent); await ingest(store);
      const pump = delivery.pump(agent); await entered.promise;
      if (stale === "desired-stop") desiredRunning = false;
      if (stale === "api-origin") currentApiUrl = "https://rotated-origin.test";
      if (stale === "handle-replacement") currentHandle = { ...agent.handle, pid: 2 };
      release.resolve({ turnId: "turn", outcome: "reply", text: "late" }); await pump;
      assert.equal(published, 0, stale);
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", stale);
      await store.close();
    } finally { await removeTestDirectory(root); }
  }
});

test("handoff tracks a retry paused after its receipt read and leaves the blocked head unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retry-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.transition(item.inbox_item_id, "blocked", { last_error: "manual retry" });
    const entered = deferred<void>(); const release = deferred<void>(); const receipts = store.receipts.bind(store);
    (store as unknown as { receipts(agentId: string): ReturnType<typeof store.receipts> }).receipts = async (agentId) => { entered.resolve(); await release.promise; return receipts(agentId); };
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("must not run"); }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    const retry = delivery.retry(agent, "1"); await entered.promise;
    const drain = delivery.fenceAndDrain(); release.resolve();
    await drain; await assert.rejects(retry, (error: unknown) => error instanceof Error);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "blocked");
    await store.close();
  } finally { await removeTestDirectory(root); }
});

test("retry acknowledges durable scheduling without waiting for a long provider turn, and duplicate retry is fenced", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retry-ack-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.transition(item.inbox_item_id, "blocked", { last_error: "manual retry" });
    const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "no_reply"; text: null }>();
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.markDispatched?.();
      entered.resolve();
      return release.promise;
    }), { poll: async () => ({}), publish: async () => { throw new Error("no-reply must not publish"); } }, currentAuthority);
    const started = delivery.retry(agent, "1");
    await started;
    await entered.promise;
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", "the request returned after durable scheduling, while provider work remains live");
    await assert.rejects(() => delivery.retry(agent, "1"), /blocked room delivery is no longer available/i);
    release.resolve({ turnId: "turn", outcome: "no_reply", text: null });
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged_no_reply");
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await removeTestDirectory(root); }
});

test("daemon socket retry accepts only the exact blocked binding and reports committed no-reply settlement", async t => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retry-socket-"));
  let daemon: SupervisorDaemon | null = null;
  let release: ReturnType<typeof deferred<{ turnId: string; outcome: "no_reply"; text: null }>> | null = null;
  try {
    const entered = deferred<void>(); release = deferred<{ turnId: string; outcome: "no_reply"; text: null }>();
    const paths = {
      lockPath: join(root, "daemon.lock"), ...testDaemonEndpoint(root), manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"), workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    };
    daemon = new SupervisorDaemon(paths, "darwin", provider(async (_handle, _request, options) => {
      await options?.markDispatched?.(); entered.resolve(); return release!.promise;
    }), false, 60_000, undefined, {}, {
      poll: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true })),
      publish: async () => { throw new Error("no-reply must not publish"); },
    });
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof agent.handle>;
      supervisedInbox: SupervisedAgentInboxStore;
      roomWorkPublisher: { settled(agentId: string): void };
      workerBindings: { bind(input: Record<string, string>): Promise<unknown>; unbind(entryId: string): Promise<void> };
    };
    await daemon.start();
    const observed = new DatabaseSync(paths.manifestPath, { readOnly: true });
    t.after(() => observed.close());
    const completionHints: string[] = [];
    const settled = internals.roomWorkPublisher.settled.bind(internals.roomWorkPublisher);
    t.mock.method(internals.roomWorkPublisher, "settled", (agentId: string) => {
      const row = observed.prepare("SELECT state FROM supervised_agent_inbox WHERE agent_id=? AND source_message_id='msg_1'").get(agentId);
      if (row?.state === "acknowledged_no_reply") completionHints.push(agentId);
      settled(agentId);
    });
    const identities = {
      stone: { attempt: "00000000-0000-4000-8000-000000000001", execution: "00000000-0000-4000-8000-000000000011", session: "00000000-0000-4000-8000-000000000021" },
      other: { attempt: "00000000-0000-4000-8000-000000000002", execution: "00000000-0000-4000-8000-000000000012", session: "00000000-0000-4000-8000-000000000022" },
    } as const;
    for (const id of ["stone", "other"] as const) {
      const identity = identities[id];
      const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        id, room_id: id === "stone" ? "room" : "other-room", display_name: id, provider: "codex", model: null, charter: "test",
        desired_state: "running", observed_state: "working", condition: "none", permission_profile_id: null, delivery_mode: "daemon_inbox", created_by: "test", created_at: new Date().toISOString(), work_attempt_id: identity.attempt,
        provider_ref: { work_attempt_id: identity.attempt, provider_continuation_id: `${id}-thread`, provider_connection: { ...agent.providerConnection, pid: id === "stone" ? 1 : 2, processIdentity: `${id}-process-birth` }, execution_generation_id: identity.execution },
      } });
      assert.equal(put.ok, true, put.error);
      internals.liveHandles.set(id, { workAttemptId: identity.attempt, providerContinuationId: `${id}-thread`, pid: id === "stone" ? 1 : 2, providerConnection: { ...agent.providerConnection, pid: id === "stone" ? 1 : 2, processIdentity: `${id}-process-birth` }, observedState: "working" });
      await internals.workerBindings.bind({
        entry_id: id, room_id: id === "stone" ? "room" : "other-room", work_attempt_id: identity.attempt, execution_generation_id: identity.execution,
        agent_session_id: identity.session, agent_session_token: `${id}-token`, api_url: "https://letagents.test",
      });
      await internals.supervisedInbox.ingestPoll({ agent_id: id, room_id: id === "stone" ? "room" : "other-room", last_observed_message_id: "1", messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1" }, activation: {} }] });
      const item = await internals.supervisedInbox.claimHead(id);
      await internals.supervisedInbox.transition(item!.inbox_item_id, "blocked", { last_error: "manual retry" });
    }
    await internals.supervisedInbox.ingestPoll({ agent_id: "other", room_id: "other-room", last_observed_message_id: "2", messages: [{ source_message_id: "msg_2", source_message: { id: "msg_2" }, activation: {} }] });
    const generation = (await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number };
    const exact = { entry_id: "stone", room_id: "room", source_message_id: "msg_1", work_attempt_id: identities.stone.attempt, execution_generation_id: identities.stone.execution, agent_session_id: identities.stone.session, daemon_generation: generation.generation };
    for (const [field, value] of Object.entries({ room_id: "wrong-room", work_attempt_id: "old-attempt", execution_generation_id: "old-generation", agent_session_id: "old-session", daemon_generation: generation.generation + 1 })) {
      const response = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", { ...exact, [field]: value });
      assert.equal(response.ok, false, `stale ${field} must reject`);
    }
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", { ...exact, source_message_id: "unknown" })).ok, false, "an unknown source row rejects");
    internals.liveHandles.delete("stone");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", exact)).ok, false, "a missing live handle rejects");
    internals.liveHandles.set("stone", { workAttemptId: identities.stone.attempt, providerContinuationId: "stone-thread", pid: 1, providerConnection: { ...agent.providerConnection, processIdentity: "stone-process-birth" }, observedState: "working" });
    const accepted = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", exact);
    assert.equal(accepted.ok, true, accepted.error);
    await entered.promise;
    const activeReceipt = (await internals.supervisedInbox.receipts("stone"))[0]!;
    const activeProjection = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{
      id: string;
      room_agent_state?: { turn: { state: string; inbox_item_id: string | null; source_message_id: string | null } } | null;
    }>;
    const activeTurn = activeProjection.find((entry) => entry.id === "stone")?.room_agent_state?.turn;
    assert.equal(activeTurn?.state, "responding", "only the live markDispatched edge projects an active responding turn");
    assert.equal(activeTurn?.inbox_item_id, activeReceipt.inbox_item_id);
    assert.equal(activeTurn?.source_message_id, "msg_1");
    const duplicate = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", exact);
    assert.equal(duplicate.ok, false, "a dispatching row is not retryable again");
    const listed = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{ id: string; delivery_receipts?: Array<{ state: string; source_message_id: string }> }>;
    assert.equal(listed.find((entry) => entry.id === "stone")?.delivery_receipts?.[0]?.state, "dispatching");
    const otherReceipts = listed.find((entry) => entry.id === "other")?.delivery_receipts ?? [];
    assert.equal(otherReceipts[0]?.state, "blocked", "retry targets only the selected agent row");
    assert.equal(otherReceipts[1]?.state, "queued_behind_blocked");
    assert.equal((otherReceipts[1] as { blocked_by_message_id?: string }).blocked_by_message_id, "msg_1", "projection exposes the public source ID, not a private inbox ID");
    release.resolve({ turnId: "turn", outcome: "no_reply", text: null });
    await waitForAsync(async () => (await internals.supervisedInbox.receipts("stone"))[0]?.state === "acknowledged_no_reply");
    await waitForAsync(async () => completionHints.includes("stone"));
    assert.deepEqual([...new Set(completionHints)], ["stone"], "the publisher is notified after the real terminal commit, without another native event");
    const completed = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{ id: string; delivery_receipts?: Array<{ state: string; timeline?: Array<{ phase: string }> }> }>;
    assert.equal(completed.find((entry) => entry.id === "stone")?.delivery_receipts?.[0]?.state, "acknowledged_no_reply");
    assert.equal(completed.find((entry) => entry.id === "stone")?.delivery_receipts?.[0]?.timeline?.at(-1)?.phase, "no_reply");
    const final = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", exact);
    assert.equal(final.ok, false, "final rows cannot be retried");
    await internals.workerBindings.unbind("other");
    const missingCredential = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", { ...exact, entry_id: "other", room_id: "other-room", work_attempt_id: identities.other.attempt, execution_generation_id: identities.other.execution, agent_session_id: identities.other.session });
    assert.equal(missingCredential.ok, false, "missing binding/credential rejects");
    const waitingCredentials = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{
      id: string; room_agent_state?: { inbox: { state: string } } | null;
    }>;
    assert.equal(waitingCredentials.find((entry) => entry.id === "other")?.room_agent_state?.inbox.state, "waiting_for_desktop_credentials");
    await internals.workerBindings.bind({ entry_id: "other", room_id: "other-room", work_attempt_id: identities.other.attempt, execution_generation_id: identities.other.execution, agent_session_id: identities.other.session, agent_session_token: "other-token", api_url: "https://letagents.test" });
    const otherHead = (await internals.supervisedInbox.receipts("other"))[0]!;
    await internals.supervisedInbox.retryBlocked(otherHead.inbox_item_id);
    await internals.supervisedInbox.claimHead("other");
    await internals.supervisedInbox.checkpointTurnStarted(otherHead.inbox_item_id, "other-turn", {
      work_attempt_id: identities.other.attempt,
      origin_execution_generation_id: identities.other.execution,
      provider_continuation_id: "other-thread",
    });
    await internals.supervisedInbox.transition(otherHead.inbox_item_id, "awaiting_result");
    await internals.supervisedInbox.transition(otherHead.inbox_item_id, "publishing", { outcome: JSON.stringify({ kind: "reply", text: "durable" }) });
    const publishingProjection = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{ id: string; delivery_receipts?: Array<{ state: string }> }>;
    assert.equal(publishingProjection.find((entry) => entry.id === "other")?.delivery_receipts?.[0]?.state, "publishing");
    await internals.supervisedInbox.transition(otherHead.inbox_item_id, "retryable", { last_error: "publish transport failed" });
    const retryableProjection = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{ id: string; delivery_receipts?: Array<{ state: string }> }>;
    assert.equal(retryableProjection.find((entry) => entry.id === "other")?.delivery_receipts?.[0]?.state, "retryable");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "other", desired_state: "stopped" });
    const stopped = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", { ...exact, entry_id: "other", room_id: "other-room", work_attempt_id: identities.other.attempt, execution_generation_id: identities.other.execution, agent_session_id: identities.other.session });
    assert.equal(stopped.ok, false, "desired non-running rejects before retry");
    await daemon.stop(); daemon = null;
  } finally {
    release?.resolve({ turnId: "cleanup", outcome: "no_reply", text: null });
    await daemon?.stop().catch(() => undefined);
    await removeTestDirectory(root);
  }
});
