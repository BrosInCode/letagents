import { mapTicketState } from "../status-map.js";
import { isAtlassianCloudId, normalizeJiraSiteUrl } from "../site-url.js";
import { asRecord, asString, trackerRequest } from "./http.js";
import { freshCredentials, type TokenRefresher } from "./oauth-refresh.js";
import {
  type ExternalItem,
  type JiraCredentials,
  type ListItemsOptions,
  type ProviderConnection,
  type TrackerWriteResult,
  type WorkItemProvider,
  TrackerProviderError,
} from "./types.js";

/** Jira comment property that carries the journal's correlation key. */
export const JIRA_EFFECT_PROPERTY_KEY = "letagents.effect";

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d{1,12}$/;
const ITEM_FIELDS = ["summary", "status", "assignee", "updated"];
const PAGE_SIZE = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** How far back a changelog entry may precede the effect (clock skew). */
const TRANSITION_SKEW_MS = 60_000;

export interface JiraProviderOptions {
  fetchImpl?: typeof fetch;
  refresh?: TokenRefresher | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * A room filter's JQL, without a trailing ORDER BY. Parentheses must balance
 * outside quoted strings, so the filter cannot close the group this provider
 * wraps it in and widen the query past the clauses added after it.
 */
export function jiraFilterClause(filter: string | null): string | null {
  const base = filter?.replace(/\border\s+by\b[\s\S]*$/i, "").trim();
  if (!base) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < base.length; index += 1) {
    const char = base[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")" && --depth < 0) {
      break;
    }
  }
  if (depth !== 0 || quote) throw new TrackerProviderError("definite", "The Jira filter has unbalanced parentheses or quotes.");
  return base;
}

export function assertJiraKey(key: string): string {
  const normalized = key.trim().toUpperCase();
  if (!ISSUE_KEY.test(normalized)) throw new TrackerProviderError("definite", `"${key.slice(0, 40)}" is not a Jira issue key.`);
  return normalized;
}

