import type {
  DesktopRoomMessage,
  DesktopRoomStorageState,
} from "../../ipc-types.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import {
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
  listLocalTasks,
  addLocalTask,
  updateLocalTask,
  claimLocalTaskReviewLease,
} from "../rooms/local-store.js";
import {
  addLocalChatMessage,
  getLatestLocalChatMessages,
  getLocalChatMessages,
  getLocalChatMessagesBefore,
} from "../rooms/messages/local-store.js";
import {
  mapRoomMessagePayload,
  type RoomMessagePayload,
} from "../rooms/messages/mappers.js";
import {
  mapDesktopTaskSummaryPayload,
  type DesktopTaskSummaryPayload,
} from "../rooms/tasks/mappers.js";
import {
  buildManagedAgentRoomToolResultPrompt,
  hasManagedAgentRoomToolRequestLine,
  isManagedAgentRoomToolRequest,
  MANAGED_AGENT_ROOM_TOOL_REQUEST_PREFIX,
  parseManagedAgentRoomToolRequest,
  type ManagedAgentRoomToolName,
  type ManagedAgentRoomToolRequest,
  type ManagedAgentRoomToolResult,
  type ManagedAgentRoomToolStorage,
} from "./managed-agent-room-tools-protocol.js";
import {
  getStoredAgentSession,
  type StoredAgentSessionState,
} from "./state.js";

export {
  buildManagedAgentRoomToolResultPrompt,
  hasManagedAgentRoomToolRequestLine,
  isManagedAgentRoomToolRequest,
  MANAGED_AGENT_ROOM_TOOL_REQUEST_PREFIX,
  parseManagedAgentRoomToolRequest,
};

export const DESKTOP_EVENT_ROOM_TOOL_REQUEST_LIMIT = 5;
const ROOM_TOOL_REQUEST_TIMEOUT_MS = 20_000;

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

export type ManagedAgentRoomToolSession = {
  session_id: string;
  room_id: string;
  room_identifier: string;
  display_name?: string | null;
  agent_session_id?: string | null;
};

export type ManagedAgentRoomToolCache = Map<string, ManagedAgentRoomToolResult>;

export interface ManagedAgentRoomToolExecutorDeps {
  apiFetch?: ApiFetch;
}

export async function executeManagedAgentRoomToolRequestWithTimeout(input: {
  session: ManagedAgentRoomToolSession;
  storage: DesktopRoomStorageState;
  request: ManagedAgentRoomToolRequest;
  cache?: ManagedAgentRoomToolCache;
  deps?: ManagedAgentRoomToolExecutorDeps;
}): Promise<ManagedAgentRoomToolResult> {
  const cacheKey = roomToolCacheKey(input.request);
  const cached = input.cache?.get(cacheKey);
  if (cached) {
    return { ...cached, cached: true } as ManagedAgentRoomToolResult;
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      executeManagedAgentRoomToolRequest(input.session, input.storage, input.request, input.deps),
      new Promise<ManagedAgentRoomToolResult>((resolve) => {
        timeout = setTimeout(() => {
          resolve({
            ok: false,
            tool: input.request.tool,
            roomIdentifier: input.session.room_identifier || input.session.room_id,
            storage: storageMode(input.storage),
            error: "Desktop room tool timed out.",
            code: "room_tool_timeout",
          });
        }, ROOM_TOOL_REQUEST_TIMEOUT_MS);
      }),
    ]);
    input.cache?.set(cacheKey, result);
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function executeManagedAgentRoomToolRequest(
  session: ManagedAgentRoomToolSession,
  storage: DesktopRoomStorageState,
  request: ManagedAgentRoomToolRequest,
  deps: ManagedAgentRoomToolExecutorDeps = {},
): Promise<ManagedAgentRoomToolResult> {
  const roomIdentifier = (session.room_identifier || session.room_id || "").trim();
  const storageKind = storageMode(storage);
  if (!roomIdentifier) {
    return {
      ok: false,
      tool: request.tool,
      roomIdentifier,
      storage: storageKind,
      error: "Managed room tools require a room identifier.",
      code: "missing_room_identifier",
    };
  }

  const workerSession = getStoredAgentSession(session.agent_session_id);
  if (!workerSession?.session_id || !workerSession.session_token) {
    return {
      ok: false,
      tool: request.tool,
      roomIdentifier,
      storage: storageKind,
      error: "Managed room tools require a registered worker session.",
      code: "missing_worker_session",
    };
  }

  try {
    const data = storageKind === "local"
      ? await executeLocalRoomTool(roomIdentifier, storage, workerSession, request)
      : await executeCloudRoomTool(roomIdentifier, storage, workerSession, request, deps.apiFetch ?? apiFetch);
    if (isUnsupportedLocalRoomToolResult(data)) {
      return {
        ok: false,
        tool: request.tool,
        roomIdentifier,
        storage: storageKind,
        error: data.error,
        code: data.code,
      };
    }
    return {
      ok: true,
      tool: request.tool,
      roomIdentifier,
      storage: storageKind,
      data: stripSensitiveKeys(data),
    };
  } catch (error) {
    return errorResult(request.tool, roomIdentifier, storageKind, error);
  }
}

