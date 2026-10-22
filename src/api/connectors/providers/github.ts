import { and, eq, isNull, sql } from "drizzle-orm";

import { createGitHubAppJwt } from "../../github/app-client.js";
import { getGitHubAppConfig } from "../../github/config.js";
import { normalizeGitHubRepo, parseGitHubIssueKey } from "../key-detectors.js";
import { mapTicketState } from "../status-map.js";
import { asRecord, asString, trackerRequest } from "./http.js";
import {
  type ExternalItem,
  type ExternalItemChange,
  type GitHubAppCredentials,
  type ListItemsOptions,
  type ProviderConnection,
  type TrackerUser,
  type WorkItemProvider,
  TrackerProviderError,
} from "./types.js";

/**
 * GitHub Issues through the LetAgents GitHub App. No token is stored: each
 * read mints an installation token that GitHub itself limits to one
 * repository and to read access (issues, metadata). Before a repository is
 * read, two checks run:
 *
 * 1. The repository belongs to the connection's installation (the server's
 *    own record of the App's repositories, kept by the App's webhooks).
 * 2. The connection's GitHub login can read the repository on GitHub
 *    (`/collaborators/{login}/permission`), so the App never shows a person a
 *    repository they could not open themselves.
 *
 * Keys are `owner/repo#123` in lower case. GitHub's issue states are open and
 * closed; the raw status adds whether an open issue has an assignee, so the
 * status map can tell to do from in progress. Labels are not states.
 */

const GITHUB_API = "https://api.github.com";
const PAGE_SIZE = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PAGES_PER_REPO = 5;
export const GITHUB_FILTER_MAX_REPOS = 10;
const ACCESS_ALLOW_TTL_MS = 5 * 60_000;
const ACCESS_DENY_TTL_MS = 60_000;
const TOKEN_SAFETY_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 2_000;
const READ_PERMISSIONS = { issues: "read", metadata: "read" } as const;
/** The status of a read LetAgents itself refused (repository outside the installation, or not readable by the login). */
export const ACCESS_REFUSED = 403;

export const GITHUB_STATUS_OPEN = "Open";
export const GITHUB_STATUS_OPEN_ASSIGNED = "Open (assigned)";
export const GITHUB_STATUS_CLOSED = "Closed";

/** What the provider needs from the server's GitHub App records. Injected in tests. */
export interface GitHubAppDirectory {
  /** The App's id and private key, or null when the server has no GitHub App. */
  appCredentials(): Promise<{ appId: string; privateKey: string } | null>;
  /** The active installation that holds `owner/repo`, or null. */
  repositoryInstallation(repo: string): Promise<{ installation_id: string } | null>;
  /** An installation that is neither suspended nor removed, or null. */
  installation(installationId: string): Promise<{ installation_id: string; target_login: string } | null>;
}

// The database loads on first use, so the provider imports without one (tests, tools).
async function appTables() {
  const [{ db }, { github_app_installations, github_app_repositories }] = await Promise.all([
    import("../../db/client.js"),
    import("../../db/schema.js"),
  ]);
  return { db, github_app_installations, github_app_repositories };
}

export const defaultGitHubAppDirectory: GitHubAppDirectory = {
  async appCredentials() {
    const config = await getGitHubAppConfig();
    return config.appId && config.privateKey ? { appId: config.appId, privateKey: config.privateKey } : null;
  },
  async repositoryInstallation(repo) {
    const { db, github_app_installations, github_app_repositories } = await appTables();
    // Stored names keep GitHub's case; keys are lower case. The table holds
    // one row per repository the App can see, so the scan is small.
    const [row] = await db.select({ installation_id: github_app_repositories.installation_id })
      .from(github_app_repositories)
      .innerJoin(github_app_installations, eq(github_app_installations.installation_id, github_app_repositories.installation_id))
      .where(and(
        sql`lower(${github_app_repositories.full_name}) = ${repo}`,
        isNull(github_app_repositories.removed_at),
        isNull(github_app_installations.suspended_at),
        isNull(github_app_installations.uninstalled_at),
      ))
      .limit(1);
    return row ?? null;
  },
  async installation(installationId) {
    const { db, github_app_installations } = await appTables();
    const [row] = await db.select({
      installation_id: github_app_installations.installation_id,
      target_login: github_app_installations.target_login,
    }).from(github_app_installations)
      .where(and(
        eq(github_app_installations.installation_id, installationId),
        isNull(github_app_installations.suspended_at),
        isNull(github_app_installations.uninstalled_at),
      ))
      .limit(1);
    return row ?? null;
  },
};

