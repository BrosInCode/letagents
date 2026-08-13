import { eq } from "drizzle-orm";

import { db } from "../client.js";
import { accounts, owner_tokens } from "../schema.js";
import { hashToken, nextPrefixedId } from "../utils.js";
import type { OwnerToken, OwnerTokenAccount } from "../types.js";

export async function createOwnerToken(input: {
  accountId: string;
  githubUserId: string;
  token: string;
  providerAccessToken?: string | null;
  oauthTokenExpiresAt?: string | null;
}): Promise<OwnerToken> {
  const now = new Date().toISOString();
  const tokenHash = hashToken(input.token);

  const ownerToken: OwnerToken = {
    token_id: await nextPrefixedId("owner_tokens", "owner_token"),
    account_id: input.accountId,
    github_user_id: input.githubUserId,
    token_hash: tokenHash,
    provider_access_token: input.providerAccessToken ?? null,
    oauth_token_expires_at: input.oauthTokenExpiresAt ?? null,
    created_at: now,
    updated_at: now,
  };

  await db.insert(owner_tokens).values(ownerToken);
  return ownerToken;
}

export async function getOwnerTokenAccountByToken(token: string): Promise<OwnerTokenAccount | null> {
  const tokenHash = hashToken(token);

  const [ownerToken] = await db
    .select({
      token_id: owner_tokens.token_id,
      account_id: owner_tokens.account_id,
      github_user_id: owner_tokens.github_user_id,
      token_hash: owner_tokens.token_hash,
      provider_access_token: owner_tokens.provider_access_token,
      oauth_token_expires_at: owner_tokens.oauth_token_expires_at,
      created_at: owner_tokens.created_at,
      updated_at: owner_tokens.updated_at,
      provider: accounts.provider,
      provider_user_id: accounts.provider_user_id,
      login: accounts.login,
      display_name: accounts.display_name,
      avatar_url: accounts.avatar_url,
    })
    .from(owner_tokens)
    .innerJoin(accounts, eq(owner_tokens.account_id, accounts.id))
    .where(eq(owner_tokens.token_hash, tokenHash))
    .limit(1);

  return ownerToken ?? null;
}

export async function deleteOwnerTokenById(tokenId: string): Promise<void> {
  await db.delete(owner_tokens).where(eq(owner_tokens.token_id, tokenId));
}
