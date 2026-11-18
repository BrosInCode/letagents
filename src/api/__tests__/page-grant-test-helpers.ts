import { randomUUID } from "node:crypto";

import type { CapabilityName } from "../../../shared/api/capabilities.mjs";
import { createSession } from "../db/auth/account-sessions.js";
import { mintPageGrant, type MintedPageGrant, type PageGrantMinter } from "../v1/page-grants.js";

/**
 * Mints a page grant for a test without a request. Routes must get the
 * minter from requirePageGrantMinter(req), which only an app session passes.
 * Without a `sessionId`, a fresh app session of the account mints it.
 */
export async function mintTestPageGrant(input: {
  accountId: string;
  sessionId?: string;
  roomId: string;
  pageId?: string;
  pageVersion?: number;
  capabilities: readonly CapabilityName[];
}): Promise<MintedPageGrant> {
  const sessionId = input.sessionId ?? (await createTestSession(input.accountId));
  return mintPageGrant({
    minter: testPageGrantMinter(input.accountId, sessionId),
    roomId: input.roomId,
    pageId: input.pageId ?? "page_test",
    pageVersion: input.pageVersion ?? 1,
    capabilities: input.capabilities,
  });
}

export function testPageGrantMinter(accountId: string, sessionId: string): PageGrantMinter {
  return { accountId, sessionId } as PageGrantMinter;
}

/** A signed-in app session for the account; returns its id. */
export async function createTestSession(accountId: string): Promise<string> {
  const session = await createSession(accountId, `page-grant-test-${randomUUID()}`, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  return session.id;
}
