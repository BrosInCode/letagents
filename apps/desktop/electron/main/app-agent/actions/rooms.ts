import { z } from "zod";

import type {
  DesktopAccountRoomEntry,
  DesktopAppAgentActionExecutionSummary,
} from "../../../ipc-types.js";

import type { AppAgentActionDefinition } from "../types.js";
import {
  findRoom,
  findRooms,
  findUnpinnedRooms,
  joinRoomNames,
  toToolRoom,
  verifyRoomArchived,
  verifyRoomPinned,
} from "../rooms-matching.js";
import { redactTraceText } from "../trace.js";

type ActionRegistrar = {
  register: <TInput extends z.ZodTypeAny>(
    action: AppAgentActionDefinition<TInput>,
  ) => unknown;
};

export const listRoomsInputSchema = z.object({
  includeArchived: z.boolean().nullable(),
});

export const roomPinnedInputSchema = z.object({
  roomIdentifier: z.string().min(1),
  pinned: z.boolean(),
});

export const roomsPinnedInputSchema = z.object({
  roomIdentifiers: z.array(z.string().min(1)).min(1).max(10),
  pinned: z.boolean(),
});

export const roomArchivedInputSchema = z.object({
  roomIdentifier: z.string().min(1),
  archived: z.boolean(),
});

export const roomsArchivedInputSchema = z.object({
  roomIdentifiers: z.array(z.string().min(1)).min(1).max(10),
  archived: z.boolean(),
});

export const unpinnedRoomsArchivedInputSchema = z.object({
  excludeRoomIdentifiers: z.array(z.string().min(1)).nullable(),
  archived: z.boolean(),
});

export const openRoomInputSchema = z.object({
  roomIdentifier: z.string().min(1),
});

export function roomExecutionSummary(input: {
  actionId: string;
  label: string;
  room: DesktopAccountRoomEntry;
  status: DesktopAppAgentActionExecutionSummary["status"];
  message: string;
}): DesktopAppAgentActionExecutionSummary {
  return {
    actionId: input.actionId,
    label: input.label,
    description: null,
    status: input.status,
    message: redactTraceText(input.message),
    roomIdentifier: input.room.roomIdentifier,
    displayName: input.room.displayName,
  };
}

export function safeActionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? redactTraceText(error.message) : fallback;
}

