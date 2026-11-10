import { defineComponent, h, onBeforeUnmount, ref, shallowRef, watch, type Component, type VNodeChild } from "vue";

// Views that the first paint of a room does not need. Each one is its own chunk,
// so the entry chunk holds only the room chat path. After the first room has
// painted and the main thread is idle, preloadLikelyViews() loads them one at a
// time, so a later click renders at once, exactly as with a static import.

export interface LazyView<T extends Component = Component> {
  /** Use it like the view itself: props, listeners and slots pass through. */
  component: T;
  /** Loads and evaluates the chunk. Never rejects. */
  preload: () => Promise<void>;
  /** True once the chunk has loaded. */
  loaded: () => boolean;
}

export interface LazyViewOptions {
  /** Names the view in the failure message, for example "Settings". */
  label: string;
  /** Drawn while the chunk loads, and under the failure message. Nothing by default. */
  loading?: () => VNodeChild;
  /** Whether the view is on screen. A view mounted while closed shows no failure. */
  visible?: (attrs: Record<string, unknown>) => boolean;
  /** Waits before the automatic retries of a mounted view; after the last one it shows the failure. */
  retryDelaysMs?: readonly number[];
}

export const LAZY_VIEW_RETRY_DELAYS_MS: readonly number[] = [400, 1_600];

function moduleDefault<T>(loaded: { default: T } | T): T {
  return loaded !== null && typeof loaded === "object" && "default" in loaded
    ? (loaded as { default: T }).default
    : loaded as T;
}

export function lazyView<T extends Component>(
  loader: () => Promise<{ default: T }>,
  options: LazyViewOptions,
): LazyView<T> {
  // Shared by every mounted copy: once any load succeeds (a mount, a retry or the
  // idle preload), each mounted copy renders the view. A failed request is forgotten.
  const resolved = shallowRef<T | null>(null);
  let pending: Promise<T> | null = null;
  const load = (): Promise<T> => {
    if (resolved.value) return Promise.resolve(resolved.value);
    return pending ??= loader().then((loaded) => {
      const view = moduleDefault(loaded);
      resolved.value = view;
      return view;
    }, (error: unknown) => {
      pending = null;
      throw error;
    });
  };
  const retryDelaysMs = options.retryDelaysMs ?? LAZY_VIEW_RETRY_DELAYS_MS;
  const visible = options.visible ?? (() => true);

  const wrapper = defineComponent({
    name: `Lazy${options.label.replace(/\W/g, "")}`,
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      const failed = ref(false);
      let attempt = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unmounted = false;
      const tryLoad = (): void => {
        if (resolved.value || unmounted) return;
        load().catch(() => {
          if (unmounted || resolved.value) return;
          const delay = retryDelaysMs[attempt];
          attempt += 1;
          if (delay === undefined) {
            failed.value = true;
            return;
          }
          timer = setTimeout(() => {
            timer = null;
            tryLoad();
          }, delay);
        });
      };
      const retry = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        attempt = 0;
        failed.value = false;
        tryLoad();
      };
      // A view mounted while closed loads at mount; if its chunk failed for good,
      // opening it tries again.
      watch(() => visible(attrs), (shown) => {
        if (shown && failed.value) retry();
      });
      tryLoad();
      onBeforeUnmount(() => {
        unmounted = true;
        if (timer) clearTimeout(timer);
      });
      return () => {
        const view = resolved.value;
        if (view) return h(view as Component, { ...attrs }, slots);
        const placeholder = options.loading?.() ?? null;
        if (!failed.value || !visible(attrs)) return placeholder;
        // The house error toast (action-toasts.css), fixed at the bottom left.
        return [placeholder, h("div", { class: "desktop-action-toasts", role: "alert" }, [
          h("button", {
            type: "button",
            class: "desktop-action-toast",
            "data-state": "error",
            "data-testid": "lazy-view-failed",
            onClick: retry,
          }, `${options.label} did not load. Click to try again, or restart LetAgents.`),
        ])];
      };
    },
  });

  return {
    component: wrapper as unknown as T,
    async preload() {
      try {
        await load();
      } catch {
        // The view loads again when it is opened.
      }
    },
    loaded: () => resolved.value !== null,
  };
}

export const SettingsViewLazy = lazyView(() => import("./components/desktop/content/SettingsView.vue"), { label: "Settings" });
export const InboxViewLazy = lazyView(() => import("./components/desktop/content/InboxView.vue"), { label: "Inbox" });
export const MyWorkViewLazy = lazyView(() => import("./components/desktop/content/MyWorkView.vue"), { label: "My work" });
export const CompanyHomeLazy = lazyView(() => import("./components/desktop/content/CompanyHome.vue"), { label: "Company home" });
export const DesktopNewRoomModalLazy = lazyView(() => import("./components/desktop/content/DesktopNewRoomModal.vue"), { label: "New room" });
export const AddAgentModalLazy = lazyView(() => import("./components/desktop/content/AddAgentModal.vue"), {
  label: "Add agent",
  // It stays mounted while closed, as before, so its open animation, focus and
  // first-open provider choice behave as they did. Its chunk therefore loads with
  // the first room; a failure shows only when the window is opened.
  visible: (attrs) => attrs.open === true,
});
export const AgentInspectorHostLazy = lazyView(() => import("./components/desktop/content/agent-inspector/AgentInspectorHost.vue"), { label: "Agent details" });
export const RoomBoardViewLazy = lazyView(() => import("./components/desktop/content/RoomBoardView.vue"), { label: "Board" });
export const RoomActivityTabViewLazy = lazyView(() => import("./components/desktop/content/RoomActivityTabView.vue"), { label: "Activity" });
export const RoomEventsViewLazy = lazyView(() => import("./components/desktop/content/RoomEventsView.vue"), { label: "Events" });
export const RoomMemoryViewLazy = lazyView(() => import("./components/desktop/content/RoomMemoryView.vue"), { label: "Memory" });
export const RoomDetailsViewLazy = lazyView(() => import("./components/desktop/content/RoomDetailsView.vue"), { label: "Rooms" });

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