function storageMode(storage: DesktopRoomStorageState): ManagedAgentRoomToolStorage {
  return storage.effectiveMode === "local" ? "local" : "cloud";
}

async function executeCloudRoomTool(
  roomIdentifier: string,
  storage: DesktopRoomStorageState,
  workerSession: StoredAgentSessionState,
  request: ManagedAgentRoomToolRequest,
  fetcher: ApiFetch,
): Promise<unknown> {
  const roomId = cloudRoomIdentifierForStorage(storage, roomIdentifier);
  const credentials = workerCredentials(workerSession);

  switch (request.tool) {
    case "read_messages":
      return await readCloudMessages(roomId, request.arguments, fetcher);
    case "send_message":
      return await postCloudMessage(roomId, {
        text: requiredString(request.arguments, "text"),
        reply_to: optionalString(request.arguments.reply_to ?? request.arguments.reply_to_id),
        thread_root_id: optionalString(request.arguments.thread_root_id),
        client_message_id: optionalString(request.arguments.client_message_id),
        ...credentials,
      }, fetcher);
    case "send_thread_message": {
      const threadRootId =
        optionalString(request.arguments.thread_root_id) ??
        optionalString(request.arguments.thread_parent_id) ??
        requiredString(request.arguments, "root_message_id");
      return await postCloudMessage(roomId, {
        text: requiredString(request.arguments, "text"),
        reply_to: optionalString(request.arguments.reply_to ?? request.arguments.reply_to_id),
        thread_root_id: threadRootId,
        client_message_id: optionalString(request.arguments.client_message_id),
        ...credentials,
      }, fetcher);
    }
    case "post_status":
      return await postCloudStatus(roomId, workerSession, request.arguments, credentials, fetcher);
    case "post_reasoning":
      return await postCloudReasoning(roomId, workerSession, request.arguments, credentials, fetcher);
    case "get_board":
      return await readCloudBoard(roomId, request.arguments, fetcher);
    case "get_board_settings":
      return await fetcher(`/rooms/${encodeURIComponent(roomId)}/board-settings`);
    case "create_task":
      return await mutateCloudTaskCollection(roomId, workerSession, request.arguments, credentials, fetcher);
    case "claim_task":
      return await claimCloudTask(roomId, workerSession, request.arguments, credentials, fetcher);
    case "update_task":
      return await updateCloudTask(roomId, workerSession, request.arguments, credentials, fetcher);
    case "claim_task_review":
      return await postCloudTaskAction(roomId, requiredString(request.arguments, "task_id"), "review-lease-action", {
        action: "claim",
        reason: optionalString(request.arguments.reason),
        ...credentials,
      }, fetcher);
    case "create_board_intent":
      return await postJson(fetcher, `/rooms/${encodeURIComponent(roomId)}/board-intents`, {
        action_type: requiredString(request.arguments, "action_type"),
        task_id: optionalString(request.arguments.task_id),
        payload: objectArg(request.arguments.payload, "payload"),
        ...credentials,
      });
    case "list_board_intents": {
      const status = optionalString(request.arguments.status);
      return await fetcher(`/rooms/${encodeURIComponent(roomId)}/board-intents${status ? `?status=${encodeURIComponent(status)}` : ""}`);
    }
    case "approve_board_intent":
      return await postJson(fetcher, `/rooms/${encodeURIComponent(roomId)}/board-intents/${encodeURIComponent(requiredString(request.arguments, "intent_id"))}/approve`, {
        reason: optionalString(request.arguments.reason),
        ...credentials,
      });
    case "deny_board_intent":
      return await postJson(fetcher, `/rooms/${encodeURIComponent(roomId)}/board-intents/${encodeURIComponent(requiredString(request.arguments, "intent_id"))}/deny`, {
        reason: optionalString(request.arguments.reason),
        ...credentials,
      });
    case "get_room_artifacts":
      return await readCloudArtifacts(roomId, request.arguments, fetcher);
    case "publish_room_artifact":
      return await postJson(fetcher, `/rooms/${encodeURIComponent(roomId)}/artifacts`, {
        artifact: objectArg(request.arguments.artifact, "artifact"),
        task_id: optionalString(request.arguments.task_id),
        linked_task_ids: arrayArg(request.arguments.linked_task_ids),
        ...credentials,
      });
  }
}

