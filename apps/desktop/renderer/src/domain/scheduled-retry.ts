import type { DesktopRoomAgentDeliveryReceipt, DesktopRoomAgentScheduledRetry, DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import { supervisedAgentDisplayLabel } from "./codenames";

/**
 * An agent's automatic attempt that waits for its time, as its owner sees it.
 * After a short provider fault the agent tries the unfinished work again by
 * itself, a few times, with a longer wait each time. After a turn that ended
 * without a reply it tries again once. The time is the one the background
 * service saved, so it is right after the app or the service restarts:
 * nothing here counts from a timer of its own.
 */
export interface AgentScheduledRetry extends DesktopRoomAgentScheduledRetry {
  /** The room message the failed work began with. Null when that receipt is no longer kept. */
  forMessageId: string | null;
  /** Names the waiting attempt for Try now and Stop trying. It is not a room message. */
  sourceMessageId: string;
  /** Where the attempt stands in the agent's queue. Messages after it wait for it. */
  fifoSequence: number;
}

type FollowUpReceipt = Pick<DesktopRoomAgentDeliveryReceipt, "state" | "followUp" | "sourceMessageId" | "fifoSequence">;

/** The attempt that waits, or null. An agent has at most one: it is the head of its queue. */
export function agentScheduledRetry(receipts: readonly FollowUpReceipt[] | undefined): AgentScheduledRetry | null {
  const receipt = (receipts ?? []).find((candidate) => candidate.state === "pending" && candidate.followUp?.scheduled);
  return receipt?.followUp?.scheduled
    ? { ...receipt.followUp.scheduled, forMessageId: receipt.followUp.forMessageId, sourceMessageId: receipt.sourceMessageId, fifoSequence: receipt.fifoSequence }
    : null;
}

/** Whether this receipt is a message that waits for the automatic attempt to be done. */
export function waitsBehindScheduledRetry(
  receipt: Pick<DesktopRoomAgentDeliveryReceipt, "state" | "fifoSequence" | "followUp">,
  retry: Pick<AgentScheduledRetry, "fifoSequence"> | null,
): boolean {
  return Boolean(retry) && receipt.state === "pending" && !receipt.followUp && receipt.fifoSequence > retry!.fifoSequence;
}

/** The time left, rounded up to a whole second: "25 s", "1 min 40 s", "10 min". Nothing is left at or after the time. */
export function retryWaitLabel(msLeft: number): string | null {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return null;
  const seconds = Math.ceil(msLeft / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `${seconds} s`;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

type RetryTime = Pick<DesktopRoomAgentScheduledRetry, "atMs" | "attempt" | "attempts">;

function attemptLabel(retry: RetryTime): string {
  return retry.attempts === 1 ? "the only automatic attempt" : `attempt ${retry.attempt} of ${retry.attempts}`;
}

/**
 * "Trying again in 1 min 40 s (attempt 2 of 3)". At or after its time nothing
 * may have started yet: dispatch can be paused, or the turn can wait to be
 * admitted. So it then says "About to try again", which is true until the
 * turn starts and the agent shows as working.
 */
export function scheduledRetryLabel(retry: RetryTime, nowMs: number): string {
  return scheduledRetryLabelParts(retry, nowMs).join(" ");
}

/**
 * The same label in its two parts: "Trying again in 1 min 40 s" and "(attempt 2 of 3)". A narrow receipt may wrap
 * the label between them, and nowhere else: a number stays with its unit.
 */
export function scheduledRetryLabelParts(retry: RetryTime, nowMs: number): [string, string] {
  const left = retryWaitLabel(retry.atMs - nowMs);
  return [left ? `Trying again in ${left}` : "About to try again", `(${attemptLabel(retry)})`];
}

/** The same for a place that does not count down, with a clock time: "Trying again at 14:32 (attempt 2 of 3)". */
export function scheduledRetryClockLabel(
  retry: RetryTime,
  nowMs: number,
  clock: (atMs: number) => string = (atMs) => new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): string {
  return `${retry.atMs > nowMs ? `Trying again at ${clock(retry.atMs)}` : "About to try again"} (${attemptLabel(retry)})`;
}

/** What the agent tries again after. */
export function scheduledRetryCause(retry: Pick<DesktopRoomAgentScheduledRetry, "kind">): string {
  return retry.kind === "no_reply" ? "The last turn ended without a reply." : "A provider problem stopped the last turn.";
}

/** What happens when this attempt fails too. */
export function scheduledRetryOutcome(retry: Pick<DesktopRoomAgentScheduledRetry, "attempt" | "attempts" | "kind">): string {
  // A turn that ends without a reply again is not tried a third time, and nothing waits for the owner.
  if (retry.kind === "no_reply") return "If it ends without a reply again, the agent stops. Send it a message to continue.";
  return retry.attempt >= retry.attempts
    ? "This is the last automatic attempt. If it fails, the agent stops and waits for you."
    : `If all ${retry.attempts} attempts fail, the agent stops and waits for you.`;
}

/** What the agent's inspector says while the agent waits. It is read again each second, so that it is right at the time. */
export function scheduledRetryDetail(retry: Pick<DesktopRoomAgentScheduledRetry, "atMs" | "attempt" | "attempts" | "kind">, nowMs: number): string {
  return `${scheduledRetryCause(retry)} ${scheduledRetryClockLabel(retry, nowMs)}. ${scheduledRetryOutcome(retry)}`;
}

/**
 * The same wait for the room's live strip: "Waiting to try again, due at
 * 14:32 (attempt 2 of 3)". It is true before and after that time, so the row
 * and its spoken name do not change while the agent waits.
 */
export function scheduledRetryDueLabel(
  retry: RetryTime,
  clock: (atMs: number) => string = (atMs) => new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): string {
  return `Waiting to try again, due at ${clock(retry.atMs)} (${attemptLabel(retry)})`;
}

/** One row of the room's live strip for an agent that waits to try again. */
export interface WaitingAgentIndicator {
  id: string;
  displayName: string;
  summary: string;
  startedAt: string;
  agentSessionId: string | null;
  agentKey: string | null;
  /** No room message retires this row: it ends when the attempt starts or is stopped. */
  sourceMessageId: null;
  /** The row is at rest: the agent is not working. */
  waiting: true;
}

/**
 * The agents of this room that wait to try again, for the live strip that
 * stays in view above the composer. The failed message can be far up in the
 * history, or no longer kept; this row is there in both cases. The strip
 * shows an agent that runs and is connected, as it does for one that works:
 * an agent that its owner paused or stopped does not try again at the saved
 * time, so it has no row.
 */
export function waitingAgentIndicators(
  entries: readonly Pick<DesktopSupervisorManifestEntry, "id" | "roomId" | "displayName" | "desiredState" | "condition" | "agentSessionBindingState"
    | "roomAgentState" | "agentSessionId" | "agentKey" | "deliveryReceipts">[],
  roomIdentifier: string | null | undefined,
  clock?: (atMs: number) => string,
): WaitingAgentIndicator[] {
  const room = String(roomIdentifier || "").trim().toLowerCase();
  return entries.flatMap((entry) => {
    const retry = String(entry.roomId || "").trim().toLowerCase() === room && entry.agentSessionBindingState === "active"
      && entry.desiredState === "running" && entry.condition === "none" && entry.roomAgentState?.connection.state === "connected"
      ? agentScheduledRetry(entry.deliveryReceipts) : null;
    return retry ? [{
      // Not the id of the agent's working row: that row's held text must not carry over to this one.
      id: `${entry.id}:waiting`,
      displayName: supervisedAgentDisplayLabel(entry.displayName, entry.id),
      summary: scheduledRetryDueLabel(retry, clock),
      // The live strip shows the newest rows when there are many. A row that waits stays among them.
      startedAt: new Date(retry.atMs).toISOString(),
      agentSessionId: entry.agentSessionId ?? null,
      agentKey: entry.agentKey ?? null,
      sourceMessageId: null,
      waiting: true as const,
    }] : [];
  });
}
