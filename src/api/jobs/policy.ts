import type { ApiActor } from "../../../shared/api/actor.mjs";
import { ApiError } from "../../../shared/api/core.mjs";
import { resolvePolicy, type ResolvedApiPolicy } from "../v1/policy.js";

/**
 * The one place room policy decides whether this actor may start a job in
 * this room. The capability check has already refused `deny` and a page
 * whose grant lacks `jobs.start`; this reads the same policy answer for the
 * call (`resolveCallPolicy` caches it per request).
 * - Only a person starts a job, in the app or through a page they opened:
 *   the post is theirs, a person's message with an explicit mention that
 *   wakes the agent. An agent asks other agents in the room instead, and an
 *   owner token or other integration (a local MCP agent, a remote MCP
 *   session) is refused: it would post a person's instruction that no person
 *   wrote or saw. The older message routes post a token's messages as an agent.
 * - `allow`: start.
 * - `confirm`: only a page call reaches this mode (the person in the app
 *   acts for themselves, so their `confirm` is `allow`), and the desktop drew
 *   the confirm sheet before the page's call was sent: start.
 * - `approve`: jobs have no approval queue in v1, so the call is refused.
 * - `deny`: refused.
 */
export async function requireJobStartAllowed(
  actor: ApiActor,
  roomId: string,
  policy: () => Promise<ResolvedApiPolicy> = () => resolvePolicy(roomId, "jobs.start", actor),
): Promise<void> {
  if (actor.roomId !== roomId) throw new ApiError("not_granted", "This caller acts in another room.");
  if (actor.principal.kind !== "person") {
    throw new ApiError("not_granted", "Only a person can start a job; agents ask each other in the room.");
  }
  if (actor.via && actor.via.kind !== "page") {
    throw new ApiError("not_granted", "Start a job from the LetAgents app or a page; a token or integration posts as an agent in the room instead.");
  }
  const { mode } = await policy();
  switch (mode) {
    case "allow":
    case "confirm":
      return;
    case "approve":
      throw new ApiError("not_granted", "This room requires a room admin's approval to start jobs through the API, and jobs cannot wait for one yet.");
    default:
      throw new ApiError("not_granted", "This room does not allow starting jobs through the LetAgents API.");
  }
}
