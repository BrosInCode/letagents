import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { letagentsHomePath } from "../../../shared/letagents-home.mjs";

// This file is provider-runtime/paths.ts in the source and
// dist-provider-runtime/paths.js in the build and in the packaged app. Both
// folders are one level below the desktop root.
export const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const workspaceRoot = join(desktopRoot, "..", "..");
export const rendererDistPath = join(
  desktopRoot,
  "dist-renderer",
  "index.html",
);
export const devServerUrl =
  process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim() || null;
export const apiUrl =
  process.env.LETAGENTS_API_URL?.trim() || "https://letagents.chat";
export const attachmentProtocolScheme = "letagents-attachment";
/** Served only inside the HTML demo session; the app window cannot load it. */
export const htmlDemoProtocolScheme = "letagents-demo";
/** Served only inside the room page session, a sibling of the demo scheme. */
export const pageProtocolScheme = "letagents-page";
export const roomMessageHistoryPageSize = 150;

export function getLetAgentsLocalStatePath(): string {
  return process.env.LETAGENTS_STATE_PATH?.trim() ||
    letagentsHomePath("mcp-state.json");
}
