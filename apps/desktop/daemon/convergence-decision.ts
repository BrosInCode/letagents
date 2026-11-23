import { CRASH_LOOP_EXIT_LIMIT, CRASH_LOOP_WINDOW_MS } from "./reconciler-policy.js";
import type {
  DaemonManifestEntry,
  DesiredState,
  ObservedState,
  PolicyCondition,
} from "./types.js";

// A live generation with no attachable handle resolves on its own once the
// old process exits or answers again. Re-check with capped backoff so the
// agent is not left blocked until some unrelated event wakes it, while a
// runtime that stays unattachable costs one cheap check per half hour.
export const UNATTACHABLE_GENERATION_RECHECK_MS = 60_000;
export const UNATTACHABLE_GENERATION_RECHECK_MAX_MS = 30 * 60_000;
export const WORKSPACE_REPOSITORY_RETRY_MS = 5_000;
export const WORKSPACE_REPOSITORY_RETRY_MAX_MS = 5 * 60_000;
export const CURSOR_ATTACH_RETRY_MS = 250;

/**
 * How long an ended runtime is left for the turn of its in-flight message to
 * be recorded. A provider reports a failed turn's result moments after the
 * failure; past this the result is not coming and the runtime is retired
 * without it.
 */
export const RETIREMENT_SETTLEMENT_WAIT_MS = 30_000;

export const UNATTACHABLE_GENERATION_CAUSE =
  "durable execution generation remains live without an attachable provider handle";
export const INCOMPLETE_PROCESS_REF_ERROR =
  "The recorded provider process has a process id and no process birth, so its absence cannot be proved.";
export const UNPROVEN_PREDECESSOR_CAUSE =
  "the earlier provider process is not proven gone after its recorded end; no replacement starts until it is";
export const CRASH_LOOP_QUARANTINE_CAUSE =
  "crash-loop threshold reached before provider restart";
export const CURSOR_ATTACH_IN_PROGRESS_CAUSE =
  "exact Cursor turn wrapper is still finishing; retrying without launching a successor";
export const CURSOR_BLOCKED_DELIVERY_FALLBACK_CAUSE =
  "The failed Cursor delivery needs attention before its runtime can recover.";
export const STOPPED_WITHOUT_PROVIDER_CAUSE =
  "desired state converged without a live provider";

export type RecordedProcessState = "none" | "exact" | "incomplete";

export type PersistedProviderRefSummary = {
  workAttemptId: string;
  executionGenerationId: string;
  providerContinuationId: string;
  providerConnectionKind: string | null;
  recordedProcessState: RecordedProcessState;
  hasProviderConnection: boolean;
};

/**
 * Read-only control projection of a single agent's durable row in `agents`.
 * Carries no inbox rows, no activity rows, and no secrets.
 */
export type PersistedConvergeControl = {
  agentId: string;
  roomId: string;
  provider: string;
  deliveryMode: "mcp_polling" | "daemon_inbox";
  desiredState: DesiredState;
  observedState: ObservedState;
  condition: PolicyCondition;
  lastError: string | null;
  workAttemptId: string | null;
  providerRef: PersistedProviderRefSummary | null;
  hasPendingTurnControl: boolean;
  turnControlWorkAttemptMatches: boolean;
  reconciliation: {
    exitTimestampsMs: readonly number[];
    nextRestartAtMs: number | null;
  };
  isRental: boolean;
};

/**
 * Strictly non-durable per-agent bookkeeping owned by convergence in memory.
 * Zeroed on a fresh daemon start; never written to SQLite.
 */
export type VolatileConvergeBookkeeping = {
  /** Opaque sha256 digest of the last failed native launch admission (no secrets). */
  failedLaunchAdmissionKey: string | null;
  unattachableRechecks: number;
  workspaceRepositoryRetries: number;
  recoveryDueAtMs: number | null;
  retirementDeadline: { handleToken: number; dueAtMs: number } | null;
};

export type ConvergeState = {
  persisted: PersistedConvergeControl;
  volatile: VolatileConvergeBookkeeping;
};

export type InboxHeadSummary = {
  state: string;
  provider_turn_id: string | null;
  outcome: string | null;
};

