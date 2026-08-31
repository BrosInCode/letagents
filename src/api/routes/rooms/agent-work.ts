import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Express, Response } from "express";
import { isSupervisorHostGrantFeatureEnabled } from "../../../shared/agent-session-bearer.js";
import type { RoomAgentWorkPollResponse } from "../../../shared/room-agent-work.js";
import { publishRoomAgentWork, readRoomAgentWork, RoomAgentWorkError } from "../../db/room-agent-work.js";
import { parsePollTimeout, respondWithInternalError, type AuthenticatedRequest } from "../../http/helpers.js";
import { resolveRequestAuth } from "../../request/auth.js";
import { reauthorizeGitRoomParticipant, resolveRequestProjectRepoAccessRoomName } from "../../rooms/access.js";
import { acquireLiveRoomAuthorization, type LiveRoomAuthorizationLease } from "../../rooms/live-authorization.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import { requireCurrentSupervisorGrant, respondToStaleSupervisorGrantFence, type RoomResolverDeps } from "../supervisor-host-grants.js";
import { resolveParticipantRoom, routeParam } from "./messages/helpers.js";
import type { RoomMessageRouteDeps } from "./messages/types.js";

export function registerRoomAgentWorkRoutes(app: Express, roomDeps: RoomMessageRouteDeps, supervisorDeps: RoomResolverDeps): void {
  // Reads remain available when grant rollout is disabled. These are retained
  // host reports, not current liveness. Register poll before the detail route.
  app.get(/^\/rooms\/(.+)\/agent-work\/poll$/, (req: AuthenticatedRequest, res) => pollRoomAgentWork(req, res, roomDeps));
  app.get(/^\/rooms\/(.+)\/agent-work(?:\/([^/]+))?$/, async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount?.account_id || (req.authKind !== "session" && req.authKind !== "owner_token")) {
      res.status(401).json({ error: "Room work history requires human account authentication." }); return;
    }
    const room = await resolveParticipantRoom(req, res, roomDeps);
    if (!room) return;
    const attemptId = routeParam(req, 1);
    if (attemptId && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attemptId)) {
      res.status(404).json({ error: "Work evidence is not available in this room." }); return;
    }
    try {
      const result = await readRoomAgentWork({ room_id: room.id, ...(attemptId ? { attempt_id: attemptId } : {}) });
      if (attemptId && result.work.length === 0) {
        res.status(404).json({ error: "Work evidence is not available in this room." }); return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(attemptId ? result.work[0] : result);
    } catch (error) { respondWithInternalError(res, "room-agent-work.read", error, "Could not read room work evidence."); }
  });

  if (!isSupervisorHostGrantFeatureEnabled()) return;
  app.post("/supervisor-host-grants/:grantId/worker-sessions/:sessionId/agent-work", async (req: AuthenticatedRequest, res) => {
    if (req.authKind !== "supervisor_grant" || req.supervisorGrant?.grant_id !== req.params.grantId) {
      res.status(403).json({ error: "A current supervisor grant is required." }); return;
    }
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["room_id", "source_message_id", "revision", "summary", "generation"].includes(key))
      || typeof body.room_id !== "string" || body.room_id.length > 512 || !body.room_id.trim()
      || typeof body.source_message_id !== "string" || !/^msg_[1-9]\d{0,9}$/.test(body.source_message_id)
      || Number(body.source_message_id.slice(4)) > 2147483647) {
      res.status(400).json({ error: "Invalid room work snapshot." }); return;
    }
    try {
      const roomId = await supervisorDeps.resolveCanonicalRoomRequestId(normalizeRoomId(body.room_id));
      const grant = await requireCurrentSupervisorGrant(req, res, supervisorDeps, { kind: "rooms", room_ids: [roomId] });
      if (!grant) return;
      const result = await publishRoomAgentWork({
        fence: { grant_id: grant.grant_id, generation: grant.current_generation, token_version: grant.token_version },
        room_id: roomId, session_id: String(req.params.sessionId), source_message_number: Number(body.source_message_id.slice(4)),
        revision: body.revision as number, summary: body.summary,
      });
      res.status(result.status === "created" ? 201 : 200).json(result);
    } catch (error) {
      if (respondToStaleSupervisorGrantFence(res, error)) return;
      if (error instanceof RoomAgentWorkError) {
        res.status(error.code === "invalid_summary" ? 400 : error.code === "publisher_not_authorized" ? 403 : 409)
          .json({ error: "Room work snapshot was not accepted.", code: error.code }); return;
      }
      respondWithInternalError(res, "room-agent-work.publish", error, "Could not store room work evidence.");
    }
  });
}

