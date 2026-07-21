import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPollTimeoutCapMs } from "../../../../shared/poll-timeout-cap.js";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  appendIncludePromptOnly,
  buildAgentDeliveryHeaders,
  bindSupervisedWorkerSession,
  scheduleSupervisedWorkerCursorCheckpoint,
  currentRoom,
  ensureAgentIdentity,
  getFallbackProjectId,
  getLatestLocalChatMessages,
  getLocalChatMessages,
  getLastMessageId,
  getRememberedRoomPresence,
  getTargetRoomId,
  identityFromAgentSession,
  isLocalRoomStorageEnabled,
  listLocalTasks,
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
import { attachAgentMessageActivations } from "../../../../shared/activation-routing.js";
import { findLocalMessageById, findRemoteMessageById } from "./message-lookup.js";
import { fetchRecentRemoteMessages } from "./read-tool.js";
import { jsonToolResponse } from "./response.js";

const DEFAULT_POLL_TIMEOUT_MS = 30000;

// When wait_for_messages is called WITHOUT an after_message_id cursor, it must
// catch up on only the most RECENT messages instead of replaying the entire
// room history (busy rooms archive millions of characters, which blows the
// tool's token budget). This bounds that no-cursor catch-up to a recent tail.
export const DEFAULT_WAIT_CATCHUP_LIMIT = 100;

export type WaitForMessagesFetchPlan =
  | { mode: "catch_up_tail"; limit: number }
  | { mode: "after_cursor"; after: string };

// Decide how the initial fetch should behave. With a cursor we return
// everything after it (genuine "new since I last polled", already bounded);
// without one we fetch only the bounded recent tail.
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

type WaitForMessagesRemoteRequest = {
  room_id: string | null;
  project_id: string | null;
  room_path: (targetRoomId: string) => string;
  project_path: (targetProjectId: string) => string;
  options: RequestInit;
};

const LOCAL_TASK_OWNER_STATUSES = new Set(["assigned", "in_progress", "blocked", "in_review"]);

export function buildWaitForMessagesRequestOptions(input: {
  deliveryHeaders: Record<string, string>;
  signal?: AbortSignal;
}): RequestInit {
  return {
    ...(input.signal ? { signal: input.signal } : {}),
    headers: input.deliveryHeaders,
  };
}