export type DurableTransitionEffect = {
  observedState: ObservedState;
  condition: PolicyCondition;
  cause: string;
  actor: "daemon-convergence";
};

export type ScheduleRecoveryCommand = {
  kind: "schedule_recovery";
  delayMs: number;
  dueAtMs: number;
  replaceExisting: boolean;
};

export type ConvergeCommand =
  | { kind: "stop_delivery" }
  | { kind: "proceed_running" }
  | { kind: "ensure_delivery_and_archive" }
  | ScheduleRecoveryCommand
  | { kind: "fence_terminal_handle"; actionId: string }
  | { kind: "proceed_launch_setup" }
  | { kind: "retire_unproven_predecessor" }
  | { kind: "log_unproven_predecessor"; message: string }
  | {
      kind: "proceed_after_predecessor";
      reusesActiveCursorExecution: boolean;
      needsTurnControlCompletion: boolean;
    }
  | { kind: "prepare_workspace_and_transition"; resumed: boolean }
  | { kind: "proceed_spawn" }
  | { kind: "stop_handle" }
  | { kind: "stop_unattached_exact_ref"; alreadySettledTerminal: boolean }
  | { kind: "execute_stop_ref"; settledAtTarget: boolean }
  | { kind: "finalize_witnessed_stop" }
  | { kind: "attach_for_stop" }
  | { kind: "fail_stop"; errorMessage: string };

export type ConvergeDecision = {
  volatile: VolatileConvergeBookkeeping;
  transition?: DurableTransitionEffect;
  commands: readonly ConvergeCommand[];
};

export type ExecutionTerminalState =
  | "none"
  | "unwitnessed"
  | "witnessed"
  | "missing_generation";

export type ConvergeEvent =
  | {
      kind: "request_arrived";
      requestKind: "owned" | "rehydration";
    }
  | {
      kind: "rental_permission_rejected";
      reason: string;
    }
  | {
      kind: "running_gate_checked";
      nowMs: number;
      requiresGrant: boolean;
      hasGrant: boolean;
      grantFresh: boolean;
      hasMatchingInboxCursor: boolean;
      hasPendingTimer?: boolean;
    }
  | {
      kind: "attach_in_progress";
      nowMs: number;
      hasPendingTimer?: boolean;
    }
  | {
      kind: "attached_handle_evaluated";
      nowMs: number;
      handleToken: number;
      handleObservedState: ObservedState;
      typed: boolean;
      requiresGrant: boolean;
      inboxHead: InboxHeadSummary | null;
      roomRefusesAccess: boolean;
      hasPendingTimer?: boolean;
    }
  | {
      kind: "rehydration_admission_checked";
      requestKind: "owned" | "rehydration";
      admissionKey: string | null;
    }
  | {
      kind: "launch_failed";
      admissionKey: string | null;
    }
  | {
      kind: "launch_dispatched";
    }
  | {
      kind: "launch_preconditions_checked";
      nowMs: number;
      hasActiveExecution: boolean;
      inboxHeadBlocked: boolean;
      inboxHeadLastError: string | null;
      predecessorHasTerminalWithoutWitness: boolean;
      predecessorExactStopAvailable: boolean;
      hasPendingTimer?: boolean;
    }
  | {
      kind: "predecessor_retired";
      hasActiveExecution: boolean;
    }
  | {
      kind: "predecessor_retire_failed";
      nowMs: number;
      errorMessage: string;
      hasPendingTimer?: boolean;
    }
  | {
      kind: "capabilities_evaluated";
      supportedDeliveryModes: readonly string[] | null;
      supportsResume: boolean;
      providerLabel: string;
    }
  | {
      kind: "workspace_repository_checked";
      nowMs: number;
      outcome: "ok" | "not_required" | "failed";
      errorMessage?: string;
      hasPendingTimer?: boolean;
    }
  | {
      kind: "launch_completed_without_grant";
      handleObservedState: ObservedState;
      resumed: boolean;
    }
  | {
      kind: "stop_requested";
      hasLiveHandle: boolean;
      exitSettling: boolean;
      hasStopRefCapability: boolean;
      hasExactProcessStopCapability: boolean;
      executionTerminal: ExecutionTerminalState;
    }
  | {
      kind: "stop_unattached_exact_ref_prepared";
      alreadySettledTerminal: boolean;
    }
  | {
      kind: "stop_after_attach_evaluated";
      hasLiveHandle: boolean;
    }
  | {
      kind: "stop_without_provider_converged";
    }
  | {
      kind: "recovery_schedule_requested";
      nowMs: number;
      delayMs: number;
      hasPendingTimer?: boolean;
    }
  | {
      kind: "recovery_timer_fired";
    }
  | {
      kind: "recovery_cleared";
    };

