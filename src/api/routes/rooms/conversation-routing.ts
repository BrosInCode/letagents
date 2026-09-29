import type { Express } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { rooms } from "../../db/schema.js";
import { readJevRoutingConfig } from "../../messages/jev-conversation-routing.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import type { RoomMetadataRouteDeps } from "./metadata.js";
import type { RoomMessageRouteDeps } from "./messages/types.js";
import { normalizeRoomId } from "../../rooms/routing.js";

export function registerConversationRoutingRoutes(
  app: Express,
  deps: Pick<RoomMetadataRouteDeps, "resolveCanonicalRoomRequestId" | "resolveRoomOrReply" | "requireAdmin" | "resolveProjectRole">
    & Pick<RoomMessageRouteDeps, "requireParticipant">,
): void {
  const route = /^\/rooms\/(.+)\/conversation-routing$/;
  for (const method of ["get", "patch"] as const) app[method](route, async (req: AuthenticatedRequest, res) => {
    const raw = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(raw));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project || !await deps.requireParticipant(req, res, project)) return;
    const config = readJevRoutingConfig();
    const available = config.status === "enabled" && config.config.mode === "active";
    if (method === "patch") {
      if (!await deps.requireAdmin(req, res, project)) return;
      if (typeof req.body?.enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" }); return;
      }
      if (req.body.enabled && !available) {
        res.status(409).json({ error: "Smart conversation routing is currently unavailable." }); return;
      }
      await db.update(rooms).set({ jev_routing_enabled: req.body.enabled }).where(eq(rooms.id, project.id));
    }
    const [room] = await db.select({ enabled: rooms.jev_routing_enabled }).from(rooms).where(eq(rooms.id, project.id));
    const role = await deps.resolveProjectRole(project, req.sessionAccount);
    res.json({ enabled: room?.enabled ?? false, available, can_manage: req.authKind !== "agent_session" && role === "admin" });
  });
}
