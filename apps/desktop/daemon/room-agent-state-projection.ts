import { projectDeliveryReceipts, projectDeliveryTurn } from "./manifest-view-projection.js";
import type {
  ProviderContinuationRepair,
  SupervisedInboxReceiptWithTimeline,
} from "./supervised-agent-inbox-store.js";
import type { DaemonManifestEntry, DaemonManifestEntryView } from "./types.js";
import type { WorkerSessionBinding } from "./worker-binding-store.js";

export type RoomAgentLiveHandle = {
  workAttemptId: string;
  providerContinuationId: string | null;
};

export type RoomAgentIngressHealth = {
  room_id: string;
  state: "starting" | "observing" | "backoff" | "blocked" | "stopped";
  detail: string | null;
  execution_generation_id: string;
};

export type RoomAgentActiveTurn = Parameters<typeof projectDeliveryTurn>[1];

/**
 * All facts needed to build the ephemeral manifest view. The authority owner
 * resolves durable records and process-only credentials before calling this
 * module; projection itself performs no I/O and owns no clocks or timers.
 */
export type RoomAgentStateProjectionInput = {
  entry: DaemonManifestEntry;
  binding: WorkerSessionBinding | null;
  credentialAvailable: boolean;
  currentHostGrantAvailable: boolean;
  liveHandle: RoomAgentLiveHandle | null;
  ingressHealth: RoomAgentIngressHealth | null;
  continuationRepair: Pick<ProviderContinuationRepair, "inbox_item_id" | "phase"> | null;
  receipts: readonly SupervisedInboxReceiptWithTimeline[];
  activeTurn: RoomAgentActiveTurn;
  nowMs: number;
  workplaceLivenessStaleAfterMs: number;
  nativeLivenessStaleAfterMs: number;
};

type DeliveryAuthorityFacts = Pick<
  RoomAgentStateProjectionInput,
  "entry" | "binding" | "credentialAvailable" | "liveHandle"
>;

export function bindingMatchesRoomAgentGeneration(
  entry: DaemonManifestEntry,
  binding: WorkerSessionBinding | null,
): binding is WorkerSessionBinding {
  return Boolean(
    binding
    && entry.desired_state === "running"
    && ["starting", "working", "idle", "recovering"].includes(entry.observed_state)
    && binding.room_id === entry.room_id
    && binding.work_attempt_id === entry.work_attempt_id
    && binding.execution_generation_id === entry.provider_ref?.execution_generation_id,
  );
}

/** Allows the authority owner to avoid asking delivery for an inapplicable active turn. */
export function hasExactRoomAgentDeliveryOwner(input: DeliveryAuthorityFacts): boolean {
  const hasCurrentBinding = bindingMatchesRoomAgentGeneration(input.entry, input.binding);
  return Boolean(
    hasCurrentBinding
    && input.credentialAvailable
    && input.liveHandle
    && input.liveHandle.workAttemptId === input.entry.work_attempt_id
    && input.liveHandle.providerContinuationId === input.entry.provider_ref?.provider_continuation_id
    && input.entry.provider_ref?.execution_generation_id === input.binding?.execution_generation_id,
  );
}

