import type { Express, Response } from "express";

import { WakeRuleError, type WakeRuleActor } from "../../../../shared/wake-rules.mjs";
import { hashToken } from "../../db/utils.js";
import { listWakeRules, type WakeRuleCredential } from "../../db/wake-rules.js";
import { inProcessPrincipal } from "../../remote-mcp/in-process-dispatch.js";
import { parseBearerAuthorization } from "../../request/bearer-authorization.js";
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

/**
 * The credential behind this request, which a webhook or email rule is bound
 * to: a remote MCP session's owner token or OAuth grant (by the hash the
 * session holds), an owner token sent directly (by its hash), or a worker
 * bearer's session.
 */
function registeringCredential(req: AuthenticatedRequest): WakeRuleCredential | null {
  const internal = inProcessPrincipal(req);
  if (internal) return { kind: "token", ref: internal.tokenHash };
  if (req.authKind === "owner_token") {
    const bearer = parseBearerAuthorization(req.headers.authorization);
    return bearer.kind === "token" ? { kind: "token", ref: hashToken(bearer.token) } : null;
  }
  if (req.authKind === "agent_session" && req.agentSession) return { kind: "agent_session", ref: req.agentSession.agent_session_id };
  return null;
}

/** The account asking: it alone sees the delivery details of its own agents' webhook rules. */
function viewer(req: AuthenticatedRequest): { accountId: string | null } {
  return { accountId: req.sessionAccount?.account_id ?? req.agentSession?.owner_account_id ?? null };
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
      res.json(await listWakeRules(project.id, { agentKey, viewer: viewer(req) }));
    } catch (error) { fail(res, error); }
  });

  // Agents set their own rules. A person reaches an agent by messaging it.
  app.post(/^\/rooms\/(.+)\/wake-rules$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      const identity = await worker(req, project.id);
      const { rule, created, confirmation } = await addWakeRuleForAgent({
        roomId: project.id,
        agent: {
          agent_key: identity.agent_key,
          agent_name: identity.display_name || identity.actor_label,
          session_id: identity.agent_session_id,
          owner_account_id: identity.owner_account_id ?? null,
        },
        body: req.body?.rule,
        credential: registeringCredential(req),
      });
      res.status(created ? 201 : 200).json({ rule, created, ...(confirmation ? { confirmation } : {}) });
    } catch (error) { fail(res, error); }
  });

  for (const [action, apply] of [["cancel", cancelWakeRuleAs], ["restore", restoreWakeRuleAs]] as const) {
    app.post(new RegExp(`^/rooms/(.+)/wake-rules/([^/]+)/${action}$`), async (req: AuthenticatedRequest, res) => {
      try {
        const project = await room(req, res); if (!project) return;
        res.json({ rule: await apply(project.id, routeParam(req, 1), await actor(req, project.id), viewer(req)) });
      } catch (error) { fail(res, error); }
    });
  }
}