export function initialVolatileConvergeBookkeeping(): VolatileConvergeBookkeeping {
  return {
    failedLaunchAdmissionKey: null,
    unattachableRechecks: 0,
    workspaceRepositoryRetries: 0,
    recoveryDueAtMs: null,
    retirementDeadline: null,
  };
}

/**
 * Minimal persisted control placeholder for purely volatile events
 * (`recovery_schedule_requested`, `recovery_timer_fired`, `recovery_cleared`)
 * that depend only on `volatile` bookkeeping.
 */
export function recoveryControlState(
  agentId: string,
  volatile: VolatileConvergeBookkeeping,
): ConvergeState {
  return {
    persisted: {
      agentId,
      roomId: "",
      provider: "",
      deliveryMode: "daemon_inbox",
      desiredState: "running",
      observedState: "absent",
      condition: "none",
      lastError: null,
      workAttemptId: null,
      providerRef: null,
      hasPendingTurnControl: false,
      turnControlWorkAttemptMatches: false,
      reconciliation: { exitTimestampsMs: [], nextRestartAtMs: null },
      isRental: false,
    },
    volatile,
  };
}

export function clearRecoveryTimerBookkeeping(
  volatile: VolatileConvergeBookkeeping,
): VolatileConvergeBookkeeping {
  return {
    ...volatile,
    recoveryDueAtMs: null,
    unattachableRechecks: 0,
    workspaceRepositoryRetries: 0,
  };
}

export function detachConvergenceBookkeeping(
  volatile: VolatileConvergeBookkeeping,
): VolatileConvergeBookkeeping {
  return {
    ...volatile,
    failedLaunchAdmissionKey: null,
  };
}

/**
 * The inbox head has a turn that may still be running and no result saved for
 * it. A started turn handed back to `pending` counts: a delivery lane that
 * lets go of its turn leaves the row that way while the provider works on.
 */
export function turnInFlight(head: InboxHeadSummary | null): boolean {
  return head !== null && (
    head.state === "dispatching"
    || head.state === "awaiting_result"
    || head.state === "result_recovery"
    || (head.state === "pending" && Boolean(head.provider_turn_id) && !head.outcome)
  );
}

/**
 * A reference with no process id names no process (a Cursor lane between
 * turns): there is nothing to prove. A process id with no recorded birth is an
 * incomplete reference: no process can be matched to it, so it is never
 * signalled and never treated as gone.
 */
export function recordedProcessState(
  connection: { pid?: number | null; processIdentity?: string | null } | null | undefined,
): RecordedProcessState {
  if (!connection || connection.pid === null || connection.pid === undefined) return "none";
  return Number.isSafeInteger(connection.pid) && connection.pid > 0
    && typeof connection.processIdentity === "string" && connection.processIdentity.trim()
    ? "exact"
    : "incomplete";
}

export function computeCappedBackoffMs(attempts: number, baseMs: number, maxMs: number): number {
  const safeAttempts = Math.max(1, attempts);
  return Math.min(baseMs * 2 ** Math.min(safeAttempts - 1, 10), maxMs);
}

export function isResumableCursorLane(persisted: PersistedConvergeControl): boolean {
  return persisted.provider === "cursor"
    && persisted.deliveryMode === "daemon_inbox"
    && persisted.providerRef?.providerConnectionKind === "cursor_cli";
}

