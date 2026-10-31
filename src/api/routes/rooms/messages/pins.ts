import type { Express, Response } from "express";
import { isPinMessageId, MESSAGE_PIN_LIMIT_NOTICE } from "../../../../../shared/message-pins.mjs";
import { getMessagePins, setMessagePin } from "../../../db/messages/pins.js";
import { parseScopedId } from "../../../db/utils.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { isAppSession } from "../../../request/app-session.js";
import { queueMessagePinInvalidation } from "../../../server/events.js";
import { resolveParticipantRoom, routeParam } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

export interface MessagePinStore {
  list: typeof getMessagePins;
  set: typeof setMessagePin;
}

function fail(res: Response, error: unknown): void {
  let cause = error;
  for (let depth = 0; cause && depth < 5; depth++) {
    const current = cause as { code?: string; cause?: unknown };
    if (current.code === "55P03") {
      res.status(503).json({ code: "pin_busy", error: "Pins are busy. Please try again." });
      return;
    }
    cause = current.cause;
  }
  console.error("[message pins]", error);
  res.status(500).json({ error: "Pins could not be loaded or saved. Please retry." });
}

export function registerMessagePinRoutes(app: Express, deps: RoomMessageRouteDeps): void {
  const store = deps.messagePinStore ?? { list: getMessagePins, set: setMessagePin };
  const invalidate = deps.queueMessagePinInvalidation ?? queueMessagePinInvalidation;
  app.get(/^\/rooms\/(.+)\/messages\/pins$/, async (req: AuthenticatedRequest, res) => {
    try {
      const room = await resolveParticipantRoom(req, res, deps);
      if (room) res.json({ room_id: room.id, pins: await store.list(room.id) });
    } catch (error) { fail(res, error); }
  });
  async function mutate(req: AuthenticatedRequest, res: Response, pinned: boolean): Promise<void> {
    try {
      const room = await resolveParticipantRoom(req, res, deps);
      if (!room) return;
      if (!isAppSession(req)) {
        res.status(req.authKind ? 403 : 401).json({
          code: "person_required", error: "Only a person signed in to LetAgents can pin a message.",
        });
        return;
      }
      const id = routeParam(req, 1);
      const number = isPinMessageId(id) ? parseScopedId(id, "msg") : null;
      if (!number) {
        res.status(400).json({ code: "invalid_message_id", error: "A valid message id is required." });
        return;
      }
      const result = await store.set({ roomId: room.id, messageNumber: number, accountId: req.sessionAccount!.account_id, pinned });
      if (result === "message_not_found") {
        res.status(404).json({ code: result, error: "That message is not available." });
      } else if (result === "pin_limit") {
        res.status(409).json({ code: result, error: MESSAGE_PIN_LIMIT_NOTICE });
      } else {
        const changed = result === "changed";
        if (changed) invalidate(room.id);
        res.json({ room_id: room.id, message_id: id, changed });
      }
    } catch (error) { fail(res, error); }
  }
  const path = /^\/rooms\/(.+)\/messages\/([^/]+)\/pin$/;
  app.put(path, (req: AuthenticatedRequest, res) => mutate(req, res, true));
  app.delete(path, (req: AuthenticatedRequest, res) => mutate(req, res, false));
}