async function executeLocalRoomTool(
  roomIdentifier: string,
  storage: DesktopRoomStorageState,
  workerSession: StoredAgentSessionState,
  request: ManagedAgentRoomToolRequest,
): Promise<unknown> {
  const roomId = localRoomIdentifierForStorage(storage, roomIdentifier);
  switch (request.tool) {
    case "read_messages":
      return await readLocalMessages(roomId, request.arguments);
    case "send_message": {
      const message = await addLocalChatMessage(roomId, {
        sender: workerSender(workerSession),
        text: requiredString(request.arguments, "text"),
        reply_to: optionalString(request.arguments.reply_to ?? request.arguments.reply_to_id),
        thread_root_id: optionalString(request.arguments.thread_root_id),
        source: "agent",
      });
      const mapped = mapRoomMessagePayload(message);
      await emitLocalRoomMessage(roomIdentifier, mapped);
      return { message: mapped };
    }
    case "send_thread_message": {
      const threadRootId =
        optionalString(request.arguments.thread_root_id) ??
        optionalString(request.arguments.thread_parent_id) ??
        requiredString(request.arguments, "root_message_id");
      const message = await addLocalChatMessage(roomId, {
        sender: workerSender(workerSession),
        text: requiredString(request.arguments, "text"),
        reply_to: optionalString(request.arguments.reply_to ?? request.arguments.reply_to_id),
        thread_root_id: threadRootId,
        source: "agent",
      });
      const mapped = mapRoomMessagePayload(message);
      await emitLocalRoomMessage(roomIdentifier, mapped);
      return { message: mapped };
    }
    case "post_status": {
      const status = requiredString(request.arguments, "status");
      const message = await addLocalChatMessage(roomId, {
        sender: workerSender(workerSession),
        text: `[status] ${status}`,
        source: "agent",
      });
      const mapped = mapRoomMessagePayload(message);
      await emitLocalRoomMessage(roomIdentifier, mapped);
      return { status_posted: status, message: mapped };
    }
    case "get_board":
      return { tasks: await listLocalTasks(roomId) };
    case "create_task":
      return {
        task: await addLocalTask(roomId, {
          title: requiredString(request.arguments, "title"),
          description: optionalString(request.arguments.description),
          createdBy: workerSession.actor_label || workerSender(workerSession),
        }),
      };
    case "claim_task": {
      const taskId = requiredString(request.arguments, "task_id");
      return {
        task: await updateLocalTask(roomId, taskId, {
          status: "assigned",
          assignee: workerSession.actor_label || workerSender(workerSession),
          assigneeAgentKey: workerSession.agent_key || null,
        }),
      };
    }
    case "update_task": {
      const taskId = requiredString(request.arguments, "task_id");
      return {
        task: await updateLocalTask(roomId, taskId, {
          status: optionalString(request.arguments.status),
          assignee: optionalStringOrNull(request.arguments.assignee),
          assigneeAgentKey: optionalStringOrNull(request.arguments.assignee_agent_key),
          prUrl: optionalStringOrNull(request.arguments.pr_url),
          workflowArtifacts: arrayArg(request.arguments.workflow_artifacts) as never,
        }),
      };
    }
    case "claim_task_review": {
      const result = await claimLocalTaskReviewLease(roomId, requiredString(request.arguments, "task_id"), {
        holderLabel: workerSession.actor_label || workerSender(workerSession),
        agentKey: workerSession.agent_key || null,
        agentSessionId: workerSession.session_id,
      });
      return result;
    }
    default:
      return unsupportedLocalRoomTool(request.tool);
  }
}

