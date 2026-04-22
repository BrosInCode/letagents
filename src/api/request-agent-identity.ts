import { buildAgentActorLabel, parseAgentActorLabel } from "../shared/agent-identity.js";
import { getAgentIdentityByCanonicalKey } from "./db.js";
import type { AuthenticatedRequest } from "./http-helpers.js";

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export interface ResolvedRequestAgentIdentity {
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  display_name: string;
  owner_label: string;
  ide_label: string;
}

export async function resolveRequestAgentIdentity(input: {
  req: AuthenticatedRequest;
  actor_label?: string | null;
  actor_key?: string | null;
  actor_instance_id?: string | null;
}): Promise<ResolvedRequestAgentIdentity | null> {
  if (input.req.authKind !== "owner_token") {
    return null;
  }

  const actorKey = normalizeOptionalString(input.actor_key);
  if (!actorKey) {
    return null;
  }

  const actorIdentity = await getAgentIdentityByCanonicalKey(actorKey);
  if (!actorIdentity || actorIdentity.owner_account_id !== input.req.sessionAccount?.account_id) {
    return null;
  }

  const parsedActorLabel = parseAgentActorLabel(input.actor_label);
  const ideLabel = parsedActorLabel?.ide_label ?? "Agent";

  return {
    actor_label: buildAgentActorLabel({
      display_name: actorIdentity.display_name,
      owner_label: actorIdentity.owner_label,
      ide_label: ideLabel,
    }),
    agent_key: actorIdentity.canonical_key,
    agent_instance_id: normalizeOptionalString(input.actor_instance_id),
    display_name: actorIdentity.display_name,
    owner_label: actorIdentity.owner_label,
    ide_label: ideLabel,
  };
}
