import { createHash } from "node:crypto";

import { mapTicketState } from "../status-map.js";
import { asRecord, asString, trackerRequest } from "./http.js";
import { freshCredentials, type TokenRefresher } from "./oauth-refresh.js";
import { parseLinearWebhook, verifyLinearWebhook } from "./webhooks.js";
import {
  type ExternalItem,
  type LinearCredentials,
  type ListItemsOptions,
  type ProviderConnection,
  type WorkItemProvider,
  TrackerProviderError,
} from "./types.js";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d{1,12}$/;
const PAGE_SIZE = 50;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TRANSITION_SKEW_MS = 60_000;

const ISSUE_FIELDS = `
  id identifier title url updatedAt
  state { id name type }
  assignee { id name displayName }
  team { key }
`;

export interface LinearProviderOptions {
  fetchImpl?: typeof fetch;
  refresh?: TokenRefresher | null;
  now?: () => Date;
}

export function assertLinearKey(key: string): string {
  const normalized = key.trim().toUpperCase();
  if (!ISSUE_KEY.test(normalized)) throw new TrackerProviderError("definite", `"${key.slice(0, 40)}" is not a Linear issue key.`);
  return normalized;
}

/**
 * The comment id the journal asks Linear to use: a UUID derived from the
 * correlation key. Linear accepts client-chosen ids, so the comment is found
 * again by id and a duplicate create is refused by Linear itself.
 */
