/**
 * Tracker base URLs a user may name. Every request with a user's credentials
 * goes to a fixed vendor host or to a Jira Cloud site on `*.atlassian.net`, so
 * a connection cannot point the server at an internal address (SSRF).
 * `LETAGENTS_JIRA_ALLOWED_HOSTS` adds exact host names for a deployment that
 * fronts Jira Cloud under its own domain.
 */
export const JIRA_ALLOWED_HOSTS_ENV = "LETAGENTS_JIRA_ALLOWED_HOSTS";

const ATLASSIAN_SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;

export class TrackerSiteUrlError extends Error {
  readonly code = "tracker_site_url_invalid";
  constructor(message: string) {
    super(message);
    this.name = "TrackerSiteUrlError";
  }
}

function extraAllowedHosts(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    String(env[JIRA_ALLOWED_HOSTS_ENV] ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The site's origin (`https://acme.atlassian.net`), or a TrackerSiteUrlError. */
export function normalizeJiraSiteUrl(raw: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof raw !== "string" || !raw.trim()) throw new TrackerSiteUrlError("Enter your Jira site, for example https://acme.atlassian.net.");
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TrackerSiteUrlError("The Jira site is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new TrackerSiteUrlError("The Jira site must use https.");
  if (url.username || url.password) throw new TrackerSiteUrlError("The Jira site must not contain credentials.");
  if (url.port && url.port !== "443") throw new TrackerSiteUrlError("The Jira site must use the default https port.");
  const host = url.hostname.toLowerCase();
  if (!ATLASSIAN_SITE.test(host) && !extraAllowedHosts(env).has(host)) {
    throw new TrackerSiteUrlError("The Jira site must be a Jira Cloud site on atlassian.net.");
  }
  return `https://${host}`;
}

/** Atlassian cloud ids are UUIDs; anything else never reaches a URL path. */
export function isAtlassianCloudId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F-]{8,64}$/.test(value);
}