export function registerRoomActions(registry: ActionRegistrar): void {
  registry.register({
      id: "rooms.list",
      toolName: "list_account_rooms",
      description:
        "List the user's LetAgents rooms with identifiers, names, pinned state, archived state, focus rooms, and timestamps.",
      category: "rooms",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: [],
      inputSchema: listRoomsInputSchema,
      inputSummary: () => "Listed rooms",
      resultLabel: () => "Listed rooms",
      confirmation: () => ({
        label: "List rooms",
        description: "List visible LetAgents rooms.",
        confirmLabel: "List",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const rooms = await context.deps.listAccountRooms({
          includeArchived: input.includeArchived === true,
          limit: 100,
        });
        return {
          message: `Found ${rooms.length} rooms.`,
          actionResult: { rooms: rooms.map(toToolRoom) },
        };
      },
    });
  registry.register({
      id: "rooms.pin",
      toolName: "set_room_pinned",
      description:
        "Pin or unpin exactly one account room by roomIdentifier. Use only when the user intent and room match are unambiguous.",
      category: "rooms",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: roomPinnedInputSchema,
      inputSummary: (input) => `${input.pinned ? "Pin" : "Unpin"} room`,
      resultLabel: (_input, result) =>
        `${result?.pinned ? "Pinned" : "Unpinned"} ${result?.displayName || "room"}`,
      confirmation: (input) => ({
        label: `${input.pinned ? "Pin" : "Unpin"} room`,
        description: `${input.pinned ? "Pin" : "Unpin"} ${input.roomIdentifier}.`,
        confirmLabel: input.pinned ? "Pin" : "Unpin",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const room = await findRoom(context.deps, input.roomIdentifier);
        if (!room) {
          throw new Error(`I don't see a room called "${input.roomIdentifier}" in your account.`);
        }
        const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
          pinned: input.pinned,
        });
        await verifyRoomPinned(context.deps, room.roomIdentifier, input.pinned);
        return {
          message: `${input.pinned ? "Pinned" : "Unpinned"} ${room.displayName}.`,
          roomIdentifier: room.roomIdentifier,
          displayName: room.displayName,
          pinned: input.pinned,
          actionResult: actionResult as unknown as Record<string, unknown>,
        };
      },
    });
  registry.register({
      id: "rooms.pin_many",
      toolName: "set_rooms_pinned",
      description:
        "Pin or unpin multiple account rooms by roomIdentifiers. Use when the user asks to pin or unpin more than one room.",
      category: "rooms",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: roomsPinnedInputSchema,
      inputSummary: (input) => `${input.pinned ? "Pin" : "Unpin"} ${input.roomIdentifiers.length} rooms`,
      resultLabel: (input) => `${input.pinned ? "Pinned" : "Unpinned"} ${input.roomIdentifiers.length} rooms`,
      confirmation: (input) => ({
        label: `${input.pinned ? "Pin" : "Unpin"} rooms`,
        description: `${input.pinned ? "Pin" : "Unpin"} ${input.roomIdentifiers.join(", ")}.`,
        confirmLabel: input.pinned ? "Pin" : "Unpin",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const rooms = await findRooms(context.deps, input.roomIdentifiers);
        const actionResults: Record<string, unknown>[] = [];
        const executedActions: DesktopAppAgentActionExecutionSummary[] = [];
        const successRooms: DesktopAccountRoomEntry[] = [];
        const verb = input.pinned ? "Pin" : "Unpin";
        const pastVerb = input.pinned ? "Pinned" : "Unpinned";
        for (let index = 0; index < rooms.length; index += 1) {
          const room = rooms[index];
          try {
            const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
              pinned: input.pinned,
            });
            await verifyRoomPinned(context.deps, room.roomIdentifier, input.pinned);
            actionResults.push(actionResult as unknown as Record<string, unknown>);
            successRooms.push(room);
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.pin",
              label: `${verb} ${room.displayName}`,
              room,
              status: "success",
              message: `${pastVerb} ${room.displayName}.`,
            }));
          } catch (error) {
            const failedMessage = safeActionErrorMessage(
              error,
              `Could not ${verb.toLowerCase()} ${room.displayName}.`,
            );
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.pin",
              label: `${verb} ${room.displayName}`,
              room,
              status: "error",
              message: failedMessage,
            }));
            for (const skippedRoom of rooms.slice(index + 1)) {
              executedActions.push(roomExecutionSummary({
                actionId: "rooms.pin",
                label: `${verb} ${skippedRoom.displayName}`,
                room: skippedRoom,
                status: "skipped",
                message: "Skipped after an earlier room action failed.",
              }));
            }
            return {
              ok: false,
              message: `Stopped after ${successRooms.length} of ${rooms.length} rooms. ${failedMessage}`,
              roomIdentifier: room.roomIdentifier,
              displayName: joinRoomNames(rooms),
              pinned: input.pinned,
              refreshTargets: ["rooms", "active_room", "foreground"],
              executedActions,
              actionResult: {
                rooms: actionResults,
                roomIdentifiers: successRooms.map((successRoom) => successRoom.roomIdentifier),
                targetRoomIdentifiers: rooms.map((targetRoom) => targetRoom.roomIdentifier),
              },
            };
          }
        }
        return {
          message: `${input.pinned ? "Pinned" : "Unpinned"} ${joinRoomNames(rooms)}.`,
          roomIdentifier: rooms[0]?.roomIdentifier || null,
          displayName: joinRoomNames(rooms),
          pinned: input.pinned,
          executedActions,
          actionResult: {
            rooms: actionResults,
            roomIdentifiers: rooms.map((room) => room.roomIdentifier),
          },
        };
      },
    });
  registry.register({
      id: "rooms.archive",
      toolName: "set_room_archived",
      description:
        "Archive or restore exactly one account room by roomIdentifier. Archiving removes the room from active room lists.",
      category: "rooms",
      risk: "medium",
      requiresConfirmation: true,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: roomArchivedInputSchema,
      inputSummary: (input) => `${input.archived ? "Archive" : "Restore"} room`,
      resultLabel: (_input, result) =>
        `${result?.archived ? "Archived" : "Restored"} ${result?.displayName || "room"}`,
      confirmation: (input) => ({
        label: `${input.archived ? "Archive" : "Restore"} room`,
        description: `${input.archived ? "Archive" : "Restore"} ${input.roomIdentifier}?`,
        confirmLabel: input.archived ? "Archive" : "Restore",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const room = await findRoom(context.deps, input.roomIdentifier);
        if (!room) {
          throw new Error(`I don't see a room called "${input.roomIdentifier}" in your account.`);
        }
        const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
          archived: input.archived,
        });
        await verifyRoomArchived(context.deps, room.roomIdentifier, input.archived);
        return {
          message: `${input.archived ? "Archived" : "Restored"} ${room.displayName}.`,
          roomIdentifier: room.roomIdentifier,
          displayName: room.displayName,
          archived: input.archived,
          actionResult: {
            ...(actionResult as unknown as Record<string, unknown>),
            roomIdentifier: room.roomIdentifier,
            displayName: room.displayName,
            archivedRoomIdentifiers: input.archived ? [room.roomIdentifier] : [],
            archivedRooms: input.archived ? [toToolRoom(room)] : [],
          },
        };
      },
    });
  registry.register({
      id: "rooms.archive_many",
      toolName: "set_rooms_archived",
      description:
        "Archive or restore multiple account rooms by roomIdentifiers. Use when the user asks to archive, hide, restore, or unarchive more than one room.",
      category: "rooms",
      risk: "medium",
      requiresConfirmation: true,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: roomsArchivedInputSchema,
      inputSummary: (input) => `${input.archived ? "Archive" : "Restore"} ${input.roomIdentifiers.length} rooms`,
      resultLabel: (input) => `${input.archived ? "Archived" : "Restored"} ${input.roomIdentifiers.length} rooms`,
      confirmation: (input) => ({
        label: `${input.archived ? "Archive" : "Restore"} rooms`,
        description: `${input.archived ? "Archive" : "Restore"} ${input.roomIdentifiers.join(" and ")}?`,
        confirmLabel: input.archived ? "Archive" : "Restore",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const rooms = await findRooms(context.deps, input.roomIdentifiers);
        const actionResults: Record<string, unknown>[] = [];
        const executedActions: DesktopAppAgentActionExecutionSummary[] = [];
        const successRooms: DesktopAccountRoomEntry[] = [];
        const verb = input.archived ? "Archive" : "Restore";
        const pastVerb = input.archived ? "Archived" : "Restored";
        for (let index = 0; index < rooms.length; index += 1) {
          const room = rooms[index];
          try {
            const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
              archived: input.archived,
            });
            await verifyRoomArchived(context.deps, room.roomIdentifier, input.archived);
            actionResults.push(actionResult as unknown as Record<string, unknown>);
            successRooms.push(room);
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.archive",
              label: `${verb} ${room.displayName}`,
              room,
              status: "success",
              message: `${pastVerb} ${room.displayName}.`,
            }));
          } catch (error) {
            const failedMessage = safeActionErrorMessage(
              error,
              `Could not ${verb.toLowerCase()} ${room.displayName}.`,
            );
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.archive",
              label: `${verb} ${room.displayName}`,
              room,
              status: "error",
              message: failedMessage,
            }));
            for (const skippedRoom of rooms.slice(index + 1)) {
              executedActions.push(roomExecutionSummary({
                actionId: "rooms.archive",
                label: `${verb} ${skippedRoom.displayName}`,
                room: skippedRoom,
                status: "skipped",
                message: "Skipped after an earlier room action failed.",
              }));
            }
            return {
              ok: false,
              message: `Stopped after ${successRooms.length} of ${rooms.length} rooms. ${failedMessage}`,
              roomIdentifier: room.roomIdentifier,
              displayName: joinRoomNames(rooms),
              archived: input.archived,
              refreshTargets: ["rooms", "active_room", "foreground"],
              executedActions,
              actionResult: {
                actionResults,
                rooms: successRooms.map(toToolRoom),
                roomIdentifiers: successRooms.map((successRoom) => successRoom.roomIdentifier),
                targetRoomIdentifiers: rooms.map((targetRoom) => targetRoom.roomIdentifier),
                archivedRoomIdentifiers: input.archived
                  ? successRooms.map((successRoom) => successRoom.roomIdentifier)
                  : [],
                archivedRooms: input.archived ? successRooms.map(toToolRoom) : [],
              },
            };
          }
        }
        return {
          message: `${input.archived ? "Archived" : "Restored"} ${joinRoomNames(rooms)}.`,
          roomIdentifier: rooms[0]?.roomIdentifier || null,
          displayName: joinRoomNames(rooms),
          archived: input.archived,
          executedActions,
          actionResult: {
            actionResults,
            rooms: rooms.map(toToolRoom),
            roomIdentifiers: rooms.map((room) => room.roomIdentifier),
            archivedRoomIdentifiers: input.archived
              ? rooms.map((room) => room.roomIdentifier)
              : [],
            archivedRooms: input.archived ? rooms.map(toToolRoom) : [],
          },
        };
      },
    });
  registry.register({
      id: "rooms.archive_unpinned",
      toolName: "archive_unpinned_rooms",
      description:
        "Archive all currently visible account rooms that are not pinned, optionally excluding specific rooms by identifier or name. Electron main computes the matching room set.",
      category: "rooms",
      risk: "medium",
      requiresConfirmation: true,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: unpinnedRoomsArchivedInputSchema,
      inputSummary: () => "Archive unpinned rooms",
      resultLabel: () => "Archived unpinned rooms",
      confirmation: (input) => ({
        label: "Archive unpinned rooms",
        description: input.excludeRoomIdentifiers?.length
          ? `Archive all unpinned rooms except ${input.excludeRoomIdentifiers.join(" and ")}?`
          : "Archive all unpinned rooms?",
        confirmLabel: "Archive",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        if (!input.archived) {
          throw new Error("Unpinned-room batch action only supports archiving.");
        }
        const rooms = await findUnpinnedRooms(context.deps, input.excludeRoomIdentifiers);
        if (!rooms.length) {
          throw new Error("There are no unpinned rooms to archive.");
        }
        const actionResults: Record<string, unknown>[] = [];
        const executedActions: DesktopAppAgentActionExecutionSummary[] = [];
        const successRooms: DesktopAccountRoomEntry[] = [];
        for (let index = 0; index < rooms.length; index += 1) {
          const room = rooms[index];
          try {
            const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
              archived: true,
            });
            await verifyRoomArchived(context.deps, room.roomIdentifier, true);
            actionResults.push(actionResult as unknown as Record<string, unknown>);
            successRooms.push(room);
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.archive",
              label: `Archive ${room.displayName}`,
              room,
              status: "success",
              message: `Archived ${room.displayName}.`,
            }));
          } catch (error) {
            const failedMessage = safeActionErrorMessage(
              error,
              `Could not archive ${room.displayName}.`,
            );
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.archive",
              label: `Archive ${room.displayName}`,
              room,
              status: "error",
              message: failedMessage,
            }));
            for (const skippedRoom of rooms.slice(index + 1)) {
              executedActions.push(roomExecutionSummary({
                actionId: "rooms.archive",
                label: `Archive ${skippedRoom.displayName}`,
                room: skippedRoom,
                status: "skipped",
                message: "Skipped after an earlier room action failed.",
              }));
            }
            return {
              ok: false,
              message: `Stopped after ${successRooms.length} of ${rooms.length} rooms. ${failedMessage}`,
              roomIdentifier: room.roomIdentifier,
              displayName: joinRoomNames(rooms),
              archived: true,
              refreshTargets: ["rooms", "active_room", "foreground"],
              executedActions,
              actionResult: {
                actionResults,
                rooms: successRooms.map(toToolRoom),
                roomIdentifiers: successRooms.map((successRoom) => successRoom.roomIdentifier),
                targetRoomIdentifiers: rooms.map((targetRoom) => targetRoom.roomIdentifier),
                archivedRoomIdentifiers: successRooms.map((successRoom) => successRoom.roomIdentifier),
                archivedRooms: successRooms.map(toToolRoom),
              },
            };
          }
        }
        return {
          message: `Archived ${joinRoomNames(rooms)}.`,
          roomIdentifier: rooms[0]?.roomIdentifier || null,
          displayName: joinRoomNames(rooms),
          archived: true,
          executedActions,
          actionResult: {
            actionResults,
            rooms: rooms.map(toToolRoom),
            roomIdentifiers: rooms.map((room) => room.roomIdentifier),
            archivedRoomIdentifiers: rooms.map((room) => room.roomIdentifier),
            archivedRooms: rooms.map(toToolRoom),
          },
        };
      },
    });
  registry.register({
      id: "rooms.open",
      toolName: "open_room",
      description:
        "Open exactly one LetAgents room in the desktop app by roomIdentifier.",
      category: "rooms",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: ["active_room", "foreground"],
      inputSchema: openRoomInputSchema,
      inputSummary: () => "Open room",
      resultLabel: (_input, result) => `Opened ${result?.displayName || "room"}`,
      confirmation: (input) => ({
        label: "Open room",
        description: `Open ${input.roomIdentifier}.`,
        confirmLabel: "Open",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const room = await findRoom(context.deps, input.roomIdentifier);
        if (!room) {
          throw new Error(`I don't see a room called "${input.roomIdentifier}" in your account.`);
        }
        return {
          message: `Opened ${room.displayName}.`,
          roomIdentifier: room.roomIdentifier,
          displayName: room.displayName,
          openRoomIdentifier: room.roomIdentifier,
          actionResult: { roomIdentifier: room.roomIdentifier },
        };
      },
    });
}
