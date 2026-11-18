import type { ApiActor } from "../../../shared/api/actor.mjs";
import { getCapability, type CapabilityName } from "../../../shared/api/capabilities.mjs";
import { ApiError, capabilityForCall } from "../../../shared/api/core.mjs";
import type { PageGrantRequestGrant } from "../http/helpers.js";
import type { ApiCallContext, ApiCapabilityCheck } from "./context.js";
import { isPolicyCapability, resolvePolicy, type ResolvedApiPolicy } from "./policy.js";

/**
 * Every /api/v1 route calls this after the room access check and the input
 * parse, before its handler. The capability is the method's, or the one its
 * `capabilityFromInput` derives from this input. Rights are the person's (or
 * agent's) room rights, which the access check already proved, intersected
 * with the grant of what they act through:
 * 1. Room administration (not grantable) is for a person acting for
 *    themselves: no page, agent, job or integration. An agent's worker
 *    bearer reads, and writes only through a method the contract opens to
 *    agents (`agents: "write"`).
 * 2. Through a page: the page grant must hold the capability, for this page
 *    version in this room. Through a job or the remote MCP integration: the
 *    principal's own rights; a job carries no permission and adds none.
 * 3. A capability with a room policy (everything but reads and room
 *    administration) reads the policy, reads of `data.*` included. `deny`
 *    refuses. `confirm` and `approve` pass only to an intent or a job, whose
 *    handler acts on them with `resolveCallPolicy`; any other method cannot
 *    wait for a viewer or an admin, so it is refused.
 * Every refusal is `not_granted`.
 */
export function createCapabilityCheck(deps: { resolvePolicy?: typeof resolvePolicy } = {}): ApiCapabilityCheck {
  const policyOf = deps.resolvePolicy ?? resolvePolicy;
  return async (actor, method, input, call) => {
    const capability = capabilityForCall(method, input);
    if (!getCapability(capability).grantable && (actor.principal.kind !== "person" || actor.via)) {
      throw new ApiError("not_granted", "Only a person signed in to LetAgents, acting for themselves, can do this.");
    }
    if (actor.principal.kind === "agent" && method.kind !== "read" && method.agents !== "write") {
      throw new ApiError("not_granted", "Agents cannot use this method through the LetAgents API.");
    }
    if (actor.via?.kind === "page" && !pageGrantHolds(call.req.pageGrant ?? null, actor, capability)) {
      throw new ApiError("not_granted", `This caller does not hold the "${capability}" capability.`);
    }
    if (!isPolicyCapability(capability)) return;
    const policy = await resolveCallPolicy({ actor, req: call.req }, capability, policyOf);
    if (policy.mode === "deny") {
      throw new ApiError("not_granted", `This room does not allow "${capability}" through the LetAgents API.`);
    }
    if ((policy.mode === "confirm" || policy.mode === "approve") && method.kind !== "intent" && method.kind !== "job") {
      const waitsFor = policy.mode === "confirm" ? "the viewer's confirmation" : "a room admin's approval";
      throw new ApiError("not_granted", `In this room "${capability}" needs ${waitsFor}, which this method cannot wait for.`);
    }
  };
}

export const checkCapability: ApiCapabilityCheck = createCapabilityCheck();

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
