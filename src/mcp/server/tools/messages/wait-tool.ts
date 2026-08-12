import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPollTimeoutCapMs } from "../../../../shared/poll-timeout-cap.js";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  agentSessionCredentials,
  AGENT_MESSAGE_BODY_MAX_BYTES,
  appendIncludePromptOnly,
  boundAgentMessageOutput,
  buildAgentDeliveryHeaders,
  bindSupervisedWorkerSession,
  scheduleSupervisedWorkerCursorCheckpoint,
  currentRoom,
  ensureAgentIdentity,
  getFallbackProjectId,
  getLatestLocalChatMessages,
  getLocalImportedRoutingAuthority,
  getLocalChatMessages,
  getLocalChatThreadRoutingMembership,
  getLastMessageId,
  getRememberedRoomPresence,
  getStoredAgentRoutingStateSnapshot,
  getTargetRoomId,
  identityFromAgentSession,
  isLocalRoomStorageEnabled,
  listLocalActiveTaskOwnerLeases,
  resolveLocalRoomStorageIdentifiers,
  resolveAgentSession,
  roomScopedApiCall,
  syncRoomPresence,
  toAgentReadableMessages,
  touchRoomSession,
  WORKER_BEARER_AGENT_SESSION_ID,
  waitForLocalChatMessages,
  type StoredAgentSessionState,
} from "../../runtime.js";
import {
  requireValidWorkerBearerRuntime,
  supervisedBoundedDeliveryDisabledToolResult,
} from "../../runtime/worker-bearer.js";
import {
  attachAgentMessageActivations,
  createGlobalAgentAddressResolver,
  decideAgentMessageActivation,
  isTaskOwnerFollowUpMessageText,
  type AgentMessageActivation,
  type AgentMessageActivationReason,
  type ActivationIdentity,
} from "../../../../shared/activation-routing.js";
import { normalizeRoutingSender } from "../../../../../shared/routing-aliases.mjs";
import { findLocalMessageById, findRemoteMessageById } from "./message-lookup.js";
import { fetchRecentRemoteMessages } from "./read-tool.js";
import { jsonToolResponse } from "./response.js";

const DEFAULT_POLL_TIMEOUT_MS = 30000;

// When wait_for_messages is called WITHOUT an after_message_id cursor, it must
// catch up on only the most RECENT messages instead of replaying the entire
// room history (busy rooms archive millions of characters, which blows the
// tool's token budget). This bounds that no-cursor catch-up to a recent tail.
export const DEFAULT_WAIT_CATCHUP_LIMIT = 100;
export const MAX_WAIT_MESSAGES_PER_CALL = 100;

export type WaitForMessagesFetchPlan =
  | { mode: "catch_up_tail"; limit: number }
  | { mode: "after_cursor"; after: string };

// Decide how the initial fetch should behave. Both paths return one bounded
// page; callers continue from last_observed_message_id when truncated.
export function planWaitForMessagesFetch(input: {
  effectiveAfterMessageId?: string;
  catchupLimit?: number;
}): WaitForMessagesFetchPlan {
  if (input.effectiveAfterMessageId) {
    return { mode: "after_cursor", after: input.effectiveAfterMessageId };
  }
  return {
    mode: "catch_up_tail",
    limit: input.catchupLimit ?? DEFAULT_WAIT_CATCHUP_LIMIT,
  };
}

type MessageRecord = Record<string, unknown>;

export function buildWaitForMessagesRequestOptions(input: {
  deliveryHeaders: Record<string, string>;
  signal?: AbortSignal;
}): RequestInit {
  return {
    ...(input.signal ? { signal: input.signal } : {}),
    headers: input.deliveryHeaders,
  };
}

function isRecord(value: unknown): value is MessageRecord {
  return Boolean(value && typeof value === "object");
}

function messageId(message: MessageRecord): string | null {
  return typeof message.id === "string" && message.id.trim() ? message.id : null;
}

export function resolveEffectiveAfterMessageId(input: {
  requestedAfterMessageId?: string | null;
  rememberedLastMessageId?: string | null;
}): string | undefined {
  const requested = input.requestedAfterMessageId?.trim();
  return requested || undefined;
}

