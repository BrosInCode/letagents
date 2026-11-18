import type { CapabilityName } from "../../../shared/api/capabilities.mjs";
import { ApiError } from "../../../shared/api/core.mjs";
import type { AuthenticatedRequest } from "../http/helpers.js";

// What the pages registry needs from the page_grant bearer tokens (the actor
// chain owns the tokens). The registry decides which page version and which
// capabilities; the port mints and revokes the bearers. The default below is
// used until the actor chain's mintPageGrant and revokePageGrants are wired in.

export interface MintedPageGrant {
  /** The bearer; shown once, stored only as its hash. */
  token: string;
  grantId: string;
  expiresAt: string;
}

export interface PageGrantsPort {
  /**
   * A short-lived page_grant for one person, one room and one page version,
   * with exactly these capabilities. `req` is the person's own request: the
   * minter checks it is an app session.
   */
  mintPageGrant(input: {
    req: AuthenticatedRequest;
    accountId: string;
    roomId: string;
    pageId: string;
    pageVersion: number;
    capabilities: readonly CapabilityName[];
  }): Promise<MintedPageGrant>;
  /** Ends the live page grants that match every given filter, and their open streams. Returns how many. */
  revokePageGrants(filter: { pageId?: string; roomId?: string; accountId?: string }): Promise<number>;
}

/**
 * Without the actor chain no page grant can be minted, so none can be live
 * and revoking has nothing to end.
 */
export const pageGrantsUnavailable: PageGrantsPort = {
  async mintPageGrant() {
    throw new ApiError("internal", "Page grants are not available on this server.");
  },
  async revokePageGrants() {
    return 0;
  },
};
