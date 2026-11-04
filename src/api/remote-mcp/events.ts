/**
 * MCP Events on the remote endpoint: `events/list`, `events/subscribe` and
 * `events/unsubscribe`, so a ChatGPT Work chat or dot can be woken by a room
 * message. Each subscription is a `room.message` wake rule with delivery kind
 * `mcp_event`, bound to the credential behind the session (the owner token or
 * OAuth grant, by its hash): it shares the webhook rules' URL guard, pinned
 * HTTP client, budgets, pause and revocation. Delivery is the wake worker's
 * (`../notifications/wake-webhooks.ts`).
 *
 * Contract: https://developers.openai.com/plugins/build/mcp-events (a draft).
 * Order of a subscribe, as the page requires: authorize the principal for the
 * event and its arguments, validate them, check the secret, verify the
 * callback URL with a signed challenge, then store.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { WAKE_RULE_LIMITS } from "../../../shared/wake-rules.mjs";
import type { McpSessionPersistentState } from "../../mcp/server/runtime/session-scope.js";
import { loadConnectorCipher, type ConnectorCipher } from "../connectors/crypto.js";
import { getProjectById } from "../db.js";
import type { OwnerTokenAccount } from "../db/types/auth.js";
import {
  McpEventSubscriptionCapError,
  MCP_EVENT_REPLAY_RETENTION_MS,
  cancelMcpEventSubscription,
  findHeldMcpEventRule,
  getMcpEventWorkerSession,
  mcpEventWatermark,
  replayMcpEventDeliveries,
  roomLatestMessageNumber,
  roomMessagePostedAt,
  saveMcpEventSubscription,
  type McpEventRuleAgent,
} from "../db/wake-rules-mcp-events.js";
import { authorizeDesktopPushNotification, type DesktopPushAuthorizationDecision } from "../notifications/authorization.js";
import { getPushDeliveryAccount } from "../notifications/push-account.js";
import { isProjectRoomMember, resolveProjectRepoRoomAccessDecision } from "../rooms/access.js";
import { resolveCanonicalRoomRequestId } from "../rooms/resolution.js";
import { normalizeRoomId } from "../rooms/routing.js";
import { queueWakeRuleInvalidation } from "../server/events.js";
import {
  MCP_EVENT_DEFINITIONS,
  MCP_EVENT_ROOM_MESSAGE,
  MCP_EVENTS_CALLBACK_ENDPOINT_ERROR,
  MCP_EVENTS_FORBIDDEN,
  MCP_EVENTS_INVALID_PARAMS,
  MCP_EVENTS_RESOURCE_EXHAUSTED,
  McpEventsError,
  buildMcpVerificationBody,
  grantMcpEventTtlMs,
  mcpCallbackReason,
  mcpChallengeAnswered,
  mcpEventHeaders,
  mcpEventSignature,
  mcpEventSubscriptionId,
  newMcpVerificationChallenge,
  newMcpVerificationId,
  parseMcpEventCursor,
  parseMcpEventSecret,
  parseMcpRoomMessageArguments,
  rotatedSecretFields,
  type McpRoomMessageArguments,
} from "../wake-rules/mcp-events.js";
import { wakeWebhookBinding } from "../wake-rules/webhook-delivery.js";
import {
  WAKE_WEBHOOK_TIMEOUT_MS,
  WAKE_WEBHOOK_URL_REFUSED,
  WakeWebhookResolveError,
  WakeWebhookUrlError,
  assertWakeWebhookUrl,
  parseWakeWebhookUrl,
  postWakeWebhook,
  wakeWebhookHost,
  wakeWebhookTargetKey,
  type WakeWebhookLookup,
  type WakeWebhookSendResult,
} from "../wake-rules/webhook-url.js";
import { IMPLICIT_CLIENT_NAME } from "./implicit-session.js";

/** What the handlers know about the session they serve. Nothing here is a token. */
export interface McpEventsSessionContext {
  account: OwnerTokenAccount;
  /** SHA-256 of the owner token or OAuth grant secret: the principal, and the credential the subscription is bound to. */
  tokenHash: string;
  /** The session's worker state (the credential's, for a stateless client): where "me" in a room is found. */
  state: McpSessionPersistentState;
  clientName: string | null;
}

