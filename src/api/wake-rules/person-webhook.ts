/**
 * A person adds a webhook wake rule for one of their own agents from the app,
 * without handing the URL and key to the bot by chat. The rule is the same
 * rule the agent would add itself over MCP (`addWakeRuleForAgent`: the same
 * URL guard, sealing, budgets and identity), made for the agent the person
 * owns in the room and bound to the sign-in behind that agent.
 */
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { WakeRuleError, type WakeRule, type WakeWebhookAgent, type WakeWebhookFormInput } from "../../../shared/wake-rules.mjs";
import { db } from "../db/client.js";
import { remote_mcp_sessions, room_agent_sessions } from "../db/schema.js";
import type { WakeRuleCredential } from "../db/wake-rules.js";
import { addWakeRuleForAgent } from "./service.js";
import type { WakeWebhookLookup } from "./webhook-url.js";

/** An agent that ended longer ago than this is no longer offered. */
const OWNED_AGENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface OwnedAgentSession {
  session_id: string;
  agent_key: string;
  display_name: string;
  agent_instance_id: string | null;
  last_seen_at: string;
  ended_at: string | null;
}

/**
 * The account's worker sessions in the room, newest first: live ones, and
 * ones that ended in the past 30 days (a hosted bot's session ends after a
 * while of silence; a mention by name still wakes it by webhook).
 */
async function ownedAgentSessions(roomId: string, accountId: string, now: Date): Promise<OwnedAgentSession[]> {
  const since = new Date(now.getTime() - OWNED_AGENT_WINDOW_MS).toISOString();
  return db.select({
    session_id: room_agent_sessions.session_id,
    agent_key: room_agent_sessions.agent_key,
    display_name: room_agent_sessions.display_name,
    agent_instance_id: room_agent_sessions.agent_instance_id,
    last_seen_at: room_agent_sessions.last_seen_at,
    ended_at: room_agent_sessions.ended_at,
  }).from(room_agent_sessions).where(and(
    eq(room_agent_sessions.room_id, roomId),
    eq(room_agent_sessions.owner_account_id, accountId),
    eq(room_agent_sessions.session_kind, "worker"),
    or(isNull(room_agent_sessions.ended_at), gt(room_agent_sessions.last_seen_at, since)),
  )).orderBy(sql`${room_agent_sessions.ended_at} IS NULL DESC`, desc(room_agent_sessions.last_seen_at), desc(room_agent_sessions.session_id));
}

/** One entry per agent: its newest session decides the name and whether it is live. */
function byAgent(sessions: readonly OwnedAgentSession[]): Map<string, OwnedAgentSession> {
  const agents = new Map<string, OwnedAgentSession>();
  for (const session of sessions) if (!agents.has(session.agent_key)) agents.set(session.agent_key, session);
  return agents;
}

/** The agents the account owns in the room, as the app's agent picker lists them. */
export async function listOwnedWakeAgents(roomId: string, accountId: string, now = new Date()): Promise<WakeWebhookAgent[]> {
  return [...byAgent(await ownedAgentSessions(roomId, accountId, now)).values()].map((session) => ({
    agent_key: session.agent_key,
    agent_name: session.display_name,
    live: session.ended_at === null,
    last_seen_at: new Date(session.last_seen_at).toISOString(),
  }));
}

/**
 * The sign-in behind the agent, which the rule is bound to so that it ends
 * when that sign-in is removed. A worker registered over the remote MCP
 * connector (ChatGPT, Grok Bot) is reached through an owner token or an
 * OAuth grant: the remote MCP session that holds the worker names that
 * credential by its hash, and the rule binds to it like a rule the agent
 * added itself over `/mcp`. Any other worker (a desktop-supervised agent, a
 * bot that uses its worker bearer) binds to its live worker session, as a
 * rule added with that bearer does.
 */
export async function ownedAgentCredential(
  accountId: string,
  session: Pick<OwnedAgentSession, "session_id" | "agent_instance_id" | "ended_at">,
): Promise<WakeRuleCredential | null> {
  const [remote] = await db.select({ token_hash: remote_mcp_sessions.token_hash }).from(remote_mcp_sessions).where(and(
    eq(remote_mcp_sessions.account_id, accountId),
    session.agent_instance_id
      ? or(eq(remote_mcp_sessions.worker_session_id, session.session_id), eq(remote_mcp_sessions.agent_instance_id, session.agent_instance_id))
      : eq(remote_mcp_sessions.worker_session_id, session.session_id),
  )).orderBy(desc(remote_mcp_sessions.last_seen_at)).limit(1);
  if (remote) return { kind: "token", ref: remote.token_hash };
  return session.ended_at === null ? { kind: "agent_session", ref: session.session_id } : null;
}

/** The webhook fields of the form, as the rule body `addWakeRuleForAgent` reads. */
export function wakeWebhookRuleBody(input: WakeWebhookFormInput): Record<string, unknown> {
  return {
    event: "room.message",
    arguments: { mentions_me: true },
    ...(input.note ? { note: input.note } : {}),
    webhook: { url: input.url, secret: input.secret, ...(input.bearer ? { bearer: input.bearer } : {}) },
  };
}

/**
 * Add (or renew) a `room.message` webhook rule for an agent the account owns
 * in the room. Refused for an agent of another account, and for an agent
 * with neither a remote sign-in nor a live session to bind the rule to.
 */
export async function addWakeWebhookRuleForPerson(input: {
  roomId: string;
  accountId: string;
  agentKey: string;
  form: WakeWebhookFormInput;
  webhookLookup?: WakeWebhookLookup;
  now?: Date;
}): Promise<{ rule: WakeRule; created: boolean }> {
  const agentKey = input.agentKey.trim();
  if (!agentKey) throw new WakeRuleError("Choose one of your agents in this room.", 400);
  const agent = byAgent(await ownedAgentSessions(input.roomId, input.accountId, input.now ?? new Date())).get(agentKey);
  if (!agent) throw new WakeRuleError("You can add a wake-up only for an agent that belongs to your account in this room.", 403);
  const credential = await ownedAgentCredential(input.accountId, agent);
  if (!credential) {
    throw new WakeRuleError("This agent has no live session and no remote sign-in to bind the wake-up to. Connect the agent to the room again, then add the wake-up.", 409);
  }
  const { rule, created } = await addWakeRuleForAgent({
    roomId: input.roomId,
    agent: { agent_key: agent.agent_key, agent_name: agent.display_name, session_id: agent.session_id, owner_account_id: input.accountId },
    body: wakeWebhookRuleBody(input.form),
    credential,
    webhookLookup: input.webhookLookup,
  });
  return { rule, created };
}
