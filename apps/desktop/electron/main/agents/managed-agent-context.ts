import type { DesktopTaskSummary } from "../../ipc-types.js";
import { parsePositivePgIntegerScopedId } from "../../../../../shared/message-contracts.mjs";
import {
  describeAgentMessageAttachments,
  type AgentMessageAttachmentDescriptor,
} from "./managed-agent-attachments.js";
import { apiFetch } from "../auth.js";
import {
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "../rooms/local-store.js";
import {
  getLatestLocalChatMessages,
  getLocalChatMessagesAround,
  getLocalChatThreadMessages,
  searchLocalChatMessages,
} from "../rooms/messages/local-store.js";
import { getLocalRoomArtifacts } from "../rooms/artifacts/local-store.js";
import type { RoomMessagePayload } from "../rooms/messages/mappers.js";
import {
  mapDesktopTaskSummaryPayload,
  type DesktopTaskSummaryPayload,
} from "../rooms/tasks/mappers.js";
import {
  compactManagedAgentRoomArtifacts,
  MANAGED_AGENT_CONTEXT_ARTIFACT_LIMIT,
  managedAgentRoomArtifactsPath,
  type CompactManagedAgentRoomArtifact,
  type ManagedAgentRoomArtifactPayload,
} from "./managed-agent-artifacts.js";
export {
  buildManagedAgentContextResultPrompt,
  hasManagedAgentContextRequestLine,
  isManagedAgentContextRequest,
  MANAGED_AGENT_CONTEXT_REQUEST_PREFIX,
  parseManagedAgentContextRequest,
} from "./managed-agent-context-protocol.js";
import type {
  ManagedAgentContextRequest,
  ManagedAgentContextResult,
  ManagedAgentContextStorage,
} from "./managed-agent-context-protocol.js";
import type { DesktopCodexLiveSessionState } from "./state.js";

const MAX_CONTEXT_MESSAGES = 50;
const MAX_CONTEXT_SEARCH_SCAN = 500;
const MAX_CONTEXT_TASKS = 20;
const MAX_CONTEXT_TASK_SCAN = 500;

type ContextStorage = ManagedAgentContextStorage;

type CompactMessage = {
  id: string;
  sender: string;
  actor: string | null;
  timestamp: string;
  text: string;
  source: string | null;
  replyTo: {
    id: string;
    sender: string;
    text: string;
    timestamp: string;
  } | null;
  attachments: number;
  imageAttachments?: AgentMessageAttachmentDescriptor[];
};

type CompactTask = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  assigneeAgentKey: string | null;
  createdBy: string | null;
  prUrl: string | null;
  activeLeases: DesktopTaskSummary["activeLeases"];
  activeLocks: DesktopTaskSummary["activeLocks"];
  workflowRefs: DesktopTaskSummary["workflowRefs"];
  workflowArtifacts: DesktopTaskSummary["workflowArtifacts"];
  updatedAt: string;
};

