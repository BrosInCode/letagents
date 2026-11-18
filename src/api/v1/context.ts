import type { ApiActor } from "../../../shared/api/actor.mjs";
import type { CapabilityName } from "../../../shared/api/capabilities.mjs";
import type { OwnerTokenAccount, Project, SessionAccount } from "../db.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import type { RoomAccessTarget } from "../rooms/access-decision.js";

/** What every /api/v1 handler gets besides its parsed input. */
export interface ApiCallContext {
  actor: ApiActor;
  /** The room in the URL; the caller may read it. */
  room: Project;
  /** How access to the room is decided: by membership, or by its repository. */
  access: RoomAccessTarget;
  /** The signed-in account behind a person, with the GitHub credential checks may use. */
  account: SessionAccount | OwnerTokenAccount | null;
  req: AuthenticatedRequest;
}

export type ResolvedApiActor = Omit<ApiCallContext, "req">;

/**
 * Turns a request and the `:room` path segment into an actor in a room the
 * caller may read, or throws an ApiError (`unauthenticated`, `not_found`,
 * `not_participant`, `not_granted`, `source_unavailable`).
 */
export type ApiActorResolver = (req: AuthenticatedRequest, roomParam: string) => Promise<ResolvedApiActor>;

/** Throws ApiError `not_granted` (or `declined`, `pending_approval`) when the actor may not use the capability. */
export type ApiCapabilityCheck = (actor: ApiActor, capability: CapabilityName, call: ApiCallContext) => Promise<void>;
