// One rule for "this room lives only on this device", used by the desktop main
// process and the renderer so they always agree.

const DEVICE_LOCAL_PREFIX = /^local[_-]|^git-room:local:/i;
const FOLDER_DERIVED_ROOM_ID = /^local-[a-z0-9-]+-[a-f0-9]{10}$/;

/** The id shape the desktop gives a room it derives from a project folder. */
export function isFolderDerivedLocalRoomId(identifier) {
  return FOLDER_DERIVED_ROOM_ID.test(String(identifier ?? "").trim());
}

/**
 * Whether an id is device-local. Every local prefix is local, with one
 * exception: a folder-derived `local-<slug>-<10 hex>` id is cloud when
 * `cloudProven` is true. The caller sets it when the server lists the room for
 * the signed-in account AND this device has no local record (archived counts)
 * with exactly that id. An unproven id stays local, as before.
 */
export function isDeviceLocalRoomId(identifier, cloudProven = false) {
  const value = String(identifier ?? "").trim();
  if (!DEVICE_LOCAL_PREFIX.test(value)) return false;
  return !(cloudProven && FOLDER_DERIVED_ROOM_ID.test(value));
}

/** The text of the snapshot a folder-derived room gets while the account's room list is not known yet. */
export const SERVER_LIST_PENDING_MESSAGE = "Waiting for your room list. LetAgents will try this room again.";
