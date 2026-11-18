import { randomUUID } from "node:crypto";

import { ApiError } from "../../../shared/api/core.mjs";
import { isCapabilityName, type CapabilityName } from "../../../shared/api/capabilities.mjs";
import { getLiveApiPageToken, insertApiPageToken, revokeApiPageTokens } from "../db/api-page-tokens.js";
import { hashToken } from "../db/utils.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import { isAppSession } from "../request/app-session.js";
import { accountCredentialRetirementEvents } from "../rooms/live-authorization.js";
import { newPageGrantToken, PAGE_GRANT_TTL_MS } from "./page-grant-token.js";

declare const minterBrand: unique symbol;

/**
 * A person signed in with an app session (the desktop or the web app), the
 * only caller that may mint or refresh a page grant. Made only by
 * `requirePageGrantMinter`, so a route cannot mint for an agent by mistake.
 */
export interface PageGrantMinter {
  readonly accountId: string;
  readonly [minterBrand]: true;
}

export interface MintedPageGrant {
  /** The bearer; shown once, stored only as its hash. */
  token: string;
  grantId: string;
  expiresAt: string;
}

/**
 * Throws ApiError `not_granted` unless the request is a person's own app
 * session. Owner tokens (what MCP agents hold), worker bearers, supervisor
 * grants, MCP OAuth tokens and page grants themselves cannot mint: a grant
 * acts for the person, so only the person's interactive sign-in makes one.
 */
export function requirePageGrantMinter(req: AuthenticatedRequest): PageGrantMinter {
  if (!isAppSession(req)) {
    throw new ApiError("not_granted", "Only a person signed in to the LetAgents app can open a page.");
  }
  return { accountId: req.sessionAccount!.account_id } as PageGrantMinter;
}

/**
 * Mints a 15-minute `page_grant` for one person, one room and one page
 * version. The caller (the pages registry) has already checked that the page
 * version is placed in the room and which capabilities it was granted; this
 * stores exactly those. The grant never widens the person's rights: every
 * /api/v1 call still checks the person's room access and takes the overlap.
 */
export async function mintPageGrant(input: {
  minter: PageGrantMinter;
  roomId: string;
  pageId: string;
  pageVersion: number;
  capabilities: readonly CapabilityName[];
}): Promise<MintedPageGrant> {
  if (!input.roomId || !input.pageId) throw new TypeError("mintPageGrant needs a room and a page.");
  if (!Number.isInteger(input.pageVersion) || input.pageVersion < 1) throw new TypeError("mintPageGrant needs a positive page version.");
  const unknown = input.capabilities.filter((name) => !isCapabilityName(name));
  if (unknown.length) throw new TypeError(`mintPageGrant: unknown capabilities ${unknown.join(", ")}.`);
  const token = newPageGrantToken();
  const row = await insertApiPageToken({
    tokenId: `pgt_${randomUUID()}`,
    tokenHash: hashToken(token),
    accountId: input.minter.accountId,
    roomId: input.roomId,
    pageId: input.pageId,
    pageVersion: input.pageVersion,
    capabilities: [...new Set(input.capabilities)],
    expiresAt: new Date(Date.now() + PAGE_GRANT_TTL_MS).toISOString(),
  });
  return { token, grantId: row.token_id, expiresAt: new Date(row.expires_at).toISOString() };
}

/**
 * A new token with the same binding (room, page version, capabilities) as a
 * live one, for the same person. The old token keeps working until its own
 * expiry, so calls in flight during the swap do not fail. Returns null when
 * the old token is unknown, expired, revoked, or another person's; the
 * client then mints again through the pages registry, which rechecks the page.
 */
export async function refreshPageGrant(input: { minter: PageGrantMinter; token: string }): Promise<MintedPageGrant | null> {
  const current = await getLiveApiPageToken(hashToken(input.token));
  if (!current || current.account_id !== input.minter.accountId) return null;
  return mintPageGrant({
    minter: input.minter,
    roomId: current.room_id,
    pageId: current.page_id,
    pageVersion: current.page_version,
    capabilities: current.capabilities.filter(isCapabilityName),
  });
}

/**
 * Revokes the live page grants that match every given filter: a page (unpin,
 * grant change, delete), a room, a person (sign-out), or one grant. Calls
 * with a revoked grant fail at once, and the grants' open streams close now,
 * on every API instance. Returns how many grants were revoked.
 */
export async function revokePageGrants(filter: {
  pageId?: string;
  roomId?: string;
  accountId?: string;
  grantId?: string;
}): Promise<number> {
  const hashes = await revokeApiPageTokens({
    pageId: filter.pageId,
    roomId: filter.roomId,
    accountId: filter.accountId,
    tokenId: filter.grantId,
  });
  retirePageGrantStreams(hashes);
  return hashes.length;
}

/**
 * Live room leases key a bearer by the base64url SHA-256 of the token
 * (accountCredentialHash); the table keeps the hex of the same digest.
 */
function retirePageGrantStreams(tokenHashesHex: readonly string[]): void {
  const hashes = tokenHashesHex.map((hex) => Buffer.from(hex, "hex").toString("base64url"));
  if (hashes.length) accountCredentialRetirementEvents.emit("retire", { credential_hashes: hashes });
}
