import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { AuditLog } from "./audit-log.js";
import {
  hostGrantApiOrigin,
  lastRoomMessageId,
  NATIVE_LIVENESS_STALE_AFTER_MS,
  publishWorkerNativeActivity,
  productionSupervisedDeliveryHttp,
  productionSupervisorGrantHttp,
  supervisedProviderLabel,
  SupervisorGrantRequestError,
  workplaceLivenessStaleAfterMs,
  type SupervisorGrantHttp,
} from "./cloud-http.js";
import { DaemonControlSocket } from "./control-socket.js";
import { createDaemonControlRequestHandler, type DaemonControlOperations } from "./control-request-router.js";
import { redactCredentialText, sanitizeDaemonActivityEvent } from "./credential-redaction.js";
import { WorkDurabilityStore } from "./durability-store.js";
import { EphemeralWorkspaceProvisioner, isEphemeralWorkspaceMarker } from "./ephemeral-workspace-provisioner.js";
import { projectDaemonCreateRequestReplayParameters, serializeDaemonDeploymentId } from "./manifest-entry-projection.js";
import { projectDeliveryReceipts, projectDeliveryTurn } from "./manifest-view-projection.js";
import { ManifestConflictError, ManifestStore } from "./manifest-store.js";
import { assertMacOS } from "./platform.js";
import { sameProcessBirthIdentity } from "./process-identity.js";
import { sameProviderActionConnectionIdentity, sameProviderActionConnectionSnapshot, type ProviderActionAttachTerminal, type ProviderActionConnectionRef, type ProviderActionHandle, type ProviderActionPort, type ProviderActionRef, type ProviderActionSpawn, type ProviderActionStreamEvent, type ProviderActionTerminal, type ProviderTurnControlResult } from "./provider-action-port.js";
import { isAllowedCursorProviderStateTransition, isIdleCursorConnection, isLiveCursorConnection } from "./provider-state-policy.js";
import {
  isAgentInspectorLiveDisplayEvent,
  isCorrelatedNonemptyWaitResult,
  isHumanRoomActivityEvent,
  isSupervisedQuietPollContinuation,
  isSupervisedWaitProviderEvent,
  providerStreamLifecycle,
  resolveReadyReachedAt,
  supervisedWaitEvidenceFromProviderEvent,
  type SupervisedWaitEvidence,
} from "./provider-stream-policy.js";
import { CRASH_LOOP_EXIT_LIMIT, CRASH_LOOP_WINDOW_MS } from "./reconciler-policy.js";
import { ProviderReconciler, type ReconcilerExecutionInput } from "./reconciler-runner.js";
import { advanceReconciliationState, beginReconciliationAction, completeReconciliationAction, recordReconciliationActionFailure, rememberCompletedControlAction } from "./reconciler-state.js";
import { DaemonFenceLostError, DaemonSingleton, defaultDaemonPaths } from "./singleton.js";
import { DAEMON_IMPLEMENTATION_VERSION, DAEMON_PROTOCOL_VERSION, type DaemonActivityEvent, type DaemonAgentStreamEvent, type DaemonDeliveryCutover, type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRequest, type DaemonRoomMoveRecord, type DesiredState, type ExecutionTerminalPayload, type LegacyLaneOwner, type ObservedState, type PolicyCondition, type ReconciliationNotice } from "./types.js";
import { devMcpServerEntryFromEnv } from "./dev-spawn-options.js";
import {
  deriveProviderConfigurationSnapshot,
  providerSupportsConcurrentSupervisedAgents,
  type ProviderReasoningEffort,
} from "./provider-configuration.js";
import {
  assertSupervisedPermissionProfileAvailable,
  assertSupervisedRentalPermissionProfileAvailable,
  supervisedPermissionProfilesForProvider,
} from "./supervised-permission-profiles.js";
import { createGitCommand, repositoryStorageKey, WorkspaceProvisioner, type GitCommand } from "./workspace-provisioner.js";
import { WorkerBindingStore, type WorkerSessionBinding } from "./worker-binding-store.js";
import { structuredRoomTurnCompletion, SupervisedAgentInboxStore, type ProviderContinuationRepair, type SupervisedEffectRecord } from "./supervised-agent-inbox-store.js";
import { SupervisedAgentDelivery, type SupervisedAuthorityScope, type SupervisedDeliveryAuthority, type SupervisedDeliveryHttp, type SupervisedDeliveryInterruptReservation, type SupervisedIngressAgent } from "./supervised-agent-delivery.js";

export {
  productionSupervisedDeliveryHttp,
  SupervisorGrantRequestError,
  workplaceLivenessStaleAfterMs,
  type SupervisorGrantHttp,
} from "./cloud-http.js";
export {
  isSupervisedQuietPollContinuation,
  isSupervisedWaitProviderEvent,
  providerStreamLifecycle,
  resolveReadyReachedAt,
  supervisedWaitCursorFromProviderEvent,
  supervisedWaitEvidenceFromProviderEvent,
} from "./provider-stream-policy.js";
export { sameProcessBirthIdentity } from "./process-identity.js";

type DaemonPaths = Pick<ReturnType<typeof defaultDaemonPaths>, "lockPath" | "socketPath" | "manifestPath" | "auditPath"> & Partial<Pick<ReturnType<typeof defaultDaemonPaths>, "legacyManifestPath" | "attemptsPath" | "attemptsRoot" | "workspaceRoot" | "workerBindingsPath">>;
type LiveBindingIdentity = { agentSessionId: string; executionGenerationId: string; updatedAt: string };
type PendingResumeBinding = {
  roomId: string;
  workAttemptId: string;
  predecessorExecutionGenerationId: string;
  successorExecutionGenerationId: string;
  agentSessionId: string;
  providerContinuationId: string;
};
type RecoveryClock = {
  nowMs?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};
class InvalidSupervisorGrantRenewalError extends Error {}
type InstalledHostGrant = {
  entryId: string; roomId: string; agentKey: string; grantId: string; supervisorGrant: string;
  grantGeneration: number; apiUrl: string; daemonGeneration: number;
  hostId: string; installationId: string; expiresAt: string;
};
type InstalledOpenModelCredential = {
  entryId: string;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  daemonGeneration: number;
};
/** A short-lived, process-only worker bearer.  It is intentionally never durable. */
type CachedWorkerAuthorization = {
  entryId: string; roomId: string; agentKey: string; workAttemptId: string | null;
  grantId: string; grantGeneration: number; daemonGeneration: number; apiUrl: string;
  agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; mintedAtMs: number;
};
type BootstrapOperation = {
  controller: AbortController;
  phase: "observing" | "committing";
  operation: Promise<unknown>;
};

const MAX_TURN_CONTROL_CORRECTION_BYTES = 32 * 1024;
const MAX_TURN_CONTROL_ACTION_ID_BYTES = 256;
const TURN_CONTROL_ADMISSION_WINDOW_MS = 60_000;
const MAX_NEW_TURN_CONTROLS_PER_WINDOW = 24;
// Ephemeral per-agent live feed: how many recent events to retain in memory,
// and the most to return in one long-poll response (bounded to fit the
// control socket's 64 KB frame; the client re-polls for the remainder).
const AGENT_STREAM_BUFFER_LIMIT = 400;
const AGENT_STREAM_MAX_BATCH = 64;
const WORKER_BEARER_ROTATION_LEAD_MS = 60_000;
const HOST_GRANT_TTL_MS = 24 * 60 * 60 * 1_000;
const HOST_GRANT_RENEWAL_LEAD_MS = 60 * 60 * 1_000;
// Electron calls the bootstrap admission with a dedicated 45s deadline. Keep
// the admission boundary inside that window: after Electron gives up, a late
// first-tail write would be both surprising and hard to surface to the user.
// The envelope must hold two sequential cloud round-trips (worker mint with
// retries, then the first room-tail read); its 2.5s predecessor aborted real
// launches on mobile networks and orphaned their durable claims as paused.
const BOOTSTRAP_ROOM_INGRESS_TIMEOUT_MS = 40_000;
// One HTTPS round-trip on a degraded network routinely exceeds 2s; a mint
// attempt that times out burns a server-side session, so give each attempt a
// realistic budget instead of retrying a deadline that cannot be met.
const WORKER_MINT_TIMEOUT_MS = 10_000;
const WORKER_MINT_MAX_ATTEMPTS = 3;
const WORKER_MINT_RETRY_DELAY_MS = 100;
const WORKER_MINT_FALLBACK_FRESH_MS = 2 * 60_000;
const WORKER_BIND_MAX_ATTEMPTS = 3;
const WORKER_BIND_RETRY_DELAYS_MS = [1_000, 3_000] as const;
export const CONTINUATION_REPAIR_EXHAUSTED_ERROR =
  "The replacement conversation also became unavailable before a model turn started. Automatic recovery stopped to prevent a retry loop.";

export function continuationRepairMissingContinuation(
  previousRepair: Pick<ProviderContinuationRepair, "inbox_item_id" | "phase" | "missing_continuation"> | null,
  inboxItemId: string,
  currentContinuation: string,
): string {
  return previousRepair?.inbox_item_id === inboxItemId
    && previousRepair.phase !== "committed"
    ? previousRepair.missing_continuation
    : currentContinuation;
}

export function continuationRepairExhaustionNeedsPersistence(lastError: string | null): boolean {
  return lastError !== CONTINUATION_REPAIR_EXHAUSTED_ERROR;
}

function schedulerErrorDetail(error: unknown, depth = 0): string {
  if (depth > 3) return "nested error omitted";
  if (!(error instanceof Error)) return redactCredentialText(String(error || "unknown error")).value;
  const cause = (error as Error & { cause?: unknown }).cause;
  const detail = cause === undefined ? error.message : `${error.message}; cause: ${schedulerErrorDetail(cause, depth + 1)}`;
  return redactCredentialText(detail).value;
}

function retryableWorkerMintFailure(error: unknown): boolean {
  if (!(error instanceof SupervisorGrantRequestError)) return true;
  return error.status >= 500 || [408, 425, 429].includes(error.status);
}

function authoritativeRoomJoinRejection(error: unknown): boolean {
  return error instanceof SupervisorGrantRequestError
    && [400, 401, 403, 404, 409, 422].includes(error.status);
}

class WorkerCredentialMintError extends Error {
  constructor(
    readonly attempts: number,
    readonly retryable: boolean,
    cause: unknown,
  ) {
    super(`Worker credential mint failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${schedulerErrorDetail(cause)}`, { cause });
    this.name = "WorkerCredentialMintError";
  }
}

function exhaustedTransientWorkerMint(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof WorkerCredentialMintError) return current.retryable;
    if (!(current instanceof Error)) return false;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

const PROVIDER_START_RETRY_LIMIT = 3;
const WORKER_MINT_RECOVERY_RETRY_LIMIT = 5;

/** Provider adapters mark launch timeouts that a fresh attempt may resolve. */
function transientProviderStartFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if ((current as { transientProviderStart?: unknown } | null)?.transientProviderStart === true) return true;
    if (!(current instanceof Error)) return false;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Provider adapters mark a resume failure where the saved process is provably
 * gone (attach returned terminal identity). Resume can never reattach it, so
 * the daemon recovers by starting a fresh runtime generation instead of
 * retrying resume against a corpse — bounded by the crash-loop machinery.
 */
function providerRuntimeGoneFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if ((current as { providerRuntimeGone?: unknown } | null)?.providerRuntimeGone === true) return true;
    if (!(current instanceof Error)) return false;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

type DaemonTurnControlResult = ProviderTurnControlResult & {
  entryId: string;
  workAttemptId: string;
  executionGenerationId: string;
  actionId: string;
  duplicate: boolean;
  stages: Array<"delivered" | "interrupting" | "applied" | "resumed" | "already_applied">;
};

export type DaemonReconcileInput = Omit<ReconcilerExecutionInput, "desiredState" | "observedState" | "condition" | "exitsInWindow" | "nextRestartAtMs"> & {
  /** Durable provider-action identity; reused ticks must keep this value. */
  reconciliationActionId: string;
  reconciliationActionSequence: number;
};

class ReplacementListenerInstallError extends Error {}
class DeliveryCutoverObservationDetached extends Error {}


export class SupervisorDaemon {
  private manifestGeneration = 0;
  private readonly singleton: DaemonSingleton;
  private readonly store: ManifestStore;
  private readonly audit: AuditLog;
  private readonly durability: WorkDurabilityStore;
  private readonly provisioner: WorkspaceProvisioner;
  private readonly ephemeralProvisioner: EphemeralWorkspaceProvisioner;
  private readonly gitCommand: GitCommand;
  private readonly workerBindings: WorkerBindingStore;
  /** Shares the daemon's SQLite durability path; delivery orchestration owns no secrets. */
  private readonly supervisedInbox: SupervisedAgentInboxStore;
  private readonly supervisedDelivery: SupervisedAgentDelivery | null;
  private readonly socket: DaemonControlSocket;
  private readonly reconciliationTicks = new Map<string, Promise<void>>();
  private readonly scheduledConvergence = new Map<string, Promise<{ dispose: () => Promise<void> }>>();
  private readonly scheduledConvergenceCancels = new Map<string, () => void>();
  private manifestMutation: Promise<void> = Promise.resolve();
  private readonly liveHandles = new Map<string, ProviderActionHandle>();
  private readonly liveDisposers = new Map<string, Array<() => void>>();
  private readonly convergenceRequests = new Map<string, Promise<void>>();
  /**
   * Control requests must be able to fence a launch while its per-entry
   * reconciliation lane is awaiting remote authorization or capabilities.
   * They therefore cannot rely on that same lane for ordering.
   */
  private readonly entryControlEpochs = new Map<string, number>();
  private readonly providerStreamQueues = new Map<string, Promise<void>>();
  private readonly cursorCheckpointQueues = new Map<string, Promise<void>>();
  private readonly providerCallbacks = new Set<Promise<void>>();
  /** Handoff drains only dispatches that crossed the native-effect boundary. */
  private readonly providerDispatchReservations = new Set<Promise<void>>();
  /** Short local exactly-once journal admissions/completions. External tool
   * callbacks are never included; their durable executing record survives. */
  private readonly boundedEffectJournalReservations = new Set<Promise<void>>();
  /** Fatal returned-handle cleanup failure permanently blocks authority release. */
  private fatalProviderDispatchError: unknown = null;
  private readonly activeProviderDispatches = new Map<symbol, {
    entryId: string; executionGenerationId: string; daemonGeneration: number;
  }>();
  private readonly terminalFenceRequests = new WeakMap<ProviderActionHandle, Promise<void>>();
  private readonly turnControlRequests = new Map<string, {
    input: {
      entryId: string; daemonGeneration: number; roomId: string;
      workAttemptId: string; executionGenerationId: string; providerContinuationId: string;
      providerTurnId: string; inboxItemId: string; sourceMessageId: string;
      actionId: string; actionSequence: number; correction: string | null;
    };
    operation: Promise<DaemonTurnControlResult>;
  }>();
  private readonly deliveryCutoverRequests = new Map<string, Promise<void>>();
  private readonly deliveryCutoverControllers = new Map<string, AbortController>();
  private readonly turnControlActiveEntries = new Set<string>();
  private readonly turnControlAdmissions = new Map<string, number[]>();
  private readonly lifecycleActiveEntries = new Set<string>();
  /** A lifecycle edge waits only for room membership work that already
   * crossed its in-memory admission check. It must never wait behind unrelated
   * provider launch/capability work on the broader per-entry lane. */
  private readonly activeRoomMoveReconciliations = new Map<string, Promise<void>>();
  /** Wake callers queued on the broad entry lane as soon as lifecycle fencing
   * starts; their queued callback later observes the same fence and no-ops. */
  private readonly roomMoveExclusionWaiters = new Map<string, Set<() => void>>();
  private readonly recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly liveBindingIdentities = new Map<string, LiveBindingIdentity>();
  private readonly pendingResumeBindings = new Map<string, PendingResumeBinding>();
  /** Installed by the desktop over the local socket; intentionally never serialized. */
  private readonly hostGrants = new Map<string, InstalledHostGrant>();
  /** Open Model endpoint authority is decrypted by Electron and held here only for this daemon generation. */
  private readonly openModelCredentials = new Map<string, InstalledOpenModelCredential>();
  /** Latest successful bootstrap/launch mint, fenced to one effective grant and attempt. */
  private readonly cachedWorkerAuthorizations = new Map<string, CachedWorkerAuthorization>();
  /**
   * Post-launch room binding is retried against one exact provider generation.
   * This state is deliberately process-only: durable manifest copy exposes the
   * current attempt and failure, while a successor safely starts a fresh
   * bounded retry series after reattaching the same persisted provider.
   */
  private readonly workerBindingRecoveryAttempts = new Map<string, {
    executionGenerationId: string;
    attempts: number;
  }>();
  /**
   * Consecutive transient provider-start failures per entry. A launch that
   * times out is retried automatically a bounded number of times instead of
   * parking the entry in "starting" until the next unrelated RPC arrives.
   */
  private readonly providerStartRetryAttempts = new Map<string, number>();
  /** Consecutive worker-mint recovery retries per entry; bounded, reset on success. */
  private readonly workerMintRecoveryRetryAttempts = new Map<string, number>();
  /** Initial-tail reads are authority-bearing admission operations. */
  private readonly bootstrapOperations = new Set<BootstrapOperation>();
  private readonly nowMs: () => number;
  private readonly setRecoveryTimeout: typeof setTimeout;
  private readonly clearRecoveryTimeout: typeof clearTimeout;
  private manifestCommit: Promise<void> = Promise.resolve();
  private readonly startedAt = new Date().toISOString();
  /** Ordered within one singleton generation; snapshots coalesce lower-level writes. */
  private stateSequence = 1;
  private readonly stateWaiters = new Set<() => void>();
  /** Ephemeral per-agent live feed (not persisted): entryId -> ring buffer + waiters. */
  private readonly agentStreams = new Map<string, {
    sequence: number;
    generation: number;
    generationStartSequence: number;
    events: DaemonAgentStreamEvent[];
    ended: boolean;
  }>();
  private readonly agentStreamWaiters = new Map<string, Set<() => void>>();
  private handoffScheduled = false;
  private handoffTeardownScheduled = false;
  /** Resolves only once this daemon has relinquished every authority surface. */
  private readonly handoffCompletion: Promise<void>;
  private resolveHandoffCompletion!: () => void;
  private rejectHandoffCompletion!: (error: unknown) => void;

  constructor(paths: DaemonPaths = defaultDaemonPaths(), private readonly platform = process.platform, private readonly providerPort?: ProviderActionPort, private readonly autoConverge = providerPort?.constructor.name === "CodexProviderActionPort", private readonly nativeHeartbeatIntervalMs = 15_000, private readonly controlRequestBarrier?: (request: DaemonRequest) => Promise<void>, recoveryClock: RecoveryClock = {}, private readonly supervisedDeliveryHttp: SupervisedDeliveryHttp = productionSupervisedDeliveryHttp, private readonly supervisorGrantHttp: SupervisorGrantHttp = productionSupervisorGrantHttp) {
    this.handoffCompletion = new Promise<void>((resolve, reject) => {
      this.resolveHandoffCompletion = resolve;
      this.rejectHandoffCompletion = reject;
    });
    // A library consumer may prepare a handoff without awaiting its completion.
    // Keep the rejection observed while preserving it for waitForHandoff().
    void this.handoffCompletion.catch(() => undefined);
    this.singleton = new DaemonSingleton(paths.lockPath, platform);
    this.store = new ManifestStore(paths.manifestPath, paths.legacyManifestPath);
    this.audit = new AuditLog(paths.auditPath);
    const root = paths.workspaceRoot ?? dirname(paths.manifestPath);
    const gitCommand = createGitCommand(root);
    this.gitCommand = gitCommand;
    this.durability = new WorkDurabilityStore(
      paths.attemptsPath ?? `${paths.manifestPath}.attempts`,
      paths.attemptsRoot ?? `${paths.manifestPath}.attempt-data`,
      undefined,
      `${root}/worktrees`,
      undefined,
      gitCommand,
      undefined,
      undefined,
      undefined,
      paths.manifestPath,
    );
    this.provisioner = new WorkspaceProvisioner(root, gitCommand);
    this.ephemeralProvisioner = new EphemeralWorkspaceProvisioner(root);
    this.workerBindings = new WorkerBindingStore(
      paths.workerBindingsPath ?? `${paths.manifestPath}.worker-bindings`,
      (commit) => this.fenceDaemonCommit(commit),
      paths.manifestPath,
    );
    // Inbox state belongs to the canonical daemon database. The worker-binding
    // path is a legacy JSON import source and must never become a second SQLite
    // authority for delivery receipts.
    this.supervisedInbox = new SupervisedAgentInboxStore(
      paths.manifestPath,
      undefined,
      () => this.notifyStateChanged(),
    );
    this.supervisedDelivery = providerPort
      ? new SupervisedAgentDelivery(
        this.supervisedInbox,
        providerPort,
        supervisedDeliveryHttp,
        (authority, scope) => this.isExactSupervisedDeliveryAuthority(authority, scope),
        undefined,
        undefined,
        undefined,
        (input) => this.commitPreparedRoomMove(input),
        async (authority) => {
          if (!await this.isExactSupervisedDeliveryAuthority(authority)) {
            throw new Error("The supervised delivery authority changed before resolving its turn configuration.");
          }
          const configuration = await this.store.getAgentConfiguration(authority.agentId);
          if (!configuration) throw new Error("The exact agent no longer exists.");
          if (!await this.isExactSupervisedDeliveryAuthority(authority)) {
            throw new Error("The supervised delivery authority changed while resolving its turn configuration.");
          }
          return { charter: configuration.charter };
        },
        (input) => this.restoreMissingProviderContinuation(input),
        (input) => this.checkpointDynamicProviderState(input),
        (input) => this.checkpointPreparedCursorTurn(input),
      )
      : null;
    const controlOperations = {
      acknowledgeInspectorRoomMoveSourceRevocation: this.acknowledgeInspectorRoomMoveSourceRevocation.bind(this),
      activateLegacyLane: this.activateLegacyLane.bind(this),
      appendActivity: this.appendActivity.bind(this),
      bindWorkerSession: this.bindWorkerSession.bind(this),
      bootstrapRoomIngress: (input) => this.beginBootstrap(this.bootstrapRoomIngress.bind(this), input),
      borrowWorkerCredential: this.borrowWorkerCredential.bind(this),
      checkpointWorkerCursor: this.checkpointWorkerCursor.bind(this),
      commitInspectorRoomMove: this.commitInspectorRoomMove.bind(this),
      compareAndSetDesiredState: this.compareAndSetDesiredState.bind(this),
      completeBoundedEffect: this.completeBoundedEffect.bind(this),
      controlTurn: this.controlTurn.bind(this),
      entryWithDerivedLiveness: this.entryWithDerivedLiveness.bind(this),
      getAgentConfiguration: this.getAgentConfiguration.bind(this),
      getAgentInspectorDetail: this.getAgentInspectorDetail.bind(this),
      getCurrentInspectorRoomMove: this.getCurrentInspectorRoomMove.bind(this),
      getInspectorRoomMove: this.getInspectorRoomMove.bind(this),
      installHostGrant: this.installHostGrant.bind(this),
      installOpenModelCredential: this.installOpenModelCredential.bind(this),
      installWorkerCredential: this.installWorkerCredential.bind(this),
      listManifest: async () => this.entriesWithDerivedLiveness((await this.store.load()).entries),
      prepareBoundedEffect: this.prepareBoundedEffect.bind(this),
      prepareHandoff: this.prepareHandoff.bind(this),
      prepareInspectorRoomMove: this.prepareInspectorRoomMove.bind(this),
      purgeAgent: this.purgeAgent.bind(this),
      putManifestEntry: this.putManifestEntry.bind(this),
      readAttempt: this.readAttempt.bind(this),
      recoverAgentRuntime: this.recoverAgentRuntime.bind(this),
      releaseLegacyLane: this.releaseLegacyLane.bind(this),
      reserveLegacyLane: this.reserveLegacyLane.bind(this),
      resolveTurnControl: this.resolveTurnControl.bind(this),
      restoreAgentConversation: this.restoreAgentConversation.bind(this),
      retireAgent: this.retireAgent.bind(this),
      retryRoomDelivery: this.retryRoomDelivery.bind(this),
      rollbackInspectorRoomMove: this.rollbackInspectorRoomMove.bind(this),
      setDesiredState: this.setDesiredState.bind(this),
      setDisplayName: this.setDisplayName.bind(this),
      skipRoomDelivery: this.skipRoomDelivery.bind(this),
      shutdownIfIdle: this.shutdownIfIdle.bind(this),
      status: this.status.bind(this),
      updateAgentConfiguration: this.updateAgentConfiguration.bind(this),
      updateWorkplaceLiveness: this.updateWorkplaceLiveness.bind(this),
      verifyWorkerSession: this.verifyWorkerSession.bind(this),
      watchAgentStream: this.watchAgentStream.bind(this),
      watchState: this.watchState.bind(this),
    } satisfies DaemonControlOperations;
    this.socket = new DaemonControlSocket(
      paths.socketPath,
      createDaemonControlRequestHandler({
        assertCurrent: () => this.singleton.assertCurrent(),
        currentGeneration: () => this.singleton.currentGeneration,
        isHandoffScheduled: () => this.handoffScheduled,
        requestBarrier: this.controlRequestBarrier,
      }, controlOperations),
      async (error) => { if (error instanceof DaemonFenceLostError) await this.stop(); },
    );
    this.nowMs = recoveryClock.nowMs ?? Date.now;
    this.setRecoveryTimeout = recoveryClock.setTimeout ?? setTimeout;
    this.clearRecoveryTimeout = recoveryClock.clearTimeout ?? clearTimeout;
  }

  async start(): Promise<void> {
    assertMacOS(this.platform);
    await this.singleton.acquire();
    this.durability.bindSupervisorFence(this.supervisorFenceIdentity());
    this.manifestGeneration = (await this.store.load()).generation;
    await this.supervisedInbox.normalizeInterruptedEffects();
    await this.quarantineDuplicateSupervisedLaneOwners();
    await this.recoverTurnControls();
    await this.recoverOrphanedLegacyReservations();
    await this.reconcilePreparedRoomMoves();
    await this.recoverPreparedPurges();
    await this.recoverEphemeralWorkspaces();
    await this.socket.start();
    for (const entry of (await this.store.load()).entries) {
      void this.startSupervisedDelivery(entry.id).catch(() => undefined);
    }
    if (this.providerPort && this.autoConverge) {
      for (const entry of (await this.store.load()).entries) this.requestConvergence(entry.id);
    }
  }

  private async recoverTurnControls(): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const recoveredAt = new Date().toISOString();
      let changed = false;
      const entries: DaemonManifestEntry[] = [];
      for (const entry of manifest.entries) {
        const control = entry.turn_control;
        if (!control || control.status === "completed") { entries.push(entry); continue; }

        let correctionText = control.correction_text?.trim() || null;
        let correctionStrategy = control.correction_strategy ?? null;
        let exactLegacyCorrectionApplied = false;
        // The predecessor implementation could enqueue the correction before
        // it checkpointed the journal payload. That exact, action-derived row
        // is trustworthy recovery evidence; arbitrary room text is not.
        if (entry.delivery_mode === "daemon_inbox" && control.has_correction) {
          const legacyCorrection = await this.supervisedInbox.getBySourceMessage(
            entry.id,
            entry.room_id,
            `correction:${control.action_id}`,
          ).catch(() => null);
          const source = legacyCorrection?.source_message;
          const sourceRecord = source && typeof source === "object" && !Array.isArray(source)
            ? source as Record<string, unknown>
            : null;
          const sender = sourceRecord?.sender && typeof sourceRecord.sender === "object" && !Array.isArray(sourceRecord.sender)
            ? sourceRecord.sender as Record<string, unknown>
            : null;
          const recoveredText = typeof sourceRecord?.text === "string" ? sourceRecord.text.trim() : "";
          const exactLegacyCorrection = Boolean(
            recoveredText
            && sender?.kind === "supervisor_correction"
            && legacyCorrection?.activation?.decision === "activate"
            && legacyCorrection.activation.reason === "human_correction"
            && legacyCorrection.activation.addressed === true
            && (!correctionText || correctionText === recoveredText)
            && (!correctionStrategy || correctionStrategy === "native" || correctionStrategy === "stop_then_resend"),
          );
          if (exactLegacyCorrection) {
            correctionText = recoveredText;
            correctionStrategy = "stop_then_resend";
            // In the predecessor implementation this deterministic row was
            // inserted only after native Stop and A settlement. Its existence
            // is exact durable completion evidence, not work to Stop again.
            // Preserve the row in every state (including active/blocked/final)
            // and tombstone the old journal without touching FIFO authority.
            exactLegacyCorrectionApplied = true;
          }
        }
        // Only a pre-dispatch/retryable legacy daemon action can be migrated
        // from native correction to the bounded Stop + FIFO correction model.
        // A dispatching/uncertain action may already have produced the native
        // effect and must retain its original semantics for operator review.
        if (entry.delivery_mode === "daemon_inbox"
          && control.has_correction
          && correctionText
          && ["prepared", "retryable"].includes(control.status)
          && (correctionStrategy === null || correctionStrategy === "native")) {
          correctionStrategy = "stop_then_resend";
        } else if ((entry.delivery_mode ?? "mcp_polling") !== "daemon_inbox"
          && control.has_correction
          && correctionText
          && correctionStrategy === null
          && ["prepared", "retryable"].includes(control.status)) {
          correctionStrategy = "native";
        }

        const missingCorrectionIntent = control.has_correction && (!correctionText || !correctionStrategy);
        const retireWithoutClaimingEffect = !exactLegacyCorrectionApplied && (control.status === "prepared"
          ? !control.has_correction || missingCorrectionIntent
          : control.status === "retryable" && missingCorrectionIntent);
        const nextStatus = exactLegacyCorrectionApplied || retireWithoutClaimingEffect
          ? "completed" as const
          : control.status === "prepared"
            ? "retryable" as const
            : control.status === "dispatching"
              ? "uncertain" as const
              : control.status;
        const nextError = exactLegacyCorrectionApplied
          ? "Recovered the predecessor supervisor's exact durable correction row; no provider control or FIFO mutation was replayed."
          : retireWithoutClaimingEffect
          ? control.has_correction
            ? "Supervisor restarted before a native effect was proven. The legacy correction payload was not durable, so no effect was claimed; reissue the correction."
            : "Supervisor restarted before native dispatch. The unapplied Stop was retired and the supervised lane was recovered."
          : control.status === "dispatching"
            ? "Supervisor restarted after native dispatch began; verify the provider outcome before resolving the action."
            : control.status === "prepared"
              ? correctionStrategy === "stop_then_resend"
                ? "Supervisor restarted before native dispatch; the accepted correction will retry through the daemon's bounded FIFO."
                : "Supervisor restarted before native dispatch; the exact action is safe to retry."
              : missingCorrectionIntent && control.status === "uncertain"
                ? "The native effect is uncertain and the legacy correction payload is unavailable. Resolve the effect; if it was not applied, reissue the correction."
                : control.error;
        const controlChanged = nextStatus !== control.status
          || correctionText !== (control.correction_text?.trim() || null)
          || correctionStrategy !== (control.correction_strategy ?? null)
          || nextError !== control.error
          || control.operator_resolution != null;
        if (!controlChanged) { entries.push(entry); continue; }
        changed = true;
        entries.push({
          ...entry,
          reconciliation: exactLegacyCorrectionApplied || retireWithoutClaimingEffect
            ? rememberCompletedControlAction(
              advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()),
              control.action_id,
            )
            : entry.reconciliation,
          turn_control: {
            ...control,
            correction_text: correctionText,
            correction_strategy: correctionStrategy,
            operator_resolution: null,
            status: nextStatus,
            interrupted: exactLegacyCorrectionApplied ? true : retireWithoutClaimingEffect ? false : control.interrupted,
            resumed: exactLegacyCorrectionApplied ? true : retireWithoutClaimingEffect ? false : control.resumed,
            state: exactLegacyCorrectionApplied
              ? entry.observed_state === "working" ? "working" as const : "idle" as const
              : retireWithoutClaimingEffect
              ? entry.observed_state === "working" ? "working" as const : "idle" as const
              : control.state,
            stages: exactLegacyCorrectionApplied
              ? ["delivered", "applied", "resumed"]
              : retireWithoutClaimingEffect ? [] : control.stages,
            error: nextError,
            updated_at: recoveredAt,
          },
        });
      }
      if (!changed) return;
      const next = await this.writeManifest(this.manifestGeneration, entries, manifest.legacy_lane_owners);
      this.manifestGeneration = next.generation;
    });
  }

  async stop(): Promise<void> {
    // Stop is final for this daemon instance. Fence late delivery/cutover
    // continuations before awaiting any drain so they cannot retain a socket
    // or SQLite handle after the caller has observed shutdown.
    this.handoffScheduled = true;
    this.supervisedDelivery?.fence();
    this.wakeRoomMoveReconciliationWaiters();
    this.notifyStateChanged();
    this.hostGrants.clear();
    this.openModelCredentials.clear();
    this.cachedWorkerAuthorizations.clear();
    await this.fenceAndDrainDeliveryCutovers();
    await this.supervisedDelivery?.fenceAndDrain();
    await this.fenceAndDrainRoomMoveReconciliations();
    await Promise.all([...this.boundedEffectJournalReservations]);
    for (const timer of this.recoveryTimers.values()) this.clearRecoveryTimeout(timer);
    this.recoveryTimers.clear();
    await Promise.all([...this.scheduledConvergence.values()].map(async (scheduled) => (await scheduled).dispose()));
    await Promise.all([...this.convergenceRequests.values()]);
    for (const disposers of this.liveDisposers.values()) for (const dispose of disposers) dispose();
    this.liveDisposers.clear();
    await Promise.all([...this.providerCallbacks]);
    await this.socket.stop();
    await this.serializeManifestCommit(() => this.singleton.release());
    await this.store.close();
    await this.durability.close();
    await this.workerBindings.close();
    await this.supervisedInbox.close();
  }

  /**
   * Wait for a requested version handoff to finish. This is intentionally a
   * daemon-lifecycle promise rather than a socket response: prepare_handoff
   * must acknowledge before it tears down the connection carrying that reply.
   */
  async waitForHandoff(): Promise<void> {
    await this.handoffCompletion;
  }

  /**
   * Version handoff must release daemon authority independently of provider or
   * network callback latency. Provider work survives; only this daemon's
   * observers and control authority are detached.
   */
  private async stopForHandoff(): Promise<void> {
    // Fence first. Any callbacks that outlive this method are prevented from
    // committing daemon-owned state by fenceDaemonCommit().
    this.hostGrants.clear();
    this.openModelCredentials.clear();
    this.cachedWorkerAuthorizations.clear();
    this.wakeRoomMoveReconciliationWaiters();
    const failures: unknown[] = [];
    try { await this.fenceAndDrainDeliveryCutovers(); } catch (error) { failures.push(error); }
    try { await this.supervisedDelivery?.fenceAndDrain(); } catch (error) { failures.push(error); }
    try { await this.fenceAndDrainRoomMoveReconciliations(); } catch (error) { failures.push(error); }
    const captureSync = (operation: () => void): void => {
      try { operation(); } catch (error) { failures.push(error); }
    };
    for (const cancel of this.scheduledConvergenceCancels.values()) captureSync(cancel);
    this.scheduledConvergenceCancels.clear();
    for (const timer of this.recoveryTimers.values()) captureSync(() => this.clearRecoveryTimeout(timer));
    this.recoveryTimers.clear();
    for (const scheduled of this.scheduledConvergence.values()) {
      void scheduled.then(({ dispose }) => dispose()).catch(() => undefined);
    }
    this.scheduledConvergence.clear();
    // Remote grant/capability waits remain freely cancellable, but once a
    // native provider dispatch begins its exact returned identity must be
    // persisted before the shared stores are closed for successor attach.
    if (this.fatalProviderDispatchError) throw this.fatalProviderDispatchError;
    await Promise.all([...this.providerDispatchReservations]);
    if (this.fatalProviderDispatchError) throw this.fatalProviderDispatchError;
    await Promise.all([...this.boundedEffectJournalReservations]);
    for (const disposers of this.liveDisposers.values()) for (const dispose of disposers) captureSync(dispose);
    this.liveDisposers.clear();
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
    // Existing convergence/provider callbacks are generation-fenced below.
    // Do not await them: a wedged native transport must not block an upgrade.
    this.convergenceRequests.clear();
    this.providerCallbacks.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Supervisor handoff cleanup did not complete cleanly.");
    }
  }

  /**
   * Retries one known blocked receipt. Every identity in the renderer request
   * is compared with the currently-owned runtime before the in-memory bearer
   * is read, so a historical binding cannot reanimate a replacement worker.
   */
  private async retryRoomDelivery(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }): Promise<void> {
    for (const [field, value] of Object.entries(input)) {
      if ((typeof value === "string" && !value.trim()) || (field === "daemonGeneration" && !Number.isSafeInteger(value))) {
        throw new Error(`Exact room delivery retry ${field} is required.`);
      }
    }
    if (!this.supervisedDelivery || !this.providerPort?.runRoomTurn) {
      throw new Error("This supervisor does not support room delivery retry.");
    }
    if (input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("The supervisor generation changed; refresh before retrying.");
    }
    const entry = await this.store.getEntry(input.entryId);
    const handle = this.liveHandles.get(input.entryId);
    const binding = await this.workerBindings.get(input.entryId);
    if (!entry || !handle || !binding
      || entry.room_id !== input.roomId
      || entry.delivery_mode !== "daemon_inbox"
      || entry.work_attempt_id !== input.workAttemptId
      || entry.provider_ref?.execution_generation_id !== input.executionGenerationId
      || binding.room_id !== input.roomId
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId
      || binding.agent_session_id !== input.agentSessionId) {
      throw new Error("The room delivery binding is stale; refresh before retrying.");
    }
    const credential = await this.workerBindings.credentialFor(binding);
    if (!credential) throw new Error("Waiting for desktop credential handoff before retrying delivery.");
    const agent = {
      agentId: entry.id, roomId: binding.room_id, provider: entry.provider, apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id, bearer: credential, handle,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: handle.providerContinuationId,
      providerConnection: handle.providerConnection ?? null,
      executionGenerationId: binding.execution_generation_id, daemonGeneration: this.singleton.currentGeneration,
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    if (!await this.isExactSupervisedDeliveryAuthority({
      agentId: agent.agentId, roomId: agent.roomId, provider: agent.provider, apiUrl: agent.apiUrl,
      agentSessionId: agent.agentSessionId, bearer: agent.bearer, handle: agent.handle,
      workAttemptId: agent.handle.workAttemptId, executionGenerationId: agent.executionGenerationId,
      daemonGeneration: agent.daemonGeneration,
      providerContinuationId: agent.handle.providerContinuationId,
      providerConnection: agent.handle.providerConnection ?? null,
    })) throw new Error("The room delivery binding is no longer current; refresh before retrying.");
    await this.supervisedDelivery.retry(agent, input.sourceMessageId);
  }

  private async restoreAgentConversation(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }): Promise<void> {
    if (!this.supervisedDelivery || !this.providerPort?.repairContinuation) {
      throw new Error("This supervisor cannot restore provider conversations.");
    }
    const agent = await this.resolveExactRoomDeliveryControlAgent(input, true);
    await this.supervisedDelivery.restoreConversation(agent, input.sourceMessageId);
  }

  private async skipRoomDelivery(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }): Promise<void> {
    if (!this.supervisedDelivery) throw new Error("This supervisor cannot skip room delivery.");
    const agent = await this.resolveExactRoomDeliveryControlAgent(input, false);
    await this.supervisedDelivery.skipMessage(agent, input.sourceMessageId);
  }

  private async resolveExactRoomDeliveryControlAgent(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }, requireHandle: boolean): Promise<SupervisedIngressAgent> {
    for (const [field, value] of Object.entries(input)) {
      if ((typeof value === "string" && !value.trim()) || (field === "daemonGeneration" && !Number.isSafeInteger(value))) {
        throw new Error(`Exact room delivery control ${field} is required.`);
      }
    }
    if (input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("The supervisor generation changed; refresh the agent before continuing.");
    }
    const entry = await this.store.getEntry(input.entryId);
    const handle = this.liveHandles.get(input.entryId) ?? null;
    const binding = await this.workerBindings.get(input.entryId);
    if (!entry || !binding || (requireHandle && !handle)
      || entry.room_id !== input.roomId
      || entry.desired_state !== "running"
      || entry.delivery_mode !== "daemon_inbox"
      || entry.work_attempt_id !== input.workAttemptId
      || entry.provider_ref?.execution_generation_id !== input.executionGenerationId
      || binding.room_id !== input.roomId
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId
      || binding.agent_session_id !== input.agentSessionId
      || (handle && (handle.workAttemptId !== input.workAttemptId
        || handle.providerContinuationId !== entry.provider_ref?.provider_continuation_id))) {
      throw new Error("The room delivery authority is stale; refresh the agent before continuing.");
    }
    const credential = await this.workerBindings.credentialFor(binding);
    if (!credential) throw new Error("Waiting for desktop credential handoff before continuing.");
    const agent: SupervisedIngressAgent = {
      agentId: entry.id,
      roomId: binding.room_id,
      provider: entry.provider,
      charter: entry.charter,
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: credential,
      handle,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: entry.provider_ref?.provider_continuation_id ?? null,
      providerConnection: entry.provider_ref?.provider_connection ?? null,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.singleton.currentGeneration,
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    if (!await this.isExactSupervisedDeliveryAuthority(agent)) {
      throw new Error("The room delivery authority changed; refresh the agent before continuing.");
    }
    return agent;
  }

  /**
   * Repair one pre-turn missing provider conversation without replacing its
   * process, workspace, execution generation, worker session, or room route.
   * This lane is serialized with lifecycle convergence so persistence and
   * handle promotion cannot race a restart or handoff.
   */
  private async restoreMissingProviderContinuation(input: {
    agent: SupervisedIngressAgent;
    item: import("./supervised-agent-inbox-store.js").SupervisedInboxItem;
    manual: boolean;
  }): Promise<"restored" | "replaced" | "authority_changed" | "failed"> {
    const { agent, item } = input;
    const repairContinuation = this.providerPort?.repairContinuation?.bind(this.providerPort);
    if (!repairContinuation) return "failed";
    return this.serializeEntryTick(agent.agentId, async () => {
      if (this.handoffScheduled || agent.daemonGeneration !== this.singleton.currentGeneration) return "authority_changed";
      await this.singleton.assertCurrent();

      const previousRepair = await this.supervisedInbox.latestContinuationRepair(agent.agentId);
      const entry = await this.store.getEntry(agent.agentId);
      const handle = this.liveHandles.get(agent.agentId);
      const binding = await this.workerBindings.get(agent.agentId);
      const connection = handle?.providerConnection;
      const processIdentity = connection?.processIdentity?.trim() || null;
      const expectedPid = connection?.pid ?? handle?.pid ?? null;
      if (!entry || !handle || !binding || !entry.work_attempt_id || !entry.provider_ref
        || item.agent_id !== entry.id || item.room_id !== entry.room_id
        || item.state !== "blocked" || item.failure_code !== "provider_continuation_missing"
        || item.attempt_count !== 0 || item.provider_turn_id || item.outcome
        || binding.entry_id !== entry.id || binding.room_id !== entry.room_id
        || binding.work_attempt_id !== entry.work_attempt_id
        || binding.execution_generation_id !== entry.provider_ref.execution_generation_id
        || binding.agent_session_id !== agent.agentSessionId
        || handle.workAttemptId !== entry.work_attempt_id
        || expectedPid === null || expectedPid <= 0 || !processIdentity) {
        return "authority_changed";
      }
      const credential = await this.workerBindings.credentialFor(binding);
      if (!credential || credential !== agent.bearer) return "authority_changed";

      const durableContinuation = entry.provider_ref.provider_continuation_id;
      const currentContinuation = agent.providerContinuationId;
      if (!currentContinuation) return "failed";
      const previousCommittedForCurrentContinuation = Boolean(
        previousRepair
        && previousRepair.inbox_item_id === item.inbox_item_id
        && previousRepair.phase === "committed"
        && previousRepair.replacement_continuation === currentContinuation,
      );
      const previousRepairOnlyRematerialized = previousCommittedForCurrentContinuation
        && previousRepair!.missing_continuation === previousRepair!.replacement_continuation;
      if (previousCommittedForCurrentContinuation && !previousRepairOnlyRematerialized && !input.manual) {
        if (!continuationRepairExhaustionNeedsPersistence(item.last_error)) return "failed";
        await this.supervisedInbox.exhaustCommittedContinuationRepair(
          item.inbox_item_id,
          previousRepair!.repair_id,
          CONTINUATION_REPAIR_EXHAUSTED_ERROR,
        );
        this.notifyStateChanged();
        return "failed";
      }
      const forceReplacement = previousCommittedForCurrentContinuation
        && (previousRepairOnlyRematerialized || input.manual);
      const missingContinuation = continuationRepairMissingContinuation(
        previousRepair,
        item.inbox_item_id,
        currentContinuation,
      );
      if (!missingContinuation) return "failed";
      const replacementAlreadyDurable = previousRepair?.replacement_continuation ?? null;
      const canReconcileFailedReplacement = previousRepair?.inbox_item_id === item.inbox_item_id
        && previousRepair.phase === "failed"
        && replacementAlreadyDurable !== null
        && durableContinuation === replacementAlreadyDurable
        && handle.providerContinuationId === replacementAlreadyDurable;
      if (!input.manual
        && previousRepair?.inbox_item_id === item.inbox_item_id
        && previousRepair.phase === "failed"
        && !canReconcileFailedReplacement) {
        return "failed";
      }
      const continuationIsRepairTarget = durableContinuation === missingContinuation
        || (replacementAlreadyDurable !== null && durableContinuation === replacementAlreadyDurable);
      if (!continuationIsRepairTarget
        || !sameProviderActionConnectionIdentity(entry.provider_ref.provider_connection, connection)) {
        return "authority_changed";
      }

      const repair = await this.supervisedInbox.beginContinuationRepair({
        agent_id: entry.id,
        room_id: entry.room_id,
        inbox_item_id: item.inbox_item_id,
        daemon_generation: this.singleton.currentGeneration,
        execution_generation_id: entry.provider_ref.execution_generation_id,
        work_attempt_id: entry.work_attempt_id,
        expected_pid: expectedPid,
        expected_process_identity: processIdentity,
        missing_continuation: missingContinuation,
      });

      // A predecessor may have completed every authority-changing commit and
      // crashed before releasing the inbox row. Reconcile that fact without
      // creating or probing another thread.
      if (repair.replacement_continuation
        && durableContinuation === repair.replacement_continuation
        && handle.providerContinuationId === repair.replacement_continuation) {
        await this.supervisedInbox.commitContinuationRepair(
          repair.repair_id,
          repair.replacement_continuation,
          true,
        );
        return "restored";
      }

      if (durableContinuation !== repair.missing_continuation
        || handle.providerContinuationId !== repair.missing_continuation) {
        return "authority_changed";
      }

      try {
        const result = await repairContinuation(handle, {
          workAttemptId: entry.work_attempt_id,
          expectedProviderContinuationId: repair.missing_continuation,
          checkpointedReplacementProviderContinuationId: repair.replacement_continuation,
          forceReplacement,
          cwd: entry.workspace_path ?? "",
          launchPolicy: entry.provider_launch_policy,
          model: entry.model,
          reasoningEffort: entry.reasoning_effort ?? null,
        }, {
          checkpointReplacement: async (replacementContinuation) => {
            await this.singleton.assertCurrent();
            const checkpointed = await this.supervisedInbox.checkpointContinuationReplacement(
              repair.repair_id,
              replacementContinuation,
            );
            const current = await this.store.getEntry(entry.id);
            const currentHandle = this.liveHandles.get(entry.id);
            if (!current || currentHandle !== handle
              || current.work_attempt_id !== repair.work_attempt_id
              || current.provider_ref?.execution_generation_id !== repair.execution_generation_id
              || current.provider_ref.provider_continuation_id !== repair.missing_continuation
              || !sameProviderActionConnectionIdentity(current.provider_ref.provider_connection, handle.providerConnection)) {
              throw new Error("Provider authority changed before the replacement conversation could be committed.");
            }
            const attempt = await this.durability.getAttempt(repair.work_attempt_id);
            if (attempt.checkpoints.at(-1)?.provider_continuation_id !== replacementContinuation) {
              await this.durability.checkpoint(repair.work_attempt_id, {
                room_cursor: null,
                provider_continuation_id: replacementContinuation,
              });
            }
            await this.updateManifestEntry(entry.id, (candidate) => {
              if (candidate.work_attempt_id !== repair.work_attempt_id
                || candidate.provider_ref?.execution_generation_id !== repair.execution_generation_id
                || candidate.provider_ref.provider_continuation_id !== repair.missing_continuation
                || !sameProviderActionConnectionIdentity(candidate.provider_ref.provider_connection, handle.providerConnection)) {
                throw new Error("Provider authority changed during replacement conversation persistence.");
              }
              return {
                ...candidate,
                provider_ref: {
                  ...candidate.provider_ref,
                  provider_continuation_id: checkpointed.replacement_continuation!,
                },
              };
            });
          },
        });

        if (result.handle.workAttemptId !== repair.work_attempt_id
          || result.handle.pid !== repair.expected_pid
          || !sameProviderActionConnectionIdentity(result.handle.providerConnection, connection)
          || result.previousProviderContinuationId !== repair.missing_continuation) {
          throw new Error("Continuation repair returned a different provider process or work attempt.");
        }
        const continuityReset = result.outcome === "replaced";
        if (continuityReset) {
          const committedEntry = await this.store.getEntry(entry.id);
          if (committedEntry?.provider_ref?.provider_continuation_id !== result.replacementProviderContinuationId) {
            throw new Error("Replacement conversation was not durable before handle promotion.");
          }
          await this.installProviderHandle(entry.id, result.handle, repair.execution_generation_id);
        }
        await this.supervisedInbox.commitContinuationRepair(
          repair.repair_id,
          result.replacementProviderContinuationId,
          continuityReset,
        );
        this.notifyStateChanged();
        return continuityReset ? "replaced" : "restored";
      } catch (error) {
        const detail = redactCredentialText(error instanceof Error ? error.message : "Conversation restoration failed.").value;
        await this.supervisedInbox.failContinuationRepair(
          repair.repair_id,
          `Couldn't restore this agent's provider conversation. ${detail}`,
        ).catch(() => undefined);
        this.notifyStateChanged();
        return "failed";
      }
    });
  }

  /** Inspector reads are exact-entry scoped; a room mismatch never falls back to history. */
  private async getAgentInspectorDetail(entryId: string, roomId: string, sourceMessageId: string | null) {
    if (!entryId.trim() || !roomId.trim() || (sourceMessageId !== null && !sourceMessageId.trim())) throw new Error("Agent inspector detail requires an exact entry and room identity.");
    const entry = await this.store.getEntry(entryId);
    if (!entry) throw new Error("The exact supervisor entry is no longer present; inspector history is not queryable without its manifest fence.");
    if (entry.room_id !== roomId) throw new Error("The agent inspector room does not match the exact supervisor entry.");
    return this.supervisedInbox.detail(entryId, roomId, sourceMessageId);
  }

  private async exactActiveBoundedContext(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number; providerTurnId?: string;
  }) {
    if (!input.entryId || !input.workAttemptId || !input.executionGenerationId || input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("The supervised effect coordinates are stale.");
    }
    if (!this.supervisedDelivery) throw new Error("Supervised bounded turns are unavailable.");
    const entry = await this.store.getEntry(input.entryId);
    const handle = this.liveHandles.get(input.entryId);
    const binding = await this.workerBindings.get(input.entryId);
    const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
    if (!entry || !handle || !binding || !credential
      || entry.work_attempt_id !== input.workAttemptId
      || entry.provider_ref?.execution_generation_id !== input.executionGenerationId
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId) {
      throw new Error("The supervised effect no longer belongs to the exact live execution generation.");
    }
    const agent = {
      agentId: entry.id, roomId: entry.room_id, provider: entry.provider, deliveryMode: entry.delivery_mode ?? "mcp_polling",
      apiUrl: binding.api_url, agentSessionId: binding.agent_session_id, bearer: credential, handle,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: handle.providerContinuationId,
      providerConnection: handle.providerConnection ?? null,
      executionGenerationId: binding.execution_generation_id, daemonGeneration: this.singleton.currentGeneration,
    };
    const active = this.supervisedDelivery.activeTurn(agent);
    if (!active) throw new Error("No exact bounded room turn is currently active for this agent.");
    const inbox = await this.supervisedInbox.get(active.inboxItemId);
    if (!inbox?.provider_turn_id) throw new Error("The bounded room turn has not checkpointed its provider turn id yet.");
    const providerTurnBinding = await this.supervisedInbox.providerTurnBinding(inbox.inbox_item_id);
    if (!providerTurnBinding
      || providerTurnBinding.agent_id !== entry.id
      || providerTurnBinding.room_id !== entry.room_id
      || providerTurnBinding.work_attempt_id !== entry.work_attempt_id
      || providerTurnBinding.provider_continuation_id !== handle.providerContinuationId
      || providerTurnBinding.provider_turn_id !== inbox.provider_turn_id) {
      throw new Error("The bounded provider turn has a different or unverifiable durable authority binding.");
    }
    if ((entry.provider === "cursor" || input.providerTurnId)
      && input.providerTurnId !== inbox.provider_turn_id) {
      throw new Error("The supervised provider turn capability is stale.");
    }
    return { entry, agent, active, inbox, providerTurnBinding };
  }

  private prepareBoundedEffect(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string;
    mcpRequestId: string; toolName: string; input: unknown; mutation: boolean;
  }): Promise<Record<string, unknown>> {
    return this.reserveBoundedEffectJournal(() => this.prepareBoundedEffectOnce(input));
  }

  private async prepareBoundedEffectOnce(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string;
    mcpRequestId: string; toolName: string; input: unknown; mutation: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.mcpRequestId.trim() || !input.toolName.trim()) throw new Error("A supervised effect requires MCP request and tool identities.");
    const context = await this.exactActiveBoundedContext(input);
    const withExactRoom = (result: Record<string, unknown>): Record<string, unknown> => ({
      ...result,
      room_id: context.entry.room_id,
    });
    const args = input.input && typeof input.input === "object" && !Array.isArray(input.input) ? input.input as Record<string, unknown> : {};
    if (input.toolName === "complete_room_turn") {
      if (context.entry.provider !== "cursor") {
        throw new Error("The structured room-turn completion channel is reserved for supervised Cursor turns.");
      }
      if (!structuredRoomTurnCompletion(input.input)) {
        throw new Error("The supervised room-turn completion proposal is malformed.");
      }
    }
    if (input.toolName === "join_room") {
      const destination = typeof args.name === "string" ? args.name.trim() : "";
      if (!destination || destination.length > 1_024 || /[\u0000-\u001f\u007f]/.test(destination) || destination === context.entry.room_id) throw new Error("A room move requires a different valid destination room.");
      const prepared = await this.supervisedInbox.prepareRoomMoveEffect({
        agent_id: input.entryId,
        room_id: context.entry.room_id,
        effect_execution_generation_id: context.providerTurnBinding.origin_execution_generation_id,
        provider_turn_id: context.inbox.provider_turn_id!,
        mcp_request_id: input.mcpRequestId,
        request: input.input,
        destination_room_id: destination,
        daemon_generation: this.singleton.currentGeneration,
        work_attempt_id: context.agent.workAttemptId,
        execution_generation_id: context.agent.executionGenerationId,
        provider_continuation_id: context.agent.providerContinuationId!,
        agent_session_id: context.agent.agentSessionId,
        activating_inbox_item_id: context.inbox.inbox_item_id,
      }, (commit) => this.fenceDaemonCommit(commit));
      if (prepared.effect.state === "completed") return withExactRoom({ state: "completed", result: prepared.effect.result });
      if (prepared.effect.state === "failed") throw new Error(prepared.effect.error || "The prior supervised room move failed.");
      return withExactRoom({ state: "prepared", effect_id: prepared.effect.effect_id, action: "room_move_prepared", destination_room: destination });
    }
    const prepared = await this.supervisedInbox.prepareEffect({
      agent_id: input.entryId, room_id: context.entry.room_id,
      execution_generation_id: context.providerTurnBinding.origin_execution_generation_id,
      work_attempt_id: context.agent.workAttemptId,
      current_execution_generation_id: context.agent.executionGenerationId,
      provider_continuation_id: context.agent.providerContinuationId!,
      provider_turn_id: context.inbox.provider_turn_id!, mcp_request_id: input.mcpRequestId,
      tool_name: input.toolName, request: input.input, mutation: input.mutation,
    }, (commit) => this.fenceDaemonCommit(commit));
    if (prepared.effect.state === "completed") return withExactRoom({ state: "completed", result: prepared.effect.result });
    if (!prepared.created) {
      if (prepared.effect.state === "failed") throw new Error(prepared.effect.error || "The prior supervised effect failed.");
      if (prepared.effect.state === "uncertain") return withExactRoom({
        state: "uncertain",
        effect_id: prepared.effect.effect_id,
        mutation: prepared.effect.mutation,
        error: prepared.effect.error || "The mutating tool outcome is uncertain.",
      });
      if (prepared.effect.state === "executing") throw new Error("The prior supervised effect is still executing; refusing a duplicate side effect.");
    }
    const targetMessage = typeof args.thread_parent_id === "string" ? args.thread_parent_id : typeof args.reply_to === "string" ? args.reply_to : null;
    if ((input.toolName === "send_message" || input.toolName === "send_thread_message") && targetMessage === context.active.sourceMessageId) {
      return withExactRoom({ state: "prepared", effect_id: prepared.effect.effect_id, action: "use_final_answer", source_message_id: context.active.sourceMessageId });
    }
    const executing = await this.supervisedInbox.markEffectExecuting({
      effect_id: prepared.effect.effect_id,
      agent_id: input.entryId,
      room_id: context.entry.room_id,
      execution_generation_id: context.providerTurnBinding.origin_execution_generation_id,
      work_attempt_id: context.agent.workAttemptId,
      current_execution_generation_id: context.agent.executionGenerationId,
      provider_continuation_id: context.agent.providerContinuationId!,
      provider_turn_id: context.inbox.provider_turn_id!,
    }, (commit) => this.fenceDaemonCommit(commit));
    if (executing.state !== "executing") {
      throw new Error("The supervised effect did not acquire durable execution authority.");
    }
    return withExactRoom({ state: "prepared", effect_id: prepared.effect.effect_id, action: "execute", mutation: input.mutation });
  }

  private completeBoundedEffect(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string;
    effectId: string; result?: unknown; error?: string;
  }): Promise<{ completed: true }> {
    return this.reserveBoundedEffectJournal(() => this.completeBoundedEffectOnce(input));
  }

  private async completeBoundedEffectOnce(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string;
    effectId: string; result?: unknown; error?: string;
  }): Promise<{ completed: true }> {
    await this.singleton.assertCurrent();
    if (!Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("The supervised effect completion belongs to a stale daemon generation.");
    }
    const entry = await this.store.getEntry(input.entryId);
    if (!entry || entry.work_attempt_id !== input.workAttemptId) {
      throw new Error("The supervised effect completion lost its exact agent work authority.");
    }
    const callerProviderTurnId = input.providerTurnId.trim() || null;
    if (entry.provider === "cursor" && !callerProviderTurnId) {
      throw new Error("Cursor supervised effect completion requires its exact provider turn capability.");
    }
    await this.supervisedInbox.completeEffect({
      effect_id: input.effectId,
      result: input.result,
      error: input.error,
      expected: {
        agent_id: input.entryId,
        work_attempt_id: input.workAttemptId,
        provider_turn_id: callerProviderTurnId,
      },
    }, (commit) => this.fenceDaemonCommit(commit));
    return { completed: true };
  }

  private async commitPreparedRoomMove(input: { agent: SupervisedIngressAgent; inboxItemId: string }): Promise<void> {
    const item = await this.supervisedInbox.get(input.inboxItemId);
    if (!item?.provider_turn_id || !["acknowledged", "acknowledged_no_reply"].includes(item.state)) return;
    try {
      for (const move of await this.store.pendingRoomMoves(input.agent.agentId)) await this.reconcileRoomMove(move);
    } catch {
      // The reply is already terminal and ingress is fenced. A transient join
      // or local-store failure must retry the durable move, not fail or rerun
      // the completed provider turn.
      this.scheduleRecoveryConvergence(input.agent.agentId, 1_000);
    }
  }

  private async reconcilePreparedRoomMoves(agentId?: string): Promise<void> {
    // Repair an exact predecessor split first. Earlier builds could commit a
    // terminal move and crash before terminalizing its prepared join effect;
    // terminal moves are absent from pendingRoomMoves(), so effect-first
    // enumeration is the only complete startup worklist.
    for (const effect of await this.supervisedInbox.preparedRoomMoves(agentId)) {
      await this.reconcilePreparedRoomMove(effect).catch(() => {
        this.scheduleRecoveryConvergence(effect.agent_id, 1_000);
      });
    }
    for (const move of await this.store.pendingRoomMoves(agentId)) {
      await this.reconcileRoomMove(move).catch(() => {
        this.scheduleRecoveryConvergence(move.agent_id, 1_000);
      });
    }
  }

  private async reconcilePreparedRoomMove(effect: SupervisedEffectRecord): Promise<void> {
    const move = await this.store.getRoomMove(`room_move:${effect.effect_id}`);
    if (!move) return;
    if (move.phase === "active" || move.phase === "failed") {
      await this.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: move.agent_id,
        expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id,
        from: [move.phase],
        to: move.phase,
        error: move.error,
      }, (commit) => this.fenceDaemonCommit(commit));
      return;
    }
    await this.reconcileRoomMove(move);
  }

  /**
   * Shared room-move transaction runner for Inspector and mediated join_room.
   * Every durable edge is re-authorized against the exact provider generation;
   * a successor may adopt only the journal generation, never its runtime fence.
   */
  private async reconcileRoomMove(initial: DaemonRoomMoveRecord): Promise<DaemonRoomMoveRecord> {
    // Lifecycle/recovery announces exclusion synchronously, before draining
    // delivery. Avoid queueing a room-move continuation behind that drain: a
    // delivery callback may itself be waiting to reconcile this exact move.
    if (this.handoffScheduled || this.lifecycleActiveEntries.has(initial.agent_id)) return initial;
    let exclude!: () => void;
    const excluded = new Promise<DaemonRoomMoveRecord>((resolve) => {
      exclude = () => resolve(initial);
    });
    const waiters = this.roomMoveExclusionWaiters.get(initial.agent_id) ?? new Set<() => void>();
    waiters.add(exclude);
    this.roomMoveExclusionWaiters.set(initial.agent_id, waiters);
    const operation = this.serializeRoomMoveReconciliation(
      initial.agent_id,
      async () => initial,
      async () => {
      if (this.handoffScheduled) return initial;
      let move = await this.store.getRoomMove(initial.operation_id);
      if (!move || ["active", "failed"].includes(move.phase)) return move ?? initial;
      if (move.daemon_generation !== this.singleton.currentGeneration) {
        await this.singleton.assertCurrent();
        move = await this.store.advanceRoomMove({ operationId: move.operation_id, agentId: move.agent_id, expectedDaemonGeneration: move.daemon_generation, expectedExecutionGenerationId: move.execution_generation_id, from: [move.phase], to: move.phase, adoptDaemonGeneration: this.singleton.currentGeneration }, (commit) => this.fenceDaemonCommit(commit));
      }
      if (move.phase === "rollback_required") return this.compensateRoomMoveRollback(move);
      let entry = await this.store.getEntry(move.agent_id);
      const membershipCommitted = ["membership_committed", "rotating_credentials", "bootstrapping_destination_tail"].includes(move.phase);
      // joining_destination is already beyond the last provably pre-effect
      // edge: the remote join may have committed before a lost response or a
      // daemon crash. Any authority mismatch from this phase onward requires
      // compensation, even while local membership still names the source.
      const externalJoinMayHaveCommitted = move.phase === "joining_destination" || membershipCommitted;
      const runtimeExact = Boolean(entry && entry.desired_state === "running"
        && move.work_attempt_id && move.execution_generation_id
        && entry.work_attempt_id === move.work_attempt_id
        && entry.provider_ref?.execution_generation_id === move.execution_generation_id);
      if (!entry || !runtimeExact || (membershipCommitted ? entry.room_id !== (move.remote_room_id ?? move.destination_room_id) : ![move.source_room_id, move.destination_room_id, move.remote_room_id].includes(entry.room_id))) {
        const phase = externalJoinMayHaveCommitted ? "rollback_required" : "failed";
        move = await this.store.advanceRoomMove({ operationId: move.operation_id, agentId: move.agent_id, expectedDaemonGeneration: move.daemon_generation, expectedExecutionGenerationId: move.execution_generation_id, from: [move.phase], to: phase, error: "The exact provider generation or room membership changed during the move." }, (commit) => this.fenceDaemonCommit(commit));
        if (phase === "rollback_required") this.scheduleRecoveryConvergence(move.agent_id, 1_000);
        return move;
      }
      const advance = async (from: DaemonRoomMoveRecord["phase"], to: DaemonRoomMoveRecord["phase"], extra: Partial<Pick<DaemonRoomMoveRecord, "remote_room_id" | "destination_cursor" | "source_credentials_revoked" | "error">> = {}) => {
        move = await this.store.advanceRoomMove({ operationId: move!.operation_id, agentId: move!.agent_id, expectedDaemonGeneration: move!.daemon_generation, expectedExecutionGenerationId: move!.execution_generation_id, from: [from], to, remoteRoomId: extra.remote_room_id, destinationCursor: extra.destination_cursor, sourceCredentialsRevoked: extra.source_credentials_revoked, error: extra.error }, (commit) => this.fenceDaemonCommit(commit));
      };
      const runtimeIsExact = async (roomIds: readonly string[]): Promise<boolean> => {
        if (!await this.ownsDaemonGeneration(move!.daemon_generation)) return false;
        const current = await this.store.getEntry(move!.agent_id);
        return Boolean(current && roomIds.includes(current.room_id) && current.work_attempt_id === move!.work_attempt_id
          && current.provider_ref?.execution_generation_id === move!.execution_generation_id);
      };
      const failFence = async (terminal: "failed" | "rollback_required", detail: string): Promise<DaemonRoomMoveRecord> => {
        await advance(move!.phase, terminal, { error: detail });
        if (terminal === "rollback_required") this.scheduleRecoveryConvergence(move!.agent_id, 1_000);
        return move!;
      };

      if (move.phase === "prepared") await advance("prepared", "waiting_for_current_turn");
      if (move.phase === "waiting_for_current_turn") {
        if (move.activating_inbox_item_id) {
          const item = await this.supervisedInbox.get(move.activating_inbox_item_id);
          const providerTurnBinding = item
            ? await this.supervisedInbox.providerTurnBinding(item.inbox_item_id)
            : null;
          const effect = move.effect_id && move.provider_turn_id && providerTurnBinding
            ? await this.supervisedInbox.preparedRoomMove(
              move.agent_id,
              providerTurnBinding.origin_execution_generation_id,
              move.provider_turn_id,
            )
            : null;
          const exactActivatingAuthority = Boolean(item
            && item.agent_id === move.agent_id && item.room_id === move.source_room_id
            && item.provider_turn_id === move.provider_turn_id
            && providerTurnBinding && providerTurnBinding.provider_turn_id === item.provider_turn_id
            && effect && effect.effect_id === move.effect_id && effect.room_id === move.source_room_id
            && effect.execution_generation_id === providerTurnBinding.origin_execution_generation_id);
          if (!exactActivatingAuthority) {
            return failFence("failed", "The activating provider-turn authority changed before destination membership was joined.");
          }
          if (["cancelled_by_room_move", "cancelled_by_user"].includes(item!.state)) {
            return failFence("failed", "The activating provider turn was cancelled before destination membership was joined.");
          }
          if (!["acknowledged", "acknowledged_no_reply"].includes(item!.state)) return move;
        } else {
          const receipts = await this.supervisedInbox.receipts(move.agent_id);
          if (receipts.some((receipt) => ["dispatching", "awaiting_result", "result_recovery", "publishing", "retryable"].includes(receipt.state)
            || (receipt.state === "pending" && receipt.provider_turn_id !== null))) return move;
        }
        if (!await runtimeIsExact([move.source_room_id])) return failFence("failed", "Runtime authority changed before destination membership was joined.");
        await advance("waiting_for_current_turn", "joining_destination");
      }
      if (move.phase === "joining_destination") {
        this.supervisedDelivery?.pauseIngress(move.agent_id);
        const binding = await this.workerBindings.get(move.agent_id);
        const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
        if (!binding || !credential || binding.room_id !== move.source_room_id
          || binding.work_attempt_id !== move.work_attempt_id || binding.execution_generation_id !== move.execution_generation_id
          || (move.agent_session_id !== null && binding.agent_session_id !== move.agent_session_id)) return move;
        let remoteRoomId: string;
        try {
          if (!this.supervisedDeliveryHttp.joinRoom) throw new Error("Durable room join transport is unavailable.");
          await this.assertRoomMoveExternalAuthority();
          remoteRoomId = (await this.supervisedDeliveryHttp.joinRoom({ roomId: move.destination_room_id, apiUrl: binding.api_url, bearer: credential, signal: AbortSignal.timeout(10_000) })).roomId.trim();
          await this.assertRoomMoveExternalAuthority();
          if (!remoteRoomId || remoteRoomId === move.source_room_id || remoteRoomId.length > 1_024 || /[\u0000-\u001f\u007f]/.test(remoteRoomId)) throw new Error("Destination join response omitted a valid distinct canonical room identity.");
        } catch (error) {
          if (this.handoffScheduled && error instanceof DaemonFenceLostError) throw error;
          if (!authoritativeRoomJoinRejection(error)) {
            await advance("joining_destination", "joining_destination", { error: `Destination join outcome was ambiguous and will retry: ${schedulerErrorDetail(error)}` });
            this.scheduleRecoveryConvergence(move.agent_id, 1_000);
            return move;
          }
          await advance("joining_destination", "failed", { error: `Destination join was authoritatively rejected before local membership changed: ${schedulerErrorDetail(error)}` });
          void this.startSupervisedDelivery(move.agent_id).catch(() => undefined);
          return move;
        }
        // The join target can be an alias while the server returns a
        // different canonical room id. Journal that canonical identity before
        // changing the manifest. A crash after local membership then replays
        // from joining_destination with enough durable evidence to recognize
        // the canonical room instead of falsely terminalizing the move.
        await advance("joining_destination", "joining_destination", { remote_room_id: remoteRoomId });
        entry = await this.store.getEntry(move.agent_id);
        if (!entry || entry.work_attempt_id !== move.work_attempt_id || entry.provider_ref?.execution_generation_id !== move.execution_generation_id) {
          try {
            await this.assertRoomMoveExternalAuthority();
            await this.supervisedDeliveryHttp.joinRoom({ roomId: move.source_room_id, apiUrl: binding.api_url, bearer: credential, signal: AbortSignal.timeout(10_000) });
            await this.assertRoomMoveExternalAuthority();
            await advance("joining_destination", "failed", { error: "Runtime authority changed after remote join; remote membership was rolled back to the source room." });
          } catch (error) {
            await advance("joining_destination", "rollback_required", { error: `Runtime authority changed after remote join and remote rollback failed: ${schedulerErrorDetail(error)}` });
            this.scheduleRecoveryConvergence(move.agent_id, 1_000);
          }
          return move;
        }
        if (entry.room_id === move.source_room_id) {
          const fencedMove = move;
          await this.updateManifestEntry(fencedMove.agent_id, (current) => current.work_attempt_id === fencedMove.work_attempt_id && current.provider_ref?.execution_generation_id === fencedMove.execution_generation_id && current.room_id === fencedMove.source_room_id ? {
            ...current, room_id: remoteRoomId, condition: "coordination_blocked",
            last_error: "Room membership moved; waiting for destination credential rotation.",
            workplace_liveness: { state: "unknown", observed_at: new Date().toISOString(), detail: "Destination membership committed; destination ingress is not active yet." },
            last_worker_binding: null,
          } : current);
        }
        entry = await this.store.getEntry(move.agent_id);
        if (!entry || entry.room_id !== remoteRoomId || entry.work_attempt_id !== move.work_attempt_id || entry.provider_ref?.execution_generation_id !== move.execution_generation_id) {
          try {
            await this.assertRoomMoveExternalAuthority();
            await this.supervisedDeliveryHttp.joinRoom({ roomId: move.source_room_id, apiUrl: binding.api_url, bearer: credential, signal: AbortSignal.timeout(10_000) });
            await this.assertRoomMoveExternalAuthority();
            await advance("joining_destination", "failed", { error: "Local membership commit lost its fence; remote membership was rolled back to the source room." });
          } catch (error) {
            await advance("joining_destination", "rollback_required", { error: `Local membership commit and remote rollback both failed: ${schedulerErrorDetail(error)}` });
            this.scheduleRecoveryConvergence(move.agent_id, 1_000);
          }
          return move;
        }
        await advance("joining_destination", "membership_committed", { remote_room_id: remoteRoomId });
      }
      if (move.phase === "membership_committed") {
        const binding = await this.workerBindings.get(move.agent_id);
        const destination = move.remote_room_id ?? move.destination_room_id;
        if (!binding || ![move.source_room_id, destination].includes(binding.room_id) || binding.work_attempt_id !== move.work_attempt_id || binding.execution_generation_id !== move.execution_generation_id) return failFence("rollback_required", "Credential binding changed after membership commit.");
        const activating = move.activating_inbox_item_id ? await this.supervisedInbox.get(move.activating_inbox_item_id) : null;
        await this.supervisedInbox.commitRoomMoveQueue({ operation_id: move.operation_id, agent_id: move.agent_id, old_room_id: move.source_room_id, after_fifo_sequence: activating?.fifo_sequence ?? 0 }, (commit) => this.fenceDaemonCommit(commit));
        if (!await runtimeIsExact([destination])) return failFence("rollback_required", "Runtime authority changed after membership commit.");
        await advance("membership_committed", "rotating_credentials");
      }
      if (move.phase === "rotating_credentials") {
        const destination = move.remote_room_id ?? move.destination_room_id;
        if (!await runtimeIsExact([destination])) return failFence("rollback_required", "Runtime authority changed during credential rotation.");
        // Process memory is not durable revocation evidence. Electron owns the
        // parent grant and must first acknowledge revocation of the exact
        // journalled source session, then install a destination-scoped grant
        // into this same daemon generation.
        if (!move.source_credentials_revoked || !move.agent_session_id) return move;
        const binding = await this.workerBindings.get(move.agent_id);
        const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
        const grant = this.hostGrants.get(move.agent_id) ?? null;
        if (!binding || !credential || binding.room_id !== destination
          || binding.work_attempt_id !== move.work_attempt_id || binding.execution_generation_id !== move.execution_generation_id
          || !grant || grant.entryId !== move.agent_id || grant.roomId !== destination
          || grant.daemonGeneration !== move.daemon_generation) return move;
        await advance("rotating_credentials", "bootstrapping_destination_tail");
      }
      if (move.phase === "bootstrapping_destination_tail") {
        const current = await this.store.getEntry(move.agent_id);
        const binding = await this.workerBindings.get(move.agent_id);
        const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
        const destination = move.remote_room_id ?? move.destination_room_id;
        if (!current || current.room_id !== destination || current.work_attempt_id !== move.work_attempt_id
          || current.provider_ref?.execution_generation_id !== move.execution_generation_id) return failFence("rollback_required", "Runtime authority changed before destination ingress activation.");
        if (!binding || !credential || binding.room_id !== destination || binding.work_attempt_id !== move.work_attempt_id
          || binding.execution_generation_id !== move.execution_generation_id || !this.supervisedDeliveryHttp.latest) return move;
        await this.assertRoomMoveExternalAuthority();
        const tail = await this.supervisedDeliveryHttp.latest({ roomId: destination, apiUrl: binding.api_url, bearer: credential, signal: AbortSignal.timeout(10_000) });
        await this.assertRoomMoveExternalAuthority();
        if (!await runtimeIsExact([destination])) return failFence("rollback_required", "Runtime authority changed while destination tail was observed.");
        const exactBinding = await this.workerBindings.get(move.agent_id);
        if (!exactBinding || exactBinding.room_id !== destination || exactBinding.work_attempt_id !== move.work_attempt_id || exactBinding.execution_generation_id !== move.execution_generation_id || exactBinding.agent_session_id !== binding.agent_session_id) return move;
        const cursor = lastRoomMessageId(tail.messages ?? []);
        await this.supervisedInbox.commitRoomMoveCursor({ agent_id: move.agent_id, source_room_id: move.source_room_id, destination_room_id: destination, last_observed_message_id: cursor }, (commit) => this.fenceDaemonCommit(commit));
        if (!await runtimeIsExact([destination])) return failFence("rollback_required", "Runtime authority changed before destination ingress activation committed.");
        await advance("bootstrapping_destination_tail", "active", { destination_cursor: cursor });
        void this.startSupervisedDelivery(move.agent_id).catch(() => undefined);
      }
      return move;
      },
    );
    try {
      return await Promise.race([operation, excluded]);
    } catch (error) {
      if (this.handoffScheduled && error instanceof DaemonFenceLostError) return initial;
      throw error;
    } finally {
      waiters.delete(exclude);
      if (waiters.size === 0 && this.roomMoveExclusionWaiters.get(initial.agent_id) === waiters) {
        this.roomMoveExclusionWaiters.delete(initial.agent_id);
      }
    }
  }

  private serializeRoomMoveReconciliation<T>(
    entryId: string,
    excluded: () => Promise<T>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeEntryTick(entryId, async () => {
      if (this.handoffScheduled || this.lifecycleActiveEntries.has(entryId)) return excluded();
      let settle!: () => void;
      const active = new Promise<void>((resolve) => { settle = resolve; });
      if (this.activeRoomMoveReconciliations.has(entryId)) {
        throw new Error("Room-move reconciliation entered its critical section twice for one agent.");
      }
      this.activeRoomMoveReconciliations.set(entryId, active);
      try {
        return await operation();
      } finally {
        settle();
        if (this.activeRoomMoveReconciliations.get(entryId) === active) {
          this.activeRoomMoveReconciliations.delete(entryId);
        }
      }
    });
  }

  private async waitForActiveRoomMoveReconciliation(entryId: string): Promise<void> {
    await this.activeRoomMoveReconciliations.get(entryId);
  }

  private wakeRoomMoveReconciliationWaiters(): void {
    for (const waiters of this.roomMoveExclusionWaiters.values()) {
      for (const waiter of waiters) waiter();
    }
  }

  /**
   * Handoff fences admission synchronously. Only reconciliation that already
   * entered its bounded critical section is drained; callbacks queued behind
   * unrelated entry work are woken and later return their captured snapshot
   * without touching a closed store.
   */
  private async fenceAndDrainRoomMoveReconciliations(): Promise<void> {
    this.wakeRoomMoveReconciliationWaiters();
    while (this.activeRoomMoveReconciliations.size > 0) {
      await Promise.all([...this.activeRoomMoveReconciliations.values()]);
    }
  }

  private async assertRoomMoveExternalAuthority(): Promise<void> {
    if (this.handoffScheduled) throw new DaemonFenceLostError("Supervisor handoff fenced a stale room-move effect.");
    await this.singleton.assertCurrent();
    if (this.handoffScheduled) throw new DaemonFenceLostError("Supervisor handoff fenced a stale room-move effect.");
  }

  /**
   * Retryable compensation for every post-join failure. Each edge is
   * idempotent, so a daemon crash may replay from rollback_required without
   * inventing external success or leaving the operation as a permanent lock.
   */
  private async compensateRoomMoveRollback(initial: DaemonRoomMoveRecord): Promise<DaemonRoomMoveRecord> {
    let move = initial;
    const destination = move.remote_room_id ?? move.destination_room_id;
    const retry = async (detail: string): Promise<DaemonRoomMoveRecord> => {
      move = await this.store.advanceRoomMove({
        operationId: move.operation_id, agentId: move.agent_id, expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id, from: ["rollback_required"], to: "rollback_required", error: detail,
      }, (commit) => this.fenceDaemonCommit(commit));
      this.scheduleRecoveryConvergence(move.agent_id, 1_000);
      return move;
    };
    this.supervisedDelivery?.pauseIngress(move.agent_id);
    const entry = await this.store.getEntry(move.agent_id);
    if (!entry) return move;
    if (![move.source_room_id, destination, move.destination_room_id].includes(entry.room_id)) {
      const detail = `Room-move rollback was superseded by operator membership ${entry.room_id}; no local membership was overwritten.`;
      move = await this.store.advanceRoomMove({
        operationId: move.operation_id, agentId: move.agent_id, expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id, from: ["rollback_required"], to: "failed", error: detail,
      }, (commit) => this.fenceDaemonCommit(commit));
      return move;
    }

    const binding = await this.workerBindings.get(move.agent_id);
    const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
    if (!binding || !credential || ![move.source_room_id, destination, move.destination_room_id].includes(binding.room_id)) {
      return retry("Room-move rollback is waiting for a current source-or-destination credential.");
    }
    if (!this.supervisedDeliveryHttp.joinRoom) return retry("Room-move rollback transport is unavailable.");
    try {
      await this.assertRoomMoveExternalAuthority();
      const joined = await this.supervisedDeliveryHttp.joinRoom({
        roomId: move.source_room_id, apiUrl: binding.api_url, bearer: credential, signal: AbortSignal.timeout(10_000),
      });
      await this.assertRoomMoveExternalAuthority();
      if (joined.roomId.trim() !== move.source_room_id) throw new Error("Source rejoin returned a different canonical room identity.");
    } catch (error) {
      if (this.handoffScheduled && error instanceof DaemonFenceLostError) throw error;
      return retry(`Source-room rollback join failed and will retry: ${schedulerErrorDetail(error)}`);
    }

    await this.updateManifestEntry(move.agent_id, (current) => {
      if (![move.source_room_id, destination, move.destination_room_id].includes(current.room_id)) return current;
      return {
        ...current,
        room_id: move.source_room_id,
        condition: "coordination_blocked",
        last_error: "Room move rolled back; waiting for source-room credential and ingress convergence.",
        workplace_liveness: {
          state: "unknown", observed_at: new Date().toISOString(),
          detail: "Source membership restored after room-move compensation.",
        },
        last_worker_binding: binding.room_id === move.source_room_id ? current.last_worker_binding : null,
      };
    });
    const restored = await this.store.getEntry(move.agent_id);
    if (!restored || restored.room_id !== move.source_room_id) {
      return retry("Source-room external membership was restored, but local membership is awaiting an operator-safe retry.");
    }

    const activating = move.activating_inbox_item_id ? await this.supervisedInbox.get(move.activating_inbox_item_id) : null;
    await this.supervisedInbox.rollbackRoomMoveIngress({
      operation_id: move.operation_id,
      agent_id: move.agent_id,
      source_room_id: move.source_room_id,
      destination_room_id: destination,
      source_cursor_present: move.source_cursor_present,
      source_cursor: move.source_cursor,
      after_fifo_sequence: activating?.fifo_sequence ?? 0,
    }, (commit) => this.fenceDaemonCommit(commit));
    if (binding.room_id !== move.source_room_id) {
      await this.workerBindings.unbind(move.agent_id, binding.agent_session_id, binding.execution_generation_id);
      this.liveBindingIdentities.delete(move.agent_id);
      this.cachedWorkerAuthorizations.delete(move.agent_id);
    }
    const grant = this.hostGrants.get(move.agent_id);
    if (grant && grant.roomId !== move.source_room_id) this.revokeHostGrantIfCurrent(move.agent_id, grant);

    const detail = "Room move failed after destination join and was durably restored to the source room.";
    move = await this.store.advanceRoomMove({
      operationId: move.operation_id, agentId: move.agent_id, expectedDaemonGeneration: move.daemon_generation,
      expectedExecutionGenerationId: move.execution_generation_id, from: ["rollback_required"], to: "failed", error: detail,
    }, (commit) => this.fenceDaemonCommit(commit));
    void this.startSupervisedDelivery(move.agent_id).catch(() => undefined);
    return move;
  }

  private async prepareInspectorRoomMove(input: { entryId: string; destinationRoomId: string; requestId: string; daemonGeneration: number }): Promise<DaemonRoomMoveRecord> {
    if (!input.entryId.trim() || !input.destinationRoomId.trim() || input.destinationRoomId.length > 1_024 || /[\u0000-\u001f\u007f]/.test(input.destinationRoomId) || !input.requestId.trim() || input.requestId.length > 256
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration !== this.singleton.currentGeneration) throw new Error("Room-move preparation is stale or invalid.");
    return this.serializeEntryTick(input.entryId, async () => {
      await this.singleton.assertCurrent();
      const entry = await this.store.getEntry(input.entryId);
      const binding = await this.workerBindings.get(input.entryId);
      const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
      const handle = this.liveHandles.get(input.entryId);
      if (!entry || input.destinationRoomId.trim() === entry.room_id || !entry.work_attempt_id || !entry.provider_ref || !binding || !credential || !handle
        || binding.room_id !== entry.room_id || binding.work_attempt_id !== entry.work_attempt_id
        || binding.execution_generation_id !== entry.provider_ref.execution_generation_id
        || handle.workAttemptId !== entry.work_attempt_id || handle.providerContinuationId !== entry.provider_ref.provider_continuation_id) {
        throw new Error("Room move requires the exact current live provider and source-room credential binding.");
      }
      const operationId = `inspector-room-move:${input.entryId}:${input.requestId}`;
      const prepared = await this.store.prepareRoomMove({
        operation_id: operationId, request_id: `inspector:${input.requestId}`, agent_id: entry.id,
        source_room_id: entry.room_id, destination_room_id: input.destinationRoomId.trim(), daemon_generation: input.daemonGeneration,
        work_attempt_id: entry.work_attempt_id, execution_generation_id: entry.provider_ref.execution_generation_id,
        agent_session_id: binding.agent_session_id, activating_inbox_item_id: null, provider_turn_id: null, effect_id: null, phase: "prepared",
      }, (commit) => this.fenceDaemonCommit(commit));
      return prepared.move;
    });
  }

  private async commitInspectorRoomMove(input: { operationId: string; entryId: string; daemonGeneration: number }): Promise<DaemonRoomMoveRecord> {
    if (!input.operationId.trim() || !input.entryId.trim() || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration !== this.singleton.currentGeneration) throw new Error("Room-move commit is stale or invalid.");
    const move = await this.store.getRoomMove(input.operationId);
    if (!move || move.agent_id !== input.entryId) throw new Error("Unknown room-move operation for this agent.");
    return this.reconcileRoomMove(move);
  }

  private async acknowledgeInspectorRoomMoveSourceRevocation(input: { operationId: string; entryId: string; sourceAgentSessionId: string; daemonGeneration: number }): Promise<DaemonRoomMoveRecord> {
    if (!input.operationId.trim() || !input.entryId.trim() || !input.sourceAgentSessionId.trim()
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("Room-move credential acknowledgement is stale or invalid.");
    }
    return this.serializeEntryTick(input.entryId, async () => {
      await this.singleton.assertCurrent();
      const move = await this.store.getRoomMove(input.operationId);
      if (!move || move.agent_id !== input.entryId) throw new Error("Unknown room-move operation for this agent.");
      if (move.agent_session_id !== input.sourceAgentSessionId) throw new Error("Room-move credential acknowledgement does not match the exact source session.");
      if (move.source_credentials_revoked) return move;
      if (move.phase !== "rotating_credentials") throw new Error("Room-move source credentials can only be acknowledged during credential rotation.");
      return this.store.advanceRoomMove({
        operationId: move.operation_id, agentId: move.agent_id, expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id, from: ["rotating_credentials"], to: "rotating_credentials",
        sourceCredentialsRevoked: true,
      }, (commit) => this.fenceDaemonCommit(commit));
    });
  }

  private async rollbackInspectorRoomMove(input: { operationId: string; entryId: string; detail: string; daemonGeneration: number }): Promise<DaemonRoomMoveRecord> {
    if (!input.operationId.trim() || !input.entryId.trim() || !input.detail.trim()
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("Room-move rollback is stale or invalid.");
    }
    return this.serializeEntryTick(input.entryId, async () => {
      await this.singleton.assertCurrent();
      let move = await this.store.getRoomMove(input.operationId);
      if (!move || move.agent_id !== input.entryId) throw new Error("Unknown room-move operation for this agent.");
      if (["active", "failed"].includes(move.phase)) return move;
      if (move.phase !== "rollback_required") {
        if (!["joining_destination", "membership_committed", "rotating_credentials", "bootstrapping_destination_tail"].includes(move.phase)) {
          throw new Error("Room move cannot be rolled back before destination membership commits.");
        }
        move = await this.store.advanceRoomMove({
          operationId: move.operation_id, agentId: move.agent_id, expectedDaemonGeneration: move.daemon_generation,
          expectedExecutionGenerationId: move.execution_generation_id, from: [move.phase], to: "rollback_required",
          error: `Destination credential preparation failed: ${schedulerErrorDetail(new Error(input.detail))}`,
        }, (commit) => this.fenceDaemonCommit(commit));
      }
      // Journal rollback_required before restoring local source membership, so
      // a crash can never make the source manifest look like a fresh move.
      const destination = move.remote_room_id ?? move.destination_room_id;
      await this.updateManifestEntry(move.agent_id, (current) => {
        if (![move.source_room_id, destination, move.destination_room_id].includes(current.room_id)) return current;
        return {
          ...current, room_id: move.source_room_id, condition: "coordination_blocked",
          last_error: "Room move rollback is waiting for source-room owner authority.",
          workplace_liveness: {
            state: "unknown", observed_at: new Date().toISOString(),
            detail: "Destination credential preparation failed; source authority is being restored.",
          },
          last_worker_binding: current.room_id === move.source_room_id ? current.last_worker_binding : null,
        };
      });
      return move;
    });
  }

  private async getInspectorRoomMove(input: { operationId: string; entryId: string; daemonGeneration: number }): Promise<DaemonRoomMoveRecord> {
    if (!input.operationId.trim() || !input.entryId.trim() || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration !== this.singleton.currentGeneration) throw new Error("Room-move status is stale or invalid.");
    const move = await this.store.getRoomMove(input.operationId);
    if (!move || move.agent_id !== input.entryId) throw new Error("Unknown room-move operation for this agent.");
    return move;
  }

  private async getCurrentInspectorRoomMove(input: {
    entryId: string;
    daemonGeneration: number;
  }): Promise<DaemonRoomMoveRecord | null> {
    if (!input.entryId.trim() || !Number.isSafeInteger(input.daemonGeneration)
      || input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("Current room-move discovery is stale or invalid.");
    }
    const moves = await this.store.pendingRoomMoves(input.entryId);
    if (moves.length > 1) throw new Error("More than one nonterminal room move exists for this agent.");
    const move = moves[0] ?? null;
    return move?.daemon_generation === input.daemonGeneration ? move : null;
  }

  /** Build a delivery agent only from one current manifest, handle, binding, and memory credential tuple. */
  private async startSupervisedDelivery(entryId: string, mode: "refresh" | "ensure" | "wake" = "refresh"): Promise<void> {
    if (this.handoffScheduled || !this.supervisedDelivery || !this.providerPort?.runRoomTurn) return;
    if (this.lifecycleActiveEntries.has(entryId)) return;
    const entry = await this.store.getEntry(entryId);
    // A legacy worker-owned polling loop must be cut over before the daemon
    // can even read its bearer.  This keeps the two ingress systems mutually
    // exclusive across every crash boundary.
    if (entry?.provider === "codex" && (entry.delivery_mode ?? "mcp_polling") === "mcp_polling") {
      await this.startDeliveryCutover(entryId);
      return;
    }
    if (!entry || entry.delivery_mode !== "daemon_inbox") return;
    if (entry.turn_control?.inbox_item_id
      && ["prepared", "dispatching", "uncertain"].includes(entry.turn_control.status)) {
      // The native side effect is unresolved. Its linked FIFO invocation is a
      // durable quarantine boundary across restart, refresh, and handoff; no
      // startup normalization may recover or redispatch it before the journal
      // is atomically completed or explicitly resolved.
      return;
    }
    // A pending move owns successor ingress, but its exact activating turn may
    // still need the source-room delivery loop after restart. Reconcile first;
    // only a validated pre-join waiter may resume that exact FIFO head.
    const pendingMoves = await this.store.pendingRoomMoves(entryId);
    if (pendingMoves.length > 1) throw new Error("More than one nonterminal room move exists for this agent.");
    const pendingMove = pendingMoves[0] ?? null;
    if (pendingMove) {
      let move: DaemonRoomMoveRecord;
      try {
        move = await this.reconcileRoomMove(pendingMove);
      } catch (error) {
        this.scheduleRecoveryConvergence(pendingMove.agent_id, 1_000);
        throw error;
      }
      if (this.lifecycleActiveEntries.has(entryId) || move.phase !== "waiting_for_current_turn") return;
      const isRecoverableActivatingState = (candidate: { state: string; provider_turn_id: string | null }): boolean =>
        ["dispatching", "awaiting_result", "result_recovery", "publishing", "retryable"].includes(candidate.state)
        || (candidate.state === "pending" && candidate.provider_turn_id !== null);
      if (move.activating_inbox_item_id) {
        const item = await this.supervisedInbox.get(move.activating_inbox_item_id);
        const binding = item ? await this.supervisedInbox.providerTurnBinding(item.inbox_item_id) : null;
        const effect = move.effect_id && move.provider_turn_id && binding
          ? await this.supervisedInbox.preparedRoomMove(
            move.agent_id,
            binding.origin_execution_generation_id,
            move.provider_turn_id,
          )
          : null;
        const exactWaiter = Boolean(item
          && isRecoverableActivatingState(item)
          && item.agent_id === move.agent_id
          && item.room_id === move.source_room_id
          && item.provider_turn_id === move.provider_turn_id
          && binding
          && binding.agent_id === move.agent_id
          && binding.room_id === move.source_room_id
          && binding.work_attempt_id === move.work_attempt_id
          && binding.provider_turn_id === move.provider_turn_id
          && effect
          && effect.effect_id === move.effect_id
          && effect.room_id === move.source_room_id
          && effect.execution_generation_id === binding.origin_execution_generation_id);
        if (!exactWaiter) return;
      } else {
        const receipts = await this.supervisedInbox.receipts(move.agent_id);
        if (!receipts.some(isRecoverableActivatingState)) return;
      }
    }
    const handle = this.liveHandles.get(entryId);
    const binding = await this.workerBindings.get(entryId);
    if (!entry || !binding || !entry.work_attempt_id || !entry.provider_ref) return;
    const credential = await this.workerBindings.credentialFor(binding);
    if (!credential) return;
    const agent = {
      agentId: entryId,
      roomId: binding.room_id,
      provider: entry.provider,
      charter: entry.charter,
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: credential,
      handle: handle ?? null,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: entry.provider_ref.provider_continuation_id,
      providerConnection: entry.provider_ref.provider_connection ?? null,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.singleton.currentGeneration,
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    if (!await this.isExactSupervisedDeliveryAuthority({
      agentId: agent.agentId, roomId: agent.roomId, provider: agent.provider,
      apiUrl: agent.apiUrl, agentSessionId: agent.agentSessionId, bearer: agent.bearer,
      handle: agent.handle, workAttemptId: agent.workAttemptId,
      executionGenerationId: agent.executionGenerationId,
      daemonGeneration: agent.daemonGeneration,
      providerContinuationId: agent.providerContinuationId,
      providerConnection: agent.providerConnection,
    })) return;
    if (mode === "ensure" || mode === "wake") {
      // Recovery only fills an absent loop; it never tears down healthy work.
      await this.supervisedDelivery.ensureStarted(agent);
      if (mode === "wake") this.supervisedDelivery.wake(agent);
    } else {
      // Rebinding replaces the prior loop only after it has been cancelled and
      // joined. The new loop pumps durable work before its first long poll.
      await this.supervisedDelivery.refresh(agent);
    }
  }

  private async restartSupervisedDeliveryOrConverge(entryId: string): Promise<void> {
    if (this.lifecycleActiveEntries.has(entryId)) {
      // Lifecycle callers invoke this from their failure/losing-CAS cleanup,
      // before their outer finally releases exclusion. Defer one turn so the
      // exact pending room move and delivery owner can actually reacquire the
      // lane instead of treating an exclusion no-op as successful recovery.
      const timer = setTimeout(() => void this.restartSupervisedDeliveryOrConverge(entryId), 0);
      timer.unref();
      return;
    }
    try {
      await this.startSupervisedDelivery(entryId, "ensure");
    } catch {
      // A running daemon-inbox entry now restarts delivery from ordinary
      // convergence even when its provider handle is already healthy.
      this.scheduleRecoveryConvergence(entryId, 250);
    }
  }

  /** Coalesce one durable legacy-polling -> daemon-inbox handoff per agent. */
  private startDeliveryCutover(entryId: string): Promise<void> {
    const existing = this.deliveryCutoverRequests.get(entryId);
    if (existing) return existing;
    const controller = new AbortController();
    this.deliveryCutoverControllers.set(entryId, controller);
    const operation = this.driveDeliveryCutover(entryId, controller.signal).finally(() => {
      if (this.deliveryCutoverRequests.get(entryId) === operation) this.deliveryCutoverRequests.delete(entryId);
      if (this.deliveryCutoverControllers.get(entryId) === controller) this.deliveryCutoverControllers.delete(entryId);
    });
    this.deliveryCutoverRequests.set(entryId, operation);
    return operation;
  }

  /**
   * Fence the exact legacy polling turn before enabling daemon ingress.  The
   * manifest is the effect journal: once a target is recorded no later run may
   * inspect "latest" as a replacement target, and once native dispatch is
   * recorded an active/unknown result is deliberately left gated.
   */
  private async driveDeliveryCutover(entryId: string, detachSignal: AbortSignal): Promise<void> {
    if (this.handoffScheduled || !this.providerPort?.controlExactTurn) return;
    let entry = await this.store.getEntry(entryId);
    this.assertDeliveryCutoverObservation(detachSignal);
    if (!entry) return;

    // Terminal durability is the convergence boundary for every old cutover,
    // including predecessor states whose provider_ref was already detached or
    // replaced. A terminal current/no-runtime cutover can adopt daemon ingress;
    // a stale cutover beside a successor is only cleared, never allowed to flip
    // that successor's delivery mode.
    if (entry.delivery_cutover) {
      const saved = entry.delivery_cutover;
      const attempt = await this.durability.getAttempt(saved.work_attempt_id).catch(() => null);
      const terminal = attempt?.execution_generations.some((candidate) =>
        candidate.execution_generation_id === saved.execution_generation_id && candidate.terminal) ?? false;
      if (terminal) {
        entry = await this.updateManifestEntry(entryId, (current) => {
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
        this.assertDeliveryCutoverObservation(detachSignal);
        if (entry.delivery_mode === "daemon_inbox") {
          const timer = setTimeout(() => void this.startSupervisedDelivery(entryId).catch(() => undefined), 0);
          timer.unref();
          return;
        }
      }
    }

    const handle = this.liveHandles.get(entryId);
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
      this.assertDeliveryCutoverObservation(detachSignal);
      entry = await this.updateManifestEntry(entryId, (current) => {
        this.assertDeliveryCutoverObservation(detachSignal);
        if (current.turn_control && current.turn_control.status !== "completed") {
          throw new Error(`Delivery cutover is blocked by unresolved turn-control action '${current.turn_control.action_id}'.`);
        }
        if (current.provider !== "codex" || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
          || current.work_attempt_id !== identity.work_attempt_id
          || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
          || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
          || this.liveHandles.get(entryId) !== handle
          || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)) return current;
        const cutover: DaemonDeliveryCutover = { ...identity, provider_turn_id: null, phase: "prepared", error: null, updated_at: new Date().toISOString() };
        return { ...current, delivery_cutover: cutover };
      });
      this.assertDeliveryCutoverObservation(detachSignal);
    }
    const cutover = entry.delivery_cutover;
    if (!cutover
      || cutover.work_attempt_id !== identity.work_attempt_id
      || cutover.execution_generation_id !== identity.execution_generation_id
      || cutover.provider_continuation_id !== identity.provider_continuation_id) return;

    if (cutover.phase === "dispatching" || cutover.phase === "uncertain") {
      if (!cutover.provider_turn_id || !this.providerPort.inspectTurn) {
        await this.markDeliveryCutoverUncertain(entryId, identity, "native interrupt dispatch is ambiguous without an exact turn id", handle, detachSignal);
        return;
      }
      const state = await this.observeDeliveryCutover(detachSignal, this.providerPort.inspectTurn(handle, cutover.provider_turn_id)).catch(() => "unknown" as const);
      this.assertDeliveryCutoverObservation(detachSignal);
      if (state === "terminal") {
        await this.completeDeliveryCutover(entryId, identity, handle, detachSignal);
        return;
      }
      if (state === "unknown") {
        await this.markDeliveryCutoverUncertain(entryId, identity, `native interrupt dispatch is ambiguous; exact turn remains ${state}`, handle, detachSignal);
        this.scheduleDeliveryCutoverRetry(entryId, 1_000);
        return;
      }
      // Exact A is still active. Re-driving the interrupt is safe because the
      // persisted target is immutable; no latest-turn discovery occurs.
    }

    let dispatchMarked = cutover.phase === "dispatching" || cutover.phase === "uncertain";
    try {
      const result = await this.observeDeliveryCutover(detachSignal, this.providerPort.controlExactTurn(handle, {
        targetTurnId: cutover.provider_turn_id,
        checkpointTargetTurn: async (turnId) => {
          this.assertDeliveryCutoverObservation(detachSignal);
          await this.updateManifestEntry(entryId, (current) => {
            this.assertDeliveryCutoverObservation(detachSignal);
            const currentCutover = current.delivery_cutover;
            if (!currentCutover
              || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
              || !["prepared", "retryable", "dispatching", "uncertain"].includes(currentCutover.phase)
              || current.desired_state !== "running"
              || current.condition !== "none"
              || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
              || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
              || this.liveHandles.get(entryId) !== handle
              || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
              || currentCutover.work_attempt_id !== identity.work_attempt_id
              || currentCutover.execution_generation_id !== identity.execution_generation_id
              || currentCutover.provider_continuation_id !== identity.provider_continuation_id
              || (currentCutover.provider_turn_id && currentCutover.provider_turn_id !== turnId)) {
              throw new Error("Legacy delivery cutover changed before exact turn checkpoint.");
            }
            return { ...current, delivery_cutover: { ...currentCutover, provider_turn_id: turnId, updated_at: new Date().toISOString() } };
          });
          this.assertDeliveryCutoverObservation(detachSignal);
        },
        markDispatched: async () => {
          this.assertDeliveryCutoverObservation(detachSignal);
          await this.updateManifestEntry(entryId, (current) => {
            this.assertDeliveryCutoverObservation(detachSignal);
            const currentCutover = current.delivery_cutover;
            if (!currentCutover
              || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
              || !["prepared", "retryable", "dispatching", "uncertain"].includes(currentCutover.phase)
              || current.desired_state !== "running"
              || current.condition !== "none"
              || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
              || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
              || this.liveHandles.get(entryId) !== handle
              || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
              || !currentCutover.provider_turn_id
              || currentCutover.work_attempt_id !== identity.work_attempt_id
              || currentCutover.execution_generation_id !== identity.execution_generation_id
              || currentCutover.provider_continuation_id !== identity.provider_continuation_id) {
              throw new Error("Legacy delivery cutover changed before native interrupt dispatch.");
            }
            return { ...current, delivery_cutover: { ...currentCutover, phase: "dispatching", updated_at: new Date().toISOString() } };
          });
          dispatchMarked = true;
          this.assertDeliveryCutoverObservation(detachSignal);
        },
        detachSignal,
      }));
      this.assertDeliveryCutoverObservation(detachSignal);
      // A no-active/terminal inspection is a completion fact. An adapter's
      // interrupt acknowledgement is not: independently re-inspect exactly
      // the persisted target before allowing daemon ingress.
      if (result.outcome === "no_active" || result.outcome === "terminal") {
        await this.completeDeliveryCutover(entryId, identity, handle, detachSignal);
      } else if (result.outcome === "interrupt_dispatched") {
        const targetTurnId = cutover.provider_turn_id ?? result.targetTurnId;
        if (!targetTurnId || !this.providerPort.inspectTurn) {
          await this.markDeliveryCutoverUncertain(entryId, identity, "native interrupt was acknowledged without exact terminal inspection", handle, detachSignal);
          return;
        }
        const state = await this.observeDeliveryCutover(detachSignal, this.providerPort.inspectTurn(handle, targetTurnId)).catch(() => "unknown" as const);
        this.assertDeliveryCutoverObservation(detachSignal);
        if (state === "terminal") await this.completeDeliveryCutover(entryId, identity, handle, detachSignal);
        else {
          await this.markDeliveryCutoverUncertain(entryId, identity, `native interrupt was acknowledged but exact turn remains ${state}`, handle, detachSignal);
          this.scheduleDeliveryCutoverRetry(entryId, 1_000);
        }
      }
    } catch (error) {
      if (error instanceof DeliveryCutoverObservationDetached) return;
      const outcome = error && typeof error === "object" && "turnControlOutcome" in error
        ? (error as { turnControlOutcome?: unknown }).turnControlOutcome
        : null;
      const ambiguous = dispatchMarked || outcome === "uncertain";
      if (ambiguous) {
        await this.markDeliveryCutoverUncertain(entryId, identity, error instanceof Error ? error.message : "exact legacy turn control failed", handle, detachSignal);
        this.scheduleDeliveryCutoverRetry(entryId, 1_000);
      } else {
        await this.markDeliveryCutoverRetryable(entryId, identity, error instanceof Error ? error.message : "exact legacy turn preparation failed", handle, detachSignal);
        this.scheduleDeliveryCutoverRetry(entryId, 250);
      }
    }
  }

  private async completeDeliveryCutover(entryId: string, identity: Omit<DaemonDeliveryCutover, "provider_turn_id" | "phase" | "updated_at">, handle: ProviderActionHandle, detachSignal: AbortSignal): Promise<void> {
    this.assertDeliveryCutoverObservation(detachSignal);
    const completed = await this.updateManifestEntry(entryId, (current) => {
      this.assertDeliveryCutoverObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if ((current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || !cutover
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
        || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
        || this.liveHandles.get(entryId) !== handle
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
          ? { observed_state: "idle" as const, native_liveness: { state: "idle" as const, observed_at: now, detail: "legacy polling turn fenced; daemon inbox ready" } }
          : {}),
      };
    });
    this.assertDeliveryCutoverObservation(detachSignal);
    if (completed.delivery_mode === "daemon_inbox") {
      // This coordinator is still coalesced until its finally runs. Defer the
      // first inbox start one tick so it cannot mistake the cutover operation
      // for an already-running successor.
      const timer = setTimeout(() => void this.startSupervisedDelivery(entryId).catch(() => undefined), 0);
      timer.unref();
    }
  }

  private async markDeliveryCutoverRetryable(
    entryId: string,
    identity: Omit<DaemonDeliveryCutover, "provider_turn_id" | "phase" | "updated_at">,
    detail: string,
    handle: ProviderActionHandle,
    detachSignal: AbortSignal,
  ): Promise<void> {
    this.assertDeliveryCutoverObservation(detachSignal);
    await this.updateManifestEntry(entryId, (current) => {
      this.assertDeliveryCutoverObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if ((current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || !cutover
        || cutover.phase === "dispatching"
        || cutover.phase === "uncertain"
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
        || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
        || this.liveHandles.get(entryId) !== handle
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
    this.assertDeliveryCutoverObservation(detachSignal);
  }

  private async markDeliveryCutoverUncertain(entryId: string, identity: Omit<DaemonDeliveryCutover, "provider_turn_id" | "phase" | "updated_at">, detail: string, handle: ProviderActionHandle, detachSignal: AbortSignal): Promise<void> {
    this.assertDeliveryCutoverObservation(detachSignal);
    await this.updateManifestEntry(entryId, (current) => {
      this.assertDeliveryCutoverObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if ((current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || !cutover
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
        || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
        || this.liveHandles.get(entryId) !== handle
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
        payload: { phase: "uncertain", provider_turn_id: cutover.provider_turn_id, detail: safeDetail },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: null,
      };
      return {
        ...current,
        delivery_cutover: { ...cutover, phase: "uncertain", error: safeDetail, updated_at: observedAt },
        activity: [...(current.activity ?? []), activity].slice(-200),
      };
    });
    this.assertDeliveryCutoverObservation(detachSignal);
  }

  private scheduleDeliveryCutoverRetry(entryId: string, delayMs: number): void {
    const timer = setTimeout(() => void this.startDeliveryCutover(entryId).catch(() => undefined), delayMs);
    timer.unref();
  }

  /** Retirement detaches local observation only; it never signals the provider. */
  private async fenceAndDrainDeliveryCutovers(): Promise<void> {
    for (const controller of this.deliveryCutoverControllers.values()) controller.abort();
    await Promise.allSettled([...this.deliveryCutoverRequests.values()]);
  }

  private assertDeliveryCutoverObservation(detachSignal: AbortSignal): void {
    if (detachSignal.aborted || this.handoffScheduled) throw new DeliveryCutoverObservationDetached();
  }

  private observeDeliveryCutover<T>(detachSignal: AbortSignal, operation: Promise<T>): Promise<T> {
    this.assertDeliveryCutoverObservation(detachSignal);
    return new Promise<T>((resolve, reject) => {
      const detach = () => {
        detachSignal.removeEventListener("abort", detach);
        reject(new DeliveryCutoverObservationDetached());
      };
      detachSignal.addEventListener("abort", detach, { once: true });
      void operation.then(
        (value) => {
          detachSignal.removeEventListener("abort", detach);
          if (detachSignal.aborted || this.handoffScheduled) reject(new DeliveryCutoverObservationDetached());
          else resolve(value);
        },
        (error) => {
          detachSignal.removeEventListener("abort", detach);
          reject(error);
        },
      );
    });
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  private async checkpointPreparedCursorTurn(input: {
    agent: SupervisedIngressAgent;
    inboxItemId: string;
    providerTurnId: string;
    providerContinuationId: string;
    providerConnection: ProviderActionConnectionRef;
  }): Promise<void> {
    const { agent, inboxItemId, providerTurnId, providerContinuationId, providerConnection } = input;
    if (agent.provider !== "cursor"
      || providerConnection.kind !== "cursor_cli"
      || providerContinuationId !== agent.providerContinuationId
      || providerConnection.pid === null
      || !providerConnection.processIdentity?.trim()
      || !agent.handle) {
      throw new Error("Only an exact paused Cursor wrapper may cross the prepared-turn boundary.");
    }
    const expectedConnection = agent.providerConnection;
    if (!isIdleCursorConnection(expectedConnection)) {
      throw new DaemonFenceLostError("Cursor prepared turn did not begin from the exact idle runtime state.");
    }
    await this.serializeEntryTick(agent.agentId, () => this.serializeManifestMutation(async () => {
      if (this.handoffScheduled) throw new DaemonFenceLostError("Cursor prepared turn changed during daemon handoff.");
      await this.singleton.assertCurrent();
      const current = await this.store.getEntry(agent.agentId);
      const live = this.liveHandles.get(agent.agentId);
      const binding = await this.workerBindings.get(agent.agentId);
      const currentCredential = binding ? await this.workerBindings.credentialFor(binding) : null;
      if (!current
        || live !== agent.handle
        || current.room_id !== agent.roomId
        || current.desired_state !== "running"
        || current.provider !== "cursor"
        || current.delivery_mode !== "daemon_inbox"
        || current.work_attempt_id !== agent.workAttemptId
        || current.provider_ref?.work_attempt_id !== agent.workAttemptId
        || current.provider_ref.execution_generation_id !== agent.executionGenerationId
        || current.provider_ref.provider_continuation_id !== agent.providerContinuationId
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, expectedConnection)
        || !binding
        || binding.room_id !== agent.roomId
        || binding.api_url !== agent.apiUrl
        || binding.work_attempt_id !== agent.workAttemptId
        || binding.execution_generation_id !== agent.executionGenerationId
        || binding.agent_session_id !== agent.agentSessionId
        || currentCredential !== agent.bearer
        || live.workAttemptId !== agent.workAttemptId
        || live.providerContinuationId !== providerContinuationId
        || !sameProviderActionConnectionSnapshot(live.providerConnection, providerConnection)) {
        throw new DaemonFenceLostError("Cursor prepared turn no longer belongs to the exact supervised lane.");
      }
      try {
        const checkpoint = await this.store.checkpointCursorPreparedTurn(this.manifestGeneration, {
          agentId: agent.agentId,
          roomId: agent.roomId,
          inboxItemId,
          providerTurnId,
          providerContinuationId,
          workAttemptId: agent.workAttemptId,
          executionGenerationId: agent.executionGenerationId,
          agentSessionId: agent.agentSessionId,
          credentialRef: binding.credential_ref,
          apiUrl: agent.apiUrl,
          expectedProviderContinuationId: agent.providerContinuationId!,
          expectedProviderConnection: expectedConnection,
          providerConnection,
          observedAt: new Date(this.nowMs()).toISOString(),
        }, (commit) => this.fenceDaemonCommit(commit));
        this.manifestGeneration = checkpoint.generation;
        agent.providerConnection = providerConnection;
      } catch (error) {
        // A commit fence may report failure after SQLite committed. The paired
        // manifest+inbox read proves whether the atomic boundary won.
        const [persisted, inbox, recoveredBinding] = await Promise.all([
          this.store.getEntry(agent.agentId).catch(() => undefined),
          this.supervisedInbox.get(inboxItemId).catch(() => null),
          this.workerBindings.get(agent.agentId).catch(() => null),
        ]);
        const recoveredCredential = recoveredBinding
          ? await this.workerBindings.credentialFor(recoveredBinding).catch(() => null)
          : null;
        const recoveredLive = this.liveHandles.get(agent.agentId);
        if (persisted?.room_id === agent.roomId
          && persisted.desired_state === "running"
          && persisted.provider === "cursor"
          && persisted.delivery_mode === "daemon_inbox"
          && persisted.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref?.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref.execution_generation_id === agent.executionGenerationId
          && persisted.provider_ref.provider_continuation_id === providerContinuationId
          && sameProviderActionConnectionSnapshot(persisted.provider_ref.provider_connection, providerConnection)
          && inbox?.agent_id === agent.agentId
          && inbox.room_id === agent.roomId
          && inbox?.provider_turn_id === providerTurnId
          && ["dispatching", "awaiting_result", "result_recovery"].includes(inbox.state)
          && recoveredBinding?.entry_id === agent.agentId
          && recoveredBinding.room_id === agent.roomId
          && recoveredBinding.api_url === agent.apiUrl
          && recoveredBinding.work_attempt_id === agent.workAttemptId
          && recoveredBinding.execution_generation_id === agent.executionGenerationId
          && recoveredBinding.agent_session_id === agent.agentSessionId
          && recoveredCredential === agent.bearer
          && recoveredLive === agent.handle
          && recoveredLive.workAttemptId === agent.workAttemptId
          && recoveredLive.providerContinuationId === providerContinuationId
          && sameProviderActionConnectionSnapshot(recoveredLive.providerConnection, providerConnection)) {
          const manifest = await this.store.load();
          this.manifestGeneration = manifest.generation;
          agent.providerConnection = providerConnection;
          return;
        }
        throw error;
      }
    }));
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  private async checkpointDynamicProviderState(input: {
    agent: SupervisedIngressAgent;
    inboxItemId: string;
    providerTurnId: string;
    providerContinuationId: string;
    providerConnection: ProviderActionConnectionRef;
  }): Promise<void> {
    const { agent, inboxItemId, providerTurnId, providerContinuationId, providerConnection } = input;
    if (agent.provider !== "cursor" || providerConnection.kind !== "cursor_cli"
      || !providerContinuationId.trim() || !agent.handle) {
      throw new Error("Only an exact live Cursor lane may checkpoint dynamic provider state.");
    }
    const completingAdmittedCursorState = isLiveCursorConnection(agent.providerConnection)
      && isAllowedCursorProviderStateTransition(
        agent.providerContinuationId,
        agent.providerConnection,
        providerContinuationId,
        providerConnection,
      );
    await this.serializeEntryTick(agent.agentId, () => this.serializeManifestMutation(async () => {
      if (this.handoffScheduled && !completingAdmittedCursorState) {
        throw new DaemonFenceLostError("Cursor provider state changed during daemon handoff.");
      }
      await this.singleton.assertCurrent();
      const current = await this.store.getEntry(agent.agentId);
      const live = this.liveHandles.get(agent.agentId);
      const binding = await this.workerBindings.get(agent.agentId);
      const currentCredential = binding ? await this.workerBindings.credentialFor(binding) : null;
      const currentProviderStateMatchesAgent = Boolean(current?.provider_ref
        && current.provider_ref.provider_continuation_id === agent.providerContinuationId
        && sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection ?? null, agent.providerConnection));
      const currentProviderStateMatchesCandidate = Boolean(current?.provider_ref
        && current.provider_ref.provider_continuation_id === providerContinuationId
        && sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection ?? null, providerConnection));
      const inbox = await this.supervisedInbox.get(inboxItemId);
      if (!current || live !== agent.handle
        || current.room_id !== agent.roomId
        || current.desired_state !== "running"
        || current.provider !== "cursor"
        || current.delivery_mode !== "daemon_inbox"
        || current.work_attempt_id !== agent.workAttemptId
        || current.provider_ref?.work_attempt_id !== agent.workAttemptId
        || current.provider_ref.execution_generation_id !== agent.executionGenerationId
        || (!currentProviderStateMatchesAgent && !currentProviderStateMatchesCandidate)
        || !inbox
        || inbox.agent_id !== agent.agentId
        || inbox.room_id !== agent.roomId
        || inbox.provider_turn_id !== providerTurnId
        || !["dispatching", "awaiting_result", "result_recovery"].includes(inbox.state)
        || !binding
        || binding.entry_id !== agent.agentId
        || binding.room_id !== agent.roomId
        || binding.api_url !== agent.apiUrl
        || binding.work_attempt_id !== agent.workAttemptId
        || binding.execution_generation_id !== agent.executionGenerationId
        || binding.agent_session_id !== agent.agentSessionId
        || currentCredential !== agent.bearer
        || live.workAttemptId !== agent.workAttemptId
        || live.providerContinuationId !== providerContinuationId
        || !sameProviderActionConnectionSnapshot(live.providerConnection, providerConnection)
        || !isAllowedCursorProviderStateTransition(
          agent.providerContinuationId,
          agent.providerConnection,
          providerContinuationId,
          providerConnection,
        )) {
        throw new DaemonFenceLostError("Cursor provider state no longer belongs to the exact supervised lane.");
      }
      try {
        if (current.provider_ref.provider_continuation_id !== providerContinuationId
          || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, providerConnection)) {
          const checkpoint = await this.store.checkpointCursorProviderState(this.manifestGeneration, {
            agentId: agent.agentId,
            roomId: agent.roomId,
            inboxItemId,
            providerTurnId,
            workAttemptId: agent.workAttemptId,
            executionGenerationId: agent.executionGenerationId,
            agentSessionId: agent.agentSessionId,
            credentialRef: binding.credential_ref,
            apiUrl: agent.apiUrl,
            expectedProviderContinuationId: agent.providerContinuationId!,
            expectedProviderConnection: agent.providerConnection,
            providerContinuationId,
            providerConnection,
            observedAt: new Date().toISOString(),
          }, (commit) => completingAdmittedCursorState
            ? this.fenceAdmittedCursorTransitionCommit(commit)
            : this.fenceDaemonCommit(commit));
          this.manifestGeneration = checkpoint.generation;
        }
        // Manifest and live handle now agree. Advance the in-memory ingress
        // authority before the separate attempt checkpoint so a failure in the
        // latter cannot split manifest=new from agent/handle=old.
        agent.providerContinuationId = providerContinuationId;
        agent.providerConnection = providerConnection;
        const attempt = await this.durability.getAttempt(agent.workAttemptId);
        if (attempt.checkpoints.at(-1)?.provider_continuation_id !== providerContinuationId) {
          try {
            await this.durability.checkpoint(agent.workAttemptId, {
              room_cursor: null,
              provider_continuation_id: providerContinuationId,
            });
          } catch {
            // The manifest is the authoritative live runtime reference. A
            // secondary attempt-history checkpoint must not make the adapter
            // reap an already-authorized turn; convergence retries it.
            this.scheduleRecoveryConvergence(agent.agentId, 1_000);
          }
        }
      } catch (error) {
        // An SQLite/filesystem boundary can report failure after committing.
        // Re-read the manifest and converge in-memory authority when the exact
        // new handle/ref is already durable; the next retry then only needs to
        // finish the idempotent attempt checkpoint.
        const [persisted, recoveredInbox, recoveredBinding] = await Promise.all([
          this.store.getEntry(agent.agentId).catch(() => undefined),
          this.supervisedInbox.get(inboxItemId).catch(() => null),
          this.workerBindings.get(agent.agentId).catch(() => null),
        ]);
        const recoveredCredential = recoveredBinding
          ? await this.workerBindings.credentialFor(recoveredBinding).catch(() => null)
          : null;
        const recoveredLive = this.liveHandles.get(agent.agentId);
        if (persisted?.room_id === agent.roomId
          && persisted.desired_state === "running"
          && persisted.provider === "cursor"
          && persisted.delivery_mode === "daemon_inbox"
          && persisted.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref?.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref.execution_generation_id === agent.executionGenerationId
          && persisted.provider_ref.provider_continuation_id === providerContinuationId
          && sameProviderActionConnectionSnapshot(persisted.provider_ref.provider_connection, providerConnection)
          && recoveredInbox?.agent_id === agent.agentId
          && recoveredInbox.room_id === agent.roomId
          && recoveredInbox.provider_turn_id === providerTurnId
          && ["dispatching", "awaiting_result", "result_recovery"].includes(recoveredInbox.state)
          && recoveredBinding?.entry_id === agent.agentId
          && recoveredBinding.room_id === agent.roomId
          && recoveredBinding.api_url === agent.apiUrl
          && recoveredBinding.work_attempt_id === agent.workAttemptId
          && recoveredBinding.execution_generation_id === agent.executionGenerationId
          && recoveredBinding.agent_session_id === agent.agentSessionId
          && recoveredCredential === agent.bearer
          && recoveredLive === agent.handle
          && recoveredLive.workAttemptId === agent.workAttemptId
          && recoveredLive.providerContinuationId === providerContinuationId
          && sameProviderActionConnectionSnapshot(recoveredLive.providerConnection, providerConnection)
          && isAllowedCursorProviderStateTransition(
            agent.providerContinuationId,
            agent.providerConnection,
            providerContinuationId,
            providerConnection,
          )) {
          const manifest = await this.store.load();
          this.manifestGeneration = manifest.generation;
          agent.providerContinuationId = providerContinuationId;
          agent.providerConnection = providerConnection;
          return;
        }
        throw error;
      }
    }));
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  private async isExactSupervisedDeliveryAuthority(
    authority: SupervisedDeliveryAuthority,
    scope: SupervisedAuthorityScope = "settled_provider_state",
  ): Promise<boolean> {
    if (this.handoffScheduled) return false;
    try { await this.singleton.assertCurrent(); } catch { return false; }
    if (authority.daemonGeneration !== this.singleton.currentGeneration) return false;
    const entry = await this.store.getEntry(authority.agentId);
    const handle = this.liveHandles.get(authority.agentId);
    if (!entry
      || entry.id !== authority.agentId
      || entry.room_id !== authority.roomId
      || entry.desired_state !== "running"
      || entry.delivery_mode !== "daemon_inbox"
      || entry.provider !== authority.provider
      || entry.work_attempt_id !== authority.workAttemptId
      || entry.provider_ref?.work_attempt_id !== authority.workAttemptId
      || entry.provider_ref?.execution_generation_id !== authority.executionGenerationId
      ) return false;
    const binding = await this.workerBindings.get(authority.agentId);
    if (!binding
      || binding.entry_id !== authority.agentId
      || binding.room_id !== authority.roomId
      || binding.api_url !== authority.apiUrl
      || binding.work_attempt_id !== authority.workAttemptId
      || binding.execution_generation_id !== authority.executionGenerationId
      || binding.agent_session_id !== authority.agentSessionId) return false;
    if ((await this.workerBindings.credentialFor(binding)) !== authority.bearer) return false;
    // Ingress authority deliberately survives loss of provider execution. A
    // bounded turn requires the exact live handle in addition to this route.
    if (!authority.handle) return true;
    if (!handle
      || handle !== authority.handle
      || handle.workAttemptId !== authority.workAttemptId) return false;
    if (scope === "lane_lease") return true;
    if (handle.pid !== (authority.providerConnection?.pid ?? null)) return false;
    return entry.provider_ref?.provider_continuation_id === authority.providerContinuationId
      && sameProviderActionConnectionSnapshot(
        entry.provider_ref?.provider_connection ?? null,
        authority.providerConnection,
      )
      && handle.providerContinuationId === authority.providerContinuationId
      && sameProviderActionConnectionSnapshot(
        handle.providerConnection ?? null,
        authority.providerConnection,
      );
  }

  private status() {
    return {
      healthy: true,
      protocol_version: DAEMON_PROTOCOL_VERSION,
      implementation_version: DAEMON_IMPLEMENTATION_VERSION,
      capabilities: {
        room_delivery_retry: Boolean(this.supervisedDelivery && this.providerPort?.runRoomTurn),
        provider_continuation_repair: Boolean(this.supervisedDelivery && this.providerPort?.repairContinuation),
        room_delivery_skip: Boolean(this.supervisedDelivery),
        agent_inspector_detail_v1: true,
        agent_inspector_settings_v1: true,
        agent_room_move_v1: true,
        agent_lifecycle_v1: true,
        agent_runtime_recovery_v1: true,
        agent_state_subscription_v1: true,
        agent_activity_stream_v1: true,
      },
      generation: this.singleton.currentGeneration,
      pid: process.pid,
      started_at: this.startedAt,
    };
  }

  private async prepareHandoff(): Promise<void> {
    if (this.handoffTeardownScheduled) return;
    if (!this.handoffScheduled) this.handoffScheduled = true;
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
    await this.fenceAndDrainRoomMoveReconciliations();
    // Retire secret custody synchronously with the public handoff fence. The
    // dispatch preflight then proves every native return is journaled before
    // the acknowledgement can authorize Electron to replace this daemon.
    this.hostGrants.clear();
    this.openModelCredentials.clear();
    if (this.fatalProviderDispatchError) throw this.fatalProviderDispatchError;
    await Promise.all([...this.providerDispatchReservations]);
    if (this.fatalProviderDispatchError) throw this.fatalProviderDispatchError;
    await Promise.all([...this.boundedEffectJournalReservations]);
    this.handoffTeardownScheduled = true;
    // Delayed teardown exists only to flush the successful socket reply.
    setTimeout(() => {
      void this.stopForHandoff().then(
        () => this.resolveHandoffCompletion(),
        (error) => this.rejectHandoffCompletion(error),
      );
    }, 25).unref();
  }

  /**
   * Retire this detached daemon only when it has no provider execution left to
   * supervise. The manifest check and public handoff fence share the manifest
   * commit lane, so a concurrent lifecycle write cannot slip between them.
   * Paused agents are durable state, not background work, and remain resumable
   * when a later Desktop launch starts a fresh daemon generation.
   */
  private async shutdownIfIdle(): Promise<{
    outcome: "active" | "shutting_down";
    active_agents?: Array<{
      id: string;
      display_name: string;
      desired_state: DesiredState;
      observed_state: ObservedState;
    }>;
    generation: number;
  }> {
    if (this.handoffScheduled) {
      return { outcome: "shutting_down", generation: this.singleton.currentGeneration };
    }
    let activeAgents: DaemonManifestEntry[] = [];
    await this.serializeManifestCommit(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      activeAgents = manifest.entries.filter((entry) =>
        entry.desired_state === "running"
        || !["paused", "stopped"].includes(entry.observed_state)
        || this.liveHandles.has(entry.id)
        || this.lifecycleActiveEntries.has(entry.id)
      );
      if (activeAgents.length > 0) return;
      // This assignment is deliberately synchronous with the final manifest
      // read. Router and commit fences reject every later mutating request.
      this.handoffScheduled = true;
    });
    if (activeAgents.length > 0) {
      return {
        outcome: "active",
        active_agents: activeAgents.map((entry) => ({
          id: entry.id,
          display_name: entry.display_name,
          desired_state: entry.desired_state,
          observed_state: entry.observed_state,
        })),
        generation: this.singleton.currentGeneration,
      };
    }
    await this.prepareHandoff();
    return { outcome: "shutting_down", generation: this.singleton.currentGeneration };
  }

  private beginBootstrap<T>(run: (input: { entry_id: string; daemon_generation: number }, operation: BootstrapOperation) => Promise<T>, input: { entry_id: string; daemon_generation: number }): Promise<T> {
    const controller = new AbortController();
    const operation: BootstrapOperation = { controller, phase: "observing", operation: Promise.resolve() };
    const result = run(input, operation);
    operation.operation = result;
    this.bootstrapOperations.add(operation);
    const clear = () => this.bootstrapOperations.delete(operation);
    void result.then(clear, clear);
    return result;
  }


  private validateEntry(entry: DaemonManifestEntry): void {
    for (const field of ["id", "room_id", "display_name", "provider", "charter", "created_by", "created_at"] as const) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error(`Manifest entry ${field} is required.`);
    }
    if (!["running", "paused", "stopped"].includes(entry.desired_state)) throw new Error("Invalid desired state.");
  }

  private isSupervisedLaneOwner(entry: DaemonManifestEntry): boolean {
    return !(entry.desired_state === "stopped" && entry.observed_state === "stopped");
  }

  /**
   * Providers whose entries own independently addressable runtimes may have
   * multiple supervised participants in one room. This only relaxes
   * supervised-vs-supervised admission; a live supervised entry still fences
   * an Electron-owned legacy runtime for that provider below.
   */
  private competingSupervisedLaneOwner(
    entries: readonly DaemonManifestEntry[],
    entry: DaemonManifestEntry,
  ): DaemonManifestEntry | undefined {
    if (providerSupportsConcurrentSupervisedAgents(entry.provider)) return undefined;
    return entries.find((candidate) =>
      candidate.id !== entry.id
      && candidate.room_id === entry.room_id
      && candidate.provider === entry.provider
      && this.isSupervisedLaneOwner(candidate));
  }

  private async quarantineDuplicateSupervisedLaneOwners(): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const ownersByLane = new Map<string, DaemonManifestEntry[]>();
      for (const entry of manifest.entries) {
        if (providerSupportsConcurrentSupervisedAgents(entry.provider)) continue;
        if (!this.isSupervisedLaneOwner(entry)) continue;
        const key = `${entry.room_id}\u0000${entry.provider}`;
        const owners = ownersByLane.get(key) ?? [];
        owners.push(entry);
        ownersByLane.set(key, owners);
      }
      const duplicateIds = new Set(
        [...ownersByLane.values()]
          .filter((owners) => owners.length > 1)
          .flatMap((owners) => owners.map((entry) => entry.id)),
      );
      if (!duplicateIds.size) return;
      const entries = manifest.entries.map((entry) => duplicateIds.has(entry.id)
        ? {
            ...entry,
            desired_state: "stopped" as const,
            last_error: "LetAgents found multiple supervised agents for this provider lane after restart and stopped them to prevent duplicate work.",
          }
        : entry);
      const next = await this.writeManifest(this.manifestGeneration, entries, manifest.legacy_lane_owners);
      this.manifestGeneration = next.generation;
    });
  }

  /** Inspector configuration is a durable optimistic-concurrency resource. */
  private async getAgentConfiguration(entryId: string, daemonGeneration: number) {
    if (!entryId || daemonGeneration !== this.singleton.currentGeneration) throw new Error("Agent configuration is fenced by a stale daemon generation.");
    const configuration = await this.store.getAgentConfiguration(entryId);
    if (!configuration) throw new Error("The exact agent no longer exists.");
    return {
      entry_id: entryId, daemon_generation: daemonGeneration, ...configuration,
      supervised_permission_profiles: supervisedPermissionProfilesForProvider(configuration.provider),
    };
  }

  private async updateAgentConfiguration(input: { entryId: string; daemonGeneration: number; expectedRevision: number; configuration: Record<string, unknown> }) {
    if (!input.entryId || input.daemonGeneration !== this.singleton.currentGeneration || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { outcome: "invalid", error: "Configuration requires an exact agent, current daemon generation, and positive expected revision." };
    }
    const effort = input.configuration.reasoning_effort;
    const model = input.configuration.model;
    const charter = input.configuration.charter;
    const profile = input.configuration.permission_profile_id;
    if (!Object.hasOwn(input.configuration, "model") || !Object.hasOwn(input.configuration, "reasoning_effort")
      || !Object.hasOwn(input.configuration, "charter") || !Object.hasOwn(input.configuration, "permission_profile_id")
      || Object.hasOwn(input.configuration, "provider_launch_policy")
      || (effort !== null && !["low", "medium", "high", "xhigh", "max"].includes(String(effort)))
      || (model !== null && (typeof model !== "string" || !model.trim() || model.length > 256))
      || typeof charter !== "string" || !charter.trim()
      || charter.length > 32_768
      || (profile !== null && (typeof profile !== "string" || !profile.trim() || profile.length > 128))) {
      return { outcome: "invalid", error: "The selected provider does not accept this model, effort, charter, or permission profile. Native launch policy is managed by the desktop supervisor." };
    }
    const currentConfiguration = await this.store.getAgentConfiguration(input.entryId);
    if (!currentConfiguration) return { outcome: "invalid", error: "The exact agent no longer exists." };
    try {
      const normalized = deriveProviderConfigurationSnapshot({
        provider: currentConfiguration.provider,
        model: model === null ? null : (model as string).trim(),
        reasoningEffort: effort as ProviderReasoningEffort,
        permissionProfileId: profile === null ? null : (profile as string).trim(),
        configurationRevision: input.expectedRevision + 1,
      }, currentConfiguration.provider_launch_policy);
      return this.serializeManifestMutation(async () => {
        await this.singleton.assertCurrent();
        const result = await this.store.updateAgentConfiguration(this.manifestGeneration, {
          agentId: input.entryId, expectedRevision: input.expectedRevision, model: normalized.model,
          reasoningEffort: normalized.reasoningEffort, charter: charter.trim(),
          permissionProfileId: normalized.permissionProfileId, providerLaunchPolicy: normalized.launchPolicy,
        }, (commit) => this.fenceDaemonCommit(commit));
        this.manifestGeneration = result.generation;
        if (result.outcome === "invalid") return { outcome: "invalid", error: "The exact agent no longer exists." };
        return { outcome: result.outcome, configuration: await this.getAgentConfiguration(input.entryId, input.daemonGeneration) };
      });
    } catch (error) {
      return { outcome: "invalid", error: schedulerErrorDetail(error) };
    }
  }

  /**
   * Explicitly replace a provider runtime that is durably proven absent.
   *
   * Reconnect is intentionally credential-only and may never create a second
   * writer. Recovery crosses that boundary only after the saved execution is
   * terminal (or an attach returns exact terminal evidence), ends the prior
   * worker session, and retires every stale runtime/binding coordinate. The
   * durable agent, room, work attempt, workspace, configuration, inbox, and
   * cursor remain untouched; ordinary convergence then creates one successor
   * provider generation.
   */
  private async completeTurnControlForRuntimeRecovery(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    const control = entry.turn_control;
    if (!control || control.status === "completed") return entry;
    if (!entry.work_attempt_id || control.work_attempt_id !== entry.work_attempt_id) {
      throw new Error("Provider recovery found a turn-control barrier owned by a different work attempt.");
    }
    const attempt = await this.durability.getAttempt(control.work_attempt_id);
    const controlledExecution = attempt.execution_generations.find((candidate) =>
      candidate.execution_generation_id === control.execution_generation_id);
    if (!controlledExecution?.terminal) {
      throw new Error("Provider recovery cannot retire turn control before its exact execution generation is durably terminal.");
    }
    const observedAt = new Date(this.nowMs()).toISOString();
    const checkpoint = await this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const committed = await this.store.commitTurnControlState(this.manifestGeneration, {
        agentId: entry.id,
        roomId: entry.room_id,
        actionId: control.action_id,
        workAttemptId: control.work_attempt_id,
        executionGenerationId: control.execution_generation_id,
        mode: "runtime_recovered",
        // Terminal provider evidence retires the control barrier. FIFO state
        // is changed only when the journal persisted A's exact inbox identity;
        // an unlinked historical head may actually be successor B.
        settleOriginal: Boolean(control.inbox_item_id),
        activateCorrection: control.correction_strategy === "stop_then_resend",
        observedAt,
      }, (current, outcome) => ({
        ...current,
        reconciliation: rememberCompletedControlAction(
          advanceReconciliationState(current.reconciliation, current.observed_state, this.nowMs()),
          control.action_id,
        ),
        turn_control: {
          ...current.turn_control!,
          inbox_item_id: outcome.inboxItemId,
          provider_turn_id: outcome.providerTurnId,
          operator_resolution: null,
          status: "completed",
          interrupted: outcome.original === "cancelled",
          resumed: control.correction_strategy === "stop_then_resend",
          state: "idle",
          stages: outcome.inboxItemId
            ? control.correction_strategy === "stop_then_resend"
              ? ["delivered", "applied", "resumed"]
              : ["delivered", "applied"]
            : control.correction_strategy === "stop_then_resend"
              ? ["delivered", "resumed"]
              : [],
          error: control.has_correction && control.correction_strategy !== "stop_then_resend"
            ? "The previous provider was terminally recovered. Its legacy correction payload was not durably recoverable and must be reissued."
            : outcome.inboxItemId
              ? "The previous provider was terminally recovered; its exact linked turn-control barrier was settled before replacement."
              : "The previous provider was terminally recovered. The unlinked legacy control barrier was retired without guessing or mutating the current FIFO head.",
          updated_at: observedAt,
        },
      }), (commit) => this.fenceDaemonCommit(commit));
      this.manifestGeneration = committed.generation;
      return committed;
    });
    return checkpoint.entry;
  }

  private async recoverAgentRuntime(entryId: string, daemonGeneration: number) {
    const release = this.beginLifecycleExclusion(entryId);
    try {
      return await this.recoverAgentRuntimeExclusive(entryId, daemonGeneration);
    } finally {
      release();
    }
  }

  private async recoverAgentRuntimeExclusive(entryId: string, daemonGeneration: number) {
    if (!entryId || daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("Agent runtime recovery is fenced by a stale daemon generation.");
    }
    this.bumpEntryControlEpoch(entryId);
    this.clearRecoveryConvergence(entryId);
    const updated = await this.serializeEntryTick(entryId, async () => {
      await this.singleton.assertCurrent();
      if (daemonGeneration !== this.singleton.currentGeneration || this.handoffScheduled) {
        throw new Error("Agent runtime recovery lost daemon authority.");
      }
      let entry = await this.store.getEntry(entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      if (entry.desired_state === "stopped") {
        throw new Error("A stopped agent must be resumed before its runtime can be recovered.");
      }
      if (this.liveHandles.has(entryId)) {
        throw new Error("The provider runtime is still connected. Reconnect its credentials instead.");
      }
      // Runtime replacement is destructive: terminal evidence, the worker
      // session, and its credential binding are retired below. Prove first—
      // while lifecycle exclusion and the per-entry lane prevent any new room
      // move edge—that destination membership has not entered an ambiguous or
      // post-join phase. The final manifest mutation still performs the exact
      // atomic pre-membership cancellation; this early phase fence prevents us
      // from destroying the authority needed to compensate a later phase.
      const pendingRoomMoves = await this.store.pendingRoomMoves(entryId);
      if (pendingRoomMoves.length > 1) {
        throw new Error("Runtime recovery found more than one nonterminal room move for this agent.");
      }
      if (pendingRoomMoves.some((move) => !["prepared", "waiting_for_current_turn"].includes(move.phase))) {
        throw new Error("Agent runtime recovery is blocked while a room move may have changed destination membership.");
      }

      const ref = entry.provider_ref ?? null;
      if (ref) {
        if (!entry.work_attempt_id || ref.work_attempt_id !== entry.work_attempt_id) {
          throw new Error("The saved provider runtime no longer matches this agent’s durable work attempt.");
        }
        const attempt = await this.durability.getAttempt(ref.work_attempt_id);
        const execution = attempt.execution_generations.find((candidate) =>
          candidate.execution_generation_id === ref.execution_generation_id);
        if (!execution) {
          throw new Error("The saved provider runtime has no matching durable execution generation.");
        }
        if (!execution.terminal) {
          if (!this.providerPort) throw new Error("Provider recovery is unavailable.");
          const attachment = await this.providerPort.attach(this.providerRef(entry));
          if (!attachment) {
            throw new Error("LetAgents cannot prove that the previous provider process stopped. Recovery was not started.");
          }
          if (!this.isAttachTerminal(attachment)) {
            throw new Error("The provider runtime is still reachable. Reconnect its credentials instead.");
          }
          if (attachment.terminal.providerContinuationId
            && attachment.terminal.providerContinuationId !== ref.provider_continuation_id) {
            throw new Error("Provider recovery returned terminal evidence for a different continuation.");
          }
          await this.durability.recordTerminal(ref.work_attempt_id, ref.execution_generation_id, {
            ...this.terminalPayload(attachment.terminal, execution.actor),
            actor: execution.actor,
            generation: execution.generation,
          });
          await this.durability.releaseTerminalExecutionFence(ref.work_attempt_id, ref.execution_generation_id);
        }
      }

      await this.supervisedDelivery?.stop(entryId).catch(() => undefined);
      // Exact terminal evidence for the old provider is the generation-cutover
      // boundary. Settle its journal/FIFO effects before removing provider_ref;
      // otherwise an old unresolved action would freeze every future generation.
      entry = await this.completeTurnControlForRuntimeRecovery(await this.store.getEntry(entryId) ?? entry);
      const binding = await this.workerBindings.get(entryId);
      const retainedSessionId = binding?.agent_session_id
        ?? entry.last_worker_binding?.agent_session_id
        ?? null;
      if (retainedSessionId) {
        const grant = this.currentHostGrant(entry);
        if (!grant || !this.supervisorGrantHttp.endWorkerSession) {
          throw new Error("Desktop credentials are required before this provider can be safely recovered.");
        }
        await this.supervisorGrantHttp.endWorkerSession({
          apiUrl: grant.apiUrl,
          grantId: grant.grantId,
          supervisorGrant: grant.supervisorGrant,
          grantGeneration: grant.grantGeneration,
          sessionId: retainedSessionId,
        });
      }
      if (binding) {
        await this.workerBindings.unbind(
          entryId,
          binding.agent_session_id,
          binding.execution_generation_id,
        );
      }
      this.liveBindingIdentities.delete(entryId);
      this.pendingResumeBindings.delete(entryId);
      this.cachedWorkerAuthorizations.delete(entryId);

      entry = await this.updateManifestEntry(entryId, (current) => ({
        ...current,
        desired_state: "running",
        observed_state: "starting",
        condition: "none",
        last_error: null,
        run_id: null,
        deployment_id: null,
        provider_ref: null,
        last_worker_binding: null,
        workplace_liveness: {
          state: "unknown",
          observed_at: new Date(this.nowMs()).toISOString(),
          detail: "Preparing a replacement provider and exact worker binding.",
        },
        native_liveness: {
          state: "unknown",
          observed_at: new Date(this.nowMs()).toISOString(),
          detail: "The previous provider process stopped; a replacement is starting.",
        },
      }), {
        agentId: entryId,
        detail: "Room move cancelled because its activating provider runtime ended before destination membership was joined.",
      });
      return entry;
    });
    this.requestConvergence(entryId);
    return { outcome: "recovering", entry: await this.entryWithDerivedLiveness(updated) };
  }

  /** Retire preserves the identity, durable receipts, and on-disk worktree. */
  private async retireAgent(entryId: string, daemonGeneration: number) {
    if (!entryId || daemonGeneration !== this.singleton.currentGeneration) throw new Error("Retire is fenced by a stale daemon generation.");
    const entry = await this.setDesiredState(entryId, "stopped");
    return { outcome: "retired", entry: this.entryWithDerivedLiveness(entry) };
  }

  /** Purge is intentionally stricter than retire and never removes a worktree. */
  private async purgeAgent(
    entryId: string,
    daemonGeneration: number,
    revokedAgentSessionId: string | null = null,
    grantRevokedWithoutWorkerSession = false,
  ) {
    if (!entryId || daemonGeneration !== this.singleton.currentGeneration) throw new Error("Purge is fenced by a stale daemon generation.");
    return this.serializeEntryTick(entryId, async () => {
      const preflight = await this.store.getEntry(entryId);
      if (preflight && (preflight.desired_state !== "stopped"
        || !["absent", "stopped", "failed"].includes(preflight.observed_state))) {
        return { outcome: "invalid" as const, error: "Purge requires a fully stopped durable lifecycle." };
      }
      const cursorConnection = preflight?.provider_ref?.provider_connection?.kind === "cursor_cli"
        ? preflight.provider_ref.provider_connection
        : null;
      if (preflight && !this.liveHandles.has(entryId) && cursorConnection && cursorConnection.pid !== null) {
        if (!this.providerPort?.stopRef) {
          return { outcome: "invalid" as const, error: "Purge cannot prove the unattached Cursor wrapper is stopped." };
        }
        try {
          const ref = this.providerRef(preflight);
          const terminal = await this.providerPort.stopRef(ref, {
            actionId: `purge:${entryId}:cursor-wrapper-fence:${preflight.provider_ref!.execution_generation_id}`,
          });
          const attempt = await this.durability.getAttempt(ref.workAttemptId);
          const execution = attempt.execution_generations.find((candidate) =>
            candidate.execution_generation_id === preflight.provider_ref!.execution_generation_id);
          if (!execution) throw new Error("Cursor purge fence has no matching durable execution generation.");
          if (!execution.terminal) {
            await this.durability.recordTerminal(ref.workAttemptId, execution.execution_generation_id, {
              ...this.terminalPayload(terminal, execution.actor),
              actor: execution.actor,
              generation: execution.generation,
            });
          }
          await this.durability.releaseTerminalExecutionFence(ref.workAttemptId, execution.execution_generation_id);
        } catch (error) {
          return {
            outcome: "invalid" as const,
            error: `Purge could not fence the unattached Cursor wrapper: ${schedulerErrorDetail(error)}`,
          };
        }
      }
      return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const operationId = `purge:${entryId}`;
      let purge = await this.store.getPurge(operationId);
      const entry = await this.store.getEntry(entryId);
      if (!entry) {
        return purge?.phase === "complete" || !purge
          ? {
            outcome: "purged" as const,
            ...(purge?.attached_work_attempt_id
              ? { purged_work_attempt_id: purge.attached_work_attempt_id }
              : {}),
          }
          : { outcome: "invalid" as const, error: "Purge identity is absent but its journal is incomplete." };
      }
      if (this.liveHandles.has(entryId)) return { outcome: "invalid" as const, error: "Purge requires no live provider or bounded delivery turn." };
      if (!purge) {
        try {
          const externalRevokeRequired = this.requiresHostGrant(entry);
          const evidence = externalRevokeRequired
            ? await this.store.durablePurgeWorkerSessionAttestation(entryId)
            : { workerSessionAttestation: "not_required" as const, agentSessionId: null };
          purge = (await this.store.preparePurge(this.manifestGeneration, {
            operationId, requestId: operationId, agentId: entryId, daemonGeneration,
            // Electron is the durable grant custodian, so every daemon-inbox
            // identity requires an owner-authenticated revoke acknowledgement.
            externalRevokeRequired,
            workerSessionAttestation: evidence.workerSessionAttestation,
            agentSessionId: evidence.agentSessionId,
          })).purge;
        } catch (error) {
          return { outcome: "invalid" as const, error: schedulerErrorDetail(error) };
        }
      }
      if (purge.daemon_generation !== daemonGeneration) {
        purge = await this.store.adoptPurgeDaemonGeneration({ operationId, agentId: entryId, expectedDaemonGeneration: purge.daemon_generation, daemonGeneration });
      }
      if (purge.phase === "reprepare_credentials") {
        const evidence = await this.store.durablePurgeWorkerSessionAttestation(entryId);
        if (evidence.workerSessionAttestation === "unknown") {
          return {
            outcome: "invalid" as const,
            error: "Purge credential recovery needs an exact retained worker session or durable proof that no worker session was minted.",
          };
        }
        purge = await this.store.repreparePurgeCredentials({
          operationId,
          agentId: entryId,
          expectedDaemonGeneration: daemonGeneration,
          workerSessionAttestation: evidence.workerSessionAttestation,
          agentSessionId: evidence.agentSessionId,
        });
      }
      if (revokedAgentSessionId && purge.phase === "revoking_credentials") {
        purge = await this.store.markPurgeCredentialsRevoked({
          operationId,
          agentId: entryId,
          expectedDaemonGeneration: daemonGeneration,
          agentSessionId: revokedAgentSessionId,
        });
      }
      if (grantRevokedWithoutWorkerSession && purge.phase === "revoking_credentials") {
        purge = await this.store.markPurgeGrantRevokedWithoutWorkerSession({
          operationId,
          agentId: entryId,
          expectedDaemonGeneration: daemonGeneration,
        });
      }
      if (purge.phase === "revoking_credentials") {
        if (purge.worker_session_attestation === "exact" && purge.agent_session_id) {
          return {
            outcome: "revocation_required" as const,
            operation_id: operationId,
            revocation_kind: "worker_session" as const,
            agent_session_id: purge.agent_session_id,
          };
        }
        if (purge.worker_session_attestation === "none" && purge.agent_session_id === null) {
          return {
            outcome: "revocation_required" as const,
            operation_id: operationId,
            revocation_kind: "grant_only" as const,
          };
        }
        return { outcome: "invalid" as const, error: "Purge revocation evidence is internally inconsistent." };
      }
      if (purge.phase === "complete") {
        return {
          outcome: "purged" as const,
          ...(purge.attached_work_attempt_id
            ? { purged_work_attempt_id: purge.attached_work_attempt_id }
            : {}),
        };
      }
      if (purge.phase !== "local_commit") return { outcome: "invalid" as const, error: purge.error ?? "Purge journal is not committable." };
      try {
        if (purge.attached_work_attempt_id) {
          await this.removeEphemeralWorkAttempt(purge.attached_work_attempt_id);
        }
        const committed = await this.store.commitPurge(this.manifestGeneration, { operationId, agentId: entryId, daemonGeneration }, (commit) => this.fenceDaemonCommit(commit));
        this.manifestGeneration = committed.generation;
      } catch (error) {
        return { outcome: "invalid" as const, error: schedulerErrorDetail(error) };
      }
      this.liveBindingIdentities.delete(entryId); this.cachedWorkerAuthorizations.delete(entryId); this.hostGrants.delete(entryId); this.openModelCredentials.delete(entryId);
      // The ephemeral live feed shares the durable identity's lifetime: wake any
      // outstanding watcher so its long-poll returns, then drop the buffer and
      // its waiter set so a purged agent leaves no transcript in daemon memory.
      this.notifyAgentStreamWaiters(entryId);
      this.agentStreams.delete(entryId);
      this.agentStreamWaiters.delete(entryId);
      return {
        outcome: "purged" as const,
        ...(purge.attached_work_attempt_id
          ? { purged_work_attempt_id: purge.attached_work_attempt_id }
          : {}),
      };
      });
    });
  }

  private async recoverPreparedPurges(): Promise<void> {
    for (const purge of await this.store.pendingPurges()) {
      if (purge.phase !== "local_commit") continue; // Electron must finish external revocation.
      await this.purgeAgent(purge.agent_id, this.singleton.currentGeneration, null, false).catch(() => undefined);
    }
  }

  private async removeEphemeralWorkAttempt(workAttemptId: string): Promise<boolean> {
    let attempt = await this.durability.getAttempt(workAttemptId);
    if (!isEphemeralWorkspaceMarker(attempt.workspace_identity)) return false;
    if (!attempt.concluded_at && !["gc_pending", "garbage_collected"].includes(attempt.state)) {
      attempt = await this.durability.concludeAttempt(workAttemptId, {
        state: "cleanly_concluded",
        cause: "room_only_agent_purged",
      });
    }
    if (attempt.state !== "garbage_collected") {
      await this.durability.garbageCollectEphemeralAttempt(workAttemptId);
    }
    return true;
  }

  private async recoverEphemeralWorkspaces(): Promise<void> {
    const manifest = await this.store.load();
    const attached = new Set<string>();
    for (const entry of manifest.entries) {
      if (entry.work_attempt_id) attached.add(entry.work_attempt_id);
      if (entry.provider_ref?.work_attempt_id) attached.add(entry.provider_ref.work_attempt_id);
    }
    for (const purge of await this.store.pendingPurges()) {
      if (purge.attached_work_attempt_id) attached.add(purge.attached_work_attempt_id);
    }
    for (const attempt of await this.durability.listAttempts()) {
      if (!isEphemeralWorkspaceMarker(attempt.workspace_identity) || attached.has(attempt.work_attempt_id)) continue;
      if (attempt.execution_generations.some((generation) => generation.terminal === null)) {
        console.error(`Refusing to collect orphaned room-only attempt ${attempt.work_attempt_id}: live execution evidence remains.`);
        continue;
      }
      await this.removeEphemeralWorkAttempt(attempt.work_attempt_id).catch((error) => {
        console.error(`Refusing to collect orphaned room-only attempt ${attempt.work_attempt_id}:`, error);
      });
    }
    const retained = new Set((await this.durability.listAttempts()).map((attempt) => attempt.work_attempt_id));
    await this.ephemeralProvisioner.garbageCollectOrphans(retained);
  }

  private async putManifestEntry(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    this.validateEntry(entry);
    const updated = await this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const purgeTombstone = await this.store.getPurge(`purge:${entry.id}`);
      if (purgeTombstone?.phase === "complete") {
        throw new Error(`Supervised entry '${entry.id}' was permanently purged. Start a genuinely new agent with a new creation request id.`);
      }
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const existing = manifest.entries.find((candidate) => candidate.id === entry.id);
      if (existing) {
        if (!isDeepStrictEqual(
          projectDaemonCreateRequestReplayParameters(existing),
          projectDaemonCreateRequestReplayParameters(entry),
        )) {
          throw new Error(`Supervised creation request '${entry.id}' is already bound to different agent parameters.`);
        }
        // A retry after a lost response must observe the durable entry as it is
        // now. It must never rewind running lifecycle state back to the paused
        // creation claim supplied by the retried request.
        return existing;
      }
      if (entry.desired_state !== "stopped") {
        const supervisedOwner = this.competingSupervisedLaneOwner(manifest.entries, entry);
        if (supervisedOwner) {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
        }
        // A paused supervised entry may atomically become the pending transfer
        // claim while one legacy engine is still running. It cannot activate
        // until that exact legacy reservation has been released.
        const legacyOwner = legacyOwners.find((candidate) =>
          candidate.room_id === entry.room_id && candidate.provider === entry.provider);
        if (legacyOwner && entry.desired_state === "running") {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
        }
      }
      const nextEntry: DaemonManifestEntry = {
        ...entry,
        workplace_liveness: entry.workplace_liveness ?? { state: "unknown", observed_at: null, detail: null },
        native_liveness: entry.native_liveness ?? { state: "unknown", observed_at: null, detail: null },
        activity: (entry.activity ?? []).slice(-200),
      };
      const entries = [...manifest.entries, nextEntry];
      const next = await this.writeManifest(this.manifestGeneration, entries, legacyOwners);
      this.manifestGeneration = next.generation;
      return nextEntry;
    });
    this.requestConvergence(updated.id);
    return updated;
  }

  private beginLifecycleExclusion(entryId: string): () => void {
    if (this.lifecycleActiveEntries.has(entryId) || this.turnControlActiveEntries.has(entryId)) {
      throw new Error("This supervised entry already has an in-flight lifecycle or turn-control action.");
    }
    this.lifecycleActiveEntries.add(entryId);
    for (const waiter of this.roomMoveExclusionWaiters.get(entryId) ?? []) waiter();
    return () => { this.lifecycleActiveEntries.delete(entryId); };
  }

  private async setDesiredState(id: string, desiredState: DesiredState): Promise<DaemonManifestEntry> {
    const release = this.beginLifecycleExclusion(id);
    try {
      return await this.setDesiredStateExclusive(id, desiredState);
    } finally {
      release();
    }
  }

  private async setDesiredStateExclusive(id: string, desiredState: DesiredState): Promise<DaemonManifestEntry> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["running", "paused", "stopped"].includes(desiredState)) throw new Error("Invalid desired state.");
    this.bumpEntryControlEpoch(id);
    const deliveryStopped = desiredState !== "running" && Boolean(this.supervisedDelivery);
    if (deliveryStopped) {
      try {
        // Wait only for a room-move transition that was already active when
        // lifecycle exclusion began. Provider launch/capability work remains
        // fenceable and cannot make Stop/Pause wait on the broad entry lane.
        await this.waitForActiveRoomMoveReconciliation(id);
        this.clearRecoveryConvergence(id);
        await this.supervisedDelivery!.stop(id);
      } catch (error) {
        await this.restartSupervisedDeliveryOrConverge(id);
        throw error;
      }
    }
    let updated: DaemonManifestEntry;
    try {
      updated = await this.serializeManifestMutation(async () => {
        await this.singleton.assertCurrent();
        const manifest = await this.store.load();
        const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
        const entry = manifest.entries.find((candidate) => candidate.id === id);
        if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
        if (desiredState !== "stopped") {
          const supervisedOwner = this.competingSupervisedLaneOwner(manifest.entries, entry);
          if (supervisedOwner) {
            throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
          }
          const legacyOwner = legacyOwners.find((candidate) =>
            candidate.room_id === entry.room_id && candidate.provider === entry.provider);
          if (legacyOwner && desiredState === "running") {
            throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
          }
        }
        const updated = { ...entry, desired_state: desiredState };
        const next = await this.writeManifest(
          this.manifestGeneration,
          manifest.entries.map((candidate) => candidate.id === id ? updated : candidate),
          legacyOwners,
          desiredState === "running" ? undefined : {
            agentId: id,
            detail: `Room move cancelled because the agent lifecycle changed to ${desiredState} before destination membership was joined.`,
          },
        );
        this.manifestGeneration = next.generation;
        return updated;
      });
    } catch (error) {
      if (deliveryStopped) await this.restartSupervisedDeliveryOrConverge(id);
      throw error;
    }
    this.requestConvergence(id);
    return updated;
  }

  /**
   * Repair mutable product identity without touching provider execution,
   * delivery cursors, credentials, or lifecycle authority.
   */
  private async setDisplayName(id: string, displayName: string): Promise<DaemonManifestEntry> {
    const normalized = displayName.trim();
    if (!id || !normalized || normalized.length > 120) {
      throw new Error("Agent naming requires an exact identity and display name.");
    }
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      if (entry.display_name === normalized) return entry;
      const updated = { ...entry, display_name: normalized };
      const next = await this.writeManifest(
        this.manifestGeneration,
        manifest.entries.map((candidate) => candidate.id === id ? updated : candidate),
        this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []),
      );
      this.manifestGeneration = next.generation;
      return updated;
    });
  }

  private async compareAndSetDesiredState(
    id: string,
    expectedDesiredState: DesiredState,
    desiredState: DesiredState,
  ): Promise<{ applied: boolean; entry: DaemonManifestEntry }> {
    const release = this.beginLifecycleExclusion(id);
    try {
      return await this.compareAndSetDesiredStateExclusive(id, expectedDesiredState, desiredState);
    } finally {
      release();
    }
  }

  private async compareAndSetDesiredStateExclusive(
    id: string,
    expectedDesiredState: DesiredState,
    desiredState: DesiredState,
  ): Promise<{ applied: boolean; entry: DaemonManifestEntry }> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["running", "paused", "stopped"].includes(expectedDesiredState)) throw new Error("Invalid expected desired state.");
    if (!["running", "paused", "stopped"].includes(desiredState)) throw new Error("Invalid desired state.");
    const preflight = await this.store.getEntry(id);
    if (!preflight) throw new Error(`Unknown daemon manifest entry: ${id}`);
    if (preflight.desired_state !== expectedDesiredState) {
      return { applied: false, entry: preflight };
    }
    this.bumpEntryControlEpoch(id);
    const deliveryStopped = desiredState !== "running" && Boolean(this.supervisedDelivery);
    if (deliveryStopped) {
      try {
        await this.waitForActiveRoomMoveReconciliation(id);
        this.clearRecoveryConvergence(id);
        await this.supervisedDelivery!.stop(id);
      } catch (error) {
        await this.restartSupervisedDeliveryOrConverge(id);
        throw error;
      }
    }
    let result: { applied: boolean; entry: DaemonManifestEntry };
    try {
      result = await this.serializeManifestMutation(async () => {
        await this.singleton.assertCurrent();
        const manifest = await this.store.load();
        const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
        const entry = manifest.entries.find((candidate) => candidate.id === id);
        if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
        if (entry.desired_state !== expectedDesiredState) return { applied: false, entry };
        if (desiredState !== "stopped") {
          const supervisedOwner = this.competingSupervisedLaneOwner(manifest.entries, entry);
          if (supervisedOwner) {
            throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
          }
          const legacyOwner = legacyOwners.find((candidate) =>
            candidate.room_id === entry.room_id && candidate.provider === entry.provider);
          if (legacyOwner && desiredState === "running") {
            throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
          }
        }
        const updated = { ...entry, desired_state: desiredState };
        const next = await this.writeManifest(
          this.manifestGeneration,
          manifest.entries.map((candidate) => candidate.id === id ? updated : candidate),
          legacyOwners,
          desiredState === "running" ? undefined : {
            agentId: id,
            detail: `Room move cancelled because the agent lifecycle changed to ${desiredState} before destination membership was joined.`,
          },
        );
        this.manifestGeneration = next.generation;
        return { applied: true, entry: updated };
      });
    } catch (error) {
      if (deliveryStopped) await this.restartSupervisedDeliveryOrConverge(id);
      throw error;
    }
    if (result.applied) {
      this.requestConvergence(id);
    } else {
      if (deliveryStopped) await this.restartSupervisedDeliveryOrConverge(id);
      // The speculative epoch bump may have fenced an in-flight launch even
      // though the CAS lost. Reconcile the unchanged durable state again.
      this.requestConvergence(id);
    }
    return result;
  }

  private controlTurn(input: {
    entryId: string;
    daemonGeneration: number;
    roomId: string;
    workAttemptId: string;
    executionGenerationId: string;
    providerContinuationId: string;
    providerTurnId: string;
    inboxItemId: string;
    sourceMessageId: string;
    actionId: string;
    actionSequence: number;
    correction: string | null;
  }): Promise<DaemonTurnControlResult> {
    for (const [field, value] of Object.entries({
      id: input.entryId,
      room_id: input.roomId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      provider_continuation_id: input.providerContinuationId,
      provider_turn_id: input.providerTurnId,
      inbox_item_id: input.inboxItemId,
      source_message_id: input.sourceMessageId,
      action_id: input.actionId,
    })) {
      if (!value.trim() || value !== value.trim()) throw new Error(`Turn control ${field} is required.`);
    }
    if (!Number.isSafeInteger(input.actionSequence) || input.actionSequence < 1) {
      throw new Error("Turn control action_sequence must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) {
      throw new Error("Turn control daemon_generation must be a positive safe integer.");
    }
    const correction = input.correction?.trim() || null;
    if (Buffer.byteLength(input.actionId, "utf8") > MAX_TURN_CONTROL_ACTION_ID_BYTES
      || !/^[A-Za-z0-9._:-]+$/.test(input.actionId)) {
      throw new Error("Turn control action_id must be at most 256 UTF-8 bytes and contain only letters, numbers, '.', '_', ':', or '-'.");
    }
    if (correction && Buffer.byteLength(correction, "utf8") > MAX_TURN_CONTROL_CORRECTION_BYTES) {
      throw new Error("Turn control correction exceeds the 32 KiB durable payload limit.");
    }
    const normalizedInput = { ...input, correction };
    const requestKey = JSON.stringify([normalizedInput.entryId, normalizedInput.actionId]);
    const existing = this.turnControlRequests.get(requestKey);
    if (existing) {
      const sameInput = existing.input.entryId === normalizedInput.entryId
        && existing.input.daemonGeneration === normalizedInput.daemonGeneration
        && existing.input.roomId === normalizedInput.roomId
        && existing.input.workAttemptId === normalizedInput.workAttemptId
        && existing.input.executionGenerationId === normalizedInput.executionGenerationId
        && existing.input.providerContinuationId === normalizedInput.providerContinuationId
        && existing.input.providerTurnId === normalizedInput.providerTurnId
        && existing.input.inboxItemId === normalizedInput.inboxItemId
        && existing.input.sourceMessageId === normalizedInput.sourceMessageId
        && existing.input.actionId === normalizedInput.actionId
        && existing.input.actionSequence === normalizedInput.actionSequence
        && existing.input.correction === normalizedInput.correction;
      if (!sameInput) throw new Error("An in-flight turn-control action id was reused with different fenced input.");
      return existing.operation;
    }
    if (this.lifecycleActiveEntries.has(normalizedInput.entryId)) {
      throw new Error("Turn control is unavailable while a lifecycle action is in flight for this supervised entry.");
    }
    if (this.turnControlActiveEntries.has(normalizedInput.entryId)) {
      throw new Error("A turn-control action is already in flight for this exact supervised entry.");
    }
    this.turnControlActiveEntries.add(normalizedInput.entryId);
    const operation = this.controlTurnOnce(normalizedInput).finally(() => {
      this.turnControlRequests.delete(requestKey);
      this.turnControlActiveEntries.delete(normalizedInput.entryId);
    });
    this.turnControlRequests.set(requestKey, { input: normalizedInput, operation });
    return operation;
  }

  private async resolveTurnControl(input: {
    entryId: string;
    workAttemptId: string;
    executionGenerationId: string;
    actionId: string;
    resolution: "not_applied" | "applied";
  }): Promise<DaemonManifestEntryView> {
    if (!input.entryId || !input.workAttemptId || !input.executionGenerationId || !input.actionId) {
      throw new Error("Exact turn-control resolution identity is required.");
    }
    if (input.resolution !== "not_applied" && input.resolution !== "applied") {
      throw new Error("Turn-control resolution must be 'not_applied' or 'applied'.");
    }
    const prior = await this.store.getEntry(input.entryId);
    const priorControl = prior?.turn_control;
    if (prior
      && prior.work_attempt_id === input.workAttemptId
      && priorControl?.action_id === input.actionId
      && priorControl.work_attempt_id === input.workAttemptId
      && priorControl.execution_generation_id === input.executionGenerationId
      && priorControl.status === "completed") {
      if (priorControl.operator_resolution !== input.resolution) {
        throw new Error("This turn-control action was already completed with a different operator resolution.");
      }
      return this.entryWithDerivedLiveness(prior);
    }
    const updatedAt = new Date().toISOString();
    let committed: Awaited<ReturnType<ManifestStore["commitTurnControlState"]>>;
    try {
      committed = await this.serializeEntryTick(input.entryId, () => this.serializeManifestMutation(async () => {
        await this.singleton.assertCurrent();
        const current = await this.store.getEntry(input.entryId);
        const control = current?.turn_control;
        // Current-runtime resolution needs no attempt-store lookup. Historical
        // resolution consults durability only when the provider reference was
        // detached or replaced, so legacy current journals are not rejected by
        // stricter modern work-attempt identifier validation.
        const currentRuntimeMatches = current?.provider_ref?.execution_generation_id === input.executionGenerationId;
        const controlledAttempt = current?.work_attempt_id === input.workAttemptId && !currentRuntimeMatches
          ? await this.durability.getAttempt(input.workAttemptId)
          : null;
        const controlledExecutionTerminal = Boolean(controlledAttempt?.execution_generations.some((candidate) =>
          candidate.execution_generation_id === input.executionGenerationId && candidate.terminal));
        if (!current
          || !control
          || control.action_id !== input.actionId
          || control.work_attempt_id !== input.workAttemptId
          || control.execution_generation_id !== input.executionGenerationId
          || current.work_attempt_id !== input.workAttemptId
          || (!currentRuntimeMatches && !controlledExecutionTerminal)) {
          throw new Error("Turn-control resolution identity is stale or belongs to another execution.");
        }
        if (control.status !== "uncertain") {
          throw new Error("Only an uncertain turn-control outcome requires operator resolution.");
        }
        const checkpoint = await this.store.commitTurnControlState(this.manifestGeneration, {
          agentId: current.id,
          roomId: current.room_id,
          actionId: input.actionId,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          mode: input.resolution === "applied" ? "operator_applied" : "operator_not_applied",
          // Every applied native interrupt settles the exact old FIFO row. A
          // legacy daemon-inbox native-correction journal cannot safely resume
          // that old provider turn; future corrections never create this shape
          // because daemon-owned corrections use bounded stop-then-resend.
          settleOriginal: input.resolution === "applied" && Boolean(control.inbox_item_id),
          // The operator resolves only whether native Stop happened. The
          // already-accepted durable correction intent survives either answer.
          activateCorrection: control.correction_strategy === "stop_then_resend",
          observedAt: updatedAt,
        }, (entry, outcome) => {
          const publicationWon = outcome.original === "publication_won";
          const interrupted = input.resolution === "applied" && !publicationWon;
          const resumed = control.correction_strategy === "stop_then_resend"
            || (input.resolution === "applied" && control.has_correction);
          const activity = [...(entry.activity ?? []), sanitizeDaemonActivityEvent({
            observed_at: updatedAt,
            sequence: ((entry.activity ?? []).at(-1)?.sequence ?? 0) + 1,
            provider: entry.provider,
            kind: "turn_lifecycle",
            method: "supervisor/resolve-turn-control",
            summary: input.resolution === "not_applied"
              ? publicationWon
                ? "Operator verified the native control was not applied; the committed reply stands"
                : outcome.original === "cancelled"
                  ? "Operator verified the native control was not applied; the migration-cancelled legacy turn remains retired"
                  : "Operator verified the native control was not applied; the exact turn was recovered"
              : publicationWon
                ? "Operator verified the native control was applied after the reply had already committed"
                : control.correction_strategy === "stop_then_resend"
                  ? "Operator verified the stop was applied; the durable correction was queued"
                  : "Operator verified the ambiguous native effect was applied",
            status: entry.observed_state === "working" ? "working" : "idle",
            payload: { action_id: control.action_id, resolution: input.resolution },
            payload_truncated: false,
            payload_redacted: false,
            durable_payload_ref: null,
          })].slice(-200);
          return {
            ...entry,
            activity,
            reconciliation: rememberCompletedControlAction(
              advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()),
              control.action_id,
            ),
            turn_control: {
              ...control,
              inbox_item_id: outcome.inboxItemId,
              provider_turn_id: outcome.providerTurnId,
              operator_resolution: input.resolution,
              status: "completed",
              interrupted,
              resumed,
              state: entry.observed_state === "working" ? "working" : "idle",
              stages: input.resolution === "applied" ? ["already_applied"] : [],
              error: input.resolution === "not_applied"
                ? control.has_correction && (!control.correction_text?.trim() || !control.correction_strategy)
                  ? "Operator verified that the prior native effect was not applied. The legacy correction payload was not durable and must be reissued."
                  : outcome.original === "cancelled"
                    ? "Operator verified that the prior native effect was not applied; the migration-cancelled legacy turn remains cancelled and was not replayed."
                    : "Operator verified that the prior native effect was not applied; the exact turn was recovered without replaying native Stop."
                : "Operator verified that the prior native effect was applied.",
              updated_at: updatedAt,
            },
          };
        }, (commit) => this.fenceDaemonCommit(commit));
        this.manifestGeneration = checkpoint.generation;
        return checkpoint;
      }));
    } catch (error) {
      // As with native completion, an exact completed readback wins over a
      // post-COMMIT transport/filesystem error.
      const recoveredManifest = await this.store.load().catch(() => null);
      const recoveredEntry = recoveredManifest?.entries.find((candidate) => candidate.id === input.entryId);
      const recoveredControl = recoveredEntry?.turn_control;
      if (!recoveredManifest
        || recoveredEntry?.work_attempt_id !== input.workAttemptId
        || recoveredControl?.action_id !== input.actionId
        || recoveredControl.work_attempt_id !== input.workAttemptId
        || recoveredControl.execution_generation_id !== input.executionGenerationId
        || recoveredControl.status !== "completed"
        || recoveredControl.operator_resolution !== input.resolution) {
        throw error;
      }
      const recoveredInbox = recoveredControl.inbox_item_id
        ? await this.supervisedInbox.get(recoveredControl.inbox_item_id).catch(() => null)
        : null;
      const original = recoveredInbox?.state === "cancelled_by_user"
        ? "cancelled" as const
        : recoveredInbox && ["publishing", "acknowledged", "acknowledged_no_reply"].includes(recoveredInbox.state)
          ? "publication_won" as const
          : input.resolution === "not_applied" && recoveredInbox
            ? "resumed" as const
            : "none" as const;
      this.manifestGeneration = recoveredManifest.generation;
      committed = { generation: recoveredManifest.generation, entry: recoveredEntry, original, correctionInboxItemId: null, providerTurnId: recoveredControl.provider_turn_id ?? null };
    }

    this.supervisedDelivery?.finishActiveDeliveryInterruptByAction(
      input.entryId,
      input.actionId,
      committed.original === "cancelled" ? "cancelled" : "resume",
    );
    try {
      await this.startSupervisedDelivery(input.entryId, "wake");
    } catch {
      this.scheduleRecoveryConvergence(input.entryId, 250);
    }
    // `startSupervisedDelivery` is deliberately a no-op until handle, binding,
    // and memory-only credential authority all exist. Resolution is durable, so
    // ordinary convergence must retry that reconstruction instead of leaving a
    // recovered exact turn pending forever.
    this.requestConvergence(input.entryId);
    return this.entryWithDerivedLiveness(committed.entry);
  }

  private async controlTurnOnce(input: {
    entryId: string;
    daemonGeneration: number;
    roomId: string;
    workAttemptId: string;
    executionGenerationId: string;
    providerContinuationId: string;
    providerTurnId: string;
    inboxItemId: string;
    sourceMessageId: string;
    actionId: string;
    actionSequence: number;
    correction: string | null;
  }): Promise<DaemonTurnControlResult> {
    await this.singleton.assertCurrent();
    if (input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("Turn control belongs to a stale supervisor generation.");
    }
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === input.entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entryId}`);
    const ref = entry.provider_ref;
    if (entry.desired_state !== "running") throw new Error("Turn control requires desired_state=running.");
    if (entry.condition !== "none" || (entry.observed_state !== "working" && entry.observed_state !== "idle")) {
      throw new Error("Turn control requires a healthy working or idle supervised entry.");
    }
    if (!entry.work_attempt_id || entry.work_attempt_id !== input.workAttemptId || ref?.work_attempt_id !== input.workAttemptId) {
      throw new Error("Turn control work attempt is stale or belongs to a different entry.");
    }
    if (!ref || ref.execution_generation_id !== input.executionGenerationId) {
      throw new Error("Turn control execution generation is stale or incomplete.");
    }
    if (entry.room_id !== input.roomId || ref.provider_continuation_id !== input.providerContinuationId) {
      throw new Error("Turn control room or provider continuation is stale.");
    }
    const reconciliation = advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs());
    const capabilities = await this.providerPort?.capabilities(input.workAttemptId, entry.provider);
    const capability = capabilities?.turnControl ?? "unsupported";
    const correction = input.correction?.trim() || null;
    // The daemon-inbox lane must observe every bounded provider turn itself.
    // Even when an adapter supports native correction, interrupt+resume can
    // create a replacement provider turn outside this FIFO's result observer.
    // Therefore every daemon-owned correction is one atomic Stop + durable next
    // row. Legacy/mcp_polling lanes have no daemon pump and retain their native
    // adapter correction path.
    const stopThenResend = Boolean(correction) && (entry.delivery_mode ?? "mcp_polling") === "daemon_inbox";
    let nativeCorrection = stopThenResend ? null : correction;
    let correctionStrategy: "native" | "stop_then_resend" | null = correction
      ? stopThenResend ? "stop_then_resend" : "native"
      : null;
    const existingControl = entry.turn_control;
    const retryingControl = existingControl?.action_id === input.actionId
      && existingControl.status === "retryable";
    if (existingControl?.action_id === input.actionId) {
      if (existingControl.work_attempt_id !== input.workAttemptId
        || existingControl.execution_generation_id !== input.executionGenerationId
        || existingControl.target_room_id !== input.roomId
        || existingControl.target_source_message_id !== input.sourceMessageId
        || existingControl.target_provider_continuation_id !== input.providerContinuationId
        || existingControl.inbox_item_id !== input.inboxItemId
        || existingControl.provider_turn_id !== input.providerTurnId
        || existingControl.action_sequence !== input.actionSequence
        || existingControl.has_correction !== Boolean(correction)
        || (existingControl.correction_text ?? null) !== correction) {
        throw new Error("Turn control action id was reused with different fenced input.");
      }
      if (existingControl.status === "completed") {
        return {
          entryId: input.entryId,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          actionId: input.actionId,
          capability: existingControl.capability,
          interrupted: existingControl.interrupted === true,
          resumed: existingControl.resumed === true,
          state: existingControl.state ?? (entry.observed_state === "working" ? "working" : "idle"),
          duplicate: true,
          // Duplicate acknowledgement must report the durable outcome. In
          // particular, an operator-resolved not-applied action has no applied
          // stage and must never be relabelled as already applied.
          stages: [...existingControl.stages],
        };
      }
      if (!retryingControl) {
        throw new Error("Turn control was durably dispatched but its provider outcome is unresolved; it was not replayed.");
      }
      if (correction && !existingControl.correction_strategy) {
        throw new Error("Turn control retry is missing its durable correction strategy; it was not replayed.");
      }
      // A retry executes the accepted journal semantics, never semantics
      // re-derived from mutable capabilities or a later delivery-mode view.
      correctionStrategy = existingControl.correction_strategy ?? null;
      nativeCorrection = correctionStrategy === "stop_then_resend" ? null : correction;
    }
    if (existingControl
      && existingControl.work_attempt_id === input.workAttemptId
      && existingControl.execution_generation_id === input.executionGenerationId
      && existingControl.status !== "completed"
      && existingControl.status !== "retryable") {
      throw new Error(`Turn control action '${existingControl.action_id}' is unresolved; refusing a second action on the same execution generation.`);
    }
    if (existingControl
      && existingControl.action_id !== input.actionId
      && existingControl.work_attempt_id === input.workAttemptId
      && existingControl.execution_generation_id === input.executionGenerationId
      && existingControl.status === "retryable"
      && existingControl.inbox_item_id) {
      throw new Error(`Turn control action '${existingControl.action_id}' is accepted and retryable; refusing to replace its exact FIFO barrier with another action.`);
    }
    if (!retryingControl) {
      if (entry.observed_state === "idle" && correction === null) {
        throw new Error("There is no active supervised turn to stop.");
      }
      this.admitNewTurnControl(entry.id);
    }
    if (!this.providerPort?.controlTurn || capability === "unsupported") {
      throw new Error(`Provider '${entry.provider}' does not support supervised turn control.`);
    }
    const binding = await this.workerBindings.get(entry.id);
    if (!binding
      || binding.room_id !== entry.room_id
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId) {
      throw new Error("Turn control requires the exact active worker binding for this execution generation.");
    }
    const attempt = await this.durability.getAttempt(input.workAttemptId);
    const execution = attempt.execution_generations.find((candidate) =>
      candidate.execution_generation_id === input.executionGenerationId);
    if (!execution || execution.terminal) throw new Error("Turn control execution generation is no longer live.");
    let handle = this.liveHandles.get(entry.id) ?? null;
    if (!handle) handle = await this.attachLiveProvider(entry);
    if (!handle
      || handle.workAttemptId !== input.workAttemptId
      || handle.providerContinuationId !== ref.provider_continuation_id) {
      throw new Error("Turn control could not resolve the exact live provider continuation.");
    }
    // Capture or reconstruct the exact FIFO owner before provider control. A
    // retryable linked journal is also a durable successor barrier, so recovery
    // may finish A but can never start B before this action completes.
    const deliveryAgent: SupervisedIngressAgent = {
      agentId: entry.id,
      roomId: binding.room_id,
      provider: entry.provider,
      charter: entry.charter,
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: "",
      handle,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: ref.provider_continuation_id ?? null,
      providerConnection: ref.provider_connection ?? null,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.singleton.currentGeneration,
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    const interruptedDelivery: { current: SupervisedDeliveryInterruptReservation | null } = { current: null };
    let foldCompletedRetryWithoutNativeControl = false;
    if (retryingControl && existingControl?.inbox_item_id && (entry.delivery_mode ?? "mcp_polling") === "daemon_inbox") {
      // Recovery may safely finish A, but the durable journal prevents B from
      // being claimed. Give A's exact recovery a bounded chance to materialize
      // an in-memory invocation. If A already reached publication/terminal,
      // fold that race into the journal transaction without calling a provider
      // API that could only target the provider's latest (not exact) turn.
      await this.startSupervisedDelivery(entry.id, "wake");
      for (let observation = 0; observation < 500; observation += 1) {
        const active = this.supervisedDelivery?.activeTurn(deliveryAgent);
        if (active?.inboxItemId === existingControl.inbox_item_id) break;
        const linked = await this.supervisedInbox.get(existingControl.inbox_item_id);
        if (linked && ["publishing", "acknowledged", "acknowledged_no_reply"].includes(linked.state)) {
          foldCompletedRetryWithoutNativeControl = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const recordedAt = new Date().toISOString();
    let prepared: Awaited<ReturnType<ManifestStore["prepareTurnControlState"]>>;
    try {
      prepared = await this.serializeEntryTick(entry.id, () => this.serializeManifestMutation(async () => {
        await this.singleton.assertCurrent();
        const checkpoint = await this.store.prepareTurnControlState(this.manifestGeneration, {
          agentId: entry.id,
          roomId: entry.room_id,
          expectedInboxItemId: input.inboxItemId,
          expectedSourceMessageId: input.sourceMessageId,
          expectedProviderTurnId: input.providerTurnId,
          actionId: input.actionId,
          actionSequence: input.actionSequence,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          providerContinuationId: ref.provider_continuation_id,
          providerConnection: ref.provider_connection,
          deliveryMode: entry.delivery_mode ?? "mcp_polling",
          hasCorrection: Boolean(correction),
          correctionText: correction,
          correctionStrategy,
          capability,
          recordedAt,
        }, (commit) => this.fenceDaemonCommit(commit));
        this.manifestGeneration = checkpoint.generation;
        return checkpoint;
      }));
    } catch (error) {
      // A filesystem/transport edge may report failure after SQLite COMMIT.
      // Exact readback prevents us from either accepting twice or treating the
      // durable admission barrier as absent.
      const recoveredManifest = await this.store.load().catch(() => null);
      const recoveredEntry = recoveredManifest?.entries.find((candidate) => candidate.id === entry.id);
      const recovered = recoveredEntry?.turn_control;
      if (!recoveredManifest
        || recoveredEntry?.room_id !== entry.room_id
        || recoveredEntry.work_attempt_id !== input.workAttemptId
        || recoveredEntry.provider_ref?.execution_generation_id !== input.executionGenerationId
        || recoveredEntry.provider_ref.provider_continuation_id !== ref.provider_continuation_id
        || !sameProviderActionConnectionSnapshot(recoveredEntry.provider_ref.provider_connection, ref.provider_connection)
        || (recoveredEntry.delivery_mode ?? "mcp_polling") !== (entry.delivery_mode ?? "mcp_polling")
        || recovered?.action_id !== input.actionId
        || recovered.target_room_id !== input.roomId
        || recovered.target_source_message_id !== input.sourceMessageId
        || recovered.target_provider_continuation_id !== input.providerContinuationId
        || recovered.inbox_item_id !== input.inboxItemId
        || recovered.provider_turn_id !== input.providerTurnId
        || recovered.action_sequence !== input.actionSequence
        || recovered.work_attempt_id !== input.workAttemptId
        || recovered.execution_generation_id !== input.executionGenerationId
        || recovered.status !== "prepared"
        || recovered.has_correction !== Boolean(correction)
        || (recovered.correction_text ?? null) !== correction
        || (recovered.correction_strategy ?? null) !== correctionStrategy) {
        throw error;
      }
      const linked = recovered.inbox_item_id
        ? await this.supervisedInbox.get(recovered.inbox_item_id).catch(() => null)
        : null;
      this.manifestGeneration = recoveredManifest.generation;
      prepared = {
        generation: recoveredManifest.generation,
        entry: recoveredEntry,
        linkedInboxItemId: recovered.inbox_item_id ?? null,
        providerTurnId: recovered.provider_turn_id ?? null,
        linkedState: linked?.state ?? null,
      };
    }
    if ((entry.delivery_mode ?? "mcp_polling") === "daemon_inbox") {
      if (prepared.linkedInboxItemId) {
        interruptedDelivery.current = this.supervisedDelivery?.captureActiveDeliveryInterrupt(deliveryAgent, input.actionId) ?? null;
        if (interruptedDelivery.current?.inboxItemId !== prepared.linkedInboxItemId) {
          this.supervisedDelivery?.finishActiveDeliveryInterrupt(interruptedDelivery.current, "resume");
          interruptedDelivery.current = null;
        }
        if (!interruptedDelivery.current) {
          const linked = await this.supervisedInbox.get(prepared.linkedInboxItemId);
          if (linked && ["publishing", "acknowledged", "acknowledged_no_reply", "cancelled_by_user"].includes(linked.state)) {
            foldCompletedRetryWithoutNativeControl = true;
          } else {
            const message = "Turn control is waiting for its exact admitted FIFO invocation; no native latest-turn control was dispatched.";
            await this.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
              && current.turn_control.status === "prepared"
              ? { ...current, turn_control: { ...current.turn_control, status: "retryable", error: message, updated_at: new Date().toISOString() } }
              : current);
            try { await this.startSupervisedDelivery(entry.id, "wake"); } catch { this.scheduleRecoveryConvergence(entry.id, 250); }
            this.requestConvergence(entry.id);
            throw new Error(message);
          }
        }
      } else {
        // The atomic preparation transaction won before any pending head could
        // be admitted. A plain Stop is therefore an honest no-op; a correction
        // is inserted at the frozen head without touching provider latest-turn
        // state.
        foldCompletedRetryWithoutNativeControl = true;
      }
    }
    let providerResult: ProviderTurnControlResult;
    let dispatchMarked = false;
    try {
      providerResult = foldCompletedRetryWithoutNativeControl
        ? { capability, interrupted: false, resumed: false, state: entry.observed_state === "working" ? "working" : "idle" }
        : await this.providerPort.controlTurn(handle, nativeCorrection, {
        actionId: input.actionId,
        targetTurnId: prepared.providerTurnId,
        checkpointTurnStarted: async (turnId) => {
          if (!turnId.trim() || this.liveHandles.get(entry.id) !== handle) {
            throw new Error("Turn control lost its exact live provider before target checkpoint.");
          }
          const checkpointedAt = new Date().toISOString();
          const checkpoint = await this.serializeManifestMutation(async () => {
            await this.singleton.assertCurrent();
            const result = await this.store.checkpointTurnControlTarget(this.manifestGeneration, {
              agentId: entry.id,
              roomId: entry.room_id,
              actionId: input.actionId,
              workAttemptId: input.workAttemptId,
              executionGenerationId: input.executionGenerationId,
              providerContinuationId: ref.provider_continuation_id,
              providerConnection: ref.provider_connection,
              deliveryMode: entry.delivery_mode ?? "mcp_polling",
              providerTurnId: turnId,
              observedAt: checkpointedAt,
            }, (commit) => this.fenceDaemonCommit(commit));
            this.manifestGeneration = result.generation;
            return result;
          });
          if (this.liveHandles.get(entry.id) !== handle) {
            throw new Error("Turn control provider changed after exact target checkpoint.");
          }
          prepared = { ...prepared, generation: checkpoint.generation, entry: checkpoint.entry, providerTurnId: turnId };
        },
        markDispatched: async () => {
          if (dispatchMarked) return;
          if ((entry.delivery_mode ?? "mcp_polling") === "daemon_inbox" && !interruptedDelivery.current) {
            throw new Error("Turn control cannot dispatch without reserving the exact active daemon-inbox invocation.");
          }
          await this.updateManifestEntry(entry.id, (current) => {
            if (current.turn_control?.action_id !== input.actionId
              || current.desired_state !== "running"
              || current.condition !== "none"
              || current.work_attempt_id !== input.workAttemptId
              || current.provider_ref?.execution_generation_id !== input.executionGenerationId
              || current.provider_ref.provider_continuation_id !== ref.provider_continuation_id
              || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, ref.provider_connection)
              || (current.delivery_mode ?? "mcp_polling") !== (entry.delivery_mode ?? "mcp_polling")
              || this.liveHandles.get(entry.id) !== handle) {
              throw new Error("Turn control lost its durable prepared journal before native dispatch.");
            }
            const durableInboxItemId = current.turn_control.inbox_item_id ?? null;
            const capturedInboxItemId = interruptedDelivery.current?.inboxItemId ?? null;
            if (durableInboxItemId !== null && durableInboxItemId !== capturedInboxItemId) {
              throw new Error("Turn control retry no longer owns its exact durable FIFO invocation.");
            }
            return {
              ...current,
              turn_control: {
                ...current.turn_control,
                inbox_item_id: interruptedDelivery.current?.inboxItemId ?? current.turn_control.inbox_item_id ?? null,
                provider_turn_id: interruptedDelivery.current?.providerTurnId ?? current.turn_control.provider_turn_id ?? null,
                status: "dispatching",
                updated_at: new Date().toISOString(),
              },
            };
          });
          dispatchMarked = true;
        },
        });
      if ((providerResult.interrupted || providerResult.resumed) && !dispatchMarked) {
        throw Object.assign(
          new Error("Provider reported a turn-control effect without marking native dispatch."),
          { turnControlOutcome: "uncertain" as const },
        );
      }
    } catch (error) {
      const message = redactCredentialText(error instanceof Error ? error.message : String(error)).value;
      const outcome = error && typeof error === "object" && "turnControlOutcome" in error
        ? (error as { turnControlOutcome?: unknown }).turnControlOutcome
        : null;
      const mayResumeDelivery = outcome === "not_applied" || (!dispatchMarked && outcome !== "uncertain");
      if (!mayResumeDelivery) {
        this.supervisedDelivery?.resolveActiveDeliveryInterrupt(interruptedDelivery.current, "freeze");
      }
      try {
        await this.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
          ? {
            ...current,
            turn_control: {
              ...current.turn_control,
              inbox_item_id: interruptedDelivery.current?.inboxItemId ?? current.turn_control.inbox_item_id ?? null,
              provider_turn_id: interruptedDelivery.current?.providerTurnId ?? current.turn_control.provider_turn_id ?? null,
              // An adapter that explicitly reports "uncertain" (e.g. an abort was
              // accepted but its turn boundary could not be verified) must be
              // honored as uncertain even if native dispatch was never marked —
              // never silently downgraded to a replayable "retryable".
              status: outcome === "not_applied" ? "retryable" : outcome === "uncertain" ? "uncertain" : dispatchMarked ? "uncertain" : "retryable",
              error: message,
              updated_at: new Date().toISOString(),
            },
          }
          : current);
      } catch (journalError) {
        // Never let the FIFO advance unless the provider-control journal first
        // proves this Stop is safe to replay. Otherwise recovery could re-drive
        // the old action against the row's successor invocation.
        this.supervisedDelivery?.resolveActiveDeliveryInterrupt(interruptedDelivery.current, "freeze");
        throw journalError;
      }
      if (mayResumeDelivery) {
        this.supervisedDelivery?.resolveActiveDeliveryInterrupt(interruptedDelivery.current, "resume");
      }
      throw error;
    }
    const reservation = interruptedDelivery.current;
    if (nativeCorrection === null && providerResult.interrupted && reservation && this.supervisedDelivery) {
      try {
        await this.supervisedDelivery.prepareActiveDeliveryInterrupt(reservation);
      } catch (error) {
        this.supervisedDelivery.finishActiveDeliveryInterrupt(reservation, "freeze");
        const message = redactCredentialText(error instanceof Error ? error.message : String(error)).value;
        await this.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
          ? { ...current, turn_control: {
            ...current.turn_control,
            inbox_item_id: reservation.inboxItemId,
            provider_turn_id: reservation.providerTurnId ?? current.turn_control.provider_turn_id ?? null,
            status: "uncertain" as const,
            error: message,
            updated_at: new Date().toISOString(),
          } }
          : current);
        throw error;
      }
    }

    const observedAt = new Date().toISOString();
    let committed: Awaited<ReturnType<ManifestStore["commitTurnControlState"]>>;
    try {
      committed = await this.serializeEntryTick(entry.id, () => this.serializeManifestMutation(async () => {
        await this.singleton.assertCurrent();
        const checkpoint = await this.store.commitTurnControlState(this.manifestGeneration, {
          agentId: entry.id,
          roomId: entry.room_id,
          actionId: input.actionId,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          mode: "native_applied",
          settleOriginal: nativeCorrection === null && providerResult.interrupted && Boolean(reservation),
          activateCorrection: correctionStrategy === "stop_then_resend",
          observedAt,
        }, (current, outcome) => {
          const interrupted = outcome.original === "publication_won" ? false : providerResult.interrupted;
          const resumed = correctionStrategy === "stop_then_resend" ? true : providerResult.resumed;
          const stages: DaemonTurnControlResult["stages"] = ["delivered"];
          if (interrupted) stages.push("interrupting");
          stages.push("applied");
          if (resumed) stages.push("resumed");
          const nextReconciliation = rememberCompletedControlAction(
            advanceReconciliationState(current.reconciliation, providerResult.state, this.nowMs()),
            input.actionId,
          );
          const activity = [...(current.activity ?? []), sanitizeDaemonActivityEvent({
            observed_at: observedAt,
            sequence: ((current.activity ?? []).at(-1)?.sequence ?? 0) + 1,
            provider: current.provider,
            kind: "turn_lifecycle",
            method: correction ? "supervisor/steer" : "supervisor/stop-turn",
            summary: correctionStrategy === "stop_then_resend"
              ? "Active turn stopped; human correction queued as the next bounded turn"
              : correction
                ? "Human correction applied; same continuation resumed"
                : interrupted
                  ? "Active turn interrupted; worker remains available"
                  : "Turn already finished before the stop; its reply stands",
            status: providerResult.state === "working" ? "working" : "idle",
            payload: { action_id: input.actionId, capability, stages },
            payload_truncated: false,
            payload_redacted: false,
            durable_payload_ref: null,
          })].slice(-200);
          return {
            ...current,
            observed_state: providerResult.state,
            native_liveness: {
              state: providerResult.state === "working" ? "active" : "idle",
              observed_at: observedAt,
              detail: correctionStrategy === "stop_then_resend"
                ? "turn interrupted; correction queued on the same supervised lane"
                : correction
                  ? "human correction resumed on the same continuation"
                  : interrupted
                    ? "turn interrupted; worker available"
                    : "turn already finished; its reply stands",
            },
            activity,
            reconciliation: nextReconciliation,
            turn_control: {
              ...current.turn_control!,
              inbox_item_id: outcome.inboxItemId,
              provider_turn_id: outcome.providerTurnId,
              status: "completed",
              capability,
              interrupted,
              resumed,
              state: providerResult.state,
              stages,
              error: null,
              updated_at: observedAt,
            },
          };
        }, (commit) => this.fenceDaemonCommit(commit));
        this.manifestGeneration = checkpoint.generation;
        return checkpoint;
      }));
    } catch (error) {
      // COMMIT can become durable before the SQLite/filesystem boundary reports
      // failure. Read back the exact action before freezing it: a completed
      // journal plus its linked FIFO outcome is authoritative, and post-commit
      // abort/wake still has to run.
      const recoveredManifest = await this.store.load().catch(() => null);
      const recoveredEntry = recoveredManifest?.entries.find((candidate) => candidate.id === entry.id);
      const recoveredControl = recoveredEntry?.turn_control;
      const expectedInboxItemId = reservation?.inboxItemId
        ?? prepared.linkedInboxItemId
        ?? existingControl?.inbox_item_id
        ?? null;
      if (recoveredManifest
        && recoveredEntry?.room_id === entry.room_id
        && recoveredEntry.work_attempt_id === input.workAttemptId
        && recoveredEntry.provider_ref?.execution_generation_id === input.executionGenerationId
        && recoveredControl?.action_id === input.actionId
        && recoveredControl.work_attempt_id === input.workAttemptId
        && recoveredControl.execution_generation_id === input.executionGenerationId
        && recoveredControl.status === "completed"
        && (recoveredControl.inbox_item_id ?? null) === expectedInboxItemId
        && (recoveredControl.provider_turn_id ?? null) === (reservation?.providerTurnId ?? prepared.providerTurnId ?? null)
        && recoveredControl.has_correction === Boolean(correction)
        && (recoveredControl.correction_text ?? null) === correction
        && (recoveredControl.correction_strategy ?? null) === correctionStrategy) {
        const recoveredInbox = expectedInboxItemId
          ? await this.supervisedInbox.get(expectedInboxItemId).catch(() => null)
          : null;
        const original = recoveredInbox?.state === "cancelled_by_user"
          ? "cancelled" as const
          : recoveredInbox && ["publishing", "acknowledged", "acknowledged_no_reply"].includes(recoveredInbox.state)
            ? "publication_won" as const
            : "none" as const;
        this.manifestGeneration = recoveredManifest.generation;
        committed = { generation: recoveredManifest.generation, entry: recoveredEntry, original, correctionInboxItemId: null, providerTurnId: recoveredControl.provider_turn_id ?? null };
      } else {
        const nativeOutcomeMayExist = dispatchMarked && !foldCompletedRetryWithoutNativeControl;
        this.supervisedDelivery?.finishActiveDeliveryInterrupt(
          reservation,
          nativeOutcomeMayExist ? "freeze" : "resume",
        );
        const message = redactCredentialText(error instanceof Error ? error.message : String(error)).value;
        try {
          await this.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
            && current.turn_control.status !== "completed"
            ? { ...current, turn_control: {
              ...current.turn_control,
              inbox_item_id: reservation?.inboxItemId ?? current.turn_control.inbox_item_id ?? null,
              provider_turn_id: reservation?.providerTurnId ?? current.turn_control.provider_turn_id ?? null,
              status: nativeOutcomeMayExist ? "uncertain" as const : "retryable" as const,
              error: message,
              updated_at: new Date().toISOString(),
            } }
            : current);
        } catch { /* The durable dispatching journal still fails closed on restart. */ }
        if (!nativeOutcomeMayExist) {
          try { await this.startSupervisedDelivery(entry.id, "wake"); } catch { this.scheduleRecoveryConvergence(entry.id, 250); }
          this.requestConvergence(entry.id);
        }
        throw error;
      }
    }

    const interrupted = committed.entry.turn_control?.interrupted === true;
    const resumed = committed.entry.turn_control?.resumed === true;
    const stages = committed.entry.turn_control?.stages ?? ["applied"];
    this.supervisedDelivery?.finishActiveDeliveryInterrupt(
      reservation,
      committed.original === "cancelled" ? "cancelled" : "resume",
    );
    if (committed.correctionInboxItemId
      || (correctionStrategy === "stop_then_resend" && committed.entry.turn_control?.status === "completed")) {
      try {
        await this.startSupervisedDelivery(entry.id, "wake");
      } catch {
        this.scheduleRecoveryConvergence(entry.id, 250);
      }
      this.requestConvergence(entry.id);
    }
    return {
      entryId: input.entryId,
      workAttemptId: input.workAttemptId,
      executionGenerationId: input.executionGenerationId,
      actionId: input.actionId,
      duplicate: false,
      stages,
      ...providerResult,
      interrupted,
      resumed,
    };
  }

  /** Bound renderer-originated durable control creation without rate-limiting exact recovery retries. */
  private admitNewTurnControl(entryId: string): void {
    const now = this.nowMs();
    const cutoff = now - TURN_CONTROL_ADMISSION_WINDOW_MS;
    const recent = (this.turnControlAdmissions.get(entryId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= MAX_NEW_TURN_CONTROLS_PER_WINDOW) {
      this.turnControlAdmissions.set(entryId, recent);
      throw new Error("Turn control is temporarily rate limited for this supervised agent.");
    }
    recent.push(now);
    this.turnControlAdmissions.set(entryId, recent);
  }

  private async reserveLegacyLane(input: { reservation_id: string; room_id: string; provider: string; owner_pid: number; owner_process_identity: string }): Promise<LegacyLaneOwner> {
    for (const [field, value] of Object.entries({ reservation_id: input.reservation_id, room_id: input.room_id, provider: input.provider })) {
      if (!value.trim()) throw new Error(`Legacy lane ${field} is required.`);
    }
    if (!Number.isSafeInteger(input.owner_pid) || input.owner_pid < 1) throw new Error("Legacy lane owner_pid is required.");
    if (!input.owner_process_identity.trim()) throw new Error("Legacy lane owner_process_identity is required.");
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const duplicate = legacyOwners.find((candidate) => candidate.reservation_id === input.reservation_id);
      if (duplicate) {
        if (duplicate.room_id !== input.room_id || duplicate.provider !== input.provider) {
          throw new Error(`Legacy reservation '${input.reservation_id}' is already bound to another lane.`);
        }
        if (duplicate.owner_pid !== input.owner_pid || duplicate.owner_process_identity !== input.owner_process_identity) {
          throw new Error(`Legacy reservation '${input.reservation_id}' belongs to another Electron process.`);
        }
        return duplicate;
      }
      const supervisedOwner = manifest.entries.find((candidate) =>
        candidate.room_id === input.room_id && candidate.provider === input.provider && this.isSupervisedLaneOwner(candidate));
      if (supervisedOwner) {
        throw new Error(`Provider lane '${input.room_id}/${input.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
      }
      const legacyOwner = legacyOwners.find((candidate) =>
        candidate.room_id === input.room_id && candidate.provider === input.provider);
      if (legacyOwner) {
        throw new Error(`Provider lane '${input.room_id}/${input.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
      }
      const now = new Date().toISOString();
      const owner: LegacyLaneOwner = {
        ...input,
        state: "reserved",
        session_id: null,
        created_at: now,
        updated_at: now,
      };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, [...legacyOwners, owner]);
      this.manifestGeneration = next.generation;
      return owner;
    });
  }

  private liveLegacyLaneOwners(owners: readonly LegacyLaneOwner[]): LegacyLaneOwner[] {
    return owners.filter((owner) => owner.state === "active" || this.isProcessOwnerLive(owner.owner_pid, owner.owner_process_identity));
  }

  private isProcessOwnerLive(pid: number, expectedIdentity: string): boolean {
    try {
      // Read the start-time-only identity to match how Electron records the owner
      // (defaultGetProcessIdentity). Compare the stable birth prefix, not the whole
      // string — a live owner whose recorded identity omits the mutable command must
      // still read live, or its reservation is wrongly pruned before activate.
      const identity = execFileSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return Boolean(identity) && sameProcessBirthIdentity(identity, expectedIdentity);
    } catch (error) {
      try {
        process.kill(pid, 0);
        // Unknown evidence fails closed: retain the fence until a later
        // reconciliation can prove absence or birth-identity mismatch.
        return true;
      } catch (killError) {
        return (killError as NodeJS.ErrnoException).code === "EPERM";
      }
    }
  }

  private async recoverOrphanedLegacyReservations(): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const owners = manifest.legacy_lane_owners ?? [];
      const live = this.liveLegacyLaneOwners(owners);
      if (live.length === owners.length) return;
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, live);
      this.manifestGeneration = next.generation;
    });
  }

  private async activateLegacyLane(reservationId: string, sessionId: string): Promise<LegacyLaneOwner> {
    if (!reservationId.trim() || !sessionId.trim()) throw new Error("Legacy reservation and session ids are required.");
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const owner = legacyOwners.find((candidate) => candidate.reservation_id === reservationId);
      if (!owner) throw new Error(`Unknown legacy lane reservation: ${reservationId}`);
      if (owner.state === "active" && owner.session_id !== sessionId) {
        throw new Error(`Legacy reservation '${reservationId}' is already active for another session.`);
      }
      const updated: LegacyLaneOwner = { ...owner, state: "active", session_id: sessionId, updated_at: new Date().toISOString() };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, legacyOwners
        .map((candidate) => candidate.reservation_id === reservationId ? updated : candidate));
      this.manifestGeneration = next.generation;
      return updated;
    });
  }

  private async releaseLegacyLane(input: { reservation_id: string | null; session_id: string | null; room_id: string | null; provider: string | null }): Promise<{ released: boolean }> {
    const reservationId = input.reservation_id?.trim() || null;
    const sessionId = input.session_id?.trim() || null;
    const roomId = input.room_id?.trim() || null;
    const provider = input.provider?.trim() || null;
    if (!reservationId && !sessionId && !(roomId && provider)) {
      throw new Error("Legacy reservation_id, session_id, or complete room/provider lane is required.");
    }
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const owners = manifest.legacy_lane_owners ?? [];
      const retained = owners.filter((candidate) => !(
        (reservationId && candidate.reservation_id === reservationId)
        || (sessionId && candidate.session_id === sessionId)
        || (roomId && provider && candidate.room_id === roomId && candidate.provider === provider)
      ));
      if (retained.length === owners.length) return { released: false };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, retained);
      this.manifestGeneration = next.generation;
      return { released: true };
    });
  }

  private async appendActivity(id: string, event: DaemonActivityEvent): Promise<DaemonManifestEntry> {
    if (!event || typeof event !== "object" || !event.observed_at) throw new Error("A bounded activity event is required.");
    const sanitizedEvent = sanitizeDaemonActivityEvent(event);
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const entry = await this.store.getEntry(id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const lastSequence = entry.activity?.at(-1)?.sequence ?? -1;
      if (sanitizedEvent.sequence <= lastSequence) throw new Error(`Native activity sequence ${sanitizedEvent.sequence} is not newer than ${lastSequence}.`);
      const updated: DaemonManifestEntry = {
        ...entry,
        observed_state: sanitizedEvent.status === "working" || sanitizedEvent.status === "reviewing" ? "working" : sanitizedEvent.status === "blocked" ? entry.observed_state : "idle",
        native_liveness: { state: sanitizedEvent.status === "idle" ? "idle" : "active", observed_at: sanitizedEvent.observed_at, detail: sanitizedEvent.summary },
        activity: [...(entry.activity ?? []), sanitizedEvent].slice(-200),
      };
      const next = await this.store.appendActivity(
        this.manifestGeneration,
        id,
        sanitizedEvent,
        updated.observed_state,
        updated.native_liveness!,
        200,
        (commit) => this.fenceDaemonCommit(commit),
      );
      this.manifestGeneration = next.generation;
      return next.entry;
    });
  }

  private async updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null, observedAt: string): Promise<DaemonManifestEntry> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["reachable", "stale", "unknown"].includes(state)) throw new Error("Invalid workplace liveness state.");
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const entry = await this.store.getEntry(id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const updated: DaemonManifestEntry = { ...entry, workplace_liveness: { state, observed_at: observedAt, detail } };
      const next = await this.store.updateWorkplaceLiveness(
        this.manifestGeneration,
        id,
        updated.workplace_liveness!,
        (commit) => this.fenceDaemonCommit(commit),
      );
      this.manifestGeneration = next.generation;
      return next.entry;
    });
  }

  private async entriesWithDerivedLiveness(entries: DaemonManifestEntry[]): Promise<DaemonManifestEntryView[]> {
    const bindings = new Map((await this.workerBindings.list()).map((binding) => [binding.entry_id, binding]));
    return Promise.all(entries.map((entry) => this.entryWithDerivedLiveness(entry, bindings.get(entry.id) ?? null)));
  }

  private notifyStateChanged(): void {
    this.stateSequence += 1;
    for (const resolve of this.stateWaiters) resolve();
    this.stateWaiters.clear();
  }

  private notifyAgentStreamWaiters(entryId: string): void {
    const waiters = this.agentStreamWaiters.get(entryId);
    if (!waiters) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  /** Append one redacted event to an agent's ephemeral live feed and wake watchers. */
  private pushAgentStreamEvent(entryId: string, event: DaemonActivityEvent): void {
    const buffer = this.agentStreams.get(entryId) ?? {
      sequence: 0,
      generation: 1,
      generationStartSequence: 1,
      events: [],
      ended: false,
    };
    if (buffer.ended) return;
    buffer.sequence += 1;
    buffer.events.push({
      sequence: buffer.sequence,
      observed_at: event.observed_at,
      kind: event.kind,
      method: event.method,
      summary: event.summary || null,
      payload: event.payload,
    });
    if (buffer.events.length > AGENT_STREAM_BUFFER_LIMIT) {
      buffer.events.splice(0, buffer.events.length - AGENT_STREAM_BUFFER_LIMIT);
    }
    this.agentStreams.set(entryId, buffer);
    this.notifyAgentStreamWaiters(entryId);
  }

  /** Start one bounded display generation without replaying an older turn. */
  private resetAgentStream(entryId: string): void {
    const buffer = this.agentStreams.get(entryId) ?? {
      sequence: 0,
      generation: 0,
      generationStartSequence: 1,
      events: [],
      ended: false,
    };
    buffer.generation += 1;
    buffer.generationStartSequence = buffer.sequence + 1;
    buffer.events = [];
    buffer.ended = false;
    this.agentStreams.set(entryId, buffer);
    this.notifyAgentStreamWaiters(entryId);
  }

  /** Mark an agent's live feed closed (provider handle torn down) and wake watchers. */
  private endAgentStream(entryId: string): void {
    const buffer = this.agentStreams.get(entryId);
    if (!buffer || buffer.ended) return;
    buffer.ended = true;
    this.notifyAgentStreamWaiters(entryId);
  }

  private async watchAgentStream(input: {
    entryId: string;
    afterSequence: number;
    waitMs: number;
  }): Promise<{ sequence: number; stream_generation: number; dropped_events: number; events: DaemonAgentStreamEvent[]; ended: boolean }> {
    const waitMs = Number.isFinite(input.waitMs)
      ? Math.max(0, Math.min(30_000, Math.floor(input.waitMs)))
      : 25_000;
    const snapshot = (): { sequence: number; stream_generation: number; dropped_events: number; events: DaemonAgentStreamEvent[]; ended: boolean } => {
      const buffer = this.agentStreams.get(input.entryId);
      if (!buffer) return { sequence: input.afterSequence, stream_generation: 0, dropped_events: 0, events: [], ended: false };
      const effectiveAfter = Math.max(input.afterSequence, buffer.generationStartSequence - 1);
      const events = buffer.events
        .filter((event) => event.sequence > effectiveAfter)
        .slice(0, AGENT_STREAM_MAX_BATCH);
      // Advance the cursor only to the last event actually delivered. Returning
      // the producer's newest sequence would strand every event past the batch
      // cap: the client resumes from this cursor and would filter them all out.
      const sequence = events.length > 0 ? events[events.length - 1]!.sequence : Math.max(input.afterSequence, buffer.generationStartSequence - 1);
      const oldestRetained = buffer.events[0]?.sequence ?? buffer.sequence + 1;
      const droppedEvents = Math.max(0, oldestRetained - effectiveAfter - 1);
      // `ended` belongs to the generation high-water mark, not merely to the
      // producer state. A capped batch must keep the viewer draining until it
      // has received every retained event from the ended generation.
      const ended = buffer.ended && sequence >= buffer.sequence;
      return { sequence, stream_generation: buffer.generation, dropped_events: droppedEvents, events, ended };
    };
    let current = snapshot();
    if (!this.handoffScheduled && current.events.length === 0 && !current.ended && waitMs > 0) {
      // There is only one focused inspector consumer. A replacement watch must
      // release an older long poll for the same entry instead of leaving it
      // resident until its timeout after rapid close/reopen cycles.
      this.notifyAgentStreamWaiters(input.entryId);
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.agentStreamWaiters.get(input.entryId)?.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        const waiters = this.agentStreamWaiters.get(input.entryId) ?? new Set<() => void>();
        waiters.add(finish);
        this.agentStreamWaiters.set(input.entryId, waiters);
      });
      current = snapshot();
    }
    return current;
  }

  private async watchState(input: {
    afterDaemonGeneration: number;
    afterSequence: number;
    waitMs: number;
  }): Promise<{
    daemon_generation: number;
    sequence: number;
    entries: DaemonManifestEntryView[];
  }> {
    const generation = this.singleton.currentGeneration;
    const waitMs = Number.isFinite(input.waitMs)
      ? Math.max(0, Math.min(30_000, Math.floor(input.waitMs)))
      : 25_000;
    if (
      !this.handoffScheduled
      && input.afterDaemonGeneration === generation
      && input.afterSequence >= this.stateSequence
      && waitMs > 0
    ) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.stateWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        this.stateWaiters.add(finish);
      });
    }
    await this.singleton.assertCurrent();
    return {
      daemon_generation: this.singleton.currentGeneration,
      sequence: this.stateSequence,
      entries: await this.entriesWithDerivedLiveness((await this.store.load()).entries),
    };
  }

  private async entryWithDerivedLiveness(
    entry: DaemonManifestEntry,
    projectedBinding?: WorkerSessionBinding | null,
  ): Promise<DaemonManifestEntryView> {
    const now = this.nowMs();
    const derive = <T extends string>(
      axis: { state: T; observed_at: string | null; detail: string | null } | undefined,
      staleStates: string[],
      staleAfterMs: number,
    ) => {
      if (!axis?.observed_at || !staleStates.includes(axis.state)) return axis;
      const observed = Date.parse(axis.observed_at);
      return Number.isFinite(observed) && now - observed > staleAfterMs
        ? { ...axis, state: "stale" }
        : axis;
    };
    const binding = projectedBinding === undefined ? await this.workerBindings.get(entry.id) : projectedBinding;
    const bindingMatchesCurrentGeneration = Boolean(
      binding &&
      entry.desired_state === "running" &&
      ["starting", "working", "idle", "recovering"].includes(entry.observed_state) &&
      binding.room_id === entry.room_id &&
      binding.work_attempt_id === entry.work_attempt_id &&
      binding.execution_generation_id === entry.provider_ref?.execution_generation_id,
    );
    // The binding store is advanced by accepted, exact wait publications. It
    // is the live workplace clock; the manifest timestamp only records the
    // original bind and deliberately is not rewritten for every long poll.
    const workplaceLiveness = bindingMatchesCurrentGeneration && binding
      ? {
          state: "reachable" as const,
          observed_at: binding.updated_at,
          detail: entry.workplace_liveness?.detail ?? "supervised worker session bound",
        }
      : entry.workplace_liveness;
    const receipts = await this.supervisedInbox.receipts(entry.id);
    const credential = bindingMatchesCurrentGeneration && binding
      ? await this.workerBindings.credentialFor(binding)
      : null;
    const continuationRepair = await this.supervisedInbox.latestContinuationRepair(entry.id);
    const activeContinuationRepair = continuationRepair && !["committed", "failed"].includes(continuationRepair.phase)
      ? continuationRepair
      : null;
    const deliveryReceipts = projectDeliveryReceipts(receipts, activeContinuationRepair?.inbox_item_id ?? null);
    const nonfinal = receipts.filter((receipt) => !["acknowledged", "acknowledged_no_reply", "cancelled_by_room_move", "cancelled_by_user"].includes(receipt.state));
    const head = nonfinal[0] ?? null;
    const blocked = receipts.find((receipt) => receipt.receipt_state === "blocked") ?? null;
    const hasCurrentBinding = Boolean(bindingMatchesCurrentGeneration && binding);
    const waitingForDesktopGrant = this.requiresHostGrant(entry) && !this.currentHostGrant(entry);
    const cutoverNeedsAttention = entry.provider === "codex"
      && (entry.delivery_mode ?? "mcp_polling") === "mcp_polling"
      && entry.delivery_cutover?.phase === "uncertain";
    const inbox = cutoverNeedsAttention
      ? {
          state: "blocked" as const,
          pending_count: nonfinal.length,
          blocked_by_message_id: null,
          detail: `Daemon inbox cutover needs attention; legacy polling remains fenced. ${entry.delivery_cutover?.error ?? "Exact turn state is uncertain."}`,
        }
      : activeContinuationRepair
      ? {
          state: "restoring_conversation" as const,
          pending_count: nonfinal.length,
          blocked_by_message_id: blocked?.source_message_id ?? null,
          detail: "Restoring the blocked message before any model turn starts.",
        }
      : !hasCurrentBinding || !credential
      ? { state: "waiting_for_desktop_credentials" as const, pending_count: nonfinal.length, blocked_by_message_id: blocked?.source_message_id ?? null, detail: waitingForDesktopGrant || hasCurrentBinding ? "Waiting for desktop credential handoff." : "A current worker binding is required before delivery can start." }
      : blocked
        ? { state: "blocked" as const, pending_count: nonfinal.length, blocked_by_message_id: blocked.source_message_id, detail: blocked.last_error ?? "An earlier delivery needs attention." }
        : nonfinal.length
          ? { state: "queued" as const, pending_count: nonfinal.length, blocked_by_message_id: null, detail: "Room delivery is queued." }
          : { state: "empty" as const, pending_count: 0, blocked_by_message_id: null, detail: null };
    const liveHandle = this.liveHandles.get(entry.id);
    const hasLiveDeliveryOwner = Boolean(
      hasCurrentBinding && credential && liveHandle
      && liveHandle.workAttemptId === entry.work_attempt_id
      && liveHandle.providerContinuationId === entry.provider_ref?.provider_continuation_id
      && entry.provider_ref?.execution_generation_id === binding?.execution_generation_id,
    );
    const connection = hasLiveDeliveryOwner
      ? { state: "connected" as const, observed_at: binding!.updated_at, detail: "Live provider and exact worker binding are available." }
      : entry.desired_state === "running"
        && ["starting", "recovering"].includes(entry.observed_state)
        && (Boolean(liveHandle) || entry.condition === "none")
        ? { state: "reconnecting" as const, observed_at: entry.workplace_liveness?.observed_at ?? null, detail: waitingForDesktopGrant ? "Waiting for desktop credential handoff." : "Restoring the provider and exact worker binding." }
        : { state: "disconnected" as const, observed_at: entry.native_liveness?.observed_at ?? null, detail: liveHandle ? "The current worker binding or credential is unavailable." : "No live provider handle." };
    const persistedIngress = await this.supervisedInbox.ingressHealth(entry.id);
    const ingressMatches = Boolean(persistedIngress
      && persistedIngress.room_id === entry.room_id
      && persistedIngress.execution_generation_id === entry.provider_ref?.execution_generation_id);
    const hasLiveIngressOwner = Boolean(hasCurrentBinding && credential && ingressMatches);
    const ingress = hasLiveIngressOwner
      ? { state: persistedIngress!.state, observed_at: persistedIngress!.state === "stopped" ? null : binding!.updated_at, detail: persistedIngress!.detail }
      : {
          state: "stopped" as const,
          observed_at: entry.native_liveness?.observed_at ?? null,
          detail: hasCurrentBinding && credential ? "The room observation loop has not started." : "Room observation is stopped because its exact binding or credential is unavailable.",
        };
    const activeTurn = hasLiveDeliveryOwner && binding && credential && liveHandle
      ? this.supervisedDelivery?.activeTurn({
          agentId: entry.id, roomId: binding.room_id, provider: entry.provider, apiUrl: binding.api_url,
          agentSessionId: binding.agent_session_id, bearer: credential, handle: liveHandle,
          workAttemptId: binding.work_attempt_id,
          providerContinuationId: liveHandle.providerContinuationId,
          providerConnection: entry.provider_ref?.provider_connection ?? null,
          executionGenerationId: binding.execution_generation_id, daemonGeneration: this.singleton.currentGeneration,
          deliveryMode: entry.delivery_mode ?? "mcp_polling",
        }) ?? null
      : null;
    const projectedTurn = activeContinuationRepair
      ? {
          state: "idle" as const,
          inbox_item_id: head?.inbox_item_id ?? null,
          source_message_id: head?.source_message_id ?? null,
          provider_turn_id: null,
          detail: "Conversation restoration is happening before any model turn starts.",
        }
      : projectDeliveryTurn(head, activeTurn);
    const turn = cutoverNeedsAttention
      ? {
          state: "failed" as const,
          inbox_item_id: null,
          source_message_id: null,
          provider_turn_id: entry.delivery_cutover?.provider_turn_id ?? null,
          detail: entry.delivery_cutover?.error ?? "Legacy polling turn cutover is uncertain; daemon ingress is fenced.",
        }
      : projectedTurn;
    return {
      ...entry,
      workplace_liveness: derive(
        workplaceLiveness,
        ["reachable"],
        workplaceLivenessStaleAfterMs(),
      ) as DaemonManifestEntry["workplace_liveness"],
      native_liveness: derive(
        entry.native_liveness,
        ["active", "idle"],
        NATIVE_LIVENESS_STALE_AFTER_MS,
      ) as DaemonManifestEntry["native_liveness"],
      worker_binding: bindingMatchesCurrentGeneration && binding ? {
        agent_session_id: binding.agent_session_id,
        work_attempt_id: binding.work_attempt_id,
        execution_generation_id: binding.execution_generation_id,
        updated_at: binding.updated_at,
      } : null,
      room_agent_state: {
        connection,
        ingress,
        inbox,
        turn,
        task: { state: "none", task_id: null, title: null },
      },
      delivery_receipts: deliveryReceipts,
    };
  }

  private async readAttempt(id: string) {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
    const attempt = entry.work_attempt_id ? await this.durability.getAttempt(entry.work_attempt_id) : null;
    const lastGeneration = attempt?.execution_generations.at(-1) ?? null;
    return {
      entry_id: entry.id,
      work_attempt_id: attempt?.work_attempt_id ?? null,
      workspace_path: attempt?.workspace_path ?? null,
      last_terminal: lastGeneration?.terminal ?? null,
      restart_count: Math.max(0, (attempt?.execution_generations.length ?? 0) - 1),
      execution_generations: attempt?.execution_generations ?? [],
      checkpoints: attempt?.checkpoints ?? [],
      activity: entry.activity ?? [],
    };
  }

  /** Queue convergence without making a control-socket caller wait for launch. */
  private requestConvergence(entryId: string): void {
    if (this.handoffScheduled || !this.providerPort || !this.autoConverge) return;
    const previous = this.convergenceRequests.get(entryId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      // Direct manifest convergence and the legacy reconciliation scheduler
      // both mutate provider authority for this entry. They must share one
      // serialization lane; otherwise a pause/resume edge can observe the
      // durable generation before its provider handle is installed and mint a
      // second live generation.
      .then(() => this.serializeEntryTick(entryId, () => this.convergeManifestEntry(entryId)))
      .catch(async (error) => {
        await this.recordSchedulerFailure(entryId, error, "daemon-convergence").catch(() => undefined);
      })
      .finally(() => {
        if (this.convergenceRequests.get(entryId) === next) this.convergenceRequests.delete(entryId);
      });
    this.convergenceRequests.set(entryId, next);
  }

  private currentEntryControlEpoch(entryId: string): number {
    return this.entryControlEpochs.get(entryId) ?? 0;
  }

  private bumpEntryControlEpoch(entryId: string): number {
    const next = this.currentEntryControlEpoch(entryId) + 1;
    this.entryControlEpochs.set(entryId, next);
    return next;
  }

  private reserveProviderDispatch(entryId: string, executionGenerationId: string): { token: symbol; release: (error?: unknown) => void } {
    const token = Symbol(`provider-dispatch:${entryId}`);
    let release!: () => void;
    let reject!: (error: unknown) => void;
    const reservation = new Promise<void>((resolve, rejectReservation) => { release = resolve; reject = rejectReservation; });
    // stopForHandoff awaits the original rejected promise. Outside handoff,
    // keep a rejection observed so an injected persistence+stop failure does
    // not become a process-level unhandled rejection.
    void reservation.catch(() => undefined);
    this.providerDispatchReservations.add(reservation);
    this.activeProviderDispatches.set(token, {
      entryId, executionGenerationId, daemonGeneration: this.singleton.currentGeneration,
    });
    return {
      token,
      release: (error) => {
        this.activeProviderDispatches.delete(token);
        this.providerDispatchReservations.delete(reservation);
        if (error === undefined) release();
        else {
          this.fatalProviderDispatchError ??= error;
          reject(error);
        }
      },
    };
  }

  private reserveBoundedEffectJournal<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const reservation = new Promise<void>((resolve) => { release = resolve; });
    this.boundedEffectJournalReservations.add(reservation);
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      this.boundedEffectJournalReservations.delete(reservation);
      release();
      throw error;
    }
    return result.finally(() => {
      this.boundedEffectJournalReservations.delete(reservation);
      release();
    });
  }

  /** Re-read durable intent after every delayed launch boundary. */
  private async launchEntryIfCurrent(entryId: string, expectedEpoch: number): Promise<DaemonManifestEntry | null> {
    if (this.handoffScheduled || this.currentEntryControlEpoch(entryId) !== expectedEpoch) return null;
    const current = await this.store.getEntry(entryId);
    if (this.handoffScheduled || this.currentEntryControlEpoch(entryId) !== expectedEpoch
      || current?.desired_state !== "running") return null;
    return current;
  }

  private async terminalizeUnlaunchedGeneration(
    attempt: Awaited<ReturnType<WorkDurabilityStore["getAttempt"]>>,
    executionGenerationId: string,
    generation: number,
  ): Promise<void> {
    const terminal = this.terminalPayload({
      endedAt: new Date().toISOString(), exitCode: 0, signal: null,
      terminalCause: "stopped", providerContinuationId: null,
    }, "daemon-provider");
    await this.durability.recordTerminal(attempt.work_attempt_id, executionGenerationId, {
      ...terminal, generation, actor: "daemon-provider",
    });
    await this.durability.releaseTerminalExecutionFence(attempt.work_attempt_id, executionGenerationId);
  }

  /** Stop and record the real terminal for a returned handle that could not be journaled. */
  private async fenceUnpersistedReturnedProvider(
    attempt: Awaited<ReturnType<WorkDurabilityStore["getAttempt"]>>,
    executionGenerationId: string,
    generation: number,
    handle: ProviderActionHandle,
  ): Promise<void> {
    const terminal = await this.providerPort!.stop(handle, {
      actionId: `manifest:unjournaled-dispatch-fence:${executionGenerationId}`,
    });
    await this.durability.recordTerminal(attempt.work_attempt_id, executionGenerationId, {
      ...this.terminalPayload(terminal, "daemon-provider"), generation, actor: "daemon-provider",
    });
    await this.durability.releaseTerminalExecutionFence(attempt.work_attempt_id, executionGenerationId);
  }

  /** A real handle returned after Pause/Stop won the race; fence that exact process. */
  private async fenceReturnedProviderAfterControl(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    generation: number,
  ): Promise<boolean> {
    // A control request bumps the epoch before it queues its durable manifest
    // mutation. Drain that queue so the exact desired state, not a stale
    // pre-control row, decides whether this returned provider must be stopped.
    await this.serializeManifestMutation(async () => undefined);
    const current = await this.store.getEntry(entryId);
    if (!current || current.desired_state === "running") return false;
    await this.supervisedDelivery?.stop(entryId).catch(() => undefined);
    await this.transition(entryId, "stopping", current.condition, `desired state changed to ${current.desired_state} during provider dispatch`, "daemon-convergence");
    const terminal = await this.providerPort!.stop(handle, {
      actionId: `manifest:${entryId}:${current.desired_state}:dispatch-fence:${generation}`,
    });
    if (this.liveHandles.get(entryId) === handle) {
      this.liveHandles.delete(entryId);
      this.liveBindingIdentities.delete(entryId);
      for (const dispose of this.liveDisposers.get(entryId) ?? []) dispose();
      this.liveDisposers.delete(entryId);
    }
    const attempt = current.work_attempt_id ? await this.durability.getAttempt(current.work_attempt_id) : null;
    const execution = attempt?.execution_generations.find((candidate) => candidate.execution_generation_id === executionGenerationId);
    if (attempt && execution && !execution.terminal) {
      await this.durability.recordTerminal(attempt.work_attempt_id, executionGenerationId, {
        ...this.terminalPayload(terminal, execution.actor), generation: execution.generation,
      });
      if (current.desired_state === "stopped") {
        await this.durability.releaseTerminalExecutionFence(attempt.work_attempt_id, executionGenerationId);
      }
    }
    await this.observeProviderExitOnce(entryId, terminal, "daemon-provider", executionGenerationId, handle);
    return true;
  }

  private async revalidateReturnedProviderControl(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    generation: number,
    expectedEpoch: number,
  ): Promise<"current" | "fenced" | "handoff"> {
    if (this.handoffScheduled) return "handoff";
    if (this.currentEntryControlEpoch(entryId) === expectedEpoch) return "current";
    return await this.fenceReturnedProviderAfterControl(entryId, handle, executionGenerationId, generation)
      ? "fenced"
      : this.handoffScheduled ? "handoff" : "current";
  }

  private async convergeManifestEntry(entryId: string): Promise<void> {
    if (this.handoffScheduled || !this.providerPort) return;
    let entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    let launchControlEpoch = this.currentEntryControlEpoch(entryId);
    if (!this.providerPort) throw new Error(`No daemon provider port is available for ${entry.provider}.`);

    const historicalControl = entry.turn_control;
    if (historicalControl && historicalControl.status !== "completed"
      && entry.work_attempt_id === historicalControl.work_attempt_id) {
      const attempt = await this.durability.getAttempt(historicalControl.work_attempt_id);
      const controlledExecution = attempt.execution_generations.find((candidate) =>
        candidate.execution_generation_id === historicalControl.execution_generation_id);
      if (controlledExecution?.terminal) {
        // Upgrade recovery is independent of the current provider_ref. A
        // predecessor may already have detached it or installed a successor;
        // the exact terminal execution is sufficient to retire the barrier,
        // while only an exact inbox_item_id permits FIFO mutation.
        entry = await this.completeTurnControlForRuntimeRecovery(entry);
      }
    }

    if (entry.desired_state === "running") {
      if (entry.condition === "quarantined") return;
      // A restart may load a manifest written by an older Desktop build. Fence
      // rental authority before attach, worker-bearer minting, or room delivery;
      // the later launch assertion alone cannot protect a still-live provider.
      if (entry.id.startsWith("supervised_rental_")) {
        const rentalConfiguration = await this.store.getAgentConfiguration(entry.id);
        try {
          if (!rentalConfiguration) {
            throw new Error("Rental agent configuration is unavailable.");
          }
          assertSupervisedRentalPermissionProfileAvailable(
            rentalConfiguration.provider,
            rentalConfiguration.permission_profile_id,
          );
        } catch (error) {
          await this.supervisedDelivery?.stop(entry.id).catch(() => undefined);
          await this.transition(
            entry.id,
            "failed",
            "quarantined",
            error instanceof Error ? error.message : "Unsafe rental permission profile.",
            "daemon-convergence",
          );
          return;
        }
      }
      // A daemon-inbox provider has no ambient room credential. Do not create
      // it (or even a new work execution) until Electron installs the exact
      // host grant over the local daemon socket.
      if (this.requiresHostGrant(entry) && !this.currentHostGrant(entry)) return;
      // A running provider from before cursor admission must not attach,
      // resume, or spawn in the grant-install/bootstrap gap. Bootstrap owns
      // the first-tail boundary and queues this convergence only afterwards.
      if (this.requiresHostGrant(entry) && !await this.supervisedInbox.cursor(entry.id)) return;
      if (this.requiresHostGrant(entry) && !await this.ensureHostGrantFresh(entry)) return;
      entry = await this.launchEntryIfCurrent(entry.id, launchControlEpoch) ?? entry;
      if (entry.desired_state !== "running" || this.currentEntryControlEpoch(entry.id) !== launchControlEpoch || this.handoffScheduled) return;
      if (entry.observed_state === "failed") {
        const now = this.nowMs();
        const exitsInWindow = (entry.reconciliation?.exit_timestamps_ms ?? [])
          .filter((at) => at >= now - CRASH_LOOP_WINDOW_MS).length;
        if (exitsInWindow >= CRASH_LOOP_EXIT_LIMIT) {
          await this.transition(
            entry.id,
            "failed",
            "quarantined",
            "crash-loop threshold reached before provider restart",
            "daemon-convergence",
          );
          return;
        }
        const restartAt = entry.reconciliation?.next_restart_at_ms;
        if (typeof restartAt === "number" && restartAt > now) {
          this.scheduleRecoveryConvergence(entry.id, restartAt - now);
          return;
        }
      }
      entry = await this.ensureWorkAttempt(entry);
      const currentAfterAttempt = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
      if (!currentAfterAttempt) return;
      entry = currentAfterAttempt;
      let handle = this.liveHandles.get(entry.id) ?? null;
      if (!handle && entry.provider_ref) {
        try {
          handle = await this.attachLiveProvider(entry);
        } catch (error) {
          if ((error as { providerAttachOutcome?: unknown })?.providerAttachOutcome !== "in_progress") throw error;
          await this.transition(
            entry.id,
            "recovering",
            "none",
            "exact Cursor turn wrapper is still finishing; retrying without launching a successor",
            "daemon-convergence",
          );
          this.scheduleRecoveryConvergence(entry.id, 250);
          return;
        }
        entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId) ?? entry;
      }
      if (handle) {
        if (this.requiresHostGrant(entry) && this.currentHostGrant(entry)) {
          const binding = await this.workerBindings.get(entry.id);
          const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
          const supervisedSession = binding ? await this.workerBindings.supervisedWorkerSession(entry.id) : null;
          const expiring = binding ? await this.hostWorkerBearerNeedsRotation(entry, binding) : false;
          if ((!credential || expiring) && entry.provider_ref?.execution_generation_id) {
            const executionGenerationId = entry.provider_ref.execution_generation_id;
            try {
              const minted = await this.mintHostWorkerSession(entry, executionGenerationId);
              if (minted) {
                await this.bindMintedHostWorkerSession(entry.id, minted);
                // Binding clears a coordination/auth latch in the durable
                // manifest. Refresh before the generic handle-state
                // reconciliation below so its stale copy cannot restore the
                // just-cleared condition.
                entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId) ?? entry;
              }
            } catch (error) {
              // A still-live bearer remains usable until its deadline. Keep
              // the exact provider and let the next heartbeat retry rotation.
              const bearerExpiry = supervisedSession?.expires_at ? Date.parse(supervisedSession.expires_at) : Number.NaN;
              if (!credential) {
                await this.recordWorkerBindingRecoveryFailure(
                  entry.id,
                  executionGenerationId,
                  error,
                );
                return;
              }
              if (Number.isFinite(bearerExpiry) && bearerExpiry <= this.nowMs()) {
                await this.blockExpiredWorkerAuthority(entry, `Worker bearer rotation failed after expiry: ${error instanceof Error ? error.message : "unknown error"}`);
                return;
              }
            }
          }
        }
        if (entry.observed_state !== handle.observedState) {
          await this.transition(entry.id, handle.observedState, entry.condition, "reattached durable provider handle", "daemon-convergence");
        }
        if (["failed", "stopped"].includes(handle.observedState)
          || (handle.observedState === "idle" && entry.delivery_mode !== "daemon_inbox")) {
          await this.fenceTerminalProviderHandleOnce(
            handle,
            `manifest:${entry.id}:reattached-terminal:${entry.provider_ref?.execution_generation_id ?? "unknown"}`,
          );
        }
        if (entry.desired_state === "running" && entry.delivery_mode === "daemon_inbox") {
          // A healthy provider handle does not imply its room-ingress loop is
          // alive. Lifecycle rollback, transient binding reads, and daemon
          // recovery all converge this independently owned component here.
          await this.startSupervisedDelivery(entry.id, "ensure");
        }
        return;
      }

      const attempt = await this.durability.getAttempt(entry.work_attempt_id!);
      const activeExecution = attempt.execution_generations.find((candidate) => candidate.terminal === null);
      // Cursor's daemon-inbox lane is intentionally process-less while idle.
      // Its adapter returns null only after any recorded per-turn child is
      // proved absent/fenced, so the durable session must reach resume() even
      // though the execution generation itself remains nonterminal.
      const resumableCursorLane = entry.provider === "cursor"
        && entry.delivery_mode === "daemon_inbox"
        && entry.provider_ref?.provider_connection?.kind === "cursor_cli";
      if (activeExecution && !resumableCursorLane) {
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "durable execution generation remains live without an attachable provider handle",
          "daemon-convergence",
        );
        return;
      }
      if (!activeExecution && entry.turn_control && entry.turn_control.status !== "completed") {
        // Automatic restart crosses the same proven-terminal generation
        // boundary as explicit recovery. Retire the old action/FIFO authority
        // before a successor generation can exist.
        entry = await this.completeTurnControlForRuntimeRecovery(entry);
      }
      const priorBinding = entry.provider_ref ? await this.workerBindings.get(entry.id) : null;
      const resumeWorker = priorBinding
        && priorBinding.room_id === entry.room_id
        && priorBinding.work_attempt_id === attempt.work_attempt_id
        ? {
          agentSessionId: priorBinding.agent_session_id,
          roomCursor: priorBinding.room_cursor ?? null,
        }
        : null;
      const ref = entry.provider_ref ? this.providerRef(entry) : null;
      const mintedAuthorization = this.requiresHostGrant(entry)
        ? await this.mintHostWorkerAuthorization(entry)
        : null;
      if (this.requiresHostGrant(entry) && !mintedAuthorization) return;
      const currentAfterMint = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
      if (!currentAfterMint) return;
      entry = currentAfterMint;
      const capabilities = await this.providerPort.capabilities(attempt.work_attempt_id, entry.provider);
      const currentAfterCapabilities = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
      if (!currentAfterCapabilities) return;
      entry = currentAfterCapabilities;
      const deliveryMode = entry.delivery_mode ?? "mcp_polling";
      if (capabilities.deliveryModes && !capabilities.deliveryModes.includes(deliveryMode)) {
        await this.transition(
          entry.id,
          "failed",
          "coordination_blocked",
          `${supervisedProviderLabel(entry.provider)} does not support ${deliveryMode} room delivery.`,
          "daemon-convergence",
        );
        return;
      }
      const resumed = Boolean(ref && capabilities.resume);
      if (this.requiresHostGrant(entry)) {
        const grant = this.currentHostGrant(entry);
        if (!grant || !await this.ownsDaemonGeneration(grant.daemonGeneration)) return;
      }
      // Every potentially long remote authorization/capability await is now
      // complete. Only then may this daemon create a durable live generation.
      await this.transition(entry.id, entry.provider_ref ? "recovering" : "starting", "none", entry.provider_ref ? "recovering durable provider continuation" : "starting daemon-owned provider", "daemon-convergence");
      const currentAfterTransition = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
      if (!currentAfterTransition) return;
      entry = currentAfterTransition;
      if (this.requiresHostGrant(entry)) {
        const grant = this.currentHostGrant(entry);
        if (!grant || !await this.ownsDaemonGeneration(grant.daemonGeneration)) return;
      }
      const launchConfiguration = await this.store.getAgentConfiguration(entry.id);
      if (!launchConfiguration) throw new Error("Agent configuration disappeared before provider launch.");
      // Stored rows can predate the supervised Inspector contract. Re-check
      // admission at the last possible boundary so a stale generic default
      // cannot reach the native provider launch path.
      const permissionProfileId = entry.id.startsWith("supervised_rental_")
        ? assertSupervisedRentalPermissionProfileAvailable(
            launchConfiguration.provider,
            launchConfiguration.permission_profile_id,
          )
        : assertSupervisedPermissionProfileAvailable(
            launchConfiguration.provider,
            launchConfiguration.permission_profile_id,
          );
      const launchSnapshot = deriveProviderConfigurationSnapshot({
        provider: launchConfiguration.provider,
        model: launchConfiguration.model,
        reasoningEffort: launchConfiguration.reasoning_effort ?? null,
        permissionProfileId,
        configurationRevision: launchConfiguration.config_revision,
      }, launchConfiguration.provider_launch_policy);
      const openModelCredential = entry.provider === "open-model"
        ? this.openModelCredentials.get(entry.id) ?? null
        : null;
      if (entry.provider === "open-model"
        && (!openModelCredential
          || openModelCredential.daemonGeneration !== this.singleton.currentGeneration)) {
        throw new Error("Waiting for desktop Open Model credential handoff.");
      }
      const reusesActiveCursorExecution = Boolean(resumableCursorLane && activeExecution);
      const generationNumber = reusesActiveCursorExecution
        ? activeExecution!.generation
        : attempt.execution_generations.reduce((max, candidate) => Math.max(max, candidate.generation), 0) + 1;
      const execution = reusesActiveCursorExecution
        ? activeExecution!
        : await this.durability.startGeneration(attempt.work_attempt_id, "daemon-provider", generationNumber);
      if (reusesActiveCursorExecution && priorBinding
        && priorBinding.execution_generation_id !== execution.execution_generation_id) {
        throw new Error("Process-less Cursor recovery found a worker binding for a different execution generation.");
      }
      if (!await this.launchEntryIfCurrent(entry.id, launchControlEpoch)) {
        if (!reusesActiveCursorExecution) {
          await this.terminalizeUnlaunchedGeneration(attempt, execution.execution_generation_id, generationNumber);
        }
        return;
      }
      const devMcpServerEntryPath = devMcpServerEntryFromEnv() ?? undefined;
      let mintedHostSession: Awaited<ReturnType<SupervisorDaemon["mintHostWorkerSession"]>> = null;
      const spawn: ProviderActionSpawn = {
        workAttemptId: attempt.work_attempt_id,
        roomId: entry.room_id,
        cwd: attempt.workspace_path,
        launchPolicy: launchSnapshot.launchPolicy,
        provider: launchSnapshot.provider,
        model: launchSnapshot.model,
        reasoningEffort: launchSnapshot.reasoningEffort,
        permissionProfileId: launchSnapshot.permissionProfileId,
        configurationRevision: launchSnapshot.configurationRevision,
        deliveryMode: entry.delivery_mode ?? "mcp_polling",
        agentDisplayName: entry.display_name,
        actionId: `manifest:${entry.id}:generation:${generationNumber}`,
        supervisorEntryId: entry.id,
        supervisorSocketPath: this.socket.path,
        supervisorExecutionGenerationId: execution.execution_generation_id,
        ...(resumeWorker ? { supervisorWorkerSession: resumeWorker } : {}),
        ...(devMcpServerEntryPath && (entry.provider === "codex"
          || entry.provider === "open-model"
          || entry.provider === "cursor")
          ? { devMcpServerEntryPath }
          : {}),
        ...(openModelCredential ? {
          providerCredential: {
            apiKey: openModelCredential.apiKey,
            baseUrl: openModelCredential.baseUrl,
            model: launchSnapshot.model?.trim() || openModelCredential.model,
          },
        } : {}),
      };
      let providerPersisted = false;
      let providerDispatched = false;
      let unpersistedReturnedProviderFenced = false;
      try {
        if (mintedAuthorization) {
          mintedHostSession = await this.recordMintedHostWorkerSession(entry, execution.execution_generation_id, mintedAuthorization);
          if (!mintedHostSession) throw new Error("Waiting for desktop credential handoff.");
          Object.assign(spawn, { supervisorWorkerSession: { agentSessionId: mintedHostSession.agentSessionId, roomCursor: null } });
        }
        if (!await this.launchEntryIfCurrent(entry.id, launchControlEpoch)) {
          if (!reusesActiveCursorExecution) {
            await this.terminalizeUnlaunchedGeneration(attempt, execution.execution_generation_id, generationNumber);
          }
          return;
        }
        const dispatchReservation = this.reserveProviderDispatch(entry.id, execution.execution_generation_id);
        let fatalReservationError: unknown;
        try {
          try {
            handle = resumed
              ? await this.providerPort.resume(ref!, { ...spawn, resumeFrom: ref })
              : await this.providerPort.spawn(spawn);
            providerDispatched = true;
            // This check is synchronous with the native return: an adapter
            // that cannot attest the exact snapshot is still an unjournaled
            // provider and is fenced by the cleanup path below. It never
            // becomes an attachable continuation under ambiguous authority.
            if (handle.appliedConfigurationRevision !== launchSnapshot.configurationRevision) {
              throw new Error("Provider launch did not attest the complete configuration snapshot.");
            }
            await this.persistDispatchedProvider(
              dispatchReservation.token, entry.id, handle, execution.execution_generation_id,
            );
            // The native continuation is now durable. Configuration apply is
            // subsequent bookkeeping and must never make handoff treat this
            // exact returned provider as unjournaled.
            providerPersisted = true;
            const applied = await this.store.markRuntimeConfigurationApplied(this.manifestGeneration, {
              agentId: entry.id,
              executionGenerationId: execution.execution_generation_id,
              appliedRevision: launchSnapshot.configurationRevision,
            }, (commit) => this.fenceDaemonCommit(commit));
            this.manifestGeneration = applied.generation;
            await this.durability.checkpoint(attempt.work_attempt_id, { room_cursor: null, provider_continuation_id: handle.providerContinuationId });
            if (this.handoffScheduled) {
              // The successor attaches this exact durable continuation. Do not
              // signal it or register callbacks owned by the retiring daemon.
              return;
            }
            let control = await this.revalidateReturnedProviderControl(
              entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
            );
            if (control === "handoff" || control === "fenced") return;
            launchControlEpoch = this.currentEntryControlEpoch(entry.id);
            // installProviderHandle has its own async listener-registration
            // boundaries. The synchronous guard prevents it from starting room
            // delivery if Pause/Stop/handoff wins during those awaits.
            if (this.handoffScheduled) return;
            await this.installProviderHandle(
              entry.id,
              handle,
              execution.execution_generation_id,
              () => !mintedHostSession
                && !this.handoffScheduled
                && this.currentEntryControlEpoch(entryId) === launchControlEpoch,
            );
            if (this.handoffScheduled) return;
            control = await this.revalidateReturnedProviderControl(
              entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
            );
            if (control === "handoff" || control === "fenced") return;
            launchControlEpoch = this.currentEntryControlEpoch(entry.id);

            if (mintedHostSession) {
              control = await this.revalidateReturnedProviderControl(
                entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
              );
              if (control === "handoff" || control === "fenced") return;
              launchControlEpoch = this.currentEntryControlEpoch(entry.id);
              try {
                await this.bindMintedHostWorkerSession(
                  entry.id,
                  mintedHostSession,
                  () => !this.handoffScheduled && this.currentEntryControlEpoch(entryId) === launchControlEpoch,
                );
              } catch (error) {
                if (this.handoffScheduled) return;
                control = await this.revalidateReturnedProviderControl(
                  entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
                );
                if (control === "handoff" || control === "fenced") return;
                await this.recordWorkerBindingRecoveryFailure(
                  entry.id,
                  execution.execution_generation_id,
                  error,
                );
                return;
              }
              if (this.handoffScheduled) return;
              control = await this.revalidateReturnedProviderControl(
                entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
              );
              if (control === "handoff" || control === "fenced") return;
              launchControlEpoch = this.currentEntryControlEpoch(entry.id);
            }

            // Last guard before terminal/bootstrap state and delivery logic
            // continue outside this native dispatch reservation.
            control = await this.revalidateReturnedProviderControl(
              entry.id, handle, execution.execution_generation_id, generationNumber, launchControlEpoch,
            );
            if (control === "handoff" || control === "fenced") return;
            launchControlEpoch = this.currentEntryControlEpoch(entry.id);
          } catch (error) {
            if (providerDispatched && !providerPersisted && handle) {
              try {
                await this.fenceUnpersistedReturnedProvider(
                  attempt, execution.execution_generation_id, generationNumber, handle,
                );
                unpersistedReturnedProviderFenced = true;
              } catch (cleanupError) {
                fatalReservationError = cleanupError;
                throw new AggregateError([error, cleanupError], "Returned provider could not be journaled or exactly fenced.");
              }
            }
            throw error;
          }
        } finally {
          dispatchReservation.release(fatalReservationError);
        }
      } catch (error) {
        if (reusesActiveCursorExecution && !providerPersisted) {
          await this.recordWorkerBindingRecoveryFailure(
            entry.id,
            execution.execution_generation_id,
            error,
          );
          return;
        }
        if (providerPersisted && this.handoffScheduled) return;
        // Once the provider reference is durable, do not convert a local
        // post-spawn bookkeeping/credential issue into a terminal execution.
        // The exact provider remains the recovery target; no stop, restart,
        // migration, or second spawn is permitted here.
        if (providerPersisted) {
          await this.recordWorkerBindingRecoveryFailure(
            entry.id,
            execution.execution_generation_id,
            error,
          );
          return;
        }
        // A native handle that actually returned is never an "unlaunched"
        // generation. Persistence normally cannot fail here because the
        // active reservation falls back through the retirement gate, but an
        // unexpected fault must still avoid fabricating terminal evidence.
        if (providerDispatched || unpersistedReturnedProviderFenced) throw error;
        const terminal = this.terminalPayload({
          endedAt: new Date().toISOString(), exitCode: null, signal: null,
          terminalCause: "protocol_error", providerContinuationId: entry.provider_ref?.provider_continuation_id ?? null,
        }, "daemon-provider");
        try {
          await this.durability.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ...terminal, generation: generationNumber, actor: "daemon-provider" });
          await this.durability.releaseTerminalExecutionFence(attempt.work_attempt_id, execution.execution_generation_id);
        } catch (cleanupError) {
          const launchMessage = error instanceof Error ? error.message : "unknown provider launch failure";
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : "unknown failed-launch cleanup failure";
          throw new Error(`Provider launch failed (${launchMessage}) and durable cleanup failed (${cleanupMessage}).`, { cause: error });
        }
        throw error;
      }
      if (["failed", "stopped"].includes(handle.observedState)
        || (handle.observedState === "idle" && entry.delivery_mode !== "daemon_inbox")) {
        // A provider can finish the bootstrap turn before spawn/resume
        // returns and before the daemon has installed its stream listener.
        // The handle state is still authoritative: a persistent polling
        // worker that already failed or completed has no live delivery
        // loop. Fence it after installing the exit listener so the normal
        // terminal callback can persist the edge and mint a bounded resume
        // generation instead of parking forever on a terminal live handle.
        await this.fenceTerminalProviderHandleOnce(
          handle,
          `manifest:${entry.id}:returned-terminal:${generationNumber}`,
        );
        return;
      }
      if (priorBinding && !resumed) {
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "fresh provider generation cannot inherit a terminal worker credential; awaiting exact bind",
          "daemon-convergence",
        );
        return;
      }
      if (resumed && priorBinding && !reusesActiveCursorExecution) {
        try {
          await this.stageWorkerBindingAfterResume(entry, priorBinding, execution.execution_generation_id, handle);
        } catch (error) {
          await this.transition(
            entry.id,
            "recovering",
            "coordination_blocked",
            `resumed provider worker binding could not be staged: ${error instanceof Error ? error.message : "unknown binding recovery failure"}`,
            "daemon-convergence",
          );
          return;
        }
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "resumed provider awaits exact worker wait evidence",
          "daemon-convergence",
        );
        return;
      }
      this.providerStartRetryAttempts.delete(entry.id);
      this.workerMintRecoveryRetryAttempts.delete(entry.id);
      await this.transition(entry.id, handle.observedState, "none", resumed ? "provider resumed under daemon authority" : "provider launched under daemon authority", "daemon-convergence");
      return;
    }

    let handle = this.liveHandles.get(entry.id) ?? null;
    const exactCursorRef = entry.provider_ref?.provider_connection?.kind === "cursor_cli"
      ? entry.provider_ref
      : null;
    if (!handle && exactCursorRef && this.providerPort.stopRef) {
      await this.transition(entry.id, "stopping", entry.condition, `desired state changed to ${entry.desired_state}`, "daemon-convergence");
      const terminal = await this.providerPort.stopRef(this.providerRef(entry), {
        actionId: `manifest:${entry.id}:${entry.desired_state}:${this.nowMs()}`,
      });
      const attempt = await this.durability.getAttempt(exactCursorRef.work_attempt_id);
      const execution = attempt.execution_generations.find((candidate) =>
        candidate.execution_generation_id === exactCursorRef.execution_generation_id);
      if (!execution) throw new Error("Cursor exact-reference stop has no matching durable execution generation.");
      if (!execution.terminal) {
        await this.durability.recordTerminal(exactCursorRef.work_attempt_id, exactCursorRef.execution_generation_id, {
          ...this.terminalPayload(terminal, execution.actor),
          actor: execution.actor,
          generation: execution.generation,
        });
        if (entry.desired_state === "stopped") {
          await this.durability.releaseTerminalExecutionFence(exactCursorRef.work_attempt_id, exactCursorRef.execution_generation_id);
        }
      }
      await this.observeProviderExitOnce(entry.id, terminal, "daemon-provider", exactCursorRef.execution_generation_id);
      return;
    }
    if (!handle && entry.provider_ref) {
      handle = await this.attachLiveProvider(entry);
    }
    if (handle) {
      await this.transition(entry.id, "stopping", entry.condition, `desired state changed to ${entry.desired_state}`, "daemon-convergence");
      await this.providerPort.stop(handle, { actionId: `manifest:${entry.id}:${entry.desired_state}:${this.nowMs()}` });
      return;
    }
    await this.transition(entry.id, entry.desired_state === "paused" ? "paused" : "stopped", "none", "desired state converged without a live provider", "daemon-convergence");
  }

  private providerRef(entry: DaemonManifestEntry): ProviderActionRef {
    const ref = entry.provider_ref;
    if (!ref) throw new Error("Manifest entry has no durable provider ref.");
    return {
      workAttemptId: ref.work_attempt_id,
      providerContinuationId: ref.provider_continuation_id,
      provider: entry.provider,
      providerConnection: ref.provider_connection,
    };
  }

  /**
   * Attach only when the manifest's exact execution generation is still live.
   * A provider transport (for example a long-lived app-server) can remain
   * reachable after an intentional worker stop, but that transport is not
   * authority to resurrect the terminal generation. A later desired=running
   * transition must instead mint a successor generation and use resume/spawn.
   */
  private async attachLiveProvider(
    entry: DaemonManifestEntry,
    mayStartDelivery: () => boolean = () => true,
  ): Promise<ProviderActionHandle | null> {
    const ref = entry.provider_ref;
    if (!ref) return null;
    const attempt = await this.durability.getAttempt(ref.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === ref.execution_generation_id);
    if (!execution) throw new Error("Manifest provider reference has no matching durable execution generation.");
    if (execution.terminal) return null;
    const attachment = await this.providerPort!.attach(this.providerRef(entry));
    if (!attachment) return null;
    if (this.isAttachTerminal(attachment)) {
      const terminal = attachment.terminal;
      if (terminal.providerContinuationId && terminal.providerContinuationId !== ref.provider_continuation_id) {
        throw new Error("Provider attach terminal evidence belongs to a different durable continuation.");
      }
      await this.durability.recordTerminal(ref.work_attempt_id, execution.execution_generation_id, {
        ...this.terminalPayload(terminal, execution.actor),
        actor: execution.actor,
        generation: execution.generation,
      });
      // A no-handle attach result used to strand this generation forever. The
      // explicit terminal evidence proves the writer absent (or fenced), so it
      // is now safe to release workspace authority before bounded resume.
      await this.durability.releaseTerminalExecutionFence(ref.work_attempt_id, execution.execution_generation_id);
      // Keep the private credential on its durably terminal generation. It is
      // no longer projected or allowed to publish, but a later exact native
      // resume needs it for verify-before-rollover compatibility with workers
      // that cannot bind again after their saved provider session resumes.
      return null;
    }
    const handle = attachment;
    let authoritativeEntry = entry;
    if (handle.providerConnection && ref.provider_connection
      && !sameProviderActionConnectionIdentity(ref.provider_connection, handle.providerConnection)) {
      throw new Error("Attached provider returned connection evidence that conflicts with the durable manifest.");
    }
    if (handle.providerConnection && !ref.provider_connection) {
      authoritativeEntry = await this.updateManifestEntry(entry.id, (current) => {
        if (current.work_attempt_id !== ref.work_attempt_id
          || current.provider_ref?.execution_generation_id !== ref.execution_generation_id
          || current.provider_ref.provider_continuation_id !== ref.provider_continuation_id) {
          throw new Error("Provider authority changed before recovered connection evidence could be persisted.");
        }
        return {
          ...current,
          provider_ref: {
            ...current.provider_ref,
            provider_connection: handle.providerConnection ?? null,
          },
        };
      });
    }
    await this.durability.recoverExecutionFence(ref.work_attempt_id);
    await this.installProviderHandle(
      authoritativeEntry.id,
      handle,
      ref.execution_generation_id,
      mayStartDelivery,
    );
    const binding = await this.workerBindings.get(authoritativeEntry.id);
    if (binding && binding.execution_generation_id !== ref.execution_generation_id) {
      try {
        await this.stageWorkerBindingAfterResume(
          authoritativeEntry,
          binding,
          ref.execution_generation_id,
          handle,
        );
        await this.transition(
          authoritativeEntry.id,
          "recovering",
          "coordination_blocked",
          "reattached resumed provider awaits exact worker wait evidence",
          "daemon-convergence",
        );
      } catch (error) {
        await this.transition(
          authoritativeEntry.id,
          "recovering",
          "coordination_blocked",
          `reattached provider worker binding could not be staged: ${error instanceof Error ? error.message : "unknown binding recovery failure"}`,
          "daemon-convergence",
        );
      }
    }
    return handle;
  }

  private isAttachTerminal(
    attachment: ProviderActionHandle | ProviderActionAttachTerminal,
  ): attachment is ProviderActionAttachTerminal {
    return "state" in attachment && attachment.state === "terminal";
  }

  private async ensureWorkAttempt(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    if (entry.work_attempt_id) {
      await this.durability.getAttempt(entry.work_attempt_id);
      return entry;
    }
    const sourcePath = entry.source_repo_path?.trim() || entry.workspace_path?.trim();
    if (!sourcePath) {
      const workAttemptId = randomUUID();
      const provisioned = await this.ephemeralProvisioner.provision({
        workAttemptId,
        taskId: entry.id,
      });
      const attempt = await this.durability.createAttempt({
        taskId: entry.id,
        leaseId: entry.id,
        leaseEpoch: 0,
        workspacePath: provisioned.path,
        workAttemptId,
      });
      return this.updateManifestEntry(entry.id, (current) => ({
        ...current,
        source_repo_path: null,
        workspace_path: attempt.workspace_path,
        work_attempt_id: attempt.work_attempt_id,
      }));
    }
    const remote = String(await this.gitCommand(["-C", sourcePath, "remote", "get-url", "origin"])).trim();
    const revision = String(await this.gitCommand(["-C", sourcePath, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const repo = repositoryStorageKey(remote);
    const workAttemptId = randomUUID();
    const provisioned = await this.provisioner.provision({
      repo,
      workAttemptId,
      taskId: entry.id,
      remoteUrl: remote,
      revision,
      sourceRepoPath: sourcePath,
    });
    const attempt = await this.durability.createAttempt({ taskId: entry.id, leaseId: entry.id, leaseEpoch: 0, workspacePath: provisioned.path, workAttemptId });
    return this.updateManifestEntry(entry.id, (current) => ({ ...current, source_repo_path: sourcePath, workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id }));
  }

  private async persistProviderHandle(entryId: string, handle: ProviderActionHandle, executionGenerationId: string): Promise<void> {
    if (!handle.providerContinuationId) throw new Error("Provider launch did not return a durable continuation id.");
    await this.updateManifestEntry(entryId, (current) => ({
      ...current,
      run_id: executionGenerationId,
      deployment_id: serializeDaemonDeploymentId(entryId, executionGenerationId),
      provider_ref: {
        work_attempt_id: handle.workAttemptId,
        provider_continuation_id: handle.providerContinuationId!,
        provider_connection: handle.providerConnection ?? null,
        execution_generation_id: executionGenerationId,
      },
    }));
  }

  /**
   * Select normal or retirement persistence while the exact native dispatch
   * reservation is live. If handoff wins the normal commit fence, retry only
   * through the narrow retirement gate before releasing the reservation.
   */
  private async persistDispatchedProvider(
    token: symbol,
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
  ): Promise<void> {
    if (this.handoffScheduled) {
      await this.persistReturnedProviderForHandoff(token, entryId, handle, executionGenerationId);
      return;
    }
    try {
      await this.persistProviderHandle(entryId, handle, executionGenerationId);
    } catch (error) {
      if (!this.handoffScheduled || !(error instanceof DaemonFenceLostError)) throw error;
      await this.persistReturnedProviderForHandoff(token, entryId, handle, executionGenerationId);
    }
  }

  /**
   * The sole mutation admitted after prepare_handoff: finish journaling a
   * native dispatch that began while this exact daemon generation owned the
   * singleton. The reservation is deleted before authority/store release.
   */
  private async persistReturnedProviderForHandoff(
    token: symbol,
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
  ): Promise<void> {
    if (!handle.providerContinuationId) throw new Error("Provider launch did not return a durable continuation id.");
    const reservation = this.activeProviderDispatches.get(token);
    if (!this.handoffScheduled || !reservation
      || reservation.entryId !== entryId
      || reservation.executionGenerationId !== executionGenerationId
      || reservation.daemonGeneration !== this.singleton.currentGeneration) {
      throw new DaemonFenceLostError("Retiring provider dispatch reservation is no longer exact.");
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.singleton.assertCurrent();
      const activeBeforeRead = this.activeProviderDispatches.get(token);
      if (!this.handoffScheduled || activeBeforeRead !== reservation
        || activeBeforeRead.daemonGeneration !== this.singleton.currentGeneration) {
        throw new DaemonFenceLostError("Retiring provider dispatch persistence gate closed.");
      }
      const snapshot = await this.store.load();
      const current = snapshot.entries.find((candidate) => candidate.id === entryId);
      if (!current || current.work_attempt_id !== handle.workAttemptId) {
        throw new DaemonFenceLostError("Retiring provider dispatch no longer matches the durable work attempt.");
      }
      if (current.provider_ref?.execution_generation_id === executionGenerationId
        && current.provider_ref.provider_continuation_id === handle.providerContinuationId) {
        this.manifestGeneration = snapshot.generation;
        return;
      }
      const updated: DaemonManifestEntry = {
        ...current,
        run_id: executionGenerationId,
        deployment_id: serializeDaemonDeploymentId(entryId, executionGenerationId),
        provider_ref: {
          work_attempt_id: handle.workAttemptId,
          provider_continuation_id: handle.providerContinuationId,
          provider_connection: handle.providerConnection ?? null,
          execution_generation_id: executionGenerationId,
        },
      };
      try {
        const next = await this.store.replaceEntry(snapshot.generation, updated, (commit) => this.serializeManifestCommit(async () => {
          const active = this.activeProviderDispatches.get(token);
          if (!this.handoffScheduled || active !== reservation
            || active.daemonGeneration !== this.singleton.currentGeneration) {
            throw new DaemonFenceLostError("Retiring provider dispatch persistence gate closed.");
          }
          await this.singleton.assertCurrent();
          await commit();
        }));
        this.manifestGeneration = next.generation;
        return;
      } catch (error) {
        if (!(error instanceof ManifestConflictError)) throw error;
      }
    }
    throw new DaemonFenceLostError("Retiring provider dispatch persistence could not converge on the latest manifest generation.");
  }

  private async installProviderHandle(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    mayStartDelivery: () => boolean = () => true,
  ): Promise<void> {
    for (const dispose of this.liveDisposers.get(entryId) ?? []) dispose();
    // A fresh provider generation owns a fresh ephemeral display transcript.
    // Keep only the monotonic sequence; never replay the predecessor's tail.
    this.resetAgentStream(entryId);
    this.liveHandles.set(entryId, handle);
    const binding = await this.workerBindings.get(entryId);
    const currentBinding = this.liveBindingIdentities.get(entryId);
    if (binding?.execution_generation_id === executionGenerationId) {
      if (!currentBinding || binding.updated_at >= currentBinding.updatedAt) {
        this.liveBindingIdentities.set(entryId, {
          agentSessionId: binding.agent_session_id,
          executionGenerationId: binding.execution_generation_id,
          updatedAt: binding.updated_at,
        });
      }
    } else if (currentBinding?.executionGenerationId !== executionGenerationId) {
      this.liveBindingIdentities.delete(entryId);
    }
    const disposeExit = await this.providerPort!.onExit(handle, (terminal) => {
      const bindingIdentity = this.liveBindingIdentities.get(entryId);
      this.trackProviderCallback(this.handleProviderTerminal(entryId, handle, executionGenerationId, bindingIdentity, terminal));
    });
    const disposeStream = this.providerPort!.onStream
      ? await this.providerPort!.onStream!(handle, (event) => { this.trackProviderCallback(this.enqueueProviderStream(entryId, handle, event)); })
      : () => {};
    const heartbeat = setInterval(() => {
      const current = this.liveHandles.get(entryId);
      if (!current) return;
      this.trackProviderCallback((async () => {
        const manifestEntry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
        if (!manifestEntry || this.liveHandles.get(entryId) !== current) return;
        if (this.liveBindingIdentities.get(entryId)?.executionGenerationId !== manifestEntry.provider_ref?.execution_generation_id) return;
        const retriesCredentialHandoff = manifestEntry.desired_state === "running"
          && manifestEntry.observed_state === "recovering"
          && manifestEntry.condition === "coordination_blocked"
          && manifestEntry.last_error === "Provider is running; waiting for desktop credential handoff.";
        if (!["working", "idle"].includes(manifestEntry.observed_state) && !retriesCredentialHandoff) return;
        if (!["working", "idle"].includes(current.observedState)) return;
        const hostGrant = this.requiresHostGrant(manifestEntry) ? this.currentHostGrant(manifestEntry) : null;
        if (hostGrant && this.hostGrantNeedsRenewal(hostGrant)) {
          this.requestConvergence(entryId);
          return;
        }
        if (hostGrant) {
          const binding = await this.workerBindings.get(entryId);
          if (binding && await this.hostWorkerBearerNeedsRotation(manifestEntry, binding)) {
            // The serialized convergence lane rotates the bearer against the
            // existing generation and provider. No Electron reinstall is
            // required while this daemon still owns the in-memory host grant.
            this.requestConvergence(entryId);
            return;
          }
        }
        const status = current.observedState === "idle" ? "idle" : "working";
        await this.publishNativeActivity(entryId, "native_harness.heartbeat", status);
      })().catch(() => undefined));
    }, this.nativeHeartbeatIntervalMs);
    heartbeat.unref();
    this.liveDisposers.set(entryId, [disposeExit, disposeStream, () => clearInterval(heartbeat), () => this.endAgentStream(entryId)]);
    if (mayStartDelivery()) void this.startSupervisedDelivery(entryId).catch(() => undefined);
  }

  private async stageWorkerBindingAfterResume(
    entry: DaemonManifestEntry,
    priorBinding: WorkerSessionBinding,
    successorExecutionGenerationId: string,
    handle: ProviderActionHandle,
  ): Promise<void> {
    const ref = entry.provider_ref;
    if (!ref
      || priorBinding.entry_id !== entry.id
      || priorBinding.room_id !== entry.room_id
      || priorBinding.work_attempt_id !== ref.work_attempt_id
      || handle.workAttemptId !== ref.work_attempt_id
      || handle.providerContinuationId !== ref.provider_continuation_id) {
      throw new Error("Resumed provider does not match the durable worker continuation identity.");
    }
    const attempt = await this.durability.getAttempt(ref.work_attempt_id);
    const predecessor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === priorBinding.execution_generation_id,
    );
    const successor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === successorExecutionGenerationId,
    );
    if (!predecessor?.terminal) {
      throw new Error("Worker binding predecessor execution is not durably terminal.");
    }
    if (predecessor.terminal.provider_continuation_id !== ref.provider_continuation_id) {
      throw new Error("Worker binding predecessor belongs to a different provider continuation.");
    }
    if (!successor || successor.terminal
      || attempt.execution_generations.filter((candidate) => candidate.terminal === null).length !== 1) {
      throw new Error("Worker binding successor is not the single live execution generation.");
    }
    this.pendingResumeBindings.set(entry.id, {
      roomId: entry.room_id,
      workAttemptId: ref.work_attempt_id,
      predecessorExecutionGenerationId: priorBinding.execution_generation_id,
      successorExecutionGenerationId,
      agentSessionId: priorBinding.agent_session_id,
      providerContinuationId: ref.provider_continuation_id,
    });
  }

  /**
   * Published MCP runtimes before bind-on-wait cannot present their credential
   * again after a native session resume. The first exact wait event proves the
   * saved worker-session identity. While the credential still belongs to its
   * terminal predecessor, verify it with the API; only an accepted response is
   * allowed to atomically advance the private binding and public projection.
   */
  private async restoreWorkerBindingFromWait(
    entryId: string,
    evidence: SupervisedWaitEvidence,
  ): Promise<boolean> {
    const pending = this.pendingResumeBindings.get(entryId);
    if (!pending || evidence.agentSessionId !== pending.agentSessionId) return false;
    const entry = await this.store.getEntry(entryId);
    const handle = this.liveHandles.get(entryId);
    if (!entry || !handle
      || entry.room_id !== pending.roomId
      || entry.work_attempt_id !== pending.workAttemptId
      || entry.provider_ref?.execution_generation_id !== pending.successorExecutionGenerationId
      || entry.provider_ref.provider_continuation_id !== pending.providerContinuationId
      || handle.workAttemptId !== pending.workAttemptId
      || handle.providerContinuationId !== pending.providerContinuationId) {
      throw new Error("Resumed wait evidence does not match the staged provider continuation.");
    }
    const attempt = await this.durability.getAttempt(pending.workAttemptId);
    const predecessor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === pending.predecessorExecutionGenerationId,
    );
    const successor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === pending.successorExecutionGenerationId,
    );
    if (!predecessor?.terminal) throw new Error("Worker binding predecessor execution is not durably terminal.");
    if (predecessor.terminal.provider_continuation_id !== pending.providerContinuationId) {
      throw new Error("Worker binding predecessor belongs to a different provider continuation.");
    }
    if (!successor || successor.terminal
      || attempt.execution_generations.filter((candidate) => candidate.terminal === null).length !== 1) {
      throw new Error("Worker binding successor is not the single live execution generation.");
    }
    const method = "native_harness.resumed_binding";
    const result = await this.workerBindings.verifyAndAdvanceExecutionGeneration({
      entryId,
      roomId: pending.roomId,
      workAttemptId: pending.workAttemptId,
      fromExecutionGenerationId: pending.predecessorExecutionGenerationId,
      toExecutionGenerationId: pending.successorExecutionGenerationId,
      agentSessionId: pending.agentSessionId,
    }, async ({ binding, sequence, observed_at }) => {
      const credential = await this.workerBindings.credentialFor(binding);
      if (!credential) throw new Error("Worker credential is unavailable until desktop credential delivery.");
      return { accepted: await publishWorkerNativeActivity({
        apiUrl: binding.api_url,
        roomId: binding.room_id,
        agentSessionId: binding.agent_session_id,
        bearer: credential,
        observedAt: observed_at,
        sequence,
        method,
        status: "working",
        operation: "resumed credential verification",
      }) };
    });
    if (!result.accepted) throw new Error("Native activity endpoint rejected the retained worker credential.");
    const verified = result.binding;
    this.liveBindingIdentities.set(entry.id, {
      agentSessionId: verified.agent_session_id,
      executionGenerationId: verified.execution_generation_id,
      updatedAt: verified.updated_at,
    });
    await this.updateManifestEntry(entry.id, (current) => {
      if (current.work_attempt_id !== pending.workAttemptId
        || current.provider_ref?.execution_generation_id !== pending.successorExecutionGenerationId
        || current.provider_ref.provider_continuation_id !== pending.providerContinuationId) {
        throw new Error("Manifest moved while restoring the resumed worker binding.");
      }
      return {
        ...current,
        observed_state: "working" as const,
        condition: "none" as const,
        last_error: null,
        workplace_liveness: {
          state: "reachable" as const,
          observed_at: verified.updated_at,
          detail: "exact persisted worker session restored after native resume",
        },
        last_worker_binding: {
          agent_session_id: verified.agent_session_id,
          work_attempt_id: verified.work_attempt_id,
          execution_generation_id: verified.execution_generation_id,
          updated_at: verified.updated_at,
        },
      };
    });
    this.pendingResumeBindings.delete(entryId);
    return true;
  }

  private async handleProviderStream(entryId: string, handle: ProviderActionHandle, event: ProviderActionStreamEvent): Promise<void> {
    if (this.liveHandles.get(entryId) !== handle) return;
    const observedLifecycle = providerStreamLifecycle(event);
    const entry = await this.store.getEntry(entryId);
    if (!entry) return;
    // A daemon-inbox worker deliberately completes one bounded native turn at
    // a time. During the one-way legacy Codex cutover, the old polling turn
    // has the same reusable-thread meaning: it is the handoff boundary, never
    // evidence that the app-server deployment died.
    const daemonInbox = entry.delivery_mode === "daemon_inbox";
    const legacyCodexCutover = entry.provider === "codex"
      && (entry.delivery_mode ?? "mcp_polling") === "mcp_polling"
      && entry.desired_state === "running";
    const effectiveLifecycle = (daemonInbox || legacyCodexCutover) && observedLifecycle === "terminal"
      ? "idle"
      : observedLifecycle;
    const addressedWaitResult = observedLifecycle === "idle"
      && isCorrelatedNonemptyWaitResult(event, entry.activity ?? []);
    // A terminal native failure is sticky for the installed execution. Late
    // deltas and heartbeats from that same handle are evidence, not recovery.
    const lifecycle = entry.observed_state === "failed"
      ? "failed"
      : addressedWaitResult ? "working" : effectiveLifecycle;
    // Provider-local stream counters may restart when a replacement daemon
    // attaches. Persist a daemon-global monotonic sequence for the manifest.
    const sequence = Math.max((entry.activity?.at(-1)?.sequence ?? 0) + 1, event.sequence);
    const quietlyPolling = isSupervisedWaitProviderEvent(event)
      || isSupervisedQuietPollContinuation(event, entry.activity ?? []);
    const status: DaemonActivityEvent["status"] = lifecycle === "failed"
      ? "blocked"
      : lifecycle === "terminal" || quietlyPolling ? "idle" : lifecycle;
    const sanitizedEvent = sanitizeDaemonActivityEvent({
      observed_at: event.observedAt,
      sequence,
      provider: event.provider,
      kind: event.kind,
      method: event.method,
      summary: (event.summary?.trim() || `${event.provider} · ${event.method}`).slice(0, 500),
      status,
      payload: event.payload,
      payload_truncated: event.payloadTruncated,
      payload_redacted: event.payloadRedacted,
      durable_payload_ref: event.durablePayloadRef,
    });
    // Cursor launches one native child per bounded turn. Its verified init is
    // the exact display-generation boundary: clear any prior turn before
    // assistant/tool projections for this child arrive.
    if (event.provider === "cursor" && event.method === "system/init") {
      this.resetAgentStream(entryId);
    }
    // Transcript probes and account telemetry remain in provider diagnostics;
    // they are transport facts, not human-readable agent activity.
    if (isHumanRoomActivityEvent(event)) {
      // Ephemeral live feed first (in-memory, non-blocking): the focused
      // inspector sees reasoning/text/tool events token-by-token without the
      // durable journal's coalescing or 200-event cap.
      if (isAgentInspectorLiveDisplayEvent(event)) {
        this.pushAgentStreamEvent(entryId, sanitizedEvent);
      }
      await this.appendActivity(entryId, sanitizedEvent);
    }
    const waitEvidence = supervisedWaitEvidenceFromProviderEvent(event);
    if (waitEvidence) {
      const pending = this.pendingResumeBindings.get(entryId);
      if (pending && waitEvidence.agentSessionId === pending.agentSessionId) {
        try {
          await this.serializeEntryTick(entryId, () => this.restoreWorkerBindingFromWait(entryId, waitEvidence));
        } catch (error) {
          await this.serializeEntryTick(entryId, () => this.transition(
            entryId,
            "recovering",
            "coordination_blocked",
            `resumed provider credential verification failed: ${error instanceof Error ? error.message : "unknown credential verification failure"}`,
            "daemon-provider-stream",
          ));
          return;
        }
      }
      if (!this.pendingResumeBindings.has(entryId)) {
        await this.checkpointObservedWaitCursor(entry, waitEvidence.roomCursor, waitEvidence.agentSessionId);
      }
    }
    if (lifecycle === "failed" && entry.observed_state !== "failed") {
      await this.transition(entryId, "failed", entry.condition, `provider stream terminal failure: ${sanitizedEvent.method}`, "daemon-provider-stream");
    }
    const liveBinding = this.liveBindingIdentities.get(entryId);
    if (liveBinding?.executionGenerationId === entry.provider_ref?.execution_generation_id) {
      await this.publishNativeActivity(entryId, sanitizedEvent.method, lifecycle === "working" && !quietlyPolling ? "working" : "idle", event.observedAt).catch(() => undefined);
    }
    if (legacyCodexCutover && observedLifecycle === "terminal") {
      // The exact control adapter will checkpoint this now-terminal legacy
      // turn and atomically hand ingress to daemon_inbox without replacing
      // the PID, thread, continuation, work attempt, or generation.
      void this.startDeliveryCutover(entryId).catch(() => undefined);
    }
    if ((lifecycle === "failed" || lifecycle === "terminal")
      && this.liveHandles.get(entryId) === handle
      && !["stopping", "stopped"].includes(handle.observedState)) {
      try {
        // A persistent polling turn ending (successfully or with a native
        // terminal error) means delivery ended. Fence that native process so
        // the terminal callback can mint a bounded resume generation.
        await this.fenceTerminalProviderHandleOnce(
          handle,
          `manifest:${entryId}:terminal-turn:${event.sequence}`,
        );
      } catch (error) {
        await this.transition(
          entryId,
          "failed",
          "coordination_blocked",
          `failed to fence terminal provider turn: ${error instanceof Error ? error.message : "unknown error"}`,
          "daemon-provider-stream",
        );
      }
    }
  }

  private async checkpointObservedWaitCursor(entry: DaemonManifestEntry, roomCursor: string, agentSessionId: string): Promise<void> {
    await this.serializeCursorCheckpoint(entry.id, async () => {
      const executionGenerationId = entry.provider_ref?.execution_generation_id;
      if (!entry.work_attempt_id || !executionGenerationId) return;
      const currentEntry = (await this.store.load()).entries.find((candidate) => candidate.id === entry.id);
      if (!currentEntry
        || currentEntry.room_id !== entry.room_id
        || currentEntry.work_attempt_id !== entry.work_attempt_id
        || currentEntry.provider_ref?.execution_generation_id !== executionGenerationId) return;
      const binding = await this.workerBindings.get(entry.id);
      if (!binding
        || binding.entry_id !== entry.id
        || binding.room_id !== entry.room_id
        || binding.work_attempt_id !== entry.work_attempt_id
        || binding.agent_session_id !== agentSessionId
        || binding.execution_generation_id !== executionGenerationId) return;
      const checkpoint = await this.workerBindings.checkpointCursorMonotonic(
        entry.id,
        binding.agent_session_id,
        executionGenerationId,
        roomCursor,
      );
      const durableAttempt = await this.durability.getAttempt(entry.work_attempt_id);
      const durableCursor = checkpoint.binding.room_cursor;
      if (!durableCursor || (!checkpoint.advanced && durableAttempt.checkpoints.at(-1)?.room_cursor === durableCursor)) return;
      await this.durability.checkpoint(entry.work_attempt_id, {
        room_cursor: durableCursor,
        provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
      });
    });
  }

  private enqueueProviderStream(entryId: string, handle: ProviderActionHandle, event: ProviderActionStreamEvent): Promise<void> {
    const previous = this.providerStreamQueues.get(entryId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.handleProviderStream(entryId, handle, event)).finally(() => {
      if (this.providerStreamQueues.get(entryId) === next) this.providerStreamQueues.delete(entryId);
    });
    this.providerStreamQueues.set(entryId, next);
    return next;
  }

  private serializeCursorCheckpoint<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.cursorCheckpointQueues.get(entryId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined).finally(() => {
      if (this.cursorCheckpointQueues.get(entryId) === tail) this.cursorCheckpointQueues.delete(entryId);
    });
    this.cursorCheckpointQueues.set(entryId, tail);
    return result;
  }

  private fenceTerminalProviderHandleOnce(handle: ProviderActionHandle, actionId: string): Promise<void> {
    const existing = this.terminalFenceRequests.get(handle);
    if (existing) return existing;
    const operation = this.providerPort!
      .stop(handle, { actionId })
      .then(() => undefined);
    this.terminalFenceRequests.set(handle, operation);
    return operation;
  }

  private scheduleRecoveryConvergence(entryId: string, delayMs: number): void {
    if (this.recoveryTimers.has(entryId)) return;
    const timer = this.setRecoveryTimeout(() => {
      this.recoveryTimers.delete(entryId);
      this.requestConvergence(entryId);
    }, Math.max(1, delayMs));
    timer.unref?.();
    this.recoveryTimers.set(entryId, timer);
  }

  private clearRecoveryConvergence(entryId: string): void {
    const timer = this.recoveryTimers.get(entryId);
    if (!timer) return;
    this.clearRecoveryTimeout(timer);
    this.recoveryTimers.delete(entryId);
  }

  private async bindWorkerSession(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; credential_ref?: string; api_url: string }): Promise<{ bound: true; entry_id: string; agent_session_id: string }> {
    return this.serializeEntryTick(input.entry_id, () => this.bindWorkerSessionLocked(input));
  }

  private async bindWorkerSessionLocked(
    input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; credential_ref?: string; api_url: string },
    mayPublish: () => boolean = () => true,
  ): Promise<{ bound: true; entry_id: string; agent_session_id: string }> {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
    if (entry.room_id !== input.room_id) throw new Error("Worker session room does not match the supervised manifest entry.");
    if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker session work attempt does not match the supervised manifest entry.");
    if (entry.provider_ref?.execution_generation_id !== input.execution_generation_id) {
      throw new Error("Worker session execution generation does not match the active supervised manifest entry.");
    }
    const attempt = await this.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) throw new Error("Worker session execution generation is absent or terminal.");
    const currentBinding = await this.workerBindings.get(input.entry_id);
    const currentCredential = currentBinding
      ? await this.workerBindings.credentialFor(currentBinding)
      : null;
    const normalizedApiUrl = new URL(input.api_url).origin;
    const exactCurrentBinding = Boolean(currentBinding
      && currentBinding.entry_id === input.entry_id
      && currentBinding.room_id === input.room_id
      && currentBinding.work_attempt_id === input.work_attempt_id
      && currentBinding.execution_generation_id === input.execution_generation_id
      && currentBinding.agent_session_id === input.agent_session_id
      && currentCredential === input.agent_session_token
      && currentBinding.api_url === normalizedApiUrl);
    const binding = exactCurrentBinding && currentBinding
      ? currentBinding
      : await this.workerBindings.bind(input);
    this.liveBindingIdentities.set(input.entry_id, {
      agentSessionId: binding.agent_session_id,
      executionGenerationId: binding.execution_generation_id,
      updatedAt: binding.updated_at,
    });
    this.pendingResumeBindings.delete(input.entry_id);
    // The native-activity publication is part of restoring room access: a
    // server that rejects the bound observation proves the room is NOT
    // reachable yet. Verify it before clearing the bounded recovery ledger
    // and before projecting the entry as working, so a deterministic remote
    // rejection exhausts its bounded retries instead of resetting the count
    // (and flickering working/recovering) on every convergence cycle.
    if (mayPublish() && (!exactCurrentBinding || entry.workplace_liveness?.state !== "reachable")) {
      await this.publishNativeActivity(input.entry_id, "native_harness.bound", "working");
    }
    this.workerBindingRecoveryAttempts.delete(input.entry_id);
    this.workerMintRecoveryRetryAttempts.delete(input.entry_id);
    this.clearRecoveryConvergence(input.entry_id);
    await this.updateManifestEntry(input.entry_id, (current) => {
      const clearsCoordinationLatch = current.desired_state === "running"
        && (current.condition === "coordination_blocked" || current.condition === "auth_blocked");
      const manifestBindingIsCurrent = current.last_worker_binding?.agent_session_id === binding.agent_session_id
        && current.last_worker_binding?.work_attempt_id === binding.work_attempt_id
        && current.last_worker_binding?.execution_generation_id === binding.execution_generation_id;
      if (current.workplace_liveness?.state === "reachable"
        && !clearsCoordinationLatch
        && manifestBindingIsCurrent) return current;
      return {
        ...current,
        // A successful exact-generation bind proves that an ambiguous live
        // provider has its MCP control route. Restore workplace reachability on
        // fresh and persisted-idempotent binds; clear only the coordination
        // latch, while quarantine and native terminal failures stay authoritative.
        workplace_liveness: {
          state: "reachable" as const,
          observed_at: new Date().toISOString(),
          detail: exactCurrentBinding
            ? "exact supervised worker session binding confirmed"
            : "supervised worker session bound",
        },
        ...(clearsCoordinationLatch
          ? {
            observed_state: "working" as const,
            condition: "none" as const,
            last_error: null,
          }
          : {}),
        // Durable set-once ready stamp: this bind restores reachability, so the
        // entry is ready when it is running + unblocked + live.
        ready_reached_at: resolveReadyReachedAt(current, clearsCoordinationLatch, new Date().toISOString()),
        last_worker_binding: {
          agent_session_id: binding.agent_session_id,
          work_attempt_id: binding.work_attempt_id,
          execution_generation_id: binding.execution_generation_id,
          updated_at: binding.updated_at,
        },
      };
    });
    if (mayPublish()) void this.startSupervisedDelivery(input.entry_id).catch(() => undefined);
    return { bound: true, entry_id: input.entry_id, agent_session_id: input.agent_session_id };
  }

  private requiresHostGrant(entry: DaemonManifestEntry): boolean {
    return entry.delivery_mode === "daemon_inbox";
  }

  private currentHostGrant(entry: DaemonManifestEntry): InstalledHostGrant | null {
    const grant = this.hostGrants.get(entry.id);
    if (!grant || this.handoffScheduled || grant.daemonGeneration !== this.singleton.currentGeneration
      || grant.entryId !== entry.id || grant.roomId !== entry.room_id) return null;
    return grant;
  }

  private hostGrantNeedsRenewal(grant: InstalledHostGrant): boolean {
    const expiresAt = Date.parse(grant.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= this.nowMs() + HOST_GRANT_RENEWAL_LEAD_MS;
  }

  private async blockHostGrantAuthority(entry: DaemonManifestEntry, grant: InstalledHostGrant, detail: string): Promise<void> {
    this.revokeHostGrantIfCurrent(entry.id, grant);
    this.cachedWorkerAuthorizations.delete(entry.id);
    await this.supervisedDelivery?.stop(entry.id).catch(() => undefined);
    const binding = await this.workerBindings.get(entry.id);
    if (binding) await this.workerBindings.unbind(entry.id, binding.agent_session_id, binding.execution_generation_id);
    this.liveBindingIdentities.delete(entry.id);
    await this.updateManifestEntry(entry.id, (current) => ({
      ...current,
      observed_state: current.desired_state === "running" ? "recovering" : current.observed_state,
      condition: "auth_blocked",
      last_error: redactCredentialText(detail).value,
      workplace_liveness: {
        state: "stale",
        observed_at: new Date(this.nowMs()).toISOString(),
        detail: "Supervisor host authority is unavailable; room delivery is paused.",
      },
    }));
  }

  private async blockExpiredWorkerAuthority(entry: DaemonManifestEntry, detail: string): Promise<void> {
    this.cachedWorkerAuthorizations.delete(entry.id);
    await this.supervisedDelivery?.stop(entry.id).catch(() => undefined);
    const binding = await this.workerBindings.get(entry.id);
    if (binding) await this.workerBindings.unbind(entry.id, binding.agent_session_id, binding.execution_generation_id);
    await this.updateManifestEntry(entry.id, (current) => ({
      ...current,
      observed_state: current.desired_state === "running" ? "recovering" : current.observed_state,
      condition: "auth_blocked",
      last_error: redactCredentialText(detail).value,
      workplace_liveness: {
        state: "stale", observed_at: new Date(this.nowMs()).toISOString(),
        detail: "The worker bearer expired before rotation succeeded; room delivery is paused.",
      },
    }));
    this.scheduleRecoveryConvergence(entry.id, this.nativeHeartbeatIntervalMs);
  }

  /** Renew in memory only and rotate the live worker bearer in place. */
  private async ensureHostGrantFresh(entry: DaemonManifestEntry): Promise<InstalledHostGrant | null> {
    const grant = this.currentHostGrant(entry);
    if (!grant) return null;
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.nowMs()) {
      await this.blockHostGrantAuthority(entry, grant, "Supervisor host grant expired; waiting for Electron owner recovery.");
      return null;
    }
    if (!this.hostGrantNeedsRenewal(grant)) return grant;
    try {
      if (!this.supervisorGrantHttp.renewHostGrant) throw new Error("Supervisor host grant renewal is unavailable.");
      const renewed = await this.supervisorGrantHttp.renewHostGrant({
        apiUrl: grant.apiUrl, grantId: grant.grantId, supervisorGrant: grant.supervisorGrant,
        grantGeneration: grant.grantGeneration, hostId: grant.hostId,
        installationId: grant.installationId, ttlMs: HOST_GRANT_TTL_MS,
      });
      const renewedExpiry = Date.parse(renewed.expiresAt);
      if (renewed.grantId !== grant.grantId || renewed.grantGeneration !== grant.grantGeneration
        || !renewed.supervisorGrant.trim() || !Number.isFinite(renewedExpiry) || renewedExpiry <= this.nowMs()) {
        throw new InvalidSupervisorGrantRenewalError("Supervisor host grant renewal returned a stale fence.");
      }
      if (!await this.ownsDaemonGeneration(grant.daemonGeneration) || this.hostGrants.get(entry.id) !== grant) return null;
      const replacement: InstalledHostGrant = {
        ...grant, supervisorGrant: renewed.supervisorGrant, expiresAt: renewed.expiresAt,
      };
      this.hostGrants.set(entry.id, replacement);
      const current = await this.store.getEntry(entry.id);
      if (current?.provider_ref?.execution_generation_id && this.liveHandles.get(entry.id)) {
        try {
          const minted = await this.mintHostWorkerSession(current, current.provider_ref.execution_generation_id);
          if (!minted) throw new Error("Renewed host grant could not rotate the live worker bearer.");
          await this.bindMintedHostWorkerSession(entry.id, minted);
        } catch (error) {
          if (error instanceof SupervisorGrantRequestError && [401, 403, 409].includes(error.status)) throw error;
          // The renewed parent grant is valid and stays memory-only. Preserve
          // the still-live worker bearer and let its heartbeat retry rotation;
          // a transient child-session transport failure must not force owner
          // recovery or disturb the provider.
        }
      }
      return replacement;
    } catch (error) {
      const active = this.hostGrants.get(entry.id);
      const definitiveRejection = error instanceof InvalidSupervisorGrantRenewalError
        || (error instanceof SupervisorGrantRequestError && [401, 403, 409].includes(error.status));
      if (definitiveRejection && active && active.grantId === grant.grantId && active.daemonGeneration === grant.daemonGeneration) {
        await this.blockHostGrantAuthority(
          entry,
          active,
          `Supervisor host grant renewal failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return null;
      }
      if (active && Date.parse(active.expiresAt) <= this.nowMs()) {
        await this.blockHostGrantAuthority(
          entry,
          active,
          `Supervisor host grant expired while renewal was pending: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return null;
      }
      // Transport and 5xx failures do not revoke a still-valid parent grant
      // or its worker bearer. Retry in the background and let the actual
      // parent/bearer deadlines decide when delivery becomes auth_blocked.
      this.scheduleRecoveryConvergence(entry.id, this.nativeHeartbeatIntervalMs);
      return this.currentHostGrant(entry);
    }
  }

  private async hostWorkerBearerNeedsRotation(entry: DaemonManifestEntry, binding: WorkerSessionBinding): Promise<boolean> {
    const session = await this.workerBindings.supervisedWorkerSession(entry.id);
    if (!session
      || session.room_id !== entry.room_id
      || session.agent_session_id !== binding.agent_session_id
      || session.execution_generation_id !== binding.execution_generation_id) return false;
    // Public metadata is committed before the private vault rebind. If the
    // latter fails, the mismatch makes the next heartbeat remint instead of
    // silently retaining the old credential forever.
    if (session.credential_ref !== binding.credential_ref) return true;
    if (!session.expires_at) return false;
    const expiresAt = Date.parse(session.expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= this.nowMs() + WORKER_BEARER_ROTATION_LEAD_MS;
  }

  private async ownsDaemonGeneration(expectedGeneration: number): Promise<boolean> {
    if (this.handoffScheduled) {
      this.hostGrants.clear();
      this.openModelCredentials.clear();
      this.cachedWorkerAuthorizations.clear();
      return false;
    }
    if (expectedGeneration !== this.singleton.currentGeneration) return false;
    try {
      await this.singleton.assertCurrent();
      if (this.handoffScheduled) {
        this.hostGrants.clear();
        this.openModelCredentials.clear();
        this.cachedWorkerAuthorizations.clear();
        return false;
      }
      return expectedGeneration === this.singleton.currentGeneration;
    } catch {
      // A successor acquired the singleton without this process completing its
      // normal handoff path. Drop every process-memory credential immediately.
      this.hostGrants.clear();
      this.openModelCredentials.clear();
      this.cachedWorkerAuthorizations.clear();
      return false;
    }
  }

  private revokeHostGrantIfCurrent(entryId: string, grant: InstalledHostGrant): void {
    if (this.hostGrants.get(entryId) === grant) {
      this.hostGrants.delete(entryId);
      this.openModelCredentials.delete(entryId);
      this.cachedWorkerAuthorizations.delete(entryId);
    }
  }

  private cachedWorkerAuthorization(entry: DaemonManifestEntry, grant: InstalledHostGrant): CachedWorkerAuthorization | null {
    const cached = this.cachedWorkerAuthorizations.get(entry.id);
    if (!cached) return null;
    const expiresAt = cached.expiresAt ? Date.parse(cached.expiresAt) : Number.NaN;
    const fresh = Number.isFinite(expiresAt)
      ? expiresAt > this.nowMs() + WORKER_BEARER_ROTATION_LEAD_MS
      : cached.mintedAtMs + WORKER_MINT_FALLBACK_FRESH_MS > this.nowMs();
    const exact = cached.entryId === entry.id
      && cached.roomId === entry.room_id
      && cached.agentKey === grant.agentKey
      && cached.grantId === grant.grantId
      && cached.grantGeneration === grant.grantGeneration
      && cached.daemonGeneration === grant.daemonGeneration
      && cached.apiUrl === grant.apiUrl;
    if (!fresh || !exact) {
      this.cachedWorkerAuthorizations.delete(entry.id);
      return null;
    }
    // Bootstrap necessarily mints before ensureWorkAttempt. The first launch
    // claims that one-use pre-attempt credential into its newly durable attempt;
    // subsequent use is fenced to that exact attempt.
    if (cached.workAttemptId === null && entry.work_attempt_id) cached.workAttemptId = entry.work_attempt_id;
    if (cached.workAttemptId !== entry.work_attempt_id) {
      this.cachedWorkerAuthorizations.delete(entry.id);
      return null;
    }
    return cached;
  }

  private async mintWorkerSessionWithRetry(entry: DaemonManifestEntry, grant: InstalledHostGrant, signal?: AbortSignal): Promise<Awaited<ReturnType<SupervisorGrantHttp["createWorkerSession"]>>> {
    let lastError: unknown = null;
    let attempts = 0;
    let lastRetryable = false;
    const agentInstanceId = `daemon:${entry.id}`;
    if (signal?.aborted) throw new Error("Worker credential mint was cancelled.");
    // Commit uncertainty before the first byte of the remote POST can leave
    // this process. A crash or lost response can now only resolve to unknown,
    // never to the stale never-minted proof.
    await this.workerBindings.beginSupervisedWorkerSessionMint({
      agent_id: entry.id,
      room_id: entry.room_id,
      agent_instance_id: agentInstanceId,
    });
    for (let attempt = 1; attempt <= WORKER_MINT_MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw new Error("Worker credential mint was cancelled.");
      attempts = attempt;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let timeoutReject!: (error: Error) => void;
      const timedOut = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
      const timeout = this.setRecoveryTimeout(() => {
        controller.abort();
        timeoutReject(new Error(`Worker credential mint timed out after ${WORKER_MINT_TIMEOUT_MS}ms.`));
      }, WORKER_MINT_TIMEOUT_MS);
      timeout.unref();
      try {
        const request = (async () => {
          const minted = await this.supervisorGrantHttp.createWorkerSession({
            apiUrl: grant.apiUrl, grantId: grant.grantId, supervisorGrant: grant.supervisorGrant,
            grantGeneration: grant.grantGeneration, roomId: grant.roomId, agentKey: grant.agentKey,
            agentInstanceId, provider: entry.provider,
            displayName: entry.display_name, signal: controller.signal,
          });
          // The server serializes this stable agent-instance tuple and reuses
          // its live session id. Persist that exact public id before the
          // returned bearer is cached or coupled to a provider generation.
          await this.workerBindings.recordExactSupervisedWorkerSessionMint({
            agent_id: entry.id,
            room_id: entry.room_id,
            agent_instance_id: agentInstanceId,
            agent_session_id: minted.sessionId,
          });
          return minted;
        })();
        return await Promise.race([request, timedOut]);
      } catch (error) {
        lastError = error;
        const retryable = retryableWorkerMintFailure(error);
        lastRetryable = retryable && !signal?.aborted;
        if (!retryable || signal?.aborted || attempt === WORKER_MINT_MAX_ATTEMPTS) break;
        await new Promise<void>((resolve) => this.setRecoveryTimeout(resolve, WORKER_MINT_RETRY_DELAY_MS));
      } finally {
        this.clearRecoveryTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    }
    throw new WorkerCredentialMintError(attempts, lastRetryable, lastError);
  }

  /** Remote authorization happens before starting a durable provider generation. */
  private async mintHostWorkerAuthorization(entry: DaemonManifestEntry, signal?: AbortSignal, forceFresh = false): Promise<{
    agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; apiUrl: string;
  } | null> {
    const grant = this.currentHostGrant(entry);
    if (!grant) return null;
    if (!await this.ownsDaemonGeneration(grant.daemonGeneration) || this.hostGrants.get(entry.id) !== grant) {
      this.revokeHostGrantIfCurrent(entry.id, grant);
      return null;
    }
    const cached = forceFresh ? null : this.cachedWorkerAuthorization(entry, grant);
    if (cached) return {
      agentSessionId: cached.agentSessionId, bearer: cached.bearer, bearerId: cached.bearerId,
      expiresAt: cached.expiresAt, apiUrl: cached.apiUrl,
    };
    const minted = await this.mintWorkerSessionWithRetry(entry, grant, signal);
    if (!await this.ownsDaemonGeneration(grant.daemonGeneration) || this.hostGrants.get(entry.id) !== grant) {
      this.revokeHostGrantIfCurrent(entry.id, grant);
      return null;
    }
    const current = await this.store.getEntry(entry.id);
    if (!current || current.work_attempt_id !== entry.work_attempt_id || this.currentHostGrant(current) !== grant) return null;
    this.cachedWorkerAuthorizations.set(entry.id, {
      entryId: entry.id, roomId: entry.room_id, agentKey: grant.agentKey,
      workAttemptId: entry.work_attempt_id ?? null, grantId: grant.grantId, grantGeneration: grant.grantGeneration,
      daemonGeneration: grant.daemonGeneration, apiUrl: grant.apiUrl, agentSessionId: minted.sessionId,
      bearer: minted.bearer, bearerId: minted.bearerId, expiresAt: minted.expiresAt, mintedAtMs: this.nowMs(),
    });
    return { agentSessionId: minted.sessionId, bearer: minted.bearer, bearerId: minted.bearerId, expiresAt: minted.expiresAt, apiUrl: grant.apiUrl };
  }

  /** Bind public session metadata to the exact generation after it exists. */
  private async recordMintedHostWorkerSession(entry: DaemonManifestEntry, executionGenerationId: string, minted: {
    agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; apiUrl: string;
  }): Promise<{
    agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; apiUrl: string; executionGenerationId: string;
  } | null> {
    const grant = this.currentHostGrant(entry);
    if (!grant || !entry.work_attempt_id || !await this.ownsDaemonGeneration(grant.daemonGeneration)) return null;
    const current = await this.store.getEntry(entry.id);
    if (!current || !this.currentHostGrant(current)
      || current.work_attempt_id !== entry.work_attempt_id) return null;
    const attempt = await this.durability.getAttempt(entry.work_attempt_id);
    if (!attempt.execution_generations.some((candidate) => candidate.execution_generation_id === executionGenerationId && !candidate.terminal)) return null;
    await this.workerBindings.recordSupervisedWorkerSession({
      agent_id: entry.id, room_id: entry.room_id, agent_session_id: minted.agentSessionId,
      execution_generation_id: executionGenerationId, credential_ref: minted.bearerId, expires_at: minted.expiresAt,
    });
    if (!await this.ownsDaemonGeneration(grant.daemonGeneration) || this.hostGrants.get(entry.id) !== grant) {
      this.revokeHostGrantIfCurrent(entry.id, grant);
      return null;
    }
    return { ...minted, executionGenerationId };
  }

  private async mintHostWorkerSession(entry: DaemonManifestEntry, executionGenerationId: string, forceFresh = false): Promise<{
    agentSessionId: string; bearer: string; bearerId: string; expiresAt: string | null; apiUrl: string; executionGenerationId: string;
  } | null> {
    const minted = await this.mintHostWorkerAuthorization(entry, undefined, forceFresh);
    return minted ? this.recordMintedHostWorkerSession(entry, executionGenerationId, minted) : null;
  }

  /** Provider identity has already been persisted when this binds the raw bearer. */
  private async bindMintedHostWorkerSession(entryId: string, session: {
    agentSessionId: string; bearer: string; bearerId: string; apiUrl: string; executionGenerationId: string;
  }, mayPublish: () => boolean = () => true): Promise<void> {
    const entry = await this.store.getEntry(entryId);
    if (!entry || !entry.work_attempt_id || !entry.provider_ref || entry.provider_ref.execution_generation_id !== session.executionGenerationId || !this.currentHostGrant(entry)) return;
    await this.bindWorkerSessionLocked({
      entry_id: entry.id, room_id: entry.room_id, work_attempt_id: entry.work_attempt_id,
      execution_generation_id: session.executionGenerationId, agent_session_id: session.agentSessionId,
      agent_session_token: session.bearer, credential_ref: session.bearerId, api_url: session.apiUrl,
    }, mayPublish);
  }

  /**
   * A provider that already crossed the durable native boundary must never be
   * restarted merely because its room credential could not be bound. Retry
   * only that exact generation, expose the real safe error, and stop after a
   * bounded number of attempts so the user eventually receives an action.
   */
  private async recordWorkerBindingRecoveryFailure(
    entryId: string,
    executionGenerationId: string,
    error: unknown,
  ): Promise<void> {
    const entry = await this.store.getEntry(entryId);
    const handle = this.liveHandles.get(entryId);
    if (!entry
      || entry.desired_state !== "running"
      || entry.provider_ref?.execution_generation_id !== executionGenerationId
      || !handle
      || handle.workAttemptId !== entry.work_attempt_id
      || handle.providerContinuationId !== entry.provider_ref.provider_continuation_id) return;

    const previous = this.workerBindingRecoveryAttempts.get(entryId);
    const attempts = previous?.executionGenerationId === executionGenerationId
      ? previous.attempts + 1
      : 1;
    this.workerBindingRecoveryAttempts.set(entryId, { executionGenerationId, attempts });
    const safeError = schedulerErrorDetail(error);
    const retrying = attempts < WORKER_BIND_MAX_ATTEMPTS;
    const detail = retrying
      ? `Restoring room access (attempt ${attempts} of ${WORKER_BIND_MAX_ATTEMPTS}) failed: ${safeError}. Retrying automatically.`
      : `The provider is running, but room access could not be restored after ${WORKER_BIND_MAX_ATTEMPTS} attempts: ${safeError}. Use Reconnect to try the room handoff again.`;
    await this.transition(
      entryId,
      "recovering",
      "coordination_blocked",
      detail,
      "daemon-convergence",
    );
    if (retrying) {
      this.clearRecoveryConvergence(entryId);
      this.scheduleRecoveryConvergence(
        entryId,
        WORKER_BIND_RETRY_DELAYS_MS[Math.min(attempts - 1, WORKER_BIND_RETRY_DELAYS_MS.length - 1)]!,
      );
    }
  }

  /** Desktop-only local RPC. Provider endpoint authority remains process-memory-only. */
  private async installOpenModelCredential(input: {
    entry_id: string;
    api_key: string | null;
    base_url: string;
    model: string;
    daemon_generation: number;
  }): Promise<{ status: "installed" | "stale" }> {
    if (!input.entry_id.trim() || !input.base_url.trim() || !input.model.trim()) {
      throw new Error("Open Model credential handoff requires an entry, endpoint, and model.");
    }
    if (input.api_key !== null && !input.api_key.trim()) {
      throw new Error("Open Model API key must be non-empty or null.");
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(input.base_url);
    } catch {
      throw new Error("Open Model credential handoff contains an invalid endpoint.");
    }
    if (!["http:", "https:"].includes(baseUrl.protocol)
      || baseUrl.username
      || baseUrl.password
      || baseUrl.hash) {
      throw new Error("Open Model credential handoff contains an unsafe endpoint.");
    }
    if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
    const entry = await this.store.getEntry(input.entry_id);
    if (!entry || entry.provider !== "open-model") return { status: "stale" };
    if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
    this.openModelCredentials.set(entry.id, {
      entryId: entry.id,
      apiKey: input.api_key,
      baseUrl: input.base_url.replace(/\/+$/, ""),
      model: input.model.trim(),
      daemonGeneration: input.daemon_generation,
    });
    return { status: "installed" };
  }

  /** Desktop-only local RPC. The host grant itself is never copied to SQLite, activity, or manifests. */
  private async installHostGrant(input: {
    entry_id: string; room_id: string; agent_key: string; grant_id: string; supervisor_grant: string;
    grant_generation: number; api_url: string; daemon_generation: number;
    host_id: string; installation_id: string; grant_expires_at: string; credential_only?: boolean;
    recovery_only?: boolean;
  }): Promise<{ status: "installed" | "stale" | "provider_unavailable"; agent_session_id?: string }> {
    return this.serializeEntryTick(input.entry_id, async () => {
      if (input.credential_only && input.recovery_only) {
        throw new Error("Host grant installation cannot be both reconnect-only and recovery-only.");
      }
      for (const field of ["entry_id", "room_id", "agent_key", "grant_id", "supervisor_grant", "api_url", "host_id", "installation_id", "grant_expires_at"] as const) {
        if (!input[field].trim()) throw new Error(`Host grant ${field} is required.`);
      }
      if (!Number.isSafeInteger(input.grant_generation) || input.grant_generation < 1
        || !await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
      const inputExpiry = Date.parse(input.grant_expires_at);
      if (!Number.isFinite(inputExpiry) || inputExpiry <= this.nowMs()) return { status: "stale" };
      let apiUrl: string;
      try { apiUrl = hostGrantApiOrigin(input.api_url); } catch { throw new Error("Host grant api_url must be HTTPS or exact loopback HTTP."); }
      let entry = await this.store.getEntry(input.entry_id);
      if (!entry || !this.requiresHostGrant(entry) || entry.room_id !== input.room_id) return { status: "stale" };
      if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
      const currentGrant = this.currentHostGrant(entry);
      const currentGrantIsAtLeastInput = Boolean(currentGrant?.grantId === input.grant_id
        && (currentGrant.grantGeneration > input.grant_generation
          || (currentGrant.grantGeneration === input.grant_generation
            && Date.parse(currentGrant.expiresAt) >= inputExpiry)));
      if (currentGrantIsAtLeastInput && currentGrant && !input.credential_only && !input.recovery_only) {
        // Electron may still hold the pre-renewal safeStorage value. It may
        // confirm installation, but must never roll the daemon's newer
        // memory-only token/expiry backwards in the same generation.
        // A cursorless daemon-inbox entry is waiting for Electron's separate
        // admission RPC. Do not queue provider work in the gap between this
        // grant install and the durable first-tail boundary.
        if (entry.desired_state === "running"
          && (!this.requiresHostGrant(entry) || await this.supervisedInbox.cursor(entry.id))) {
          this.requestConvergence(entry.id);
        }
        return { status: "installed" };
      }
      // Credential-only reconnect is a rebind request, not a credential
      // update. Electron can legitimately still have a pre-renewal encrypted
      // copy, so retain and mint through the daemon's newer memory-only grant.
      const grant: InstalledHostGrant = currentGrantIsAtLeastInput && currentGrant ? currentGrant : {
        entryId: entry.id, roomId: entry.room_id, agentKey: input.agent_key, grantId: input.grant_id,
        supervisorGrant: input.supervisor_grant, grantGeneration: input.grant_generation, apiUrl,
        daemonGeneration: input.daemon_generation, hostId: input.host_id,
        installationId: input.installation_id, expiresAt: input.grant_expires_at,
      };
      // Compare the *effective* grant after stale-install resolution. A stale
      // Electron resend deliberately retains the daemon's newer grant and its
      // cache; an actual grant id/generation replacement cannot reuse it.
      if (currentGrant && (currentGrant.grantId !== grant.grantId
        || currentGrant.grantGeneration !== grant.grantGeneration)) {
        this.cachedWorkerAuthorizations.delete(entry.id);
      }
      // Explicit runtime recovery needs current owner authority so it can end
      // the retained worker session before replacing a proven-dead provider.
      // Installing that authority must not attach, mint, start delivery, or
      // request convergence against the old runtime.
      if (input.recovery_only) {
        if (this.hostGrants.get(entry.id) !== grant) this.hostGrants.set(entry.id, grant);
        return { status: "installed" };
      }
      // Recovery must not signal, restart, or migrate a live provider. It only
      // rotates the worker bearer against the persisted exact generation.
      let live: ProviderActionHandle | null | undefined = this.liveHandles.get(entry.id);
      let hasExactLiveProvider = Boolean(entry.provider_ref && entry.work_attempt_id && live
        && live.workAttemptId === entry.work_attempt_id
        && live.providerContinuationId === entry.provider_ref.provider_continuation_id);
      if (input.credential_only && !hasExactLiveProvider && entry.provider_ref) {
        live = await this.attachLiveProvider(entry, () => false);
        entry = await this.store.getEntry(input.entry_id);
        if (!entry) return { status: "stale" };
        hasExactLiveProvider = Boolean(entry.provider_ref && entry.work_attempt_id && live
          && live.workAttemptId === entry.work_attempt_id
          && live.providerContinuationId === entry.provider_ref.provider_continuation_id);
      }
      if (input.credential_only && !hasExactLiveProvider) {
        // Do not retain a new reconnect grant when there is nothing exact to
        // bind it to. A later unrelated reconciliation must not turn this
        // rejected reconnect into a launch.
        return { status: "provider_unavailable" };
      }
      if (this.hostGrants.get(entry.id) !== grant) this.hostGrants.set(entry.id, grant);
      if (hasExactLiveProvider && entry.provider_ref && entry.work_attempt_id && live) {
        const attempt = await this.durability.getAttempt(entry.work_attempt_id);
        if (!await this.ownsDaemonGeneration(input.daemon_generation) || this.hostGrants.get(entry.id) !== grant) {
          this.revokeHostGrantIfCurrent(entry.id, grant);
          return { status: "stale" };
        }
        const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === entry.provider_ref!.execution_generation_id);
        if (execution && !execution.terminal) {
          const minted = await this.mintHostWorkerSession(entry, execution.execution_generation_id, input.credential_only === true);
          if (minted) {
            await this.bindMintedHostWorkerSession(entry.id, minted);
            if (!await this.ownsDaemonGeneration(input.daemon_generation) || this.hostGrants.get(entry.id) !== grant) {
              this.revokeHostGrantIfCurrent(entry.id, grant);
              return { status: "stale" };
            }
            if (input.credential_only) await this.startSupervisedDelivery(entry.id);
            return { status: "installed", agent_session_id: minted.agentSessionId };
          }
        }
      }
      if (input.credential_only) {
        // Reconnect is deliberately not recovery. It may rebind an exact live
        // provider generation, but it must never request convergence, resume,
        // spawn, stop, signal, or alter desired state when that handle is gone.
        // A pre-existing newer grant remains valid even though this exact
        // provider could not be rebound; only discard a newly supplied input.
        if (grant !== currentGrant) this.revokeHostGrantIfCurrent(entry.id, grant);
        return { status: "provider_unavailable" };
      }
      if (!await this.ownsDaemonGeneration(input.daemon_generation) || this.hostGrants.get(entry.id) !== grant) {
        this.revokeHostGrantIfCurrent(entry.id, grant);
        return { status: "stale" };
      }
      // For daemon-inbox entries, bootstrapRoomIngress is the only path that
      // may queue a running convergence after the first cursor exists. A
      // stopped entry never queues lifecycle work merely because its host
      // grant was repaired.
      if (entry.desired_state === "running"
        && (!this.requiresHostGrant(entry) || await this.supervisedInbox.cursor(entry.id))) {
        this.requestConvergence(entry.id);
      }
      return { status: "installed" };
    });
  }

  /**
   * Establish the first daemon-inbox cursor. Fresh entries call this while
   * paused, before provider start/reachability. Upgrade recovery may call it
   * for an already-running or stopped entry that predates cursor admission.
   * It observes the current tail and durably records that boundary before any
   * running convergence is queued. Stopped entries remain stopped. The cursor
   * remains durable even if this generation loses authority after the HTTP
   * read, so a successor resumes this exact boundary instead of reading a
   * newer tail and skipping the intervening message.
   */
  private async bootstrapRoomIngress(input: { entry_id: string; daemon_generation: number }, operation: BootstrapOperation): Promise<{ status: "bootstrapped" | "existing" | "stale"; last_observed_message_id: string | null }> {
    return this.serializeEntryTick(input.entry_id, async () => {
      if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale", last_observed_message_id: null };
      const entry = await this.store.getEntry(input.entry_id);
      if (!entry || !this.requiresHostGrant(entry)) return { status: "stale", last_observed_message_id: null };
      const existing = await this.supervisedInbox.cursor(entry.id);
      if (existing) {
        await this.requestAdmittedRunningConvergence(entry.id, input.daemon_generation);
        return { status: "existing", last_observed_message_id: existing.last_observed_message_id };
      }
      const grant = this.currentHostGrant(entry);
      const latest = this.supervisedDeliveryHttp.latest;
      if (!grant || !latest) throw new Error("A supervised room tail reader is required before activation.");
      const timeout = setTimeout(() => {
        if (operation.phase === "observing") operation.controller.abort();
      }, BOOTSTRAP_ROOM_INGRESS_TIMEOUT_MS);
      timeout.unref();
      let minted: NonNullable<Awaited<ReturnType<typeof this.mintHostWorkerAuthorization>>>;
      let tail: { messages?: Array<Record<string, unknown>> };
      try {
        const authorization = await this.mintHostWorkerAuthorization(entry, operation.controller.signal);
        if (!authorization) throw new Error("Room ingress bootstrap lost host grant authority before minting a worker credential.");
        minted = authorization;
        if (operation.controller.signal.aborted) throw new Error("Room ingress bootstrap was cancelled before a room tail was observed.");
        tail = await latest({ roomId: entry.room_id, apiUrl: grant.apiUrl, bearer: minted.bearer, signal: operation.controller.signal });
        if (operation.controller.signal.aborted) throw new Error("Room ingress bootstrap was cancelled before a room tail was observed.");
      } finally {
        clearTimeout(timeout);
      }
      // Do not re-check singleton authority before this durable write. Once a
      // generation observed tail N, every successor must inherit N rather
      // than advancing the initial boundary beyond a message that raced it.
      const tailId = lastRoomMessageId(tail.messages ?? []);
      operation.phase = "committing";
      const result = await this.supervisedInbox.bootstrapCursor({
        agent_id: entry.id, room_id: entry.room_id, last_observed_message_id: tailId,
      });
      await this.requestAdmittedRunningConvergence(entry.id, input.daemon_generation);
      if (!result.created) return { status: "existing", last_observed_message_id: result.last_observed_message_id };
      return { status: "bootstrapped", last_observed_message_id: tailId };
    });
  }

  /** Queue provider work only after this generation has durably admitted ingress. */
  private async requestAdmittedRunningConvergence(entryId: string, daemonGeneration: number): Promise<void> {
    if (!await this.ownsDaemonGeneration(daemonGeneration)) return;
    const entry = await this.store.getEntry(entryId);
    if (!entry || !this.requiresHostGrant(entry) || entry.desired_state !== "running") return;
    if (!await this.supervisedInbox.cursor(entryId)) return;
    this.requestConvergence(entryId);
  }

  private async verifyWorkerSession(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; api_url: string }): Promise<{ verified: true; entry_id: string; agent_session_id: string }> {
    return this.serializeEntryTick(input.entry_id, () => this.verifyWorkerSessionLocked(input));
  }

  private async verifyWorkerSessionLocked(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; api_url: string }): Promise<{ verified: true; entry_id: string; agent_session_id: string }> {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
    if (entry.room_id !== input.room_id) throw new Error("Worker session room does not match the supervised manifest entry.");
    if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker session work attempt does not match the supervised manifest entry.");
    if (entry.provider_ref?.execution_generation_id !== input.execution_generation_id) {
      throw new Error("Worker session execution generation does not match the active supervised manifest entry.");
    }
    const attempt = await this.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) throw new Error("Worker session execution generation is absent or terminal.");
    const binding = await this.workerBindings.get(input.entry_id);
    const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
    const normalizedApiUrl = new URL(input.api_url).origin;
    if (!binding
      || binding.entry_id !== input.entry_id
      || binding.room_id !== input.room_id
      || binding.work_attempt_id !== input.work_attempt_id
      || binding.execution_generation_id !== input.execution_generation_id
      || binding.agent_session_id !== input.agent_session_id
      || credential !== input.agent_session_token
      || binding.api_url !== normalizedApiUrl) {
      throw new Error("Worker session verification does not match the active supervised binding.");
    }
    return { verified: true, entry_id: input.entry_id, agent_session_id: input.agent_session_id };
  }

  /** Main-process-only handoff path. Tokens live only in WorkerBindingStore memory. */
  private async installWorkerCredential(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; daemon_generation: number }): Promise<{ status: "installed" | "stale" }> {
    return this.serializeEntryTick(input.entry_id, async () => {
      if (!await this.isExactCredentialRoute(input)) return { status: "stale" };
      const installed = await this.workerBindings.installCredential(input);
      if (installed) void this.startSupervisedDelivery(input.entry_id).catch(() => undefined);
      return { status: installed ? "installed" : "stale" };
    });
  }

  private async borrowWorkerCredential(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; daemon_generation: number; api_url: string; provider_turn_id: string }): Promise<{ status: "available"; credential: string } | { status: "deferred" | "stale" }> {
    return this.serializeEntryTick(input.entry_id, async () => {
      if (!await this.isExactCredentialRoute(input)) return { status: "stale" };
      const entry = await this.store.getEntry(input.entry_id);
      if (entry?.provider === "cursor") {
        try {
          await this.exactActiveBoundedContext({
            entryId: input.entry_id,
            workAttemptId: input.work_attempt_id,
            executionGenerationId: input.execution_generation_id,
            daemonGeneration: input.daemon_generation,
            providerTurnId: input.provider_turn_id,
          });
        } catch {
          return { status: "stale" };
        }
      }
      const credential = await this.workerBindings.credentialFor(input);
      return credential ? { status: "available", credential } : { status: "deferred" };
    });
  }

  /** All four durable identities fence a credential from a retired daemon/turn. */
  private async isExactCredentialRoute(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; daemon_generation: number; api_url?: string }): Promise<boolean> {
    if (!Number.isSafeInteger(input.daemon_generation) || input.daemon_generation !== this.singleton.currentGeneration) return false;
    const entry = await this.store.getEntry(input.entry_id);
    if (!entry || entry.room_id !== input.room_id || entry.work_attempt_id !== input.work_attempt_id
      || entry.provider_ref?.execution_generation_id !== input.execution_generation_id) return false;
    const attempt = await this.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) return false;
    const binding = await this.workerBindings.get(input.entry_id);
    let normalizedApiUrl: string | null = null;
    if (input.api_url !== undefined) {
      try { normalizedApiUrl = new URL(input.api_url).origin; } catch { return false; }
    }
    return Boolean(binding && binding.room_id === input.room_id && binding.work_attempt_id === input.work_attempt_id
      && binding.execution_generation_id === input.execution_generation_id && binding.agent_session_id === input.agent_session_id
      && (normalizedApiUrl === null || binding.api_url === normalizedApiUrl));
  }

  private async checkpointWorkerCursor(input: { entry_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; room_cursor: string }): Promise<{ checkpointed: true; entry_id: string; room_cursor: string }> {
    return this.serializeEntryTick(input.entry_id, () => this.serializeCursorCheckpoint(input.entry_id, async () => {
      const entry = (await this.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
      if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker cursor work attempt does not match the supervised manifest entry.");
      if (entry.provider_ref?.execution_generation_id !== input.execution_generation_id) {
        throw new Error("Worker cursor execution generation does not match the active supervised manifest entry.");
      }
      const attempt = await this.durability.getAttempt(input.work_attempt_id);
      const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
      if (!execution || execution.terminal) throw new Error("Worker cursor execution generation is absent or terminal.");
      const currentBinding = await this.workerBindings.get(input.entry_id);
      if (!currentBinding
        || currentBinding.entry_id !== input.entry_id
        || currentBinding.room_id !== entry.room_id
        || currentBinding.work_attempt_id !== input.work_attempt_id
        || currentBinding.agent_session_id !== input.agent_session_id
        || currentBinding.execution_generation_id !== input.execution_generation_id) {
        throw new Error("Worker cursor checkpoint does not match the active supervised binding.");
      }
      const checkpoint = await this.workerBindings.checkpointCursorMonotonic(
        input.entry_id,
        input.agent_session_id,
        input.execution_generation_id,
        input.room_cursor,
      );
      if (!checkpoint.advanced) {
        const durableCursor = checkpoint.binding.room_cursor;
        if (durableCursor && attempt.checkpoints.at(-1)?.room_cursor !== durableCursor) {
          await this.durability.checkpoint(input.work_attempt_id, {
            room_cursor: durableCursor,
            provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
          });
        }
        return {
          checkpointed: true,
          entry_id: input.entry_id,
          room_cursor: checkpoint.binding.room_cursor ?? input.room_cursor,
        };
      }
      await this.durability.checkpoint(input.work_attempt_id, {
        room_cursor: input.room_cursor,
        provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
      });
      return { checkpointed: true, entry_id: input.entry_id, room_cursor: input.room_cursor };
    }));
  }

  private async publishNativeActivity(entryId: string, method: string, status: "working" | "idle", observedAt = new Date().toISOString()): Promise<boolean> {
    const safeMethod = redactCredentialText(method, 160).value;
    const observedMs = Date.parse(observedAt);
    const currentBinding = await this.workerBindings.get(entryId);
    if (!currentBinding || !await this.workerBindings.credentialFor(currentBinding)) return false;
    const publication = await this.workerBindings.publish(entryId, observedMs, async ({ binding, sequence, observed_at }) => {
      const credential = await this.workerBindings.credentialFor(binding);
      if (!credential) throw new Error("Worker credential is unavailable until desktop credential delivery.");
      return { accepted: await publishWorkerNativeActivity({
        apiUrl: binding.api_url,
        roomId: binding.room_id,
        agentSessionId: binding.agent_session_id,
        bearer: credential,
        observedAt: observed_at,
        sequence,
        method: safeMethod,
        status,
        operation: "the daemon bridge",
      }) };
    });
    if (!publication) return false;
    if (!publication.accepted) throw new Error("Native activity endpoint rejected a stale daemon observation.");
    const verifiedBinding = await this.workerBindings.get(entryId);
    if (verifiedBinding
      && verifiedBinding.room_id === currentBinding.room_id
      && verifiedBinding.work_attempt_id === currentBinding.work_attempt_id
      && verifiedBinding.execution_generation_id === currentBinding.execution_generation_id
      && verifiedBinding.agent_session_id === currentBinding.agent_session_id) {
      // A successful scoped-bearer write is stronger evidence than the stale
      // launch-time credential-handoff latch. This also heals agents that were
      // blocked while an older server still rejected worker bearers.
      let recoveredCredentialHandoff = false;
      await this.updateManifestEntry(entryId, (current) => {
        const recoversCredentialHandoff = current.desired_state === "running"
          && current.condition === "coordination_blocked"
          && current.last_error === "Provider is running; waiting for desktop credential handoff."
          && current.room_id === verifiedBinding.room_id
          && current.work_attempt_id === verifiedBinding.work_attempt_id
          && current.provider_ref?.execution_generation_id === verifiedBinding.execution_generation_id;
        if (!recoversCredentialHandoff) return current;
        recoveredCredentialHandoff = true;
        const confirmedAt = publication.observed_at;
        return {
          ...current,
          observed_state: "working",
          condition: "none",
          last_error: null,
          ready_reached_at: resolveReadyReachedAt(current, true, confirmedAt),
          workplace_liveness: {
            state: "reachable",
            observed_at: confirmedAt,
            detail: "scoped worker bearer verified",
          },
        };
      });
      if (recoveredCredentialHandoff) {
        // The failed bind path suppresses initial inbox startup. A later
        // successful heartbeat must restore both the visible state and actual
        // room delivery, otherwise the agent appears healthy but hears nothing.
        void this.startSupervisedDelivery(entryId).catch(() => undefined);
      }
    }
    return true;
  }

  private async handleProviderTerminal(entryId: string, handle: ProviderActionHandle, executionGenerationId: string, _terminalBinding: LiveBindingIdentity | undefined, terminal: ProviderActionTerminal): Promise<void> {
    if (this.liveHandles.get(entryId) !== handle) return;
    this.pendingResumeBindings.delete(entryId);
    this.liveHandles.delete(entryId);
    this.liveBindingIdentities.delete(entryId);
    for (const dispose of this.liveDisposers.get(entryId) ?? []) dispose();
    this.liveDisposers.delete(entryId);
    // Provider execution and room observation are separate authorities. Keep
    // the exact worker binding polling so routed work is durably queued while
    // convergence restores the native runtime.
    void this.startSupervisedDelivery(entryId).catch(() => undefined);
    await this.serializeEntryTick(entryId, async () => {
      const entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
      const successorHandle = this.liveHandles.get(entryId);
      if (successorHandle && successorHandle !== handle) return;
      if (entry?.work_attempt_id) {
        const attempt = await this.durability.getAttempt(entry.work_attempt_id);
        if (this.liveHandles.get(entryId)) return;
        const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === executionGenerationId);
        if (execution && !execution.terminal) {
          await this.durability.recordTerminal(entry.work_attempt_id, execution.execution_generation_id, {
            ...this.terminalPayload(terminal, execution.actor),
            generation: execution.generation,
          });
        }
        if (entry.desired_state === "stopped") {
          await this.durability.releaseTerminalExecutionFence(entry.work_attempt_id, executionGenerationId);
        }
      }
      if (this.liveHandles.get(entryId)) return;
      // Do not erase the terminal binding here. installProviderHandle removed its
      // live publication authority above; retaining the owner-only (0600)
      // private credential is what permits an exact successor to verify and
      // roll it forward after an intentional stop/start or daemon replacement.
      await this.observeProviderExitOnce(entryId, terminal, "daemon-provider", executionGenerationId, handle);
      this.requestConvergence(entryId);
    });
  }

  private trackProviderCallback(operation: Promise<void>): void {
    this.providerCallbacks.add(operation);
    void operation.finally(() => this.providerCallbacks.delete(operation));
  }

  private async updateManifestEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
    roomMoveCancellation?: { agentId: string; detail: string },
  ): Promise<DaemonManifestEntry> {
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const entry = await this.store.getEntry(entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      const updated = update(entry);
      if (updated === entry) return entry;
      const next = await this.store.replaceEntry(
        this.manifestGeneration,
        updated,
        (commit) => this.fenceDaemonCommit(commit),
        roomMoveCancellation,
      );
      this.manifestGeneration = next.generation;
      return next.entry;
    });
  }

  /** Identity P1b/P1d must pass into work-durability fencing. */
  supervisorFenceIdentity(): { supervisor_id: string; supervisor_generation: number } {
    return { supervisor_id: this.singleton.lockPath, supervisor_generation: this.singleton.currentGeneration };
  }

  async transition(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"]): Promise<void> {
    return this.serializeManifestMutation(() => this.transitionOnce(entryId, to, condition, cause, actor, reconciliation));
  }

  private async transitionOnce(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"], notice?: ReconciliationNotice["kind"], terminal?: ExecutionTerminalPayload): Promise<void> {
    await this.singleton.assertCurrent();
    const entry = await this.store.getEntry(entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    const safeCause = redactCredentialText(cause).value;
    const safeActor = redactCredentialText(actor).value;
    const sanitizeTerminal = (value: ExecutionTerminalPayload | undefined): ExecutionTerminalPayload | undefined => value ? {
      ...value,
      signal: value.signal === null ? null : redactCredentialText(value.signal).value,
      stdio_archive_ref: value.stdio_archive_ref === null ? null : redactCredentialText(value.stdio_archive_ref).value,
      stdio_tail: redactCredentialText(value.stdio_tail, 64 * 1024).value,
      terminal_cause: redactCredentialText(value.terminal_cause).value,
      actor: redactCredentialText(value.actor).value,
      provider_continuation_id: value.provider_continuation_id === null ? null : redactCredentialText(value.provider_continuation_id).value,
    } : undefined;
    const candidateReconciliation = reconciliation ?? advanceReconciliationState(entry.reconciliation, to, this.nowMs());
    const nextReconciliation = {
      ...candidateReconciliation,
      last_terminal: sanitizeTerminal(candidateReconciliation.last_terminal),
    };
    const safeTerminal = sanitizeTerminal(terminal);
    const noticeKind = notice ?? (condition === "quarantined" ? "quarantine_death" : condition === "coordination_blocked" ? "coordination_escalation" : undefined);
    const notices = (entry.reconciliation_notices ?? []).map((candidate) => ({
      ...candidate,
      cause: redactCredentialText(candidate.cause).value,
      terminal: sanitizeTerminal(candidate.terminal),
    }));
    if (noticeKind) notices.push({ at: new Date().toISOString(), kind: noticeKind, cause: safeCause, terminal: safeTerminal ?? nextReconciliation.last_terminal ?? undefined });
    const lastError = to === "failed" || condition !== "none"
      ? safeCause
      : (["working", "idle", "stopped"].includes(to) ? null : entry.last_error === null || entry.last_error === undefined ? null : redactCredentialText(entry.last_error).value);
    const updated: DaemonManifestEntry = {
      ...entry,
      observed_state: to,
      condition,
      last_error: lastError,
      reconciliation: nextReconciliation,
      reconciliation_notices: notices.slice(-32),
    };
    const next = await this.store.replaceEntry(this.manifestGeneration, updated, (commit) => this.fenceDaemonCommit(commit));
    this.manifestGeneration = next.generation;
    await this.serializeManifestCommit(async () => {
      await this.singleton.assertCurrent();
      await this.audit.append({ at: new Date().toISOString(), entry_id: entryId, from: entry.observed_state, to, cause: safeCause, actor: safeActor, generation: next.generation });
    });
  }

  /**
   * The daemon owns this convergence entry point: manifest state is the source
   * of truth, and every retry deadline survives a daemon restart. P1e supplies
   * the real control-socket port; tests may inject a fake port directly.
   */
  async reconcile(entryId: string, input: DaemonReconcileInput, watchdogThresholdMs: number, actor = "reconciler") {
    return this.serializeEntryTick(entryId, () => this.serializeManifestMutation(() => this.reconcileOnce(entryId, input, watchdogThresholdMs, actor)));
  }

  private async reconcileOnce(entryId: string, input: DaemonReconcileInput, watchdogThresholdMs: number, actor: string) {
    if (!this.providerPort) throw new Error("Provider action port is unavailable");
    await this.singleton.assertCurrent();
    const entry = await this.store.getEntry(entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);

    let reconciliation = advanceReconciliationState(entry.reconciliation, entry.observed_state, input.nowMs);
    if (JSON.stringify(reconciliation) !== JSON.stringify(entry.reconciliation)) {
      const persisted = { ...entry, reconciliation };
      const next = await this.store.replaceEntriesBatch(
        this.manifestGeneration,
        [persisted],
        (commit) => this.fenceDaemonCommit(commit),
      );
      this.manifestGeneration = next.generation;
    }

    let redispatchPending = false;
    let redispatchKind: "poke" | "restart_fresh" | "restart_with_resume" | "stop" | undefined;
    let redispatchActionId = input.reconciliationActionId;
    let redispatchActionSequence = input.reconciliationActionSequence;
    if (reconciliation.pending_action) {
      const pending = reconciliation.pending_action;
      const attachment = await this.providerPort.attachAction(pending.id, input.workAttemptId);
      if (attachment.state === "attached") {
        reconciliation = completeReconciliationAction(reconciliation, pending.id);
        await this.transitionOnce(entryId, attachment.handle.observedState, entry.condition, "reconciled pending provider action", actor, reconciliation);
      }
      if (attachment.state === "absent") { redispatchPending = true; redispatchActionId = pending.id; redispatchActionSequence = pending.sequence; redispatchKind = pending.kind; }
      if (attachment.state === "ambiguous") {
        await this.transitionOnce(entryId, "recovering", "coordination_blocked", `pending provider action ambiguous: ${attachment.reason}`, actor, reconciliation);
        return { decision: { action: "hold_coordination" as const, observedState: "recovering" as const, condition: "coordination_blocked" as const, reason: `pending provider action ambiguous: ${attachment.reason}` }, disposition: "held" as const };
      }
      if (attachment.state === "attached") return {
        decision: { action: "hold_coordination" as const, observedState: attachment.handle.observedState, condition: entry.condition, reason: "pending provider action attached; await next convergence tick" },
        disposition: "held" as const,
      };
    }

    if (redispatchPending && entry.desired_state === "stopped" && redispatchKind !== "stop") {
      reconciliation = completeReconciliationAction(reconciliation, redispatchActionId);
      redispatchPending = false;
      redispatchKind = undefined;
      redispatchActionId = input.reconciliationActionId;
      redispatchActionSequence = input.reconciliationActionSequence;
      await this.transitionOnce(entryId, entry.observed_state, entry.condition, "cancelled pending provider action because desired state is stopped", actor, reconciliation);
    }
    if (redispatchPending && entry.condition === "quarantined") {
      reconciliation = completeReconciliationAction(reconciliation, redispatchActionId);
      await this.transitionOnce(entryId, entry.observed_state, "quarantined", "cancelled pending provider action because entry is quarantined", actor, reconciliation);
      return { decision: { action: "quarantine" as const, observedState: entry.observed_state, condition: "quarantined" as const, reason: "quarantined entry cannot redispatch pending provider action" }, disposition: "held" as const };
    }
    if (redispatchPending && ["restart_fresh", "restart_with_resume"].includes(redispatchKind ?? "") && input.activeLease) {
      await this.transitionOnce(entryId, "recovering", "coordination_blocked", "pending provider action awaits fenced lease rebind", actor, reconciliation);
      return { decision: { action: "hold_coordination" as const, observedState: "recovering" as const, condition: "coordination_blocked" as const, reason: "pending provider action awaits fenced lease rebind" }, disposition: "held" as const };
    }

    const result = await new ProviderReconciler(this.providerPort).reconcile({
      ...input,
      actionId: redispatchActionId,
      forcedAction: redispatchKind,
      desiredState: entry.desired_state,
      observedState: entry.observed_state,
      condition: entry.condition,
      exitsInWindow: reconciliation.exit_timestamps_ms.length,
      nextRestartAtMs: reconciliation.next_restart_at_ms,
    }, watchdogThresholdMs, {
      beforeAction: async (kind) => {
        if (redispatchPending) return;
        reconciliation = beginReconciliationAction(reconciliation, { id: redispatchActionId, sequence: redispatchActionSequence, kind, recorded_at_ms: input.nowMs });
        await this.transitionOnce(entryId, entry.observed_state, entry.condition, `persisted ${kind} action intent`, actor, reconciliation);
      },
    });
    const finalReconciliation = result.disposition === "failed"
      ? recordReconciliationActionFailure(reconciliation, redispatchActionId, input.nowMs)
      : result.disposition === "executed"
        ? completeReconciliationAction(reconciliation, redispatchActionId)
        : reconciliation;
    const target = result.disposition === "failed"
      ? { observedState: "failed" as const, condition: "none" as const }
      : { observedState: result.decision.observedState, condition: result.decision.condition };
    if (target.observedState !== entry.observed_state || target.condition !== entry.condition || JSON.stringify(finalReconciliation) !== JSON.stringify(reconciliation)) {
      await this.transitionOnce(entryId, target.observedState, target.condition, result.decision.reason, actor, finalReconciliation);
    }
    return result;
  }

  private async serializeEntryTick<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.reconciliationTicks.get(entryId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.reconciliationTicks.set(entryId, tail);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.reconciliationTicks.get(entryId) === tail) this.reconciliationTicks.delete(entryId);
    }
  }

  /** Provider terminal callback: records an actual exit edge before the next tick. */
  async observeProviderExit(entryId: string, terminal: ProviderActionTerminal, actor = "provider", expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
    await this.serializeEntryTick(entryId, () => this.observeProviderExitOnce(entryId, terminal, actor, expectedExecutionGenerationId, expectedHandle));
  }

  private async observeProviderExitOnce(entryId: string, terminal: ProviderActionTerminal, actor: string, expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      if (expectedExecutionGenerationId && entry.provider_ref?.execution_generation_id !== expectedExecutionGenerationId) return;
      const currentHandle = this.liveHandles.get(entryId);
      if (expectedHandle && currentHandle && currentHandle !== expectedHandle) return;
      const payload = this.terminalPayload(terminal, actor);
      if (entry.condition === "quarantined") {
        // A stale child cannot unquarantine the entry, but its immutable death
        // evidence must still reach the durable operator inbox.
        await this.transitionOnce(entryId, entry.observed_state, "quarantined", `late provider terminal: ${terminal.terminalCause}`, actor, { ...advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()), last_terminal: payload }, "quarantine_death", payload);
        return;
      }
      const turnControl = entry.turn_control;
      const completedStopTurn = entry.desired_state === "running"
        && terminal.terminalCause === "stopped"
        && turnControl?.execution_generation_id === entry.provider_ref?.execution_generation_id
        && turnControl?.status === "completed"
        && turnControl?.has_correction === false
        && turnControl?.interrupted === true
        && turnControl?.resumed === false
        && turnControl?.state === "idle";
      const intentional = entry.desired_state === "stopped" || entry.desired_state === "paused" || completedStopTurn;
      const observedState = completedStopTurn ? "idle" : entry.desired_state === "paused" ? "paused" : intentional ? "stopped" : "failed";
      const reconciliation = { ...advanceReconciliationState(entry.reconciliation, observedState, this.nowMs()), last_terminal: payload };
      await this.transitionOnce(
        entryId,
        observedState,
        "none",
        completedStopTurn ? "provider terminal completed intentional stop-turn" : `provider terminal: ${terminal.terminalCause}`,
        actor,
        reconciliation,
      );
    });
  }

  /** Starts periodic convergence and joins provider onExit to the same durable path. */
  async scheduleConvergence(entryId: string, handle: ProviderActionHandle, input: () => DaemonReconcileInput, watchdogThresholdMs: number, intervalMs: number, actor = "reconciler"): Promise<() => Promise<void>> {
    const providerPort = this.providerPort;
    if (!providerPort) throw new Error("Provider action port is unavailable");
    const existing = this.scheduledConvergence.get(entryId);
    if (existing) return (await existing).dispose;
    let resolveReservation!: (control: { dispose: () => Promise<void> }) => void;
    const reservation = new Promise<{ dispose: () => Promise<void> }>((resolve) => { resolveReservation = resolve; });
    this.scheduledConvergence.set(entryId, reservation);
    let timer: ReturnType<typeof setInterval> | null = null;
    let unsubscribe = () => {};
    try {
      let stopped = false;
      let currentHandle = handle;
      let currentHandleGeneration = 0;
      let listenerInstalledGeneration = 0;
      let listenerInstallTail: Promise<void> = Promise.resolve();
      const activeCallbacks = new Set<Promise<void>>();
      const cancel = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        unsubscribe();
        if (this.scheduledConvergence.get(entryId) === reservation) this.scheduledConvergence.delete(entryId);
        if (this.scheduledConvergenceCancels.get(entryId) === cancel) this.scheduledConvergenceCancels.delete(entryId);
      };
      this.scheduledConvergenceCancels.set(entryId, cancel);
      const trackCallback = (operation: Promise<void>) => {
        activeCallbacks.add(operation);
        void operation.then(() => activeCallbacks.delete(operation), () => activeCallbacks.delete(operation));
      };
      const recordError = async (error: unknown) => this.recordSchedulerFailure(entryId, error, actor);
      const sameHandle = (left: ProviderActionHandle, right: ProviderActionHandle) => left.workAttemptId === right.workAttemptId && left.pid === right.pid && left.providerContinuationId === right.providerContinuationId;
      const recordStaleExit = async (staleHandle: ProviderActionHandle, terminal: ProviderActionTerminal) => {
        const payload = this.terminalPayload(terminal, actor);
        await this.serializeEntryTick(entryId, () => this.serializeManifestMutation(async () => {
          const manifest = await this.store.load();
          const entry = manifest.entries.find((candidate) => candidate.id === entryId);
          if (!entry) return;
          await this.transitionOnce(entryId, entry.observed_state, entry.condition, `stale terminal from superseded provider handle pid=${staleHandle.pid ?? "unknown"}`, actor, { ...advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()), last_terminal: payload }, "coordination_escalation", payload);
        }));
      };
      const installExitListener = async (nextHandle: ProviderActionHandle, generation: number) => {
        let nextUnsubscribe: () => void;
        try { nextUnsubscribe = await providerPort.onExit(nextHandle, (terminal) => {
          const operation = (async () => {
            try {
              if (generation !== currentHandleGeneration || !sameHandle(nextHandle, currentHandle)) {
                await recordStaleExit(nextHandle, terminal);
                return;
              }
              await this.observeProviderExit(entryId, terminal, actor);
              await tick();
            } catch (error) {
              try { await recordError(error); } catch { /* A fenced daemon cannot persist after losing authority. */ }
            }
          })();
          trackCallback(operation);
        }); } catch (error) {
          if (generation > 1) throw new ReplacementListenerInstallError(error instanceof Error ? error.message : "replacement listener installation failed");
          throw error;
        }
        if (stopped || generation !== currentHandleGeneration || !sameHandle(nextHandle, currentHandle)) { nextUnsubscribe(); return; }
        const previousUnsubscribe = unsubscribe;
        unsubscribe = nextUnsubscribe;
        listenerInstalledGeneration = generation;
        previousUnsubscribe();
      };
      const enqueueExitListenerInstall = (nextHandle: ProviderActionHandle, generation: number) => {
        const operation = listenerInstallTail.then(() => installExitListener(nextHandle, generation));
        listenerInstallTail = operation.catch(() => undefined);
        return operation;
      };
      const queueExitListenerInstall = (nextHandle: ProviderActionHandle) => {
        // Promotion is intentionally before the await inside `onExit`: a late
        // terminal from the superseded child is evidence, never a new restart.
        currentHandle = nextHandle;
        currentHandleGeneration += 1;
        const generation = currentHandleGeneration;
        return enqueueExitListenerInstall(nextHandle, generation);
      };
      let tickTail: Promise<void> = Promise.resolve();
      const tick = () => {
        const operation = tickTail.then(async () => {
          if (stopped) return;
          if (listenerInstalledGeneration !== currentHandleGeneration) await enqueueExitListenerInstall(currentHandle, currentHandleGeneration);
          const result = await this.reconcile(entryId, { ...input(), handle: currentHandle }, watchdogThresholdMs, actor);
          if (!stopped && result.replacementHandle) await queueExitListenerInstall(result.replacementHandle);
        });
        // A failed action is durably escalated by the caller, but must not
        // prevent the next convergence edge from observing the new handle.
        tickTail = operation.catch(() => undefined);
        return operation;
      };
      timer = setInterval(() => {
        trackCallback(tick().catch(async (error) => { try { await recordError(error); } catch { /* See terminal callback. */ } }));
      }, intervalMs);
      await queueExitListenerInstall(handle);
      // A replacement may already exist when its listener bridge transiently
      // fails. Keep the scheduler alive: the next serialized tick retries the
      // same promoted handle instead of launching another child.
      try { await tick(); } catch (error) {
        if (error instanceof ReplacementListenerInstallError) await recordError(error);
        else throw error;
      }
      const dispose = async () => {
        cancel();
        await Promise.all([...activeCallbacks]);
      };
      resolveReservation({ dispose });
      return dispose;
    } catch (error) {
      this.scheduledConvergenceCancels.get(entryId)?.();
      try { await this.recordSchedulerFailure(entryId, error, actor); } catch { /* Preserve the original setup failure for the caller. */ }
      resolveReservation({ dispose: async () => {} });
      if (this.scheduledConvergence.get(entryId) === reservation) this.scheduledConvergence.delete(entryId);
      throw error;
    }
  }

  private async serializeManifestMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.manifestMutation;
    let release!: () => void;
    this.manifestMutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.singleton.assertCurrent();
      return await operation();
    } finally { release(); }
  }

  private writeManifest(
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    legacyOwners?: LegacyLaneOwner[],
    roomMoveCancellation?: { agentId: string; detail: string },
  ) {
    return this.store.write(
      expectedGeneration,
      entries,
      legacyOwners,
      (commit) => this.fenceDaemonCommit(commit),
      roomMoveCancellation,
    );
  }

  private fenceDaemonCommit(commit: () => Promise<void>): Promise<void> {
    return this.serializeManifestCommit(async () => {
      if (this.handoffScheduled) throw new DaemonFenceLostError("Supervisor handoff fenced a stale daemon-owned commit.");
      await this.singleton.assertCurrent();
      // assertCurrent performs asynchronous filesystem I/O. Handoff may set
      // the public revocation flag during that await while this process still
      // owns the on-disk generation, so validate both sides of the boundary.
      if (this.handoffScheduled) throw new DaemonFenceLostError("Supervisor handoff fenced a stale daemon-owned commit.");
      await commit();
      this.notifyStateChanged();
    });
  }

  /**
   * Finish only the exact init or live->idle edge of a wrapper already admitted
   * by this generation. Handoff has synchronously fenced new delivery, but the
   * old daemon still owns the singleton and must leave that admitted turn's
   * provider state honest before releasing the singleton to a successor.
   */
  private fenceAdmittedCursorTransitionCommit(commit: () => Promise<void>): Promise<void> {
    return this.serializeManifestCommit(async () => {
      await this.singleton.assertCurrent();
      await commit();
      await this.singleton.assertCurrent();
      this.notifyStateChanged();
    });
  }

  private async serializeManifestCommit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.manifestCommit;
    let release!: () => void;
    this.manifestCommit = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private terminalPayload(terminal: ProviderActionTerminal, actor: string): ExecutionTerminalPayload {
    return {
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: terminal.terminalCause,
      actor,
      generation: this.singleton.currentGeneration,
      provider_continuation_id: terminal.providerContinuationId,
    };
  }

  private async recordSchedulerFailure(entryId: string, error: unknown, actor: string): Promise<void> {
    const message = schedulerErrorDetail(error);
    // A resume that failed because the saved runtime is provably gone can never
    // succeed by retrying resume. Recover the way a manual Recover does: drop
    // the dead continuation so the next convergence starts a fresh runtime, and
    // record a failed edge so the crash-loop machinery bounds it — a single
    // crash self-heals in ~1s, a genuine crash-loop backs off then quarantines
    // (an actionable rest) instead of dead-ending silently in "recovering".
    if (providerRuntimeGoneFailure(error)) {
      let didReset = false;
      await this.serializeEntryTick(entryId, () => this.updateManifestEntry(entryId, (current) => {
        // Only the daemon-owned running entry with a live continuation to drop
        // is reset here; anything else (stopped, quarantined, already reset) is
        // left untouched so this cannot re-fire on a subsequent poke.
        if (current.desired_state !== "running" || current.condition === "quarantined" || !current.provider_ref) {
          return current;
        }
        didReset = true;
        return {
          ...current,
          observed_state: "failed",
          condition: "none",
          last_error: "The previous provider runtime stopped; starting a replacement.",
          provider_ref: null,
          last_worker_binding: null,
          reconciliation: advanceReconciliationState(current.reconciliation, "failed", this.nowMs()),
        };
      }));
      if (didReset) {
        await this.audit.append({
          at: new Date().toISOString(), entry_id: entryId, from: "recovering", to: "failed",
          cause: "provider runtime is gone; recovering with a fresh runtime", actor,
          generation: this.singleton.currentGeneration,
        });
        // Prompt first attempt; convergence honors the persisted backoff for
        // repeats and quarantines a true crash-loop into an actionable rest.
        this.scheduleRecoveryConvergence(entryId, 1_000);
      }
      return;
    }
    await this.serializeEntryTick(entryId, () => this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return;
      const condition = entry.condition === "quarantined" ? "quarantined" : "coordination_blocked";
      // Before a work attempt exists there is no provider execution to
      // recover or reconnect. Preserve that distinction in durable state so
      // the desktop can offer an honest provisioning retry.
      const observedState = !entry.work_attempt_id && !entry.provider_ref
        ? "failed"
        : entry.observed_state;
      await this.transitionOnce(entryId, observedState, condition, `convergence scheduler failure: ${message}`, actor, undefined, "coordination_escalation");
    }));
    // A transient mint failure must converge again without waiting for another
    // Electron RPC — but only a bounded number of times: each retry re-runs up
    // to three 10s cloud mints, so an endpoint that stays unreachable must
    // rest at the blocked state instead of looping every heartbeat forever.
    if (exhaustedTransientWorkerMint(error)) {
      const attempts = (this.workerMintRecoveryRetryAttempts.get(entryId) ?? 0) + 1;
      this.workerMintRecoveryRetryAttempts.set(entryId, attempts);
      if (attempts <= WORKER_MINT_RECOVERY_RETRY_LIMIT) {
        this.scheduleRecoveryConvergence(entryId, this.nativeHeartbeatIntervalMs);
      }
      return;
    }
    // A launch that timed out left nothing durable behind; retry it a bounded
    // number of times instead of parking the entry in "starting" until an
    // unrelated RPC happens to converge it again.
    if (transientProviderStartFailure(error)) {
      const attempts = (this.providerStartRetryAttempts.get(entryId) ?? 0) + 1;
      this.providerStartRetryAttempts.set(entryId, attempts);
      if (attempts <= PROVIDER_START_RETRY_LIMIT) {
        this.scheduleRecoveryConvergence(entryId, this.nativeHeartbeatIntervalMs);
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { ProviderActionPortRouter } = await import("./provider-action-port-router.js");
    const daemon = new SupervisorDaemon(defaultDaemonPaths(), process.platform, new ProviderActionPortRouter(), true);
    await daemon.start();
    await daemon.waitForHandoff();
    process.exit(0);
  })().catch((error) => {
    console.error("Supervisor daemon handoff failed:", error);
    process.exit(1);
  });
}
