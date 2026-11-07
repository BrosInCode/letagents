import { app, autoUpdater } from "electron";

import { parseDesktopRoomLink, type DesktopRoomLink } from "../../../../shared/room-app-links.mjs";
import {
  askLinkRendererGone,
  askLinkRendererReady,
  clearHeldAskLink,
  clearHeldRoomLink,
  holdAskLink,
  holdRoomLink,
} from "./ask-link-inbox.js";
import { createWindow, emitToMainWindow, focusMainWindow, hasOpenWindows } from "./window.js";

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

/** What a `letagents://` link asks the app to open. */
export type DesktopLinkTarget =
  | { kind: "ask"; token: string }
  | { kind: "room"; room: DesktopRoomLink };

/** An ask link or a room link, from the app scheme or the web; null for anything else. */
export function parseDesktopLink(url: string): DesktopLinkTarget | null {
  const token = parseAskLink(url);
  if (token) return { kind: "ask", token };
  const room = parseDesktopRoomLink(url);
  return room ? { kind: "room", room } : null;
}

/** Windows and Linux pass the link as a launch argument instead of an open-url event. */
export function desktopLinkFromArgv(argv: readonly string[]): DesktopLinkTarget | null {
  for (const arg of argv) { const target = parseDesktopLink(arg); if (target) return target; }
  return null;
}

/** `letagents://ask/<token>` or `https://<host>/ask/<token>` → the link token. */
export function parseAskLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.protocol === "letagents:" ? [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)]
      : parsed.protocol === "https:" ? parsed.pathname.split("/").filter(Boolean) : [];
    return parts.length === 2 && parts[0] === "ask" && TOKEN.test(parts[1]!) ? parts[1]! : null;
  } catch { return null; }
}

/** Windows and Linux pass the link as a launch argument instead of an open-url event. */
export function askLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) { const token = parseAskLink(arg); if (token) return token; }
  return null;
}

function deliver(target: DesktopLinkTarget): void {
  if (target.kind === "ask") holdAskLink(target.token);
  else holdRoomLink(target.room);
  if (!app.isReady()) return;
  // A fresh window's renderer takes the link when it loads; emitting now would be lost.
  if (!hasOpenWindows()) { askLinkRendererGone(); createWindow(); }
  focusMainWindow();
  if (!askLinkRendererReady()) return;
  if (target.kind === "ask") {
    emitToMainWindow("desktop:asks:open-link", target.token);
    clearHeldAskLink();
  } else {
    emitToMainWindow("desktop:links:open-room", target.room);
    clearHeldRoomLink();
  }
}

let quitPaused = false;
let installingUpdate = false;

/**
 * Gifts are watched only while the app runs, but their agents live in the
 * detached daemon. So a quit pauses them first (the room sees them go offline)
 * instead of leaving them running unwatched; the next start resumes them.
 * An update install is never held up.
 */
function pauseGiftsOnQuit(): void {
  autoUpdater.on("before-quit-for-update", () => { installingUpdate = true; });
  app.on("before-quit", (event) => {
    if (quitPaused || installingUpdate) return;
    event.preventDefault();
    quitPaused = true;
    const pause = import("../asks/give-coordinator.js").then(({ askGiveCoordinator }) => askGiveCoordinator.pauseForQuit());
    void Promise.race([pause, new Promise(resolve => setTimeout(resolve, 3_000))]).catch(() => undefined).finally(() => app.quit());
  });
}

/**
 * Register before "ready": macOS delivers a launch link through open-url before
 * the app is ready. Ask links and room links share one handler.
 */
export function registerAskLinks(): void {
  pauseGiftsOnQuit();
  // Dev and smoke runs must not take the letagents:// scheme from the installed app.
  if (app.isPackaged) app.setAsDefaultProtocolClient("letagents");
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const target = parseDesktopLink(url);
    if (target) deliver(target);
  });
}

/**
 * macOS keeps one instance and sends open-url. Elsewhere a link starts a second
 * instance: only the first runs the app, and a later one must exit before
 * starting anything, its link handed over through second-instance.
 */
export function claimDesktopInstance(): boolean {
  if (process.platform === "darwin") return true;
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", (_event, argv) => {
    const target = desktopLinkFromArgv(argv);
    if (target) deliver(target);
    else if (app.isReady()) { if (!hasOpenWindows()) createWindow(); focusMainWindow(); }
  });
  const launched = desktopLinkFromArgv(process.argv);
  if (launched) deliver(launched);
  return true;
}
