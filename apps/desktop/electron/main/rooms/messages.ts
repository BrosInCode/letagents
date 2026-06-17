import type {
  DesktopLocalChatSyncResult,
  DesktopTaskSummary,
  DesktopRoomLatestMessage,
  DesktopRoomMessagesPage,
  DesktopSendRoomMessageResult,
} from "../../ipc-types.js";
import { apiFetch, readStoredAuth } from "../auth.js";
import {
  consumeLocalStagedAttachments,
  publishLocalAttachmentPayload,
} from "../attachments.js";
import {
  addLocalChatMessage,
  claimUnsyncedLocalChatMessages,
  getLatestLocalChatMessages,
  getLocalChatMessagesBefore,
  getSyncedCloudMessageId,
  markLocalChatMessageSynced,
} from "./messages/local-store.js";
import {
  readChatStorageSettings,
  setChatStorageMode,
  setRoomStorageMode,
} from "../chat-storage/settings.js";
import {
  claimLocalTasksForPublish,
  cloudRoomIdentifierForStorage,
  getLocalRoom,
  getLocalRoomByCloudRoom,
  getLocalTaskCloudId,
  localRoomIdentifierForStorage,
  linkLocalRoomToCloud,
  markLocalTaskSynced,
  rememberLocalTaskCloudId,
  releaseLocalTaskPublishClaim,
  resolveLocalAwareRoomStorageMode,
} from "./local-store.js";
import { roomMessageHistoryPageSize } from "../paths.js";
import { desktopSmokeRoomSnapshot, isDesktopSmokeCheck } from "../smoke.js";
import {
  mapRoomMessagePayload,
  type RoomMessagePayload,
} from "./messages/mappers.js";

export { mapRoomMessagePayload, type RoomMessagePayload };

export async function sendDesktopRoomMessage(
  roomIdentifier: string,
  text: string,
  replyTo?: string | null,
  attachments: Array<{ upload_id: string }> = [],
): Promise<DesktopSendRoomMessageResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedText = text.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before sending a message.");
  }
  if (!trimmedText && attachments.length === 0) {
    throw new Error("Write a message before sending.");
  }

  const storedAuth = await readStoredAuth();
  const sender =
    storedAuth.account?.displayName || storedAuth.account?.login || "Desktop";
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const localAttachments = consumeLocalStagedAttachments(
      localRoomIdentifier,
      attachments,
    );
    const message = await addLocalChatMessage(localRoomIdentifier, {
      sender,
      text: trimmedText,
      reply_to: replyTo || null,
      source: "browser",
      attachments: localAttachments,
    });
    return {
      message: mapRoomMessagePayload(message),
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const message = await apiFetch<RoomMessagePayload>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        sender,
        text: trimmedText,
        reply_to: replyTo || null,
        attachments,
      }),
    },
  );

  return {
    message: mapRoomMessagePayload(message),
  };
}

