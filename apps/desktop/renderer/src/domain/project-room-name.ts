import type { DesktopGitRoomInfo } from "../../../electron/ipc-types";
import { repositoryRoomName } from "../../../../../shared/project-room-name.mjs";
import { localPathBasename } from "./local-path";

/** Use the server's room title (including intentional renames), then project identity. */
export function projectRoomName(input: {
  roomIdentifier?: string | null;
  gitRoom?: DesktopGitRoomInfo | null;
  rootPath?: string | null;
  fallback?: string | null;
}): string {
  const title = input.fallback?.trim();
  return (title && title.toLowerCase() !== input.roomIdentifier?.trim().toLowerCase() ? title : null)
    || input.gitRoom?.repository.name?.trim()
    || repositoryRoomName(input.roomIdentifier)
    || localPathBasename(input.rootPath)
    || input.roomIdentifier
    || "Project";
}
