import type { IpcMain } from "electron";

import type {
  DesktopRepoRoomSelection,
  DesktopRepoWorktreeResult,
  RepoStatus,
} from "../../ipc-types.js";
import { buildRepoStatus } from "../../repo-status.js";
import { workspaceRoot } from "../paths.js";
import { startRepoStatusWatch, stopRepoStatusWatch } from "../repo-status-watch.js";
import { createRepoRoomWorktree, openRepoRoomFromPath, pickRepoRoom } from "../rooms.js";

export function registerDesktopRepoIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle(
    "desktop:repos:get-status",
    async (_event, rootPath?: string | null): Promise<RepoStatus> => buildRepoStatus(rootPath || workspaceRoot),
  );
  targetIpcMain.handle(
    "desktop:repos:start-status-watch",
    async (_event, rootPath?: string | null): Promise<RepoStatus> => startRepoStatusWatch(rootPath || workspaceRoot),
  );
  targetIpcMain.handle(
    "desktop:repos:stop-status-watch",
    async (): Promise<void> => stopRepoStatusWatch(),
  );
  targetIpcMain.handle(
    "desktop:repos:pick-room",
    async (): Promise<DesktopRepoRoomSelection> => pickRepoRoom(),
  );
  targetIpcMain.handle(
    "desktop:repos:open-room",
    async (_event, folderPath?: string | null): Promise<DesktopRepoRoomSelection> =>
      openRepoRoomFromPath(folderPath || ""),
  );
  targetIpcMain.handle(
    "desktop:repos:create-worktree",
    async (
      _event,
      repoRoot?: string | null,
      branch?: string | null,
    ): Promise<DesktopRepoWorktreeResult> =>
      createRepoRoomWorktree(repoRoot || "", branch || ""),
  );
}