export async function getDesktopRoomMessagesBefore(
  roomIdentifier: string,
  beforeMessageId: string,
  limit = roomMessageHistoryPageSize,
): Promise<DesktopRoomMessagesPage> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedBeforeMessageId = beforeMessageId.trim();
  if (!trimmedRoomIdentifier || !trimmedBeforeMessageId) {
    return { messages: [], hasOlder: false };
  }

  if (isDesktopSmokeCheck()) {
    return { messages: [], hasOlder: false };
  }

  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const page = await getLocalChatMessagesBefore(
      localRoomIdentifier,
      trimmedBeforeMessageId,
      { limit },
    );
    return {
      messages: page.messages.map(mapRoomMessagePayload),
      hasOlder: page.has_more,
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const page = await apiFetch<{
    messages?: RoomMessagePayload[];
    has_older?: boolean;
    has_more?: boolean;
  }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages?limit=${encodeURIComponent(String(limit))}&before=${encodeURIComponent(trimmedBeforeMessageId)}`,
  );

  return {
    messages: [...(page.messages || [])]
      .sort(
        (left, right) =>
          Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""),
      )
      .map(mapRoomMessagePayload),
    hasOlder: Boolean(page.has_older ?? page.has_more),
  };
}

export async function getDesktopRoomLatestMessages(
  roomIdentifiers: string[],
): Promise<DesktopRoomLatestMessage[]> {
  if (isDesktopSmokeCheck()) {
    const snapshot = desktopSmokeRoomSnapshot();
    const latest = snapshot.messages.at(-1) || null;
    return roomIdentifiers.filter(Boolean).map((roomIdentifier) => ({
      roomIdentifier,
      latestMessageId: latest?.id || null,
      latestMessageAt: latest?.timestamp || null,
    }));
  }

  const identifiers = [
    ...new Set(
      roomIdentifiers
        .map((roomIdentifier) => roomIdentifier.trim())
        .filter(Boolean),
    ),
  ].slice(0, 100);
  if (!identifiers.length) return [];

  const results = await Promise.all(
    identifiers.map(async (roomIdentifier): Promise<DesktopRoomLatestMessage | null> => {
      try {
        const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
        const localRoomIdentifier = localRoomIdentifierForStorage(
          storage,
          roomIdentifier,
        );
        const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
          storage,
          roomIdentifier,
        );
        const page = storage.effectiveMode === "local"
          ? await getLatestLocalChatMessages(localRoomIdentifier, { limit: 1 })
          : await apiFetch<{
              messages?: RoomMessagePayload[];
            }>(
              `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages?limit=1&before=latest`,
            );
        const latest = page.messages?.at(-1) || null;
        return {
          roomIdentifier,
          latestMessageId: latest?.id || null,
          latestMessageAt: latest?.timestamp || null,
        };
      } catch {
        return null;
      }
    }),
  );

  return results.filter((result): result is DesktopRoomLatestMessage => Boolean(result));
}

export { readChatStorageSettings, setChatStorageMode, setRoomStorageMode };

export async function syncDesktopLocalChatRoom(
  roomIdentifier: string,
): Promise<DesktopLocalChatSyncResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before syncing local chat.");
  }
  const localRoom = await getLocalRoom(trimmedRoomIdentifier)
    || await getLocalRoomByCloudRoom(trimmedRoomIdentifier);
  if (!localRoom) {
    throw new Error("Only local rooms can be published.");
  }
  const localRoomIdentifier = localRoom.roomIdentifier;
  const cloudRoomIdentifier = await ensureLocalRoomPublishTarget(
    localRoomIdentifier,
  );

  const localMessages = await claimUnsyncedLocalChatMessages(localRoomIdentifier);
  const cloudIdsByLocalId = new Map<string, string>();
  let syncedCount = 0;
  let skippedCount = 0;

  for (const localMessage of localMessages) {
    const replyToCloudId = localMessage.reply_to?.id
      ? cloudIdsByLocalId.get(localMessage.reply_to.id) ||
        await getSyncedCloudMessageId({
          roomId: localRoomIdentifier,
          localMessageId: localMessage.reply_to.id,
        })
      : null;
    if (localMessage.reply_to?.id && !replyToCloudId) {
      skippedCount += 1;
      continue;
    }
    let attachments: Array<{ upload_id: string }> = [];
    try {
      attachments = await Promise.all(
        (localMessage.attachments || []).map((attachment) =>
          publishLocalAttachmentPayload(cloudRoomIdentifier, attachment),
        ),
      );
    } catch {
      skippedCount += 1;
      continue;
    }

    const cloudMessage = await apiFetch<RoomMessagePayload>(
      `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-LetAgents-Desktop-Client": "1",
        },
        body: JSON.stringify({
          sender: localMessage.sender,
          text: localMessage.text,
          reply_to: replyToCloudId,
          attachments,
          client_message_id: localMessage.sync_key,
        }),
      },
    );

    if (cloudMessage.id) {
      cloudIdsByLocalId.set(localMessage.id, cloudMessage.id);
      await markLocalChatMessageSynced({
        roomId: localRoomIdentifier,
        localMessageId: localMessage.id,
        cloudMessageId: cloudMessage.id,
      });
      syncedCount += 1;
    } else {
      skippedCount += 1;
    }
  }

  const taskResult = await syncLocalRoomTasks({
    localRoomIdentifier,
    cloudRoomIdentifier,
  });

  return {
    roomIdentifier: trimmedRoomIdentifier,
    cloudRoomIdentifier,
    syncedCount,
    skippedCount,
    syncedTaskCount: taskResult.syncedTaskCount,
    skippedTaskCount: taskResult.skippedTaskCount,
  };
}

