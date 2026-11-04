import type { DesktopRoomAccess } from "../../../electron/ipc-types";
import { normalizeRoomIdentifier } from "./sidebar-rooms";

/** Switching windows quickly, or a refusal that repeats, must not reload the room each time. */
export const ROOM_ACCESS_RECHECK_MIN_GAP_MS = 10_000;

export interface StreamRefusalRecheckInput {
  /** The room whose stream the server refused. */
  refusedRoom: string;
  /** The room on screen, by both names the app may know it by. */
  openRooms: ReadonlyArray<string | null | undefined>;
  status: DesktopRoomAccess["status"];
  /** A room check is running. Each check opens the room's stream first, so its own refusal lands here. */
  loading: boolean;
  lastRecheckAt: number;
  now: number;
}

/**
 * Whether a stream refusal should check the room again. Only a room the app
 * shows as open needs it: a room on the join card is already refused, and a
 * check in progress will show the refusal itself. Answering a refusal during
 * a check would start the next check, whose stream is refused again, without end.
 */
export function shouldRecheckAfterStreamRefusal(input: StreamRefusalRecheckInput): boolean {
  if (input.loading || input.status !== "ready") return false;
  if (input.now - input.lastRecheckAt < ROOM_ACCESS_RECHECK_MIN_GAP_MS) return false;
  const refused = normalizeRoomIdentifier(input.refusedRoom);
  return Boolean(refused && input.openRooms.some((room) => normalizeRoomIdentifier(room) === refused));
}
