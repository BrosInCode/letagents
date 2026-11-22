/** Starting, stopping and handing off the supervisor daemon. */
import { openDaemonMaintenance, registerDaemonBoardAccess } from "../maintenance-service.js";
import { BOUNDED_MCP_EFFECT_KIND, EffectExecutor } from "../effect-journal/index.js";
import { restoreLocalRoomAuthorities } from "../local-room-runtime.js";
import { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import { withProtectedStateUpgrade, type StateRecoveryBootstrap } from "../state-recovery-key.js";
import { recordedRemote, RoomWorkPublisher } from "../room-work-publisher.js";
import { assertSupervisorDaemonPlatform } from "../platform.js";
import { runEveryStopStep } from "../stop-steps.js";
import type { BootstrapOperation } from "../worker-authority-coordinator.js";
import { REPLY_ATTACHMENT_RETENTION_MS } from "./types.js";
import { SupervisorDaemonOperations } from "./operations.js";

export abstract class SupervisorDaemonLifecycle extends SupervisorDaemonOperations {
  async start(storage: StateRecoveryBootstrap = {}): Promise<void> {
    assertSupervisorDaemonPlatform(this.platform);
    await this.singleton.acquire();
    // Copies for replies that never published (no_reply, a lost or refused turn) are not needed after two days.
    const sweepReplyAttachments = () => void this.replyAttachmentSpool.sweep(REPLY_ATTACHMENT_RETENTION_MS).catch(() => undefined);
    sweepReplyAttachments();
    this.replyAttachmentSweep = setInterval(sweepReplyAttachments, 60 * 60 * 1000);
    this.replyAttachmentSweep.unref();
    const writeFence = () => { this.singleton.assertCurrentSync(); };
    try {
      this.maintenance = await openDaemonMaintenance({
        singleton: this.singleton, store: this.store, socket: this.socket,
        stores: [this.durability, this.workerBindings, this.supervisedInbox],
        closeDatabase: () => this.closeStateDatabase(),
        status: () => this.status(),
        retire: () => { this.handoffScheduled = true; this.boardOwnershipActive = false; this.convergencePacer.close(); },
      });
      this.boardOwnershipActive = true;
      registerDaemonBoardAccess(this.singleton, () =>
        this.boardOwnershipActive && !this.maintenance && !this.handoffScheduled);
      if (!this.maintenance) await this.hostApprovals.enroll(storage);
      this.stateDatabase = await withProtectedStateUpgrade(this.stateDatabasePath, async (database) => {
        this.store.attachDatabase(database.connection, writeFence);
        this.durability.attachDatabase(database.connection, writeFence);
        this.durability.bindSupervisorFence(this.supervisorFenceIdentity());
        this.workerBindings.attachDatabase(database.connection, writeFence);
        this.supervisedInbox.attachDatabase(database.connection, writeFence);
        await this.store.load();
        return database;
      }, storage, () => this.singleton.assertCurrent(), { keepOpen: true });
    } catch (error) {
      this.boardOwnershipActive = false;
      await this.store.close().catch(() => undefined);
      await this.durability.close().catch(() => undefined);
      await this.workerBindings.close().catch(() => undefined);
      await this.supervisedInbox.close().catch(() => undefined);
      this.closeStateDatabase();
      await this.singleton.release();
      throw error;
    }
    if (this.maintenance) { await this.socket.start(); return; }
    if (!this.handoffScheduled && this.stateDatabase) {
      const database = this.stateDatabase.connection;
      this.roomWorkPublisher = RoomWorkPublisher.attach(database, {
        workspaceLocation: (id) => this.durability.getAttempt(id).then(({ workspace_path: path, workspace_identity }) =>
          ({ path, revision: workspace_identity.resolved_revision, remote: recordedRemote(workspace_identity) })),
        custody: this.workerRuntimeCustody, daemonGeneration: () => this.singleton.currentGeneration,
        isClosing: () => this.handoffScheduled, assertCurrent: () => this.singleton.assertCurrent(),
        assertWriteFence: writeFence,
      });
      this.executionCapture = ExecutionCaptureCoordinator.attach(database, this.providerPort, {
        currentHandle: (entryId) => this.liveHandles.get(entryId), daemonGeneration: () => this.singleton.currentGeneration,
        assertWriteFence: writeFence,
        changed: (agentId) => {
          this.roomWorkPublisher?.changed(agentId);
          this.providerStreams.typedLifecycleAdmissionChanged(agentId);
          this.stateWatch.notify();
        },
        lifecycleProjected: (agentId, observedState) => {
          this.providerStreams.typedLifecycleEffectChanged(agentId, observedState);
          if (observedState) this.requestConvergence(agentId);
          this.stateWatch.notify();
        },
        recordStopped: (agentId) => this.providerExecution?.noteRecordStopped(agentId),
      });
      this.effectExecutor = new EffectExecutor({
        getDatabase: () => this.stateDatabase?.connection ?? null,
        currentDaemonGeneration: () => this.singleton.currentGeneration,
        assertCurrent: () => this.singleton.assertCurrent(),
        assertWriteFence: writeFence,
        isClosing: () => this.handoffScheduled,
        notifyStateChanged: () => this.notifyStateChanged(),
        nowMs: () => this.nowMs(),
      });
      this.effectExecutor.registerHandler(
        BOUNDED_MCP_EFFECT_KIND,
        this.boundedEffects.createExecutorHandler(),
      );
      this.roomMoves.attachEffectExecutor(this.effectExecutor, database, writeFence);
      this.executionDelegations.start();
    }
    const effectRecovery = await this.effectExecutor?.recoverOnStartup();
    if (effectRecovery && effectRecovery.uncertainAgentIds.length > 0) {
      await this.supervisedInbox.pruneAgentsAfterEffectRecovery(effectRecovery.uncertainAgentIds);
    }
    await this.runtimeRecovery.recoverTurnControls();
    await this.roomMoves.reconcilePrepared();
    await this.lifecycleAdministration.recoverPreparedPurges();
    await this.lifecycleAdministration.recoverEphemeralWorkspaces();
    // Uses id, room_id, local_room_id, desired_state, display_name and provider of each entry; no activity.
    await restoreLocalRoomAuthorities((await this.store.load("summary")).entries, this.singleton.currentGeneration, this.workerRuntimeCustody);
    await this.socket.start();
    // The bundled MCP runtime's integrity check reads its whole tree once per
    // daemon (over a minute on a fresh install behind an on-access scanner). It
    // starts now, in the background; a launch waits on it only while it runs.
    void this.providerPort?.verifyBundledRuntime?.().catch((error) => console.warn("[runtime_verify]", String(error)));
    // Images an earlier process staged for turns that have long ended.
    void this.roomTurnAttachments.sweep();
    // These two passes use the id of each entry only, in manifest order.
    for (const entryId of await this.store.listEntryIds()) {
      void this.startSupervisedDelivery(entryId).catch(() => undefined);
    }
    if (this.providerPort && this.autoConverge) {
      for (const entryId of await this.store.listEntryIds()) this.requestConvergence(entryId, "rehydration");
    }
    void this.workerBindings.compactRetainedPublications().catch(() => undefined);
    // Earlier turns that a stopped process could not remove from a room are removed now.
    this.liveRoomShare.resume(await this.store.liveSharingByAgent());
  }

  async stop(): Promise<void> {
    // Stop is final for this daemon instance. Fence late delivery/cutover
    // continuations before awaiting any drain. Every step then runs whatever an
    // earlier one reports, and the first failure is rethrown at the end: an
    // open socket would keep the process alive.
    this.handoffScheduled = true;
    let executionDelegationDrain: Promise<void> | undefined;
    if (this.replyAttachmentSweep) clearInterval(this.replyAttachmentSweep);
    await runEveryStopStep([
      () => this.convergencePacer.close(), () => this.providerTerminals.close(), () => this.hostApprovals.close(),
      () => this.liveRoomShare.dispose(),
      () => { executionDelegationDrain = this.executionDelegations.fenceAndDrain(); },
      () => this.roomWorkPublisher?.close(), () => this.executionCapture?.close(), () => this.effectExecutor?.fence(), () => this.supervisedDelivery?.fence(),
      () => this.wakeRoomMoveReconciliationWaiters(), () => this.notifyStateChanged(), () => this.workerRuntimeCustody.destroyAllCredentials(),
      () => executionDelegationDrain,
      () => this.supervisedDelivery?.fenceAndDrain(),
      () => this.fenceAndDrainRoomMoveReconciliations(),
      () => this.effectExecutor?.fenceAndDrain(),
      () => this.boundedEffects.drainJournalReservations(),
      () => this.providerExecution?.clearRecoveryTimers(),
      () => this.providerReconciliation?.disposeAll(),
      () => this.providerExecution?.drainConvergence(),
      () => this.providerStreams.disposeAll(),
      () => this.activityWrites.close(),
      () => this.socket.stop(),
      () => this.serializeManifestCommit(() => this.singleton.release()),
      () => this.store.close(),
      () => this.durability.close(),
      () => this.workerBindings.close(),
      () => this.supervisedInbox.close(),
      () => this.closeStateDatabase(),
    ]);
  }

  /**
   * Wait for a requested version handoff to finish. This is intentionally a
   * daemon-lifecycle promise rather than a socket response: prepare_handoff
   * must acknowledge before it tears down the connection carrying that reply.
   */
  async waitForHandoff(): Promise<void> {
    await (this.maintenance?.completion ?? this.handoff.waitForCompletion());
  }

  /**
   * Version handoff must release daemon authority independently of provider or
   * network callback latency. Provider work survives; only this daemon's
   * observers and control authority are detached.
   */
  protected async stopForHandoff(): Promise<void> {
    // Fence first. Any callbacks that outlive this method are prevented from
    // committing daemon-owned state by fenceDaemonCommit().
    if (this.replyAttachmentSweep) clearInterval(this.replyAttachmentSweep);
    this.workerRuntimeCustody.destroyAllCredentials();
    this.convergencePacer.close();
    this.effectExecutor?.fence();
    this.wakeRoomMoveReconciliationWaiters();
    const failures: unknown[] = [...this.handoffCleanupFailures];
    try { await this.activityWrites.close(); } catch (error) { failures.push(error); }
    try { await this.supervisedDelivery?.fenceAndDrain(); } catch (error) { failures.push(error); }
    try { await this.fenceAndDrainRoomMoveReconciliations(); } catch (error) { failures.push(error); }
    const captureSync = (operation: () => void): void => {
      try { operation(); } catch (error) { failures.push(error); }
    };
    captureSync(() => this.providerReconciliation?.detachAll());
    captureSync(() => this.providerExecution?.clearRecoveryTimers());
    // Remote grant/capability waits remain freely cancellable, but once a
    // native provider dispatch begins its exact returned identity must be
    // persisted before the shared stores are closed for successor attach.
    await this.providerExecution?.drainDispatches();
    try { await this.effectExecutor?.fenceAndDrain(); } catch (error) { failures.push(error); }
    await this.boundedEffects.drainJournalReservations();
    captureSync(() => this.providerStreams.detachAll());
    // Complete every local cleanup step even if one fails. The process-level
    // entrypoint will report the failure and exit non-zero, but should never
    // leave the singleton lock behind merely because (for example) socket
    // unlinking failed after the listener had already closed.
    const cleanup = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    await cleanup(() => this.socket.stop());
    await cleanup(() => this.serializeManifestCommit(() => this.singleton.release()));
    await cleanup(() => this.store.close());
    await cleanup(() => this.durability.close());
    await cleanup(() => this.workerBindings.close());
    await cleanup(() => this.supervisedInbox.close());
    captureSync(() => this.closeStateDatabase());
    // Existing convergence/provider callbacks are generation-fenced below.
    // Do not await them: a wedged native transport must not block an upgrade.
    this.providerExecution?.detachConvergence();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Supervisor handoff cleanup did not complete cleanly.");
    }
  }

  protected async retireForHandoff(): Promise<void> {
    const executionDelegationDrain = this.executionDelegations.fenceAndDrain();
    this.hostApprovals.close();
    this.roomWorkPublisher?.close();
    this.executionCapture?.close();
    // Authority revocation and delivery cancellation are one synchronous
    // edge. No claimed FIFO item may observe the public fence before its
    // controller is aborted and its cleanup owner is established.
    this.supervisedDelivery?.fence();
    // Stop admitting new effects immediately without aborting already-admitted
    // bounded external tool calls before `drainExternalExecutions()` completes.
    this.effectExecutor?.fence({ abortInFlight: false });
    this.wakeRoomMoveReconciliationWaiters();
    this.notifyStateChanged();
    // A bootstrap that already read tail N must commit N before lock/socket
    // release. Otherwise a successor could establish a later tail and skip a
    // message that raced this handoff. New bootstrap requests are rejected by
    // the public fence above; this only drains operations admitted before it.
    for (const bootstrap of this.bootstrapOperations) {
      if (bootstrap.phase === "observing") bootstrap.controller.abort();
    }
    await Promise.allSettled([...this.bootstrapOperations].map((bootstrap) => bootstrap.operation));
    await executionDelegationDrain;
    await this.fenceAndDrainRoomMoveReconciliations();
    // Retire secret custody synchronously with the public handoff fence. The
    // dispatch preflight then proves every native return is journaled before
    // the acknowledgement can authorize Electron to replace this daemon.
    this.workerRuntimeCustody.destroyOwnerCredentials();
    await this.providerExecution?.drainDispatches();
    await this.boundedEffects.drainExternalExecutions();
    await this.effectExecutor?.fenceAndDrain();
    await this.boundedEffects.drainJournalReservations();
    await this.providerTerminals.drainAndClose(() => {
      try { this.providerStreams.detachAll(); } catch (error) { this.handoffCleanupFailures.push(error); }
    });
  }

  protected beginBootstrap<T>(run: (input: { entry_id: string; daemon_generation: number }, operation: BootstrapOperation) => Promise<T>, input: { entry_id: string; daemon_generation: number }): Promise<T> {
    const controller = new AbortController();
    const operation: BootstrapOperation = { controller, phase: "observing", operation: Promise.resolve() };
    const result = run(input, operation);
    operation.operation = result;
    this.bootstrapOperations.add(operation);
    const clear = () => this.bootstrapOperations.delete(operation);
    void result.then(clear, clear);
    return result;
  }
}
