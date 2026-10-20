// The shared context of App.vue's composables. App.vue fills it in order: the
// state, then the function composables (they only define functions, like the
// hoisted declarations they came from), then each watcher and composable slice
// in its original registration order.

import type { useAppState } from "./useAppState";

/** What each composable returns, by composable name. */
interface AppContextParts {
  useAppState: ReturnType<typeof useAppState>;
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
