import type { DesktopInlineHtmlDemoEvent } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index";

type InlineDemoEventHandler = (event: DesktopInlineHtmlDemoEvent) => void;

export interface InlineDemoEvents {
  /**
   * Sends the events of one lease URL to `handler`. The returned function stops
   * that and is safe to call more than once.
   */
  register(url: string, handler: InlineDemoEventHandler): () => void;
}

/**
 * One listener on main's event channel serves every card in the window, so a
 * room with many demos does not add one `ipcRenderer` listener per card. It
 * listens only while some card holds a lease.
 */
export function createInlineDemoEvents(
  subscribe: (listener: InlineDemoEventHandler) => (() => void) | null | undefined,
): InlineDemoEvents {
  const handlers = new Map<string, InlineDemoEventHandler>();
  let unsubscribe: (() => void) | null = null;

  return {
    register(url, handler) {
      handlers.set(url, handler);
      unsubscribe ??= subscribe((event) => handlers.get(event.url)?.(event)) ?? null;
      return () => {
        // A newer card may hold the URL now.
        if (handlers.get(url) !== handler) return;
        handlers.delete(url);
        if (handlers.size === 0) {
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },
  };
}

export const inlineDemoEvents = createInlineDemoEvents(
  (listener) => desktopIpc.room?.onInlineHtmlDemoEvent?.(listener),
);
