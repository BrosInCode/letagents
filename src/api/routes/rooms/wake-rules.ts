import type { Express, Response } from "express";

import { WakeRuleError, type WakeRuleActor } from "../../../../shared/wake-rules.mjs";
import { hashToken } from "../../db/utils.js";
import { listWakeRules, type WakeRuleCredential } from "../../db/wake-rules.js";
import { inProcessPrincipal } from "../../remote-mcp/in-process-dispatch.js";
import { parseBearerAuthorization } from "../../request/bearer-authorization.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { isHumanAppWrite } from "../../request/app-session.js";
import { requireWorkerRequestAgentIdentity, type ResolvedRequestAgentIdentity } from "../../request/agent-identity.js";
import { addWakeWebhookRuleForPerson, listOwnedWakeAgents } from "../../wake-rules/person-webhook.js";
import { addWakeRuleForAgent, cancelWakeRuleAs, restoreWakeRuleAs } from "../../wake-rules/service.js";
import { testWakeWebhookRule } from "../../wake-rules/webhook-test.js";
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

/**
 * The person behind an app session, for the routes only a person may call
 * (adding and testing a webhook rule for an agent they own). An owner token,
 * a worker bearer or a remote MCP session is not a person here: an agent
 * adds its own rules. A write authenticated by the session cookie alone must
 * come from this app's own origin (a bearer session, as the desktop app
 * sends, carries no ambient cookie and needs no origin).
 */
function requirePerson(req: AuthenticatedRequest): { id: string; login: string } {
  const person = human(req);
  if (!person) throw new WakeRuleError("Only a signed-in person can do this for an agent they own. Agents add their own wake rules.", 403);
  if (parseBearerAuthorization(req.headers.authorization).kind !== "token" && !["GET", "HEAD"].includes(req.method)) {
    const origin = req.headers.origin;
    const expected = process.env.LETAGENTS_BASE_URL || process.env.PUBLIC_API_URL;
    const allowed = expected ? new URL(expected).origin : `${req.protocol}://${req.get("host")}`;
    if (!origin || origin !== allowed) throw new WakeRuleError("Open this action from LetAgents.", 403);
  }
  return { id: person.id, login: person.label };
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

/** The form's webhook fields, as the person sent them; the rule body is built on the server. */
function personWebhookForm(body: Record<string, unknown>): { url: string; secret: string; bearer?: string; note?: string | null } {
  const rule = body.rule;
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new WakeRuleError("rule must be an object with webhook { url, secret }.", 400);
  const { event, webhook, note } = rule as Record<string, unknown>;
  if (event !== undefined && event !== "room.message") throw new WakeRuleError("The app adds room.message webhook rules only.", 400);
  if (!webhook || typeof webhook !== "object" || Array.isArray(webhook)) throw new WakeRuleError("rule.webhook must be an object with url and secret.", 400);
  const { url, secret, bearer } = webhook as Record<string, unknown>;
  return {
    url: typeof url === "string" ? url : "",
    secret: typeof secret === "string" ? secret : "",
    ...(bearer !== undefined && bearer !== "" ? { bearer: bearer as string } : {}),
    note: typeof note === "string" ? note : null,
  };
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

  // The agents the signed-in person owns in the room: the webhook wake-up form's agent picker.
  app.get(/^\/rooms\/(.+)\/wake-rules\/my-agents$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      const person = requirePerson(req);
      res.json({ room_id: project.id, agents: await listOwnedWakeAgents(project.id, person.id) });
    } catch (error) { fail(res, error); }
  });

  // Agents set their own rules. A person adds a webhook rule for an agent
  // they own by naming it (`agent_key`); the rule is bound to the sign-in
  // behind that agent, as if the agent had added it.
  app.post(/^\/rooms\/(.+)\/wake-rules$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.agent_key === "string") {
        const person = requirePerson(req);
        const { rule, created } = await addWakeWebhookRuleForPerson({
          roomId: project.id, accountId: person.id, agentKey: body.agent_key, form: personWebhookForm(body),
        });
        res.status(created ? 201 : 200).json({ rule, created });
        return;
      }
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

  // One test delivery, by the account that owns the rule's agent; the result comes back at once.
  app.post(/^\/rooms\/(.+)\/wake-rules\/([^/]+)\/test$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      const person = requirePerson(req);
      res.json(await testWakeWebhookRule({ roomId: project.id, ruleId: routeParam(req, 1), account: person }));
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
