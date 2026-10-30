/** Starting, stopping and handing off the supervisor daemon. */
import { openDaemonMaintenance, registerDaemonBoardAccess } from "../maintenance-service.js";
import { restoreLocalRoomAuthorities } from "../local-room-runtime.js";
import { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import { TypedLifecycleEffectCoordinator } from "../typed-lifecycle-effect-coordinator.js";
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
    try {
      this.maintenance = await openDaemonMaintenance({
        singleton: this.singleton, store: this.store, socket: this.socket,
        stores: [this.durability, this.workerBindings, this.supervisedInbox],
        status: () => this.status(),
        retire: () => { this.handoffScheduled = true; this.boardOwnershipActive = false; this.convergencePacer.close(); },
      });
      this.boardOwnershipActive = true;
      registerDaemonBoardAccess(this.singleton, () =>
        this.boardOwnershipActive && !this.maintenance && !this.handoffScheduled);
      if (!this.maintenance) await this.hostApprovals.enroll(storage);
      this.manifestGeneration = await withProtectedStateUpgrade(this.stateDatabasePath, async () => {
        this.durability.bindSupervisorFence(this.supervisorFenceIdentity());
        return (await this.store.load()).generation;
      }, storage, () => this.singleton.assertCurrent());
    } catch (error) {
      this.boardOwnershipActive = false;
      await this.store.close();
      await this.singleton.release();
      throw error;
    }
    if (this.maintenance) { await this.socket.start(); return; }
    if (!this.handoffScheduled) {
      this.typedLifecycleEffects = new TypedLifecycleEffectCoordinator({
        store: this.store,
        currentInstallation: (entryId) => this.providerStreams.currentInstallation(entryId),
        authority: {
          serialize: (operation) => this.serializeManifestMutation(operation),
          assertCurrent: async () => { await this.singleton.assertCurrent(); },
          currentManifestGeneration: () => this.manifestGeneration,
          acceptManifestGeneration: (generation) => { this.manifestGeneration = generation; },
          fenceCommit: (commit) => this.fenceDaemonCommit(commit),
        },
        isClosing: () => this.handoffScheduled,
        nowMs: () => this.nowMs(),
        diagnostic: (agentId, error) => console.warn("[typed_lifecycle_effect]", JSON.stringify({ agentId, error: String(error) })),
        changed: (agentId, state) => { this.providerStreams.typedLifecycleEffectChanged(agentId, state); if (state) this.requestConvergence(agentId); },
      });
      this.typedLifecycleEffects.start();
      this.roomWorkPublisher = RoomWorkPublisher.open(this.stateDatabasePath, {
        workspaceLocation: (id) => this.durability.getAttempt(id).then(({ workspace_path: path, workspace_identity }) =>
          ({ path, revision: workspace_identity.resolved_revision, remote: recordedRemote(workspace_identity) })),
        custody: this.workerRuntimeCustody, daemonGeneration: () => this.singleton.currentGeneration,
        isClosing: () => this.handoffScheduled, assertCurrent: () => this.singleton.assertCurrent(),
      });
      this.executionCapture = ExecutionCaptureCoordinator.open(this.stateDatabasePath, this.providerPort, {
        currentHandle: (entryId) => this.liveHandles.get(entryId), daemonGeneration: () => this.singleton.currentGeneration,
        changed: (agentId) => (this.roomWorkPublisher?.changed(agentId), this.typedLifecycleEffects?.changed(agentId), this.stateWatch.notify()),
        recordStopped: (agentId) => this.providerExecution?.noteRecordStopped(agentId),
      });
      this.executionDelegations.start();
    }
    await this.supervisedInbox.normalizeInterruptedEffects();
    await this.runtimeRecovery.recoverTurnControls();
    await this.roomMoves.reconcilePrepared();
    await this.lifecycleAdministration.recoverPreparedPurges();
    await this.lifecycleAdministration.recoverEphemeralWorkspaces();
    await restoreLocalRoomAuthorities((await this.store.load()).entries, this.singleton.currentGeneration, this.workerRuntimeCustody);
    await this.socket.start();
    // Images an earlier process staged for turns that have long ended.
    void this.roomTurnAttachments.sweep();
    for (const entry of (await this.store.load()).entries) {
      void this.startSupervisedDelivery(entry.id).catch(() => undefined);
      if (await this.store.unresolvedDeliveryDrain(entry.id) || await this.store.unresolvedPollingActivation(entry.id)) {
        void this.deliveryCutovers.start(entry.id).catch(() => undefined);
      }
    }
    if (this.providerPort && this.autoConverge) {
      for (const entry of (await this.store.load()).entries) this.requestConvergence(entry.id, "rehydration");
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
      () => this.roomWorkPublisher?.close(), () => this.executionCapture?.close(), () => this.supervisedDelivery?.fence(),
      () => this.typedLifecycleEffects?.close(),
      () => this.wakeRoomMoveReconciliationWaiters(), () => this.notifyStateChanged(), () => this.workerRuntimeCustody.destroyAllCredentials(),
      () => executionDelegationDrain,
      () => this.deliveryCutovers.fenceAndDrain(),
      () => this.supervisedDelivery?.fenceAndDrain(),
      () => this.fenceAndDrainRoomMoveReconciliations(),
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
    this.wakeRoomMoveReconciliationWaiters();
    const failures: unknown[] = [...this.handoffCleanupFailures];
    try { await this.activityWrites.close(); } catch (error) { failures.push(error); }
    try { await this.deliveryCutovers.fenceAndDrain(); } catch (error) { failures.push(error); }
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
    await this.boundedEffects.drainJournalReservations();
    captureSync(() => this.providerStreams.detachAll());
    // Complete every local cleanup step even if one fails. The process-level
    // entrypoint will report the failure and exit non-zero, but should never
    // leave the singleton lock behind merely because (for example) socket
    // unlinking failed after the listener had already closed.
    const cleanup = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    await cleanup(() => this.typedLifecycleEffects?.close() ?? Promise.resolve());
    await cleanup(() => this.socket.stop());
    await cleanup(() => this.serializeManifestCommit(() => this.singleton.release()));
    await cleanup(() => this.store.close());
    await cleanup(() => this.durability.close());
    await cleanup(() => this.workerBindings.close());
    await cleanup(() => this.supervisedInbox.close());
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
    await this.boundedEffects.drainJournalReservations();
    await this.boundedEffects.drainExternalExecutions();
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
