import type { TrackerOAuthTokens } from "../oauth.js";
import { type ProviderConnection, type TrackerCredentials, TrackerProviderError } from "./types.js";

const REFRESH_MARGIN_MS = 60_000;
const RELOAD_ATTEMPTS = 3;
const RELOAD_DELAY_MS = 500;
const inflight = new Map<string, Promise<TrackerCredentials>>();

export type TokenRefresher = (refreshToken: string) => Promise<TrackerOAuthTokens>;

type OAuthCredentials = Extract<TrackerCredentials, { kind: "oauth" }>;

function usable(credentials: TrackerCredentials, now: Date): boolean {
  if (credentials.kind !== "oauth") return true;
  const expiresAt = credentials.expires_at ? Date.parse(credentials.expires_at) : Number.NaN;
  return !Number.isFinite(expiresAt) || expiresAt - now.getTime() > REFRESH_MARGIN_MS;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Credentials with a usable access token. Refresh tokens rotate, so two
 * refreshes with the same token invalidate each other:
 * - within one process, one refresh per connection runs at a time;
 * - the stored row is read again first, in case another process refreshed;
 * - the save is a compare-and-set, so an older result never replaces a newer;
 * - a refused refresh first looks for credentials another process saved.
 */
export async function freshCredentials<C extends TrackerCredentials>(
  conn: ProviderConnection<C>,
  refresh: TokenRefresher | null,
  now: () => Date = () => new Date(),
): Promise<C> {
  if (usable(conn.credentials, now())) return conn.credentials;
  let pending = inflight.get(conn.id) as Promise<C> | undefined;
  if (!pending) {
    pending = refreshOnce(conn, refresh, now).finally(() => inflight.delete(conn.id));
    inflight.set(conn.id, pending);
  }
  const next = await pending;
  conn.credentials = next;
  return next;
}

async function reloadUsable<C extends TrackerCredentials>(conn: ProviderConnection<C>, now: () => Date): Promise<C | null> {
  if (!conn.reload) return null;
  const stored = await conn.reload();
  return usable(stored, now()) ? stored : null;
}

async function refreshOnce<C extends TrackerCredentials>(
  conn: ProviderConnection<C>,
  refresh: TokenRefresher | null,
  now: () => Date,
): Promise<C> {
  const already = await reloadUsable(conn, now);
  if (already) return already;
  const credentials = (conn.reload ? await conn.reload() : conn.credentials) as unknown as OAuthCredentials;
  if (credentials.kind !== "oauth" || !credentials.refresh_token || !refresh) {
    throw new TrackerProviderError("auth", "The tracker sign-in expired. Connect the tracker again.");
  }
  let tokens: TrackerOAuthTokens;
  try {
    tokens = await refresh(credentials.refresh_token);
  } catch (error) {
    // Another process may have used this refresh token a moment ago.
    for (let attempt = 0; attempt < RELOAD_ATTEMPTS; attempt += 1) {
      await pause(RELOAD_DELAY_MS);
      const other = await reloadUsable(conn, now);
      if (other) return other;
    }
    throw error;
  }
  const next = {
    ...credentials,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? credentials.refresh_token,
    expires_at: tokens.expires_at,
  } as unknown as C;
  if (await conn.saveCredentials(next)) return next;
  const other = await reloadUsable(conn, now);
  if (other) return other;
  throw new TrackerProviderError("definite", "The tracker credentials changed while they were refreshed. Try again.");
}
