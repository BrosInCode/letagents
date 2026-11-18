// Who made an API call, through what, in which room. Every call resolves to
// one actor; writes, intents and jobs store it with the change.
import { z } from "zod";

export const ACTOR_PRINCIPAL_KINDS = /** @type {const} */ (["person", "agent"]);
export const ACTOR_VIA_KINDS = /** @type {const} */ (["page", "job", "integration"]);

/** The account (person) or agent key (agent) whose rights the call uses. */
export const ActorPrincipal = z.object({
  kind: z.enum(ACTOR_PRINCIPAL_KINDS),
  id: z.string().min(1),
  login: z.string().min(1).optional(),
});

/**
 * What the principal acts through. A delegated caller gets the overlap of
 * its own grant and the principal's rights, never more.
 */
export const ActorVia = z.object({
  kind: z.enum(ACTOR_VIA_KINDS),
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
});

export const ApiActor = z.object({
  principal: ActorPrincipal,
  via: ActorVia.optional(),
  roomId: z.string().min(1),
});

/** @typedef {z.infer<typeof ActorPrincipal>} ActorPrincipal */
/** @typedef {z.infer<typeof ActorVia>} ActorVia */
/** @typedef {z.infer<typeof ApiActor>} ApiActor */

/**
 * A stable key for per-actor limits: the same principal through two pages
 * counts as two actors. The room is not part of it, so one caller has one
 * budget across rooms.
 * @param {Pick<ApiActor, "principal" | "via">} actor
 * @returns {string}
 */
export function actorKey(actor) {
  const via = actor.via ? `|${actor.via.kind}:${actor.via.id}` : "";
  return `${actor.principal.kind}:${actor.principal.id}${via}`;
}
