import type { CoordinationEventMetadata } from "../schema.js";
import { db } from "../client.js";
import { coordination_events } from "../schema.js";
import { toCoordinationEvent } from "../mappers.js";
import type {
  CoordinationDecision,
  CoordinationEvent,
  CoordinationEventRow,
} from "../types.js";
import { coordinationId } from "../utils.js";

export async function createCoordinationEvent(input: {
  room_id: string;
  event_type: string;
  decision?: CoordinationDecision;
  task_id?: string | null;
  lease_id?: string | null;
  lock_id?: string | null;
  actor_label?: string | null;
  actor_key?: string | null;
  actor_instance_id?: string | null;
  reason?: string | null;
  metadata?: CoordinationEventMetadata | null;
}): Promise<CoordinationEvent> {
  const row: CoordinationEventRow = {
    id: coordinationId("ce"),
    room_id: input.room_id,
    task_id: input.task_id ?? null,
    lease_id: input.lease_id ?? null,
    lock_id: input.lock_id ?? null,
    event_type: input.event_type,
    decision: input.decision ?? "record",
    actor_label: input.actor_label ?? null,
    actor_key: input.actor_key ?? null,
    actor_instance_id: input.actor_instance_id ?? null,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
    created_at: new Date().toISOString(),
  };

  await db.insert(coordination_events).values(row);
  return toCoordinationEvent(row);
}
