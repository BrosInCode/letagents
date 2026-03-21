/**
 * Room URL routing and normalization utilities.
 *
 * Architecture spec reference: docs/v1-architecture.md
 *
 * URL structure:
 *   /in/{room}  — canonical room entry (discoverable or invite)
 *   /{provider}/{owner}/{repo} — convenience alias → redirects to /in/...
 *
 * Room ID normalization handles all of:
 *   - https:// and http:// prefix stripping
 *   - git@github.com:owner/repo.git (SSH remote) → github.com/owner/repo
 *   - .git suffix stripping
 *   - Trailing slash stripping
 *   - Provider-specific casing (GitHub: lowercase)
 *   - Invite codes (XXXX-XXXX) uppercased for consistency
 */

// Known git providers and their normalization rules
const KNOWN_PROVIDERS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
]);

// Providers where owner and repo names are case-insensitive
const CASE_INSENSITIVE_PROVIDERS = new Set(["github.com"]);

/**
 * Invite code pattern: XXXX-XXXX (4 uppercase alphanumeric chars, dash, 4 more)
 */
const INVITE_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/**
 * Check if a string looks like an invite code.
 */
export function isInviteCode(value: string): boolean {
  return INVITE_CODE_PATTERN.test(value.toUpperCase());
}

/**
 * Normalize a room name according to provider-specific rules.
 *
 * Strips all common prefixes and normalizes slashes:
 *   - Strip https:// or http:// prefix
 *   - Convert SSH remote git@github.com:owner/repo → github.com/owner/repo
 *   - Strip .git suffix
 *   - Strip trailing slashes
 *   - Apply provider-specific casing (GitHub → lowercase)
 *
 * Examples:
 *   "github.com/EmmyMay/letagents.git"         → "github.com/emmymay/letagents"
 *   "https://github.com/EmmyMay/LetAgents/"    → "github.com/emmymay/letagents"
 *   "git@github.com:EmmyMay/letagents.git"     → "github.com/emmymay/letagents"
 *   "github.com/EmmyMay/LetAgents/"            → "github.com/emmymay/letagents"
 *   "gitlab.com/User/Repo"                     → "gitlab.com/User/Repo" (preserves case)
 */
export function normalizeRoomName(name: string): string {
  let normalized = name.trim();

  // Strip https:// or http:// prefix
  if (normalized.startsWith("https://")) {
    normalized = normalized.slice("https://".length);
  } else if (normalized.startsWith("http://")) {
    normalized = normalized.slice("http://".length);
  }

  // Convert SSH remote: git@github.com:owner/repo → github.com/owner/repo
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, "");

  // Strip .git suffix
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }

  // Apply provider-specific casing
  const parts = normalized.split("/");
  const provider = parts[0]?.toLowerCase();

  if (provider && CASE_INSENSITIVE_PROVIDERS.has(provider)) {
    // Lowercase everything for case-insensitive providers
    normalized = normalized.toLowerCase();
  } else if (provider && KNOWN_PROVIDERS.has(provider)) {
    // Normalize provider hostname only, preserve rest
    parts[0] = provider;
    normalized = parts.join("/");
  }

  return normalized;
}

/**
 * Normalize any room identifier:
 *   - Invite codes (XXXX-XXXX): returned uppercased
 *   - Everything else: treated as a repo room name and normalized
 *
 * This is the safe, high-level entry point for API middleware.
 * Guaranteed to produce a consistent canonical ID for the same room.
 */
export function normalizeRoomId(identifier: string): string {
  const trimmed = identifier.trim();
  if (INVITE_CODE_PATTERN.test(trimmed.toUpperCase())) {
    return trimmed.toUpperCase();
  }
  return normalizeRoomName(trimmed);
}

/**
 * Check if a provider hostname is known.
 */
export function isKnownProvider(hostname: string): boolean {
  return KNOWN_PROVIDERS.has(hostname.toLowerCase());
}

/**
 * Resolve a room identifier to either a canonical room locator or an invite code.
 *
 * Returns:
 *   { type: "room", name: string }      — canonical room (normalized)
 *   { type: "invite", code: string }     — invite code
 */
export function resolveRoomIdentifier(
  identifier: string
): { type: "room"; name: string } | { type: "invite"; code: string } {
  if (isInviteCode(identifier)) {
    return { type: "invite", code: identifier.toUpperCase() };
  }

  return { type: "room", name: normalizeRoomName(identifier) };
}
