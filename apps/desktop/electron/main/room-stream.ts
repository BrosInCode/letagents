import type {
  DesktopRentalActivityEvent,
  DesktopRoomStreamEvent,
  DesktopTaskSummary,
} from "../ipc-types.js";
import { mapApiActivityEvent } from "../rental/api-mapper.js";
import { apiUrl, roomMessageHistoryPageSize } from "./paths.js";
import { readStoredAuth } from "./auth.js";
import { isLocalChatStorageEnabled } from "./chat-storage/settings.js";
import { getLocalChatMessages } from "./rooms/messages/local-store.js";
import {
  mapDesktopReasoningSessionPayload,
  mapDesktopReasoningUpdatePayload,
  mapGitHubRoomEventPayload,
  mapDesktopTaskSummaryPayload,
  mapRoomMessagePayload,
} from "./rooms.js";
import { emitToMainWindow } from "./window.js";

let activeRoomStream: {
  roomIdentifier: string;
  abortController: AbortController;
  reconnectTimer: NodeJS.Timeout | null;
  pollAbortController: AbortController | null;
  retryMs: number;
  lastMessageId: string | null;
  stopped: boolean;
} | null = null;

export function getActiveRoomIdentifier(): string | null {
  return activeRoomStream?.roomIdentifier ?? null;
}

function isCurrentRoomStream(
  stream: NonNullable<typeof activeRoomStream>,
): boolean {
  return activeRoomStream === stream && !stream.stopped;
}

export function emitRoomStreamEvent(event: DesktopRoomStreamEvent): void {
  emitToMainWindow("desktop:room:stream-event", event);
}

function mapRoomStreamTaskPayload(task: {
  id?: string;
  title?: string;
  description?: string | null;
  status?: string;
  assignee?: string | null;
  assignee_agent_key?: string | null;
  created_by?: string | null;
  pr_url?: string | null;
  workflow_artifacts?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["workflow_artifacts"];
  workflow_refs?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["workflow_refs"];
  active_leases?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["active_leases"];
  active_locks?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["active_locks"];
  stale_prompt_state?: Parameters<
    typeof mapDesktopTaskSummaryPayload
  >[0]["stale_prompt_state"];
  created_at?: string | null;
  updated_at?: string;
  updatedAt?: string;
}): DesktopTaskSummary | null {
  if (!task.id) return null;
  return mapDesktopTaskSummaryPayload({ ...task, id: task.id });
}

function readStreamActivity(
  payload: Record<string, unknown>,
): DesktopRentalActivityEvent | null {
  const rawActivity = payload.activity;
  return mapApiActivityEvent(rawActivity ?? payload);
}

function readPatchIdFromActivityPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const obj = payload as Record<string, unknown>;
  return typeof obj.patch_id === "string"
    ? obj.patch_id
    : typeof obj.patchId === "string"
      ? obj.patchId
      : null;
}

