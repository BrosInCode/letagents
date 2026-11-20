/**
 * One image in a room's image viewer. Each app builds these from its own
 * message model; the viewer only needs what it shows.
 */
export interface RoomImage {
  /** `${messageId}:${attachmentKey}`, the id a message's image button opens. */
  id: string
  href: string
  name: string
  /** File type and size, e.g. "image/png · 120 KB". */
  meta: string
  /** Display name of who sent it. */
  sender: string
  /** ISO timestamp of the message. */
  timestamp: string
}