export function projectPersistedConvergeControl(
  entry: DaemonManifestEntry,
): PersistedConvergeControl {
  const ref = entry.provider_ref;
  const turnControl = entry.turn_control;
  return {
    agentId: entry.id,
    roomId: entry.room_id,
    provider: entry.provider,
    deliveryMode: entry.delivery_mode ?? "daemon_inbox",
    desiredState: entry.desired_state,
    observedState: entry.observed_state,
    condition: entry.condition,
    lastError: entry.last_error ?? null,
    workAttemptId: entry.work_attempt_id ?? null,
    providerRef: ref ? {
      workAttemptId: ref.work_attempt_id,
      executionGenerationId: ref.execution_generation_id,
      providerContinuationId: ref.provider_continuation_id,
      providerConnectionKind: ref.provider_connection?.kind ?? null,
      recordedProcessState: recordedProcessState(ref.provider_connection),
      hasProviderConnection: Boolean(ref.provider_connection),
    } : null,
    hasPendingTurnControl: Boolean(turnControl && turnControl.status !== "completed"),
    turnControlWorkAttemptMatches: Boolean(
      turnControl && turnControl.status !== "completed"
      && entry.work_attempt_id === turnControl.work_attempt_id,
    ),
    reconciliation: {
      exitTimestampsMs: [...(entry.reconciliation?.exit_timestamps_ms ?? [])],
      nextRestartAtMs: typeof entry.reconciliation?.next_restart_at_ms === "number"
        ? entry.reconciliation.next_restart_at_ms
        : null,
    },
    isRental: entry.id.startsWith("supervised_rental_"),
  };
}

function scheduleRecoveryUpdate(
  volatile: VolatileConvergeBookkeeping,
  nowMs: number,
  delayMs: number,
  hasPendingTimer = volatile.recoveryDueAtMs !== null,
): { volatile: VolatileConvergeBookkeeping; command: ScheduleRecoveryCommand | null } {
  const clampedDelayMs = Math.max(1, delayMs);
  const dueAtMs = nowMs + clampedDelayMs;
  // Keep whichever wake-up is sooner so a slow re-check never delays a
  // restart that another path scheduled for earlier.
  if (hasPendingTimer && (volatile.recoveryDueAtMs === null || volatile.recoveryDueAtMs <= dueAtMs)) {
    return { volatile, command: null };
  }
  return {
    volatile: { ...volatile, recoveryDueAtMs: dueAtMs },
    command: {
      kind: "schedule_recovery",
      delayMs: clampedDelayMs,
      dueAtMs,
      replaceExisting: hasPendingTimer,
    },
  };
}

function decidePredecessorBlocked(
  persisted: PersistedConvergeControl,
  volatile: VolatileConvergeBookkeeping,
  nowMs: number,
  errorMessage: string,
  hasPendingTimer?: boolean,
): ConvergeDecision {
  const needsTransition = persisted.observedState !== "recovering"
    || persisted.condition !== "coordination_blocked"
    || persisted.lastError !== UNPROVEN_PREDECESSOR_CAUSE;
  const checks = volatile.unattachableRechecks + 1;
  const delayMs = computeCappedBackoffMs(
    checks,
    UNATTACHABLE_GENERATION_RECHECK_MS,
    UNATTACHABLE_GENERATION_RECHECK_MAX_MS,
  );
  const scheduled = scheduleRecoveryUpdate(
    { ...volatile, unattachableRechecks: checks },
    nowMs,
    delayMs,
    hasPendingTimer,
  );
  const commands: ConvergeCommand[] = [
    { kind: "log_unproven_predecessor", message: errorMessage },
    ...(scheduled.command ? [scheduled.command] : []),
  ];
  return {
    volatile: scheduled.volatile,
    ...(needsTransition ? {
      transition: {
        observedState: "recovering",
        condition: "coordination_blocked",
        cause: UNPROVEN_PREDECESSOR_CAUSE,
        actor: "daemon-convergence",
      },
    } : {}),
    commands,
  };
}

/**
 * Pure decision function for `ProviderExecutionCoordinator.converge()`.
 * Performs no I/O, reads no clocks, schedules no timers, and holds no secrets.
 */