export async function executeManagedAgentContextRequest(
  session: DesktopCodexLiveSessionState,
  request: ManagedAgentContextRequest,
): Promise<ManagedAgentContextResult> {
  const roomIdentifier = (session.room_identifier || session.room_id || "").trim();
  const storageState = await resolveLocalAwareRoomStorageMode(roomIdentifier);
  const storage: ContextStorage = storageState.effectiveMode === "local" ? "local" : "cloud";
  const storageRoomIdentifier = storage === "local"
    ? localRoomIdentifierForStorage(storageState, roomIdentifier)
    : cloudRoomIdentifierForStorage(storageState, roomIdentifier);
  if (!roomIdentifier) {
    return {
      ok: false,
      tool: request.tool,
      roomIdentifier,
      storage,
      error: "Managed agent context tools require a room identifier.",
    };
  }

  try {
    switch (request.tool) {
      case "read_recent_room_messages":
        return await readRecentRoomMessages(storageRoomIdentifier, storage, request.arguments);
      case "search_room_messages":
        return await searchRoomMessages(storageRoomIdentifier, storage, request.arguments);
      case "read_thread":
        return await readThread(storageRoomIdentifier, storage, request.arguments);
      case "read_messages_around":
        return await readMessagesAround(storageRoomIdentifier, storage, request.arguments);
      case "get_task_context":
        return await getTaskContext(storageRoomIdentifier, storage, request.arguments);
      case "get_room_context_summary":
        return await getRoomContextSummary(storageRoomIdentifier, storage, request.arguments);
    }
  } catch (error) {
    return {
      ok: false,
      tool: request.tool,
      roomIdentifier: storageRoomIdentifier,
      storage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function numberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function nonNegativeNumberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? String(args[key]).trim() : "";
}

function truncate(value: string | null | undefined, max = 700): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function compactMessage(message: RoomMessagePayload): CompactMessage {
  return {
    id: message.id,
    sender: message.sender,
    actor: message.agent_identity?.actor_label || message.agent_identity?.display_name || null,
    timestamp: message.timestamp,
    text: truncate(message.text),
    source: message.source || null,
    replyTo: message.reply_to
      ? {
          id: message.reply_to.id,
          sender: message.reply_to.sender,
          text: truncate(message.reply_to.text, 240),
          timestamp: message.reply_to.timestamp,
        }
      : null,
    attachments: message.attachments?.length || 0,
    ...compactImageAttachments(message),
  };
}

function compactImageAttachments(
  message: RoomMessagePayload,
): Pick<CompactMessage, "imageAttachments"> {
  const imageAttachments = describeAgentMessageAttachments(message.id, message.attachments)
    .filter((descriptor) => descriptor.image);
  return imageAttachments.length ? { imageAttachments } : {};
}

function compactTask(task: DesktopTaskSummary): CompactTask {
  return {
    id: task.id,
    title: task.title,
    description: task.description ? truncate(task.description, 900) : null,
    status: task.status,
    assignee: task.assignee,
    assigneeAgentKey: task.assigneeAgentKey,
    createdBy: task.createdBy,
    prUrl: task.prUrl,
    activeLeases: task.activeLeases.slice(0, 6),
    activeLocks: task.activeLocks.slice(0, 6),
    workflowRefs: task.workflowRefs.slice(0, 8),
    workflowArtifacts: task.workflowArtifacts.slice(0, 8),
    updatedAt: task.updatedAt,
  };
}

async function fetchCloudMessages(input: {
  roomIdentifier: string;
  limit: number;
  before?: string;
  after?: string;
}): Promise<{ messages: RoomMessagePayload[]; hasMore: boolean }> {
  if (input.limit <= 0) {
    return { messages: [], hasMore: false };
  }

  const params = new URLSearchParams();
  params.set("limit", String(input.limit));
  if (input.before) {
    params.set("before", input.before);
  }
  if (input.after) {
    params.set("after", input.after);
  }
  const page = await apiFetch<{
    messages?: RoomMessagePayload[];
    has_more?: boolean;
    has_older?: boolean;
  }>(`/rooms/${encodeURIComponent(input.roomIdentifier)}/messages?${params.toString()}`);
  return {
    messages: [...(page.messages || [])].sort(
      (left, right) => Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""),
    ),
    hasMore: Boolean(page.has_more ?? page.has_older),
  };
}

async function fetchCloudAnchorMessage(
  roomIdentifier: string,
  messageId: string,
): Promise<RoomMessagePayload | null> {
  const messageNumber = parseMessageNumber(messageId);
  const page = await fetchCloudMessages({
    roomIdentifier,
    after: messageNumber && messageNumber > 1 ? formatMessageId(messageNumber - 1) : undefined,
    limit: 1,
  });
  return page.messages.find((message) => message.id === messageId) ?? null;
}

async function fetchCloudRecentWindow(
  roomIdentifier: string,
  limit = MAX_CONTEXT_SEARCH_SCAN,
): Promise<RoomMessagePayload[]> {
  const page = await fetchCloudMessages({
    roomIdentifier,
    before: "latest",
    limit: Math.min(MAX_CONTEXT_SEARCH_SCAN, Math.max(MAX_CONTEXT_MESSAGES, limit)),
  });
  return page.messages;
}

function parseMessageNumber(messageId: string): number | null {
  return parsePositivePgIntegerScopedId(messageId, "msg");
}

function formatMessageId(number: number): string {
  return `msg_${number}`;
}

function uniqueMessages(messages: RoomMessagePayload[]): RoomMessagePayload[] {
  const messagesById = new Map<string, RoomMessagePayload>();
  for (const message of messages) {
    messagesById.set(message.id, message);
  }
  return [...messagesById.values()].sort(
    (left, right) => Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""),
  );
}

function threadMessagesFromWindow(
  rootMessageId: string,
  messages: RoomMessagePayload[],
): RoomMessagePayload[] {
  const included = new Set([rootMessageId]);
  const threadMessages: RoomMessagePayload[] = [];
  for (const message of messages) {
    const replyToId = message.reply_to?.id;
    if (replyToId && included.has(replyToId)) {
      included.add(message.id);
      threadMessages.push(message);
    }
  }
  return threadMessages;
}

