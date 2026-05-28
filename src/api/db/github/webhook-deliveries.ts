import { eq } from "drizzle-orm";

import { db } from "../client.js";
import { toGitHubWebhookDelivery } from "../mappers.js";
import { github_webhook_deliveries } from "../schema.js";
import type { GitHubWebhookDelivery, GitHubWebhookDeliveryStatus } from "../types.js";

export async function recordGitHubWebhookDelivery(input: {
  delivery_id: string;
  event_name: string;
  action?: string | null;
  installation_id?: string | null;
  github_repo_id?: string | null;
  room_id?: string | null;
}): Promise<{ delivery: GitHubWebhookDelivery; duplicate: boolean }> {
  const received_at = new Date().toISOString();
  const [created] = await db
    .insert(github_webhook_deliveries)
    .values({
      delivery_id: input.delivery_id,
      event_name: input.event_name,
      action: input.action ?? null,
      installation_id: input.installation_id ?? null,
      github_repo_id: input.github_repo_id ?? null,
      room_id: input.room_id ?? null,
      status: "received",
      error: null,
      received_at,
      processed_at: null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return {
      delivery: toGitHubWebhookDelivery(created),
      duplicate: false,
    };
  }

  const [existing] = await db
    .select()
    .from(github_webhook_deliveries)
    .where(eq(github_webhook_deliveries.delivery_id, input.delivery_id))
    .limit(1);

  if (!existing) {
    throw new Error(`Webhook delivery '${input.delivery_id}' could not be recorded`);
  }

  return {
    delivery: toGitHubWebhookDelivery(existing),
    duplicate: true,
  };
}

export async function markGitHubWebhookDeliveryProcessed(
  deliveryId: string,
  input: {
    status: Exclude<GitHubWebhookDeliveryStatus, "received">;
    error?: string | null;
    installation_id?: string | null;
    github_repo_id?: string | null;
    room_id?: string | null;
  }
): Promise<void> {
  const update: Partial<typeof github_webhook_deliveries.$inferInsert> = {
    status: input.status,
    processed_at: new Date().toISOString(),
  };

  if (input.error !== undefined) {
    update.error = input.error;
  }
  if (input.installation_id !== undefined) {
    update.installation_id = input.installation_id;
  }
  if (input.github_repo_id !== undefined) {
    update.github_repo_id = input.github_repo_id;
  }
  if (input.room_id !== undefined) {
    update.room_id = input.room_id;
  }

  await db
    .update(github_webhook_deliveries)
    .set(update)
    .where(eq(github_webhook_deliveries.delivery_id, deliveryId));
}