async function readCloudMessages(
  roomId: string,
  args: Record<string, unknown>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const params = new URLSearchParams();
  params.set("limit", String(numberArg(args.limit, 50, 100)));
  const after = optionalString(args.after ?? args.after_message_id);
  const before = optionalString(args.before ?? args.before_message_id);
  if (after) params.set("after", after);
  if (before) params.set("before", before);
  const data = await fetcher<{
    room_id?: string;
    messages?: RoomMessagePayload[];
    has_more?: boolean;
    has_older?: boolean;
  }>(`/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`);
  return {
    room_id: data.room_id ?? roomId,
    messages: (data.messages || []).map(mapRoomMessagePayload),
    has_more: Boolean(data.has_more),
    has_older: data.has_older,
  };
}

async function readLocalMessages(
  roomId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const limit = numberArg(args.limit, 50, 100);
  const after = optionalString(args.after ?? args.after_message_id);
  const before = optionalString(args.before ?? args.before_message_id);
  const page = before
    ? await getLocalChatMessagesBefore(roomId, before, { limit })
    : after
      ? await getLocalChatMessages(roomId, { limit, after })
      : await getLatestLocalChatMessages(roomId, { limit });
  return {
    messages: page.messages.map(mapRoomMessagePayload),
    has_more: Boolean(page.has_more),
    has_older: before ? Boolean(page.has_more) : undefined,
  };
}

async function postCloudMessage(
  roomId: string,
  body: Record<string, unknown>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const message = await postJson<RoomMessagePayload>(
    fetcher,
    `/rooms/${encodeURIComponent(roomId)}/messages`,
    body,
  );
  return { message: mapRoomMessagePayload(message) };
}

async function postCloudStatus(
  roomId: string,
  workerSession: StoredAgentSessionState,
  args: Record<string, unknown>,
  credentials: Record<string, string>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const statusText = requiredString(args, "status");
  const presenceStatus = normalizePresenceStatus(args.presence_status ?? args.state) ?? "working";
  const [presence, message] = await Promise.all([
    postJson(fetcher, `/rooms/${encodeURIComponent(roomId)}/presence`, {
      status: presenceStatus,
      status_text: statusText,
      ...credentials,
    }),
    postCloudMessage(roomId, {
      text: `[status] ${statusText}`,
      client_message_id: optionalString(args.client_message_id),
      ...credentials,
    }, fetcher),
  ]);
  return {
    status_posted: statusText,
    sender: workerSession.actor_label ?? null,
    presence,
    message: (message as { message?: unknown }).message ?? null,
  };
}

async function postCloudReasoning(
  roomId: string,
  workerSession: StoredAgentSessionState,
  args: Record<string, unknown>,
  credentials: Record<string, string>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const summary = requiredString(args, "summary");
  const actorLabel = workerSession.actor_label || workerSender(workerSession);
  const snapshot = {
    summary,
    goal: optionalString(args.goal),
    checking: optionalString(args.checking),
    hypothesis: optionalString(args.hypothesis),
    blocker: optionalString(args.blocker),
    next_action: optionalString(args.next_action),
    milestone: optionalString(args.milestone),
    confidence: typeof args.confidence === "number" ? args.confidence : undefined,
    status: normalizePresenceStatus(args.status),
  };
  const query = new URLSearchParams({
    open: "true",
    actor_label: actorLabel,
  });
  const list = await fetcher<{
    sessions?: Array<{ id?: string }>;
  }>(`/rooms/${encodeURIComponent(roomId)}/reasoning-sessions?${query.toString()}`);
  const existingSessionId = list.sessions?.find((session) => typeof session.id === "string")?.id;
  const result = existingSessionId
    ? await postJson(fetcher, `/rooms/${encodeURIComponent(roomId)}/reasoning-sessions/${encodeURIComponent(existingSessionId)}/updates`, {
      actor_label: actorLabel,
      ...credentials,
      ...snapshot,
    })
    : await postJson(fetcher, `/rooms/${encodeURIComponent(roomId)}/reasoning-sessions`, {
      actor_label: actorLabel,
      agent_key: workerSession.agent_key || null,
      ...credentials,
      ...snapshot,
    });
  let milestoneMessage: unknown = null;
  const milestone = optionalString(args.milestone);
  if (milestone) {
    milestoneMessage = (await postCloudMessage(roomId, {
      text: milestone,
      ...credentials,
    }, fetcher) as { message?: unknown }).message ?? null;
  }
  return {
    ...objectOrEmpty(result),
    milestone_message: milestoneMessage,
  };
}

