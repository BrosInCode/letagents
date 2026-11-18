import type { ActorPrincipal, ActorVia, ApiActor } from "../../../shared/api/actor.mjs";
import type { AnyApiMethod } from "../../../shared/api/core.mjs";
import type { OwnerTokenAccount, Project, SessionAccount } from "../db.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import type { RoomAccessTarget } from "../rooms/access-decision.js";

/** Who is calling, before any room is known. The rate limit counts per caller. */
export interface ApiCaller {
  principal: ActorPrincipal;
  via?: ActorVia;
  /** The signed-in account behind a person, with the GitHub credential checks may use. */
  account: SessionAccount | OwnerTokenAccount | null;
  /** The one room this credential opens: a worker bearer's session room, a page grant's room. */
  roomId?: string;
}

/** The caller in the room in the URL, after the room access check. */
export interface ApiRoomAccess {
  actor: ApiActor;
  /** The room in the URL; the caller may read it. */
  room: Project;
  /** How access to the room is decided: by membership, or by its repository. */
  access: RoomAccessTarget;
}

/** What every /api/v1 handler gets besides its parsed input. */
export interface ApiCallContext extends ApiRoomAccess {
  account: SessionAccount | OwnerTokenAccount | null;
  req: AuthenticatedRequest;
}

/**
 * Who sent the request: null when nobody signed in (the router answers
 * `unauthenticated`). Throws ApiError `not_granted` for a credential the API
 * does not take.
 */
export type ApiCallerIdentifier = (req: AuthenticatedRequest) => Promise<ApiCaller | null>;

/**
 * The room in the URL for this caller, or ApiError `not_found`,
 * `not_participant`, `unauthenticated` or `source_unavailable`.
 */
export type ApiRoomAccessResolver = (caller: ApiCaller, roomParam: string) => Promise<ApiRoomAccess>;

/**
 * Runs after the input is parsed, so a check can look at the target (which
 * ticket, which collection). Throws ApiError `not_granted`, `declined` or
 * `pending_approval` when the actor may not make this call.
 */
export type ApiCapabilityCheck = (actor: ApiActor, method: AnyApiMethod, input: unknown, call: ApiCallContext) => Promise<void>;
