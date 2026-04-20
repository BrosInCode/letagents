import type { Express } from "express";

import {
  markGitHubWebhookDeliveryProcessed,
  recordGitHubWebhookDelivery,
  type GitHubWebhookDeliveryStatus,
} from "../db.js";
import { getGitHubAppConfig } from "../github-config.js";
import {
  buildGitHubRepoRoomId,
  getGitHubWebhookMetadata,
  verifyGitHubWebhookSignature,
  type GitHubWebhookPayload,
} from "../github-app.js";
import {
  respondWithInternalError,
  type AuthenticatedRequest,
} from "../http-helpers.js";

type WebhookProcessingResult = {
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
};

export interface GitHubWebhookRouteDeps {
  toGitHubWebhookId(value: string | number | null | undefined): string | null;
  handleGitHubWebhookEvent(
    eventName: string,
    payload: GitHubWebhookPayload,
    deliveryId: string
  ): Promise<WebhookProcessingResult>;
}

export function registerGitHubWebhookRoutes(
  app: Express,
  deps: GitHubWebhookRouteDeps
): void {
  app.post("/webhooks/github", async (req: AuthenticatedRequest, res) => {
    const config = await getGitHubAppConfig();
    if (!config.webhookSecret) {
      res.status(503).json({ error: "GitHub App webhook handling is not configured" });
      return;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "Raw webhook body is required" });
      return;
    }

    const metadata = getGitHubWebhookMetadata(
      req.headers as Record<string, string | string[] | undefined>
    );
    if (!metadata.deliveryId || !metadata.eventName) {
      res.status(400).json({ error: "Missing GitHub webhook headers" });
      return;
    }

    if (!verifyGitHubWebhookSignature(rawBody, metadata.signature256, config.webhookSecret)) {
      res.status(401).json({ error: "Invalid GitHub webhook signature" });
      return;
    }

    const payload = req.body as GitHubWebhookPayload;
    const initialInstallationId = deps.toGitHubWebhookId(payload.installation?.id);
    const initialGitHubRepoId = deps.toGitHubWebhookId(payload.repository?.id);
    const initialRoomId = payload.repository?.full_name
      ? buildGitHubRepoRoomId(payload.repository.full_name)
      : null;

    const delivery = await recordGitHubWebhookDelivery({
      delivery_id: metadata.deliveryId,
      event_name: metadata.eventName,
      action: payload.action ?? null,
      installation_id: initialInstallationId,
      github_repo_id: initialGitHubRepoId,
      room_id: initialRoomId,
    });

    if (delivery.duplicate) {
      res.status(202).json({ ok: true, duplicate: true });
      return;
    }

    try {
      const result = await deps.handleGitHubWebhookEvent(
        metadata.eventName,
        payload,
        metadata.deliveryId
      );
      await markGitHubWebhookDeliveryProcessed(metadata.deliveryId, {
        status: result.status,
        installation_id: result.installationId,
        github_repo_id: result.githubRepoId,
        room_id: result.roomId,
        error: null,
      });

      res.status(202).json({
        ok: true,
        status: result.status,
      });
    } catch (error) {
      await markGitHubWebhookDeliveryProcessed(metadata.deliveryId, {
        status: "failed",
        installation_id: initialInstallationId,
        github_repo_id: initialGitHubRepoId,
        room_id: initialRoomId,
        error: error instanceof Error ? error.message : "Unknown GitHub webhook processing error",
      });

      respondWithInternalError(
        res,
        "POST /webhooks/github",
        error,
        "GitHub webhook processing failed."
      );
    }
  });
}
