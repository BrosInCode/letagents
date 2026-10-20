// The shared context of App.vue's composables. App.vue fills it in order: the
// state, then the function composables (they only define functions, like the
// hoisted declarations they came from), then each watcher and composable slice
// in its original registration order.

import type { useAppState } from "./useAppState";
import type { useAppInboxActions, useAppInboxState, useAppRoomAttention } from "./useAppInbox";
import type { useAppSidebarLayout } from "./useAppSidebarLayout";
import type { useAppSessionActions, useAppAccountScope, useAppAuthFlow, useAppAccountSwitch, useAppAuthWatchers } from "./useAppSession";
import type { useAppNavigation, useAppRoomContext, useAppSelectionWatchers } from "./useAppNavigation";

/** What each composable returns, by composable name. */
interface AppContextParts {
  useAppState: ReturnType<typeof useAppState>;
  useAppInboxActions: ReturnType<typeof useAppInboxActions>;
  useAppSidebarLayout: ReturnType<typeof useAppSidebarLayout>;
  useAppSessionActions: ReturnType<typeof useAppSessionActions>;
  useAppAccountScope: ReturnType<typeof useAppAccountScope>;
  useAppInboxState: ReturnType<typeof useAppInboxState>;
  useAppNavigation: ReturnType<typeof useAppNavigation>;
  useAppRoomAttention: ReturnType<typeof useAppRoomAttention>;
  useAppRoomContext: ReturnType<typeof useAppRoomContext>;
  useAppAuthFlow: ReturnType<typeof useAppAuthFlow>;
  useAppAccountSwitch: ReturnType<typeof useAppAccountSwitch>;
  useAppSelectionWatchers: ReturnType<typeof useAppSelectionWatchers>;
  useAppAuthWatchers: ReturnType<typeof useAppAuthWatchers>;
  /** Names that still live in App.vue while the split is in progress. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appVuePending: Record<string, any>;
}

type UnionToIntersection<U> = (U extends unknown ? (part: U) => void : never) extends (part: infer I) => void ? I : never;

/**
 * The context as one composable sees it: only the results of the composables
 * it reads from. A narrow view keeps TypeScript from inferring a composable's
 * return type from itself.
 */
export type AppContextOf<Name extends keyof AppContextParts> = UnionToIntersection<AppContextParts[Name]>;

/** The whole context that App.vue fills. */
export type AppContext = AppContextOf<keyof AppContextParts>;
