import { createHash } from "node:crypto";
import { redactCredentialText } from "./credential-redaction.js";
import { DeliveryCutoverObservationDetached, type DeliveryCutoverCoordinator } from "./delivery-cutover-coordinator.js";
import { deliveryDrainBlocksRuntime, type DeliveryDrainRecord } from "./delivery-drain.js";
import { devMcpServerEntryFromEnv } from "./dev-spawn-options.js";
import type { DaemonAuthority } from "./daemon-authority.js";
import type { EntryConcurrencyGate } from "./entry-concurrency-gate.js";
import type { ManifestStore } from "./manifest-store.js";
import { processBirthState, type ProcessIdentity } from "./process-identity.js";
import type { SupervisedAgentDelivery } from "./supervised-agent-delivery.js";
import { matchesPollingActivationRuntime, type PollingActivationRecord } from "./custodial-polling-activation.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";
import type { InstalledHostGrant } from "./worker-runtime-custody.js";
import {
  sameProviderActionConnectionSnapshot,
  type ProviderActionHandle,
  type ProviderActionPort,
  type ProviderActionRef,
} from "./provider-action-port.js";
import type {
  DaemonActivityEvent,
  DaemonDeliveryCutover,
  DaemonManifestEntry,
  TaskWorkAttempt,
} from "./types.js";

type DeliveryCutoverIdentity = Omit<
  DaemonDeliveryCutover,
  "provider_turn_id" | "phase" | "updated_at"
>;

export type DeliveryCutoverExecutionCoordinatorOptions = {
  isHandoffScheduled: () => boolean;
  provider?: ProviderActionPort;
  getEntry: (entryId: string) => Promise<DaemonManifestEntry | undefined>;
  getAttempt: (workAttemptId: string) => Promise<TaskWorkAttempt>;
  updateEntry: (
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
  ) => Promise<DaemonManifestEntry>;
  getLiveHandle: (entryId: string) => ProviderActionHandle | undefined;
  startDelivery: (entryId: string) => Promise<void>;
  observation: Pick<DeliveryCutoverCoordinator, "assertObservation" | "observe" | "scheduleRetry">;
  drain?: {
    store: Pick<ManifestStore, "prepareDeliveryDrain" | "getDeliveryDrain" | "unresolvedDeliveryDrain" | "cancelDeliveryDrain"
      | "deliveryDrainReadiness" | "markDeliveryDrainDispatch" | "markDeliveryDrainUncertain" | "commitDeliveryDrain" | "getAgentConfiguration"
      | "preparePollingActivation" | "getPollingActivation" | "unresolvedPollingActivation" | "markPollingActivationDispatch"
      | "checkpointPollingActivationTurn" | "markPollingActivationUncertain" | "cancelPollingActivation" | "completePollingActivation">;
    authority: Pick<DaemonAuthority, "generation" | "serializeManifestMutation" | "fenceDaemonCommit">;
    entries: Pick<EntryConcurrencyGate, "run" | "beginLifecycle" | "bumpControlEpoch" | "waitForActiveRoomMove">;
    delivery: Pick<SupervisedAgentDelivery, "stop"> | null;
    processIdentity?: ProcessIdentity;
  };
  polling?: {
    bindings: Pick<WorkerBindingStore, "get" | "credentialFor" | "supervisedWorkerSession">;
    currentHostGrant: (entry: DaemonManifestEntry) => InstalledHostGrant | null;
  };
};

export type DeliveryDrainIdentity = { entryId: string; operationId: string };
export type DeliveryDrainRequest = DeliveryDrainIdentity & { requestId: string; roomId: string; executionGenerationId: string };
export type PollingActivationRequest = DeliveryDrainRequest & { reverseOperationId: string };

/**
 * Executes durable delivery cutovers and explicit custodial polling activation.
 *
 * Process-local admission, retry timers, and handoff draining remain owned by
 * DeliveryCutoverCoordinator. This coordinator owns only durable saga phases
 * and exact-provider observations.
 */
export class DeliveryCutoverExecutionCoordinator {
  private readonly isHandoffScheduled: () => boolean;
  private readonly provider?: ProviderActionPort;
  private readonly getEntry: DeliveryCutoverExecutionCoordinatorOptions["getEntry"];
  private readonly getAttempt: DeliveryCutoverExecutionCoordinatorOptions["getAttempt"];
  private readonly updateEntry: DeliveryCutoverExecutionCoordinatorOptions["updateEntry"];
  private readonly getLiveHandle: DeliveryCutoverExecutionCoordinatorOptions["getLiveHandle"];
  private readonly startDelivery: DeliveryCutoverExecutionCoordinatorOptions["startDelivery"];
  private readonly observation: DeliveryCutoverExecutionCoordinatorOptions["observation"];
  private readonly drain: DeliveryCutoverExecutionCoordinatorOptions["drain"];
  private readonly polling: DeliveryCutoverExecutionCoordinatorOptions["polling"];

