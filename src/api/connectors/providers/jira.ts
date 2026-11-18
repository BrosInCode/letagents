import { releaseLabels, releaseOptions, type ReleaseField } from './release-fields.js';
import { mapTicketState } from "../status-map.js";
import { isAtlassianCloudId, normalizeJiraSiteUrl } from "../site-url.js";
import { asRecord, asString, trackerRequest } from "./http.js";
import { freshCredentials, type TokenRefresher } from "./oauth-refresh.js";
import { parseJiraWebhook, verifyJiraWebhook } from "./webhooks.js";
import { jiraIteration, planningEstimate, trackerAvatarUrl, type TrackerPlanning } from "./planning.js";
import {
  type ExternalItem,
  type ExternalItemDetail,
  type ExternalStatusChange,
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
const ITEM_FIELDS = ["summary", "status", "assignee", "updated", "labels"];
/** Fields only the API read model shows; sync does not ask for them. */
const DETAIL_FIELDS = ["fixVersions", "parent", "statuscategorychangedate"];
/** Changelog pages read for a status history (100 entries each). */
const MAX_HISTORY_PAGES = 10;
const PAGE_SIZE = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** How far back a changelog entry may precede the effect (clock skew). */
const TRANSITION_SKEW_MS = 60_000;
const PLANNING_FIELDS_TTL_MS = 5 * 60_000;

interface JiraPlanningFields { sprint: string[]; estimate: string | null; release: { id: string; name: string }[] }

/** No fixed custom-field IDs: each Jira site creates its own. Ambiguous estimates stay unknown. */
function discoverPlanningFields(value: unknown): JiraPlanningFields {
  const fields = Array.isArray(value) ? value.map(asRecord) : [];
  const id = (field: Record<string, unknown>) => {
    const value = asString(field.id);
    return value && /^customfield_\d+$/.test(value) ? value : null;
  };
  const sprint = fields.filter(field => asRecord(field.schema).custom === "com.pyxis.greenhopper.jira:gh-sprint")
    .flatMap(field => id(field) ? [id(field)!] : []);
  const estimates = fields.filter(field => asRecord(field.schema).type === "number"
    && /^(story points|story point estimate)$/i.test(asString(field.name)?.trim() ?? ""))
    .flatMap(field => id(field) ? [id(field)!] : []);
  const release = fields.flatMap(field => {
    const schema = asRecord(field.schema), fieldId = id(field), name = asString(field.name);
    return fieldId && name && name.length <= 240 && (schema.type === "boolean" || schema.type === "option"
      || (schema.type === "array" && schema.items === "option")) ? [{ id: fieldId, name }] : [];
  });
  return { sprint: [...new Set(sprint)], estimate: estimates.length === 1 ? estimates[0] : null, release };
}

function issuePlanning(fields: Record<string, unknown>, mapping: JiraPlanningFields | null): TrackerPlanning {
  const iterations = (mapping?.sprint ?? []).flatMap(field => {
    const values = fields[field];
    return (Array.isArray(values) ? values : values ? [values] : []).flatMap(value => {
      const sprint = jiraIteration(value);
      return sprint ? [sprint] : [];
    });
  });
  return {
    estimate: mapping?.estimate ? planningEstimate(fields[mapping.estimate]) : null,
    assigneeAvatarUrl: trackerAvatarUrl(asRecord(asRecord(fields.assignee).avatarUrls)["48x48"]),
    estimateAvailable: Boolean(mapping?.estimate && Object.hasOwn(fields, mapping.estimate)),
    iterationsAvailable: Boolean(mapping?.sprint.some(field => Object.hasOwn(fields, field))),
    iterations: [...new Map(iterations.map(sprint => [sprint.id, sprint])).values()],
  };
}

export interface JiraProviderOptions {
  fetchImpl?: typeof fetch;
  refresh?: TokenRefresher | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * Reads JQL the way Jira's lexer splits it: a backslash escapes the next
 * character inside a quoted string and in an unquoted word alike (`\'` in a
 * word is a literal quote, not the start of a string). Returns whether the
 * parentheses and quotes balance and whether a backslash appears outside a
 * quoted string.
 */
function scanJql(text: string): { balanced: boolean; bareBackslash: boolean } {
  let depth = 0;
  let quote: string | null = null;
  let bareBackslash = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      if (!quote) bareBackslash = true;
      index += 1;
    } else if (quote) {
      if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")" && --depth < 0) {
      break;
    }
  }
  return { balanced: depth === 0 && !quote, bareBackslash };
}

/**
 * A room filter's JQL, without a trailing ORDER BY. Parentheses must balance
 * outside quoted strings, so the filter cannot close the group this provider
 * wraps it in and widen the query past the clauses added after it.
 */
export function jiraFilterClause(filter: string | null): string | null {
  const base = filter?.replace(/\border\s+by\b[\s\S]*$/i, "").trim();
  if (!base) return null;
  if (!scanJql(base).balanced) throw new TrackerProviderError("definite", "The Jira filter has unbalanced parentheses or quotes.");
  return base;
}

