import { computed, ref, type Ref } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import type { DesktopMessageImage } from "../DesktopImageViewerModal.vue";
import {
  attachmentHref,
  attachmentKey,
  attachmentMeta,
  attachmentName,
  isImageAttachment,
} from "./attachment-utils";
import { displaySender, formatDateTime } from "./message-format";

export function useRoomImages(messages: Readonly<Ref<DesktopRoomMessage[]>>) {
  const activeImageId = ref<string | null>(null);

  const roomImages = computed<DesktopMessageImage[]>(() => {
    const images: DesktopMessageImage[] = [];
    for (const message of messages.value) {
      for (const attachment of message.attachments || []) {
        if (!isImageAttachment(attachment)) continue;
        images.push({
          id: `${message.id}:${attachmentKey(attachment)}`,
          href: attachmentHref(attachment),
          name: attachmentName(attachment),
          meta: attachmentMeta(attachment),
          sender: displaySender(message.sender),
          time: formatDateTime(message.timestamp),
        });
      }
    }
    return images;
  });

  function openImageViewer(imageId: string): void {
    if (!roomImages.value.some((image) => image.id === imageId)) return;
    activeImageId.value = imageId;
  }

  function shiftImage(direction: 1 | -1): void {
    if (!roomImages.value.length || !activeImageId.value) return;
    const currentIndex = Math.max(0, roomImages.value.findIndex((image) => image.id === activeImageId.value));
    const nextIndex = (currentIndex + direction + roomImages.value.length) % roomImages.value.length;
    activeImageId.value = roomImages.value[nextIndex].id;
  }

  return {
    activeImageId,
    roomImages,
    openImageViewer,
    shiftImage,
  };
}