  constructor(options: DeliveryCutoverExecutionCoordinatorOptions) {
    this.isHandoffScheduled = options.isHandoffScheduled;
    this.provider = options.provider;
    this.getEntry = options.getEntry;
    this.getAttempt = options.getAttempt;
    this.updateEntry = options.updateEntry;
    this.getLiveHandle = options.getLiveHandle;
    this.startDelivery = options.startDelivery;
    this.observation = options.observation;
    this.drain = options.drain;
    this.polling = options.polling;
  }

  /** Only this explicit operator action may dispatch a polling activation.
   * Mode commits, grant installation, and startup reconciliation never call it. */
  async activatePolling(input: PollingActivationRequest): Promise<PollingActivationRecord> {
    const drain = this.requireDrain();
    if (!this.polling || !this.provider?.activateCustodialPolling || !this.provider.inspectTurnBoundary) {
      throw new Error("Custodial polling activation is unavailable.");
    }
    const release = drain.entries.beginLifecycle(input.entryId);
    drain.entries.bumpControlEpoch(input.entryId);
    const identity = { operationId: input.operationId, agentId: input.entryId };
    try {
      await drain.entries.waitForActiveRoomMove(input.entryId);
      // turn/start acknowledges admission, not work completion. Keep worker
      // tool admission behind this lock until the exact ID is checkpointed.
      return await drain.entries.run(input.entryId, async () => {
        this.assertAttached();
        let activation = await drain.store.getPollingActivation(input.operationId);
        if (activation && (activation.agent_id !== input.entryId || activation.request_id !== input.requestId
          || activation.room_id !== input.roomId || activation.execution_generation_id !== input.executionGenerationId
          || activation.reverse_operation_id !== input.reverseOperationId)) throw new Error("Polling activation request identity changed.");
        if (activation && activation.phase !== "prepared") {
          if (activation.phase !== "complete" && activation.phase !== "cancelled") this.observation.scheduleRetry(input.entryId, 0);
          return activation;
        }
        const entry = await this.getEntry(input.entryId);
        const handle = this.getLiveHandle(input.entryId);
        const request = await this.pollingLaunchRequest(entry, handle, input.operationId);
        if (entry!.room_id !== input.roomId || entry!.provider_ref!.execution_generation_id !== input.executionGenerationId) {
          throw new Error("Polling activation no longer owns the requested execution.");
        }
        const boundary = await this.provider!.inspectTurnBoundary!(handle!);
        this.assertAttached();
        if (!activation) activation = (await drain.store.preparePollingActivation({ ...input, agentId: input.entryId,
          handle: handle!, boundary }, (commit) => drain.authority.fenceDaemonCommit(commit))).activation;
        try {
          await this.provider!.activateCustodialPolling!(handle!, request, {
            beforeNativeDispatch: async () => {
              this.assertAttached();
              const currentRequest = await this.pollingLaunchRequest(await this.getEntry(input.entryId), handle, input.operationId);
              if (JSON.stringify(currentRequest) !== JSON.stringify(request)) throw new Error("Polling activation authority changed before dispatch.");
              const latestBoundary = await this.provider!.inspectTurnBoundary!(handle!);
              this.assertAttached();
              activation = await drain.store.markPollingActivationDispatch({ ...identity, handle: handle!, boundary: latestBoundary },
                (commit) => drain.authority.fenceDaemonCommit(commit));
            },
            checkpointTurnStarted: async (providerTurnId) => {
              this.assertAttached();
              // Only the initiating RPC acknowledgement supplies this identity;
              // observers may never discover/adopt a latest turn for this row.
              activation = await drain.store.checkpointPollingActivationTurn({ ...identity, providerTurnId },
                (commit) => drain.authority.fenceDaemonCommit(commit));
            },
          });
        } catch (error) {
          this.assertAttached();
          activation = await drain.store.getPollingActivation(input.operationId);
          if (activation?.phase === "dispatching" || activation?.phase === "active") {
            activation = await drain.store.markPollingActivationUncertain(identity, (commit) => drain.authority.fenceDaemonCommit(commit));
          } else if (activation?.phase === "prepared") {
            throw error; // Proven pre-dispatch: only an explicit retry may start it.
          }
        }
        this.assertAttached();
        this.observation.scheduleRetry(input.entryId, 0);
        return (await drain.store.getPollingActivation(input.operationId))!;
      });
    } finally { release(); }
  }

  async getPollingActivation(input: DeliveryDrainIdentity): Promise<PollingActivationRecord> {
    const activation = await this.requireDrain().store.getPollingActivation(input.operationId);
    if (!activation || activation.agent_id !== input.entryId) throw new Error("Unknown polling activation for this agent.");
    return activation;
  }

  async cancelPollingActivation(input: DeliveryDrainIdentity): Promise<PollingActivationRecord> {
    const drain = this.requireDrain();
    return drain.entries.run(input.entryId, async () => {
      this.assertAttached();
      return drain.store.cancelPollingActivation({ operationId: input.operationId, agentId: input.entryId },
        (commit) => drain.authority.fenceDaemonCommit(commit));
    });
  }

