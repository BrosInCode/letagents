import type { ApiActor } from "../../../shared/api/actor.mjs";
import { getCapability, type CapabilityName } from "../../../shared/api/capabilities.mjs";
import { ApiError, type AnyApiMethod } from "../../../shared/api/core.mjs";
import type { PageGrantRequestGrant } from "../http/helpers.js";
import type { ApiCallContext, ApiCapabilityCheck } from "./context.js";
import { resolvePolicy, type ResolvedApiPolicy } from "./policy.js";

/**
 * Every /api/v1 route calls this after the room access check and the input
 * parse, before its handler. Rights are the person's (or agent's) room
 * rights, which the access check already proved, intersected with the grant
 * of what they act through:
 * 1. Through a page: the page grant must hold the call's capability (the
 *    method's, or the one its input picks), for this page
 *    version in this room (`not_granted` otherwise).
 *    Through a job or the remote MCP integration: the principal's own rights;
 *    a job carries no permission and adds none.
 * 2. A method that is not a read, or a write-like capability, then
 *    consults the room policy. `deny` refuses with `not_granted`. `confirm`
 *    and `approve` pass: the intent or job handler acts on them with
 *    `resolveCallPolicy`, since only it can make a pending intent or a
 *    confirm request.
 */
export function createCapabilityCheck(deps: { resolvePolicy?: typeof resolvePolicy } = {}): ApiCapabilityCheck {
  const policyOf = deps.resolvePolicy ?? resolvePolicy;
  return async (actor, method, input, call) => {
    const capability = methodCapability(method, input);
    if (actor.via?.kind === "page" && !pageGrantHolds(call.req.pageGrant ?? null, actor, capability)) {
      throw new ApiError("not_granted", `This caller does not hold the "${capability}" capability.`);
    }
    if (method.kind === "read" && !getCapability(capability).writeLike) return;
    const policy = await resolveCallPolicy(call, capability, policyOf);
    if (policy.mode === "deny") {
      throw new ApiError("not_granted", `This room does not allow "${capability}" through the LetAgents API.`);
    }
  };
}

export const checkCapability: ApiCapabilityCheck = createCapabilityCheck();

/**
 * The capability one call uses. A method whose input picks it (a data scope,
 * an intent kind) names it with `capabilityFromInput`; `capability` is the
 * default the reference shows.
 */
export function methodCapability(method: AnyApiMethod, input: unknown): CapabilityName {
  return method.capabilityFromInput?.(input) ?? method.capability;
}

function pageGrantHolds(grant: PageGrantRequestGrant | null, actor: ApiActor, capability: CapabilityName): boolean {
  return Boolean(
    grant
    && grant.page_id === actor.via?.id
    && grant.page_version === actor.via?.version
    && grant.room_id === actor.roomId
    && grant.capabilities.includes(capability),
  );
}

const callPolicies = new WeakMap<object, Map<CapabilityName, Promise<ResolvedApiPolicy>>>();

/**
 * The room policy for this call's actor, read once per request: the
 * capability check and the handler (intents, jobs) share one answer.
 */
export function resolveCallPolicy(
  call: Pick<ApiCallContext, "actor" | "req">,
  capability: CapabilityName,
  policyOf: typeof resolvePolicy = resolvePolicy,
): Promise<ResolvedApiPolicy> {
  let byCapability = callPolicies.get(call.req);
  if (!byCapability) {
    byCapability = new Map();
    callPolicies.set(call.req, byCapability);
  }
  let policy = byCapability.get(capability);
  if (!policy) {
    policy = policyOf(call.actor.roomId, capability, call.actor);
    byCapability.set(capability, policy);
  }
  return policy;
}
