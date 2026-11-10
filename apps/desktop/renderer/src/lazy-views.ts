import { defineAsyncComponent, type Component } from "vue";

// Views that the first paint of a room does not need. Each one is its own chunk,
// so the entry chunk holds only the room chat path. After the first room has
// painted and the main thread is idle, preloadLikelyViews() loads them one at a
// time, so a later click renders at once, exactly as with a static import.

export interface LazyView<T extends Component = Component> {
  component: T;
  /** Loads and evaluates the chunk, and marks the component resolved. Never rejects. */
  preload: () => Promise<void>;
}

export function lazyView<T extends Component>(loader: () => Promise<{ default: T }>): LazyView<T> {
  // One request at a time; a failed request is forgotten, so a later mount tries again.
  let pending: Promise<{ default: T }> | null = null;
  const load = () => pending ??= loader().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  const component = defineAsyncComponent(load);
  return {
    component,
    async preload() {
      try {
        await load();
        // The wrapper's own loader reuses the resolved request and records the
        // component, so its next mount renders in the same pass, with no empty frame.
        await (component as { __asyncLoader?: () => Promise<unknown> }).__asyncLoader?.();
      } catch {
        // The view still loads when it is opened.
      }
    },
  };
}

export const SettingsViewLazy = lazyView(() => import("./components/desktop/content/SettingsView.vue"));
export const InboxViewLazy = lazyView(() => import("./components/desktop/content/InboxView.vue"));
export const MyWorkViewLazy = lazyView(() => import("./components/desktop/content/MyWorkView.vue"));
export const CompanyHomeLazy = lazyView(() => import("./components/desktop/content/CompanyHome.vue"));
export const DesktopNewRoomModalLazy = lazyView(() => import("./components/desktop/content/DesktopNewRoomModal.vue"));
export const AddAgentModalLazy = lazyView(() => import("./components/desktop/content/AddAgentModal.vue"));
export const AgentInspectorHostLazy = lazyView(() => import("./components/desktop/content/agent-inspector/AgentInspectorHost.vue"));
export const RoomBoardViewLazy = lazyView(() => import("./components/desktop/content/RoomBoardView.vue"));
export const RoomActivityTabViewLazy = lazyView(() => import("./components/desktop/content/RoomActivityTabView.vue"));
export const RoomEventsViewLazy = lazyView(() => import("./components/desktop/content/RoomEventsView.vue"));
export const RoomMemoryViewLazy = lazyView(() => import("./components/desktop/content/RoomMemoryView.vue"));
export const RoomDetailsViewLazy = lazyView(() => import("./components/desktop/content/RoomDetailsView.vue"));

/** Most likely first. */
const likelyViews: readonly LazyView[] = [
  SettingsViewLazy,
  InboxViewLazy,
  MyWorkViewLazy,
  AddAgentModalLazy,
  DesktopNewRoomModalLazy,
  RoomBoardViewLazy,
  AgentInspectorHostLazy,
  RoomActivityTabViewLazy,
  RoomEventsViewLazy,
  RoomMemoryViewLazy,
  RoomDetailsViewLazy,
  CompanyHomeLazy,
];

export interface IdleScheduler {
  /** Runs the callback after the next frame has painted. */
  afterPaint: (callback: () => void) => void;
  /** Runs the callback when the main thread is idle, or after timeoutMs at the latest. */
  whenIdle: (callback: () => void, timeoutMs: number) => void;
}

const browserScheduler: IdleScheduler = {
  afterPaint(callback) {
    // A task queued from the next frame callback runs after that frame paints.
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(callback, 0));
    else setTimeout(callback, 0);
  },
  whenIdle(callback, timeoutMs) {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => callback(), { timeout: timeoutMs });
    else setTimeout(callback, 0);
  },
};

export const IDLE_PRELOAD_TIMEOUT_MS = 2_000;

/**
 * Returns a start function that preloads each task in its own idle slot, one
 * after another. Only the first call starts; a rejected or throwing task does
 * not stop the rest; nothing is thrown to the caller.
 */
export function createIdlePreloader(
  tasks: readonly (() => Promise<unknown>)[],
  scheduler: IdleScheduler = browserScheduler,
  timeoutMs = IDLE_PRELOAD_TIMEOUT_MS,
): () => void {
  let started = false;
  const runFrom = (index: number): void => {
    if (index >= tasks.length) return;
    try {
      scheduler.whenIdle(() => {
        let result: Promise<unknown>;
        try {
          result = Promise.resolve(tasks[index]());
        } catch {
          result = Promise.resolve();
        }
        void result.catch(() => undefined).then(() => runFrom(index + 1));
      }, timeoutMs);
    } catch {
      // No scheduler: views load when they are opened.
    }
  };
  return () => {
    if (started) return;
    started = true;
    try {
      scheduler.afterPaint(() => runFrom(0));
    } catch {
      // No scheduler: views load when they are opened.
    }
  };
}

/** Called when a room has mounted; only the first call of the app's life does anything. */
export const preloadLikelyViews = createIdlePreloader(likelyViews.map((view) => view.preload));
