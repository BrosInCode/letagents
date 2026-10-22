/**
 * Ticket key detectors. Find tracker keys such as `HT-1234` in branch names,
 * pull request text and room messages, so the card that names the ticket can
 * collect them. Pure functions: no I/O, one regex pass per input.
 *
 * Linear keys look like Jira keys, so Linear matches only prefixes the caller
 * names as known team keys. With no team keys, Linear matches nothing.
 *
 * GitHub Issues keys are `owner/repo#123` (lower case). `#123` and
 * `owner/repo#123` match only for repositories the caller names (the room's
 * GitHub Issues filter); with none, GitHub matches nothing.
 */

export type TicketProvider = "jira" | "linear" | "github";

export const TICKET_PROVIDERS: readonly TicketProvider[] = ["jira", "linear", "github"];

export interface TicketKeyMatch {
  provider: TicketProvider;
  key: string;
  /** The card's `external_ref` form, e.g. `jira:HT-1234`. */
  ref: string;
}

export interface KeyDetectorOptions {
  /** Linear team keys known for this room or connection, e.g. `["ENG"]`. */
  linearTeamKeys?: readonly string[];
  /** Repositories (`owner/repo`) the room's GitHub Issues filter names. */
  githubRepos?: readonly string[];
  /**
   * The repository a bare `#123` names, e.g. the pull request's own. A bare
   * number matches only when `githubRepos` holds it. Without one (a room
   * message), a bare number names the only repository in `githubRepos`, and
   * nothing when there are several.
   */
  githubDefaultRepo?: string | null;
}

// Bound the work for one input: a pasted log can be very long.
const MAX_SCANNED_CHARS = 64 * 1024;
const MAX_KEYS_PER_INPUT = 50;
/** `github:` + a 39-character owner + `/` + a 100-character repository + `#` + 9 digits fits. */
export const EXTERNAL_REF_MAX_LENGTH = 160;

