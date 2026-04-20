import type { Express } from "express";

import { getProjectById } from "../db.js";
import type { AuthenticatedRequest } from "../http-helpers.js";
import {
  isKnownProvider,
  normalizeRoomId,
  normalizeRoomName,
  resolveRoomIdentifier,
} from "../room-routing.js";
import { sendAppPage } from "./web.js";

export interface RoomEntryRouteDeps {
  isRepoBackedRoomId(roomId: string): boolean;
  resolveGitHubRoomEntryDecision(input: {
    roomName: string;
    sessionAccount: AuthenticatedRequest["sessionAccount"];
    redirectTo: string;
  }): Promise<
    | { kind: "allow" }
    | { kind: "redirect"; location: string }
  >;
}

export function registerRoomEntryRoutes(
  app: Express,
  deps: RoomEntryRouteDeps
): void {
  app.get(/^\/api\/rooms\/resolve\/(.+)$/, async (req, res) => {
    const identifier = decodeURIComponent((req.params as Record<string, string>)[0] || "");
    const resolved = resolveRoomIdentifier(identifier);
    if (resolved.type === "invite") {
      res.json(resolved);
      return;
    }

    const project = await getProjectById(resolved.name);
    res.json({
      ...resolved,
      canonical_room_id: project?.id ?? resolved.name,
    });
  });

  app.get("/:provider/:owner/:repo", (req, res, next) => {
    const provider = req.params.provider.toLowerCase();

    if (!isKnownProvider(provider)) {
      return next();
    }

    const roomKey = `${provider}/${req.params.owner}/${req.params.repo}`;
    const normalized = normalizeRoomName(roomKey);
    res.redirect(301, `/in/${normalized}`);
  });

  app.get(/^\/in\/(.+)$/, async (req: AuthenticatedRequest, res) => {
    const roomIdentifier = decodeURIComponent((req.params as Record<string, string>)[0] || "");
    const resolved = resolveRoomIdentifier(roomIdentifier);

    if (resolved.type === "room") {
      const project = await getProjectById(resolved.name);
      const canonicalRoomId = project?.id ?? resolved.name;

      if (canonicalRoomId !== roomIdentifier) {
        res.redirect(301, `/in/${canonicalRoomId}`);
        return;
      }

      if (deps.isRepoBackedRoomId(canonicalRoomId)) {
        const decision = await deps.resolveGitHubRoomEntryDecision({
          roomName: canonicalRoomId,
          sessionAccount: req.sessionAccount,
          redirectTo: `/in/${canonicalRoomId}`,
        });

        if (decision.kind === "redirect") {
          res.redirect(302, decision.location);
          return;
        }
      }
    }

    sendAppPage(res);
  });

  app.get("/rooms/resolve/:identifier", async (req, res) => {
    const identifier = decodeURIComponent(req.params.identifier);
    const normalized = normalizeRoomId(identifier);
    const resolved = resolveRoomIdentifier(normalized);
    if (resolved.type === "invite") {
      res.json({ input: identifier, normalized, resolved });
      return;
    }

    const project = await getProjectById(resolved.name);
    res.json({
      input: identifier,
      normalized,
      resolved,
      canonical_room_id: project?.id ?? resolved.name,
    });
  });
}
