import { app } from "electron";

import { askLinkRendererReady, clearHeldAskLink, holdAskLink } from "./ask-link-inbox.js";
import { createWindow, emitToMainWindow, focusMainWindow, hasOpenWindows } from "./window.js";

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

/** `letagents://ask/<token>` or `https://<host>/ask/<token>` → the link token. */
export function parseAskLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.protocol === "letagents:" ? [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)]
      : parsed.protocol === "https:" ? parsed.pathname.split("/").filter(Boolean) : [];
    return parts.length === 2 && parts[0] === "ask" && TOKEN.test(parts[1]!) ? parts[1]! : null;
  } catch { return null; }
}

function deliver(token: string): void {
  holdAskLink(token);
  if (!app.isReady()) return;
  if (!hasOpenWindows()) createWindow();
  focusMainWindow();
  if (askLinkRendererReady()) { emitToMainWindow("desktop:asks:open-link", token); clearHeldAskLink(); }
}

/** Register before "ready": macOS delivers a launch link through open-url before the app is ready. */
export function registerAskLinks(): void {
  app.setAsDefaultProtocolClient("letagents");
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const token = parseAskLink(url);
    if (token) deliver(token);
  });
}
