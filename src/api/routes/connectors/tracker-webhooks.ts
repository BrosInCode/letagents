import type { Express } from "express";

import { isTrackerProvider } from "../../../../shared/ticket-connectors.mjs";
import type { ConnectorCipher } from "../../connectors/crypto.js";
import { loadConnectorCipher } from "../../connectors/crypto.js";
import { createWorkItemProviders, type WorkItemProviders } from "../../connectors/providers/index.js";
import { getDefaultTrackerSync, type TrackerSync } from "../../connectors/sync.js";
import { trackerConnectionStore, type TrackerConnectionStore } from "../../connectors/store.js";
import { connectorErrorText } from "../../connectors/connections.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";

export interface TrackerWebhookRouteDeps {
  cipher: ConnectorCipher | null;
  store: Pick<TrackerConnectionStore, "get">;
  providers: WorkItemProviders;
  sync: Pick<TrackerSync, "handleWebhook"> | null;
}

const RECENT_DELIVERIES = 2_000;

export function defaultTrackerWebhookRouteDeps(): TrackerWebhookRouteDeps {
  return {
    cipher: loadConnectorCipher(),
    store: trackerConnectionStore,
    providers: createWorkItemProviders(),
    sync: getDefaultTrackerSync(),
  };
}

/**
 * `POST /webhooks/trackers/:provider/:connectionId`: a Jira or Linear webhook
 * for one connection, signed with that connection's secret (see
 * `GET /account/connectors/:id/webhook`). The payload only names tickets;
 * sync reads each one and applies it through the same path as a poll.
 */
export function registerTrackerWebhookRoutes(app: Express, deps: TrackerWebhookRouteDeps = defaultTrackerWebhookRouteDeps()): void {
  // Redeliveries within this process are answered without work. Another
  // process may still apply one again; the apply path writes nothing twice.
  const recent = new Set<string>();

  app.post("/webhooks/trackers/:provider/:connectionId", async (req: AuthenticatedRequest, res) => {
    const params = req.params as Record<string, string>;
    const provider = params.provider;
    if (!deps.cipher || !deps.sync || !isTrackerProvider(provider)) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    const connection = await deps.store.get(String(params.connectionId ?? ""));
    const tracker = deps.providers[provider];
    if (!connection || connection.provider !== provider || !req.rawBody || !tracker.verifyWebhook || !tracker.parseWebhook) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    const verified = tracker.verifyWebhook({
      headers: req.headers,
      rawBody: req.rawBody,
      secret: deps.cipher.webhookSecret(connection.id),
    });
    if (!verified.ok) {
      res.status(401).json({ error: "Invalid signature." });
      return;
    }
    const deliveryKey = `${connection.id}:${verified.deliveryId}`;
    if (recent.has(deliveryKey)) {
      res.status(202).json({ ok: true, duplicate: true });
      return;
    }
    recent.add(deliveryKey);
    if (recent.size > RECENT_DELIVERIES) recent.delete(recent.values().next().value!);
    const changes = tracker.parseWebhook(req.body);
    // Answer at once: trackers time out slow receivers. Sync reads each ticket.
    res.status(202).json({ ok: true, changes: changes.length });
    if (changes.length === 0) return;
    void deps.sync.handleWebhook(connection, changes).catch((error: unknown) => {
      recent.delete(deliveryKey);
      console.error("Tracker webhook apply failed:", connectorErrorText(error));
    });
  });
}