function replyReferenceId(message: MessageRecord): string | null {
  const reply = message.reply_to ?? message.replyTo ?? null;
  if (typeof reply === "string" && reply.trim()) {
    return reply;
  }
  if (isRecord(reply) && typeof reply.id === "string" && reply.id.trim()) {
    return reply.id;
  }
  return null;
}

function activationDecision(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const activation = message.activation;
  if (!isRecord(activation)) return null;
  const forCurrentAgent = activation.for_current_agent;
  if (!isRecord(forCurrentAgent)) return null;
  return typeof forCurrentAgent.decision === "string" ? forCurrentAgent.decision : null;
}

export function filterSilentActivationMessages<T>(messages: readonly T[]): {
  messages: T[];
  skipped_message_ids: string[];
  last_observed_message_id: string | null;
} {
  const visibleMessages: T[] = [];
  const skippedMessageIds: string[] = [];
  let lastObservedMessageId: string | null = null;

  for (const message of messages) {
    if (isRecord(message)) {
      lastObservedMessageId = messageId(message) ?? lastObservedMessageId;
    }

    if (activationDecision(message) === "silent") {
      if (isRecord(message)) {
        const id = messageId(message);
        if (id) skippedMessageIds.push(id);
      }
      continue;
    }

    visibleMessages.push(message);
  }

  return {
    messages: visibleMessages,
    skipped_message_ids: skippedMessageIds,
    last_observed_message_id: lastObservedMessageId,
  };
}

function addActivationRoutingTelemetry(
  output: Record<string, unknown>,
  routing: ReturnType<typeof filterSilentActivationMessages>,
): Record<string, unknown> {
  if (routing.last_observed_message_id) {
    output.last_observed_message_id = routing.last_observed_message_id;
  }
  if (routing.skipped_message_ids.length > 0) {
    output.skipped_message_ids = routing.skipped_message_ids;
    output.skipped_message_count = routing.skipped_message_ids.length;
  }
  return output;
}

export function resolveWaitAgentSession(
  roomId: string | null,
  agentSessionId?: string | null,
): StoredAgentSessionState | null {
  if (
    requireValidWorkerBearerRuntime().mode === "worker" &&
    (!agentSessionId?.trim() || agentSessionId === WORKER_BEARER_AGENT_SESSION_ID)
  ) {
    return null;
  }
  if (!agentSessionId?.trim()) {
    return null;
  }
  return resolveAgentSession(roomId, agentSessionId);
}

export async function localActivationContext(roomId: string): Promise<{
  activeTaskLeases: Array<{
    kind: "work";
    status: "active";
    actor_label: string;
    agent_key: string;
    agent_instance_id: string | null;
    agent_session_id: string | null;
  }>;
}> {
  return {
    activeTaskLeases: await listLocalActiveTaskOwnerLeases(roomId),
  };
}

