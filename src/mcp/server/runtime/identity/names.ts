import { createHash } from "crypto";

import type { StoredAgentIdentityState } from "../../../local-state.js";
import { toTitleCaseCodename } from "../../../../shared/agent-identity.js";
import {
  AGENT_CODENAME_SPACE,
  normalizeAgentBaseName,
  pickLocalCodename,
} from "../../../../shared/codenames.js";
import {
  AGENT_DISPLAY_NAME,
  AGENT_NAME,
} from "./config.js";
import { getAuthenticatedAgentDirectory } from "./directory.js";

function shouldReuseStoredIdentity(
  identity: StoredAgentIdentityState | null,
  identityKey: string
): boolean {
  return Boolean(
    identity &&
      identity.runtime_key === identityKey &&
      identity.display_name?.trim() &&
      identity.ide_label?.trim() &&
      identity.owner_attribution?.trim()
  );
}

function resolveExplicitAgentIdentity(): { name: string; display_name: string } | null {
  if (AGENT_NAME) {
    const name = normalizeAgentBaseName(AGENT_NAME);
    return {
      name,
      display_name: AGENT_DISPLAY_NAME || toTitleCaseCodename(AGENT_NAME),
    };
  }

  if (AGENT_DISPLAY_NAME) {
    return {
      name: normalizeAgentBaseName(AGENT_DISPLAY_NAME),
      display_name: AGENT_DISPLAY_NAME.trim(),
    };
  }

  return null;
}

export async function resolveAgentName(input: {
  authAvailable: boolean;
  identityKey: string;
  currentIdentity: StoredAgentIdentityState | null;
}): Promise<{ name: string; display_name: string }> {
  const explicit = resolveExplicitAgentIdentity();
  if (explicit) {
    return explicit;
  }

  if (shouldReuseStoredIdentity(input.currentIdentity, input.identityKey)) {
    return {
      name: input.currentIdentity!.name,
      display_name: input.currentIdentity!.display_name,
    };
  }

  if (!input.authAvailable) {
    return pickLocalCodename(input.identityKey);
  }

  const directory = await getAuthenticatedAgentDirectory();
  const existingNames = new Set(
    (directory?.agents ?? [])
      .map((agent) => normalizeAgentBaseName(agent.name || ""))
      .filter(Boolean)
  );

  for (let offset = 0; offset < AGENT_CODENAME_SPACE; offset += 1) {
    const candidate = pickLocalCodename(input.identityKey, offset);
    if (!existingNames.has(candidate.name)) {
      return candidate;
    }
  }

  const fallbackHash = createHash("sha256")
    .update(input.identityKey)
    .digest("hex")
    .slice(0, 4);
  const fallback = pickLocalCodename(input.identityKey);
  return {
    name: `${fallback.name}-${fallbackHash}`,
    display_name: `${fallback.display_name} ${fallbackHash.toUpperCase()}`,
  };
}

export function sameAgentIdentity(
  left: StoredAgentIdentityState | null,
  right: StoredAgentIdentityState
): boolean {
  return Boolean(
    left &&
      left.name === right.name &&
      left.display_name === right.display_name &&
      left.owner_label === right.owner_label &&
      left.owner_attribution === right.owner_attribution &&
      left.ide_label === right.ide_label &&
      left.actor_label === right.actor_label &&
      left.canonical_key === right.canonical_key &&
      left.runtime_key === right.runtime_key &&
      left.source === right.source
  );
}