/** Build the wire-compatible, ephemeral room-agent view from already-resolved facts. */
export function projectRoomAgentManifestEntry(
  input: RoomAgentStateProjectionInput,
): DaemonManifestEntryView {
  const {
    entry,
    binding,
    credentialAvailable,
    currentHostGrantAvailable,
    liveHandle,
    ingressHealth,
    continuationRepair,
    receipts,
    activeTurn,
    nowMs,
  } = input;
  const bindingMatchesCurrentGeneration = bindingMatchesRoomAgentGeneration(entry, binding);

  // The binding store is advanced by accepted, exact wait publications. It
  // is the live workplace clock; the manifest timestamp only records the
  // original bind and deliberately is not rewritten for every long poll.
  const workplaceLiveness = bindingMatchesCurrentGeneration
    ? {
        state: "reachable" as const,
        observed_at: binding.updated_at,
        detail: entry.workplace_liveness?.detail ?? "supervised worker session bound",
      }
    : entry.workplace_liveness;
  const activeContinuationRepair = continuationRepair && !["committed", "failed"].includes(continuationRepair.phase)
    ? continuationRepair
    : null;
  const deliveryReceipts = projectDeliveryReceipts(receipts, activeContinuationRepair?.inbox_item_id ?? null);
  const nonfinal = receipts.filter((receipt) => ![
    "acknowledged",
    "acknowledged_no_reply",
    "acknowledged_failed",
    "cancelled_by_room_move",
    "cancelled_by_user",
  ].includes(receipt.state));
  const head = nonfinal[0] ?? null;
  const blocked = receipts.find((receipt) => receipt.receipt_state === "blocked") ?? null;
  const hasCurrentBinding = bindingMatchesCurrentGeneration;
  const waitingForDesktopGrant = entry.delivery_mode === "daemon_inbox" && !currentHostGrantAvailable;
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
      : !hasCurrentBinding || !credentialAvailable
        ? {
            state: "waiting_for_desktop_credentials" as const,
            pending_count: nonfinal.length,
            blocked_by_message_id: blocked?.source_message_id ?? null,
            detail: waitingForDesktopGrant || hasCurrentBinding
              ? "Waiting for desktop credential handoff."
              : "A current worker binding is required before delivery can start.",
          }
        : blocked
          ? {
              state: "blocked" as const,
              pending_count: nonfinal.length,
              blocked_by_message_id: blocked.source_message_id,
              detail: blocked.last_error ?? "An earlier delivery needs attention.",
            }
          : nonfinal.length
            ? {
                state: "queued" as const,
                pending_count: nonfinal.length,
                blocked_by_message_id: null,
                detail: "Room delivery is queued.",
              }
            : {
                state: "empty" as const,
                pending_count: 0,
                blocked_by_message_id: null,
                detail: null,
              };
  const hasLiveDeliveryOwner = hasExactRoomAgentDeliveryOwner(input);
  const connection = hasLiveDeliveryOwner
    ? {
        state: "connected" as const,
        observed_at: binding!.updated_at,
        detail: "Live provider and exact worker binding are available.",
      }
    : entry.desired_state === "running"
      && ["starting", "recovering"].includes(entry.observed_state)
      && (Boolean(liveHandle) || entry.condition === "none")
      ? {
          state: "reconnecting" as const,
          observed_at: entry.workplace_liveness?.observed_at ?? null,
          detail: waitingForDesktopGrant
            ? "Waiting for desktop credential handoff."
            : "Restoring the provider and exact worker binding.",
        }
      : {
          state: "disconnected" as const,
          observed_at: entry.native_liveness?.observed_at ?? null,
          detail: liveHandle
            ? "The current worker binding or credential is unavailable."
            : "No live provider handle.",
        };
  const ingressMatches = Boolean(
    ingressHealth
    && ingressHealth.room_id === entry.room_id
    && ingressHealth.execution_generation_id === entry.provider_ref?.execution_generation_id,
  );
  const hasLiveIngressOwner = Boolean(hasCurrentBinding && credentialAvailable && ingressMatches);
  const ingress = hasLiveIngressOwner
    ? {
        state: ingressHealth!.state,
        observed_at: ingressHealth!.state === "stopped" ? null : binding!.updated_at,
        detail: ingressHealth!.detail,
      }
    : {
        state: "stopped" as const,
        observed_at: entry.native_liveness?.observed_at ?? null,
        detail: hasCurrentBinding && credentialAvailable
          ? "The room observation loop has not started."
          : "Room observation is stopped because its exact binding or credential is unavailable.",
      };
  const projectedTurn = activeContinuationRepair
    ? {
        state: "idle" as const,
        inbox_item_id: head?.inbox_item_id ?? null,
        source_message_id: head?.source_message_id ?? null,
        provider_turn_id: null,
        detail: "Conversation restoration is happening before any model turn starts.",
      }
    : projectDeliveryTurn(head, hasLiveDeliveryOwner ? activeTurn : null);
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
    workplace_liveness: deriveLiveness(
      workplaceLiveness,
      ["reachable"],
      input.workplaceLivenessStaleAfterMs,
      nowMs,
    ) as DaemonManifestEntry["workplace_liveness"],
    native_liveness: deriveLiveness(
      entry.native_liveness,
      ["active", "idle"],
      input.nativeLivenessStaleAfterMs,
      nowMs,
    ) as DaemonManifestEntry["native_liveness"],
    worker_binding: bindingMatchesCurrentGeneration
      ? {
          agent_session_id: binding.agent_session_id,
          work_attempt_id: binding.work_attempt_id,
          execution_generation_id: binding.execution_generation_id,
          updated_at: binding.updated_at,
        }
      : null,
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

function deriveLiveness<T extends string>(
  axis: { state: T; observed_at: string | null; detail: string | null } | undefined,
  staleStates: readonly string[],
  staleAfterMs: number,
  nowMs: number,
) {
  if (!axis?.observed_at || !staleStates.includes(axis.state)) return axis;
  const observed = Date.parse(axis.observed_at);
  return Number.isFinite(observed) && nowMs - observed > staleAfterMs
    ? { ...axis, state: "stale" as const }
    : axis;
}
