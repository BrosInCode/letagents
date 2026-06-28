import type { Express } from "express";

import type { GitRoomBinding, Project } from "../../db.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import {
  formatGitRoomSummary,
  formatManualGitRoomSummaryForRoomId,
} from "../../rooms/formatting.js";
import {
  isKnownProvider,
  normalizeRoomId,
  normalizeRoomName,
  resolveRoomIdentifier,
} from "../../rooms/routing.js";
import { sendAppPage } from "../web/index.js";

export interface RoomEntryRouteDeps {
  getProjectById(roomId: string): Promise<Project | null | undefined>;
  getGitRoomBindingForRoom?(roomId: string): Promise<GitRoomBinding | null>;
  isRepoBackedRoomId(roomId: string): boolean;
  resolveGitHubRoomEntryDecision(input: {
    roomName: string;
    sessionAccount: AuthenticatedRequest["sessionAccount"];
    redirectTo: string;
  }): Promise<
    | { kind: "allow" }
    | { kind: "redirect"; location: string }
  >;
  resolveProjectRoomEntryDecision(input: {
    project: Project;
    sessionAccount: AuthenticatedRequest["sessionAccount"];
    redirectTo: string;
  }): Promise<
    | { kind: "allow" }
    | { kind: "redirect"; location: string }
  >;
}

export function buildRoomEntryPath(roomId: string, originalUrl?: string): string {
  const queryIndex = originalUrl?.indexOf("?") ?? -1;
  const suffix = queryIndex >= 0 && originalUrl ? originalUrl.slice(queryIndex) : "";
  return `/in/${roomId}${suffix}`;
}

async function resolveRoomGitSummary(
  roomId: string,
  deps: Pick<RoomEntryRouteDeps, "getGitRoomBindingForRoom">
): Promise<ReturnType<typeof formatGitRoomSummary>> {
  const binding = deps.getGitRoomBindingForRoom
    ? await deps.getGitRoomBindingForRoom(roomId)
    : null;
  return formatGitRoomSummary(binding) ?? formatManualGitRoomSummaryForRoomId(roomId);
}

export async function buildApiRoomResolvePayload(
  identifier: string,
  deps: Pick<RoomEntryRouteDeps, "getProjectById" | "getGitRoomBindingForRoom">
): Promise<Record<string, unknown>> {
  const resolved = resolveRoomIdentifier(identifier);
  if (resolved.type === "invite") {
    return resolved;
  }

  const project = await deps.getProjectById(resolved.name);
  const canonicalRoomId = project?.id ?? resolved.name;
  return {
    ...resolved,
    canonical_room_id: canonicalRoomId,
    git_room: await resolveRoomGitSummary(canonicalRoomId, deps),
  };
}

export async function buildPublicRoomResolvePayload(
  identifier: string,
  deps: Pick<RoomEntryRouteDeps, "getProjectById" | "getGitRoomBindingForRoom">
): Promise<Record<string, unknown>> {
  const normalized = normalizeRoomId(identifier);
  const resolved = resolveRoomIdentifier(normalized);
  if (resolved.type === "invite") {
    return { input: identifier, normalized, resolved };
  }

  const project = await deps.getProjectById(resolved.name);
  const canonicalRoomId = project?.id ?? resolved.name;
  return {
    input: identifier,
    normalized,
    resolved,
    canonical_room_id: canonicalRoomId,
    git_room: await resolveRoomGitSummary(canonicalRoomId, deps),
  };
}

export function registerRoomEntryRoutes(
  app: Express,
  deps: RoomEntryRouteDeps
): void {
  app.get(/^\/api\/rooms\/resolve\/(.+)$/, async (req, res) => {
    const identifier = decodeURIComponent((req.params as Record<string, string>)[0] || "");
    res.json(await buildApiRoomResolvePayload(identifier, deps));
  });

  app.get("/:provider/:owner/:repo", (req, res, next) => {
    const provider = req.params.provider.toLowerCase();

    if (!isKnownProvider(provider)) {
      return next();
    }

    const roomKey = `${provider}/${req.params.owner}/${req.params.repo}`;
    const normalized = normalizeRoomName(roomKey);
    res.redirect(301, buildRoomEntryPath(normalized, req.originalUrl));
  });

  app.get(/^\/in\/(.+)$/, async (req: AuthenticatedRequest, res) => {
    const roomIdentifier = decodeURIComponent((req.params as Record<string, string>)[0] || "");
    const resolved = resolveRoomIdentifier(roomIdentifier);

    if (resolved.type === "room") {
      const project = await deps.getProjectById(resolved.name);
      const canonicalRoomId = project?.id ?? resolved.name;
      const redirectTo = buildRoomEntryPath(canonicalRoomId, req.originalUrl);

      if (canonicalRoomId !== roomIdentifier) {
        res.redirect(301, redirectTo);
        return;
      }

      if (project) {
        const decision = await deps.resolveProjectRoomEntryDecision({
          project,
          sessionAccount: req.sessionAccount,
          redirectTo,
        });

        if (decision.kind === "redirect") {
          res.redirect(302, decision.location);
          return;
        }
      } else if (deps.isRepoBackedRoomId(canonicalRoomId)) {
        const decision = await deps.resolveGitHubRoomEntryDecision({
          roomName: canonicalRoomId,
          sessionAccount: req.sessionAccount,
          redirectTo,
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
    res.json(await buildPublicRoomResolvePayload(identifier, deps));
  });
}