async function ensureLocalRoomPublishTarget(
  roomIdentifier: string,
): Promise<string> {
  const localRoom = await getLocalRoom(roomIdentifier);
  if (localRoom?.cloudRoomIdentifier) {
    return localRoom.cloudRoomIdentifier;
  }
  if (!localRoom) {
    throw new Error("Only local rooms can be published.");
  }

  const createdRoom = await apiFetch<{ id?: string; room_id?: string }>(
    "/projects",
    { method: "POST" },
  );
  const cloudRoomIdentifier = createdRoom.room_id || createdRoom.id;
  if (!cloudRoomIdentifier) {
    throw new Error("Cloud room could not be created for publishing.");
  }
  await linkLocalRoomToCloud({
    roomIdentifier,
    cloudRoomIdentifier,
  });
  return cloudRoomIdentifier;
}

const taskStatusTransitions: Record<string, string[]> = {
  proposed: ["accepted", "cancelled"],
  accepted: ["assigned", "cancelled"],
  assigned: ["in_progress", "in_review", "cancelled"],
  in_progress: ["blocked", "in_review", "done", "cancelled"],
  blocked: ["in_progress", "in_review", "cancelled"],
  in_review: ["merged", "in_progress", "blocked", "done", "cancelled"],
  merged: ["done", "accepted"],
  done: ["accepted"],
  cancelled: ["accepted"],
};

function taskStatusPath(fromStatus: string, toStatus: string): string[] {
  if (!toStatus || fromStatus === toStatus) return [];
  const queue: Array<{ status: string; path: string[] }> = [
    { status: fromStatus || "proposed", path: [] },
  ];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.status)) continue;
    seen.add(current.status);
    for (const next of taskStatusTransitions[current.status] || []) {
      const path = [...current.path, next];
      if (next === toStatus) return path;
      queue.push({ status: next, path });
    }
  }
  return [];
}

function buildTaskPublishPatches(
  task: DesktopTaskSummary,
  cloudStatus: string,
): Record<string, unknown>[] {
  const patches: Record<string, unknown>[] = [];
  const targetStatus = task.status || "proposed";
  const assignee = task.assignee || task.createdBy || "human";
  const statusPath = taskStatusPath(cloudStatus || "proposed", targetStatus);

  for (const nextStatus of statusPath) {
    const patch: Record<string, unknown> = { status: nextStatus };
    if (nextStatus === "assigned") {
      patch.assignee = assignee;
      patch.assignee_agent_key = task.assigneeAgentKey || null;
    }
    patches.push(patch);
  }

  const finalPatch: Record<string, unknown> = {};
  if (task.assignee) finalPatch.assignee = task.assignee;
  if (task.assigneeAgentKey) finalPatch.assignee_agent_key = task.assigneeAgentKey;
  if (task.prUrl) finalPatch.pr_url = task.prUrl;
  if (task.workflowArtifacts?.length) {
    finalPatch.workflow_artifacts = task.workflowArtifacts;
  }
  if (Object.keys(finalPatch).length > 0) {
    patches.push(finalPatch);
  }
  return patches;
}