export interface GitHubIssuesProviderOptions {
  fetchImpl?: typeof fetch;
  directory?: GitHubAppDirectory;
  now?: () => Date;
}

/** The repositories of a GitHub Issues room filter: `owner/repo` terms, space or comma separated. */
export function parseGitHubFilter(filter: string | null): string[] {
  const terms = (filter ?? "").split(/[\s,]+/).filter(Boolean);
  const repos: string[] = [];
  for (const term of terms) {
    const repo = normalizeGitHubRepo(term);
    if (!repo) throw new TrackerProviderError("definite", `GitHub Issues filter term "${term.slice(0, 60)}" is not owner/repo.`);
    if (!repos.includes(repo)) repos.push(repo);
  }
  if (repos.length === 0) throw new TrackerProviderError("definite", "Name at least one repository as owner/repo.");
  if (repos.length > GITHUB_FILTER_MAX_REPOS) {
    throw new TrackerProviderError("definite", `A GitHub Issues filter can name at most ${GITHUB_FILTER_MAX_REPOS} repositories.`);
  }
  return repos;
}

/** Whether a GitHub issue belongs to one of the filter's repositories. */
export function githubFilterAllows(filter: string, item: ExternalItem): boolean {
  const key = parseGitHubIssueKey(item.key);
  if (!key) return false;
  try {
    return parseGitHubFilter(filter).includes(key.repo);
  } catch {
    return false;
  }
}

/** The raw status the status map sees. */
export function githubRawStatus(issue: Record<string, unknown>): string {
  if (asString(issue.state) === "closed") return GITHUB_STATUS_CLOSED;
  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  return assignees.length > 0 || asString(asRecord(issue.assignee).login) ? GITHUB_STATUS_OPEN_ASSIGNED : GITHUB_STATUS_OPEN;
}

/**
 * GitHub `issues` webhook payload → the issue it names. The payload is not
 * trusted as the issue's state: sync reads the issue again through the same
 * checks as a poll. Pull requests are not issues here.
 */
export function parseGitHubIssuesWebhook(payload: unknown): ExternalItemChange[] {
  const record = asRecord(payload);
  const issue = asRecord(record.issue);
  if (issue.pull_request) return [];
  const repo = normalizeGitHubRepo(asString(asRecord(record.repository).full_name) ?? "");
  const number = Number(issue.number);
  if (!repo || !Number.isSafeInteger(number) || number < 1) return [];
  const deleted = record.action === "deleted" || record.action === "transferred";
  return [{ key: `${repo}#${number}`, item: null, deleted }];
}

export interface GitHubIssuesProvider extends WorkItemProvider {
  /** Throws a "definite" TrackerProviderError unless the connection may read `repo`. */
  assertReadable(conn: ProviderConnection, repo: string): Promise<void>;
}

function credentialsOf(conn: ProviderConnection): GitHubAppCredentials {
  const credentials = conn.credentials as Partial<GitHubAppCredentials>;
  if (credentials.kind !== "github_app" || !credentials.installation_id || !credentials.login) {
    throw new TrackerProviderError("auth", "This GitHub Issues connection is incomplete. Connect it again.");
  }
  return credentials as GitHubAppCredentials;
}

function bounded<V>(cache: Map<string, V>): Map<string, V> {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return cache;
}