export async function attachLocalActivationMetadata(
  roomId: string,
  messages: unknown[],
  agentSession: StoredAgentSessionState | null,
  options: {
    includeTaskOwnerLeases?: boolean;
    activeSessionRoomId?: string | null;
  } = {},
): Promise<unknown[]> {
  if (!agentSession || agentSession.session_kind !== "worker") {
    return messages;
  }

  const records = messages.filter(isRecord);
  if (records.length === 0) return messages;
  const identity = {
    actor_label: agentSession.actor_label,
    agent_key: agentSession.agent_key,
    agent_instance_id: agentSession.agent_instance_id ?? null,
    agent_session_id: agentSession.session_id,
    display_name: agentSession.display_name,
    session_kind: agentSession.session_kind,
  };
  // Imported cloud rows carry immutable, account-scoped send-time authority.
  // A present wrapper always wins over mutable local aliases, including when
  // the current state population cannot be read completely.
  const activeSessionRoomId = options.activeSessionRoomId?.trim() || roomId;
  const routingState = getStoredAgentRoutingStateSnapshot(activeSessionRoomId);
  const authoritativeLegacyDecisions = new Map<
    string,
    AgentMessageActivation["for_current_agent"]
  >();
  const legacyRecords: MessageRecord[] = [];
  const normalizedIdentityKey = normalizeRoutingSender(identity.agent_key);
  const validActivationReasons = new Set<AgentMessageActivationReason>([
    "self_message",
    "explicit_mention",
    "explicit_other_mention",
    "broadcast",
    "reply_target",
    "other_reply_target",
    "thread_participant",
    "task_owner",
    "system_event",
    "unaddressed",
  ]);
  for (const message of records) {
    const id = messageId(message);
    if (!id) continue;
    const imported = getLocalImportedRoutingAuthority(message);
    if (!imported) {
      if (routingState.complete) {
        legacyRecords.push(message);
      } else {
        authoritativeLegacyDecisions.set(id, {
          decision: "silent",
          reason: "unaddressed",
          addressed: false,
        });
      }
      continue;
    }
    if (
      !routingState.accountReaderKey
      || imported.readerKey !== routingState.accountReaderKey
      || imported.routing.authority === "invalid"
    ) {
      authoritativeLegacyDecisions.set(id, {
        decision: "silent",
        reason: "unaddressed",
        addressed: false,
      });
      continue;
    }
    const target = imported.routing.recipientSessions.find(
      (candidate) => candidate.agentKey === normalizedIdentityKey,
    );
    const targetSessionId = imported.routing.authority === "receipts"
      ? target && "successorAgentSessionId" in target
        ? target.successorAgentSessionId ?? target.agentSessionId
        : target?.agentSessionId
      : target?.agentSessionId;
    if (!target || targetSessionId !== identity.agent_session_id) {
      authoritativeLegacyDecisions.set(id, {
        decision: "silent",
        reason: "unaddressed",
        addressed: false,
      });
      continue;
    }
    const importedReason = imported.routing.authority === "legacy"
      && "activationReason" in target
      && validActivationReasons.has(target.activationReason as AgentMessageActivationReason)
      ? target.activationReason as AgentMessageActivationReason
      : "explicit_mention";
    authoritativeLegacyDecisions.set(id, {
      decision: "activate",
      reason: importedReason,
      addressed: true,
    });
  }
  if (legacyRecords.length === 0) {
    return attachAgentMessageActivations(records, identity, { authoritativeLegacyDecisions });
  }

  const threadRootIds = legacyRecords.flatMap((message) => {
    const messageId = typeof message.id === "string" ? message.id : "";
    const thread = isRecord(message.thread) ? message.thread : null;
    const rootId = typeof message.thread_root_id === "string"
      ? message.thread_root_id
      : typeof thread?.root_message_id === "string"
        ? thread.root_message_id
        : "";
    return rootId && rootId !== messageId ? [rootId] : [];
  });
  // Linked local/cloud rooms store messages under the SQLite room id while
  // registered workers remain keyed by the canonical cloud room id. Routing
  // ambiguity must always use that complete canonical population.
  const storedActiveSessions = routingState.sessions;
  const activeIdentities = storedActiveSessions.map((session) => ({
    actor_label: session.actor_label,
    agent_key: session.agent_key,
    agent_instance_id: session.agent_instance_id ?? null,
    agent_session_id: session.session_id,
    display_name: session.display_name,
    session_kind: session.session_kind,
  } satisfies ActivationIdentity));
  if (!activeIdentities.some((candidate) =>
    candidate.agent_session_id === identity.agent_session_id
    && candidate.agent_key === identity.agent_key)) {
    // The request's authenticated current session is authoritative even when
    // an older local-state file has not persisted it yet.
    activeIdentities.push(identity);
  }
  const sameKeySessions = storedActiveSessions.filter(
    (session) => session.agent_key === identity.agent_key,
  );
  const currentRepresentativeSessionId = sameKeySessions[0]?.session_id
    ?? identity.agent_session_id;
  const currentIsActive = currentRepresentativeSessionId === identity.agent_session_id;
  const resolveGlobalAddress = createGlobalAgentAddressResolver(activeIdentities);
  const explicitMentionMessageIds = new Set<string>();
  const replyTargetMessageIds = new Set<string>();
  const exactReplyTargetMessageIds = new Set<string>();
  const selfMessageIds = new Set<string>();
  for (const message of legacyRecords) {
    const messageId = typeof message.id === "string" ? message.id : "";
    if (!messageId) continue;
    const addressed = resolveGlobalAddress(message);
    const reply = isRecord(message.reply_to) ? message.reply_to : null;
    const replyPublisherIdentity = isRecord(reply?.agent_identity)
      ? reply.agent_identity
      : null;
    const replyPublisherKey = typeof replyPublisherIdentity?.agent_key === "string"
      ? replyPublisherIdentity.agent_key.trim()
      : "";
    const replyPublisherSessionId = typeof replyPublisherIdentity?.agent_session_id === "string"
      ? replyPublisherIdentity.agent_session_id.trim()
      : "";
    if (replyPublisherKey) {
      addressed.replyTargetKeys.clear();
      const exactReplyIdentity = replyPublisherSessionId
        ? activeIdentities.find((candidate) =>
            candidate.agent_key === replyPublisherKey
            && candidate.agent_session_id === replyPublisherSessionId)
        : undefined;
      if (exactReplyIdentity) {
        if (exactReplyIdentity.agent_session_id === identity.agent_session_id) {
          exactReplyTargetMessageIds.add(messageId);
        }
      } else if (activeIdentities.some((candidate) => candidate.agent_key === replyPublisherKey)) {
        addressed.replyTargetKeys.add(replyPublisherKey);
      }
    }
    const publisherIdentity = isRecord(message.agent_identity)
      ? message.agent_identity
      : null;
    const publisherAgentKey = typeof publisherIdentity?.agent_key === "string"
      ? publisherIdentity.agent_key.trim()
      : "";
    if (
      String(message.source ?? "").trim() === "agent"
      && (publisherAgentKey
        ? publisherAgentKey === identity.agent_key
        : addressed.senderKeys.has(identity.agent_key))
    ) {
      selfMessageIds.add(messageId);
    }
    if (addressed.explicitMentionKeys.has(identity.agent_key)) {
      explicitMentionMessageIds.add(messageId);
    }
    const thread = isRecord(message.thread) ? message.thread : null;
    const rootId = typeof message.thread_root_id === "string"
      ? message.thread_root_id
      : typeof thread?.root_message_id === "string"
        ? thread.root_message_id
        : "";
    if (
      (!rootId || rootId === messageId)
      && (
        exactReplyTargetMessageIds.has(messageId)
        || addressed.replyTargetKeys.has(identity.agent_key)
      )
    ) {
      replyTargetMessageIds.add(messageId);
    }
  }
  const [activationContext, projectedThreadParticipantRootIds] = await Promise.all([
    options.includeTaskOwnerLeases === false
      || !records.some((message) => isTaskOwnerFollowUpMessageText(message.text))
      ? undefined
      : localActivationContext(roomId),
    getLocalChatThreadRoutingMembership(roomId, threadRootIds, identity, activeIdentities),
  ]);
  const exactContext = {
    ...activationContext,
    selfMessageIds,
    threadParticipantRootIds: projectedThreadParticipantRootIds,
    explicitMentionMessageIds,
    replyTargetMessageIds,
  };
  const exactTaskSessionIdsForKey = new Set(
    (activationContext?.activeTaskLeases ?? [])
      .filter((lease) =>
        lease.status === "active"
        && lease.agent_key === identity.agent_key
        && Boolean(lease.agent_session_id))
      .map((lease) => lease.agent_session_id!),
  );
  for (const message of legacyRecords) {
    const messageId = typeof message.id === "string" ? message.id : "";
    if (!messageId) continue;
    const resolved = decideAgentMessageActivation(message, identity, exactContext);
    const exactTaskOwner = resolved.reason === "task_owner"
      && activationContext?.activeTaskLeases?.some((lease) =>
        lease.status === "active"
        && lease.agent_session_id === identity.agent_session_id
        && (!lease.agent_key || lease.agent_key === identity.agent_key));
    const eligibleRepresentative = exactReplyTargetMessageIds.has(messageId)
      ? true
      : resolved.reason === "task_owner" && exactTaskSessionIdsForKey.size > 0
        ? exactTaskSessionIdsForKey.size === 1 && exactTaskOwner
        : currentIsActive;
    authoritativeLegacyDecisions.set(
      messageId,
      eligibleRepresentative && resolved.decision === "activate"
        ? resolved
        : { decision: "silent", reason: "unaddressed", addressed: false },
    );
  }
  return attachAgentMessageActivations(records, identity, { authoritativeLegacyDecisions });
}