  private async pollingLaunchRequest(entry: DaemonManifestEntry | undefined, handle: ProviderActionHandle | undefined, operationId: string) {
    const drain = this.requireDrain();
    if (!this.polling || !entry || !handle || this.getLiveHandle(entry.id) !== handle
      || entry.provider !== "codex" || (entry.delivery_mode ?? "mcp_polling") !== "mcp_polling" || entry.desired_state !== "running"
      || entry.condition !== "none" || !entry.work_attempt_id || !entry.provider_ref
      || handle.workAttemptId !== entry.work_attempt_id || handle.providerContinuationId !== entry.provider_ref.provider_continuation_id
      || !sameProviderActionConnectionSnapshot(handle.providerConnection, entry.provider_ref.provider_connection)) {
      throw new Error("Polling activation requires the exact owned custodial runtime.");
    }
    const configuration = await drain.store.getAgentConfiguration(entry.id);
    const binding = await this.polling.bindings.get(entry.id);
    const session = await this.polling.bindings.supervisedWorkerSession(entry.id);
    const grant = this.polling.currentHostGrant(entry);
    const attempt = await this.getAttempt(entry.work_attempt_id);
    if (!configuration || configuration.polling_contract !== "custodial_polling_v1"
      || configuration.config_revision !== configuration.runtime_configuration_revision
      || (handle.appliedConfigurationRevision !== undefined && handle.appliedConfigurationRevision !== configuration.config_revision)
      || !binding?.room_cursor || binding.room_id !== entry.room_id || binding.work_attempt_id !== entry.work_attempt_id
      || binding.execution_generation_id !== entry.provider_ref.execution_generation_id
      || entry.provider_ref.custodial_launch_agent_session_id !== binding.agent_session_id
      || !session || session.agent_session_id !== binding.agent_session_id || session.room_id !== binding.room_id
      || session.execution_generation_id !== binding.execution_generation_id || session.credential_ref !== binding.credential_ref
      || !session.expires_at || !(Date.parse(session.expires_at) > Date.now())
      || !grant || !(Date.parse(grant.expiresAt) > Date.now()) || !await this.polling.bindings.credentialFor(binding)
      || !attempt.workspace_path || this.polling.currentHostGrant(entry) !== grant
      || this.getLiveHandle(entry.id) !== handle || ["failed", "stopped", "stopping"].includes(handle.observedState)) {
      throw new Error("Polling activation requires current applied configuration and bound worker authority.");
    }
    this.assertAttached();
    return { operationId, roomId: entry.room_id, cwd: attempt.workspace_path, agentDisplayName: entry.display_name,
      workerSession: { agentSessionId: binding.agent_session_id, roomCursor: binding.room_cursor },
      launchReceipt: { contract: "custodial_polling_v1" as const, configurationRevision: configuration.config_revision,
        agentSessionId: entry.provider_ref.custodial_launch_agent_session_id!,
        workAttemptId: entry.work_attempt_id, providerContinuationId: entry.provider_ref.provider_continuation_id,
        providerConnection: structuredClone(entry.provider_ref.provider_connection!) } };
  }

  /** Explicit reverse operation: selecting the contract does not start a polling turn. */
  async prepareDrain(input: DeliveryDrainRequest): Promise<DeliveryDrainRecord> {
    const drain = this.requireDrain();
    const release = drain.entries.beginLifecycle(input.entryId);
    drain.entries.bumpControlEpoch(input.entryId);
    try {
      await drain.entries.waitForActiveRoomMove(input.entryId);
      return await drain.entries.run(input.entryId, async () => {
        this.assertAttached();
        const existing = await drain.store.getDeliveryDrain(input.operationId);
        if (existing) {
          if (existing.agent_id !== input.entryId || existing.request_id !== input.requestId || existing.room_id !== input.roomId
            || existing.execution_generation_id !== input.executionGenerationId) throw new Error("Delivery drain request identity changed.");
          if (!["complete", "cancelled", "failed"].includes(existing.phase)) this.observation.scheduleRetry(input.entryId, 0);
          return existing;
        }
        const entry = await this.getEntry(input.entryId);
        const handle = this.getLiveHandle(input.entryId);
        if (!entry || entry.provider !== "codex" || entry.delivery_mode !== "daemon_inbox"
          || entry.room_id !== input.roomId || entry.provider_ref?.execution_generation_id !== input.executionGenerationId
          || !handle || handle.workAttemptId !== entry.work_attempt_id
          || handle.providerContinuationId !== entry.provider_ref.provider_continuation_id
          || !sameProviderActionConnectionSnapshot(handle.providerConnection, entry.provider_ref.provider_connection)) {
          throw new Error("Delivery drain requires the exact owned Codex runtime.");
        }
        // Prove the actual resolved MCP runtime, not a version promised by the
        // controller, before installing a gate or stopping any provider.
        await this.preflightPolling();
        const boundary = await this.provider!.inspectTurnBoundary!(handle);
        this.assertAttached();
        const result = await drain.store.prepareDeliveryDrain({ ...input, agentId: input.entryId, handle, boundary },
          (commit) => drain.authority.fenceDaemonCommit(commit));
        this.observation.scheduleRetry(input.entryId, 0);
        return result.cutover;
      });
    } finally { release(); }
  }