export interface McpEventsDeps {
  /** Whether the account may read the room now. */
  authorize(accountId: string, roomId: string): Promise<DesktopPushAuthorizationDecision>;
  /** Tests resolve callback hosts without DNS. */
  lookup?: WakeWebhookLookup;
  send: typeof postWakeWebhook;
  verifyTimeoutMs: number;
  /** Verification POSTs one credential may cause in 10 minutes (successful ones are cached and cost nothing more). */
  verificationsPer10Min: number;
  now(): Date;
}

function defaultDeps(): McpEventsDeps {
  return {
    authorize: (accountId, roomId) => authorizeDesktopPushNotification({ accountId, roomId }, {
      getProject: getProjectById, getAccount: getPushDeliveryAccount, resolveAccess: resolveProjectRepoRoomAccessDecision,
      isRoomMember: isProjectRoomMember,
    }),
    send: postWakeWebhook,
    verifyTimeoutMs: WAKE_WEBHOOK_TIMEOUT_MS,
    verificationsPer10Min: VERIFICATIONS_PER_10_MIN,
    now: () => new Date(),
  };
}

/**
 * A subscribe makes this server POST to a URL the caller chose, so the number
 * of verification requests one credential can cause is bounded (per process,
 * in memory), on top of the endpoint's request budget.
 */
const VERIFICATIONS_PER_10_MIN = 30;
const VERIFICATION_WINDOW_MS = 10 * 60_000;
const verificationAttempts = new Map<string, number[]>();

function countVerificationAttempt(principal: string, nowMs: number, limit: number): boolean {
  const recent = (verificationAttempts.get(principal) ?? []).filter((at) => at > nowMs - VERIFICATION_WINDOW_MS);
  if (recent.length >= limit) {
    verificationAttempts.set(principal, recent);
    return false;
  }
  recent.push(nowMs);
  verificationAttempts.set(principal, recent);
  // Principals that went quiet are forgotten.
  for (const [key, attempts] of verificationAttempts) {
    if (key !== principal && !attempts.some((at) => at > nowMs - VERIFICATION_WINDOW_MS)) verificationAttempts.delete(key);
  }
  return true;
}

let testOverrides: Partial<McpEventsDeps> | null = null;

/** Tests only: replace the room check, the resolver, the sender, the timeout or the clock. */
export function configureMcpEventsForTests(overrides: Partial<McpEventsDeps> | null): void {
  testOverrides = overrides;
}

function deps(): McpEventsDeps {
  return { ...defaultDeps(), ...testOverrides };
}

/**
 * Callback URLs verified lately, by principal and URL: a renewal inside the
 * window is not challenged again. In this process's memory only: a restart
 * (or another replica) challenges once more, which is harmless.
 */
const verified = new Map<string, number>();

function verificationKey(principal: string, url: string): string {
  return `${principal}\n${url}`;
}

function recentlyVerified(principal: string, url: string, nowMs: number): boolean {
  for (const [key, until] of verified) if (until <= nowMs) verified.delete(key);
  return (verified.get(verificationKey(principal, url)) ?? 0) > nowMs;
}

/** Tests only: forget every verification and every attempt. */
export function forgetMcpEventVerificationsForTests(): void {
  verified.clear();
  verificationAttempts.clear();
}

const RequestSchema = (method: string) => z.object({ method: z.literal(method), params: z.unknown().optional() });

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new McpEventsError(MCP_EVENTS_INVALID_PARAMS, `${name} must be an object.`);
  return value as Record<string, unknown>;
}

function eventName(value: unknown): string {
  if (value !== MCP_EVENT_ROOM_MESSAGE) {
    throw new McpEventsError(MCP_EVENTS_INVALID_PARAMS, `Unknown event ${JSON.stringify(value)}. events/list names the events this server offers.`);
  }
  return MCP_EVENT_ROOM_MESSAGE;
}

