import { createRequire } from "node:module";

import { letagentsUserAgent } from "../../../../shared/client-user-agent.mjs";

/**
 * The desktop app's version, from the package.json two folders above this
 * file (in the source tree, in the build output and in the packaged app).
 * Read here and not from Electron's `app`, so code that runs without Electron
 * (the unit tests of the API helper) gets the same value.
 */
function desktopVersion(): string {
  try {
    const manifest = createRequire(import.meta.url)("../../package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    return "";
  }
}

/** Sent with every request of the desktop app to the room server, for example `LetAgents-Desktop/0.1.140 (darwin; arm64)`. */
export const DESKTOP_USER_AGENT = letagentsUserAgent("Desktop", desktopVersion());
