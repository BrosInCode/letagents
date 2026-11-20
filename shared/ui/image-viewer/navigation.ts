import type { RoomImage } from './types'

/** The id to open, or null when the room has no such image. */
export function openableImageId(images: readonly RoomImage[], imageId: string): string | null {
  return images.some((image) => image.id === imageId) ? imageId : null
}

/** The image id one step away. Previous and next wrap around. */
export function shiftedImageId(
  images: readonly RoomImage[],
  activeImageId: string | null,
  direction: 1 | -1,
): string | null {
  if (!activeImageId) return null
  const count = images.length
  if (count < 2) return activeImageId
  const currentIndex = Math.max(0, images.findIndex((image) => image.id === activeImageId))
  return images[(currentIndex + direction + count) % count]?.id || null
}

/** The open image after the room's images change: null once it has left. */
export function keptImageId(images: readonly RoomImage[], activeImageId: string | null): string | null {
  return activeImageId && images.some((image) => image.id === activeImageId) ? activeImageId : null
}
