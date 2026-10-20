// The shared context of DesktopRoomShell.vue's composables. The shell fills it in
// order: its props and emit, the state, then the function composables (they only
// define functions, like the hoisted declarations they came from), then each
// watcher and composable slice in its original registration order.

import type { DesktopRoomShellEmit, DesktopRoomShellPropsValue } from "./props";
import type { useRoomShellState } from "./useRoomShellState";
import type { useRoomShellSupervisorActions, useRoomShellSupervisorSync } from "./useRoomShellSupervisor";
import type { useRoomShellDeliveryActions } from "./useRoomShellDelivery";
import type { useRoomShellToolActions, useRoomShellStorageWatcher } from "./useRoomShellTools";
import type { useRoomShellInspectorActions, useRoomShellAgentProjections, useRoomShellInspectorWatchers, useRoomShellInspectorObservations } from "./useRoomShellAgentInspector";
import type { useRoomShellInspectorSettings } from "./useRoomShellInspectorSettings";
import type { useRoomShellInspectorRunActions } from "./useRoomShellInspectorActions";
import type { useRoomShellConversation, useRoomShellIntegrations, useRoomShellNotifications } from "./useRoomShellConversation";
import type { useRoomShellParticipants } from "./useRoomShellParticipants";
import type { useRoomShellRoomWatchers, useRoomShellAttention } from "./useRoomShellWatchers";

/** What each part of the context holds, by composable name. */
interface RoomShellContextParts {
  /** The shell's own props and emit. */
  inputs: { props: DesktopRoomShellPropsValue; emit: DesktopRoomShellEmit };
  useRoomShellState: ReturnType<typeof useRoomShellState>;
  useRoomShellSupervisorActions: ReturnType<typeof useRoomShellSupervisorActions>;
  useRoomShellDeliveryActions: ReturnType<typeof useRoomShellDeliveryActions>;
  useRoomShellToolActions: ReturnType<typeof useRoomShellToolActions>;
  useRoomShellInspectorActions: ReturnType<typeof useRoomShellInspectorActions>;
  useRoomShellInspectorSettings: ReturnType<typeof useRoomShellInspectorSettings>;
  useRoomShellInspectorRunActions: ReturnType<typeof useRoomShellInspectorRunActions>;
  useRoomShellStorageWatcher: ReturnType<typeof useRoomShellStorageWatcher>;
  useRoomShellAgentProjections: ReturnType<typeof useRoomShellAgentProjections>;
  useRoomShellSupervisorSync: ReturnType<typeof useRoomShellSupervisorSync>;
  useRoomShellConversation: ReturnType<typeof useRoomShellConversation>;
  useRoomShellIntegrations: ReturnType<typeof useRoomShellIntegrations>;
  useRoomShellParticipants: ReturnType<typeof useRoomShellParticipants>;
  useRoomShellRoomWatchers: ReturnType<typeof useRoomShellRoomWatchers>;
  useRoomShellAttention: ReturnType<typeof useRoomShellAttention>;
  useRoomShellNotifications: ReturnType<typeof useRoomShellNotifications>;
  useRoomShellInspectorWatchers: ReturnType<typeof useRoomShellInspectorWatchers>;
  useRoomShellInspectorObservations: ReturnType<typeof useRoomShellInspectorObservations>;
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
