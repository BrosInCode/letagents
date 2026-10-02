import type { Express, Response } from "express";

import {
  MESSAGE_SEARCH_MAX_QUERY_CHARS,
  MESSAGE_SEARCH_MAX_TERMS,
  MESSAGE_SEARCH_MIN_QUERY_CHARS,
  parseMessageSearchQuery,
  type MessageSearchQueryError,
  type MessageSearchResponse,
} from "../../../../../shared/message-search.mjs";
import type { Message } from "../../../db.js";
import { searchRoomMessages } from "../../../db/messages/search.js";
import { parseScopedId } from "../../../db/utils.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

const QUERY_ERRORS: Record<MessageSearchQueryError, string> = {
  too_short: `Type at least ${MESSAGE_SEARCH_MIN_QUERY_CHARS} characters to search.`,
  too_long: `A search can be at most ${MESSAGE_SEARCH_MAX_QUERY_CHARS} characters.`,
  too_many_terms: `A search can have at most ${MESSAGE_SEARCH_MAX_TERMS} words or quoted phrases.`,
};

function fail(res: Response, error: unknown): void {
  // 57014: the scan passed its statement timeout.
  if ((error as { code?: string; cause?: { code?: string } } | null)?.code === "57014"
    || (error as { cause?: { code?: string } } | null)?.cause?.code === "57014") {
    res.status(503).json({
      error: "This search took too long. Try a longer or more specific phrase.",
      code: "search_timeout",
    });
    return;
  }
  console.error("[message search]", error);
  res.status(500).json({ error: "Messages could not be searched. Please retry." });
}

export function registerMessageSearchRoute(
  app: Express,
  deps: RoomMessageRouteDeps,
): void {
  const search = deps.searchRoomMessages ?? searchRoomMessages;

  app.get(/^\/rooms\/(.+)\/messages\/search$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await resolveParticipantRoom(req, res, deps);
      if (!project) return;

      const parsed = parseMessageSearchQuery(typeof req.query.q === "string" ? req.query.q : "");
      if (parsed.error) {
        res.status(400).json({ error: QUERY_ERRORS[parsed.error], code: `query_${parsed.error}` });
        return;
      }
      const rawBefore = typeof req.query.before === "string" ? req.query.before : "";
      const before = rawBefore ? parseScopedId(rawBefore, "msg") : null;
      if (req.query.before !== undefined && !before) {
        res.status(400).json({ error: "before must be a message id." });
        return;
      }
      const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;

      const page = await search(project.id, parsed.terms, {
        before,
        limit: Number.isFinite(limit) ? limit : undefined,
        accountId: req.sessionAccount?.account_id ?? null,
      });
      const response: MessageSearchResponse<Message> = {
        room_id: project.id,
        terms: parsed.terms,
        messages: page.messages,
        has_more: page.has_more,
        next_before: page.next_before,
      };
      res.json(response);
    } catch (error) {
      fail(res, error);
    }
  });
}
