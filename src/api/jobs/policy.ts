import type { ApiActor } from "../../../shared/api/actor.mjs";
import { ApiError } from "../../../shared/api/core.mjs";

/**
 * The one place room policy decides whether this actor may start a job in
 * this room. The router has already checked the `jobs.start` capability.
 *
 * Today only a person acting for themselves reaches /api/v1, and a person
 * may always start a job: the post is theirs, in a room they can read. When
 * pages call the API, the `confirm` default of `jobs.start` is met by the
 * app-drawn confirm sheet on the desktop (PR8) before the call arrives; the
 * room policy table (PR1) replaces this body and throws `declined` or
 * `pending_approval` when it says no.
 */
export async function requireJobStartAllowed(actor: ApiActor, roomId: string): Promise<void> {
  if (actor.roomId !== roomId) throw new ApiError("not_granted", "This caller acts in another room.");
  if (actor.principal.kind !== "person") {
    throw new ApiError("not_granted", "Only a person can start a job; agents ask each other in the room.");
  }
}
