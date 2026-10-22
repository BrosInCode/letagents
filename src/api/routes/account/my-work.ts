import type { Express } from "express";

import { isTrackerProvider, type MyWorkJevNeedsMe, type MyWorkPage } from "../../../../shared/ticket-connectors.mjs";
import { accountMayReadMyWorkRoom, listMyWork, MyWorkInputError, type MyWorkQuery, type MyWorkTrackerFilter } from "../../connectors/my-work.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { createAttemptLimiter } from "./connectors/index.js";

export interface MyWorkRouteDeps {
  listMyWork(query: MyWorkQuery): Promise<MyWorkPage>;
  /** PR6: the account may read the room (its room list and the room's access check). */
  mayReadRoom?(accountId: string, login: string | null, roomId: string): Promise<boolean>;
  /** PR6: Jev's reading of who a card waits on, cached per card and last message. */
  askNeedsMe?(input: { roomId: string; taskId: string }): Promise<MyWorkJevNeedsMe>;
}

const defaultDeps: MyWorkRouteDeps = {
  listMyWork,
  mayReadRoom: accountMayReadMyWorkRoom,
  askNeedsMe: async (input) => (await import("../../connectors/jev/runtime.js")).askJevNeedsMeDefault(input),
};

/** Jev "needs me" questions per account: most answers come from the cache. */
const NEEDS_ME_PER_HOUR = 120;

function queryString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * `GET /account/my-work`: the cards across the account's rooms that are its
 * work (ticket connectors PR4). Same auth as the account activity stream: the
 * desktop session or an owner token. Query: `cursor`, `limit` (1–100),
 * `tracker` (`jira`, `linear`, `github` or `native`), `room`, `needs_me=true`,
 * `include_completed=true` (opt-in finished work).
 */
export function registerMyWorkRoute(app: Express, deps: MyWorkRouteDeps = defaultDeps): void {
  const needsMeLimiter = createAttemptLimiter(NEEDS_ME_PER_HOUR, 60 * 60_000);

  /**
   * `POST /account/my-work/needs-me` with `{ room_id, task_id }`: on request,
   * Jev reads who the card waits on (PR6). Only for a card whose ticket's
   * connection has the Jev switch on; the answer is advice for the page.
   */
  app.post("/account/my-work/needs-me", async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount || req.authKind !== "session") {
      res.status(401).json({ error: "Sign in to the LetAgents app to ask Jev." });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const roomId = typeof body?.room_id === "string" ? body.room_id.trim() : "";
    const taskId = typeof body?.task_id === "string" ? body.task_id.trim() : "";
    if (!roomId || roomId.length > 512 || !/^task_\d{1,10}$/.test(taskId)) {
      res.status(400).json({ error: "room_id and task_id are required." });
      return;
    }
    if (!deps.mayReadRoom || !deps.askNeedsMe) {
      res.status(503).json({ error: "Jev is not available on this server." });
      return;
    }
    try {
      if (!await deps.mayReadRoom(req.sessionAccount.account_id, req.sessionAccount.login ?? null, roomId)) {
        res.status(404).json({ error: "Card not found." });
        return;
      }
      if (!needsMeLimiter(req.sessionAccount.account_id)) {
        res.status(429).json({ error: "Too many questions in the last hour. Try again later." });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(await deps.askNeedsMe({ roomId, taskId }));
    } catch (error) {
      console.error("[my work] Jev needs-me failed", error instanceof Error ? error.name : "unknown");
      res.status(500).json({ error: "Jev could not be asked. Please retry." });
    }
  });

  app.get("/account/my-work", async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount || (req.authKind !== "session" && req.authKind !== "owner_token")) {
      res.status(401).json({ error: "My work requires a signed-in account." });
      return;
    }
    const tracker = queryString(req.query.tracker);
    if (tracker && tracker !== "native" && !isTrackerProvider(tracker)) {
      res.status(400).json({ error: "tracker must be jira, linear, github or native." });
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
        includeCompleted: queryString(req.query.include_completed)?.toLowerCase() === "true",
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
