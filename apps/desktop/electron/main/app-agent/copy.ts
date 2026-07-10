import { z } from "zod";

import type {
  DesktopAppAgentActionReference,
  DesktopAppAgentPendingAction,
} from "../../ipc-types.js";

import type {
  AppAgentActionDefinition,
  AppAgentActionRegistryDeps,
} from "./types.js";
import {
  findRooms,
  findUnpinnedRooms,
  joinRoomNames,
  requireRoom,
} from "./rooms-matching.js";
import {
  openRoomInputSchema,
  roomArchivedInputSchema,
  roomPinnedInputSchema,
  roomsArchivedInputSchema,
  roomsPinnedInputSchema,
  unpinnedRoomsArchivedInputSchema,
} from "./actions/rooms.js";

export function asActionInput(input: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}
export function makeChoiceId(actionId: string, input: Record<string, unknown>): string {
  const basis = `${actionId}:${JSON.stringify(input)}`;
  let hash = 0;
  for (let index = 0; index < basis.length; index += 1) {
    hash = (hash * 31 + basis.charCodeAt(index)) >>> 0;
  }
  return `${actionId}:${hash.toString(36)}`;
}

export function toPendingAction<TInput extends z.ZodTypeAny>(
  action: AppAgentActionDefinition<TInput>,
  input: z.infer<TInput>,
): DesktopAppAgentPendingAction {
  const actionInput = asActionInput(input);
  const confirmation = action.confirmation(input);
  return {
    confirmationId: makeChoiceId(action.id, actionInput),
    actionId: action.id,
    input: actionInput,
    risk: action.risk,
    ...confirmation,
  };
}
export async function resolvedActionCopy<TInput extends z.ZodTypeAny>(
  action: AppAgentActionDefinition<TInput>,
  input: z.infer<TInput>,
  deps: AppAgentActionRegistryDeps,
): Promise<{
  label: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
}> {
  const fallback = action.confirmation(input);
  if (action.id === "rooms.pin") {
    const parsed = roomPinnedInputSchema.parse(input);
    const room = await requireRoom(deps, parsed.roomIdentifier);
    const verb = parsed.pinned ? "Pin" : "Unpin";
    return {
      ...fallback,
      label: `${verb} ${room.displayName}`,
      description: `${verb} ${room.displayName}.`,
    };
  }
  if (action.id === "rooms.pin_many") {
    const parsed = roomsPinnedInputSchema.parse(input);
    const rooms = await findRooms(deps, parsed.roomIdentifiers);
    const verb = parsed.pinned ? "Pin" : "Unpin";
    return {
      ...fallback,
      label: `${verb} ${rooms.length} rooms`,
      description: `${verb} ${joinRoomNames(rooms)}.`,
    };
  }
  if (action.id === "rooms.archive") {
    const parsed = roomArchivedInputSchema.parse(input);
    const room = await requireRoom(deps, parsed.roomIdentifier);
    const verb = parsed.archived ? "Archive" : "Restore";
    return {
      ...fallback,
      label: `${verb} ${room.displayName}`,
      description: `${verb} ${room.displayName}?`,
    };
  }
  if (action.id === "rooms.archive_many") {
    const parsed = roomsArchivedInputSchema.parse(input);
    const rooms = await findRooms(deps, parsed.roomIdentifiers);
    const verb = parsed.archived ? "Archive" : "Restore";
    return {
      ...fallback,
      label: `${verb} ${rooms.length} rooms`,
      description: `${verb} ${joinRoomNames(rooms)}?`,
    };
  }
  if (action.id === "rooms.archive_unpinned") {
    const parsed = unpinnedRoomsArchivedInputSchema.parse(input);
    const rooms = await findUnpinnedRooms(deps, parsed.excludeRoomIdentifiers);
    if (!rooms.length) {
      throw new Error("There are no unpinned rooms to archive.");
    }
    return {
      ...fallback,
      label: "Archive unpinned rooms",
      description: `Archive ${joinRoomNames(rooms)}?`,
    };
  }
  if (action.id === "rooms.open") {
    const parsed = openRoomInputSchema.parse(input);
    const room = await requireRoom(deps, parsed.roomIdentifier);
    return {
      ...fallback,
      label: `Open ${room.displayName}`,
      description: `Open ${room.displayName}.`,
    };
  }
  return fallback;
}

export async function toDisplayActionReference<TInput extends z.ZodTypeAny>(
  action: AppAgentActionDefinition<TInput>,
  input: z.infer<TInput>,
  deps: AppAgentActionRegistryDeps,
): Promise<DesktopAppAgentActionReference> {
  const actionInput = asActionInput(input);
  const copy = await resolvedActionCopy(action, input, deps);
  return {
    actionId: action.id,
    input: actionInput,
    label: copy.label,
    description: copy.description,
    risk: action.risk,
    refreshTargets: action.refreshTargets,
  };
}

export async function resolvedPendingAction<TInput extends z.ZodTypeAny>(
  action: AppAgentActionDefinition<TInput>,
  input: z.infer<TInput>,
  deps: AppAgentActionRegistryDeps,
): Promise<DesktopAppAgentPendingAction> {
  const pendingAction = toPendingAction(action, input);
  const copy = await resolvedActionCopy(action, input, deps);
  pendingAction.label = copy.label;
  pendingAction.description = copy.description;
  pendingAction.confirmLabel = copy.confirmLabel;
  pendingAction.cancelLabel = copy.cancelLabel;
  return pendingAction;
}
