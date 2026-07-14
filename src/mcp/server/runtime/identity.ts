import {
  buildAgentActorLabel,
  formatOwnerAttribution,
} from "../../../shared/agent-identity.js";
import type {
  StoredAccount,
  StoredAgentIdentityState,
} from "../../local-state.js";
import { type AgentPresenceStatus } from "../../../shared/agent-presence.js";
import {
  apiCall,
  getLetagentsToken,
} from "./api.js";
import { requireValidWorkerBearerRuntime } from "./worker-bearer.js";
import {
  detectAgentIdeLabel,
  detectAgentRuntimeLabel,
} from "./identity/config.js";
import { resolveOwnerContext } from "./identity/directory.js";
import { getSessionLivenessRegistration } from "./identity/liveness.js";
import {
  resolveAgentName,
  sameAgentIdentity,
} from "./identity/names.js";
import { toPublicAgentIdentity } from "./identity/public.js";
import {
  currentAgentIdentity,
  currentAgentIdentityKey,
  ensureAgentIdentityKey,
  getConversationIdentity,
  setConversationIdentity,
  storeCurrentAgentIdentity,
  AGENT_INSTANCE_UUID,
} from "./identity/state.js";

export {
  AGENT_INSTANCE_UUID,
  currentAgentIdentity,
  currentAgentIdentityKey,
  detectAgentIdeLabel,
  detectAgentRuntimeLabel,
  getConversationIdentity,
  getSessionLivenessRegistration,
  resolveOwnerContext,
  setConversationIdentity,
  storeCurrentAgentIdentity,
  toPublicAgentIdentity,
};

export async function ensureAgentIdentity(): Promise<StoredAgentIdentityState> {
  const owner = await resolveOwnerContext();
  const authAvailable = requireValidWorkerBearerRuntime().mode === "owner" && Boolean(await getLetagentsToken());
  const ideLabel = detectAgentIdeLabel();
  const identityKey = ensureAgentIdentityKey();
  const ownerAttribution = formatOwnerAttribution(owner.label);
  const { name, display_name: displayName } = await resolveAgentName({
    authAvailable,
    identityKey,
    currentIdentity: currentAgentIdentity,
  });
  const actorLabel = buildAgentActorLabel({
    display_name: displayName,
    owner_label: owner.label,
    ide_label: ideLabel,
  });

  let resolved: StoredAgentIdentityState = {
    name,
    display_name: displayName,
    owner_label: owner.label,
    owner_attribution: ownerAttribution,
    ide_label: ideLabel,
    actor_label: actorLabel,
    canonical_key: owner.login ? `${owner.login}/${name}` : null,
    runtime_key: identityKey,
    source: "local",
    resolved_at: new Date().toISOString(),
  };

  if (
    currentAgentIdentity &&
    currentAgentIdentity.name === resolved.name &&
    currentAgentIdentity.display_name === resolved.display_name &&
    currentAgentIdentity.owner_label === resolved.owner_label &&
    currentAgentIdentity.owner_attribution === resolved.owner_attribution &&
    currentAgentIdentity.ide_label === resolved.ide_label &&
    currentAgentIdentity.actor_label === resolved.actor_label &&
    currentAgentIdentity.runtime_key === resolved.runtime_key &&
    (!authAvailable || currentAgentIdentity.source === "api")
  ) {
    return currentAgentIdentity;
  }

  if (authAvailable) {
    try {
      const registered = await apiCall<Record<string, unknown>>("/agents", {
        method: "POST",
        body: JSON.stringify({
          name: resolved.name,
          display_name: resolved.display_name,
          owner_label: resolved.owner_label,
        }),
      });

      resolved = {
        ...resolved,
        canonical_key:
          typeof registered.canonical_key === "string"
            ? registered.canonical_key
            : resolved.canonical_key,
        display_name:
          typeof registered.display_name === "string"
            ? registered.display_name
            : resolved.display_name,
        owner_label:
          typeof registered.owner_label === "string"
            ? registered.owner_label
            : resolved.owner_label,
        source: "api",
      };
      resolved.owner_attribution = formatOwnerAttribution(resolved.owner_label);
      resolved.actor_label = buildAgentActorLabel({
        display_name: resolved.display_name,
        owner_label: resolved.owner_label,
        ide_label: resolved.ide_label,
      });
    } catch (error) {
      console.error(
        "Agent identity registration failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  if (sameAgentIdentity(currentAgentIdentity, resolved)) {
    return currentAgentIdentity ?? resolved;
  }

  return storeCurrentAgentIdentity(
    {
      ...resolved,
      resolved_at: new Date().toISOString(),
    },
    identityKey
  );
}

export async function withAgentIdentity(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return {
    ...payload,
    agent_identity: toPublicAgentIdentity(await ensureAgentIdentity()),
  };
}

export type {
  AgentPresenceStatus,
  StoredAccount,
  StoredAgentIdentityState,
};