async function pollRoomAgentWork(req: AuthenticatedRequest, res: Response, deps: RoomMessageRouteDeps): Promise<void> {
  const cancellation = new AbortController();
  const onClose = () => cancellation.abort();
  res.once("close", onClose);
  let authorization: LiveRoomAuthorizationLease | undefined;
  let authorizationEpoch = 0;
  let stopInvalidation: (() => void) | undefined;
  const closed = () => cancellation.signal.aborted || res.destroyed;
  const accountId = req.sessionAccount?.account_id;
  try {
    if (closed()) return;
    if (!accountId || (req.authKind !== "session" && req.authKind !== "owner_token")) {
      res.status(401).json({ error: "Room work history requires human account authentication." }); return;
    }
    const room = await resolveParticipantRoom(req, res, deps);
    if (!room || closed()) return;
    const after = req.query.after;
    const prefix = `rw1.${createHash("sha256").update(JSON.stringify([room.id, accountId])).digest("hex")}.`;
    if (after !== undefined && (typeof after !== "string" || !/^rw1\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(after) || !after.startsWith(prefix))) {
      res.status(409).json({ error: "Room work cursor is not valid for this view.", code: "invalid_cursor" }); return;
    }
    const accessRoomName = await (deps.resolveRequestProjectRepoAccessRoomName ?? resolveRequestProjectRepoAccessRoomName)(req, room);
    if (closed()) return;
    authorization = acquireLiveRoomAuthorization({
      req, roomId: room.id, accessRoomName,
      authorize: () => (deps.reauthorizeGitRoomParticipant ?? reauthorizeGitRoomParticipant)(req, room),
    });
    stopInvalidation = authorization.onInvalidated(() => { authorizationEpoch++; });
    // Bound intentional waiting, not the duration of database/upstream checks.
    const deadline = performance.now() + Math.min(30_000, parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined));
    const currentReaderEpoch = async (): Promise<number | null> => {
      // Shared repository leases may originate from a public-room message
      // stream whose callback skips credential checks. Keep this check outside
      // that lease and after any upstream refresh, even for public rooms.
      const epoch = authorizationEpoch;
      if (closed() || !(await authorization!.check())) return null;
      const fresh = await resolveRequestAuth(req);
      return !closed() && fresh.account?.account_id === accountId && fresh.authKind === req.authKind
        ? epoch : null;
    };
    while (!closed()) {
      if ((await currentReaderEpoch()) !== authorizationEpoch) {
        if (!closed()) res.status(403).json({ error: "Room access is no longer authorized." });
        return;
      }
      if (closed()) return;
      // One SQL snapshot filters visibility before ordering and LIMIT. The
      // digest covers precisely that canonical public body, including truncation.
      const snapshot = await readRoomAgentWork({ room_id: room.id });
      if (closed()) return;
      const cursor = prefix + createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      if (after !== cursor || performance.now() >= deadline) {
        // A repository invalidation during the final credential lookup also
        // fails closed. No asynchronous work follows this fence before JSON.
        if ((await currentReaderEpoch()) !== authorizationEpoch) {
          if (!closed()) res.status(403).json({ error: "Room access is no longer authorized." });
          return;
        }
        if (closed()) return;
        const response: RoomAgentWorkPollResponse = after !== cursor
          ? { room_id: room.id, cursor, changed: true, snapshot }
          : { room_id: room.id, cursor, changed: false, snapshot: null };
        res.setHeader("Cache-Control", "no-store");
        res.json(response); return;
      }
      // No broker subscription: hidden activity cannot wake a response or
      // reset its deadline. Periodic authoritative reads also survive event loss.
      await delay(Math.min(1_000, Math.max(0, deadline - performance.now())), undefined, { signal: cancellation.signal });
    }
  } catch (error) {
    if (!closed()) respondWithInternalError(res, "room-agent-work.poll", error, "Could not read room work evidence.");
  } finally {
    stopInvalidation?.();
    authorization?.release();
    res.off("close", onClose);
  }
}
