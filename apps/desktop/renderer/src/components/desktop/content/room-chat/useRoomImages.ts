import { computed, type Ref } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import type { RoomImage } from "../../../../../../../../shared/ui/image-viewer/types";
import { useImageViewer } from "../../../../../../../../shared/ui/image-viewer/useImageViewer";
import {
  attachmentHref,
  attachmentKey,
  attachmentMeta,
  attachmentName,
  isImageAttachment,
} from "../desktop-chat-message/attachments";
import { displaySender } from "./message-format";

export function useRoomImages(messages: Readonly<Ref<DesktopRoomMessage[]>>) {
  const roomImages = computed<RoomImage[]>(() => {
    const images: RoomImage[] = [];
    for (const message of messages.value) {
      for (const attachment of message.attachments || []) {
        if (!isImageAttachment(attachment)) continue;
        images.push({
          id: `${message.id}:${attachmentKey(attachment)}`,
          href: attachmentHref(attachment),
          name: attachmentName(attachment),
          meta: attachmentMeta(attachment),
          sender: displaySender(message.sender),
          timestamp: message.timestamp,
        });
      }
    }
    return images;
  });
  return { roomImages, ...useImageViewer(roomImages) };
}
