import { ref, watch, type Ref } from 'vue'
import { keptImageId, openableImageId, shiftedImageId } from './navigation'
import type { RoomImage } from './types'

/**
 * Which image the viewer shows. Previous and next wrap around. The viewer
 * closes on its own when the image it shows leaves the list.
 */
export function useImageViewer(images: Readonly<Ref<readonly RoomImage[]>>) {
  const activeImageId = ref<string | null>(null)

  watch(images, (next) => {
    activeImageId.value = keptImageId(next, activeImageId.value)
  })

  return {
    activeImageId,
    openImageViewer: (imageId: string) => {
      const opened = openableImageId(images.value, imageId)
      if (opened) activeImageId.value = opened
    },
    closeImageViewer: () => {
      activeImageId.value = null
    },
    showNextImage: () => {
      activeImageId.value = shiftedImageId(images.value, activeImageId.value, 1)
    },
    showPreviousImage: () => {
      activeImageId.value = shiftedImageId(images.value, activeImageId.value, -1)
    },
  }
}
