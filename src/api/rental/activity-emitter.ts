/**
 * Rental Activity Emitter — append activity events to the
 * rental_activity_events table.
 *
 * Features:
 * - Auto-verification for tool-mediated events
 * - Default visibility resolution per event type
 * - Type-safe event emission
 *
 * Part of PR p1.2b.
 */

import { EventEmitter } from "node:events";

import { db } from "../db/client.js";
import { rental_activity_events } from "../db/schema.js";
import {
  type RentalActivityEventType,
  type RentalActivitySource,
  type RentalActivityVisibility,
  AUTO_VERIFIED_EVENT_TYPES,
  UNVERIFIED_EVENT_TYPES,
  getDefaultVisibility,
} from "./activity-event-types.js";

export interface EmitActivityEventInput {
  sessionId: string;
  roomId: string;
  eventType: RentalActivityEventType;
  source: RentalActivitySource;
  payload: Record<string, unknown>;
  /** Override auto-verification. If omitted, uses the auto-verified set. */
  verified?: boolean;
  /** Override default visibility. If omitted, uses getDefaultVisibility(). */
  visibility?: RentalActivityVisibility;
}

export interface ActivityEvent {
  id: string;
  session_id: string;
  room_id: string;
  event_type: string;
  source: string;
  verified: boolean;
  visibility: string;
  payload: unknown;
  created_at: Date;
}

export interface RentalActivityCreatedEvent {
  activity: ActivityEvent;
}

export const rentalActivityEvents = new EventEmitter();

function generateEventId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `rev_${timestamp}_${random}`;
}

/**
 * Emit a single activity event into the rental_activity_events table.
 *
 * Verification logic:
 * - Events in AUTO_VERIFIED_EVENT_TYPES are verified=true unless explicitly overridden
 * - Events in UNVERIFIED_EVENT_TYPES (agent.note) are verified=false unless explicitly overridden
 * - If verified is explicitly passed, that value is used
 *
 * Visibility logic:
 * - If visibility is explicitly passed, that value is used
 * - Otherwise, getDefaultVisibility() determines the default
 */
export async function emitActivityEvent(
  input: EmitActivityEventInput
): Promise<ActivityEvent> {
  const {
    sessionId,
    roomId,
    eventType,
    source,
    payload,
  } = input;

  // Resolve verification
  let verified: boolean;
  if (input.verified !== undefined) {
    verified = input.verified;
  } else if (UNVERIFIED_EVENT_TYPES.has(eventType)) {
    verified = false;
  } else if (AUTO_VERIFIED_EVENT_TYPES.has(eventType)) {
    verified = true;
  } else {
    verified = false;
  }

  // Resolve visibility
  const visibility = input.visibility ?? getDefaultVisibility(eventType);

  const id = generateEventId();

  const [row] = await db
    .insert(rental_activity_events)
    .values({
      id,
      session_id: sessionId,
      room_id: roomId,
      event_type: eventType,
      source,
      verified,
      visibility,
      payload,
    })
    .returning();

  rentalActivityEvents.emit("activity:created", { activity: row } satisfies RentalActivityCreatedEvent);
  return row;
}

/**
 * Emit multiple activity events in a single batch insert.
 * Uses the same verification/visibility resolution logic as emitActivityEvent.
 */
export async function emitActivityEvents(
  events: EmitActivityEventInput[]
): Promise<ActivityEvent[]> {
  if (events.length === 0) return [];

  const values = events.map((input) => {
    let verified: boolean;
    if (input.verified !== undefined) {
      verified = input.verified;
    } else if (UNVERIFIED_EVENT_TYPES.has(input.eventType)) {
      verified = false;
    } else if (AUTO_VERIFIED_EVENT_TYPES.has(input.eventType)) {
      verified = true;
    } else {
      verified = false;
    }

    const visibility =
      input.visibility ?? getDefaultVisibility(input.eventType);

    return {
      id: generateEventId(),
      session_id: input.sessionId,
      room_id: input.roomId,
      event_type: input.eventType,
      source: input.source,
      verified,
      visibility,
      payload: input.payload,
    };
  });

  const rows = await db
    .insert(rental_activity_events)
    .values(values)
    .returning();

  for (const row of rows) {
    rentalActivityEvents.emit("activity:created", { activity: row } satisfies RentalActivityCreatedEvent);
  }
  return rows;
}