async function readRecentRoomMessages(
  roomIdentifier: string,
  storage: ContextStorage,
  args: Record<string, unknown>,
): Promise<ManagedAgentContextResult> {
  const limit = numberArg(args, "limit", 20, MAX_CONTEXT_MESSAGES);
  if (storage === "local") {
    const page = await getLatestLocalChatMessages(roomIdentifier, { limit });
    return {
      ok: true,
      tool: "read_recent_room_messages",
      roomIdentifier,
      storage,
      messages: page.messages.map(compactMessage),
      hasMore: page.has_more,
    };
  }

  const page = await fetchCloudMessages({ roomIdentifier, before: "latest", limit });
  return {
    ok: true,
    tool: "read_recent_room_messages",
    roomIdentifier,
    storage,
    messages: page.messages.map(compactMessage),
    hasMore: page.hasMore,
  };
}

async function searchRoomMessages(
  roomIdentifier: string,
  storage: ContextStorage,
  args: Record<string, unknown>,
): Promise<ManagedAgentContextResult> {
  const query = stringArg(args, "query");
  const limit = numberArg(args, "limit", 20, MAX_CONTEXT_MESSAGES);
  if (!query) {
    return {
      ok: false,
      tool: "search_room_messages",
      roomIdentifier,
      storage,
      error: "search_room_messages requires a non-empty query.",
    };
  }

  if (storage === "local") {
    const page = await searchLocalChatMessages(roomIdentifier, query, { limit });
    return {
      ok: true,
      tool: "search_room_messages",
      roomIdentifier,
      storage,
      messages: page.messages.map(compactMessage),
      hasMore: page.has_more,
    };
  }

  const normalized = query.toLowerCase();
  const messages = (await fetchCloudRecentWindow(roomIdentifier))
    .filter((message) => [
      message.text,
      message.sender,
      message.reply_to?.text,
      message.reply_to?.sender,
    ].some((value) => String(value ?? "").toLowerCase().includes(normalized)))
    .slice(-limit);
  return {
    ok: true,
    tool: "search_room_messages",
    roomIdentifier,
    storage,
    messages: messages.map(compactMessage),
    hasMore: false,
    note: "Cloud message search is limited to the latest cached message window.",
  };
}

async function readThread(
  roomIdentifier: string,
  storage: ContextStorage,
  args: Record<string, unknown>,
): Promise<ManagedAgentContextResult> {
  const rootMessageId = stringArg(args, "root_message_id") || stringArg(args, "id");
  const limit = numberArg(args, "limit", 50, MAX_CONTEXT_MESSAGES);
  if (!rootMessageId) {
    return {
      ok: false,
      tool: "read_thread",
      roomIdentifier,
      storage,
      error: "read_thread requires root_message_id.",
    };
  }
  if (!parseMessageNumber(rootMessageId)) {
    return {
      ok: false,
      tool: "read_thread",
      roomIdentifier,
      storage,
      error: "read_thread requires a valid root_message_id.",
    };
  }

  if (storage === "local") {
    const page = await getLocalChatThreadMessages(roomIdentifier, rootMessageId, { limit });
    return {
      ok: true,
      tool: "read_thread",
      roomIdentifier,
      storage,
      messages: page.messages.map(compactMessage),
      hasMore: page.has_more,
    };
  }

  const [rootMessage, page] = await Promise.all([
    fetchCloudAnchorMessage(roomIdentifier, rootMessageId),
    fetchCloudMessages({
      roomIdentifier,
      after: rootMessageId,
      limit: MAX_CONTEXT_SEARCH_SCAN,
    }),
  ]);
  const messages = uniqueMessages([
    ...(rootMessage ? [rootMessage] : []),
    ...threadMessagesFromWindow(rootMessageId, page.messages),
  ]).slice(0, limit);
  return {
    ok: true,
    tool: "read_thread",
    roomIdentifier,
    storage,
    messages: messages.map(compactMessage),
    hasMore: page.hasMore || messages.length >= limit,
    note: rootMessage
      ? "Cloud thread reads include the root message and replies after it."
      : "Cloud thread reads include replies after the root message; the root message could not be fetched from the history API.",
  };
}

