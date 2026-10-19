import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import {
  createSupervisorHostGrant,
  endRoomAgentSession,
  getAgentIdentityByCanonicalKey,
  revokeSupervisorHostGrant,
} from "../db.js";
import { db } from "../db/client.js";
import { accounts, agent_asks, room_agent_sessions, supervisor_host_grants } from "../db/schema.js";
import { hashToken } from "../db/utils.js";
import { emitProjectMessage } from "../server/events.js";
import { removeWorkspace } from "./workspace.js";
import {
  ASK_CLAIM_TTL_MS, ASK_HOLD_TTL_MS, ASK_LINK_TTL_MS, ASK_LIVE_STATES, ASK_OFFLINE_AFTER_MS, ASK_OPEN_LIMIT,
  ASK_PAUSE_TTL_MS, ASK_ROOM_TEXT, isExactMatch, type AgentAskEndReason, type AgentAskState,
} from "./lifecycle.js";

export type AgentAsk = typeof agent_asks.$inferSelect;
export const ASK_GRANT_SCOPE_PREFIX = "ask:";
const ASK_GRANT_TTL_MS = 24 * 60 * 60_000;

const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
export const askGrantScope = (askId: string) => `${ASK_GRANT_SCOPE_PREFIX}${askId}`;
export const askIdFromGrantScope = (scope: string | null | undefined) =>
  scope?.startsWith(ASK_GRANT_SCOPE_PREFIX) ? scope.slice(ASK_GRANT_SCOPE_PREFIX.length) : null;

async function person(accountId: string | null) {
  if (!accountId) return { name: "Someone", notify: [] as Array<{ login: string; github_user_id: string | null }> };
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!row) return { name: "Someone", notify: [] };
  return { name: row.display_name || row.login, notify: row.provider === "github" ? [{ login: row.login, github_user_id: row.provider_user_id }] : [] };
}

/** A silent system line in the room; never addresses or wakes an agent. */
async function say(ask: AgentAsk, event: string, text: string, notifyAccountId: string | null = null) {
  const notify = notifyAccountId ? (await person(notifyAccountId)).notify : [];
  await emitProjectMessage(ask.room_id, "letagents", text, {
    source: "system", display_text: text, client_message_id: `agent_ask:${ask.id}:${event}`,
    ...(notify.length ? { notify_github_users: notify } : {}),
  }).catch(error => console.error("[agent asks] room message failed", ask.id, event, error));
}

/** First writer wins: the update only applies while the row is still in `from`. */
async function move(id: string, from: readonly AgentAskState[], set: Partial<typeof agent_asks.$inferInsert>) {
  const [row] = await db.update(agent_asks).set({ ...set, updated_at: now() })
    .where(and(eq(agent_asks.id, id), inArray(agent_asks.state, [...from]))).returning();
  return row ?? null;
}

async function expireIfDue(ask: AgentAsk): Promise<AgentAsk> {
  if ((ask.state === "open" || ask.state === "claimed") && Date.parse(ask.expires_at) <= Date.now()) {
    if (ask.grant_id) await revokeAskAuthority(ask);
    return (await move(ask.id, ["open", "claimed"], { state: "expired", ended_at: now() })) ?? ask;
  }
  return ask;
}

