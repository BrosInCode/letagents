import { computed, type Ref } from 'vue'

import { collectMessageImageAttachments } from '@/components/room/messageAttachments'
import type { RoomMessage } from '@/composables/useRoom'
import { useImageViewer } from '../../../../../shared/ui/image-viewer/useImageViewer'

export function useRoomImages(messages: Readonly<Ref<readonly RoomMessage[]>>) {
  const roomImages = computed(() => collectMessageImageAttachments(messages.value))
  return { roomImages, ...useImageViewer(roomImages) }
}
