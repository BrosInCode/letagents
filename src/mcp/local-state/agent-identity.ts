import { readLocalState, updateLocalState } from "./storage.js";
import type { StoredAgentIdentityState } from "./types.js";

export function getStoredAgentIdentity(
  identityKey?: string | null
): StoredAgentIdentityState | null {
  const state = readLocalState();
  if (identityKey?.trim()) {
    const scoped = state.agent_identities?.[identityKey.trim()];
    if (scoped) {
      return scoped;
    }
    // UUID-based identity keys must not inherit another process' shared identity.
    if (identityKey.startsWith("instance:")) {
      return null;
    }
  }
  return state.agent_identity ?? null;
}

export function setStoredAgentIdentity(
  agentIdentity: StoredAgentIdentityState,
  identityKey?: string | null
): StoredAgentIdentityState {
  updateLocalState((state) => {
    state.agent_identity = agentIdentity;
    if (identityKey?.trim()) {
      state.agent_identities = state.agent_identities ?? {};
      state.agent_identities[identityKey.trim()] = agentIdentity;
    }
    return state;
  });
  return agentIdentity;
}
