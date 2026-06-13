import type {
  DesktopFocusRoomConclusionDetails,
  DesktopFocusRoomMutationResult,
  DesktopFocusRoomSettingsPatch,
} from "../../ipc-types.js";
import { apiFetch } from "../auth.js";
import {
  mapDesktopFocusRoomPayload,
  type DesktopFocusRoomPayload,
} from "./snapshot/mappers.js";

type FocusRoomResponse = {
  created?: boolean;
  focus_room?: DesktopFocusRoomPayload;
  room?: DesktopFocusRoomPayload;
  message?: unknown;
};

function mapDesktopFocusRoomMutationResult(data: FocusRoomResponse): DesktopFocusRoomMutationResult {
  const focusRoom = data.focus_room || data.room;
  if (!focusRoom?.room_id) {
    throw new Error("Focus Room response was incomplete.");
  }
  return {
    focusRoom: mapDesktopFocusRoomPayload(focusRoom),
    created: data.created,
    parentMessagePosted: Boolean(data.message),
  };
}

function requireRoomIdentifier(roomIdentifier: string, action: string): string {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) throw new Error(`Choose a room before ${action}.`);
  return trimmedRoomIdentifier;
}

export async function createDesktopTaskFocusRoom(
  roomIdentifier: string,
  taskId: string,
): Promise<DesktopFocusRoomMutationResult> {
  const trimmedRoomIdentifier = requireRoomIdentifier(roomIdentifier, "opening a Focus Room");
  const trimmedTaskId = taskId.trim();
  if (!trimmedTaskId) throw new Error("Task id is required.");

  const data = await apiFetch<FocusRoomResponse>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/tasks/${encodeURIComponent(trimmedTaskId)}/focus-room`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({ desktop_human_client: true }),
    },
  );
  return mapDesktopFocusRoomMutationResult(data);
}

export async function createDesktopAdHocFocusRoom(
  roomIdentifier: string,
  title: string,
): Promise<DesktopFocusRoomMutationResult> {
  const trimmedRoomIdentifier = requireRoomIdentifier(roomIdentifier, "opening a Focus Room");
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error("Focus Room title is required.");

  const data = await apiFetch<FocusRoomResponse>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/focus-rooms`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        title: trimmedTitle,
        desktop_human_client: true,
      }),
    },
  );
  return mapDesktopFocusRoomMutationResult(data);
}

export async function updateDesktopFocusRoomSettings(
  roomIdentifier: string,
  focusKey: string,
  settings: DesktopFocusRoomSettingsPatch,
): Promise<DesktopFocusRoomMutationResult> {
  const trimmedRoomIdentifier = requireRoomIdentifier(roomIdentifier, "saving Focus Room settings");
  const trimmedFocusKey = focusKey.trim();
  if (!trimmedFocusKey) throw new Error("Focus key is required.");

  const data = await apiFetch<FocusRoomResponse>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/focus/${encodeURIComponent(trimmedFocusKey)}/settings`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify(settings),
    },
  );
  return mapDesktopFocusRoomMutationResult(data);
}

export async function concludeDesktopFocusRoom(
  roomIdentifier: string,
  focusKey: string,
  summary: string,
  conclusionDetails: DesktopFocusRoomConclusionDetails | null,
): Promise<DesktopFocusRoomMutationResult> {
  const trimmedRoomIdentifier = requireRoomIdentifier(roomIdentifier, "sharing a Focus Room result");
  const trimmedFocusKey = focusKey.trim();
  const trimmedSummary = summary.trim();
  if (!trimmedFocusKey) throw new Error("Focus key is required.");
  if (!trimmedSummary) throw new Error("Result summary is required.");

  const data = await apiFetch<FocusRoomResponse>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/focus/${encodeURIComponent(trimmedFocusKey)}/conclude`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        summary: trimmedSummary,
        conclusion_details: conclusionDetails,
      }),
    },
  );
  return mapDesktopFocusRoomMutationResult(data);
}

export async function archiveDesktopFocusRoom(
  roomIdentifier: string,
  focusKey: string,
): Promise<DesktopFocusRoomMutationResult> {
  const trimmedRoomIdentifier = requireRoomIdentifier(roomIdentifier, "archiving a Focus Room");
  const trimmedFocusKey = focusKey.trim();
  if (!trimmedFocusKey) throw new Error("Focus key is required.");

  const data = await apiFetch<FocusRoomResponse>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/focus/${encodeURIComponent(trimmedFocusKey)}`,
    {
      method: "DELETE",
      headers: {
        "X-LetAgents-Desktop-Client": "1",
      },
    },
  );
  return mapDesktopFocusRoomMutationResult(data);
}
