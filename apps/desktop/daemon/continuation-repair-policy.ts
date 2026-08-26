import type { ProviderContinuationRepair } from "./supervised-agent-inbox-store.js";

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