async function readCloudBoard(
  roomId: string,
  args: Record<string, unknown>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (args.open !== false) params.set("open", "true");
  const status = optionalString(args.status);
  const after = optionalString(args.after);
  if (status) params.set("status", status);
  if (after) params.set("after", after);
  params.set("limit", String(numberArg(args.limit, 100, 250)));
  const data = await fetcher<{
    room_id?: string;
    tasks?: DesktopTaskSummaryPayload[];
    has_more?: boolean;
  }>(`/rooms/${encodeURIComponent(roomId)}/tasks?${params.toString()}`);
  return {
    room_id: data.room_id ?? roomId,
    tasks: (data.tasks || []).map(mapDesktopTaskSummaryPayload),
    has_more: Boolean(data.has_more),
  };
}

async function mutateCloudTaskCollection(
  roomId: string,
  workerSession: StoredAgentSessionState,
  args: Record<string, unknown>,
  credentials: Record<string, string>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const data = await postJson<DesktopTaskSummaryPayload>(
    fetcher,
    `/rooms/${encodeURIComponent(roomId)}/tasks`,
    {
      title: requiredString(args, "title"),
      description: optionalString(args.description),
      source_message_id: optionalString(args.source_message_id),
      client_task_id: optionalString(args.client_task_id),
      actor_label: workerSession.actor_label || null,
      actor_key: workerSession.agent_key || null,
      actor_instance_id: workerSession.agent_instance_id || null,
      board_intent_id: optionalString(args.board_intent_id),
      board_approval_token: optionalString(args.board_approval_token),
      ...credentials,
    },
  );
  return { task: mapDesktopTaskSummaryPayload(data), raw: stripSensitiveKeys(data) };
}

async function claimCloudTask(
  roomId: string,
  workerSession: StoredAgentSessionState,
  args: Record<string, unknown>,
  credentials: Record<string, string>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const taskId = requiredString(args, "task_id");
  return await patchCloudTask(roomId, taskId, {
    status: "assigned",
    assignee: workerSession.actor_label || workerSender(workerSession),
    assignee_agent_key: workerSession.agent_key || null,
    actor_label: workerSession.actor_label || null,
    actor_key: workerSession.agent_key || null,
    actor_instance_id: workerSession.agent_instance_id || null,
    board_intent_id: optionalString(args.board_intent_id),
    board_approval_token: optionalString(args.board_approval_token),
    ...credentials,
  }, fetcher);
}

async function updateCloudTask(
  roomId: string,
  workerSession: StoredAgentSessionState,
  args: Record<string, unknown>,
  credentials: Record<string, string>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const taskId = requiredString(args, "task_id");
  return await patchCloudTask(roomId, taskId, {
    status: optionalString(args.status),
    assignee: optionalStringOrNull(args.assignee),
    assignee_agent_key: optionalStringOrNull(args.assignee_agent_key),
    pr_url: optionalStringOrNull(args.pr_url),
    workflow_artifacts: arrayArg(args.workflow_artifacts),
    actor_label: workerSession.actor_label || null,
    actor_key: workerSession.agent_key || null,
    actor_instance_id: workerSession.agent_instance_id || null,
    board_intent_id: optionalString(args.board_intent_id),
    board_approval_token: optionalString(args.board_approval_token),
    ...credentials,
  }, fetcher);
}

