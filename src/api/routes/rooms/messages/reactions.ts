import type { Express, Response } from "express";

import {
  MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE,
  MESSAGE_REACTION_RANGE_MAX_SPAN,
  normalizeMessageReactionEmoji,
  type MessageReaction,
  type MessageReactionMutationResponse,
  type MessageReactionsRangeResponse,
} from "../../../../../shared/message-reactions.mjs";
import { db } from "../../../db/client.js";
import {
  addMessageReaction,
  getMessageReactions,
  loadMessageReactions,
  loadViewerMessageReactions,
  removeMessageReaction,
  type MessageReactionRead,
} from "../../../db/messages/reactions.js";
import { formatMessageId, parseScopedId } from "../../../db/utils.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { isAppSession } from "../../../request/app-session.js";
import { queueMessageReactionInvalidation } from "../../../server/events.js";
import { resolveParticipantRoom, routeParam } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

export interface MessageReactionStore {
  add: typeof addMessageReaction;
  remove: typeof removeMessageReaction;
  forMessage(roomId: string, messageNumber: number): Promise<MessageReaction[]>;
  inRange(roomId: string, first: number, last: number): Promise<MessageReactionRead>;
  /** The emoji one person reacted with, per message number. */
  byViewer(roomId: string, accountId: string, first: number, last: number): Promise<Map<number, string[]>>;
}

const databaseStore: MessageReactionStore = {
  add: addMessageReaction,
  remove: removeMessageReaction,
  forMessage: getMessageReactions,
  inRange: (roomId, first, last) => loadMessageReactions(db, roomId, { first, last }),
  byViewer: (roomId, accountId, first, last) => loadViewerMessageReactions(db, roomId, accountId, { first, last }),
};

const MESSAGE_NOT_FOUND = "message does not exist in this room";

function fail(res: Response, error: unknown): void {
  // 55P03: another reaction to the same message held the row past lock_timeout.
  if ((error as { code?: string } | null)?.code === "55P03") {
    res.status(503).json({ error: "This message is busy. Please try again.", code: "reaction_busy" });
    return;
  }
  console.error("[message reactions]", error);
  res.status(500).json({ error: "Reactions could not be loaded or saved. Please retry." });
}

/**
 * A reaction carries the reactor's name, so only a signed-in person may leave
 * one. An agent holding its owner's token would otherwise react as the owner.
 */
function requirePerson(req: AuthenticatedRequest, res: Response): string | null {
  if (isAppSession(req)) return req.sessionAccount!.account_id;
  res.status(req.authKind ? 403 : 401).json({
    error: "Only a person signed in to LetAgents can react to a message.",
    code: "person_required",
  });
  return null;
}

function emojiParam(req: AuthenticatedRequest, res: Response): string | null {
  let raw = "";
  try {
    raw = routeParam(req, 2);
  } catch {
    // routeParam decodes what Express already decoded, so a literal "%" that
    // is not an escape throws. Either way it is not an emoji.
  }
  const emoji = normalizeMessageReactionEmoji(raw);
  if (!emoji) res.status(400).json({ error: "A reaction must be a single emoji.", code: "invalid_emoji" });
  return emoji;
}

export function registerMessageReactionRoutes(
  app: Express,
  deps: RoomMessageRouteDeps,
): void {
  const store = deps.messageReactionStore ?? databaseStore;
  const invalidate = deps.queueMessageReactionInvalidation ?? queueMessageReactionInvalidation;

  app.get(/^\/rooms\/(.+)\/messages\/reactions$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const first = parseScopedId(typeof req.query.first === "string" ? req.query.first : "", "msg");
    const last = parseScopedId(typeof req.query.last === "string" ? req.query.last : "", "msg");
    if (!first || !last || last < first) {
      res.status(400).json({ error: "first and last must be message ids, with first not after last." });
      return;
    }
    if (last - first >= MESSAGE_REACTION_RANGE_MAX_SPAN) {
      res.status(400).json({
        error: `A read covers at most ${MESSAGE_REACTION_RANGE_MAX_SPAN} messages. Ask for a narrower range.`,
        code: "range_too_wide",
      });
      return;
    }

    try {
      const read = await store.inRange(project.id, first, last);
      // A person also learns which reactions are their own: the reactor list
      // is capped, so it alone cannot always say.
      const viewerAccountId = isAppSession(req) ? req.sessionAccount!.account_id : null;
      const completeThrough = read.nextFirst === null ? last : read.nextFirst - 1;
      const byMessageId = <Value>(entries: Map<number, Value>) =>
        Object.fromEntries(Array.from(entries, ([number, value]) => [formatMessageId(number), value]));
      const response: MessageReactionsRangeResponse = {
        room_id: project.id,
        first_message_id: formatMessageId(first),
        last_message_id: formatMessageId(last),
        reactions: byMessageId(read.reactions),
        ...(viewerAccountId
          ? { viewer_reactions: byMessageId(await store.byViewer(project.id, viewerAccountId, first, completeThrough)) }
          : {}),
        next_first_message_id: read.nextFirst === null ? null : formatMessageId(read.nextFirst),
      };
      res.json(response);
    } catch (error) {
      fail(res, error);
    }
  });

  const reactionPath = /^\/rooms\/(.+)\/messages\/(msg_\d+)\/reactions\/([^/]+)$/;

  async function mutate(
    req: AuthenticatedRequest,
    res: Response,
    change: (target: { roomId: string; messageNumber: number; accountId: string; emoji: string }) => Promise<boolean | null>,
  ): Promise<void> {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;
    const accountId = requirePerson(req, res);
    if (!accountId) return;

    const messageNumber = parseScopedId(routeParam(req, 1), "msg");
    if (!messageNumber) {
      res.status(404).json({ error: MESSAGE_NOT_FOUND });
      return;
    }
    const emoji = emojiParam(req, res);
    if (!emoji) return;

    try {
      const changed = await change({ roomId: project.id, messageNumber, accountId, emoji });
      if (changed === null) return;
      if (changed) invalidate(project.id);
      const response: MessageReactionMutationResponse = {
        room_id: project.id,
        message_id: formatMessageId(messageNumber),
        emoji,
        changed,
        reactions: await store.forMessage(project.id, messageNumber),
      };
      res.json(response);
    } catch (error) {
      fail(res, error);
    }
  }

  app.put(reactionPath, (req: AuthenticatedRequest, res) => mutate(req, res, async (target) => {
    const result = await store.add(target);
    if (result === "message_not_found") {
      res.status(404).json({ error: MESSAGE_NOT_FOUND });
      return null;
    }
    if (result === "limit_reached") {
      res.status(409).json({
        error: `A message can carry at most ${MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE} different reactions. Add to one that is already there.`,
        code: "reaction_limit",
      });
      return null;
    }
    return result === "added";
  }));

  // Removing a reaction that is already gone succeeds with `changed: false`.
  app.delete(reactionPath, (req: AuthenticatedRequest, res) => mutate(req, res, (target) => store.remove(target)));
}
