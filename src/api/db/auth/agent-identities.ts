import { asc, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { agents } from "../schema.js";
import { nextPrefixedId } from "../utils.js";
import type { AgentIdentity } from "../types.js";
import { RequestValidationError } from "../../validation-error.js";

export async function registerAgentIdentity(input: {
  owner_account_id: string;
  owner_login: string;
  owner_label: string;
  name: string;
  display_name?: string;
}): Promise<AgentIdentity> {
  const canonicalKey = `${input.owner_login}/${input.name}`;
  const [existing] = await db
    .select()
    .from(agents)
    // Use the same ASCII-fold/exact-non-ASCII contract as routing. PostgreSQL
    // LOWER is locale-sensitive and would merge identities the transports do
    // not, while missing some application-equivalent whitespace spellings.
    .where(sql`normalize_message_thread_routing_alias(${agents.canonical_key}, true)
      = normalize_message_thread_routing_alias(${canonicalKey}, true)`)
    .limit(1);

  const now = new Date().toISOString();
  const displayName = input.display_name?.trim() || input.name;

  if (existing) {
    if (existing.owner_account_id !== input.owner_account_id) {
      throw new RequestValidationError("Agent key conflicts with an existing owner identity.");
    }
    await db
      .update(agents)
      .set({
        display_name: displayName,
        owner_label: input.owner_label,
        updated_at: now,
      })
      .where(eq(agents.id, existing.id));

    return {
      ...existing,
      display_name: displayName,
      owner_label: input.owner_label,
      updated_at: now,
    };
  }

  const agent: AgentIdentity = {
    id: await nextPrefixedId("agents", "agent"),
    canonical_key: canonicalKey,
    name: input.name,
    display_name: displayName,
    owner_account_id: input.owner_account_id,
    owner_login: input.owner_login,
    owner_label: input.owner_label,
    created_at: now,
    updated_at: now,
  };

  const inserted = await db
    .insert(agents)
    .values(agent)
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  // A routing-equivalent spelling may have won concurrently. Re-read the
  // unique expression key and converge on that durable identity; never turn a
  // collision owned by another account into an update.
  const [winner] = await db
    .select()
    .from(agents)
    .where(sql`normalize_message_thread_routing_alias(${agents.canonical_key}, true)
      = normalize_message_thread_routing_alias(${canonicalKey}, true)`)
    .limit(1);
  if (!winner) {
    throw new Error("Agent identity registration conflicted without a canonical winner.");
  }
  if (winner.owner_account_id !== input.owner_account_id) {
    throw new RequestValidationError("Agent key conflicts with an existing owner identity.");
  }
  await db
    .update(agents)
    .set({ display_name: displayName, owner_label: input.owner_label, updated_at: now })
    .where(eq(agents.id, winner.id));
  return {
    ...winner,
    display_name: displayName,
    owner_label: input.owner_label,
    updated_at: now,
  };
}

export async function getAgentIdentityByCanonicalKey(
  canonicalKey: string
): Promise<AgentIdentity | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.canonical_key, canonicalKey))
    .limit(1);

  return agent ?? null;
}

export async function getAgentIdentitiesForOwner(ownerAccountId: string): Promise<AgentIdentity[]> {
  return db
    .select()
    .from(agents)
    .where(eq(agents.owner_account_id, ownerAccountId))
    .orderBy(asc(agents.name));
}
