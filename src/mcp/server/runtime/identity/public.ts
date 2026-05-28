import type { StoredAgentIdentityState } from "../../../local-state.js";
import {
  formatOwnerAttribution,
  inferAgentIdeLabel,
} from "../../../../shared/agent-identity.js";
import { AGENT_INSTANCE_UUID } from "./state.js";

export function toPublicAgentIdentity(
  identity: StoredAgentIdentityState | null
): Record<string, unknown> | null {
  if (!identity) {
    return null;
  }

  return {
    name: identity.name,
    display_name: identity.display_name,
    owner_label: identity.owner_label,
    owner_attribution: identity.owner_attribution ?? formatOwnerAttribution(identity.owner_label),
    ide_label: identity.ide_label ?? inferAgentIdeLabel(identity.display_name) ?? "Agent",
    actor_label: identity.actor_label,
    canonical_key: identity.canonical_key ?? null,
    runtime_key: identity.runtime_key ?? null,
    agent_instance_id: AGENT_INSTANCE_UUID,
    source: identity.source,
  };
}
