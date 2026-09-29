/** An in-process storage adapter, never an HTTP endpoint or cloud credential audience. */
export const LOCAL_ROOM_API_ORIGIN = "letagents-local://rooms";

export function isLocalRoomApi(value) {
  return value === LOCAL_ROOM_API_ORIGIN;
}

/** Preserve the existing HTTP normalization while retaining the explicit local authority. */
export function roomApiOrigin(value) {
  if (isLocalRoomApi(value)) return LOCAL_ROOM_API_ORIGIN;
  return new URL(value).origin;
}
