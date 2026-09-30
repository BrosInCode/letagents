import type { Express, Response } from "express";

import { WakeRuleError, type WakeRuleActor } from "../../../../shared/wake-rules.mjs";
import { listWakeRules } from "../../db/wake-rules.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { isHumanAppWrite } from "../../request/app-session.js";
import { requireWorkerRequestAgentIdentity, type ResolvedRequestAgentIdentity } from "../../request/agent-identity.js";
import { addWakeRuleForAgent, cancelWakeRuleAs, restoreWakeRuleAs } from "../../wake-rules/service.js";
import { resolveParticipantRoom, routeParam } from "./messages/helpers.js";
import type { RoomMessageRouteDeps } from "./messages/types.js";

export type WakeRuleRouteDeps = Pick<RoomMessageRouteDeps, "resolveCanonicalRoomRequestId" | "resolveRoomOrReply" | "requireParticipant">;

function fail(res: Response, error: unknown): void {
  if (error instanceof WakeRuleError) res.status(error.status).json({ error: error.message });
  else {
    console.error("[wake rules]", error);
    res.status(500).json({ error: "Unable to save or load wake rules. Please retry." });
  }
}

function human(req: AuthenticatedRequest): WakeRuleActor | null {
  return req.sessionAccount && isHumanAppWrite(req, req.body ?? {})
    ? { kind: "human", id: req.sessionAccount.account_id, label: req.sessionAccount.login }
    : null;
}

async function worker(req: AuthenticatedRequest, roomId: string): Promise<ResolvedRequestAgentIdentity> {
  const result = await requireWorkerRequestAgentIdentity({ req, room_id: roomId, body: req.body ?? {} });
  if (!result.ok) throw new WakeRuleError(result.error, result.status);
  return result.identity;
}

async function actor(req: AuthenticatedRequest, roomId: string): Promise<WakeRuleActor> {
  const person = human(req);
  if (person) return person;
  const identity = await worker(req, roomId);
  return { kind: "agent", id: identity.agent_key, label: identity.display_name || identity.actor_label };
}

export function registerWakeRuleRoutes(app: Express, deps: WakeRuleRouteDeps): void {
  const room = (req: AuthenticatedRequest, res: Response) => resolveParticipantRoom(req, res, deps as RoomMessageRouteDeps);

  app.get(/^\/rooms\/(.+)\/wake-rules$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      const agentKey = typeof req.query.agent_key === "string" && req.query.agent_key.trim() ? req.query.agent_key.trim() : undefined;
      res.json(await listWakeRules(project.id, { agentKey }));
    } catch (error) { fail(res, error); }
  });

  // Agents set their own rules. A person reaches an agent by messaging it.
  app.post(/^\/rooms\/(.+)\/wake-rules$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      const identity = await worker(req, project.id);
      const { rule, created } = await addWakeRuleForAgent({
        roomId: project.id,
        agent: {
          agent_key: identity.agent_key,
          agent_name: identity.display_name || identity.actor_label,
          session_id: identity.agent_session_id,
        },
        body: req.body?.rule,
      });
      res.status(created ? 201 : 200).json({ rule, created });
    } catch (error) { fail(res, error); }
  });

  for (const [action, apply] of [["cancel", cancelWakeRuleAs], ["restore", restoreWakeRuleAs]] as const) {
    app.post(new RegExp(`^/rooms/(.+)/wake-rules/([^/]+)/${action}$`), async (req: AuthenticatedRequest, res) => {
      try {
        const project = await room(req, res); if (!project) return;
        res.json({ rule: await apply(project.id, routeParam(req, 1), await actor(req, project.id)) });
      } catch (error) { fail(res, error); }
    });
  }
}