function handleRoomStreamFrame(
  roomIdentifier: string,
  eventName: string,
  data: string,
): void {
  if (!data.trim()) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }

  const eventRoomIdentifier =
    typeof payload.room_id === "string" ? payload.room_id : roomIdentifier;
  if (eventName === "task_update") {
    const task = mapRoomStreamTaskPayload(payload);
    if (task) {
      emitRoomStreamEvent({
        type: "task_update",
        roomIdentifier: eventRoomIdentifier,
        task,
      });
    }
    return;
  }

  if (eventName === "github_event") {
    const event = mapGitHubRoomEventPayload(payload);
    if (event) {
      emitRoomStreamEvent({
        type: "github_event",
        roomIdentifier: eventRoomIdentifier,
        event,
      });
    }
    return;
  }

  if (eventName === "reasoning_update") {
    const session = payload.session;
    if (
      session &&
      typeof session === "object" &&
      typeof (session as { id?: unknown }).id === "string"
    ) {
      emitRoomStreamEvent({
        type: "reasoning_update",
        roomIdentifier: eventRoomIdentifier,
        session: mapDesktopReasoningSessionPayload(
          session as Parameters<typeof mapDesktopReasoningSessionPayload>[0],
        ),
      });
    }
    return;
  }

  if (eventName === "reasoning_remove") {
    const sessionId =
      typeof payload.session_id === "string"
        ? payload.session_id
        : typeof payload.id === "string"
          ? payload.id
          : null;
    if (sessionId) {
      emitRoomStreamEvent({
        type: "reasoning_remove",
        roomIdentifier: eventRoomIdentifier,
        sessionId,
      });
    }
    return;
  }

  if (eventName === "rental_activity") {
    const activity = readStreamActivity(payload);
    if (activity) {
      emitRoomStreamEvent({
        type: "rental_activity",
        roomIdentifier: eventRoomIdentifier,
        activity,
      });
    }
    return;
  }

  if (eventName === "rental_patch") {
    const activity = readStreamActivity(payload);
    emitRoomStreamEvent({
      type: "rental_patch",
      roomIdentifier: eventRoomIdentifier,
      activity,
      patchId: readPatchIdFromActivityPayload(activity?.payload ?? null),
    });
    return;
  }

  if (eventName === "rental_usage") {
    const activity = readStreamActivity(payload);
    emitRoomStreamEvent({
      type: "rental_usage",
      roomIdentifier: eventRoomIdentifier,
      activity,
      sessionId: activity?.sessionId || null,
    });
    return;
  }

  if (eventName === "session_disconnect") {
    emitRoomStreamEvent({
      type: "session_disconnect",
      roomIdentifier: eventRoomIdentifier,
      message: "Room stream disconnected.",
    });
    return;
  }

  if (eventName === "message") {
    if (
      activeRoomStream?.roomIdentifier === roomIdentifier &&
      typeof payload.id === "string"
    ) {
      activeRoomStream.lastMessageId = payload.id;
    }
    emitRoomStreamEvent({
      type: "message",
      roomIdentifier: eventRoomIdentifier,
      message: mapRoomMessagePayload(
        payload as Parameters<typeof mapRoomMessagePayload>[0],
      ),
    });
  }
}

async function pollDesktopRoomMessages(
  stream: NonNullable<typeof activeRoomStream>,
): Promise<void> {
  while (isCurrentRoomStream(stream)) {
    const after = stream.lastMessageId;
    if (!after) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }

    const pollAbortController = new AbortController();
    stream.pollAbortController = pollAbortController;
    try {
      const storedAuth = await readStoredAuth();
      const requestHeaders = new Headers({
        Accept: "application/json",
        "X-LetAgents-Desktop-Client": "1",
      });
      if (storedAuth.token) {
        requestHeaders.set("Authorization", `Bearer ${storedAuth.token}`);
      }
      const response = await fetch(
        `${apiUrl}/rooms/${encodeURIComponent(stream.roomIdentifier)}/messages/poll?limit=${roomMessageHistoryPageSize}&timeout=25000&after=${encodeURIComponent(after)}`,
        { headers: requestHeaders, signal: pollAbortController.signal },
      );
      if (!response.ok) {
        throw new Error(`Room poll failed with HTTP ${response.status}.`);
      }
      const page = (await response.json()) as {
        room_id?: string;
        messages?: Parameters<typeof mapRoomMessagePayload>[0][];
      };
      if (!isCurrentRoomStream(stream)) return;
      for (const rawMessage of page.messages || []) {
        if (!isCurrentRoomStream(stream)) return;
        if (typeof rawMessage.id === "string") {
          stream.lastMessageId = rawMessage.id;
        }
        emitRoomStreamEvent({
          type: "message",
          roomIdentifier: page.room_id || stream.roomIdentifier,
          message: mapRoomMessagePayload(rawMessage),
        });
      }
    } catch (error) {
      if (!isCurrentRoomStream(stream) || pollAbortController.signal.aborted)
        return;
      emitRoomStreamEvent({
        type: "error",
        roomIdentifier: stream.roomIdentifier,
        message:
          error instanceof Error ? error.message : "Room polling disconnected.",
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));
    } finally {
      if (stream.pollAbortController === pollAbortController) {
        stream.pollAbortController = null;
      }
    }
  }
}

