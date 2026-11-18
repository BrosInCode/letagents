import electron from "electron";
import type { WebContents, WebPreferences } from "electron";

const { app } = electron as typeof import("electron");

/** How a route ties a just-created guest to the lease it claimed. */
export interface WebviewClaim {
  /** Lock the guest and tie it to its lease, before it loads anything. */
  bind(guest: WebContents): void;
}

/**
 * One kind of `<webview>` the app window may show: inline demos or room pages.
 * A route claims only a webview that asks for exactly one of its own leases.
 */
export interface WebviewRoute {
  /**
   * Called for each webview the window asks to attach. A route that owns it
   * locks `webPreferences` and `params` in place and returns its claim; any
   * other route returns null and changes nothing.
   */
  claim(webPreferences: WebPreferences, params: Record<string, string>): WebviewClaim | null;
  /** The guest is bound to one of this route's live leases. */
  owns(guest: WebContents): boolean;
}

/** Routes by app window; each window gets one attach listener for all of them. */
const routesByEmbedder = new WeakMap<WebContents, WebviewRoute[]>();
/** The claim whose webview Electron is creating right now, in this task. */
let attaching: WebviewClaim | null = null;
let guestBindingInstalled = false;

/**
 * Let one more kind of webview into an app window. The first route installs
 * the window's only `will-attach-webview` listener: a webview that no route
 * claims is refused, and a guest that no route owns once attached is closed.
 */
export function addWebviewRoute(embedder: WebContents, route: WebviewRoute): void {
  if (!guestBindingInstalled) {
    app.on("web-contents-created", (_event, contents) => bindAttachingGuest(contents));
    guestBindingInstalled = true;
  }
  const existing = routesByEmbedder.get(embedder);
  if (existing) {
    existing.push(route);
    return;
  }
  const routes = [route];
  routesByEmbedder.set(embedder, routes);
  embedder.on("will-attach-webview", (event, webPreferences, params) => {
    for (const candidate of routes) {
      const claim = candidate.claim(webPreferences, params);
      if (!claim) continue;
      // Electron creates the guest right after this listener returns, in the same
      // task, and reports it to "web-contents-created". A later webview is a later
      // task, so it never finds this claim waiting for it.
      attaching = claim;
      queueMicrotask(() => { attaching = null; });
      return;
    }
    event.preventDefault();
  });
  embedder.on("did-attach-webview", (_event, guest) => {
    if (routes.some((candidate) => candidate.owns(guest))) return;
    // A webview that passed a lease check but is not bound to its lease does not run.
    setImmediate(() => {
      if (!guest.isDestroyed()) guest.close();
    });
  });
}

function bindAttachingGuest(guest: WebContents): void {
  const current = attaching;
  attaching = null;
  if (!current || guest.getType() !== "webview") return;
  current.bind(guest);
}
