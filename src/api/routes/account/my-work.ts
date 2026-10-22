import type { Express } from "express";

import { isTrackerProvider, type MyWorkPage } from "../../../../shared/ticket-connectors.mjs";
import { listMyWork, MyWorkInputError, type MyWorkQuery, type MyWorkTrackerFilter } from "../../connectors/my-work.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";

export interface MyWorkRouteDeps {
  listMyWork(query: MyWorkQuery): Promise<MyWorkPage>;
}

function queryString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * `GET /account/my-work`: the cards across the account's rooms that are its
 * work (ticket connectors PR4). Same auth as the account activity stream: the
 * desktop session or an owner token. Query: `cursor`, `limit` (1–100),
 * `tracker` (`jira`, `linear` or `native`), `room`, `needs_me=true`.
 */
export function registerMyWorkRoute(app: Express, deps: MyWorkRouteDeps = { listMyWork }): void {
  app.get("/account/my-work", async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount || (req.authKind !== "session" && req.authKind !== "owner_token")) {
      res.status(401).json({ error: "My work requires a signed-in account." });
      return;
    }
    const tracker = queryString(req.query.tracker);
    if (tracker && tracker !== "native" && !isTrackerProvider(tracker)) {
      res.status(400).json({ error: "tracker must be jira, linear or native." });
      return;
    }
    const limitText = queryString(req.query.limit);
    const limit = limitText ? Number.parseInt(limitText, 10) : undefined;
    if (limitText && !Number.isFinite(limit)) {
      res.status(400).json({ error: "limit must be a number." });
      return;
    }
    try {
      const page = await deps.listMyWork({
        accountId: req.sessionAccount.account_id,
        login: req.sessionAccount.login ?? null,
        cursor: queryString(req.query.cursor),
        limit,
        tracker: tracker as MyWorkTrackerFilter | null,
        roomId: queryString(req.query.room),
        needsMe: String(req.query.needs_me ?? "").toLowerCase() === "true",
      });
      res.json(page);
    } catch (error) {
      if (error instanceof MyWorkInputError) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error("[my work] could not list cards", error);
      res.status(500).json({ error: "My work could not be loaded. Please retry." });
    }
  });
}
