import { db } from "./client.js";
import { rooms } from "./schema.js";
import type { RoomOrigin } from "../rooms/room-nature.js";

type RoomInsert = typeof rooms.$inferInsert;

/**
 * The values of a new room. A main room names its origin; a focus room's
 * origin is always `focus`.
 */
export type NewRoomRow =
  | (Omit<RoomInsert, "origin" | "kind"> & { kind?: "main"; origin: Exclude<RoomOrigin, "focus"> })
  | (Omit<RoomInsert, "origin" | "kind"> & { kind: "focus" });

/**
 * The one way to insert a room. Every writer goes through it, so every new
 * row carries `rooms.origin` from the transaction that creates it. A test
 * (room-origin-writers.test.ts) fails when code outside this file inserts
 * into `rooms`.
 */
export async function insertRoomRow(
  executor: Pick<typeof db, "insert">,
  values: NewRoomRow,
) {
  const origin: RoomOrigin = values.kind === "focus" ? "focus" : values.origin;
  return executor
    .insert(rooms)
    .values({ ...values, kind: values.kind ?? "main", origin })
    .returning();
}
