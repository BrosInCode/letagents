import { ApiError } from "../../../shared/api/core.mjs";
import type { TrackerProvider } from "../../../shared/ticket-connectors.mjs";
import type { LocatedWorkItem } from "../connectors/work-items.js";
import type { TrackerConnectionRow } from "../connectors/store.js";
import type { WorkflowEffect } from "../db/types/effects.js";
import type { ReserveResult, SubmitTrackerEffectInput } from "../workflow-effects/broker.js";

/**
 * Ticket kinds write through the effect journal (`workflow_effects`), like
 * every other Jira or Linear write. Two guards come first (threat model 3):
 * 1. The ticket must be inside the room's tracker filter, read the same way
 *    `work_items.get` reads it (`not_found` otherwise).
 * 2. The write runs with the viewer's own tracker connection only when it is
 *    on the same site as the room filter's connection (`site_key`). Otherwise
 *    it runs with the room filter's connection, and room policy asks a room
 *    admin first.
 */
export interface TicketIntentDeps {
  /** The ticket inside the room filter, or ApiError `not_found` / `no_source`. */
  locate(roomId: string, key: string): Promise<LocatedWorkItem>;
  getConnection(id: string): Promise<TrackerConnectionRow | null>;
  findConnectionBySite(accountId: string, provider: TrackerProvider, siteKey: string): Promise<TrackerConnectionRow | null>;
  reserve(input: SubmitTrackerEffectInput): Promise<ReserveResult>;
  drive(reserved: ReserveResult): Promise<WorkflowEffect>;
  getEffect(id: string): Promise<WorkflowEffect | null>;
}

export interface TicketWritePlan {
  provider: "jira" | "linear";
  key: string;
  connectionId: string;
  connectionAccountId: string;
  /** True when the viewer's own connection runs the write. */
  own: boolean;
}

/**
 * Where a ticket write may run, decided again each time it runs: a filter
 * or a connection can change while an intent waits.
 * `accountId`: the proposing person; null for an agent, which has no
 * tracker connection of its own.
 */
export async function planTicketWrite(
  deps: TicketIntentDeps,
  input: { roomId: string; key: string; accountId: string | null },
): Promise<TicketWritePlan> {
  const located = await deps.locate(input.roomId, input.key);
  const roomConnection = await deps.getConnection(located.connectionId);
  if (!roomConnection || roomConnection.status !== "active" || roomConnection.provider !== located.provider
    || (located.provider !== "jira" && located.provider !== "linear")) {
    throw new ApiError("no_source", "The room's tracker connection needs attention in Settings → Connectors.");
  }
  const provider = located.provider;
  const own = input.accountId
    ? roomConnection.account_id === input.accountId
      ? roomConnection
      : await deps.findConnectionBySite(input.accountId, provider, roomConnection.site_key)
    : null;
  if (own && own.status === "active" && own.provider === provider && own.site_key === roomConnection.site_key) {
    return { provider, key: located.key, connectionId: own.id, connectionAccountId: own.account_id, own: true };
  }
  return { provider, key: located.key, connectionId: roomConnection.id, connectionAccountId: roomConnection.account_id, own: false };
}

export function ticketEffectRequest(input: {
  roomId: string;
  intentId: string;
  kind: "ticket.transition" | "ticket.comment";
  payload: { toStatus?: string; body?: string };
  plan: TicketWritePlan;
  actorLabel: string;
}): SubmitTrackerEffectInput {
  return {
    room_id: input.roomId,
    task_id: null,
    connection_id: input.plan.connectionId,
    connection_account_id: input.plan.connectionAccountId,
    provider: input.plan.provider,
    key: input.plan.key,
    // One journal row per intent: a repeated run reads the first one back.
    idempotency_key: `api_intent:${input.intentId}`,
    actor_label: input.actorLabel,
    action: input.kind === "ticket.transition"
      ? { kind: "tracker_transition", to_status: input.payload.toStatus ?? "" }
      : { kind: "tracker_comment", body: input.payload.body ?? "" },
  };
}

export type TicketEffectOutcome =
  | { state: "done"; result: Record<string, unknown> }
  | { state: "failed"; error: string }
  | { state: "running" };

/**
 * The intent's state from its journal row. A failed write with attempts
 * left, or an ambiguous one, is still `running`: the journal sweep retries
 * or reconciles it, and the next read of the intent sees the end.
 */
export function ticketEffectOutcome(effect: WorkflowEffect): TicketEffectOutcome {
  const key = typeof effect.request_payload.key === "string" ? effect.request_payload.key : null;
  if (effect.state === "succeeded") {
    return { state: "done", result: { key, ...(effect.external_url ? { url: effect.external_url } : {}) } };
  }
  if (effect.quarantined_at) return { state: "failed", error: effect.quarantine_reason ?? "The tracker write was refused." };
  if (effect.state === "failed" && effect.attempt_count >= effect.max_attempts) {
    return { state: "failed", error: effect.last_error ?? "The tracker refused the change." };
  }
  return { state: "running" };
}

/** The production wiring: the work item reader, the connection store and the effect broker. */
export async function createDefaultTicketIntentDeps(): Promise<TicketIntentDeps | null> {
  const [{ getDefaultWorkItemsReader }, { trackerConnectionStore }, { workflowEffectBroker }] = await Promise.all([
    import("../connectors/work-items.js"),
    import("../connectors/store.js"),
    import("../workflow-effects/runtime.js"),
  ]);
  const reader = getDefaultWorkItemsReader();
  // No connector key on this server: no tracker connection can exist.
  if (!reader) return null;
  return {
    locate: (roomId, key) => reader.locate(roomId, { key }),
    getConnection: (id) => trackerConnectionStore.get(id),
    findConnectionBySite: (accountId, provider, siteKey) => trackerConnectionStore.findBySite(accountId, provider, siteKey),
    reserve: (input) => workflowEffectBroker.reserveTrackerEffect(input),
    drive: (reserved) => workflowEffectBroker.driveTrackerEffect(reserved),
    getEffect: (id) => workflowEffectBroker.getEffect(id),
  };
}
