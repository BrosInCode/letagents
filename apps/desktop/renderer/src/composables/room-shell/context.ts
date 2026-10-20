// The shared context of DesktopRoomShell.vue's composables. The shell fills it in
// order: its props and emit, the state, then the function composables (they only
// define functions, like the hoisted declarations they came from), then each
// watcher and composable slice in its original registration order.

import type { DesktopRoomShellEmit, DesktopRoomShellPropsValue } from "./props";
import type { useRoomShellState } from "./useRoomShellState";
import type { useRoomShellSupervisorActions, useRoomShellSupervisorSync } from "./useRoomShellSupervisor";
import type { useRoomShellDeliveryActions } from "./useRoomShellDelivery";
import type { useRoomShellToolActions, useRoomShellStorageWatcher } from "./useRoomShellTools";
import type { useRoomShellConversation, useRoomShellIntegrations, useRoomShellNotifications } from "./useRoomShellConversation";

/** What each part of the context holds, by composable name. */
interface RoomShellContextParts {
  /** The shell's own props and emit. */
  inputs: { props: DesktopRoomShellPropsValue; emit: DesktopRoomShellEmit };
  useRoomShellState: ReturnType<typeof useRoomShellState>;
  useRoomShellSupervisorActions: ReturnType<typeof useRoomShellSupervisorActions>;
  useRoomShellDeliveryActions: ReturnType<typeof useRoomShellDeliveryActions>;
  useRoomShellToolActions: ReturnType<typeof useRoomShellToolActions>;
  useRoomShellStorageWatcher: ReturnType<typeof useRoomShellStorageWatcher>;
  useRoomShellSupervisorSync: ReturnType<typeof useRoomShellSupervisorSync>;
  useRoomShellConversation: ReturnType<typeof useRoomShellConversation>;
  useRoomShellIntegrations: ReturnType<typeof useRoomShellIntegrations>;
  useRoomShellNotifications: ReturnType<typeof useRoomShellNotifications>;
  /** Names that still live in DesktopRoomShell.vue while the split is in progress. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pending: Record<string, any>;
}

type UnionToIntersection<U> = (U extends unknown ? (part: U) => void : never) extends (part: infer I) => void ? I : never;

/**
 * The context as one composable sees it: only the parts it reads from. A
 * narrow view keeps TypeScript from inferring a composable's return type from
 * itself.
 */
export type RoomShellContextOf<Name extends keyof RoomShellContextParts> = UnionToIntersection<RoomShellContextParts[Name]>;

/** The whole context that DesktopRoomShell.vue fills. */
export type RoomShellContext = RoomShellContextOf<keyof RoomShellContextParts>;