export function decide(state: ConvergeState, event: ConvergeEvent): ConvergeDecision {
  const { persisted, volatile } = state;

  switch (event.kind) {
    case "request_arrived": {
      if (persisted.desiredState !== "running") {
        // A stopped or paused agent clears reminder suppression and starts its
        // next room-only workspace attempt at the shortest wait.
        return {
          volatile: {
            ...volatile,
            failedLaunchAdmissionKey: null,
            workspaceRepositoryRetries: 0,
          },
          commands: [],
        };
      }
      if (event.requestKind === "owned") {
        // Owned lifecycle/terminal/timer work can retry even identical launch inputs.
        return {
          volatile: { ...volatile, failedLaunchAdmissionKey: null },
          commands: [],
        };
      }
      return { volatile, commands: [] };
    }

    case "rental_permission_rejected": {
      return {
        volatile,
        transition: {
          observedState: "failed",
          condition: "quarantined",
          cause: event.reason,
          actor: "daemon-convergence",
        },
        commands: [{ kind: "stop_delivery" }],
      };
    }

    case "running_gate_checked": {
      if (persisted.desiredState !== "running" || persisted.condition === "quarantined") {
        return { volatile, commands: [] };
      }
      if (event.requiresGrant && !event.hasGrant) {
        return { volatile, commands: [] };
      }
      if (persisted.deliveryMode === "daemon_inbox" && !event.hasMatchingInboxCursor) {
        return { volatile, commands: [] };
      }
      if (event.requiresGrant && !event.grantFresh) {
        return { volatile, commands: [] };
      }
      if (persisted.observedState === "failed") {
        const exitsInWindow = persisted.reconciliation.exitTimestampsMs
          .filter((at) => at >= event.nowMs - CRASH_LOOP_WINDOW_MS).length;
        if (exitsInWindow >= CRASH_LOOP_EXIT_LIMIT) {
          return {
            volatile,
            transition: {
              observedState: "failed",
              condition: "quarantined",
              cause: CRASH_LOOP_QUARANTINE_CAUSE,
              actor: "daemon-convergence",
            },
            commands: [],
          };
        }
        const restartAt = persisted.reconciliation.nextRestartAtMs;
        if (restartAt !== null && restartAt > event.nowMs) {
          const scheduled = scheduleRecoveryUpdate(
            volatile,
            event.nowMs,
            restartAt - event.nowMs,
            event.hasPendingTimer,
          );
          return {
            volatile: scheduled.volatile,
            commands: scheduled.command ? [scheduled.command] : [],
          };
        }
      }
      return {
        volatile,
        commands: [{ kind: "proceed_running" }],
      };
    }

    case "attach_in_progress": {
      const scheduled = scheduleRecoveryUpdate(
        volatile,
        event.nowMs,
        CURSOR_ATTACH_RETRY_MS,
        event.hasPendingTimer,
      );
      return {
        volatile: scheduled.volatile,
        transition: {
          observedState: "recovering",
          condition: "none",
          cause: CURSOR_ATTACH_IN_PROGRESS_CAUSE,
          actor: "daemon-convergence",
        },
        commands: scheduled.command ? [scheduled.command] : [],
      };
    }

    case "attached_handle_evaluated": {
      const transition: DurableTransitionEffect | undefined = !event.typed
        && persisted.observedState !== event.handleObservedState
        ? {
            observedState: event.handleObservedState,
            condition: persisted.condition,
            cause: "reattached durable provider handle",
            actor: "daemon-convergence",
          }
        : undefined;
      // A typed lane takes its state from execution facts, not from the handle.
      // The one exception runs toward failure only: no turn can run on a handle
      // that itself reports failed or stopped, and the fact that should have
      // failed the entry can be lost, which left the agent looking alive and
      // receiving nothing. Cursor is excluded: its handle ends only with a
      // committed terminal, which the exit path already owns.
      const typedHandleEnded = event.typed
        && persisted.provider !== "cursor"
        && (event.handleObservedState === "failed" || event.handleObservedState === "stopped");
      const isTerminal = (event.typed && (
        persisted.observedState === "failed"
        || persisted.observedState === "stopped"
        || typedHandleEnded
      )) || (!event.typed && (
        event.handleObservedState === "failed"
        || event.handleObservedState === "stopped"
        || (event.handleObservedState === "idle" && !event.requiresGrant)
      ));
      if (isTerminal) {
        let nextVolatile = volatile;
        if (turnInFlight(event.inboxHead)) {
          const existingDeadline = volatile.retirementDeadline
            && volatile.retirementDeadline.handleToken === event.handleToken
            ? volatile.retirementDeadline.dueAtMs
            : null;
          const deadline = existingDeadline ?? event.nowMs + RETIREMENT_SETTLEMENT_WAIT_MS;
          nextVolatile = {
            ...nextVolatile,
            retirementDeadline: { handleToken: event.handleToken, dueAtMs: deadline },
          };
          if (event.nowMs < deadline) {
            const scheduled = scheduleRecoveryUpdate(
              nextVolatile,
              event.nowMs,
              deadline - event.nowMs,
              event.hasPendingTimer,
            );
            return {
              volatile: scheduled.volatile,
              ...(transition ? { transition } : {}),
              commands: scheduled.command ? [scheduled.command] : [],
            };
          }
        }
        const heldByRoomRefusal = typedHandleEnded
          && persisted.observedState !== "failed"
          && persisted.observedState !== "stopped"
          && event.roomRefusesAccess;
        if (heldByRoomRefusal) {
          return {
            volatile: nextVolatile,
            ...(transition ? { transition } : {}),
            commands: [],
          };
        }
        return {
          volatile: nextVolatile,
          ...(transition ? { transition } : {}),
          commands: [{
            kind: "fence_terminal_handle",
            actionId: `manifest:${persisted.agentId}:reattached-terminal:${persisted.providerRef?.executionGenerationId ?? "unknown"}`,
          }],
        };
      }
      if (persisted.desiredState === "running" && persisted.deliveryMode === "daemon_inbox") {
        return {
          volatile,
          ...(transition ? { transition } : {}),
          commands: [{ kind: "ensure_delivery_and_archive" }],
        };
      }
      return {
        volatile,
        ...(transition ? { transition } : {}),
        commands: [],
      };
    }

    case "rehydration_admission_checked": {
      if (event.requestKind === "rehydration"
        && event.admissionKey !== null
        && volatile.failedLaunchAdmissionKey !== null
        && event.admissionKey === volatile.failedLaunchAdmissionKey) {
        return { volatile, commands: [] };
      }
      return { volatile, commands: [{ kind: "proceed_launch_setup" }] };
    }

    case "launch_failed": {
      return {
        volatile: event.admissionKey
          ? { ...volatile, failedLaunchAdmissionKey: event.admissionKey }
          : volatile,
        commands: [],
      };
    }

    case "launch_dispatched": {
      return {
        volatile: { ...volatile, failedLaunchAdmissionKey: null },
        commands: [],
      };
    }

    case "launch_preconditions_checked": {
      const resumableCursorLane = isResumableCursorLane(persisted);
      if (resumableCursorLane && !event.hasActiveExecution && event.inboxHeadBlocked) {
        return {
          volatile,
          transition: {
            observedState: "recovering",
            condition: "coordination_blocked",
            cause: event.inboxHeadLastError ?? CURSOR_BLOCKED_DELIVERY_FALLBACK_CAUSE,
            actor: "daemon-convergence",
          },
          commands: [],
        };
      }
      if (event.hasActiveExecution && !resumableCursorLane) {
        // Repeated checks must not rewrite the manifest or append a notice each
        // time; only the first observation of this state is durable news.
        const needsTransition = persisted.observedState !== "recovering"
          || persisted.condition !== "coordination_blocked"
          || persisted.lastError !== UNATTACHABLE_GENERATION_CAUSE;
        const checks = volatile.unattachableRechecks + 1;
        const delayMs = computeCappedBackoffMs(
          checks,
          UNATTACHABLE_GENERATION_RECHECK_MS,
          UNATTACHABLE_GENERATION_RECHECK_MAX_MS,
        );
        const scheduled = scheduleRecoveryUpdate(
          { ...volatile, unattachableRechecks: checks },
          event.nowMs,
          delayMs,
          event.hasPendingTimer,
        );
        return {
          volatile: scheduled.volatile,
          ...(needsTransition ? {
            transition: {
              observedState: "recovering",
              condition: "coordination_blocked",
              cause: UNATTACHABLE_GENERATION_CAUSE,
              actor: "daemon-convergence",
            },
          } : {}),
          commands: scheduled.command ? [scheduled.command] : [],
        };
      }
      const ref = persisted.providerRef;
      if (ref && ref.recordedProcessState !== "none" && event.predecessorHasTerminalWithoutWitness) {
        if (ref.recordedProcessState === "incomplete") {
          return decidePredecessorBlocked(
            persisted,
            volatile,
            event.nowMs,
            INCOMPLETE_PROCESS_REF_ERROR,
            event.hasPendingTimer,
          );
        }
        if (event.predecessorExactStopAvailable) {
          return {
            volatile,
            commands: [{ kind: "retire_unproven_predecessor" }],
          };
        }
      }
      return {
        volatile: { ...volatile, unattachableRechecks: 0 },
        commands: [{
          kind: "proceed_after_predecessor",
          reusesActiveCursorExecution: Boolean(resumableCursorLane && event.hasActiveExecution),
          needsTurnControlCompletion: !event.hasActiveExecution && persisted.hasPendingTurnControl,
        }],
      };
    }

    case "predecessor_retired": {
      const resumableCursorLane = isResumableCursorLane(persisted);
      return {
        volatile: { ...volatile, unattachableRechecks: 0 },
        commands: [{
          kind: "proceed_after_predecessor",
          reusesActiveCursorExecution: Boolean(resumableCursorLane && event.hasActiveExecution),
          needsTurnControlCompletion: !event.hasActiveExecution && persisted.hasPendingTurnControl,
        }],
      };
    }

    case "predecessor_retire_failed": {
      return decidePredecessorBlocked(
        persisted,
        volatile,
        event.nowMs,
        event.errorMessage,
        event.hasPendingTimer,
      );
    }

    case "capabilities_evaluated": {
      if (event.supportedDeliveryModes !== null
        && !event.supportedDeliveryModes.includes(persisted.deliveryMode)) {
        return {
          volatile,
          transition: {
            observedState: "failed",
            condition: "coordination_blocked",
            cause: `${event.providerLabel} does not support ${persisted.deliveryMode} room delivery.`,
            actor: "daemon-convergence",
          },
          commands: [],
        };
      }
      return {
        volatile,
        commands: [{
          kind: "prepare_workspace_and_transition",
          resumed: Boolean(persisted.providerRef && event.supportsResume),
        }],
      };
    }

    case "workspace_repository_checked": {
      if (event.outcome === "failed") {
        const retries = volatile.workspaceRepositoryRetries + 1;
        const delayMs = computeCappedBackoffMs(
          retries,
          WORKSPACE_REPOSITORY_RETRY_MS,
          WORKSPACE_REPOSITORY_RETRY_MAX_MS,
        );
        const scheduled = scheduleRecoveryUpdate(
          { ...volatile, workspaceRepositoryRetries: retries },
          event.nowMs,
          delayMs,
          event.hasPendingTimer,
        );
        return {
          volatile: scheduled.volatile,
          transition: {
            observedState: "failed",
            condition: "coordination_blocked",
            cause: `Could not prepare the agent's room-only workspace (${event.errorMessage ?? "unknown error"}). Retrying in ${Math.round(delayMs / 1000)} seconds.`,
            actor: "daemon-convergence",
          },
          commands: scheduled.command ? [scheduled.command] : [],
        };
      }
      const nextVolatile = event.outcome === "ok"
        ? { ...volatile, workspaceRepositoryRetries: 0 }
        : volatile;
      return {
        volatile: nextVolatile,
        transition: {
          observedState: persisted.providerRef ? "recovering" : "starting",
          condition: "none",
          cause: persisted.providerRef
            ? "recovering durable provider continuation"
            : "starting daemon-owned provider",
          actor: "daemon-convergence",
        },
        commands: [{ kind: "proceed_spawn" }],
      };
    }

    case "launch_completed_without_grant": {
      return {
        volatile,
        transition: {
          observedState: event.handleObservedState,
          condition: "none",
          cause: event.resumed
            ? "provider resumed under daemon authority"
            : "provider launched under daemon authority",
          actor: "daemon-convergence",
        },
        commands: [],
      };
    }

    case "stop_requested": {
      if (!event.hasLiveHandle && event.exitSettling) {
        return { volatile, commands: [] };
      }
      const ref = persisted.providerRef;
      if (!event.hasLiveHandle && ref?.providerConnectionKind === "cursor_cli" && event.hasStopRefCapability) {
        return {
          volatile,
          commands: [{ kind: "stop_unattached_exact_ref", alreadySettledTerminal: false }],
        };
      }
      if (!event.hasLiveHandle && ref) {
        if (persisted.provider === "open-model" || ref.providerConnectionKind === "opencode_server") {
          if (event.executionTerminal === "missing_generation") {
            return {
              volatile,
              commands: [{
                kind: "fail_stop",
                errorMessage: "Provider exact-reference stop has no matching durable execution generation.",
              }],
            };
          }
          if (event.executionTerminal === "witnessed") {
            return {
              volatile,
              commands: [{ kind: "finalize_witnessed_stop" }],
            };
          }
          if (event.hasExactProcessStopCapability && event.hasStopRefCapability) {
            return {
              volatile,
              commands: [{
                kind: "stop_unattached_exact_ref",
                alreadySettledTerminal: event.executionTerminal === "unwitnessed",
              }],
            };
          }
          return {
            volatile,
            commands: [{ kind: "attach_for_stop" }],
          };
        }
        if (ref.recordedProcessState !== "none" && event.executionTerminal === "unwitnessed") {
          if (ref.recordedProcessState === "incomplete") {
            return {
              volatile,
              commands: [{ kind: "fail_stop", errorMessage: INCOMPLETE_PROCESS_REF_ERROR }],
            };
          }
          if (event.hasExactProcessStopCapability && event.hasStopRefCapability) {
            return {
              volatile,
              commands: [{ kind: "stop_unattached_exact_ref", alreadySettledTerminal: true }],
            };
          }
        }
        return {
          volatile,
          commands: [{ kind: "attach_for_stop" }],
        };
      }
      if (event.hasLiveHandle) {
        return {
          volatile,
          transition: {
            observedState: "stopping",
            condition: persisted.condition,
            cause: `desired state changed to ${persisted.desiredState}`,
            actor: "daemon-convergence",
          },
          commands: [{ kind: "stop_handle" }],
        };
      }
      return {
        volatile,
        transition: {
          observedState: persisted.desiredState === "paused" ? "paused" : "stopped",
          condition: "none",
          cause: STOPPED_WITHOUT_PROVIDER_CAUSE,
          actor: "daemon-convergence",
        },
        commands: [],
      };
    }

    case "stop_unattached_exact_ref_prepared": {
      const targetState = persisted.desiredState === "paused" ? "paused" : "stopped";
      const settledAtTarget = event.alreadySettledTerminal
        && persisted.observedState === targetState
        && persisted.condition === "none";
      return {
        volatile,
        ...(!settledAtTarget ? {
          transition: {
            observedState: "stopping",
            condition: persisted.condition,
            cause: `desired state changed to ${persisted.desiredState}`,
            actor: "daemon-convergence",
          },
        } : {}),
        commands: [{ kind: "execute_stop_ref", settledAtTarget }],
      };
    }

    case "stop_after_attach_evaluated": {
      if (event.hasLiveHandle) {
        return {
          volatile,
          transition: {
            observedState: "stopping",
            condition: persisted.condition,
            cause: `desired state changed to ${persisted.desiredState}`,
            actor: "daemon-convergence",
          },
          commands: [{ kind: "stop_handle" }],
        };
      }
      return {
        volatile,
        transition: {
          observedState: persisted.desiredState === "paused" ? "paused" : "stopped",
          condition: "none",
          cause: STOPPED_WITHOUT_PROVIDER_CAUSE,
          actor: "daemon-convergence",
        },
        commands: [],
      };
    }

    case "stop_without_provider_converged": {
      return {
        volatile,
        transition: {
          observedState: persisted.desiredState === "paused" ? "paused" : "stopped",
          condition: "none",
          cause: STOPPED_WITHOUT_PROVIDER_CAUSE,
          actor: "daemon-convergence",
        },
        commands: [],
      };
    }

    case "recovery_schedule_requested": {
      const scheduled = scheduleRecoveryUpdate(
        volatile,
        event.nowMs,
        event.delayMs,
        event.hasPendingTimer,
      );
      return {
        volatile: scheduled.volatile,
        commands: scheduled.command ? [scheduled.command] : [],
      };
    }

    case "recovery_timer_fired":
    case "recovery_cleared": {
      return {
        volatile: { ...volatile, recoveryDueAtMs: null },
        commands: [],
      };
    }
  }
}