  async getDrain(input: DeliveryDrainIdentity): Promise<DeliveryDrainRecord> {
    const record = await this.requireDrain().store.getDeliveryDrain(input.operationId);
    if (!record || record.agent_id !== input.entryId) throw new Error("Unknown delivery drain for this agent.");
    return record;
  }

  async cancelDrain(input: DeliveryDrainIdentity): Promise<DeliveryDrainRecord> {
    const drain = this.requireDrain();
    const release = drain.entries.beginLifecycle(input.entryId);
    try {
      return await drain.entries.run(input.entryId, async () => {
        this.assertAttached();
        const record = await drain.store.cancelDeliveryDrain({ operationId: input.operationId, agentId: input.entryId },
          (commit) => drain.authority.fenceDaemonCommit(commit));
        this.deferDeliveryStart(input.entryId);
        return record;
      });
    } finally { release(); }
  }

  private requireDrain(): NonNullable<DeliveryCutoverExecutionCoordinatorOptions["drain"]> {
    if (!this.drain) {
      throw new Error("Custodial polling transition is unavailable for this runtime.");
    }
    return this.drain;
  }

  private assertAttached(): void {
    if (this.isHandoffScheduled()) throw new DeliveryCutoverObservationDetached();
  }

  private async preflightPolling(): Promise<void> {
    this.requireDrain();
    if (!this.provider?.preflightCustodialPolling || !this.provider.inspectTurnBoundary || !this.provider.stopRef) {
      throw new Error("Custodial polling transition is unavailable for this runtime.");
    }
    const devMcpServerEntryPath = devMcpServerEntryFromEnv();
    await this.provider!.preflightCustodialPolling!({ provider: "codex", ...(devMcpServerEntryPath ? { devMcpServerEntryPath } : {}) });
    this.assertAttached();
  }

  private exactDrainRef(cutover: DeliveryDrainRecord, entry: DaemonManifestEntry | undefined): ProviderActionRef | null {
    const ref = entry?.provider_ref;
    const connection = ref?.provider_connection;
    if (!ref || entry?.id !== cutover.agent_id || entry.work_attempt_id !== cutover.work_attempt_id
      || ref.execution_generation_id !== cutover.execution_generation_id || ref.work_attempt_id !== cutover.work_attempt_id
      || ref.provider_continuation_id !== cutover.native_continuation_id || connection?.kind !== "codex_app_server"
      || createHash("sha256").update(JSON.stringify([connection.kind, connection.url, connection.pid, connection.processIdentity])).digest("hex")
        !== cutover.native_connection_sha256) return null;
    return { provider: "codex", workAttemptId: ref.work_attempt_id, providerContinuationId: ref.provider_continuation_id,
      providerConnection: structuredClone(connection) };
  }

  private async driveDrain(initial: DeliveryDrainRecord, signal: AbortSignal): Promise<void> {
    const drain = this.requireDrain();
    const identity = { operationId: initial.operation_id, agentId: initial.agent_id };
    let cutover = initial;
    let release: (() => void) | undefined;
    let deliveryStopped = false;
    try {
      this.observation.assertObservation(signal);
      if (!deliveryDrainBlocksRuntime(cutover)) {
        const readiness = await drain.store.deliveryDrainReadiness(cutover.operation_id);
        if (readiness.status === "waiting") { this.observation.scheduleRetry(cutover.agent_id, 1_000); return; }
        if (readiness.status === "queued") { await this.cancelDrain({ entryId: cutover.agent_id, operationId: cutover.operation_id }); return; }
        await this.observation.observe(signal, this.preflightPolling());
      }
      release = drain.entries.beginLifecycle(cutover.agent_id);
      drain.entries.bumpControlEpoch(cutover.agent_id);
      await drain.entries.waitForActiveRoomMove(cutover.agent_id);
      // Join outside the entry lock: completion/publication callbacks must be
      // able to acquire that lock while the old polling and FIFO loops drain.
      await this.observation.observe(signal, drain.delivery?.stop(cutover.agent_id) ?? Promise.resolve());
      deliveryStopped = true;
      await drain.entries.run(cutover.agent_id, async () => {
        this.observation.assertObservation(signal);
        cutover = await this.getDrain({ entryId: cutover.agent_id, operationId: cutover.operation_id });
        if (["complete", "cancelled", "failed"].includes(cutover.phase)) return;
        if (!deliveryDrainBlocksRuntime(cutover)) {
          const readiness = await drain.store.deliveryDrainReadiness(cutover.operation_id);
          if (readiness.status === "queued") {
            cutover = await drain.store.cancelDeliveryDrain(identity, (commit) => drain.authority.fenceDaemonCommit(commit));
            return;
          }
          if (readiness.status !== "ready") throw new Error("Delivery drain is still settling admitted work.");
          const handle = this.getLiveHandle(cutover.agent_id);
          if (!handle || !this.exactDrainRef(cutover, await this.getEntry(cutover.agent_id))) {
            throw new Error("Delivery drain lost its owned native idle boundary before dispatch.");
          }
          const boundary = await this.observation.observe(signal, this.provider!.inspectTurnBoundary!(handle));
          this.observation.assertObservation(signal);
          cutover = await drain.store.markDeliveryDrainDispatch({ ...identity, handle, boundary },
            (commit) => drain.authority.fenceDaemonCommit(commit));
        }
      });
      this.observation.assertObservation(signal);
      if (!deliveryDrainBlocksRuntime(cutover)) return;
      if (processBirthState(cutover.native_pid, cutover.native_process_identity, drain.processIdentity) !== "gone") {
        const ref = this.exactDrainRef(cutover, await this.getEntry(cutover.agent_id));
        if (!ref) throw new Error("Delivery drain cannot signal a missing or changed native connection.");
        this.observation.assertObservation(signal);
        // The durable stop intent already exists. Repeating this after a crash
        // can only address its immutable PID birth, never a successor runtime.
        await this.observation.observe(signal, this.provider!.stopRef!(ref, { graceMs: 5_000 }));
      }
      await drain.entries.run(cutover.agent_id, () => drain.authority.serializeManifestMutation(async () => {
        this.observation.assertObservation(signal);
        const result = await drain.store.commitDeliveryDrain(drain.authority.generation, identity,
          (commit) => drain.authority.fenceDaemonCommit(async () => {
            this.observation.assertObservation(signal);
            if (processBirthState(cutover.native_pid, cutover.native_process_identity, drain.processIdentity) !== "gone") {
              throw new Error("Delivery drain has no hard proof that the old process birth is gone.");
            }
            await commit();
          }));
        drain.authority.generation = result.generation;
        cutover = result.cutover;
      }));
    } catch (error) {
      if (error instanceof DeliveryCutoverObservationDetached) return;
      if (deliveryDrainBlocksRuntime(cutover)) {
        await drain.entries.run(cutover.agent_id, () => drain.store.markDeliveryDrainUncertain(identity,
          (commit) => drain.authority.fenceDaemonCommit(commit)));
      }
      this.observation.scheduleRetry(cutover.agent_id, 1_000);
      throw error;
    } finally {
      release?.();
      if (deliveryStopped && !deliveryDrainBlocksRuntime(cutover) && cutover.phase !== "complete" && !this.isHandoffScheduled()) {
        this.deferDeliveryStart(cutover.agent_id);
      }
    }
  }

