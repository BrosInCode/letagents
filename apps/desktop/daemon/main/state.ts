/** The supervisor daemon's parameters, plain state and the parts every layer reads. */
import type { DaemonMaintenanceService } from "../maintenance-service.js";
import type { AuditLog } from "../audit-log.js";
import type { AgentStreamRegistry } from "../agent-stream-registry.js";
import type { ReplyAttachmentSpool } from "../reply-attachment-spool.js";
import type { BoundedEffectCoordinator } from "../bounded-effect-coordinator.js";
import type { ContinuationRepairCoordinator } from "../continuation-repair-coordinator.js";
import type { SupervisorGrantHttp } from "../cloud-http.js";
import type { DaemonControlSocket } from "../control-socket.js";
import type { createHostApprovalBridge } from "../host-approval-broker.js";
import type { DaemonAuthority } from "../daemon-authority.js";
import type { DaemonReadModel } from "../daemon-read-model.js";
import type { DeliveryCutoverCoordinator } from "../delivery-cutover-coordinator.js";
import type { DeliveryCutoverExecutionCoordinator } from "../delivery-cutover-execution-coordinator.js";
import type { DaemonStateWatch } from "../daemon-state-watch.js";
import type { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import type { ExecutionDelegationCoordinator } from "../execution-delegation-coordinator.js";
import type { TypedLifecycleEffectCoordinator } from "../typed-lifecycle-effect-coordinator.js";
import type { DesiredStateCoordinator } from "../desired-state-coordinator.js";
import type { WorkDurabilityStore } from "../durability-store.js";
import type { EntryConcurrencyGate } from "../entry-concurrency-gate.js";
import type { EphemeralWorkspaceProvisioner } from "../ephemeral-workspace-provisioner.js";
import type { LifecycleAdministrationCoordinator } from "../lifecycle-administration-coordinator.js";
import type { ManifestAdministrationCoordinator } from "../manifest-administration-coordinator.js";
import type { ManifestStore } from "../manifest-store.js";
import type { DaemonActivityWrites } from "../activity-write-batcher.js";
import type { ManifestTransitionCoordinator } from "../manifest-transition-coordinator.js";
import type { NativeActivityPublicationCoordinator } from "../native-activity-publication-coordinator.js";
import type { LiveRoomSharePublisher } from "../live-room-share-publisher.js";
import type { ConvergencePacer } from "../convergence-pacer.js";
import type { RoomWorkPublisher } from "../room-work-publisher.js";
import type { ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";
import type { ProviderCheckpointCoordinator } from "../provider-checkpoint-coordinator.js";
import type { ProviderExecutionCoordinator } from "../provider-execution-coordinator.js";
import type { ProviderHandoffCoordinator } from "../provider-handoff-coordinator.js";
import type { ProviderReconciliationCoordinator } from "../provider-reconciliation-coordinator.js";
import type { ProviderSchedulerFailureCoordinator } from "../provider-scheduler-failure-coordinator.js";
import type { ProviderStreamCoordinator } from "../provider-stream-coordinator.js";
import type { ProviderTerminalCoordinator } from "../provider-terminal-coordinator.js";
import type { RoomDeliveryControl } from "../room-delivery-control.js";
import type { RoomMoveCoordinator } from "../room-move-coordinator.js";
import type { RuntimeConfigurationApplyCoordinator } from "../runtime-configuration-apply-coordinator.js";
import type { RuntimeRecoveryCoordinator } from "../runtime-recovery-coordinator.js";
import type { DaemonSingleton } from "../singleton.js";
import type { DaemonRequest } from "../types.js";
import type { WorkspaceProvisioner, GitCommand } from "../workspace-provisioner.js";
import type { WorkerBindingStore } from "../worker-binding-store.js";
import type { WorkerAuthorityCoordinator, BootstrapOperation } from "../worker-authority-coordinator.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";
import type { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { SupervisedAgentDelivery, SupervisedDeliveryHttp } from "../supervised-agent-delivery.js";
import type { RoomTurnAttachmentStager } from "../room-turn-attachments.js";
import type { SupervisedDeliveryLifecycleCoordinator } from "../supervised-delivery-lifecycle-coordinator.js";
import type { SupervisedToolRuntime } from "../supervised-tool-runtime.js";
import type { TurnControlCoordinator } from "../turn-control-coordinator.js";
import type { DaemonPaths, RecoveryClock } from "./types.js";

/**
 * The base of the supervisor daemon's class chain. It holds the constructor
 * parameters, the plain state with initial values, and an abstract declaration
 * for every part a later layer builds in its constructor.
 *
 * Chain, base first: SupervisorDaemonState -> SupervisorDaemonOperations ->
 * SupervisorDaemonLifecycle -> SupervisorDaemonStores ->
 * SupervisorDaemonProviderExecution -> SupervisorDaemonDelivery -> SupervisorDaemon.
 * Each constructor layer runs its part of the original constructor after its
 * base, so the parts are built in the original order.
 */
export abstract class SupervisorDaemonState {
  protected maintenance: DaemonMaintenanceService | null = null;
  protected replyAttachmentSweep: NodeJS.Timeout | null = null;
  protected readonly liveHandles = new Map<string, ProviderActionHandle>();
  protected executionCapture: ExecutionCaptureCoordinator | null = null;
  protected typedLifecycleEffects: TypedLifecycleEffectCoordinator | null = null;
  protected roomWorkPublisher: RoomWorkPublisher | null = null;
  protected readonly handoffCleanupFailures: unknown[] = [];
  /**
   * Control requests must be able to fence a launch while its per-entry
   * reconciliation lane is awaiting remote authorization or capabilities.
   * They therefore cannot rely on that same lane for ordering.
   */
  protected readonly workerRuntimeCustody = new WorkerRuntimeCustody();
  /** Initial-tail reads are authority-bearing admission operations. */
  protected readonly bootstrapOperations = new Set<BootstrapOperation>();
  protected readonly startedAt = new Date().toISOString();
  protected handoffScheduled = false;
  protected handoffDraining = false;
  protected boardOwnershipActive = false;

  protected abstract readonly stateDatabasePath: string;
  protected abstract readonly singleton: DaemonSingleton;
  protected abstract readonly authority: DaemonAuthority;
  protected abstract readonly store: ManifestStore;
  protected abstract readonly activityWrites: DaemonActivityWrites;
  protected abstract readonly manifestAdministration: ManifestAdministrationCoordinator;
  protected abstract readonly manifestTransitions: ManifestTransitionCoordinator;
  protected abstract readonly readModel: DaemonReadModel;
  protected abstract readonly lifecycleAdministration: LifecycleAdministrationCoordinator;
  protected abstract readonly desiredStates: DesiredStateCoordinator;
  protected abstract readonly audit: AuditLog;
  protected abstract readonly durability: WorkDurabilityStore;
  protected abstract readonly provisioner: WorkspaceProvisioner;
  protected abstract readonly ephemeralProvisioner: EphemeralWorkspaceProvisioner;
  protected abstract readonly gitCommand: GitCommand;
  protected abstract readonly workerBindings: WorkerBindingStore;
  protected abstract readonly nativeActivity: NativeActivityPublicationCoordinator;
  protected abstract readonly workerAuthority: WorkerAuthorityCoordinator;
  protected abstract readonly convergencePacer: ConvergencePacer;
  protected abstract readonly executionDelegations: ExecutionDelegationCoordinator;
  protected abstract readonly supervisedInbox: SupervisedAgentInboxStore;
  protected abstract readonly replyAttachmentSpool: ReplyAttachmentSpool;
  protected abstract readonly continuationRepairs: ContinuationRepairCoordinator;
  protected abstract readonly roomMoves: RoomMoveCoordinator;
  protected abstract readonly supervisedDelivery: SupervisedAgentDelivery | null;
  protected abstract readonly roomTurnAttachments: RoomTurnAttachmentStager;
  protected abstract readonly supervisedDeliveryLifecycle: SupervisedDeliveryLifecycleCoordinator;
  protected abstract readonly turnControls: TurnControlCoordinator;
  protected abstract readonly roomDeliveryControl: RoomDeliveryControl;
  protected abstract readonly runtimeRecovery: RuntimeRecoveryCoordinator;
  protected abstract readonly runtimeConfigurationApply: RuntimeConfigurationApplyCoordinator;
  protected abstract readonly boundedEffects: BoundedEffectCoordinator;
  protected abstract readonly socket: DaemonControlSocket;
  protected abstract readonly stateWatch: DaemonStateWatch;
  protected abstract readonly entryConcurrency: EntryConcurrencyGate;
  protected abstract readonly deliveryCutovers: DeliveryCutoverCoordinator;
  protected abstract readonly deliveryCutoverExecution: DeliveryCutoverExecutionCoordinator;
  protected abstract readonly providerStreams: ProviderStreamCoordinator;
  protected abstract readonly hostApprovals: ReturnType<typeof createHostApprovalBridge>;
  protected abstract readonly providerCheckpoints: ProviderCheckpointCoordinator;
  protected abstract readonly providerExecution: ProviderExecutionCoordinator | null;
  protected abstract readonly providerReconciliation: ProviderReconciliationCoordinator | null;
  protected abstract readonly providerSchedulerFailures: ProviderSchedulerFailureCoordinator;
  protected abstract readonly providerTerminals: ProviderTerminalCoordinator;
  protected abstract readonly nowMs: () => number;
  protected abstract readonly agentStreamRegistry: AgentStreamRegistry;
  protected abstract readonly liveRoomShare: LiveRoomSharePublisher;
  protected abstract readonly handoff: ProviderHandoffCoordinator;

  protected get manifestGeneration(): number {
    return this.authority.generation;
  }

  protected set manifestGeneration(generation: number) {
    this.authority.generation = generation;
  }

  constructor(
    paths: DaemonPaths,
    protected readonly platform: NodeJS.Platform,
    protected readonly providerPort: ProviderActionPort | undefined,
    protected readonly autoConverge: boolean,
    protected readonly nativeHeartbeatIntervalMs: number,
    protected readonly controlRequestBarrier: ((request: DaemonRequest) => Promise<void>) | undefined,
    recoveryClock: RecoveryClock,
    protected readonly supervisedDeliveryHttp: SupervisedDeliveryHttp,
    protected readonly supervisorGrantHttp: SupervisorGrantHttp,
    protected readonly loadSupervisedToolRuntime: () => Promise<SupervisedToolRuntime>,
  ) {}
}

export type SupervisorDaemonArgs = ConstructorParameters<typeof SupervisorDaemonState>;
