import { ApiError } from "../../../shared/api/core.mjs";
import type { ApiCapabilityCheck } from "./context.js";

/**
 * Every /api/v1 route calls this after the input is parsed and before its
 * handler. Today only people reach it: a person holds every capability in a
 * room they may read, also through a remote MCP session (their owner token).
 * The grant and room policy checks replace this body.
 */
export const checkCapability: ApiCapabilityCheck = async (actor, method) => {
  if (actor.principal.kind === "person" && (!actor.via || actor.via.kind === "integration")) return;
  throw new ApiError("not_granted", `This caller does not hold the "${method.capability}" capability.`);
};