  /** Restart recovery only observes an already dispatched invocation. A
   * prepared row never causes native work, and an unknown ACK never adopts latest. */
  private async observePollingActivation(initial: PollingActivationRecord, signal: AbortSignal): Promise<void> {
    if (initial.phase === "prepared") return;
    const drain = this.requireDrain();
    const identity = { operationId: initial.operation_id, agentId: initial.agent_id };
    await drain.entries.run(initial.agent_id, async () => {
      this.observation.assertObservation(signal);
      let activation = await drain.store.getPollingActivation(initial.operation_id);
      if (!activation || activation.phase === "complete" || activation.phase === "cancelled" || activation.phase === "prepared") return;
      try {
        const gone = () => processBirthState(activation!.native_pid, activation!.native_process_identity, drain.processIdentity) === "gone";
        if (gone()) {
          await drain.store.completePollingActivation({ ...identity, providerTurnId: activation.provider_turn_id, outcome: "lost" },
            (commit) => drain.authority.fenceDaemonCommit(async () => {
              this.observation.assertObservation(signal);
              if (!gone()) throw new Error("Polling activation native death proof changed.");
              await commit();
            }));
          return;
        }
        if (!activation.provider_turn_id || !this.provider?.inspectCustodialPollingActivation) {
          throw new Error("Polling activation has no exact turn acknowledgement to reconcile.");
        }
        const entry = await this.getEntry(initial.agent_id);
        if (!entry || !matchesPollingActivationRuntime(activation, entry)) throw new Error("Polling activation runtime changed.");
        const ref = entry.provider_ref!;
        const handle = this.getLiveHandle(initial.agent_id) ?? await this.observation.observe(signal, this.provider.attach({
          provider: "codex", workAttemptId: ref.work_attempt_id, providerContinuationId: ref.provider_continuation_id,
          providerConnection: ref.provider_connection,
        }));
        if (!handle || "state" in handle || !matchesPollingActivationRuntime(activation, entry, handle)) throw new Error("Polling activation native runtime is unavailable.");
        const observed = await this.observation.observe(signal,
          this.provider.inspectCustodialPollingActivation(handle, activation.provider_turn_id));
        this.observation.assertObservation(signal);
        const current = await this.getEntry(initial.agent_id);
        if (!current || !matchesPollingActivationRuntime(activation, current, handle)) {
          throw new Error("Polling activation lost its observed runtime.");
        }
        if (observed.state === "terminal") {
          await drain.store.completePollingActivation({ ...identity, providerTurnId: activation.provider_turn_id, outcome: observed.outcome },
            (commit) => drain.authority.fenceDaemonCommit(commit));
          return;
        }
        if (observed.state !== "active") throw new Error("Polling activation exact native turn is unknown.");
        // This ID was checkpointed by the original RPC. Observation can only
        // confirm it; it cannot supply a first ID after an ambiguous dispatch.
        activation = await drain.store.checkpointPollingActivationTurn({ ...identity, providerTurnId: activation.provider_turn_id },
          (commit) => drain.authority.fenceDaemonCommit(commit));
      } catch (error) {
        if (error instanceof DeliveryCutoverObservationDetached) return;
        this.observation.assertObservation(signal);
        await drain.store.markPollingActivationUncertain(identity, (commit) => drain.authority.fenceDaemonCommit(commit));
      }
      this.observation.scheduleRetry(initial.agent_id, 1_000);
    });
  }

