import type { Express, Response } from "express";
import type { Project } from "../../db.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { respondWithInternalError } from "../../http/helpers.js";
import { ContentDeletionError, deleteRoomData, deleteRoomMessage, deleteRoomTask } from "../../db/content-deletion.js";
import { drainAttachmentDeletions } from "../../messages/attachment-deletion.js";
import { contentDeletionEvents } from "../../server/events.js";
import { normalizeRoomId } from "../../rooms/routing.js";

export interface ContentDeletionRouteDeps {
  resolveCanonicalRoomRequestId(id: string): Promise<string>;
  resolveRoomOrReply(id: string, res: Response, options: { allowCreate: boolean }): Promise<Project | null>;
  requireParticipant(req: AuthenticatedRequest, res: Response, room: Project): Promise<boolean>;
  requireAdmin(req: AuthenticatedRequest, res: Response, room: Project): Promise<boolean>;
  resolveProjectRole(room: Project, account: AuthenticatedRequest["sessionAccount"]): Promise<string>;
  deleteMessage?: typeof deleteRoomMessage;
  deleteTask?: typeof deleteRoomTask;
  deleteRoom?: typeof deleteRoomData;
  invalidate?: (roomId: string) => void;
  cleanup?: () => Promise<void>;
}

export function registerContentDeletionRoutes(app: Express, deps: ContentDeletionRouteDeps): void {
  const invalidate = deps.invalidate ?? ((roomId: string) => contentDeletionEvents.emit("loss", { roomId, projectId: roomId }));
  const cleanup = deps.cleanup ?? drainAttachmentDeletions;
  const routes = [
    { path: /^\/rooms\/(.+)\/messages\/(msg_\d+)\/attachments\/(att_\d+)$/, kind: "attachment" },
    { path: /^\/rooms\/(.+)\/messages\/(msg_\d+)\/thread$/, kind: "thread" },
    { path: /^\/rooms\/(.+)\/messages\/(msg_\d+)$/, kind: "message" },
    { path: /^\/rooms\/(.+)\/tasks\/(task_\d+)$/, kind: "task" },
    { path: /^\/rooms\/(.+)$/, kind: "room" },
  ] as const;
  for (const route of routes) app.delete(route.path, async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount || !["session", "owner_token"].includes(req.authKind ?? "")) {
      res.status(401).json({ error: "Sign in to delete content." }); return;
    }
    try {
      const params = req.params as Record<string, string>;
      const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(decodeURIComponent(params[0] ?? "")));
      const room = await deps.resolveRoomOrReply(roomId, res, { allowCreate: false });
      if (!room || !await deps.requireParticipant(req, res, room)) return;
      const adminOnly = route.kind === "thread" || route.kind === "task" || route.kind === "room";
      if (adminOnly && !await deps.requireAdmin(req, res, room)) return;
      if (route.kind === "room" && req.body?.confirmation !== room.id) {
        res.status(400).json({ error: "Permanent room deletion requires the exact room identifier as confirmation." }); return;
      }
      let result: object;
      let affectedRooms = [room.id];
      if (route.kind === "room") {
        const removed = await (deps.deleteRoom ?? deleteRoomData)(room.id);
        affectedRooms = [...removed.deleted_room_ids, ...(removed.parent_room_id ? [removed.parent_room_id] : [])];
        result = { room_id: room.id, deleted: true, ...removed };
      } else if (route.kind === "task") {
        result = await (deps.deleteTask ?? deleteRoomTask)(room.id, params[1]);
      } else {
        result = await (deps.deleteMessage ?? deleteRoomMessage)({
          roomId: room.id, messageId: params[1], accountId: req.sessionAccount.account_id,
          admin: adminOnly || await deps.resolveProjectRole(room, req.sessionAccount) === "admin",
          thread: route.kind === "thread", ...(route.kind === "attachment" ? { attachmentId: params[2] } : {}),
        });
      }
      for (const id of affectedRooms) invalidate(id);
      void cleanup().catch(() => {});
      res.json(result);
    } catch (error) {
      if (error instanceof ContentDeletionError) { res.status(error.status).json({ error: error.message }); return; }
      respondWithInternalError(res, "content.delete", error, "Content could not be deleted.");
    }
  });
}
