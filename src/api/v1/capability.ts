import { ApiError } from "../../../shared/api/core.mjs";
import type { ApiCapabilityCheck } from "./context.js";

/**
 * Every /api/v1 route calls this before its handler. Today only a person
 * acting for themselves reaches it, and a person holds every capability in a
 * room they may read. The grant and room policy checks (a page version's
 * grant, confirm, approve) replace this body.
 */
export const checkCapability: ApiCapabilityCheck = async (actor, capability) => {
  if (actor.principal.kind === "person" && !actor.via) return;
  throw new ApiError("not_granted", `This caller does not hold the "${capability}" capability.`);
};
