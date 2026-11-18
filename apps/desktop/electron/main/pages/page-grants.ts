/**
 * The page grant client. A page's API calls never carry the person's session:
 * main mints a short-lived `page_grant` token for one lease (one page version
 * in one room, for the signed-in person) and sends only that token. This
 * module holds the tokens; it imports nothing, so sign-out can reach it from
 * anywhere.
 */

/** What the server answers for `POST /api/v1/rooms/:room/pages/:pageId/grant`. */
export interface PageGrant {
  token: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  capabilities: string[];
}

/** Main mints a new token this long before the old one runs out. */
export const PAGE_GRANT_REFRESH_BEFORE_MS = 60_000;
/** After a failed mint, calls fail `not_granted` this long before main asks again. */
export const PAGE_GRANT_RETRY_MS = 30_000;

type GrantState = {
  roomId: string;
  pageId: string;
  grant: PageGrant | null;
  minting: Promise<PageGrant | null> | null;
  failedAt: number;
};

export function createPageGrantKeeper(options: {
  mint?: (roomId: string, pageId: string) => Promise<PageGrant>;
  now?: () => number;
} = {}) {
  let mint = options.mint ?? null;
  const now = options.now ?? Date.now;
  const leases = new Map<string, GrantState>();

  function mintFor(leaseId: string, state: GrantState): Promise<PageGrant | null> {
    if (state.minting) return state.minting;
    const minting = (async () => {
      try {
        if (!mint) throw new Error("No page grant source.");
        const grant = await mint(state.roomId, state.pageId);
        // A lease released (or a sign-out) while the mint ran keeps no token.
        if (leases.get(leaseId) !== state) return null;
        state.grant = grant;
        return grant;
      } catch {
        if (leases.get(leaseId) === state) state.failedAt = now();
        return null;
      } finally {
        state.minting = null;
      }
    })();
    state.minting = minting;
    return minting;
  }

  return {
    configure(next: (roomId: string, pageId: string) => Promise<PageGrant>): void {
      mint = next;
    },
    /** A new lease mints its grant at once, so the first call does not wait for it. */
    start(leaseId: string, roomId: string, pageId: string): void {
      const state: GrantState = { roomId, pageId, grant: null, minting: null, failedAt: Number.NEGATIVE_INFINITY };
      leases.set(leaseId, state);
      void mintFor(leaseId, state);
    },
    /**
     * The lease's token for one call, minted again when it has less than a
     * minute left. Null when the lease has no grant: the call then fails
     * `not_granted`, and nothing falls back to the person's session.
     */
    async token(leaseId: string): Promise<string | null> {
      const state = leases.get(leaseId);
      if (!state) return null;
      const time = now();
      if (state.grant && time < state.grant.expiresAt - PAGE_GRANT_REFRESH_BEFORE_MS) return state.grant.token;
      if (!state.minting && time - state.failedAt < PAGE_GRANT_RETRY_MS) {
        return state.grant && time < state.grant.expiresAt ? state.grant.token : null;
      }
      const grant = await mintFor(leaseId, state);
      if (grant && now() < grant.expiresAt) return grant.token;
      // A failed refresh may still leave the old token a little time.
      return state.grant && now() < state.grant.expiresAt && leases.get(leaseId) === state ? state.grant.token : null;
    },
    capabilities(leaseId: string): string[] {
      return [...(leases.get(leaseId)?.grant?.capabilities ?? [])];
    },
    drop(leaseId: string): void {
      leases.delete(leaseId);
    },
    /** Sign-out: every open page loses its token and never mints one for the next account. */
    dropAll(): void {
      leases.clear();
    },
  };
}

export type PageGrantKeeper = ReturnType<typeof createPageGrantKeeper>;

/** The app's one keeper; the page IPC registrar gives it the server's mint. */
export const roomPageGrants = createPageGrantKeeper();

export function dropAllRoomPageGrants(): void {
  roomPageGrants.dropAll();
}

/** A grant from the server's answer, or null when it is not one. */
export function parsePageGrant(value: unknown): PageGrant | null {
  if (!value || typeof value !== "object") return null;
  const { token, expiresAt, capabilities } = value as Record<string, unknown>;
  const expires = typeof expiresAt === "number" ? expiresAt : typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (typeof token !== "string" || !token || !Number.isFinite(expires)) return null;
  return {
    token,
    expiresAt: expires,
    capabilities: Array.isArray(capabilities) ? capabilities.filter((name): name is string => typeof name === "string") : [],
  };
}
