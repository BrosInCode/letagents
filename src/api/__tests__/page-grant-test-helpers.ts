import type { CapabilityName } from "../../../shared/api/capabilities.mjs";
import { mintPageGrant, type MintedPageGrant, type PageGrantMinter } from "../v1/page-grants.js";

/**
 * Mints a page grant for a test without a request. Routes must get the
 * minter from requirePageGrantMinter(req), which only an app session passes.
 */
export function mintTestPageGrant(input: {
  accountId: string;
  roomId: string;
  pageId?: string;
  pageVersion?: number;
  capabilities: readonly CapabilityName[];
}): Promise<MintedPageGrant> {
  return mintPageGrant({
    minter: testPageGrantMinter(input.accountId),
    roomId: input.roomId,
    pageId: input.pageId ?? "page_test",
    pageVersion: input.pageVersion ?? 1,
    capabilities: input.capabilities,
  });
}

export function testPageGrantMinter(accountId: string): PageGrantMinter {
  return { accountId } as PageGrantMinter;
}