// Resolving an out-of-window parent costs a lookup (a by-id fetch, or a
// page-by-page history scan against older APIs), so resolved (and observed)
// messages are cached per process to keep repeat polls from re-resolving the
// same thread roots. Message ids are
// room-scoped, so the key includes the room scope. Message records are treated
// as immutable once posted; a bounded insertion-ordered map keeps memory flat
// for long-running workers.
const THREAD_CONTEXT_CACHE_MAX = 500;
export const THREAD_CONTEXT_LOOKUP_MAX = 16;
export const THREAD_CONTEXT_BYTES_MAX = 256 * 1024;
const THREAD_CONTEXT_DEADLINE_MS = 1_000;
const threadContextCache = new Map<string, MessageRecord>();

function threadContextCacheKey(scopeId: string, targetMessageId: string): string {
  return `${scopeId}:${targetMessageId}`;
}

export function rememberThreadContextMessages(scopeId: string, records: readonly unknown[]): void {
  for (const record of records) {
    if (!isRecord(record)) continue;
    const id = messageId(record);
    if (!id) continue;
    const key = threadContextCacheKey(scopeId, id);
    threadContextCache.delete(key);
    threadContextCache.set(key, record);
  }
  while (threadContextCache.size > THREAD_CONTEXT_CACHE_MAX) {
    const oldest = threadContextCache.keys().next().value;
    if (oldest === undefined) break;
    threadContextCache.delete(oldest);
  }
}

