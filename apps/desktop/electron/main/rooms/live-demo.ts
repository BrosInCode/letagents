import type { WebContents } from "electron";

import { watchInlineHtmlDemoPointer } from "../attachments/html-demo-inline.js";
import { readStoredAuth } from "../auth.js";
import { apiUrl } from "../paths.js";
import { isDesktopSmokeCheck } from "../smoke.js";
import { emitToMainWindow } from "../window.js";
import { connectLiveDemoSocket, LiveDemoClient } from "./live-demo-client.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

export const LIVE_DEMO_EVENT_CHANNEL = "desktop:room:live-demo-event";

const liveDemos = new LiveDemoClient({
  apiUrl,
  connect: connectLiveDemoSocket,
  cloudRoom: async (identifier) => {
    if (isDesktopSmokeCheck()) return null;
    const storage = await resolveLocalAwareRoomStorageMode(identifier);
    return storage.effectiveMode === "local" ? null : cloudRoomIdentifierForStorage(storage, identifier);
  },
  // The app's own session; the server takes no agent or worker bearer here.
  token: async () => (await readStoredAuth()).token,
  emit: (event) => emitToMainWindow(LIVE_DEMO_EVENT_CHANNEL, event),
  watchPointer: watchInlineHtmlDemoPointer,
});

const watchedOwners = new WeakSet<WebContents>();

/** A reloaded or closed chat page joins again from nothing, so its old joins end with it. */
export function watchLiveDemoOwner(contents: WebContents): void {
  if (watchedOwners.has(contents)) return;
  watchedOwners.add(contents);
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) liveDemos.leaveAll();
  });
  contents.on("render-process-gone", () => liveDemos.leaveAll());
  contents.once("destroyed", () => liveDemos.leaveAll());
}

export function joinLiveDemo(room: unknown, demoKey: unknown, leaseUrl: unknown): void {
  liveDemos.join(room, demoKey, leaseUrl);
}

export function leaveLiveDemo(room: unknown, demoKey: unknown): void {
  liveDemos.leave(room, demoKey);
}

export function sendLiveDemoFrame(room: unknown, frame: unknown): void {
  liveDemos.send(room, frame);
}

/** After a sign-in, a sign-out or an account change: every room connects again with the current token. */
export function reconnectLiveDemos(): void {
  liveDemos.reconnectAll();
}
