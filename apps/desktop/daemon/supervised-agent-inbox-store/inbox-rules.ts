import type { SupervisedInboxState, InboxHeadSnapshot, SupervisedInboxEvent, SupervisedInboxItemMetadata } from "./types.js";

export function sameInboxHead(left: InboxHeadSnapshot | null, right: InboxHeadSnapshot | null): boolean {
  return left === null || right === null ? left === right
    : left.inbox_item_id === right.inbox_item_id && left.state === right.state
      && left.provider_turn_id === right.provider_turn_id && left.outcome === right.outcome;
}

export const finalStates = new Set<SupervisedInboxState>(["acknowledged", "acknowledged_no_reply", "acknowledged_failed", "cancelled_by_room_move", "cancelled_by_user"]);
export const RETAINED_TIMELINE_EVENTS_PER_RECEIPT = 64;
export const transitions: Readonly<Record<SupervisedInboxState, readonly SupervisedInboxState[]>> = {
  pending: ["dispatching", "blocked"], dispatching: ["awaiting_result", "acknowledged_failed", "retryable", "blocked"],
  awaiting_result: ["result_recovery", "publishing", "acknowledged_no_reply", "acknowledged_failed", "retryable", "blocked"],
  result_recovery: ["publishing", "acknowledged_no_reply", "acknowledged_failed", "blocked"], publishing: ["acknowledged", "retryable", "blocked"],
  retryable: ["pending", "blocked"], blocked: ["pending", "cancelled_by_user"], acknowledged: [], acknowledged_no_reply: [], acknowledged_failed: [], cancelled_by_room_move: [], cancelled_by_user: [],
};

export function phaseForTransition(state: SupervisedInboxState): SupervisedInboxEvent["phase"] | null {
  if (state === "result_recovery") return "result_unreadable";
  if (state === "publishing") return "publish_started";
  if (state === "acknowledged") return "published";
  if (state === "acknowledged_no_reply") return "no_reply";
  if (state === "retryable") return "retry_scheduled";
  if (state === "blocked") return "blocked";
  if (state === "cancelled_by_room_move") return "room_move_cancelled";
  if (state === "cancelled_by_user") return "user_cancelled";
  if (state === "pending") return "queued";
  return null;
}

export function isNewerCursor(candidate: string, current: string | null): boolean {
  if (current === null) return true;
  const numeric = (value: string) => value.startsWith("msg_") ? value.slice(4) : value;
  const candidateNumber = BigInt(numeric(candidate)); const currentNumber = BigInt(numeric(current));
  return candidateNumber > currentNumber;
}

export function valueOrCurrent<T extends object, K extends keyof T>(patch: T, key: K, current: T[K]): T[K] {
  return Object.hasOwn(patch, key) ? patch[key] : current;
}

/** Any durable sign that this message reached, or may have reached, a provider turn. */
export function providerWorkStarted(item: Pick<SupervisedInboxItemMetadata, "attempt_count" | "provider_turn_id" | "outcome">): boolean {
  return item.attempt_count !== 0 || Boolean(item.provider_turn_id) || Boolean(item.outcome);
}

export function persistedTerminalOutcome(outcome: string | null): { kind: "reply"; text: string } | { kind: "no_reply" } | { kind: "unreadable" } | null {
  if (!outcome) return null;
  try {
    const parsed = JSON.parse(outcome) as { kind?: unknown; text?: unknown };
    if (parsed.kind === "reply" && typeof parsed.text === "string" && parsed.text.trim()) return { kind: "reply", text: parsed.text };
    if (parsed.kind === "no_reply") return { kind: "no_reply" };
    return parsed.kind === "unreadable" ? { kind: "unreadable" } : null;
  } catch { return null; }
}
