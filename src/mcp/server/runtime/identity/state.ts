import { randomUUID } from "crypto";

import {
  getStoredAgentIdentity,
  setStoredAgentIdentity,
  type StoredAgentIdentityState,
} from "../../../local-state.js";
import { EXPLICIT_AGENT_IDENTITY_KEY } from "./config.js";
import { currentSessionScope, scopedValue } from "../session-scope.js";

const MAX_CONVERSATION_IDENTITIES = 20;

/** This process's instance id (stdio). A remote session has its own. */
export const AGENT_INSTANCE_UUID = randomUUID();

export function agentInstanceUuid(): string {
  return currentSessionScope()?.agentInstanceId ?? AGENT_INSTANCE_UUID;
}

function defaultIdentityKey(): string {
  // The API process's env never names a remote session's identity.
  return currentSessionScope() ? `instance:${agentInstanceUuid()}`
    : EXPLICIT_AGENT_IDENTITY_KEY ?? `instance:${AGENT_INSTANCE_UUID}`;
}

const identityKey = scopedValue("agent-identity-key", defaultIdentityKey);
const identity = scopedValue<StoredAgentIdentityState | null>("agent-identity",
  () => getStoredAgentIdentity(identityKey.get()));
const conversationIdentities = scopedValue("conversation-identities",
  () => new Map<string, StoredAgentIdentityState>());

export function getCurrentAgentIdentityKey(): string {
  return identityKey.get();
}

export function getCurrentAgentIdentity(): StoredAgentIdentityState | null {
  return identity.get();
}

export function storeCurrentAgentIdentity(
  next: StoredAgentIdentityState,
  key = identityKey.get()
): StoredAgentIdentityState {
  const stored = setStoredAgentIdentity(next, key);
  identity.set(stored);
  return stored;
}

export function getConversationIdentity(
  conversationId?: string | null
): StoredAgentIdentityState | null {
  if (!conversationId) return identity.get();
  return conversationIdentities.get().get(conversationId) ?? identity.get();
}

export function setConversationIdentity(
  conversationId: string,
  next: StoredAgentIdentityState
): void {
  const identities = conversationIdentities.get();
  if (!identities.has(conversationId) && identities.size >= MAX_CONVERSATION_IDENTITIES) {
    const oldestKey = identities.keys().next().value;
    if (oldestKey !== undefined) identities.delete(oldestKey);
  }
  identities.set(conversationId, next);
}

export function ensureAgentIdentityKey(): string {
  identityKey.set(defaultIdentityKey());
  identity.set(getStoredAgentIdentity(identityKey.get()));
  return identityKey.get();
}