export function linearCommentId(correlationKey: string): string {
  const hex = createHash("sha256").update(`letagents-effect:${correlationKey}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Linear room filters: space-separated `team:<KEY>` and `project:<id>` terms.
 * An empty filter means every issue the credentials can read.
 */
export function parseLinearFilter(filter: string | null): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const term of (filter ?? "").trim().split(/\s+/).filter(Boolean)) {
    const match = /^(team|project):([A-Za-z0-9_-]{1,64})$/.exec(term);
    if (!match) throw new TrackerProviderError("definite", `Linear filter term "${term.slice(0, 40)}" is not team:<KEY> or project:<id>.`);
    if (match[1] === "team") result.team = { key: { eq: match[2].toUpperCase() } };
    else result.project = { id: { eq: match[2] } };
  }
  return result;
}

function sameStatus(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function createLinearProvider(options: LinearProviderOptions = {}): WorkItemProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  async function graphql(
    conn: ProviderConnection,
    query: string,
    variables: Record<string, unknown> = {},
    write = false,
  ): Promise<Record<string, unknown>> {
    const credentials = await freshCredentials(conn as ProviderConnection<LinearCredentials>, options.refresh ?? null, now);
    const token = credentials.kind === "api_token" ? credentials.api_key : credentials.access_token;
    const authorization = credentials.kind === "api_token" ? token : `Bearer ${token}`;
    const response = await trackerRequest(fetchImpl, {
      url: LINEAR_GRAPHQL,
      method: "POST",
      body: { query, variables },
      headers: { Authorization: authorization },
      secrets: [token, credentials.kind === "oauth" ? credentials.refresh_token : null],
      write,
    });
    const payload = asRecord(response.json);
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length) {
      const first = asRecord(errors[0]);
      const extensions = asRecord(first.extensions);
      const message = (asString(first.message) ?? "Linear request failed").slice(0, 300);
      const code = String(extensions.code ?? extensions.type ?? "").toUpperCase();
      if (code.includes("AUTHENTICATION")) throw new TrackerProviderError("auth", `Linear: ${message}`);
      if (/not found/i.test(message) || code.includes("NOT_FOUND")) throw new TrackerProviderError("definite", `Linear: ${message}`, 404);
      // GraphQL validation runs before any change, so a write refused with
      // errors made no change.
      throw new TrackerProviderError("definite", `Linear: ${message}`);
    }
    return asRecord(payload.data);
  }

  function toItem(conn: ProviderConnection, issue: unknown): ExternalItem | null {
    const record = asRecord(issue);
    const key = asString(record.identifier);
    if (!key) return null;
    const state = asRecord(record.state);
    const rawStatus = asString(state.name) ?? "Unknown";
    const assignee = asRecord(record.assignee);
    const mapped = mapTicketState(conn.status_map, { name: rawStatus, type: asString(state.type) });
    return {
      provider: "linear",
      key,
      title: asString(record.title) ?? key,
      ticket_state: mapped.ticket_state,
      raw_status: rawStatus,
      unmapped: mapped.unmapped,
      assignee_id: asString(assignee.id),
      assignee_label: asString(assignee.displayName) ?? asString(assignee.name),
      url: asString(record.url),
      tracker_updated_at: asString(record.updatedAt),
      payload: {
        id: asString(record.id),
        state_type: asString(state.type),
        team_key: asString(asRecord(record.team).key),
      },
    };
  }

  async function getIssue(conn: ProviderConnection, key: string, extra = ""): Promise<Record<string, unknown> | null> {
    try {
      const data = await graphql(conn, `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} ${extra} } }`, { id: key });
      const issue = asRecord(data.issue);
      return asString(issue.id) ? issue : null;
    } catch (error) {
      if (error instanceof TrackerProviderError && error.status === 404) return null;
      throw error;
    }
  }

  function teamStates(issue: Record<string, unknown>): Array<{ id: string; name: string }> {
    const nodes = asRecord(asRecord(issue.teamStates).states).nodes;
    return (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
      const record = asRecord(node);
      const id = asString(record.id);
      const name = asString(record.name);
      return id && name ? [{ id, name }] : [];
    });
  }

  const TEAM_STATES = "teamStates: team { states(first: 100) { nodes { id name type } } }";

  async function findComment(conn: ProviderConnection, rawKey: string, correlationKey: string) {
    const key = assertLinearKey(rawKey);
    try {
      const data = await graphql(conn, "query Comment($id: String!) { comment(id: $id) { id url issue { identifier } } }", {
        id: linearCommentId(correlationKey),
      });
      const comment = asRecord(data.comment);
      const id = asString(comment.id);
      if (!id || asString(asRecord(comment.issue).identifier) !== key) return null;
      return { externalId: id, url: asString(comment.url) ?? undefined };
    } catch (error) {
      if (error instanceof TrackerProviderError && error.status === 404) return null;
      throw error;
    }
  }

  return {
    name: "linear",

    async whoAmI(conn) {
      const data = await graphql(conn, "query Me { viewer { id name displayName email } organization { id name urlKey } }");
      const viewer = asRecord(data.viewer);
      const organization = asRecord(data.organization);
      const id = asString(viewer.id);
      if (!id) throw new TrackerProviderError("auth", "Linear did not return the signed-in user.");
      const orgId = asString(organization.id);
      const urlKey = asString(organization.urlKey);
      return {
        id,
        label: asString(viewer.displayName) ?? asString(viewer.name) ?? asString(viewer.email) ?? id,
        site: orgId
          ? {
              key: orgId,
              url: urlKey && /^[A-Za-z0-9_-]{1,64}$/.test(urlKey) ? `https://linear.app/${urlKey}` : null,
              name: asString(organization.name) ?? "Linear",
            }
          : undefined,
      };
    },

    async listItems(conn, filter, opts: ListItemsOptions) {
      const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const issueFilter = parseLinearFilter(filter);
      if (opts.assigneeMe) issueFilter.assignee = { isMe: { eq: true } };
      if (opts.updatedSince) {
        if (!Number.isFinite(Date.parse(opts.updatedSince))) throw new TrackerProviderError("definite", "updatedSince is not a valid time.");
        issueFilter.updatedAt = { gte: new Date(opts.updatedSince).toISOString() };
      }
      const items: ExternalItem[] = [];
      let after: string | null = null;
      do {
        const data = await graphql(
          conn,
          `query Issues($filter: IssueFilter, $first: Int!, $after: String) {
            issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
              nodes { ${ISSUE_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { filter: issueFilter, first: Math.min(PAGE_SIZE, limit - items.length), after },
        );
        const issues = asRecord(data.issues);
        const nodes = Array.isArray(issues.nodes) ? issues.nodes : [];
        for (const node of nodes) {
          const item = toItem(conn, node);
          if (item) items.push(item);
          if (items.length >= limit) break;
        }
        const pageInfo = asRecord(issues.pageInfo);
        after = pageInfo.hasNextPage === true && nodes.length ? asString(pageInfo.endCursor) : null;
      } while (after && items.length < limit);
      return items;
    },

    async getItem(conn, rawKey) {
      const key = assertLinearKey(rawKey);
      const issue = await getIssue(conn, key);
      return issue ? toItem(conn, issue) : null;
    },

    async listTransitions(conn, rawKey) {
      const key = assertLinearKey(rawKey);
      const issue = await getIssue(conn, key, TEAM_STATES);
      if (!issue) return [];
      return teamStates(issue).map((state) => ({ id: state.id, toStatus: state.name }));
    },

    async transition(conn, rawKey, toStatus, _correlationKey) {
      const key = assertLinearKey(rawKey);
      const issue = await getIssue(conn, key, TEAM_STATES);
      if (!issue) throw new TrackerProviderError("definite", `Linear issue ${key} was not found.`, 404);
      const current = asString(asRecord(issue.state).name) ?? "";
      const url = asString(issue.url) ?? undefined;
      if (sameStatus(current, toStatus)) return { externalId: `${key}:status:${current}`, url };
      const target = teamStates(issue).find((state) => sameStatus(state.name, toStatus));
      if (!target) throw new TrackerProviderError("definite", `Linear issue ${key}'s team has no status "${toStatus}".`);
      const data = await graphql(
        conn,
        "mutation Move($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
        { id: asString(issue.id), stateId: target.id },
        true,
      );
      if (asRecord(data.issueUpdate).success !== true) {
        throw new TrackerProviderError("ambiguous", `Linear did not confirm moving ${key} to "${toStatus}".`);
      }
      return { externalId: `${key}:state:${target.id}`, url };
    },

    async comment(conn, rawKey, body, correlationKey) {
      const key = assertLinearKey(rawKey);
      const issue = await getIssue(conn, key);
      if (!issue) throw new TrackerProviderError("definite", `Linear issue ${key} was not found.`, 404);
      try {
        const data = await graphql(
          conn,
          "mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }",
          { input: { id: linearCommentId(correlationKey), issueId: asString(issue.id), body } },
          true,
        );
        const result = asRecord(data.commentCreate);
        const comment = asRecord(result.comment);
        const id = asString(comment.id);
        if (result.success !== true || !id) throw new TrackerProviderError("ambiguous", "Linear did not confirm the comment.");
        return { externalId: id, url: asString(comment.url) ?? undefined };
      } catch (error) {
        // The id is fixed per effect: a refused create may mean an earlier
        // attempt already wrote it.
        if (error instanceof TrackerProviderError && error.outcome === "definite") {
          const existing = await findComment(conn, key, correlationKey);
          if (existing) return existing;
        }
        throw error;
      }
    },

    async findTransition(conn, rawKey, toStatus, since) {
      const key = assertLinearKey(rawKey);
      const sinceMs = Date.parse(since) - TRANSITION_SKEW_MS;
      const issue = await getIssue(conn, key, "history(first: 50) { nodes { id createdAt toState { name } } }");
      if (!issue) return null;
      const nodes = asRecord(issue.history).nodes;
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const entry = asRecord(node);
        const createdAt = Date.parse(asString(entry.createdAt) ?? "");
        const reached = asString(asRecord(entry.toState).name);
        if (reached && sameStatus(reached, toStatus) && Number.isFinite(createdAt) && createdAt >= sinceMs) {
          return { externalId: `${key}:history:${asString(entry.id) ?? createdAt}` };
        }
      }
      return null;
    },

    findComment,

    verifyWebhook: verifyLinearWebhook,
    parseWebhook: parseLinearWebhook,
  };
}
