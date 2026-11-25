/**
 * The suggested reply for the signed-in person's composer in a room: one of
 * the agents' `suggested_reply` texts, picked by src/api/messages/suggested-reply.ts.
 * Agents and signed-out callers get none.
 */
import type { Express, Response } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "../../../db/client.js";
import { messages } from "../../../db/schema.js";
import { sharedMessageCondition, visibleMessageCondition } from "../../../db/messages/visibility.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { isAppSession } from "../../../request/app-session.js";
import { readJevEndpoint } from "../../../messages/jev-conversation-routing.js";
import {
  pickSuggestedReply,
  suggestedReplyCandidates,
  suggestedReplyCandidatesKey,
  SUGGESTED_REPLY_WINDOW,
  SuggestedReplyCache,
  type SuggestedReplyRow,
} from "../../../messages/suggested-reply.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

const picks = new SuggestedReplyCache();

export function registerSuggestedReplyRoute(app: Express, deps: RoomMessageRouteDeps): void {
  app.get(/^\/rooms\/(.+)\/messages\/suggested-reply$/, async (req: AuthenticatedRequest, res: Response) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;
    const viewerAccountId = isAppSession(req) ? req.sessionAccount?.account_id ?? null : null;
    if (!viewerAccountId) {
      res.json({ suggestion: null });
      return;
    }
    try {
      const newestFirst: SuggestedReplyRow[] = await db
        .select({
          number: messages.number,
          sender: messages.sender,
          text: messages.text,
          source: messages.source,
          publisher_agent_key: messages.publisher_agent_key,
          publisher_account_id: messages.publisher_account_id,
          reply_to_number: messages.reply_to_number,
          suggested_reply: messages.suggested_reply,
        })
        .from(messages)
        .where(and(
          eq(messages.room_id, project.id),
          isNull(messages.thread_root_number),
          visibleMessageCondition(false),
          sharedMessageCondition(true),
        ))
        .orderBy(desc(messages.number))
        .limit(SUGGESTED_REPLY_WINDOW);
      const rows = newestFirst.reverse();
      const candidates = suggestedReplyCandidates(rows, viewerAccountId);
      if (candidates.length === 0) {
        res.json({ suggestion: null });
        return;
      }
      // Keyed by the candidates themselves: a deleted or hidden message drops
      // out of them, so it never stays in the composer.
      const key = `${project.id}\u0000${viewerAccountId}\u0000${suggestedReplyCandidatesKey(candidates)}`;
      const suggestion = await picks.get(key, () => pickSuggestedReply({
        rows,
        viewerAccountId,
        candidates,
        endpoint: readJevEndpoint(),
      }));
      res.json({ suggestion });
    } catch (error) {
      console.error(`[suggested reply] failed for ${project.id}`, error);
      res.status(500).json({ error: "Could not read the suggested reply." });
    }
  });
}
