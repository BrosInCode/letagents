import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const electronMainDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const desktopRoot = join(electronMainDir, "..");
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
export const roomMessageHistoryPageSize = 150;
export const letagentsLocalStatePath =
  process.env.LETAGENTS_STATE_PATH?.trim() ||
  join(homedir(), ".letagents", "mcp-state.json");