/**
 * A caller's query (never a room admin's filter): as `jiraFilterClause`, and
 * no backslash outside a quoted string. An escape in an unquoted word is legal
 * JQL but has no use in a page query, and refusing it leaves no room for a
 * difference between this scanner and Jira's lexer to open a way out.
 */
export function jiraQueryClause(query: string): string | null {
  const clause = jiraFilterClause(query);
  if (clause && scanJql(clause).bareBackslash) {
    throw new TrackerProviderError("definite", "The Jira query has a backslash outside a quoted string.");
  }
  return clause;
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

/** Keys a custom field value keeps: what identifies an option, a user or a version. */
const RAW_FIELD_KEYS = ["id", "key", "name", "value", "displayName"] as const;

/**
 * A custom field's value without what a page has no need for: e-mail
 * addresses, avatar and self links, and anything nested deeper (a parent
 * issue's own fields, rich text). Objects keep only RAW_FIELD_KEYS with
 * plain values; a list keeps such objects and plain values.
 */
export function sanitizeRawFieldValue(value: unknown): unknown {
  const plain = (entry: unknown) => entry === null || ["string", "number", "boolean"].includes(typeof entry);
  const pick = (entry: Record<string, unknown>) => {
    const kept: Record<string, unknown> = {};
    for (const key of RAW_FIELD_KEYS) if (Object.hasOwn(entry, key) && plain(entry[key])) kept[key] = entry[key];
    return kept;
  };
  if (plain(value)) return value;
  if (Array.isArray(value)) {
    return value.flatMap((entry) => plain(entry) ? [entry] : entry && typeof entry === "object" && !Array.isArray(entry) ? [pick(entry as Record<string, unknown>)] : []);
  }
  return value && typeof value === "object" ? pick(value as Record<string, unknown>) : null;
}

function issueDetail(fields: Record<string, unknown>, statusCategory: string | null, rawFields: readonly string[]): ExternalItemDetail {
  const parentKey = asString(asRecord(fields.parent).key);
  const versions = Array.isArray(fields.fixVersions) ? fields.fixVersions.map(asRecord) : [];
  const raw: Record<string, unknown> = {};
  for (const id of rawFields) if (Object.hasOwn(fields, id)) raw[id] = sanitizeRawFieldValue(fields[id]);
  return {
    status_category: statusCategory,
    // The key only: the parent may be outside the room filter, so its title is not ours to show.
    parent: parentKey ? { key: parentKey } : null,
    fix_versions: versions.flatMap((version) => {
      const id = asString(version.id);
      const name = asString(version.name);
      return id && name ? [{
        id,
        name,
        released: typeof version.released === "boolean" ? version.released : null,
        release_date: asString(version.releaseDate),
      }] : [];
    }),
    labels: Array.isArray(fields.labels) ? fields.labels.filter((label): label is string => typeof label === "string") : [],
    status_changed_at: jiraTime(fields.statuscategorychangedate),
    fields: raw,
  };
}

function sameStatus(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function createJiraProvider(options: JiraProviderOptions = {}): WorkItemProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const planningFields = new Map<string, { expires: number; value: JiraPlanningFields | null }>();

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

  async function readPlanningFields(conn: ProviderConnection): Promise<JiraPlanningFields | null> {
    const cached = planningFields.get(conn.id);
    if (cached && cached.expires > now().getTime()) return cached.value;
    let value: JiraPlanningFields | null = null;
    try {
      value = discoverPlanningFields((await api(conn, "/field")).json);
    } catch {
      // Planning is optional. A denied metadata read must not stop the ticket's
      // normal import; the normal read below still checks ticket authorization.
    }
    if (planningFields.size >= 100) planningFields.clear();
    planningFields.set(conn.id, { value, expires: now().getTime() + PLANNING_FIELDS_TTL_MS });
    return value;
  }

  function fieldsWithPlanning(mapping: JiraPlanningFields | null | undefined, includeRelease = true): string[] {
    return [...ITEM_FIELDS, ...(mapping?.sprint ?? []), ...(mapping?.estimate ? [mapping.estimate] : []), ...(includeRelease ? mapping?.release.map(field => field.id) ?? [] : [])];
  }

  function toItem(conn: ProviderConnection, issue: unknown, mapping?: JiraPlanningFields | null, rawFields?: readonly string[]): ExternalItem | null {
    const record = asRecord(issue);
    const key = asString(record.key);
    if (!key) return null;
    const fields = asRecord(record.fields);
    const status = asRecord(fields.status);
    const rawStatus = asString(status.name) ?? "Unknown";
    const assignee = asRecord(fields.assignee);
    // Jira's status category (new, indeterminate, done) maps a status the map does not name.
    const statusCategory = asString(asRecord(status.statusCategory).key);
    const mapped = mapTicketState(conn.status_map, { name: rawStatus, type: statusCategory });
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
        status_category: statusCategory,
        releaseMetadataAvailable: mapping != null,
        releaseFields: [{ id: 'labels', name: 'Label', values: releaseLabels(fields.labels) },
          ...(mapping?.release.map(field => ({ ...field, values: Object.hasOwn(fields, field.id) ? releaseOptions(fields[field.id]) : null })) ?? [])] satisfies ReleaseField[],
        ...(mapping !== undefined ? { planning: issuePlanning(fields, mapping) } : {}),
      },
      ...(rawFields ? { detail: issueDetail(fields, statusCategory, rawFields) } : {}),
    };
  }

  async function getItem(conn: ProviderConnection, rawKey: string, opts?: { includePlanning?: boolean }): Promise<ExternalItem | null> {
    const key = assertJiraKey(rawKey);
    const mapping = opts?.includePlanning ? await readPlanningFields(conn) : undefined;
    // Use a read-only POST when site-defined fields could overflow a GET URL.
    // A denied optional read must not block the normal ticket import.
    if (mapping?.release.length) {
      try {
        const response = await api(conn, "/issue/bulkfetch", { method: "POST", body: { issueIdsOrKeys: [key], fields: fieldsWithPlanning(mapping) } });
        const issues = asRecord(response.json).issues;
        const issue = Array.isArray(issues) ? issues.find(issue => asString(asRecord(issue).key) === key) : null;
        if (issue) return toItem(conn, issue, mapping);
      } catch { /* The regular read below still enforces ticket authorization. */ }
    }
    try {
      const response = await api(conn, `/issue/${encodeURIComponent(key)}?fields=${fieldsWithPlanning(mapping, false).join(",")}`);
      const item = toItem(conn, response.json, mapping);
      if (item && mapping?.release.length) item.payload.releaseMetadataAvailable = false;
      return item;
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
      if (opts.extraFilter !== undefined) {
        // Each filter is checked and grouped on its own, so neither can close
        // the other's group: the result is always (room filter) AND (query).
        if (!base) throw new TrackerProviderError("definite", "A query needs a room filter to scope it.");
        const extra = jiraQueryClause(opts.extraFilter);
        if (extra) clauses.push(`(${extra})`);
      }
      if (opts.assigneeMe) clauses.push("assignee = currentUser()");
      if (opts.updatedSince) {
        const since = Date.parse(opts.updatedSince);
        if (!Number.isFinite(since)) throw new TrackerProviderError("definite", "updatedSince is not a valid time.");
        // Relative minutes avoid JQL's per-user time zone for absolute dates.
        const minutes = Math.max(1, Math.ceil((now().getTime() - since) / 60_000) + 1);
        clauses.push(`updated >= -${minutes}m`);
      }
      if (opts.updatedBefore) {
        const before = Date.parse(opts.updatedBefore);
        if (!Number.isFinite(before)) throw new TrackerProviderError("definite", "updatedBefore is not a valid time.");
        // Rounded toward now, so the bound never drops a ticket at the edge.
        const minutes = Math.max(0, Math.floor((now().getTime() - before) / 60_000));
        clauses.push(`updated <= -${minutes}m`);
      }
      const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`.trim();
      const mapping = opts.includePlanning ? await readPlanningFields(conn) : undefined;
      const rawFields = opts.detail ? [...new Set(opts.rawFields ?? [])] : undefined;
      const fields = rawFields ? [...new Set([...fieldsWithPlanning(mapping), ...DETAIL_FIELDS, ...rawFields])] : fieldsWithPlanning(mapping);
      const items: ExternalItem[] = [];
      let nextPageToken: string | null = null;
      do {
        const response = await api(conn, "/search/jql", {
          method: "POST",
          body: {
            jql,
            fields,
            maxResults: Math.min(PAGE_SIZE, limit - items.length),
            ...(nextPageToken ? { nextPageToken } : {}),
          },
        });
        const page = asRecord(response.json);
        const issues = Array.isArray(page.issues) ? page.issues : [];
        for (const issue of issues) {
          const item = toItem(conn, issue, mapping, rawFields);
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

    async listStatusHistory(conn, rawKey) {
      const key = assertJiraKey(rawKey);
      const changes: ExternalStatusChange[] = [];
      let startAt = 0;
      let complete = false;
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        let json: Record<string, unknown>;
        try {
          json = asRecord((await api(conn, `/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=${PAGE_SIZE}`)).json);
        } catch (error) {
          if (error instanceof TrackerProviderError && error.status === 404) return null;
          throw error;
        }
        const values = Array.isArray(json.values) ? json.values : [];
        for (const entry of values) {
          const history = asRecord(entry);
          const at = jiraTime(history.created);
          if (!at) continue;
          for (const item of Array.isArray(history.items) ? history.items : []) {
            const change = asRecord(item);
            const to = asString(change.toString);
            if (change.field === "status" && to) changes.push({ from: asString(change.fromString), to, at });
          }
        }
        startAt += values.length;
        if (json.isLast === true || values.length === 0 || (Number.isFinite(Number(json.total)) && startAt >= Number(json.total))) {
          complete = true;
          break;
        }
      }
      // Jira answers oldest first; a stable sort keeps two changes in one entry in order.
      changes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      return { changes, complete };
    },

    verifyWebhook: verifyJiraWebhook,
    parseWebhook: parseJiraWebhook,
  };
}