function jiraTime(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  const parsed = Date.parse(text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Plain text as an Atlassian Document: blank lines split paragraphs. */
export function toAdf(text: string): Record<string, unknown> {
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: (paragraphs.length ? paragraphs : [""]).map((block) => ({
      type: "paragraph",
      content: block
        ? block.split("\n").flatMap((line, index) => [
            ...(index ? [{ type: "hardBreak" }] : []),
            ...(line ? [{ type: "text", text: line }] : []),
          ])
        : [],
    })),
  };
}

function sameStatus(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function createJiraProvider(options: JiraProviderOptions = {}): WorkItemProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  async function api(conn: ProviderConnection, path: string, init: { method?: "GET" | "POST"; body?: unknown; write?: boolean } = {}) {
    const credentials = await freshCredentials(conn as ProviderConnection<JiraCredentials>, options.refresh ?? null, now);
    let base: string;
    let authorization: string;
    let secrets: string[];
    if (credentials.kind === "api_token") {
      // Re-validated on every call: the stored site must still be allowed.
      base = `${normalizeJiraSiteUrl(credentials.site_url, env)}/rest/api/3`;
      authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.api_token}`).toString("base64")}`;
      secrets = [credentials.api_token, authorization];
    } else {
      if (!isAtlassianCloudId(credentials.cloud_id)) throw new TrackerProviderError("auth", "The Jira connection has no valid site id.");
      base = `https://api.atlassian.com/ex/jira/${credentials.cloud_id}/rest/api/3`;
      authorization = `Bearer ${credentials.access_token}`;
      secrets = [credentials.access_token, credentials.refresh_token ?? ""];
    }
    return trackerRequest(fetchImpl, {
      url: `${base}${path}`,
      method: init.method,
      body: init.body,
      headers: { Authorization: authorization },
      secrets,
      write: init.write,
    });
  }

  /** A browser link into the site, or null when the site has no known URL. */
  function siteLink(conn: ProviderConnection, path: string): string | null {
    const site = (conn.credentials as JiraCredentials).site_url;
    return site ? `${site}${path}` : null;
  }

  function toItem(conn: ProviderConnection, issue: unknown): ExternalItem | null {
    const record = asRecord(issue);
    const key = asString(record.key);
    if (!key) return null;
    const fields = asRecord(record.fields);
    const status = asRecord(fields.status);
    const rawStatus = asString(status.name) ?? "Unknown";
    const assignee = asRecord(fields.assignee);
    const mapped = mapTicketState(conn.status_map, { name: rawStatus });
    return {
      provider: "jira",
      key,
      title: asString(fields.summary) ?? key,
      ticket_state: mapped.ticket_state,
      raw_status: rawStatus,
      unmapped: mapped.unmapped,
      assignee_id: asString(assignee.accountId),
      assignee_label: asString(assignee.displayName),
      url: siteLink(conn, `/browse/${encodeURIComponent(key)}`),
      tracker_updated_at: jiraTime(fields.updated),
      payload: {
        id: asString(record.id),
        status_category: asString(asRecord(status.statusCategory).key),
      },
    };
  }

  async function getItem(conn: ProviderConnection, rawKey: string): Promise<ExternalItem | null> {
    const key = assertJiraKey(rawKey);
    try {
      const response = await api(conn, `/issue/${encodeURIComponent(key)}?fields=${ITEM_FIELDS.join(",")}`);
      return toItem(conn, response.json);
    } catch (error) {
      if (error instanceof TrackerProviderError && error.status === 404) return null;
      throw error;
    }
  }

  async function listTransitions(conn: ProviderConnection, rawKey: string) {
    const key = assertJiraKey(rawKey);
    const response = await api(conn, `/issue/${encodeURIComponent(key)}/transitions`);
    const transitions = Array.isArray(asRecord(response.json).transitions) ? asRecord(response.json).transitions as unknown[] : [];
    return transitions.flatMap((entry) => {
      const record = asRecord(entry);
      const id = asString(record.id);
      const toStatus = asString(asRecord(record.to).name) ?? asString(record.name);
      return id && toStatus ? [{ id, toStatus }] : [];
    });
  }

  return {
    name: "jira",

    async whoAmI(conn) {
      const response = await api(conn, "/myself");
      const record = asRecord(response.json);
      const id = asString(record.accountId);
      if (!id) throw new TrackerProviderError("auth", "Jira did not return the signed-in user.");
      return { id, label: asString(record.displayName) ?? asString(record.emailAddress) ?? id };
    },

    async listItems(conn, filter, opts: ListItemsOptions) {
      const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const clauses: string[] = [];
      const base = jiraFilterClause(filter);
      if (base) clauses.push(`(${base})`);
      if (opts.assigneeMe) clauses.push("assignee = currentUser()");
      if (opts.updatedSince) {
        const since = Date.parse(opts.updatedSince);
        if (!Number.isFinite(since)) throw new TrackerProviderError("definite", "updatedSince is not a valid time.");
        // Relative minutes avoid JQL's per-user time zone for absolute dates.
        const minutes = Math.max(1, Math.ceil((now().getTime() - since) / 60_000) + 1);
        clauses.push(`updated >= -${minutes}m`);
      }
      const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`.trim();
      const items: ExternalItem[] = [];
      let nextPageToken: string | null = null;
      do {
        const response = await api(conn, "/search/jql", {
          method: "POST",
          body: {
            jql,
            fields: ITEM_FIELDS,
            maxResults: Math.min(PAGE_SIZE, limit - items.length),
            ...(nextPageToken ? { nextPageToken } : {}),
          },
        });
        const page = asRecord(response.json);
        const issues = Array.isArray(page.issues) ? page.issues : [];
        for (const issue of issues) {
          const item = toItem(conn, issue);
          if (item) items.push(item);
          if (items.length >= limit) break;
        }
        nextPageToken = page.isLast === true || !issues.length ? null : asString(page.nextPageToken);
      } while (nextPageToken && items.length < limit);
      return items;
    },

    getItem,
    listTransitions,

    async transition(conn, rawKey, toStatus, _correlationKey): Promise<TrackerWriteResult> {
      const key = assertJiraKey(rawKey);
      const current = await getItem(conn, key);
      if (!current) throw new TrackerProviderError("definite", `Jira issue ${key} was not found.`, 404);
      // Already there: the desired state holds, and no write is made.
      if (sameStatus(current.raw_status, toStatus)) return { externalId: `${key}:status:${current.raw_status}`, url: current.url ?? undefined };
      const transitions = await listTransitions(conn, key);
      const target = transitions.find((entry) => sameStatus(entry.toStatus, toStatus));
      if (!target) {
        throw new TrackerProviderError(
          "definite",
          `Jira issue ${key} has no transition from "${current.raw_status}" to "${toStatus}".`,
        );
      }
      await api(conn, `/issue/${encodeURIComponent(key)}/transitions`, {
        method: "POST",
        body: { transition: { id: target.id } },
        write: true,
      });
      return { externalId: `${key}:transition:${target.id}`, url: current.url ?? undefined };
    },

    async comment(conn, rawKey, body, correlationKey) {
      const key = assertJiraKey(rawKey);
      const response = await api(conn, `/issue/${encodeURIComponent(key)}/comment`, {
        method: "POST",
        body: {
          body: toAdf(body),
          // An entity property is invisible in Jira's UI and survives edits.
          properties: [{ key: JIRA_EFFECT_PROPERTY_KEY, value: { correlation_key: correlationKey } }],
        },
        write: true,
      });
      const id = asString(asRecord(response.json).id);
      if (!id) throw new TrackerProviderError("ambiguous", "Jira accepted the comment but returned no comment id.");
      return { externalId: id, url: siteLink(conn, `/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(id)}`) ?? undefined };
    },

    async findTransition(conn, rawKey, toStatus, since) {
      const key = assertJiraKey(rawKey);
      const sinceMs = Date.parse(since) - TRANSITION_SKEW_MS;
      const path = `/issue/${encodeURIComponent(key)}/changelog`;
      const first = asRecord((await api(conn, `${path}?maxResults=${PAGE_SIZE}`)).json);
      let values = Array.isArray(first.values) ? first.values : [];
      const total = Number(first.total);
      if (first.isLast === false && Number.isFinite(total) && total > PAGE_SIZE) {
        // The changelog is oldest first; the effect's change is in the last page.
        const last = asRecord((await api(conn, `${path}?startAt=${total - PAGE_SIZE}&maxResults=${PAGE_SIZE}`)).json);
        values = Array.isArray(last.values) ? last.values : values;
      }
      for (const entry of [...values].reverse()) {
        const history = asRecord(entry);
        const created = jiraTime(history.created);
        if (!created || Date.parse(created) < sinceMs) continue;
        const items = Array.isArray(history.items) ? history.items : [];
        const reached = items.some((item) => {
          const change = asRecord(item);
          return change.field === "status" && sameStatus(asString(change.toString) ?? "", toStatus);
        });
        if (reached) return { externalId: `${key}:changelog:${asString(history.id) ?? created}` };
      }
      return null;
    },

    async findComment(conn, rawKey, correlationKey) {
      const key = assertJiraKey(rawKey);
      const response = await api(conn, `/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=${PAGE_SIZE}&expand=properties`);
      const comments = Array.isArray(asRecord(response.json).comments) ? asRecord(response.json).comments as unknown[] : [];
      for (const entry of comments) {
        const comment = asRecord(entry);
        const properties = Array.isArray(comment.properties) ? comment.properties : [];
        const marked = properties.some((property) => {
          const record = asRecord(property);
          return record.key === JIRA_EFFECT_PROPERTY_KEY && asRecord(record.value).correlation_key === correlationKey;
        });
        const id = asString(comment.id);
        if (marked && id) {
          return { externalId: id, url: siteLink(conn, `/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(id)}`) ?? undefined };
        }
      }
      return null;
    },
  };
}
