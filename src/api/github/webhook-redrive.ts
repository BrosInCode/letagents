import {
  claimStaleGitHubWebhookDelivery,
  markGitHubWebhookDeliveryProcessed,
  type GitHubWebhookDeliveryStatus,
} from "../db.js";
import type { GitHubWebhookPayload } from "./app.js";

/** Deliveries processed again per liveness tick, at most. */
const REDRIVE_MAX_PER_TICK = 10;
/** Stop starting new deliveries after this long, so the other sweeps of the tick are not held. */
const REDRIVE_TIME_BUDGET_MS = 15_000;

export interface GitHubWebhookRedriveDeps {
  handleGitHubWebhookEvent(
    eventName: string,
    payload: GitHubWebhookPayload,
    deliveryId: string,
    options?: { retryFailedDelivery?: boolean }
  ): Promise<{
    status: Exclude<GitHubWebhookDeliveryStatus, "received">;
    installationId: string | null;
    githubRepoId: string | null;
    roomId: string | null;
  }>;
  claimStale?: typeof claimStaleGitHubWebhookDelivery;
  markProcessed?: typeof markGitHubWebhookDeliveryProcessed;
  now?: () => Date;
  timeBudgetMs?: number;
}

/**
 * Process again the webhook deliveries a stopped process left 'received'. The
 * webhook route processes a delivery inline; GitHub does not redeliver on its
 * own, so without this the event would be lost. Runs in the liveness sweep,
 * one delivery at a time, within a time budget.
 */
export async function redriveStaleGitHubWebhookDeliveries(
  deps: GitHubWebhookRedriveDeps,
): Promise<number> {
  const claimStale = deps.claimStale ?? claimStaleGitHubWebhookDelivery;
  const markProcessed = deps.markProcessed ?? markGitHubWebhookDeliveryProcessed;
  const now = deps.now ?? (() => new Date());
  const startedAt = Date.now();
  const budgetMs = deps.timeBudgetMs ?? REDRIVE_TIME_BUDGET_MS;
  let processed = 0;
  while (processed < REDRIVE_MAX_PER_TICK && Date.now() - startedAt < budgetMs) {
    const delivery = await claimStale({ now: now() });
    if (!delivery) break;
    processed += 1;
    try {
      // An earlier attempt may have written part of its side effects.
      const result = await deps.handleGitHubWebhookEvent(
        delivery.event_name,
        delivery.payload as GitHubWebhookPayload,
        delivery.delivery_id,
        { retryFailedDelivery: true },
      );
      await markProcessed(delivery.delivery_id, {
        status: result.status,
        installation_id: result.installationId,
        github_repo_id: result.githubRepoId,
        room_id: result.roomId,
        error: null,
        attempt: delivery.attempt,
      });
    } catch (error) {
      console.error(`[github webhook redrive] delivery ${delivery.delivery_id} failed`, error);
      await markProcessed(delivery.delivery_id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown GitHub webhook processing error",
        attempt: delivery.attempt,
      }).catch(() => {});
    }
  }
  return processed;
}
