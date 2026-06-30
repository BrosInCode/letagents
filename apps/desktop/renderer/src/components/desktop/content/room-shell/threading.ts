import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import { threadParentId } from "../room-chat/thread-utils";

export function isThreadReplyMessage(message: DesktopRoomMessage): boolean {
  return Boolean(threadParentId(message));
}