export function resetThreadContextCacheForTests(): void {
  threadContextCache.clear();
}

export async function collectThreadContextMessages(input: {
  messages: unknown[];
  localRoomId: string | null;
  roomId: string | null;
  projectId: string | null;
}): Promise<{ messages: MessageRecord[]; truncated: boolean }> {
  const records = input.messages.filter(isRecord);
  const knownIds = new Set(records.map(messageId).filter((id): id is string => Boolean(id)));
  const seenIds = new Set(knownIds);
  const pendingIds = records
    .map(replyReferenceId)
    .filter((id): id is string => Boolean(id && !knownIds.has(id)));
  const scopeId = input.roomId ?? input.localRoomId ?? input.projectId ?? "";
  rememberThreadContextMessages(scopeId, records);
  if (pendingIds.length === 0) {
    // Nothing quotes an out-of-window message (idle polls land here), so skip
    // storage-mode resolution entirely.
    return { messages: [], truncated: false };
  }
  const contextMessages: MessageRecord[] = [];
  let contextBytes = 0;
  let lookups = 0;
  let truncated = false;
  const deadline = Date.now() + THREAD_CONTEXT_DEADLINE_MS;
  const useLocalStorage = Boolean(
    input.localRoomId && await isLocalRoomStorageEnabled(input.localRoomId)
  );
  const localIdentifiers = useLocalStorage
    ? await resolveLocalRoomStorageIdentifiers(input.localRoomId)
    : { localRoomId: input.localRoomId };
  const sqliteRoomId = localIdentifiers.localRoomId || input.localRoomId;

  while (pendingIds.length > 0) {
    if (lookups >= THREAD_CONTEXT_LOOKUP_MAX || Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const nextId = pendingIds.shift();
    if (!nextId || seenIds.has(nextId)) continue;
    seenIds.add(nextId);
    const cached = threadContextCache.get(threadContextCacheKey(scopeId, nextId));
    if (!cached) lookups += 1;
    const message = cached
      ?? (useLocalStorage && input.localRoomId
        ? await findLocalMessageById(sqliteRoomId || input.localRoomId, nextId)
        : await findRemoteMessageById({
          roomId: input.roomId,
          projectId: input.projectId,
          messageId: nextId,
        }));
    if (!message) continue;
    if (!cached) {
      rememberThreadContextMessages(scopeId, [message]);
    }
    const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (contextBytes + messageBytes > THREAD_CONTEXT_BYTES_MAX) {
      truncated = true;
      break;
    }
    contextBytes += messageBytes;
    contextMessages.push(message);
    const parentId = replyReferenceId(message);
    if (parentId && !seenIds.has(parentId)) {
      pendingIds.push(parentId);
    }
  }

  return { messages: contextMessages, truncated };
}

export function registerWaitForMessagesTool(server: McpServer): void {
  server.tool(
    "wait_for_messages",
    "Wait for new messages in a Let Agents Chat room (HTTP long-poll). Messages labeled activation.for_current_agent.decision=\"silent\" are skipped for the current worker; when last_observed_message_id is present, use it as cursor progress even if messages is empty. Threaded replies include thread_parent_id/thread.root_message_id; use send_thread_message with that id to keep focused side discussion out of the main room. For multi-hour runs, call in a loop: always pass after_message_id from the last message you processed or last_observed_message_id so an empty result means 'nothing new yet', not 'stop working'. Legacy/manual room workers may send a brief continue instruction when another legacy/manual participant posts a premature 'I will wait' closing line. Never send that nudge to or about a daemon-supervised participant, and daemon-supervised workers must not emit it; their supervisor owns wake and retry. Per-call wait is capped (default max 180s unless LETAGENTS_POLL_MAX_MS is set on API and MCP).",
    {
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
      after_message_id: z
        .string()
        .optional()
        .describe(`Only return messages after this message ID (e.g. 'msg_3'). If omitted, returns just the most recent ${DEFAULT_WAIT_CATCHUP_LIMIT} messages (bounded recent tail) instead of the full room history, and advances the session cursor to the newest message.`),
      timeout: z
        .number()
        .optional()
        .describe(
          "Maximum wait time in milliseconds (min 1000, capped by LETAGENTS_POLL_MAX_MS / server). If set to 0, the default timeout will be used."
        ),
      agent_session_id: z
        .string()
        .optional()
        .describe("Registered agent session to use. Without this, the MCP transport is treated as controller traffic and is hidden from connected-agent activity."),
    },
    async ({ room_id, after_message_id, timeout, agent_session_id }) => {
      // This guard intentionally runs before room resolution, identity setup,
      // local SQLite reads, presence writes, or HTTP traffic. In supervised
      // bounded-turn mode the daemon is the sole inbox owner.
      const boundedDeliveryDisabled = supervisedBoundedDeliveryDisabledToolResult();
      if (boundedDeliveryDisabled) {
        return jsonToolResponse(boundedDeliveryDisabled);
      }
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      const localRoomId = targetRoomId ?? currentRoom?.room_id ?? targetProjectId;
      const sessionRoomId = targetRoomId ?? currentRoom?.room_id ?? localRoomId ?? null;
      const routingStateSnapshot = getStoredAgentRoutingStateSnapshot(sessionRoomId ?? "");
      const localStorageEnabled = Boolean(
        localRoomId && await isLocalRoomStorageEnabled(localRoomId),
      );
      if (localStorageEnabled && !routingStateSnapshot.complete) {
        throw new Error("Local agent routing state is unavailable; retry after restoring the state file.");
      }
      const identity = await ensureAgentIdentity();
      const agentSession = resolveWaitAgentSession(sessionRoomId, agent_session_id);
      if (agentSession) {
        // Registration (or a successor generation) must bind strictly once.
        // Later waits use a read-only exact verification capped at 250ms, so a
        // wedged daemon cannot consume the room-poll budget and an old worker
        // cannot read after a successor generation takes ownership.
        await bindSupervisedWorkerSession(agentSession, process.env, { allowConfirmedFastPath: true });
        // A cursor is acknowledged only when the worker explicitly uses it to
        // request the next page. Persisting a cursor from the response we are
        // still constructing could skip a message if serialization, presence,
        // or the provider turn fails afterward.
        if (after_message_id) scheduleSupervisedWorkerCursorCheckpoint(agentSession, after_message_id);
      }
      const maxPollMs = getPollTimeoutCapMs();
      const serverTimeout = Math.min(
        Math.max(timeout || DEFAULT_POLL_TIMEOUT_MS, 1000),
        maxPollMs
      );
      if (localRoomId && localStorageEnabled) {
        const {
          localRoomId: sqliteRoomId,
          cloudRoomId,
        } = await resolveLocalRoomStorageIdentifiers(localRoomId);
        const effectiveLocalRoomId = sqliteRoomId || localRoomId;
        const effectiveAfterMessageId = resolveEffectiveAfterMessageId({
          requestedAfterMessageId: after_message_id,
        });
        const fetchPlan = planWaitForMessagesFetch({ effectiveAfterMessageId });
        // Without a cursor, page BACKWARDS from the tail (getLatest…) so we
        // return the most-recent messages, not the oldest N; with a cursor we
        // keep the unchanged forward "everything after the cursor" behavior.
        const existing = fetchPlan.mode === "catch_up_tail"
          ? await getLatestLocalChatMessages(effectiveLocalRoomId, {
              limit: Math.min(fetchPlan.limit, MAX_WAIT_MESSAGES_PER_CALL),
              include_prompt_only: true,
            })
          : await getLocalChatMessages(effectiveLocalRoomId, {
              after: effectiveAfterMessageId,
              limit: MAX_WAIT_MESSAGES_PER_CALL,
              include_prompt_only: true,
            });
        const replayingExistingMessages = existing.messages.length > 0;
        const result = replayingExistingMessages
          ? existing
          : await waitForLocalChatMessages(effectiveLocalRoomId, {
              after: effectiveAfterMessageId,
              timeoutMs: serverTimeout,
              limit: MAX_WAIT_MESSAGES_PER_CALL,
              include_prompt_only: true,
            });
        const messages = await attachLocalActivationMetadata(effectiveLocalRoomId, result.messages, agentSession, {
          includeTaskOwnerLeases: !replayingExistingMessages,
          activeSessionRoomId: cloudRoomId || sessionRoomId,
        });
        const bounded = boundAgentMessageOutput(messages, {
          direction: fetchPlan.mode === "catch_up_tail" ? "suffix" : "prefix",
          maxBytes: AGENT_MESSAGE_BODY_MAX_BYTES,
        });
        const routing = filterSilentActivationMessages(bounded.messages);
        const observedCursor = routing.last_observed_message_id ?? getLastMessageId(result);
        touchRoomSession(effectiveLocalRoomId, observedCursor);
        const threadContext = await collectThreadContextMessages({
          messages: routing.messages,
          localRoomId: effectiveLocalRoomId,
          roomId: targetRoomId,
          projectId: targetProjectId,
        });
        return jsonToolResponse({
          room_id: effectiveLocalRoomId,
          ...addActivationRoutingTelemetry({
            messages: toAgentReadableMessages(routing.messages, threadContext.messages),
          }, routing),
          ...(result.has_more || bounded.truncated ? { truncated: true } : {}),
          ...(bounded.omittedMessageCount > 0
            ? { omitted_message_count: bounded.omittedMessageCount }
            : {}),
          ...(threadContext.truncated ? { thread_context_truncated: true } : {}),
        });
      }

      await syncRoomPresence(
        targetRoomId ?? currentRoom?.room_id ?? null,
        identity,
        getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, agentSession ? identityFromAgentSession(agentSession) : identity),
        agentSession
      );
      const clientTimeout =
        serverTimeout + (serverTimeout > 120_000 ? 120_000 : 5_000);

      const effectiveAfterMessageId = resolveEffectiveAfterMessageId({
        requestedAfterMessageId: after_message_id,
      });
      const fetchPlan = planWaitForMessagesFetch({ effectiveAfterMessageId });
      const deliveryHeaders = buildAgentDeliveryHeaders(agentSession);

      const allMessages: unknown[] = [];
      let roomIdFromResponse: string | undefined;
      let catchUpTruncated = false;
      let apiObservedCursor: string | null = null;

      // Long-poll the server (blocks up to serverTimeout for new messages),
      // optionally seeded with a cursor. Shared by the cursor path and by the
      // no-cursor empty-tail fallback so a quiet room still blocks instead of
      // busy-spinning. When `after` is provided this also catches up any backlog
      // after the cursor via forward pagination.
      const longPollFromCursor = async (after?: string): Promise<void> => {
        const params = new URLSearchParams();
        if (after) params.set("after", after);
        params.set("limit", String(MAX_WAIT_MESSAGES_PER_CALL));
        params.set("timeout", String(serverTimeout));

        const queryString = params.toString();
        const firstResult = await roomScopedApiCall<{
          messages?: Array<{ id?: string }>;
          has_more?: boolean;
          last_observed_message_id?: string | null;
          room_id?: string;
          project_id?: string;
        }>({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) =>
            appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(targetRoomId)}/messages/poll?${queryString}`),
          project_path: (targetProjectId) =>
            appendIncludePromptOnly(`/projects/${encodeURIComponent(targetProjectId)}/messages/poll?${queryString}`),
          options: buildWaitForMessagesRequestOptions({
            deliveryHeaders,
            signal: AbortSignal.timeout(clientTimeout),
          }),
        });

        allMessages.push(...(firstResult.messages ?? []));
        roomIdFromResponse = roomIdFromResponse || firstResult.room_id || firstResult.project_id;
        catchUpTruncated = Boolean(firstResult.has_more);
        apiObservedCursor = typeof firstResult.last_observed_message_id === "string"
          ? firstResult.last_observed_message_id
          : null;
      };

      if (fetchPlan.mode === "catch_up_tail") {
        // No cursor: catch up on only the bounded recent tail. Mirror
        // read_messages by paging BACKWARDS from the tail (before=latest) so we
        // return the newest N and never walk the full room history. This also
        // advances the session cursor to the newest message returned.
        const recent = await fetchRecentRemoteMessages({
          targetRoomId,
          targetProjectId,
          limit: fetchPlan.limit,
          deliveryHeaders,
        });
        if (recent.messages.length > 0) {
          allMessages.push(...recent.messages);
          roomIdFromResponse = recent.roomIdFromResponse;
        } else {
          // Empty tail => the room is effectively empty, so there is nothing to
          // dump. Fall through to the long-poll (no cursor) so a worker looping
          // in a quiet room blocks up to the timeout instead of busy-spinning,
          // exactly as the local path does via waitForLocalChatMessages.
          roomIdFromResponse = recent.roomIdFromResponse;
          await longPollFromCursor();
        }
      } else {
        await longPollFromCursor(fetchPlan.after);
      }

      const bounded = boundAgentMessageOutput(allMessages, {
        direction: fetchPlan.mode === "catch_up_tail" ? "suffix" : "prefix",
        maxBytes: AGENT_MESSAGE_BODY_MAX_BYTES,
      });
      const routing = filterSilentActivationMessages(bounded.messages);
      const threadContext = await collectThreadContextMessages({
        messages: routing.messages,
        localRoomId,
        roomId: targetRoomId,
        projectId: targetProjectId,
      });
      const output: Record<string, unknown> = addActivationRoutingTelemetry({
        messages: toAgentReadableMessages(routing.messages, threadContext.messages),
      }, routing);
      if (threadContext.truncated) output.thread_context_truncated = true;
      if (roomIdFromResponse) {
        output[targetRoomId ? "room_id" : "project_id"] = roomIdFromResponse;
      }
      if (catchUpTruncated || bounded.truncated) output.truncated = true;
      if (bounded.omittedMessageCount > 0) {
        output.omitted_message_count = bounded.omittedMessageCount;
      }
      if (apiObservedCursor) output.last_observed_message_id = apiObservedCursor;

      if (targetRoomId) {
        const observedCursor = apiObservedCursor
          ?? routing.last_observed_message_id
          ?? getLastMessageId(output);
        touchRoomSession(targetRoomId, observedCursor);

        if (allMessages.length > 0 && agentSession) {
          const firstMsg = allMessages[0] as { id?: string };
          const lastMsg = allMessages[allMessages.length - 1] as { id?: string };
          if (typeof firstMsg?.id === "string" && typeof lastMsg?.id === "string") {
            try {
              await roomScopedApiCall({
                room_id: targetRoomId,
                project_id: targetProjectId,
                room_path: (r) => `/rooms/${encodeRoomIdPath(r)}/agents/self/observation`,
                project_path: (p) => `/projects/${encodeURIComponent(p)}/agents/self/observation`,
                options: {
                  method: "PUT",
                  body: JSON.stringify({
                    first_message_id: firstMsg.id,
                    last_message_id: lastMsg.id,
                    ...agentSessionCredentials(agentSession),
                  }),
                },
              });
            } catch {
              // Non-blocking telemetry
            }
          }
        }
        // Delivery alone is observation evidence (the span above), never a
        // "responding" receipt: an agent that ignores an activation must not
        // present as responding. Receipts advance only on real transitions —
        // send-tool marks "replied" when the agent actually publishes a reply.
      }
      await syncRoomPresence(
        targetRoomId ?? currentRoom?.room_id ?? null,
        identity,
        getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, agentSession ? identityFromAgentSession(agentSession) : identity),
        agentSession
      );
      return jsonToolResponse(output);
    }
  );
}