async function readMessagesAround(
  roomIdentifier: string,
  storage: ContextStorage,
  args: Record<string, unknown>,
): Promise<ManagedAgentContextResult> {
  const messageId = stringArg(args, "message_id") || stringArg(args, "id");
  if (!messageId) {
    return {
      ok: false,
      tool: "read_messages_around",
      roomIdentifier,
      storage,
      error: "read_messages_around requires message_id.",
    };
  }
  if (!parseMessageNumber(messageId)) {
    return {
      ok: false,
      tool: "read_messages_around",
      roomIdentifier,
      storage,
      error: "read_messages_around requires a valid message_id.",
    };
  }

  const before = nonNegativeNumberArg(args, "before", 10, 50);
  const after = nonNegativeNumberArg(args, "after", 10, 50);
  if (storage === "local") {
    const page = await getLocalChatMessagesAround(roomIdentifier, messageId, { before, after });
    return {
      ok: true,
      tool: "read_messages_around",
      roomIdentifier,
      storage,
      messages: page.messages.map(compactMessage),
      hasMore: page.has_more,
    };
  }

  const [beforePage, anchorMessage, afterPage] = await Promise.all([
    fetchCloudMessages({ roomIdentifier, before: messageId, limit: before }),
    fetchCloudAnchorMessage(roomIdentifier, messageId),
    fetchCloudMessages({ roomIdentifier, after: messageId, limit: after }),
  ]);
  const messages = uniqueMessages([
    ...beforePage.messages,
    ...(anchorMessage ? [anchorMessage] : []),
    ...afterPage.messages,
  ]);
  return {
    ok: true,
    tool: "read_messages_around",
    roomIdentifier,
    storage,
    messages: messages.map(compactMessage),
    hasMore: beforePage.hasMore || afterPage.hasMore,
    note: anchorMessage
      ? "Cloud message window includes the requested anchor message."
      : "Cloud message window could not fetch the requested anchor message from the history API.",
  };
}

async function fetchCloudTasks(roomIdentifier: string): Promise<DesktopTaskSummary[]> {
  const page = await fetchCloudTaskPage(roomIdentifier, { limit: MAX_CONTEXT_TASKS });
  return page.tasks;
}

async function fetchCloudRoomArtifacts(roomIdentifier: string): Promise<CompactManagedAgentRoomArtifact[]> {
  const page = await apiFetch<{ artifacts?: ManagedAgentRoomArtifactPayload[] }>(
    managedAgentRoomArtifactsPath(roomIdentifier),
  );
  return compactManagedAgentRoomArtifacts(page.artifacts);
}

async function fetchCloudTaskPage(
  roomIdentifier: string,
  options?: { limit?: number; after?: string },
): Promise<{ tasks: DesktopTaskSummary[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set("limit", String(options.limit));
  }
  if (options?.after) {
    params.set("after", options.after);
  }
  const page = await apiFetch<{ tasks?: DesktopTaskSummaryPayload[]; has_more?: boolean }>(
    `/rooms/${encodeURIComponent(roomIdentifier)}/tasks${params.size ? `?${params.toString()}` : ""}`,
  );
  return {
    tasks: (page.tasks || []).map(mapDesktopTaskSummaryPayload),
    hasMore: Boolean(page.has_more),
  };
}

async function fetchCloudTask(roomIdentifier: string, taskId: string): Promise<DesktopTaskSummary> {
  const task = await apiFetch<DesktopTaskSummaryPayload>(
    `/rooms/${encodeURIComponent(roomIdentifier)}/tasks/${encodeURIComponent(taskId)}`,
  );
  return mapDesktopTaskSummaryPayload(task);
}

async function searchCloudTasks(
  roomIdentifier: string,
  query: string,
  afterTaskId?: string,
): Promise<{
  tasks: DesktopTaskSummary[];
  hasMore: boolean;
  scanned: number;
  scannedAll: boolean;
  nextCursor?: string;
}> {
  const matches: DesktopTaskSummary[] = [];
  let after = afterTaskId;
  let scanned = 0;
  let hasMore = false;

  while (scanned < MAX_CONTEXT_TASK_SCAN && matches.length < MAX_CONTEXT_TASKS) {
    const page = await fetchCloudTaskPage(roomIdentifier, {
      limit: Math.min(100, MAX_CONTEXT_TASK_SCAN - scanned),
      after,
    });
    let lastProcessedTaskId: string | undefined;
    for (const [index, task] of page.tasks.entries()) {
      scanned += 1;
      lastProcessedTaskId = task.id;
      if (!query || taskMatchesQuery(task, query)) {
        matches.push(task);
        if (matches.length >= MAX_CONTEXT_TASKS) {
          const hasUnreadTasks = index < page.tasks.length - 1 || page.hasMore;
          return {
            tasks: matches,
            hasMore: hasUnreadTasks,
            scanned,
            scannedAll: !hasUnreadTasks,
            nextCursor: hasUnreadTasks ? task.id : undefined,
          };
        }
      }
    }

    hasMore = page.hasMore;
    after = lastProcessedTaskId;
    if (!page.hasMore || !after) {
      return {
        tasks: matches,
        hasMore: page.hasMore || matches.length >= MAX_CONTEXT_TASKS,
        scanned,
        scannedAll: true,
      };
    }
  }

  return {
    tasks: matches,
    hasMore: hasMore || scanned >= MAX_CONTEXT_TASK_SCAN || matches.length >= MAX_CONTEXT_TASKS,
    scanned,
    scannedAll: false,
    nextCursor: after,
  };
}

