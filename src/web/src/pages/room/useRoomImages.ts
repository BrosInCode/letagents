import { computed, ref, watch, type Ref } from 'vue'

import { collectMessageImageAttachments } from '@/components/room/messageAttachments'
import type { RoomMessage } from '@/composables/useRoom'

export function useRoomImages(messages: Readonly<Ref<readonly RoomMessage[]>>) {
  const activeImageId = ref<string | null>(null)
  const roomImages = computed(() => collectMessageImageAttachments(messages.value))
  const activeImageIndex = computed(() =>
    activeImageId.value
      ? roomImages.value.findIndex((image) => image.id === activeImageId.value)
      : -1
  )

  function openImageViewer(imageId: string) {
    if (!roomImages.value.some((image) => image.id === imageId)) return
    activeImageId.value = imageId
  }

  function closeImageViewer() {
    activeImageId.value = null
  }

  function shiftImage(direction: 1 | -1) {
    if (!roomImages.value.length) return
    const currentIndex = activeImageIndex.value >= 0 ? activeImageIndex.value : 0
    const nextIndex = (currentIndex + direction + roomImages.value.length) % roomImages.value.length
    activeImageId.value = roomImages.value[nextIndex]?.id || null
  }

  function showNextImage() {
    if (roomImages.value.length < 2) return
    shiftImage(1)
  }

  function showPreviousImage() {
    if (roomImages.value.length < 2) return
    shiftImage(-1)
  }

  watch(roomImages, (images) => {
    if (!activeImageId.value) return
    if (!images.some((image) => image.id === activeImageId.value)) {
      closeImageViewer()
    }
  })

  return {
    activeImageId,
    roomImages,
    openImageViewer,
    closeImageViewer,
    showNextImage,
    showPreviousImage,
  }
}