export function buildWaitForMessagesHistoryPageRequest(input: {
  targetRoomId: string | null;
  targetProjectId: string | null;
  queryString: string;
  deliveryHeaders: Record<string, string>;
}): WaitForMessagesRemoteRequest {
  const querySuffix = input.queryString ? `?${input.queryString}` : "";
  return {
    room_id: input.targetRoomId,
    project_id: input.targetProjectId,
    room_path: (targetRoomId) =>
      appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(targetRoomId)}/messages${querySuffix}`),
    project_path: (targetProjectId) =>
      appendIncludePromptOnly(`/projects/${encodeURIComponent(targetProjectId)}/messages${querySuffix}`),
    options: buildWaitForMessagesRequestOptions({ deliveryHeaders: input.deliveryHeaders }),
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
  const result = await listLocalTasks(roomId, { openOnly: true });
  return {
    activeTaskLeases: result.tasks
      .flatMap((task) => {
        const agentKey = task.assignee_agent_key?.trim();
        if (!LOCAL_TASK_OWNER_STATUSES.has(task.status) || !agentKey) {
          return [];
        }

        return [{
          kind: "work",
          status: "active",
          actor_label: task.assignee || agentKey,
          agent_key: agentKey,
          agent_instance_id: task.assignee_agent_instance_id,
          agent_session_id: task.assignee_agent_session_id,
        }];
      }),
  };
}

async function attachLocalActivationMetadata(
  roomId: string,
  messages: unknown[],
  agentSession: StoredAgentSessionState | null,
  options: { includeTaskOwnerLeases?: boolean } = {},
): Promise<unknown[]> {
  if (!agentSession || agentSession.session_kind !== "worker") {
    return messages;
  }

  const records = messages.filter(isRecord);
  const activationContext = options.includeTaskOwnerLeases === false
    ? undefined
    : await localActivationContext(roomId);
  return attachAgentMessageActivations(records, {
    actor_label: agentSession.actor_label,
    agent_key: agentSession.agent_key,
    agent_instance_id: agentSession.agent_instance_id ?? null,
    agent_session_id: agentSession.session_id,
    display_name: agentSession.display_name,
    session_kind: agentSession.session_kind,
  }, activationContext);
}

// Resolving an out-of-window parent costs a lookup (a by-id fetch, or a
// page-by-page history scan against older APIs), so resolved (and observed)
// messages are cached per process to keep repeat polls from re-resolving the
// same thread roots. Message ids are
// room-scoped, so the key includes the room scope. Message records are treated
// as immutable once posted; a bounded insertion-ordered map keeps memory flat
// for long-running workers.
const THREAD_CONTEXT_CACHE_MAX = 500;
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
}): Promise<MessageRecord[]> {
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
    return [];
  }
  const contextMessages: MessageRecord[] = [];
  const useLocalStorage = Boolean(
    input.localRoomId && await isLocalRoomStorageEnabled(input.localRoomId)
  );
  const localIdentifiers = useLocalStorage
    ? await resolveLocalRoomStorageIdentifiers(input.localRoomId)
    : { localRoomId: input.localRoomId };
  const sqliteRoomId = localIdentifiers.localRoomId || input.localRoomId;

  while (pendingIds.length > 0) {
    const nextId = pendingIds.shift();
    if (!nextId || seenIds.has(nextId)) continue;
    seenIds.add(nextId);
    const cached = threadContextCache.get(threadContextCacheKey(scopeId, nextId));
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
    contextMessages.push(message);
    const parentId = replyReferenceId(message);
    if (parentId && !seenIds.has(parentId)) {
      pendingIds.push(parentId);
    }
  }

  return contextMessages;
}

export function registerWaitForMessagesTool(server: McpServer): void {
  server.tool(
    "wait_for_messages",
    "Wait for new messages in a Let Agents Chat room (HTTP long-poll). Messages labeled activation.for_current_agent.decision=\"silent\" are skipped for the current worker; when last_observed_message_id is present, use it as cursor progress even if messages is empty. Threaded replies include thread_parent_id/thread.root_message_id; use send_thread_message with that id to keep focused side discussion out of the main room. For multi-hour runs, call in a loop: always pass after_message_id from the last message you processed or last_observed_message_id so an empty result means 'nothing new yet', not 'stop working'. If someone posted a premature 'I will wait' closing line, use send_message with a brief continue instruction. Per-call wait is capped (default max 180s unless LETAGENTS_POLL_MAX_MS is set on API and MCP).",
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
      const identity = await ensureAgentIdentity();
      const sessionRoomId = targetRoomId ?? currentRoom?.room_id ?? localRoomId ?? null;
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
      if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
        const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
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
              limit: fetchPlan.limit,
              include_prompt_only: true,
            })
          : await getLocalChatMessages(effectiveLocalRoomId, {
              after: effectiveAfterMessageId,
              include_prompt_only: true,
            });
        const replayingExistingMessages = existing.messages.length > 0;
        const result = replayingExistingMessages
          ? existing
          : await waitForLocalChatMessages(effectiveLocalRoomId, {
              after: effectiveAfterMessageId,
              timeoutMs: serverTimeout,
              include_prompt_only: true,
            });
        const messages = await attachLocalActivationMetadata(effectiveLocalRoomId, result.messages, agentSession, {
          includeTaskOwnerLeases: !replayingExistingMessages,
        });
        const routing = filterSilentActivationMessages(messages);
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
            messages: toAgentReadableMessages(routing.messages, threadContext),
          }, routing),
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

      // Long-poll the server (blocks up to serverTimeout for new messages),
      // optionally seeded with a cursor. Shared by the cursor path and by the
      // no-cursor empty-tail fallback so a quiet room still blocks instead of
      // busy-spinning. When `after` is provided this also catches up any backlog
      // after the cursor via forward pagination.
      const longPollFromCursor = async (after?: string): Promise<void> => {
        const params = new URLSearchParams();
        if (after) params.set("after", after);
        params.set("timeout", String(serverTimeout));

        const queryString = params.toString();
        const firstResult = await roomScopedApiCall<{
          messages?: Array<{ id?: string }>;
          has_more?: boolean;
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

        if (firstResult.has_more && allMessages.length > 0) {
          let afterCursor = (allMessages[allMessages.length - 1] as { id?: string })?.id;

          while (afterCursor) {
            const pageParams = new URLSearchParams();
            pageParams.set("after", afterCursor);
            const qs = pageParams.toString();

            const page = await roomScopedApiCall<{
              messages?: Array<{ id?: string }>;
              has_more?: boolean;
            }>(buildWaitForMessagesHistoryPageRequest({
              targetRoomId,
              targetProjectId,
              queryString: qs,
              deliveryHeaders,
            }));

            const msgs = page.messages ?? [];
            allMessages.push(...msgs);

            if (!page.has_more || msgs.length === 0) break;
            afterCursor = (msgs[msgs.length - 1] as { id?: string })?.id;
          }
        }
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

      const routing = filterSilentActivationMessages(allMessages);
      const threadContext = await collectThreadContextMessages({
        messages: routing.messages,
        localRoomId,
        roomId: targetRoomId,
        projectId: targetProjectId,
      });
      const output: Record<string, unknown> = addActivationRoutingTelemetry({
        messages: toAgentReadableMessages(routing.messages, threadContext),
      }, routing);
      if (roomIdFromResponse) {
        output[targetRoomId ? "room_id" : "project_id"] = roomIdFromResponse;
      }

      if (targetRoomId) {
        const observedCursor = routing.last_observed_message_id ?? getLastMessageId(output);
        touchRoomSession(targetRoomId, observedCursor);
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