function taskMatchesQuery(task: DesktopTaskSummary, query: string): boolean {
  return [
    task.id,
    task.title,
    task.description,
    task.status,
    task.assignee,
    task.assigneeAgentKey,
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function isValidTaskCursor(value: string): boolean {
  return /^task_\d+$/.test(value);
}

async function getTaskContext(
  roomIdentifier: string,
  storage: ContextStorage,
  args: Record<string, unknown>,
): Promise<ManagedAgentContextResult> {
  if (storage === "local") {
    return {
      ok: false,
      tool: "get_task_context",
      roomIdentifier,
      storage,
      error: "Local room task context is not available from desktop storage yet.",
    };
  }

  const taskId = stringArg(args, "task_id") || stringArg(args, "id");
  if (taskId) {
    const task = await fetchCloudTask(roomIdentifier, taskId);
    return {
      ok: true,
      tool: "get_task_context",
      roomIdentifier,
      storage,
      tasks: [compactTask(task)],
      hasMore: false,
    };
  }

  const query = stringArg(args, "query").toLowerCase();
  const afterTaskId = stringArg(args, "after_task_id") || stringArg(args, "after");
  if (afterTaskId && !isValidTaskCursor(afterTaskId)) {
    return {
      ok: false,
      tool: "get_task_context",
      roomIdentifier,
      storage,
      error: "after_task_id must be a task cursor such as task_123.",
    };
  }
  const taskSearch = await searchCloudTasks(roomIdentifier, query, afterTaskId || undefined);
  return {
    ok: true,
    tool: "get_task_context",
    roomIdentifier,
    storage,
    tasks: taskSearch.tasks.map(compactTask),
    hasMore: taskSearch.hasMore,
    nextCursor: taskSearch.nextCursor,
    note: taskSearch.scannedAll
      ? undefined
      : `Task search scanned ${taskSearch.scanned} tasks${taskSearch.nextCursor ? `; pass after_task_id=${taskSearch.nextCursor} to continue.` : "."}`,
  };
}

async function getRoomContextSummary(
  roomIdentifier: string,
  storage: ContextStorage,
  args: Record<string, unknown>,
): Promise<ManagedAgentContextResult> {
  const messageLimit = numberArg(args, "message_limit", 12, MAX_CONTEXT_MESSAGES);
  if (storage === "local") {
    const recentMessages = await getLatestLocalChatMessages(roomIdentifier, { limit: messageLimit });
    const artifactPage = await getLocalRoomArtifacts(roomIdentifier, {
      limit: MANAGED_AGENT_CONTEXT_ARTIFACT_LIMIT,
    });
    return {
      ok: true,
      tool: "get_room_context_summary",
      roomIdentifier,
      storage,
      messages: recentMessages.messages.map(compactMessage),
      hasMore: recentMessages.has_more,
      artifacts: compactManagedAgentRoomArtifacts(artifactPage.artifacts),
      note: "Local storage summary includes messages and shared artifacts; local task context is not available yet.",
    };
  }

  const recentMessages = await fetchCloudMessages({
    roomIdentifier,
    before: "latest",
    limit: messageLimit,
  });
  const result: Extract<ManagedAgentContextResult, { ok: true }> = {
    ok: true,
    tool: "get_room_context_summary",
    roomIdentifier,
    storage,
    messages: recentMessages.messages.map(compactMessage),
    hasMore: recentMessages.hasMore,
  };
  const tasks = await fetchCloudTasks(roomIdentifier);
  result.tasks = tasks.slice(0, MAX_CONTEXT_TASKS).map(compactTask);
  try {
    result.artifacts = await fetchCloudRoomArtifacts(roomIdentifier);
  } catch {
    result.artifacts = [];
    result.note = "Shared artifact summary was unavailable.";
  }
  return result;
}