export async function createAsk(input: {
  askerAccountId: string; roomId: string; providerId: string; model: string | null; modelLabel: string;
  amountPercent: number | null; note: string;
}) {
  const token = randomBytes(24).toString("base64url");
  const created = await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1095979851, hashtext(${input.askerAccountId}))`);
    const count = await tx.execute(sql`SELECT count(*)::int AS total FROM agent_asks
      WHERE asker_account_id = ${input.askerAccountId} AND state IN ('open', 'claimed') AND expires_at > now()`);
    if (Number(count.rows[0]?.total) >= ASK_OPEN_LIMIT) return { error: "ask_limit" } as const;
    const [ask] = await tx.insert(agent_asks).values({
      id: `ask_${randomUUID()}`, link_token_hash: hashToken(token), room_id: input.roomId,
      asker_account_id: input.askerAccountId, provider_id: input.providerId, model: input.model,
      model_label: input.modelLabel, amount_percent: input.amountPercent, note: input.note,
      expires_at: later(ASK_LINK_TTL_MS),
    }).returning();
    return { ask: ask! } as const;
  });
  if (!created.ask) return { error: created.error } as const;
  const asker = await person(input.askerAccountId);
  await say(created.ask, "asked", ASK_ROOM_TEXT.asked(asker.name, input.modelLabel));
  return { ask: created.ask, token, error: null } as const;
}

export async function getAskByToken(token: string): Promise<AgentAsk | null> {
  const [ask] = await db.select().from(agent_asks).where(eq(agent_asks.link_token_hash, hashToken(token))).limit(1);
  return ask ? expireIfDue(ask) : null;
}

export async function getAskById(id: string): Promise<AgentAsk | null> {
  const [ask] = await db.select().from(agent_asks).where(eq(agent_asks.id, id)).limit(1);
  return ask ? expireIfDue(ask) : null;
}

export async function listRoomAsks(roomId: string): Promise<AgentAsk[]> {
  return db.select().from(agent_asks)
    .where(and(eq(agent_asks.room_id, roomId), inArray(agent_asks.state, [...ASK_LIVE_STATES])))
    .orderBy(desc(agent_asks.created_at)).limit(50);
}

export async function listAccountAsks(accountId: string): Promise<AgentAsk[]> {
  return db.select().from(agent_asks)
    .where(sql`(${agent_asks.asker_account_id} = ${accountId} OR ${agent_asks.giver_account_id} = ${accountId})
      AND ${agent_asks.created_at} > now() - INTERVAL '30 days'`)
    .orderBy(desc(agent_asks.updated_at)).limit(100);
}

export async function personName(accountId: string | null): Promise<string> {
  return (await person(accountId)).name;
}

export async function cancelAsk(ask: AgentAsk) {
  if (ask.grant_id) await revokeAskAuthority(ask);
  return move(ask.id, ["open", "claimed"], { state: "cancelled", ended_at: now() });
}

/** Tapping the link reserves it (G12); the same giver renews their own claim. */
export async function claimAsk(ask: AgentAsk, giverAccountId: string) {
  const claimed = await db.update(agent_asks).set({
    state: "claimed", giver_account_id: giverAccountId, claim_expires_at: later(ASK_CLAIM_TTL_MS), updated_at: now(),
  }).where(and(eq(agent_asks.id, ask.id), gt(agent_asks.expires_at, now()), sql`(${agent_asks.state} = 'open'
    OR (${agent_asks.state} = 'claimed' AND ${agent_asks.giver_account_id} = ${giverAccountId}))`)).returning();
  return claimed[0] ?? null;
}

/** "Can't right now" or a failed start: the link goes back to open (spec rule 3). */
export async function releaseClaim(ask: AgentAsk, giverAccountId: string, cantHelp: boolean) {
  if (ask.state !== "claimed" || ask.giver_account_id !== giverAccountId) return null;
  if (ask.grant_id) await revokeAskAuthority(ask);
  const released = await move(ask.id, ["claimed"], openAgain());
  if (released && cantHelp) {
    await say(released, `cant:${randomUUID()}`, `${await personName(giverAccountId)} can't add an agent right now. The request is still open.`, released.asker_account_id);
  }
  return released;
}

function openAgain(): Partial<typeof agent_asks.$inferInsert> {
  return {
    state: "open", giver_account_id: null, claim_expires_at: null, given_provider_id: null, given_model: null,
    given_model_label: null, given_amount_percent: null, agent_key: null, grant_id: null,
    room_agent_session_id: null, hold_expires_at: null, paused_at: null,
  };
}

/** Mint a supervisor grant for exactly this room and agent, like rental's direct_member launch. */
export async function createAskLaunchAuthority(ask: AgentAsk, input: {
  giverAccountId: string; hostId: string; installationId: string; agentKey: string;
  givenProviderId: string; givenModel: string | null; givenModelLabel: string; givenAmountPercent: number;
}) {
  if (ask.state !== "claimed" || ask.giver_account_id !== input.giverAccountId) throw new Error("ask_not_claimed");
  const agent = await getAgentIdentityByCanonicalKey(input.agentKey);
  if (!agent || agent.owner_account_id !== input.giverAccountId) throw new Error("agent_identity_not_owned");
  const created = await createSupervisorHostGrant({
    owner_account_id: input.giverAccountId, host_id: input.hostId, installation_id: input.installationId,
    allowed_room_ids: [ask.room_id], allowed_agent_keys: [agent.canonical_key],
    expires_at: later(ASK_GRANT_TTL_MS), scope_key: askGrantScope(ask.id),
  });
  const updated = await move(ask.id, ["claimed"], {
    grant_id: created.grant.grant_id, agent_key: agent.canonical_key, claim_expires_at: later(ASK_CLAIM_TTL_MS),
    given_provider_id: input.givenProviderId, given_model: input.givenModel, given_model_label: input.givenModelLabel,
    given_amount_percent: input.givenAmountPercent,
  });
  if (!updated) {
    await revokeSupervisorHostGrant({ grant_id: created.grant.grant_id, owner_account_id: input.giverAccountId });
    throw new Error("ask_not_claimed");
  }
  return {
    ask: updated,
    grant: {
      grant_id: created.grant.grant_id, generation: created.grant.current_generation,
      current_generation: created.grant.current_generation, token_version: created.grant.token_version,
      expires_at: created.grant.expires_at, supervisor_grant: created.token,
    },
  };
}