export function createGitHubIssuesProvider(options: GitHubIssuesProviderOptions = {}): GitHubIssuesProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const directory = options.directory ?? defaultGitHubAppDirectory;
  const now = options.now ?? (() => new Date());
  // Per installation and repository ("" = no repository scope): a read-only token.
  const tokens = new Map<string, { token: string; reuseUntil: number }>();
  // Per installation, login and repository: whether the login may read it.
  const access = new Map<string, { allowed: boolean; until: number }>();

  async function mintToken(installationId: string, repoName: string | null): Promise<string> {
    const cacheKey = `${installationId}:${repoName ?? ""}`;
    const cached = tokens.get(cacheKey);
    if (cached && cached.reuseUntil > now().getTime()) return cached.token;
    const app = await directory.appCredentials();
    if (!app) throw new TrackerProviderError("definite", "This server has no GitHub App, so GitHub Issues cannot be read.");
    const jwt = createGitHubAppJwt({ appId: app.appId, privateKey: app.privateKey, now: now() });
    let response;
    try {
      response = await trackerRequest(fetchImpl, {
        url: `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        body: { ...(repoName ? { repositories: [repoName] } : {}), permissions: READ_PERMISSIONS },
        secrets: [jwt],
      });
    } catch (error) {
      if (error instanceof TrackerProviderError && (error.status === 404 || error.status === 401)) {
        throw new TrackerProviderError("auth", "The LetAgents GitHub App is no longer installed for this connection. Install it, then connect GitHub Issues again.", error.status);
      }
      if (error instanceof TrackerProviderError && error.status === 422) {
        throw new TrackerProviderError("definite", "The LetAgents GitHub App cannot read issues here. Ask the server admin to give the App the Issues (read) permission, and check that the repository is in the installation.", 422);
      }
      throw error;
    }
    const body = asRecord(response.json);
    const token = asString(body.token);
    if (!token) throw new TrackerProviderError("definite", "GitHub returned no installation token.");
    const expiresAt = Date.parse(asString(body.expires_at) ?? "");
    const reuseUntil = Number.isFinite(expiresAt) ? expiresAt - TOKEN_SAFETY_MS : 0;
    if (reuseUntil > now().getTime()) bounded(tokens).set(cacheKey, { token, reuseUntil });
    return token;
  }

  async function get(token: string, path: string, query: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const url = new URL(`${GITHUB_API}${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return trackerRequest(fetchImpl, {
      url: url.toString(),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      secrets: [token],
    });
  }

  /** Throws unless the repository is in the connection's installation and its login can read it. */
  async function assertReadable(conn: ProviderConnection, repo: string): Promise<void> {
    const { installation_id: installationId, login } = credentialsOf(conn);
    const name = normalizeGitHubRepo(repo);
    if (!name) throw new TrackerProviderError("definite", `"${repo.slice(0, 60)}" is not owner/repo.`);
    const holder = await directory.repositoryInstallation(name);
    if (!holder || holder.installation_id !== installationId) {
      throw new TrackerProviderError("definite", `The LetAgents GitHub App for this connection is not installed on ${name}.`, ACCESS_REFUSED);
    }
    const cacheKey = `${installationId}:${login.toLowerCase()}:${name}`;
    const cached = access.get(cacheKey);
    let allowed = cached && cached.until > now().getTime() ? cached.allowed : null;
    if (allowed === null) {
      const token = await mintToken(installationId, name.split("/")[1]!);
      try {
        const response = await get(token, `/repos/${name}/collaborators/${encodeURIComponent(login)}/permission`);
        const permission = asString(asRecord(response.json).permission);
        allowed = Boolean(permission && permission !== "none");
      } catch (error) {
        // 404: GitHub does not know this login for the repository.
        if (!(error instanceof TrackerProviderError && error.status === 404)) throw error;
        allowed = false;
      }
      bounded(access).set(cacheKey, { allowed, until: now().getTime() + (allowed ? ACCESS_ALLOW_TTL_MS : ACCESS_DENY_TTL_MS) });
    }
    if (!allowed) throw new TrackerProviderError("definite", `${login} cannot read ${name} on GitHub, so LetAgents does not read it for them.`, ACCESS_REFUSED);
  }

  function toItem(conn: ProviderConnection, repo: string, issue: unknown): ExternalItem | null {
    const record = asRecord(issue);
    const number = Number(record.number);
    if (record.pull_request || !Number.isSafeInteger(number) || number < 1) return null;
    const key = `${repo}#${number}`;
    const rawStatus = githubRawStatus(record);
    const mapped = mapTicketState(conn.status_map, { name: rawStatus });
    const assignees = Array.isArray(record.assignees) ? record.assignees.map(asRecord) : [];
    const assignee = assignees[0] ?? asRecord(record.assignee);
    const assigneeId = assignee.id === undefined || assignee.id === null ? null : String(assignee.id);
    return {
      provider: "github",
      key,
      title: asString(record.title) ?? key,
      ticket_state: mapped.ticket_state,
      raw_status: rawStatus,
      unmapped: mapped.unmapped,
      assignee_id: assigneeId,
      assignee_label: asString(assignee.login),
      url: asString(record.html_url),
      tracker_updated_at: asString(record.updated_at),
      payload: {
        repo,
        number,
        state: asString(record.state),
        state_reason: asString(record.state_reason),
      },
    };
  }

  async function listRepo(
    conn: ProviderConnection,
    repo: string,
    opts: ListItemsOptions,
    limit: number,
  ): Promise<ExternalItem[]> {
    await assertReadable(conn, repo);
    const { installation_id: installationId, login } = credentialsOf(conn);
    const token = await mintToken(installationId, repo.split("/")[1]!);
    const before = opts.updatedBefore ? Date.parse(opts.updatedBefore) : null;
    const items: ExternalItem[] = [];
    for (let page = 1; page <= MAX_PAGES_PER_REPO && items.length < limit; page += 1) {
      const response = await get(token, `/repos/${repo}/issues`, {
        // The first read takes open issues; later reads take every change, so closes arrive.
        state: opts.updatedSince ? "all" : "open",
        sort: "updated",
        direction: "desc",
        per_page: String(PAGE_SIZE),
        page: String(page),
        ...(opts.updatedSince ? { since: opts.updatedSince } : {}),
        ...(opts.assigneeMe ? { assignee: login } : {}),
      });
      const issues = Array.isArray(response.json) ? response.json : [];
      for (const issue of issues) {
        const item = toItem(conn, repo, issue);
        if (!item) continue;
        if (before !== null && item.tracker_updated_at && Date.parse(item.tracker_updated_at) > before) continue;
        items.push(item);
        if (items.length >= limit) break;
      }
      if (issues.length < PAGE_SIZE) break;
    }
    return items;
  }

  /** Open issues assigned to the login in the installation's repositories it can read. */
  async function listAssignedToMe(conn: ProviderConnection, limit: number): Promise<ExternalItem[]> {
    const { installation_id: installationId, login } = credentialsOf(conn);
    const token = await mintToken(installationId, null);
    const response = await get(token, "/search/issues", {
      q: `is:issue is:open assignee:${login}`,
      sort: "updated",
      order: "desc",
      per_page: String(Math.min(limit, PAGE_SIZE)),
    });
    const items: ExternalItem[] = [];
    for (const issue of Array.isArray(asRecord(response.json).items) ? asRecord(response.json).items as unknown[] : []) {
      const repo = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(asString(asRecord(issue).repository_url) ?? "")?.[1];
      const name = repo ? normalizeGitHubRepo(repo) : null;
      if (!name) continue;
      try {
        await assertReadable(conn, name);
      } catch (error) {
        if (error instanceof TrackerProviderError && error.outcome === "definite") continue;
        throw error;
      }
      const item = toItem(conn, name, issue);
      if (item) items.push(item);
    }
    return items;
  }

  const notWritten = () => new TrackerProviderError("definite", "Rules do not write to GitHub Issues yet.");

  return {
    name: "github",
    assertReadable,

    async whoAmI(conn): Promise<TrackerUser> {
      const { installation_id: installationId, login } = credentialsOf(conn);
      const installation = await directory.installation(installationId);
      if (!installation) {
        throw new TrackerProviderError("auth", "The LetAgents GitHub App is no longer installed for this connection. Install it, then connect GitHub Issues again.");
      }
      const token = await mintToken(installationId, null);
      const user = asRecord((await get(token, `/users/${encodeURIComponent(login)}`)).json);
      const id = user.id === undefined || user.id === null ? null : String(user.id);
      if (!id) throw new TrackerProviderError("definite", `GitHub does not know the login ${login}.`);
      return {
        id,
        label: asString(user.login) ?? login,
        site: {
          key: `installation:${installationId}`,
          url: `https://github.com/${encodeURIComponent(installation.target_login)}`,
          name: installation.target_login,
        },
      };
    },

    async listItems(conn, filter, opts) {
      const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      if (!filter?.trim()) {
        if (opts.assigneeMe) return listAssignedToMe(conn, limit);
        throw new TrackerProviderError("definite", "Name at least one repository as owner/repo.");
      }
      const all: ExternalItem[] = [];
      for (const repo of parseGitHubFilter(filter)) all.push(...await listRepo(conn, repo, opts, limit));
      // Newest first across repositories, as sync expects.
      return all
        .sort((a, b) => Date.parse(b.tracker_updated_at ?? "") - Date.parse(a.tracker_updated_at ?? ""))
        .slice(0, limit);
    },

    async getItem(conn, key) {
      const parsed = parseGitHubIssueKey(key);
      if (!parsed) throw new TrackerProviderError("definite", `"${key.slice(0, 60)}" is not a GitHub issue key (owner/repo#123).`);
      await assertReadable(conn, parsed.repo);
      const { installation_id: installationId } = credentialsOf(conn);
      const token = await mintToken(installationId, parsed.repo.split("/")[1]!);
      try {
        const response = await get(token, `/repos/${parsed.repo}/issues/${parsed.number}`);
        return toItem(conn, parsed.repo, response.json);
      } catch (error) {
        // 404: no such issue; 410: deleted or transferred.
        if (error instanceof TrackerProviderError && (error.status === 404 || error.status === 410)) return null;
        throw error;
      }
    },

    async listTransitions() {
      return [];
    },
    async transition() {
      throw notWritten();
    },
    async comment() {
      throw notWritten();
    },
    async findTransition() {
      return null;
    },
    async findComment() {
      return null;
    },

    parseWebhook: parseGitHubIssuesWebhook,
  };
}