// A key is not part of a longer word: `xHT-12` and `HT-12b` are not keys,
// `feature/HT-12-x` and `x-HT-12-y` are.
const JIRA_KEY_PATTERN = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+)-(\d+)(?![A-Za-z0-9])/g;
const LINEAR_KEY_PATTERN = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]*)-(\d+)(?![A-Za-z0-9])/g;
const JIRA_KEY_EXACT = /^[A-Z][A-Z0-9]+-\d+$/;
const LINEAR_KEY_EXACT = /^[A-Z][A-Z0-9]*-\d+$/;
// `#123` or `owner/repo#123`, not inside a word, a path or an HTML entity (`&#123;`).
const GITHUB_KEY_PATTERN = /(?<![A-Za-z0-9_.&/#-])(?:([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}))?#(\d{1,9})(?![A-Za-z0-9_])/g;
const GITHUB_REPO_EXACT = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
const GITHUB_KEY_EXACT = /^([a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100})#([1-9]\d{0,8})$/;

// Common technical names that have the shape of a Jira key.
const NOT_TICKET_PREFIXES = new Set([
  "UTF", "UCS", "ISO", "SHA", "MD5", "AES", "RSA", "ECDSA", "HMAC", "PBKDF2", "CRC",
  "HTTP", "TLS", "SSL", "IPV4", "IPV6", "RFC", "CVE", "CWE", "GHSA", "COVID",
  "GPT", "ES", "ECMA", "WIN", "X86", "ARM", "ARM64", "UTC", "GMT", "PEP", "JSR",
]);

function scan(text: string, pattern: RegExp, accept: (prefix: string) => boolean): string[] {
  if (!text) return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  const input = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  for (const match of input.matchAll(pattern)) {
    const prefix = match[1]!;
    if (!accept(prefix)) continue;
    const key = `${prefix}-${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= MAX_KEYS_PER_INPUT) break;
  }
  return keys;
}

function normalizeTeamKeys(teamKeys: readonly string[] | undefined): Set<string> {
  return new Set((teamKeys ?? []).map((key) => key.trim().toUpperCase()).filter(Boolean));
}

/**
 * The Linear hook: returns a detector scoped to the given team keys. With an
 * empty list, the detector returns no keys.
 */
export function createLinearKeyDetector(teamKeys: readonly string[]): (text: string) => string[] {
  const known = normalizeTeamKeys(teamKeys);
  if (known.size === 0) return () => [];
  return (text) => scan(text, LINEAR_KEY_PATTERN, (prefix) => known.has(prefix));
}

/** `owner/repo` in lower case, or null when it is not a repository name. */
export function normalizeGitHubRepo(value: string): string | null {
  const repo = value.trim().toLowerCase();
  return GITHUB_REPO_EXACT.test(repo) && !repo.endsWith(".git") ? repo : null;
}

/**
 * A bare `#333` or `#999999` written as a CSS colour (`color: #333;`): a
 * colon before it or a semicolon after it. In prose, `#333` stays an issue
 * number: there it cannot be told apart from one.
 */
function isCssColour(text: string, index: number, length: number): boolean {
  const digits = length - 1;
  if (digits !== 3 && digits !== 6) return false;
  return /:\s*$/.test(text.slice(Math.max(0, index - 8), index)) || /^\s*;/.test(text.slice(index + length, index + length + 4));
}

/**
 * The GitHub hook: issue keys (`owner/repo#123`) for the named repositories
 * only. A bare `#123` names the default repository when it is one of them, or
 * the only one.
 */
export function createGitHubKeyDetector(
  repos: readonly string[],
  defaultRepo?: string | null,
): (text: string) => string[] {
  const known = new Set(repos.map(normalizeGitHubRepo).filter((repo): repo is string => Boolean(repo)));
  if (known.size === 0) return () => [];
  const preferred = defaultRepo ? normalizeGitHubRepo(defaultRepo) : null;
  // With a pull request's repository, a bare number means that repository or
  // nothing: "#57" in acme/app never names acme/tracker#57.
  const bareRepo = preferred
    ? known.has(preferred) ? preferred : null
    : known.size === 1 ? [...known][0]! : null;
  return (text) => {
    if (!text) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    const input = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
    for (const match of input.matchAll(GITHUB_KEY_PATTERN)) {
      if (!match[1] && isCssColour(input, match.index!, match[0].length)) continue;
      const repo = match[1] ? normalizeGitHubRepo(match[1]) : bareRepo;
      const number = Number(match[2]);
      if (!repo || !known.has(repo) || !Number.isSafeInteger(number) || number < 1) continue;
      const key = `${repo}#${number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (keys.length >= MAX_KEYS_PER_INPUT) break;
    }
    return keys;
  };
}

export function detectTicketKeys(
  provider: TicketProvider,
  text: string,
  options?: KeyDetectorOptions,
): string[] {
  if (provider === "linear") return createLinearKeyDetector(options?.linearTeamKeys ?? [])(text);
  if (provider === "github") return createGitHubKeyDetector(options?.githubRepos ?? [], options?.githubDefaultRepo)(text);
  return scan(text, JIRA_KEY_PATTERN, (prefix) => !NOT_TICKET_PREFIXES.has(prefix));
}

export function formatExternalRef(provider: TicketProvider, key: string): string {
  return `${provider}:${key}`;
}

function detectAll(texts: Array<string | null | undefined>, options?: KeyDetectorOptions): TicketKeyMatch[] {
  const matches: TicketKeyMatch[] = [];
  const seen = new Set<string>();
  for (const provider of TICKET_PROVIDERS) {
    for (const text of texts) {
      if (!text) continue;
      for (const key of detectTicketKeys(provider, text, options)) {
        const ref = formatExternalRef(provider, key);
        if (seen.has(ref)) continue;
        seen.add(ref);
        matches.push({ provider, key, ref });
      }
    }
  }
  return matches;
}

export function detectKeysInBranch(branch: string | null | undefined, options?: KeyDetectorOptions): TicketKeyMatch[] {
  return detectAll([branch?.replace(/^refs\/heads\//, "")], options);
}

// `Fixes HT-12`, `closes: HT-12`, `Resolves #12`: the keyword is case-insensitive,
// the key that follows it keeps the key rules (upper case). One per line.
const CLOSING_KEYWORD_LINE = /(?:^|[\s(\[])(?:fixes|closes|resolves):?[ \t]+(\S+)/i;

/**
 * The keys a PR body names in closing-keyword form only. Prose such as
 * "follow-up to HT-5" does not link a pull request to a card.
 */
export function closingKeywordText(body: string | null | undefined): string {
  if (!body) return "";
  const input = body.length > MAX_SCANNED_CHARS ? body.slice(0, MAX_SCANNED_CHARS) : body;
  const tokens: string[] = [];
  for (const line of input.split("\n")) {
    const match = CLOSING_KEYWORD_LINE.exec(line);
    if (match) tokens.push(match[1]!);
  }
  return tokens.join("\n");
}

/**
 * Branch first, then title, then the body's closing-keyword lines: earlier
 * inputs are stronger evidence. The branch and title count in any form.
 */
export function detectKeysInPullRequest(
  pullRequest: { headRef?: string | null; title?: string | null; body?: string | null },
  options?: KeyDetectorOptions,
): TicketKeyMatch[] {
  return detectAll([
    pullRequest.headRef?.replace(/^refs\/heads\//, ""),
    pullRequest.title,
    closingKeywordText(pullRequest.body),
  ], options);
}

export function detectKeysInMessage(text: string | null | undefined, options?: KeyDetectorOptions): TicketKeyMatch[] {
  return detectAll([text], options);
}

/**
 * Normalizes a typed external ref. Accepts `jira:HT-1234`, `linear:ENG-12`,
 * `github:owner/repo#12`, or a bare `HT-1234` (read as Jira). Returns null for
 * an invalid value.
 */
export function normalizeExternalRef(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > EXTERNAL_REF_MAX_LENGTH) return null;
  const separator = trimmed.indexOf(":");
  const provider = (separator === -1 ? "jira" : trimmed.slice(0, separator).trim().toLowerCase()) as TicketProvider;
  const rest = (separator === -1 ? trimmed : trimmed.slice(separator + 1)).trim();
  if (provider === "github") {
    const key = rest.toLowerCase();
    return GITHUB_KEY_EXACT.test(key) && !key.split("#")[0]!.endsWith(".git") ? formatExternalRef(provider, key) : null;
  }
  const key = rest.toUpperCase();
  if (provider === "jira" && JIRA_KEY_EXACT.test(key)) return formatExternalRef(provider, key);
  if (provider === "linear" && LINEAR_KEY_EXACT.test(key)) return formatExternalRef(provider, key);
  return null;
}

/** `{ repo, number }` of a GitHub Issues key (`owner/repo#12`), or null. */
export function parseGitHubIssueKey(key: string): { repo: string; number: number } | null {
  const match = GITHUB_KEY_EXACT.exec(key.trim().toLowerCase());
  if (!match || match[1]!.endsWith(".git")) return null;
  return { repo: match[1]!, number: Number(match[2]) };
}

export function parseExternalRef(ref: string): TicketKeyMatch | null {
  const normalized = normalizeExternalRef(ref);
  if (!normalized) return null;
  const separator = normalized.indexOf(":");
  const provider = normalized.slice(0, separator) as TicketProvider;
  const key = normalized.slice(separator + 1);
  return { provider, key, ref: normalized };
}

/** Team key of a Linear ref, e.g. `ENG` for `linear:ENG-12`. */
export function linearTeamKeyOf(ref: string): string | null {
  const parsed = parseExternalRef(ref);
  if (!parsed || parsed.provider !== "linear") return null;
  return parsed.key.slice(0, parsed.key.lastIndexOf("-"));
}