/** The agent is in the room: exact match goes active, a substitute waits on hold (D15, D17). */
export async function acknowledgeAskJoin(ask: AgentAsk, input: { giverAccountId: string; roomAgentSessionId: string }) {
  if (ask.giver_account_id !== input.giverAccountId) throw new Error("ask_not_claimed");
  if (ask.state === "active" || ask.state === "on_hold") {
    if (ask.room_agent_session_id === input.roomAgentSessionId) return ask;
    throw new Error("ask_not_claimed");
  }
  if (ask.state !== "claimed" || !ask.grant_id) throw new Error("ask_not_claimed");
  const [worker] = await db.select().from(room_agent_sessions).where(and(
    eq(room_agent_sessions.session_id, input.roomAgentSessionId), eq(room_agent_sessions.room_id, ask.room_id),
    eq(room_agent_sessions.owner_account_id, input.giverAccountId), eq(room_agent_sessions.supervisor_grant_id, ask.grant_id),
    eq(room_agent_sessions.session_kind, "worker"), isNull(room_agent_sessions.ended_at),
  )).limit(1);
  if (!worker) throw new Error("ask_worker_not_ready");
  const exact = isExactMatch(ask, { providerId: ask.given_provider_id ?? "", model: ask.given_model });
  const joined = await move(ask.id, ["claimed"], exact
    ? { state: "active", room_agent_session_id: worker.session_id, claim_expires_at: null }
    : { state: "on_hold", room_agent_session_id: worker.session_id, claim_expires_at: null, hold_expires_at: later(ASK_HOLD_TTL_MS) });
  if (!joined) throw new Error("ask_not_claimed");
  const giver = await personName(input.giverAccountId);
  const label = joined.given_model_label ?? joined.model_label;
  if (exact) {
    const intro = joined.note ? ASK_ROOM_TEXT.joinedWithNote(giver, label, joined.note) : ASK_ROOM_TEXT.joined(giver, label);
    await say(joined, `joined:${worker.session_id}`, intro, joined.asker_account_id);
  } else {
    await say(joined, `substitute:${worker.session_id}`, ASK_ROOM_TEXT.substitute(giver, joined.model_label, label, await personName(joined.asker_account_id)), joined.asker_account_id);
  }
  return joined;
}

export async function acceptSubstitute(ask: AgentAsk) {
  const accepted = await move(ask.id, ["on_hold"], { state: "active", hold_expires_at: null });
  if (accepted) {
    const giver = await personName(accepted.giver_account_id);
    const label = accepted.given_model_label ?? accepted.model_label;
    await say(accepted, `joined:${accepted.room_agent_session_id}`, accepted.note ? ASK_ROOM_TEXT.joinedWithNote(giver, label, accepted.note) : ASK_ROOM_TEXT.joined(giver, label));
  }
  return accepted;
}

/** Declining a substitute removes it and reopens the link while it's still valid (S11). */
export async function declineSubstitute(ask: AgentAsk) {
  if (ask.state !== "on_hold") return null;
  await revokeAskAuthority(ask);
  await removeWorkspace(ask.id);
  const reopen = Date.parse(ask.expires_at) > Date.now();
  const declined = await move(ask.id, ["on_hold"], reopen ? openAgain() : { state: "expired", ended_at: now() });
  if (declined) await say(ask, `declined:${randomUUID()}`, ASK_ROOM_TEXT.ended.substitute_declined(await personName(ask.giver_account_id)), ask.giver_account_id);
  return declined;
}

export async function endAsk(ask: AgentAsk, reason: AgentAskEndReason) {
  await revokeAskAuthority(ask);
  await removeWorkspace(ask.id);
  const ended = await move(ask.id, ["on_hold", "active", "paused"], { state: "ended", ended_reason: reason, ended_at: now() });
  if (ended) {
    const giver = await personName(ended.giver_account_id);
    const notify = reason === "removed" ? ended.giver_account_id : ended.asker_account_id;
    await say(ended, "ended", ASK_ROOM_TEXT.ended[reason](giver, ended.given_amount_percent), notify);
  }
  return ended;
}

