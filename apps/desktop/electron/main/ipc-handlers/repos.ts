import type { IpcMain } from "electron";

import type {
  DesktopRepoRoomSelection,
  DesktopRepoWorktreeResult,
  DesktopLegacyProjectBindingCandidate,
  DesktopProjectBinding,
  DesktopProjectBindingContext,
  DesktopProjectConnectionResult,
  RepoStatus,
} from "../../ipc-types.js";
import { buildRepoStatus } from "../../repo-status.js";
import { workspaceRoot } from "../paths.js";
import { startRepoStatusWatch, stopRepoStatusWatch } from "../repo-status-watch.js";
import { connectProjectToRoom, createRepoRoomWorktree, openRepoRoomFromPath, pickRepoRoom } from "../rooms.js";
import {
  listProjectBindings,
  migrateLegacyProjectBindings,
} from "../project-bindings-store.js";

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
    "desktop:repos:list-project-bindings",
    async (): Promise<DesktopProjectBinding[]> => listProjectBindings(),
  );
  targetIpcMain.handle(
    "desktop:repos:migrate-project-bindings",
    async (
      _event,
      candidates?: DesktopLegacyProjectBindingCandidate[] | null,
    ): Promise<DesktopProjectBinding[]> =>
      migrateLegacyProjectBindings(Array.isArray(candidates) ? candidates : []),
  );
  targetIpcMain.handle(
    "desktop:repos:connect-project",
    async (
      _event,
      context?: DesktopProjectBindingContext | null,
    ): Promise<DesktopProjectConnectionResult> =>
      connectProjectToRoom(context || {}),
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
