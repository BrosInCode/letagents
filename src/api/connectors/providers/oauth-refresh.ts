import type { TrackerOAuthTokens } from "../oauth.js";
import { type ProviderConnection, type TrackerCredentials, TrackerProviderError } from "./types.js";

const REFRESH_MARGIN_MS = 60_000;
const inflight = new Map<string, Promise<TrackerCredentials>>();

export type TokenRefresher = (refreshToken: string) => Promise<TrackerOAuthTokens>;

/**
 * Credentials with a usable access token. An OAuth token close to expiry is
 * refreshed once per connection at a time (refresh tokens rotate, so two
 * parallel refreshes would invalidate each other), saved, then used.
 */
export async function freshCredentials<C extends TrackerCredentials>(
  conn: ProviderConnection<C>,
  refresh: TokenRefresher | null,
  now: () => Date = () => new Date(),
): Promise<C> {
  const credentials = conn.credentials;
  if (credentials.kind !== "oauth") return credentials;
  const expiresAt = credentials.expires_at ? Date.parse(credentials.expires_at) : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt - now().getTime() > REFRESH_MARGIN_MS) return credentials;
  if (!credentials.refresh_token || !refresh) {
    throw new TrackerProviderError("auth", "The tracker sign-in expired. Connect the tracker again.");
  }
  let pending = inflight.get(conn.id) as Promise<C> | undefined;
  if (!pending) {
    const refreshToken = credentials.refresh_token;
    pending = (async () => {
      const tokens = await refresh(refreshToken);
      const next = {
        ...credentials,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? refreshToken,
        expires_at: tokens.expires_at,
      } as C;
      await conn.saveCredentials(next);
      return next;
    })().finally(() => inflight.delete(conn.id));
    inflight.set(conn.id, pending);
  }
  const next = await pending;
  conn.credentials = next;
  return next;
}
