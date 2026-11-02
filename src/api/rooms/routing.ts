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
 *   - ssh://git@host[:port]/owner/repo.git (SSH URL) → host/owner/repo
 *   - ssh.github.com and www.github.com (GitHub host aliases) → github.com
 *   - .git suffix stripping
 *   - Trailing slash stripping
 *   - Provider-specific casing (GitHub: lowercase)
 *   - Invite codes (XXXX-XXXX or XXXX-XXXX-XXXX) uppercased for consistency
 */

// Known git providers and their normalization rules
const KNOWN_PROVIDERS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
]);

// Hostnames that serve the same GitHub repositories as github.com:
//   - ssh.github.com is GitHub's SSH-over-HTTPS endpoint (git@ssh.github.com on
//     port 443), used when port 22 is blocked.
//   - www.github.com is the same site as github.com.
// An SSH config alias such as `git@github-work:acme/app.git` is NOT listed: its
// real host lives in ~/.ssh/config, which the server cannot read.
const GITHUB_HOST_ALIASES = new Set(["ssh.github.com", "www.github.com"]);

/**
 * Map a GitHub host alias to `github.com`. Accepts an optional `:port`
 * (`ssh.github.com:443`). Any other host is returned lowercased and unchanged.
 */
export function canonicalizeGitHostAlias(host: string): string {
  const lowered = host.trim().toLowerCase();
  const hostname = lowered.replace(/:\d+$/, "");
  return GITHUB_HOST_ALIASES.has(hostname) ? "github.com" : lowered;
}

// Providers where owner and repo names are case-insensitive
const CASE_INSENSITIVE_PROVIDERS = new Set(["github.com"]);

/**
 * Invite code pattern: XXXX-XXXX or XXXX-XXXX-XXXX
 */
const INVITE_CODE_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,2}$/;

/**
 * Check if a string looks like an invite code.
 */
export function isInviteCode(value: string): boolean {
  return INVITE_CODE_PATTERN.test(value.toUpperCase());
}

/**
 * Drop `user[:password]@` and `:port` from the authority (the text before the
 * first `/`) of a URL whose scheme is already removed. The path is untouched.
 */
function stripAuthorityUserinfoAndPort(value: string): string {
  const slashIndex = value.indexOf("/");
  const authority = slashIndex < 0 ? value : value.slice(0, slashIndex);
  const path = slashIndex < 0 ? "" : value.slice(slashIndex);
  const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
  return `${host}${path}`;
}

/**
 * Normalize a room name according to provider-specific rules.
 *
 * Strips all common prefixes and normalizes slashes:
 *   - Strip https:// or http:// prefix, with any userinfo (token) and port
 *   - A bare host:port first segment loses its port (github.com:443/o/r)
 *   - Convert SSH remote git@github.com:owner/repo → github.com/owner/repo
 *   - Strip .git suffix
 *   - Strip trailing slashes
 *   - Apply provider-specific casing (GitHub → lowercase)
 *
 * Examples:
 *   "github.com/BrosInCode/letagents.git"         → "github.com/brosincode/letagents"
 *   "https://github.com/BrosInCode/letagents/"    → "github.com/brosincode/letagents"
 *   "git@github.com:BrosInCode/letagents.git"     → "github.com/brosincode/letagents"
 *   "github.com/BrosInCode/letagents/"            → "github.com/brosincode/letagents"
 *   "gitlab.com/User/Repo"                     → "gitlab.com/User/Repo" (preserves case)
 */
export function normalizeRoomName(name: string): string {
  let normalized = name.trim();

  // Strip https:// or http:// prefix, and with it any userinfo and port. A
  // clone URL such as https://x-access-token:TOKEN@github.com/acme/private.git
  // must never leave its token inside a room id.
  if (normalized.startsWith("https://")) {
    normalized = stripAuthorityUserinfoAndPort(normalized.slice("https://".length));
  } else if (normalized.startsWith("http://")) {
    normalized = stripAuthorityUserinfoAndPort(normalized.slice("http://".length));
  }

  // Convert SSH URL: ssh://git@host:443/owner/repo → host/owner/repo
  const sshUrlMatch = normalized.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (sshUrlMatch) {
    normalized = `${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
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

  // Map GitHub host aliases (ssh.github.com, www.github.com) to github.com
  // before anything keys off the host, so the clone lands in its real room.
  const parts = normalized.split("/");
  // A bare `host:port/owner/repo` (github.com:443/acme/private) is the same
  // repository; a port inside the host would make the id fall outside the
  // repo-backed shape and open as an ad-hoc room.
  if (parts.length >= 3 && /^[A-Za-z0-9.-]+:\d+$/.test(parts[0])) {
    parts[0] = parts[0].replace(/:\d+$/, "");
    normalized = parts.join("/");
  }
  if (parts.length > 1 && canonicalizeGitHostAlias(parts[0]) === "github.com") {
    parts[0] = "github.com";
    normalized = parts.join("/");
  }

  // Apply provider-specific casing
  const provider = parts[0]?.toLowerCase();

  if (provider && CASE_INSENSITIVE_PROVIDERS.has(provider)) {
    // Repository coordinates are case-insensitive, but a parent-scoped focus
    // key is opaque and may contain case-sensitive encoded data.
    normalized = parts.length > 4 && parts[3]?.toLowerCase() === "focus"
      ? [...parts.slice(0, 3).map((part) => part.toLowerCase()), "focus", ...parts.slice(4)].join("/")
      : normalized.toLowerCase();
  } else if (provider && KNOWN_PROVIDERS.has(provider)) {
    // Normalize provider hostname only, preserve rest
    parts[0] = provider;
    normalized = parts.join("/");
  }

  return normalized;
}

/**
 * Normalize any room identifier:
 *   - Invite codes (XXXX-XXXX or XXXX-XXXX-XXXX): returned uppercased
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

export function parseFocusRoomLocator(
  roomLocator: string
): { parentRoomId: string; focusKey: string } | null {
  const marker = "/focus/";
  const index = roomLocator.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }

  const parentRoomId = roomLocator.slice(0, index);
  const focusKey = roomLocator.slice(index + marker.length);
  if (!parentRoomId || !focusKey || focusKey.includes("/")) {
    return null;
  }

  return { parentRoomId, focusKey };
}

export function isReservedMainRoomCreationId(roomId: string): boolean {
  const normalized = roomId.trim();
  return /^focus_\d+$/.test(normalized)
    || /^git-room:github\.com:/i.test(normalized)
    || /(?:^|\/)focus\//i.test(normalized);
}

/**
 * Check if a provider hostname is known.
 */
export function isKnownProvider(hostname: string): boolean {
  return KNOWN_PROVIDERS.has(canonicalizeGitHostAlias(hostname));
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