/** End the agent's room session, then revoke its grant. Safe to repeat. */
export async function revokeAskAuthority(ask: AgentAsk): Promise<void> {
  if (!ask.grant_id || !ask.giver_account_id) return;
  const [grant] = await db.select().from(supervisor_host_grants)
    .where(and(eq(supervisor_host_grants.grant_id, ask.grant_id), isNull(supervisor_host_grants.revoked_at))).limit(1);
  if (!grant) return;
  const workers = await db.select().from(room_agent_sessions).where(and(
    eq(room_agent_sessions.supervisor_grant_id, grant.grant_id), isNull(room_agent_sessions.ended_at)));
  for (const worker of workers) {
    await endRoomAgentSession({
      session_id: worker.session_id, owner_account_id: grant.owner_account_id, supervisor_grant_id: grant.grant_id,
      supervisor_grant_fence: { grant_id: grant.grant_id, generation: grant.current_generation, token_version: grant.token_version },
    }).catch(error => console.error("[agent asks] could not end worker", worker.session_id, error));
  }
  await revokeSupervisorHostGrant({ grant_id: grant.grant_id, owner_account_id: grant.owner_account_id });
}

/** The running ask a given agent's room session belongs to, found from its grant; the agent never names it. */
export async function askForWorker(agentSessionId: string): Promise<AgentAsk | null> {
  const [row] = await db.select({ ask: agent_asks }).from(room_agent_sessions)
    .innerJoin(agent_asks, eq(agent_asks.grant_id, room_agent_sessions.supervisor_grant_id))
    .where(and(eq(room_agent_sessions.session_id, agentSessionId), isNull(room_agent_sessions.ended_at),
      inArray(agent_asks.state, ["active", "paused"]))).limit(1);
  return row?.ask ?? null;
}

/** Grants scoped to an ask work only while that ask still has, or is starting, an agent. */
export async function isAskGrantActive(input: { askId: string; ownerAccountId: string; grantId: string }): Promise<boolean> {
  const [ask] = await db.select({ id: agent_asks.id }).from(agent_asks).where(and(
    eq(agent_asks.id, input.askId), eq(agent_asks.giver_account_id, input.ownerAccountId),
    eq(agent_asks.grant_id, input.grantId), inArray(agent_asks.state, ["claimed", "on_hold", "active", "paused"]),
  )).limit(1);
  return Boolean(ask);
}

async function workerIsLive(grantId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - ASK_OFFLINE_AFTER_MS).toISOString();
  const [worker] = await db.select({ id: room_agent_sessions.session_id }).from(room_agent_sessions).where(and(
    eq(room_agent_sessions.supervisor_grant_id, grantId), isNull(room_agent_sessions.ended_at),
    gt(room_agent_sessions.last_seen_at, cutoff))).limit(1);
  return Boolean(worker);
}

/** One bounded pass of every timeout in the spec. Runs on the shared liveness tick. */
export async function sweepAgentAsks(): Promise<void> {
  const stamp = now();
  const expired = await db.select().from(agent_asks)
    .where(and(inArray(agent_asks.state, ["open", "claimed"]), lte(agent_asks.expires_at, stamp))).limit(50);
  for (const ask of expired) await expireIfDue(ask);

  const staleClaims = await db.select().from(agent_asks)
    .where(and(eq(agent_asks.state, "claimed"), lte(agent_asks.claim_expires_at, stamp))).limit(50);
  for (const ask of staleClaims) {
    if (ask.grant_id) await revokeAskAuthority(ask);
    await move(ask.id, ["claimed"], openAgain());
  }

  const holds = await db.select().from(agent_asks)
    .where(and(eq(agent_asks.state, "on_hold"), lte(agent_asks.hold_expires_at, stamp))).limit(50);
  for (const ask of holds) await declineSubstitute(ask);

  const running = await db.select().from(agent_asks)
    .where(inArray(agent_asks.state, ["active", "paused"])).orderBy(agent_asks.updated_at).limit(200);
  for (const ask of running) {
    const live = ask.grant_id ? await workerIsLive(ask.grant_id) : false;
    const giver = await personName(ask.giver_account_id);
    if (ask.state === "active" && !live) {
      const paused = await move(ask.id, ["active"], { state: "paused", paused_at: stamp });
      if (paused) await say(paused, `offline:${stamp}`, ASK_ROOM_TEXT.offline(giver), paused.asker_account_id);
    } else if (ask.state === "paused" && live) {
      const back = await move(ask.id, ["paused"], { state: "active", paused_at: null });
      if (back) await say(back, `back:${stamp}`, ASK_ROOM_TEXT.back(giver));
    } else if (ask.state === "paused" && ask.paused_at && Date.parse(ask.paused_at) + ASK_PAUSE_TTL_MS <= Date.now()) {
      await endAsk(ask, "offline");
    }
  }
}
