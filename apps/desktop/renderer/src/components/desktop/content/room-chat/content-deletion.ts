import type { InjectionKey } from "vue";
import type { DesktopContentDeletion } from "../../../../../../electron/ipc-types/api";

export const deleteRoomContentKey: InjectionKey<(input: DesktopContentDeletion) => Promise<void>> = Symbol("deleteRoomContent");
