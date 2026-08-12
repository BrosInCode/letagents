import { eq, lte } from "drizzle-orm";

import { db } from "../client.js";
import { auth_states } from "../schema.js";
import { AUTH_STATE_TTL_MS, nextPrefixedId } from "../utils.js";
import type { AuthState } from "../types.js";

export async function createAuthState(state: string, redirectTo?: string): Promise<AuthState> {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AUTH_STATE_TTL_MS).toISOString();

  await db.delete(auth_states).where(lte(auth_states.expires_at, createdAt));

  const authState: AuthState = {
    id: await nextPrefixedId("auth_states", "auth_state"),
    state,
    redirect_to: redirectTo ?? null,
    expires_at: expiresAt,
    created_at: createdAt,
  };

  await db.insert(auth_states).values(authState);
  return authState;
}

export async function consumeAuthState(state: string): Promise<AuthState | null> {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    await tx.delete(auth_states).where(lte(auth_states.expires_at, now));

    const [authState] = await tx.select().from(auth_states).where(eq(auth_states.state, state)).limit(1);
    if (!authState) {
      return null;
    }

    await tx.delete(auth_states).where(eq(auth_states.state, state));
    return authState;
  });
}