async function patchCloudTask(
  roomId: string,
  taskId: string,
  body: Record<string, unknown>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const data = await patchJson<DesktopTaskSummaryPayload>(
    fetcher,
    `/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}`,
    compactObject(body),
  );
  return { task: mapDesktopTaskSummaryPayload(data), raw: stripSensitiveKeys(data) };
}

async function postCloudTaskAction(
  roomId: string,
  taskId: string,
  actionPath: "review-lease-action",
  body: Record<string, unknown>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const data = await postJson<{
    task?: DesktopTaskSummaryPayload;
    [key: string]: unknown;
  }>(
    fetcher,
    `/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/${actionPath}`,
    compactObject(body),
  );
  const sanitized = stripSensitiveKeys(data);
  return {
    ...(sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? sanitized as Record<string, unknown>
      : {}),
    task: data.task ? mapDesktopTaskSummaryPayload(data.task) : null,
  };
}

async function readCloudArtifacts(
  roomId: string,
  args: Record<string, unknown>,
  fetcher: ApiFetch,
): Promise<unknown> {
  const params = new URLSearchParams();
  const taskId = optionalString(args.task_id);
  if (taskId) params.set("task_id", taskId);
  params.set("limit", String(numberArg(args.limit, 100, 250)));
  return await fetcher(`/rooms/${encodeURIComponent(roomId)}/artifacts?${params.toString()}`);
}

async function postJson<T = unknown>(
  fetcher: ApiFetch,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  return await fetcher<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(compactObject(body)),
  });
}

async function patchJson<T = unknown>(
  fetcher: ApiFetch,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  return await fetcher<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(compactObject(body)),
  });
}

function workerCredentials(workerSession: StoredAgentSessionState): Record<string, string> {
  return {
    agent_session_id: workerSession.session_id,
    agent_session_token: workerSession.session_token || "",
  };
}

function workerSender(workerSession: StoredAgentSessionState): string {
  return workerSession.actor_label
    || workerSession.display_name
    || workerSession.agent_key
    || "Managed agent";
}

async function emitLocalRoomMessage(
  roomIdentifier: string,
  message: DesktopRoomMessage,
): Promise<void> {
  const { emitPersistedLocalRoomMessage } = await import("../room-stream.js");
  emitPersistedLocalRoomMessage(roomIdentifier, message);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args[key]);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return optionalString(value);
}

function numberArg(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function objectArg(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayArg(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function normalizePresenceStatus(value: unknown): "idle" | "working" | "reviewing" | "blocked" | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "idle" || normalized === "working" || normalized === "reviewing" || normalized === "blocked"
    ? normalized
    : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function unsupportedLocalRoomTool(tool: ManagedAgentRoomToolName): { ok: false; code: "unsupported_local_room_tool"; error: string } {
  return {
    ok: false,
    code: "unsupported_local_room_tool",
    error: `${tool} is not supported for local rooms by the desktop room tool bridge.`,
  };
}

function isUnsupportedLocalRoomToolResult(
  value: unknown,
): value is { ok: false; code: "unsupported_local_room_tool"; error: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { ok?: unknown }).ok === false &&
      (value as { code?: unknown }).code === "unsupported_local_room_tool",
  );
}

function errorResult(
  tool: ManagedAgentRoomToolName,
  roomIdentifier: string,
  storage: ManagedAgentRoomToolStorage,
  error: unknown,
): ManagedAgentRoomToolResult {
  if (error instanceof DesktopApiError) {
    const payload = error.payload && typeof error.payload === "object"
      ? error.payload as Record<string, unknown>
      : {};
    return {
      ok: false,
      tool,
      roomIdentifier,
      storage,
      error: error.message,
      status: error.status,
      code: typeof payload.code === "string" ? payload.code : null,
    };
  }
  return {
    ok: false,
    tool,
    roomIdentifier,
    storage,
    error: error instanceof Error ? error.message : String(error),
  };
}

function roomToolCacheKey(request: ManagedAgentRoomToolRequest): string {
  return request.idempotency_key
    ? `${request.tool}:idempotency:${request.idempotency_key}`
    : `${request.tool}:arguments:${stableJson(request.arguments)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stripSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSensitiveKeys);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "agent_session_token" && key !== "session_token")
      .map(([key, entry]) => [key, stripSensitiveKeys(entry)]),
  );
}