  /**
   * Fence the exact legacy polling turn before enabling daemon ingress. The
   * manifest is the effect journal: once a target is recorded no later run may
   * inspect "latest" as a replacement target, and once native dispatch is
   * recorded an active/unknown result is deliberately left gated.
   */
  async drive(entryId: string, detachSignal: AbortSignal): Promise<void> {
    if (this.isHandoffScheduled()) return;
    const reverse = await this.drain?.store.unresolvedDeliveryDrain(entryId);
    if (reverse) { await this.driveDrain(reverse, detachSignal); return; }
    const activation = await this.drain?.store.unresolvedPollingActivation(entryId);
    if (activation) { await this.observePollingActivation(activation, detachSignal); return; }
    // Custodial workers need a separate future cutover witness. They must
    // never enter the legacy wait_for_messages interrupt protocol below.
    if ((await this.drain?.store.getAgentConfiguration(entryId))?.polling_contract) return;
    const provider = this.provider;
    if (this.isHandoffScheduled() || !provider?.controlExactTurn) return;
    let entry = await this.getEntry(entryId);
    this.observation.assertObservation(detachSignal);
    if (!entry) return;

    // Terminal durability is the convergence boundary for every old cutover,
    // including predecessor states whose provider_ref was already detached or
    // replaced. A terminal current/no-runtime cutover can adopt daemon ingress;
    // a stale cutover beside a successor is only cleared, never allowed to flip
    // that successor's delivery mode.
    if (entry.delivery_cutover) {
      const saved = entry.delivery_cutover;
      const attempt = await this.getAttempt(saved.work_attempt_id).catch(() => null);
      const terminal = attempt?.execution_generations.some((candidate) =>
        candidate.execution_generation_id === saved.execution_generation_id && candidate.terminal) ?? false;
      if (terminal) {
        entry = await this.updateEntry(entryId, (current) => {
          const cutover = current.delivery_cutover;
          if (!cutover
            || cutover.work_attempt_id !== saved.work_attempt_id
            || cutover.execution_generation_id !== saved.execution_generation_id
            || cutover.provider_continuation_id !== saved.provider_continuation_id
            || cutover.provider_turn_id !== saved.provider_turn_id) return current;
          const sameRuntime = current.provider_ref?.execution_generation_id === saved.execution_generation_id
            && current.provider_ref.provider_continuation_id === saved.provider_continuation_id;
          const noRuntime = current.provider_ref == null;
          return {
            ...current,
            ...(sameRuntime || noRuntime ? { delivery_mode: "daemon_inbox" as const } : {}),
            delivery_cutover: null,
          };
        });
        this.observation.assertObservation(detachSignal);
        if (entry.delivery_mode === "daemon_inbox") {
          this.deferDeliveryStart(entryId);
          return;
        }
      }
    }

    const handle = this.getLiveHandle(entryId);
    if (!handle
      || entry.provider !== "codex"
      || (entry.delivery_mode ?? "mcp_polling") !== "mcp_polling"
      || entry.desired_state !== "running"
      || entry.condition !== "none"
      || !entry.work_attempt_id
      || !entry.provider_ref
      || handle.workAttemptId !== entry.work_attempt_id
      || handle.providerContinuationId !== entry.provider_ref.provider_continuation_id
      || !sameProviderActionConnectionSnapshot(handle.providerConnection, entry.provider_ref.provider_connection)) return;

    const identity = {
      work_attempt_id: entry.work_attempt_id,
      execution_generation_id: entry.provider_ref.execution_generation_id,
      provider_continuation_id: entry.provider_ref.provider_continuation_id,
    };
    if (!entry.delivery_cutover) {
      this.observation.assertObservation(detachSignal);
      entry = await this.updateEntry(entryId, (current) => {
        this.observation.assertObservation(detachSignal);
        if (current.turn_control && current.turn_control.status !== "completed") {
          throw new Error(`Delivery cutover is blocked by unresolved turn-control action '${current.turn_control.action_id}'.`);
        }
        if (current.provider !== "codex" || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
          || current.work_attempt_id !== identity.work_attempt_id
          || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
          || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
          || this.getLiveHandle(entryId) !== handle
          || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)) return current;
        const cutover: DaemonDeliveryCutover = {
          ...identity,
          provider_turn_id: null,
          phase: "prepared",
          error: null,
          updated_at: new Date().toISOString(),
        };
        return { ...current, delivery_cutover: cutover };
      });
      this.observation.assertObservation(detachSignal);
    }
    const cutover = entry.delivery_cutover;
    if (!cutover
      || cutover.work_attempt_id !== identity.work_attempt_id
      || cutover.execution_generation_id !== identity.execution_generation_id
      || cutover.provider_continuation_id !== identity.provider_continuation_id) return;

