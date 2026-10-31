import type { Express } from "express";
import { parseLinkPreviewReferences } from "../../../../../shared/message-link-previews.mjs";
import { getMessageLinkPreviews } from "../../../db/messages/link-previews.js";
import { getProjectAccessRoomId } from "../../../rooms/access.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { getGitHubEventLaneRoomId } from "../events.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

export function registerMessageLinkPreviewRoutes(app: Express, deps: RoomMessageRouteDeps): void {
  app.post(/^\/rooms\/(.+)\/messages\/link-previews$/, async (req: AuthenticatedRequest, res) => {
    try {
      const room = await resolveParticipantRoom(req, res, deps);
      if (!room) return;
      const references = parseLinkPreviewReferences(req.body?.references);
      if (!references || Object.keys(req.body).length !== 1) {
        res.status(400).json({ error: "Provide at most 50 pull request or issue numbers.", code: "invalid_references" });
        return;
      }
      const lane = getGitHubEventLaneRoomId(room, getProjectAccessRoomId(room));
      const previews = await (deps.getMessageLinkPreviews ?? getMessageLinkPreviews)(lane, references);
      res.json({ room_id: room.id, previews });
    } catch (error) {
      console.error("[message link previews]", error);
      res.status(500).json({ error: "Link previews could not be loaded." });
    }
  });
}
