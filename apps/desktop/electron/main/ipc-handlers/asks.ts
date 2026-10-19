import type { IpcMain } from "electron";

import { askApi, askErrorMessage } from "../../asks/api.js";
import { takePendingAskLink } from "../ask-links.js";
import { askGiveCoordinator, giftPermissionProfile } from "../../asks/give-coordinator.js";
import type { DesktopAskResult, DesktopCreateAgentAskInput, DesktopGiveAgentInput } from "../../ipc-types/asks.js";

/** Every ask call answers with a value or one sentence to show (spec rule 4). */
async function result<T>(run: () => Promise<T>): Promise<DesktopAskResult<T>> {
  try { return { ok: true, value: await run() }; }
  catch (error) { return { ok: false, error: askErrorMessage(error) }; }
}

const text = (value: unknown) => typeof value === "string" ? value : "";

export function registerDesktopAskIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle("desktop:asks:list-models", () => result(() => askApi.models()));
  targetIpcMain.handle("desktop:asks:create", (_event, input: DesktopCreateAgentAskInput) => result(() => askApi.create(input)));
  targetIpcMain.handle("desktop:asks:list-room", (_event, roomId: unknown) => result(() => askApi.listRoom(text(roomId))));
  targetIpcMain.handle("desktop:asks:list-mine", () => result(() => askApi.listMine()));
  targetIpcMain.handle("desktop:asks:act", (_event, askId: unknown, action: unknown) => result(async () => {
    if (action !== "cancel" && action !== "accept" && action !== "decline" && action !== "remove") throw new Error("invalid action");
    return askApi.act(text(askId), action);
  }));
  targetIpcMain.handle("desktop:asks:workspace", (_event, askId: unknown) => result(() => askApi.workspace(text(askId))));
  targetIpcMain.handle("desktop:asks:decide", (_event, askId: unknown, proposalId: unknown, approve: unknown) =>
    result(() => askApi.decide(text(askId), text(proposalId), approve === true)));
  targetIpcMain.handle("desktop:asks:preview", (_event, token: unknown) => result(() => askApi.preview(text(token))));
  targetIpcMain.handle("desktop:asks:can-give", (_event, providerId: unknown) => giftPermissionProfile(text(providerId)) !== null);
  targetIpcMain.handle("desktop:asks:give", (_event, input: DesktopGiveAgentInput) => result(() => askGiveCoordinator.give(input)));
  targetIpcMain.handle("desktop:asks:cant-help", (_event, token: unknown) => result(() => askGiveCoordinator.cantHelp(text(token))));
  targetIpcMain.handle("desktop:asks:take-pending-link", () => takePendingAskLink());
  // Resume counting any gift still running from before a restart.
  askGiveCoordinator.startWatching();
}
