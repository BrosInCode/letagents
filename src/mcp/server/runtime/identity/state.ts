import { randomUUID } from "crypto";

import {
  getStoredAgentIdentity,
  setStoredAgentIdentity,
  type StoredAgentIdentityState,
} from "../../../local-state.js";
import { EXPLICIT_AGENT_IDENTITY_KEY } from "./config.js";

const MAX_CONVERSATION_IDENTITIES = 20;

export const AGENT_INSTANCE_UUID = randomUUID();
export let currentAgentIdentityKey =
  EXPLICIT_AGENT_IDENTITY_KEY ?? `instance:${AGENT_INSTANCE_UUID}`;
export let currentAgentIdentity: StoredAgentIdentityState | null =
  getStoredAgentIdentity(currentAgentIdentityKey);

const conversationIdentities = new Map<string, StoredAgentIdentityState>();

export function storeCurrentAgentIdentity(
  identity: StoredAgentIdentityState,
  identityKey = currentAgentIdentityKey
): StoredAgentIdentityState {
  currentAgentIdentity = setStoredAgentIdentity(identity, identityKey);
  return currentAgentIdentity;
}

export function getConversationIdentity(
  conversationId?: string | null
): StoredAgentIdentityState | null {
  if (!conversationId) return currentAgentIdentity;
  return conversationIdentities.get(conversationId) ?? currentAgentIdentity;
}

export function setConversationIdentity(
  conversationId: string,
  identity: StoredAgentIdentityState
): void {
  if (
    !conversationIdentities.has(conversationId) &&
    conversationIdentities.size >= MAX_CONVERSATION_IDENTITIES
  ) {
    const oldestKey = conversationIdentities.keys().next().value;
    if (oldestKey !== undefined) conversationIdentities.delete(oldestKey);
  }
  conversationIdentities.set(conversationId, identity);
}

export function ensureAgentIdentityKey(): string {
  currentAgentIdentityKey =
    EXPLICIT_AGENT_IDENTITY_KEY ?? `instance:${AGENT_INSTANCE_UUID}`;
  currentAgentIdentity = getStoredAgentIdentity(currentAgentIdentityKey);
  return currentAgentIdentityKey;
}