async function pollLocalDesktopRoomMessages(
  stream: NonNullable<typeof activeRoomStream>,
): Promise<void> {
  emitRoomStreamEvent({
    type: "open",
    roomIdentifier: stream.roomIdentifier,
  });

  while (isCurrentRoomStream(stream)) {
    try {
      const page = await getLocalChatMessages(stream.roomIdentifier, {
        after: stream.lastMessageId,
        limit: roomMessageHistoryPageSize,
      });
      if (!isCurrentRoomStream(stream)) return;
      for (const rawMessage of page.messages) {
        if (!isCurrentRoomStream(stream)) return;
        stream.lastMessageId = rawMessage.id;
        emitRoomStreamEvent({
          type: "message",
          roomIdentifier: stream.roomIdentifier,
          message: mapRoomMessagePayload(rawMessage),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, page.messages.length ? 250 : 1500));
    } catch (error) {
      if (!isCurrentRoomStream(stream)) return;
      emitRoomStreamEvent({
        type: "error",
        roomIdentifier: stream.roomIdentifier,
        message:
          error instanceof Error
            ? error.message
            : "Local room polling disconnected.",
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }
}

function parseRoomStreamChunk(roomIdentifier: string, chunk: string): string {
  const frames = chunk.split(/\n\n/);
  const remainder = frames.pop() || "";

  for (const frame of frames) {
    const lines = frame.split(/\r?\n/);
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    handleRoomStreamFrame(roomIdentifier, eventName, dataLines.join("\n"));
  }

  return remainder;
}

async function openDesktopRoomStream(
  stream: NonNullable<typeof activeRoomStream>,
): Promise<void> {
  const storedAuth = await readStoredAuth();
  const requestHeaders = new Headers({
    Accept: "text/event-stream",
    "X-LetAgents-Desktop-Client": "1",
  });
  if (storedAuth.token) {
    requestHeaders.set("Authorization", `Bearer ${storedAuth.token}`);
  }

  try {
    const response = await fetch(
      `${apiUrl}/rooms/${encodeURIComponent(stream.roomIdentifier)}/messages/stream`,
      {
        headers: requestHeaders,
        signal: stream.abortController.signal,
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`Room stream failed with HTTP ${response.status}.`);
    }

    stream.retryMs = 1000;
    emitRoomStreamEvent({
      type: "open",
      roomIdentifier: stream.roomIdentifier,
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (isCurrentRoomStream(stream)) {
      const { done, value } = await reader.read();
      if (!isCurrentRoomStream(stream)) break;
      if (done) break;
      buffer = parseRoomStreamChunk(
        stream.roomIdentifier,
        buffer + decoder.decode(value, { stream: true }),
      );
    }
  } catch (error) {
    if (!isCurrentRoomStream(stream) || stream.abortController.signal.aborted)
      return;
    emitRoomStreamEvent({
      type: "error",
      roomIdentifier: stream.roomIdentifier,
      message:
        error instanceof Error ? error.message : "Room stream disconnected.",
    });
  }

  if (isCurrentRoomStream(stream)) {
    const retryMs = Math.min(stream.retryMs, 30_000);
    stream.retryMs = Math.min(stream.retryMs * 2, 30_000);
    stream.reconnectTimer = setTimeout(() => {
      stream.reconnectTimer = null;
      void openDesktopRoomStream(stream);
    }, retryMs);
  }
}

export async function startDesktopRoomStream(
  roomIdentifier: string,
  afterMessageId?: string | null,
): Promise<void> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before opening the live stream.");
  }

  if (
    activeRoomStream?.roomIdentifier === trimmedRoomIdentifier &&
    !activeRoomStream.stopped
  ) {
    if (afterMessageId) {
      activeRoomStream.lastMessageId = afterMessageId;
    }
    return;
  }

  await stopDesktopRoomStream();
  activeRoomStream = {
    roomIdentifier: trimmedRoomIdentifier,
    abortController: new AbortController(),
    reconnectTimer: null,
    pollAbortController: null,
    retryMs: 1000,
    lastMessageId: afterMessageId || null,
    stopped: false,
  };
  if (await isLocalChatStorageEnabled()) {
    void pollLocalDesktopRoomMessages(activeRoomStream);
    return;
  }
  void openDesktopRoomStream(activeRoomStream);
  void pollDesktopRoomMessages(activeRoomStream);
}

export async function stopDesktopRoomStream(
  roomIdentifier?: string | null,
): Promise<void> {
  if (!activeRoomStream) return;
  if (
    roomIdentifier &&
    activeRoomStream.roomIdentifier !== roomIdentifier.trim()
  )
    return;

  activeRoomStream.stopped = true;
  activeRoomStream.abortController.abort();
  activeRoomStream.pollAbortController?.abort();
  if (activeRoomStream.reconnectTimer) {
    clearTimeout(activeRoomStream.reconnectTimer);
  }
  activeRoomStream = null;
}