function deliveryOf(value: unknown): { mode: string; url: string; secret?: unknown } {
  const delivery = record(value, "delivery");
  if (delivery.mode !== "webhook") throw new McpEventsError(MCP_EVENTS_INVALID_PARAMS, "delivery.mode must be \"webhook\"; this server offers no other delivery.");
  if (typeof delivery.url !== "string" || !delivery.url.trim() || delivery.url.trim().length > WAKE_RULE_LIMITS.webhookUrlMaxLength) {
    throw new McpEventsError(MCP_EVENTS_INVALID_PARAMS, `delivery.url must be a public https URL of at most ${WAKE_RULE_LIMITS.webhookUrlMaxLength} characters.`);
  }
  return { mode: "webhook", url: delivery.url.trim(), secret: delivery.secret };
}

interface Worker { agent_key: string; agent_name: string; session_id: string }

/**
 * "Me" in the room: the worker this credential registered there with
 * `register_agent_session` (kept across sessions), `worker_id` choosing among
 * several. A live session is preferred; an ended one still names the agent.
 */
async function resolveWorker(context: McpEventsSessionContext, roomId: string, workerId: string | undefined): Promise<Worker | null> {
  const local = context.state.local;
  const workers = Object.values(local.mcp_workers ?? {}).filter((worker) => !workerId || worker.worker_id === workerId);
  const sessionIds = workers.map((worker) => worker.rooms[roomId]?.session_id).filter((id): id is string => Boolean(id));
  if (!workerId) {
    const legacy = local.current_agent_session_ids?.[roomId];
    if (legacy) sessionIds.push(legacy);
  }
  let ended: Worker | null = null;
  for (const sessionId of new Set(sessionIds)) {
    const session = await getMcpEventWorkerSession(sessionId);
    if (!session || session.room_id !== roomId || session.owner_account_id !== context.account.account_id) continue;
    const worker = { agent_key: session.agent_key, agent_name: session.display_name, session_id: session.session_id };
    if (!session.ended_at) return worker;
    ended ??= worker;
  }
  return ended;
}

function subscriberName(context: McpEventsSessionContext): string {
  const name = context.clientName?.trim();
  return name && name !== IMPLICIT_CLIENT_NAME ? name.slice(0, 80) : "MCP Events subscriber";
}

/**
 * POST the challenge, signed like an event, and require it echoed with a 2xx.
 * Every failure is the one JSON-RPC error with a categorized `reason`; the
 * receiver's text never reaches the caller.
 */
async function verifyCallback(input: { url: string; key: Buffer; subscriptionId: string; principal: string }, d: McpEventsDeps): Promise<void> {
  const now = d.now();
  if (recentlyVerified(input.principal, input.url, now.getTime())) return;
  if (!countVerificationAttempt(input.principal, now.getTime(), d.verificationsPer10Min)) {
    throw new McpEventsError(MCP_EVENTS_RESOURCE_EXHAUSTED,
      `This sign-in asked for ${d.verificationsPer10Min} callback verifications in 10 minutes. Wait, then subscribe again.`, { limit: "verifications" });
  }
  const challenge = newMcpVerificationChallenge();
  const id = newMcpVerificationId();
  const timestamp = Math.floor(now.getTime() / 1000);
  const body = buildMcpVerificationBody(challenge);
  const headers = mcpEventHeaders({ id, timestamp, signature: mcpEventSignature([input.key], id, timestamp, body), subscriptionId: input.subscriptionId });
  let result: WakeWebhookSendResult;
  try {
    result = await d.send({ url: input.url, body, headers, timeoutMs: d.verifyTimeoutMs, lookup: d.lookup, readBodyBytes: 4096 });
  } catch {
    result = { outcome: "retry", status: 0, error: "connect_failed" };
  }
  if (result.outcome !== "delivered") {
    throw new McpEventsError(MCP_EVENTS_CALLBACK_ENDPOINT_ERROR, "The callback URL did not accept the verification request.", { reason: mcpCallbackReason(result) });
  }
  if (!mcpChallengeAnswered(challenge, result.body)) {
    throw new McpEventsError(MCP_EVENTS_CALLBACK_ENDPOINT_ERROR, "The callback URL answered the verification request without echoing its challenge.", { reason: "challenge_failed" });
  }
  verified.set(verificationKey(input.principal, input.url), now.getTime() + WAKE_RULE_LIMITS.mcpEventVerificationCacheMs);
}

