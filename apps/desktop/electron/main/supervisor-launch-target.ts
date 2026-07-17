import { resolve } from "node:path";

import type { DesktopSupervisorCreateInput } from "../ipc-types/agents.js";

export function assertDesktopSupervisorLaunchTarget(input: DesktopSupervisorCreateInput): void {
  const requestedRoom = normalizeRoomIdentifier(input.roomIdentifier);
  const activeRoom = normalizeRoomIdentifier(input.activeRoomIdentifier);
  const projectRoom = normalizeRoomIdentifier(input.projectRoomIdentifier);
  if (!requestedRoom || !activeRoom || !projectRoom) {
    throw new Error("Supervised launch requires an exact visible room and project context.");
  }
  if (requestedRoom !== activeRoom || requestedRoom !== projectRoom) {
    throw new Error("The visible room changed before Start. Reopen Add Agent from the room you want to use.");
  }

  const requestedRoot = normalizeRootPath(input.repoRootPath);
  const projectRoot = normalizeRootPath(input.projectRootPath);
  if (!requestedRoot || !projectRoot || requestedRoot !== projectRoot) {
    throw new Error("The selected room project changed before Start. Reopen Add Agent and choose the project again.");
  }
}

function normalizeRoomIdentifier(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\/+$/, "") || "";
}

function normalizeRootPath(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : "";
}
