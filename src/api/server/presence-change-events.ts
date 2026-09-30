import { EventEmitter } from "node:events";

/**
 * Rooms where an agent started or stopped working. Raised from the database
 * trigger's NOTIFY, which every API instance hears for itself, so this
 * emitter is deliberately local and never relayed over the room event bridge.
 * Carries only the room id: listeners re-read presence through the database.
 */
export const presenceChangeEvents = new EventEmitter();
presenceChangeEvents.setMaxListeners(0);

export const PRESENCE_CHANGED = "presence:changed";
/** The listener reconnected; changes committed while it was away were not heard. */
export const PRESENCE_RESYNC = "presence:resync";
