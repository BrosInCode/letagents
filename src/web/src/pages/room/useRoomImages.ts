import { computed, type Ref } from 'vue'

import { collectMessageImageAttachments } from '@/components/room/messageAttachments'
import { parseAgentIdentity } from '@/composables/room/identity'
import type { RoomMessage } from '@/composables/useRoom'
import type { RoomImage } from '../../../../../shared/ui/image-viewer/types'
import { useImageViewer } from '../../../../../shared/ui/image-viewer/useImageViewer'

export function useRoomImages(messages: Readonly<Ref<readonly RoomMessage[]>>) {
  const roomImages = computed<RoomImage[]>(() =>
    collectMessageImageAttachments(messages.value).map((image) => ({
      id: image.id,
      href: image.href,
      name: image.name,
      meta: image.metaLabel,
      sender: parseAgentIdentity(image.sender).displayName,
      timestamp: image.timestamp,
    })),
  )
  return { roomImages, ...useImageViewer(roomImages) }
}