    if (cutover.phase === "dispatching" || cutover.phase === "uncertain") {
      if (!cutover.provider_turn_id || !provider.inspectTurn) {
        await this.markUncertain(entryId, identity, "native interrupt dispatch is ambiguous without an exact turn id", handle, detachSignal);
        return;
      }
      const state = await this.observation.observe(detachSignal, provider.inspectTurn(handle, cutover.provider_turn_id))
        .catch(() => "unknown" as const);
      this.observation.assertObservation(detachSignal);
      if (state === "terminal") {
        await this.complete(entryId, identity, handle, detachSignal);
        return;
      }
      if (state === "unknown") {
        await this.markUncertain(entryId, identity, `native interrupt dispatch is ambiguous; exact turn remains ${state}`, handle, detachSignal);
        this.observation.scheduleRetry(entryId, 1_000);
        return;
      }
      // Exact A is still active. Re-driving the interrupt is safe because the
      // persisted target is immutable; no latest-turn discovery occurs.
    }

    let dispatchMarked = cutover.phase === "dispatching" || cutover.phase === "uncertain";
    try {
      const result = await this.observation.observe(detachSignal, provider.controlExactTurn(handle, {
        targetTurnId: cutover.provider_turn_id,
        checkpointTargetTurn: async (turnId) => {
          this.observation.assertObservation(detachSignal);
          await this.updateEntry(entryId, (current) => {
            this.observation.assertObservation(detachSignal);
            const currentCutover = current.delivery_cutover;
            if (!currentCutover
              || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
              || !["prepared", "retryable", "dispatching", "uncertain"].includes(currentCutover.phase)
              || current.desired_state !== "running"
              || current.condition !== "none"
              || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
              || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
              || this.getLiveHandle(entryId) !== handle
              || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
              || currentCutover.work_attempt_id !== identity.work_attempt_id
              || currentCutover.execution_generation_id !== identity.execution_generation_id
              || currentCutover.provider_continuation_id !== identity.provider_continuation_id
              || (currentCutover.provider_turn_id && currentCutover.provider_turn_id !== turnId)) {
              throw new Error("Legacy delivery cutover changed before exact turn checkpoint.");
            }
            return {
              ...current,
              delivery_cutover: {
                ...currentCutover,
                provider_turn_id: turnId,
                updated_at: new Date().toISOString(),
              },
            };
          });
          this.observation.assertObservation(detachSignal);
        },
        markDispatched: async () => {
          this.observation.assertObservation(detachSignal);
          await this.updateEntry(entryId, (current) => {
            this.observation.assertObservation(detachSignal);
            const currentCutover = current.delivery_cutover;
            if (!currentCutover
              || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
              || !["prepared", "retryable", "dispatching", "uncertain"].includes(currentCutover.phase)
              || current.desired_state !== "running"
              || current.condition !== "none"
              || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
              || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
              || this.getLiveHandle(entryId) !== handle
              || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
              || !currentCutover.provider_turn_id
              || currentCutover.work_attempt_id !== identity.work_attempt_id
              || currentCutover.execution_generation_id !== identity.execution_generation_id
              || currentCutover.provider_continuation_id !== identity.provider_continuation_id) {
              throw new Error("Legacy delivery cutover changed before native interrupt dispatch.");
            }
            return {
              ...current,
              delivery_cutover: {
                ...currentCutover,
                phase: "dispatching",
                updated_at: new Date().toISOString(),
              },
            };
          });
          dispatchMarked = true;
          this.observation.assertObservation(detachSignal);
        },
        detachSignal,
      }));
      this.observation.assertObservation(detachSignal);
      // A no-active/terminal inspection is a completion fact. An adapter's
      // interrupt acknowledgement is not: independently re-inspect exactly
      // the persisted target before allowing daemon ingress.
      if (result.outcome === "no_active" || result.outcome === "terminal") {
        await this.complete(entryId, identity, handle, detachSignal);
      } else if (result.outcome === "interrupt_dispatched") {
        const targetTurnId = cutover.provider_turn_id ?? result.targetTurnId;
        if (!targetTurnId || !provider.inspectTurn) {
          await this.markUncertain(entryId, identity, "native interrupt was acknowledged without exact terminal inspection", handle, detachSignal);
          return;
        }
        const state = await this.observation.observe(detachSignal, provider.inspectTurn(handle, targetTurnId))
          .catch(() => "unknown" as const);
        this.observation.assertObservation(detachSignal);
        if (state === "terminal") await this.complete(entryId, identity, handle, detachSignal);
        else {
          await this.markUncertain(entryId, identity, `native interrupt was acknowledged but exact turn remains ${state}`, handle, detachSignal);
          this.observation.scheduleRetry(entryId, 1_000);
        }
      }
    } catch (error) {
      if (error instanceof DeliveryCutoverObservationDetached) return;
      const outcome = error && typeof error === "object" && "turnControlOutcome" in error
        ? (error as { turnControlOutcome?: unknown }).turnControlOutcome
        : null;
      const ambiguous = dispatchMarked || outcome === "uncertain";
      if (ambiguous) {
        await this.markUncertain(
          entryId,
          identity,
          error instanceof Error ? error.message : "exact legacy turn control failed",
          handle,
          detachSignal,
        );
        this.observation.scheduleRetry(entryId, 1_000);
      } else {
        await this.markRetryable(
          entryId,
          identity,
          error instanceof Error ? error.message : "exact legacy turn preparation failed",
          handle,
          detachSignal,
        );
        this.observation.scheduleRetry(entryId, 250);
      }
    }
  }

  private async complete(
    entryId: string,
    identity: DeliveryCutoverIdentity,
    handle: ProviderActionHandle,
    detachSignal: AbortSignal,
  ): Promise<void> {
    this.observation.assertObservation(detachSignal);
    const completed = await this.updateEntry(entryId, (current) => {
      this.observation.assertObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if ((current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || !cutover
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
        || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
        || this.getLiveHandle(entryId) !== handle
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
        || cutover.work_attempt_id !== identity.work_attempt_id
        || cutover.execution_generation_id !== identity.execution_generation_id
        || cutover.provider_continuation_id !== identity.provider_continuation_id) return current;
      const now = new Date().toISOString();
      return {
        ...current,
        delivery_mode: "daemon_inbox",
        delivery_cutover: null,
        // A terminal legacy turn is the successful boundary of the handoff,
        // not a dead worker. The retained app-server/thread is immediately a
        // healthy idle daemon-inbox session until its next bounded delivery.
        ...(current.observed_state === "working" || current.observed_state === "starting"
          ? {
              observed_state: "idle" as const,
              native_liveness: {
                state: "idle" as const,
                observed_at: now,
                detail: "legacy polling turn fenced; daemon inbox ready",
              },
            }
          : {}),
      };
    });
    this.observation.assertObservation(detachSignal);
    if (completed.delivery_mode === "daemon_inbox") this.deferDeliveryStart(entryId);
  }

  private async markRetryable(
    entryId: string,
    identity: DeliveryCutoverIdentity,
    detail: string,
    handle: ProviderActionHandle,
    detachSignal: AbortSignal,
  ): Promise<void> {
    this.observation.assertObservation(detachSignal);
    await this.updateEntry(entryId, (current) => {
      this.observation.assertObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if ((current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || !cutover
        || cutover.phase === "dispatching"
        || cutover.phase === "uncertain"
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
        || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
        || this.getLiveHandle(entryId) !== handle
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
        || cutover.work_attempt_id !== identity.work_attempt_id
        || cutover.execution_generation_id !== identity.execution_generation_id
        || cutover.provider_continuation_id !== identity.provider_continuation_id) return current;
      return {
        ...current,
        delivery_cutover: {
          ...cutover,
          phase: "retryable",
          error: redactCredentialText(detail).value,
          updated_at: new Date().toISOString(),
        },
      };
    });
    this.observation.assertObservation(detachSignal);
  }

  private async markUncertain(
    entryId: string,
    identity: DeliveryCutoverIdentity,
    detail: string,
    handle: ProviderActionHandle,
    detachSignal: AbortSignal,
  ): Promise<void> {
    this.observation.assertObservation(detachSignal);
    await this.updateEntry(entryId, (current) => {
      this.observation.assertObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if ((current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || !cutover
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
        || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
        || this.getLiveHandle(entryId) !== handle
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
        || cutover.work_attempt_id !== identity.work_attempt_id
        || cutover.execution_generation_id !== identity.execution_generation_id
        || cutover.provider_continuation_id !== identity.provider_continuation_id) return current;
      const safeDetail = redactCredentialText(detail).value;
      const observedAt = new Date().toISOString();
      const activity: DaemonActivityEvent = {
        observed_at: observedAt,
        sequence: (current.activity?.at(-1)?.sequence ?? 0) + 1,
        provider: current.provider,
        kind: "delivery_cutover",
        method: "legacy_polling_interrupt",
        summary: "Daemon inbox cutover needs attention; legacy ingress remains fenced.",
        status: "blocked",
        payload: {
          phase: "uncertain",
          provider_turn_id: cutover.provider_turn_id,
          detail: safeDetail,
        },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: null,
      };
      return {
        ...current,
        delivery_cutover: {
          ...cutover,
          phase: "uncertain",
          error: safeDetail,
          updated_at: observedAt,
        },
        activity: [...(current.activity ?? []), activity].slice(-200),
      };
    });
    this.observation.assertObservation(detachSignal);
  }

  private deferDeliveryStart(entryId: string): void {
    // The admission coordinator is still coalesced until its finally runs.
    // Defer the first inbox start one tick so it cannot mistake the cutover
    // operation for an already-running successor.
    const timer = setTimeout(() => void this.startDelivery(entryId).catch(() => undefined), 0);
    timer.unref();
  }
}
