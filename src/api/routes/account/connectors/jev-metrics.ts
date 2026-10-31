import type { Express } from "express";

import type { TrackerJevMetrics } from "../../../../../shared/ticket-connectors.mjs";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { readJevEndpoint } from "../../../messages/jev-conversation-routing.js";
import { requireAccount } from "./index.js";

export const JEV_METRICS_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface JevMetricsRouteDeps {
  metrics(accountId: string, since: Date): Promise<Pick<TrackerJevMetrics, "enabled_connections" | "kinds">>;
  available(): boolean;
  now?(): Date;
}

async function defaultMetrics(accountId: string, since: Date) {
  const { jevQuestionStore } = await import("../../../connectors/jev/store.js");
  return jevQuestionStore.metrics(accountId, since);
}

/**
 * `GET /account/tracker-jev-metrics`: count, outcome and latency of the Jev
 * questions asked for the account's tracker connections in the last 7 days
 * (ticket connectors PR6), for the desktop's diagnostics pane. Counts only;
 * no question text.
 */
export function registerJevMetricsRoute(app: Express, deps: JevMetricsRouteDeps = {
  metrics: defaultMetrics,
  available: () => readJevEndpoint() !== null,
}): void {
  app.get("/account/tracker-jev-metrics", async (req: AuthenticatedRequest, res) => {
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const since = new Date((deps.now?.() ?? new Date()).getTime() - JEV_METRICS_WINDOW_MS);
    try {
      const counts = await deps.metrics(accountId, since);
      const body: TrackerJevMetrics = { since: since.toISOString(), available: deps.available(), ...counts };
      res.setHeader("Cache-Control", "no-store");
      res.json(body);
    } catch (error) {
      console.error("[jev tracker] metrics failed", error instanceof Error ? error.name : "unknown");
      res.status(500).json({ error: "Jev metrics could not be read." });
    }
  });
}
