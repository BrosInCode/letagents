import type { DesktopRentalActivityEvent } from "../../ipc-types.js";

import { ACTIVITY_SOURCES, ACTIVITY_VISIBILITIES } from "./enums.js";
import {
  coerceFromList,
  isObject,
  nonNullIso,
  readBool,
  readJsonObject,
  readString,
} from "./primitives.js";

// ---------------------------------------------------------------------------
// Activity event
// ---------------------------------------------------------------------------

export function mapApiActivityEvent(
  raw: unknown,
): DesktopRentalActivityEvent | null {
  if (!isObject(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  return {
    id,
    sessionId: readString(raw, "session_id", "sessionId") ?? "",
    roomIdentifier: readString(raw, "room_id", "roomId", "room_identifier"),
    eventType: readString(raw, "event_type", "eventType") ?? "unknown",
    source: coerceFromList(raw.source, ACTIVITY_SOURCES, "system"),
    verified: readBool(raw, false, "verified"),
    visibility: coerceFromList(
      raw.visibility,
      ACTIVITY_VISIBILITIES,
      "rental_visible",
    ),
    payload: readJsonObject(raw, "payload") ?? {},
    createdAt: nonNullIso(raw.created_at ?? raw.createdAt, new Date().toISOString()),
  };
}