async function resolveRoom(canonical: McpRoomMessageArguments, context: McpEventsSessionContext, d: McpEventsDeps): Promise<string> {
  const roomId = await resolveCanonicalRoomRequestId(normalizeRoomId(canonical.room_id));
  const access = await d.authorize(context.account.account_id, roomId);
  if (access !== "allow") {
    throw new McpEventsError(MCP_EVENTS_FORBIDDEN, "You cannot read this room, or it does not exist. Join it first (join_room), then subscribe again.");
  }
  return roomId;
}

export interface McpEventsSubscribeResult {
  id: string;
  refreshBefore: string;
  cursor: string | null;
  truncated: boolean;
  /** The SDK's result type is an open object. */
  [key: string]: unknown;
}

async function subscribe(params: unknown, context: McpEventsSessionContext): Promise<McpEventsSubscribeResult> {
  const d = deps();
  const p = record(params, "params");
  const name = eventName(p.name);
  const { canonical, rule: ruleArguments } = parseMcpRoomMessageArguments(p.arguments);
  const delivery = deliveryOf(p.delivery);
  const ttlMs = grantMcpEventTtlMs(p.ttlMs);
  const cursor = parseMcpEventCursor(p.cursor);

  // 1. Authorize: the room, as this account; then "me" in it.
  const roomId = await resolveRoom(canonical, context, d);
  canonical.room_id = roomId;
  const worker = await resolveWorker(context, roomId, canonical.worker_id);
  if (canonical.worker_id && !worker) throw new McpEventsError(MCP_EVENTS_INVALID_PARAMS, "arguments.worker_id names no worker of yours in this room.");
  if (canonical.mentions_me && !worker) {
    throw new McpEventsError(MCP_EVENTS_INVALID_PARAMS,
      "mentions_me needs a worker of yours in this room: join the room (join_room) and register one with register_agent_session, then subscribe again. Or subscribe with any: true to get every message.");
  }
  // 2. The secret.
  const key = parseMcpEventSecret(delivery.secret);
  const secret = delivery.secret as string;
  // 3. The callback URL: the same guard as a webhook rule, with the same one answer.
  let url: URL;
  try {
    url = await assertWakeWebhookUrl(delivery.url, d.lookup);
  } catch (error) {
    if (error instanceof WakeWebhookUrlError || error instanceof WakeWebhookResolveError) throw new McpEventsError(MCP_EVENTS_INVALID_PARAMS, `delivery.url: ${WAKE_WEBHOOK_URL_REFUSED}`);
    throw error;
  }
  const cipher = loadConnectorCipher();
  if (!cipher) throw new McpEventsError(-32603, "MCP Events are not set up on this server (it has no connector key).");
  const subscriptionId = mcpEventSubscriptionId(context.tokenHash, url.href, name, { ...canonical });
  const existing = await findHeldMcpEventRule(context.tokenHash, subscriptionId);
  // 4. Verify the callback before anything is stored.
  await verifyCallback({ url: url.href, key, subscriptionId, principal: context.tokenHash }, d);
  // 5. Store, renewing in place when the subscription exists.
  const now = d.now();
  const accountId = context.account.account_id;
  const agent: McpEventRuleAgent = worker
    ? { agent_key: worker.agent_key, agent_name: worker.agent_name, session_id: worker.session_id, owner_account_id: accountId }
    : { agent_key: `${accountId}/mcp-events`, agent_name: subscriberName(context), session_id: null, owner_account_id: accountId };
  const opened = existing?.delivery_target && existing.owner_account_id
    ? openTarget(cipher, existing.delivery_target, existing.id, existing.owner_account_id)
    : null;
  const rotation = rotatedSecretFields(opened, secret, now.getTime());
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const roomLatest = await roomLatestMessageNumber(roomId);
  let saved: Awaited<ReturnType<typeof saveMcpEventSubscription>>;
  try {
    saved = await saveMcpEventSubscription({
      roomId,
      agent,
      credentialRef: context.tokenHash,
      subscriptionId,
      eventName: name,
      subscriptionArguments: { ...canonical },
      ruleArguments,
      expiresAt,
      targetFingerprint: cipher.fingerprint("wake-webhook-target", wakeWebhookTargetKey(url)),
      hostFingerprint: cipher.fingerprint("wake-webhook-host", wakeWebhookHost(url)),
      seal: (ruleId) => cipher.encrypt({ url: url.href, secret, ...(rotation ?? {}) }, wakeWebhookBinding(ruleId, accountId)),
      initialCursor: roomLatest,
      now,
    });
  } catch (error) {
    if (error instanceof McpEventSubscriptionCapError) throw new McpEventsError(MCP_EVENTS_RESOURCE_EXHAUSTED, error.message, { limit: error.scope });
    throw error;
  }
  // 6. The cursor. A new subscription starts now; a renewal with a cursor
  //    replays what came after it (once an hour). The answer is the server's
  //    watermark: how far the subscription is delivered, never past an event
  //    that still waits to go out; for a new subscription, the room's newest
  //    message number.
  let truncated = false;
  if (cursor.kind !== "none") {
    if (saved.created) {
      // Nothing was recorded before this subscription existed.
      truncated = true;
    } else if (cursor.kind === "unknown") {
      truncated = true;
    } else {
      const postedAt = await roomMessagePostedAt(roomId, cursor.number);
      const replay = await replayMcpEventDeliveries(saved.rule, cursor.number, now);
      // A gap while the rule was paused, a cursor older than the delivery
      // rows kept, an unknown cursor, or more than the replay bound: some
      // history is not available.
      truncated = saved.previousStatus !== "active" || replay.truncated || postedAt === null
        || Date.parse(postedAt) < now.getTime() - MCP_EVENT_REPLAY_RETENTION_MS;
    }
  }
  const watermark = saved.created ? roomLatest : await mcpEventWatermark(saved.rule.id);
  queueWakeRuleInvalidation(roomId);
  return { id: subscriptionId, refreshBefore: expiresAt, cursor: String(watermark ?? roomLatest), truncated };
}

