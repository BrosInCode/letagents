import { randomBytes } from "node:crypto";

/**
 * The `page_grant` bearer: `lapg.<64 hex>`. The prefix lets the auth
 * resolver send such a bearer only to the page token lookup, as `lmcp_at.`
 * does for MCP OAuth tokens. Kept free of imports so the request auth module
 * can load it without the API router.
 */
export const PAGE_GRANT_TOKEN_PREFIX = "lapg";
const PAGE_GRANT_TOKEN = new RegExp(`^${PAGE_GRANT_TOKEN_PREFIX}\\.[0-9a-f]{64}$`);

/** A page grant lives 15 minutes; the desktop refreshes it while the page is open. */
export const PAGE_GRANT_TTL_MS = 15 * 60_000;

export const API_V1_PATH_PREFIX = "/api/v1/";

export function newPageGrantToken(): string {
  return `${PAGE_GRANT_TOKEN_PREFIX}.${randomBytes(32).toString("hex")}`;
}

/** True for any bearer with the page grant prefix; such bearers are only ever page grants. */
export function looksLikePageGrantToken(token: string): boolean {
  return token.startsWith(`${PAGE_GRANT_TOKEN_PREFIX}.`);
}

export function isWellFormedPageGrantToken(token: string): boolean {
  return PAGE_GRANT_TOKEN.test(token);
}

/**
 * A page grant is accepted only under /api/v1, where every route checks the
 * grant's capabilities. Older routes check only the account and room role,
 * so there a page token would carry the person's full rights. The match is
 * exact and case-sensitive: any other spelling is refused, never widened.
 */
export function isApiV1RequestPath(path: string | undefined): boolean {
  return typeof path === "string" && path.startsWith(API_V1_PATH_PREFIX);
}

/**
 * The request's full path. Inside a mounted router Express strips the mount
 * point from `req.path` (`/api/v1/rooms/x` reads `/rooms/x`), so the path
 * limit reads `originalUrl`, which no router rewrites.
 */
export function requestPathname(req: { originalUrl?: string; url?: string }): string | undefined {
  const raw = req.originalUrl ?? req.url;
  if (typeof raw !== "string") return undefined;
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}
