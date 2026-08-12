export const ROOM_EVENT_CHANNEL = "letagents_room_events";
export const LISTEN_RECONNECT_DELAY_MS = 5_000;
// Leaves headroom under the 8000-byte NOTIFY limit for the envelope fields.
export const MAX_INLINE_DATA_BYTES = 7_000;
export const MAX_NOTIFICATION_ORIGINS = 1_024;
export const MAX_QUEUED_NOTIFICATIONS_PER_ORIGIN = 128;
export const MAX_OUTSTANDING_NOTIFICATIONS = 1_024;
export const NOTIFICATION_QUEUE_DEADLINE_MS = 10_000;
export const BRIDGE_PUBLISH_STATEMENT_TIMEOUT_MS = 5_000;
export const BRIDGE_CLIENT_ACQUIRE_TIMEOUT_MS = 2_000;
export const MAX_BRIDGE_ROOM_ID_BYTES = 1_024;