function openTarget(cipher: ConnectorCipher, target: NonNullable<Parameters<ConnectorCipher["decrypt"]>[0]>, ruleId: string, ownerAccountId: string): Record<string, unknown> | null {
  try {
    return cipher.decrypt(target, wakeWebhookBinding(ruleId, ownerAccountId));
  } catch {
    return null;
  }
}

async function unsubscribe(params: unknown, context: McpEventsSessionContext): Promise<Record<string, unknown>> {
  const d = deps();
  const p = record(params, "params");
  const name = eventName(p.name);
  const { canonical } = parseMcpRoomMessageArguments(p.arguments);
  const delivery = deliveryOf(p.delivery);
  // The same identity as the subscribe: the canonical room id and the URL without its fragment.
  canonical.room_id = await resolveCanonicalRoomRequestId(normalizeRoomId(canonical.room_id));
  let href: string;
  try {
    href = parseWakeWebhookUrl(delivery.url).href;
  } catch {
    return {};
  }
  const cancelled = await cancelMcpEventSubscription(context.tokenHash, mcpEventSubscriptionId(context.tokenHash, href, name, { ...canonical }), d.now());
  if (cancelled) queueWakeRuleInvalidation(cancelled.room_id);
  return {};
}

/** Nothing internal reaches the caller: a McpEventsError as it is, anything else as one generic failure. */
async function guarded<T>(method: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof McpEventsError) throw error;
    console.error(`[mcp events] ${method} failed`, error instanceof Error ? error.name : "error");
    throw new McpEventsError(-32603, `${method} could not be completed. Retry.`);
  }
}

/**
 * Register the capability and the three methods on one request's server
 * object, before it connects. The capability is advertised as the OpenAI page
 * shows it for the `initialize` path (`capabilities.events: {}`); this server
 * speaks no MCP 2.0 `server/discover`.
 */
export function registerMcpEventsHandlers(server: Server, context: McpEventsSessionContext): void {
  server.registerCapabilities({ events: {} } as unknown as ServerCapabilities);
  server.setRequestHandler(RequestSchema("events/list"), async () => ({
    events: structuredClone(MCP_EVENT_DEFINITIONS) as unknown as Array<Record<string, unknown>>,
  }));
  server.setRequestHandler(RequestSchema("events/subscribe"), async (request) =>
    guarded("events/subscribe", () => subscribe(request.params, context)));
  server.setRequestHandler(RequestSchema("events/unsubscribe"), async (request) =>
    guarded("events/unsubscribe", () => unsubscribe(request.params, context)));
}