function extractCloudTask(
  response: { task?: { id?: string; status?: string }; id?: string; status?: string },
): { id: string | null; status: string | null } {
  return {
    id: response.task?.id || response.id || null,
    status: response.task?.status || response.status || null,
  };
}

async function fetchCloudTaskStatus(
  cloudRoomIdentifier: string,
  cloudTaskId: string,
): Promise<string | null> {
  const response = await apiFetch<{
    task?: { status?: string };
    status?: string;
  }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks/${encodeURIComponent(cloudTaskId)}`,
  );
  return response.task?.status || response.status || null;
}

async function patchCloudTask(
  cloudRoomIdentifier: string,
  cloudTaskId: string,
  patch: Record<string, unknown>,
): Promise<{ id: string | null; status: string | null }> {
  const response = await apiFetch<{
    task?: { id?: string; status?: string };
    id?: string;
    status?: string;
  }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks/${encodeURIComponent(cloudTaskId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        ...patch,
        desktop_human_client: true,
      }),
    },
  );
  return extractCloudTask(response);
}

async function syncLocalRoomTasks(input: {
  localRoomIdentifier: string;
  cloudRoomIdentifier: string;
}): Promise<{ syncedTaskCount: number; skippedTaskCount: number }> {
  const localTasks = await claimLocalTasksForPublish(input.localRoomIdentifier);
  let syncedTaskCount = 0;
  let skippedTaskCount = 0;

  for (const task of localTasks) {
    try {
      const cloudTaskId = await getLocalTaskCloudId({
        roomId: input.localRoomIdentifier,
        taskId: task.id,
      });
      const clientTaskId = `local-task:${input.localRoomIdentifier}:${task.id}`;
      const createBody = {
        title: task.title,
        description: task.description,
        created_by: task.createdBy || "human",
        source_message_id: clientTaskId,
        desktop_human_client: true,
        client_task_id: clientTaskId,
      };
      let syncedCloudTaskId = cloudTaskId;
      let cloudStatus: string | null = null;
      if (!syncedCloudTaskId) {
        const response = await apiFetch<{
          task?: { id?: string; status?: string };
          id?: string;
          status?: string;
        }>(
          `/rooms/${encodeURIComponent(input.cloudRoomIdentifier)}/tasks`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-LetAgents-Desktop-Client": "1",
            },
            body: JSON.stringify(createBody),
          },
        );
        const cloudTask = extractCloudTask(response);
        syncedCloudTaskId = cloudTask.id;
        cloudStatus = cloudTask.status || "proposed";
        if (syncedCloudTaskId) {
          await rememberLocalTaskCloudId({
            roomId: input.localRoomIdentifier,
            taskId: task.id,
            cloudTaskId: syncedCloudTaskId,
          });
        }
      } else {
        cloudStatus = await fetchCloudTaskStatus(
          input.cloudRoomIdentifier,
          syncedCloudTaskId,
        );
      }
      if (!syncedCloudTaskId) {
        skippedTaskCount += 1;
        await releaseLocalTaskPublishClaim({
          roomId: input.localRoomIdentifier,
          taskId: task.id,
        });
        continue;
      }
      let latestCloudStatus = cloudStatus || "proposed";
      for (const patch of buildTaskPublishPatches(task, latestCloudStatus)) {
        const patched = await patchCloudTask(
          input.cloudRoomIdentifier,
          syncedCloudTaskId,
          patch,
        );
        latestCloudStatus = patched.status || latestCloudStatus;
      }
      await markLocalTaskSynced({
        roomId: input.localRoomIdentifier,
        taskId: task.id,
        cloudTaskId: syncedCloudTaskId,
      });
      syncedTaskCount += 1;
    } catch {
      skippedTaskCount += 1;
      await releaseLocalTaskPublishClaim({
        roomId: input.localRoomIdentifier,
        taskId: task.id,
      });
    }
  }

  return { syncedTaskCount, skippedTaskCount };
}
