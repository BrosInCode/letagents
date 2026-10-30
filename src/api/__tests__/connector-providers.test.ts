import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_STATUS_MAPS } from "../../../shared/ticket-connectors.mjs";
import { createJiraProvider, JIRA_EFFECT_PROPERTY_KEY, toAdf } from "../connectors/providers/jira.js";
import { createLinearProvider, linearCommentId, parseLinearFilter } from "../connectors/providers/linear.js";
import {
  type JiraCredentials,
  type LinearCredentials,
  type ProviderConnection,
  TrackerProviderError,
} from "../connectors/providers/types.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "connectors");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: RecordedCall) => { status?: number; json?: unknown } | undefined;

/** A fetch that answers from fixtures and fails any request it does not know. */
function fakeFetch(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body ?? null,
    };
    assert.equal(init?.redirect, "manual", "tracker requests must not follow redirects");
    calls.push(call);
    for (const route of routes) {
      const answer = route(call);
      if (answer) {
        const status = answer.status ?? 200;
        return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), { status });
      }
    }
    throw new Error(`Unexpected live request in a fixture test: ${call.method} ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

function jiraConnection(credentials?: Partial<JiraCredentials>): ProviderConnection<JiraCredentials> {
  return {
    id: "tcon_jira",
    provider: "jira",
    auth_kind: "api_token",
    status_map: { ...DEFAULT_STATUS_MAPS.jira },
    tracker_user_id: "5b10ac8d82e05b22cc7d4ef5",
    credentials: { kind: "api_token", site_url: "https://acme.atlassian.net", email: "emmy@example.com", api_token: "ATATT3xFfGF0tokenvalue1234567890", ...credentials } as JiraCredentials,
    async saveCredentials() { return true; },
  };
}

function linearConnection(credentials?: LinearCredentials): ProviderConnection<LinearCredentials> {
  return {
    id: "tcon_linear",
    provider: "linear",
    auth_kind: "api_token",
    status_map: { ...DEFAULT_STATUS_MAPS.linear },
    tracker_user_id: "9a3c1d2e-4f5a-4b6c-8d7e-0f1a2b3c4d5e",
    credentials: credentials ?? { kind: "api_token", api_key: "lin_api_abcdefghijklmnopqrstuvwxyz" },
    async saveCredentials() { return true; },
  };
}

const at = (method: string, pattern: RegExp, json: unknown, status = 200): Route =>
  (call) => (call.method === method && pattern.test(call.url) ? { status, json } : undefined);

test("Jira lists assigned issues over two search pages and maps statuses", async () => {
  const { impl, calls } = fakeFetch([
    (call) => call.url.endsWith("/rest/api/3/search/jql") && !(call.body as { nextPageToken?: string }).nextPageToken
      ? { json: fixture("jira-search-assigned") } : undefined,
    (call) => call.url.endsWith("/rest/api/3/search/jql") ? { json: fixture("jira-search-page2") } : undefined,
  ]);
  const jira = createJiraProvider({ fetchImpl: impl, env: {} });
  const items = await jira.listItems(jiraConnection(), "project = HT ORDER BY created", { assigneeMe: true, limit: 5 });
  assert.deepEqual(items.map((item) => [item.key, item.raw_status, item.ticket_state, item.unmapped]), [
    ["HT-1234", "In Progress", "in_progress", false],
    ["HT-1240", "Code Review", "in_review", false],
    // Not named in the map: its status category (indeterminate) maps it.
    ["HT-1251", "Blocked", "in_progress", false],
    ["HT-1260", "To Do", "todo", false],
    ["HT-1261", "Done", "done", false],
  ]);
  assert.equal(items[0].url, "https://acme.atlassian.net/browse/HT-1234");
  assert.equal(items[0].tracker_updated_at, "2026-10-20T07:15:02.123Z");
  assert.equal(items[4].assignee_id, null);
  const firstBody = calls[0].body as { jql: string; maxResults: number };
  assert.equal(firstBody.jql, "(project = HT) AND assignee = currentUser() ORDER BY updated DESC");
  assert.equal(firstBody.maxResults, 5);
  assert.equal((calls[1].body as { nextPageToken: string; maxResults: number }).nextPageToken, "CAEaAggD");
  assert.equal((calls[1].body as { maxResults: number }).maxResults, 2);
  assert.match(calls[0].headers.Authorization, /^Basic /);
});

test("Jira filters cannot break out of their group", async () => {
  const { impl, calls } = fakeFetch([at("POST", /\/search\/jql$/, { issues: [], isLast: true })]);
  const jira = createJiraProvider({ fetchImpl: impl, env: {} });
  for (const filter of ["x) OR (project = SECRET", "project = HT)", "summary ~ \"(\" AND (a = b", "summary ~ \"open"]) {
    await assert.rejects(jira.listItems(jiraConnection(), filter, {}), TrackerProviderError, filter);
  }
  assert.equal(calls.length, 0);
  await jira.listItems(jiraConnection(), "summary ~ \"a ) b\" AND (labels = x)", {});
  assert.equal((calls[0].body as { jql: string }).jql, "(summary ~ \"a ) b\" AND (labels = x)) ORDER BY updated DESC");
});

test("an OAuth refresh another process already saved is reused instead of refreshing again", async () => {
  const { impl, calls } = fakeFetch([at("GET", /\/myself$/, fixture("jira-myself"))]);
  let refreshes = 0;
  const jira = createJiraProvider({ fetchImpl: impl, env: {}, refresh: async () => { refreshes += 1; throw new Error("unused"); } });
  const base = {
    kind: "oauth" as const,
    cloud_id: "11111111-2222-3333-4444-555555555555",
    site_url: "https://acme.atlassian.net",
    refresh_token: "r",
  };
  const conn: ProviderConnection = {
    ...jiraConnection(),
    id: "tcon_reload",
    auth_kind: "oauth",
    credentials: { ...base, access_token: "stale", expires_at: new Date(Date.now() - 1).toISOString() },
    async saveCredentials() { return true; },
    async reload() { return { ...base, access_token: "fresh-from-db", expires_at: new Date(Date.now() + 3_600_000).toISOString() }; },
  };
  await jira.whoAmI(conn);
  assert.equal(refreshes, 0);
  assert.equal(calls[0].headers.Authorization, "Bearer fresh-from-db");
});

test("a refresh that loses the compare-and-set uses the winner's tokens; a refused refresh waits for them", async () => {
  const { impl, calls } = fakeFetch([at("GET", /\/myself$/, fixture("jira-myself"))]);
  const base = {
    kind: "oauth" as const,
    cloud_id: "11111111-2222-3333-4444-555555555555",
    site_url: "https://acme.atlassian.net",
    refresh_token: "r",
  };
  const expired = { ...base, access_token: "stale", expires_at: new Date(Date.now() - 1).toISOString() };
  let stored: Record<string, unknown> = expired;
  const jira = createJiraProvider({
    fetchImpl: impl,
    env: {},
    refresh: async () => {
      // Another process refreshes first and saves.
      stored = { ...base, access_token: "winner", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      return { access_token: "loser", refresh_token: "r2", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    },
  });
  const conn: ProviderConnection = {
    ...jiraConnection(),
    id: "tcon_cas",
    auth_kind: "oauth",
    credentials: expired,
    async saveCredentials() { return false; },
    async reload() { return stored as JiraCredentials; },
  };
  await jira.whoAmI(conn);
  assert.equal(calls[0].headers.Authorization, "Bearer winner");

  stored = expired;
  const refused = createJiraProvider({
    fetchImpl: impl,
    env: {},
    refresh: async () => {
      setTimeout(() => { stored = { ...base, access_token: "other-process", expires_at: new Date(Date.now() + 3_600_000).toISOString() }; }, 100);
      throw new TrackerProviderError("auth", "invalid_grant", 400);
    },
  });
  await refused.whoAmI({ ...conn, id: "tcon_cas2", credentials: expired });
  assert.equal(calls[1].headers.Authorization, "Bearer other-process");
});

test("Jira API-token requests re-check the site and use OAuth's cloud host otherwise", async () => {
  const { impl, calls } = fakeFetch([at("GET", /\/rest\/api\/3\/myself$/, fixture("jira-myself"))]);
  const jira = createJiraProvider({ fetchImpl: impl, env: {} });
  await assert.rejects(jira.whoAmI(jiraConnection({ site_url: "https://169.254.169.254" })), /atlassian\.net/);
  assert.equal(calls.length, 0);
  const user = await jira.whoAmI({
    ...jiraConnection(),
    auth_kind: "oauth",
    credentials: {
      kind: "oauth",
      cloud_id: "11111111-2222-3333-4444-555555555555",
      site_url: "https://acme.atlassian.net",
      access_token: "oauth-access",
      refresh_token: "oauth-refresh",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  assert.deepEqual(user, { id: "5b10ac8d82e05b22cc7d4ef5", label: "Emmy May" });
  assert.equal(calls[0].url, "https://api.atlassian.com/ex/jira/11111111-2222-3333-4444-555555555555/rest/api/3/myself");
  assert.equal(calls[0].headers.Authorization, "Bearer oauth-access");
});

test("Jira OAuth tokens near expiry are refreshed once and saved before use", async () => {
  const { impl, calls } = fakeFetch([at("GET", /\/myself$/, fixture("jira-myself"))]);
  let refreshes = 0;
  const saved: unknown[] = [];
  const jira = createJiraProvider({
    fetchImpl: impl,
    env: {},
    refresh: async (refreshToken) => {
      refreshes += 1;
      assert.equal(refreshToken, "old-refresh");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { access_token: "new-access", refresh_token: "new-refresh", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    },
  });
  const conn: ProviderConnection = {
    ...jiraConnection(),
    auth_kind: "oauth",
    credentials: {
      kind: "oauth",
      cloud_id: "11111111-2222-3333-4444-555555555555",
      site_url: "https://acme.atlassian.net",
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: new Date(Date.now() + 10_000).toISOString(),
    },
    async saveCredentials(next) { saved.push(next); return true; },
  };
  await Promise.all([jira.whoAmI(conn), jira.whoAmI(conn)]);
  assert.equal(refreshes, 1);
  assert.equal(saved.length, 1);
  assert.ok(calls.every((call) => call.headers.Authorization === "Bearer new-access"));
});

test("Jira transition resolves the target status through the issue's transitions", async () => {
  const { impl, calls } = fakeFetch([
    at("GET", /\/issue\/HT-1234\?fields=/, fixture("jira-issue-ht-1234")),
    at("GET", /\/issue\/HT-1234\/transitions$/, fixture("jira-transitions-ht-1234")),
    at("POST", /\/issue\/HT-1234\/transitions$/, undefined, 204),
  ]);
  const jira = createJiraProvider({ fetchImpl: impl, env: {} });
  const result = await jira.transition(jiraConnection(), "ht-1234", "in review", "lae_x");
  assert.equal(result.externalId, "HT-1234:transition:31");
  const write = calls.find((call) => call.method === "POST");
  assert.deepEqual(write?.body, { transition: { id: "31" } });
});

test("Jira transition to the current status makes no write; an unknown status is a definite failure", async () => {
  const { impl, calls } = fakeFetch([
    at("GET", /\/issue\/HT-1234\?fields=/, fixture("jira-issue-ht-1234")),
    at("GET", /\/issue\/HT-1234\/transitions$/, fixture("jira-transitions-ht-1234")),
  ]);
  const jira = createJiraProvider({ fetchImpl: impl, env: {} });
  const same = await jira.transition(jiraConnection(), "HT-1234", "In Progress", "lae_x");
  assert.equal(same.externalId, "HT-1234:status:In Progress");
  await assert.rejects(
    jira.transition(jiraConnection(), "HT-1234", "Shipped", "lae_x"),
    (error: unknown) => error instanceof TrackerProviderError && error.outcome === "definite",
  );
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("Jira write failures: 5xx is ambiguous, 4xx definite, 401 auth; secrets never reach the message", async () => {
  for (const [status, outcome] of [[502, "ambiguous"], [400, "definite"], [401, "auth"]] as const) {
    const { impl } = fakeFetch([
      at("POST", /\/comment$/, { errorMessages: ["boom ATATT3xFfGF0tokenvalue1234567890"] }, status),
    ]);
    const jira = createJiraProvider({ fetchImpl: impl, env: {} });
    await assert.rejects(jira.comment(jiraConnection(), "HT-1234", "hi", "lae_x"), (error: unknown) => {
      assert.ok(error instanceof TrackerProviderError);
      assert.equal(error.outcome, outcome);
      assert.ok(!error.message.includes("ATATT3xFfGF0tokenvalue"), error.message);
      return true;
    });
  }
  const network = fakeFetch([]);
  const jira = createJiraProvider({ fetchImpl: network.impl, env: {} });
  await assert.rejects(jira.comment(jiraConnection(), "HT-1234", "hi", "lae_x"), (error: unknown) =>
    error instanceof TrackerProviderError && error.outcome === "ambiguous");
});

test("Jira refuses redirects so credentials never follow to another host", async () => {
  const { impl } = fakeFetch([at("GET", /\/myself$/, null, 302)]);
  const jira = createJiraProvider({ fetchImpl: impl, env: {} });
  await assert.rejects(jira.whoAmI(jiraConnection()), /redirect/);
});

test("Jira comments carry the correlation key as a hidden property and are found by it", async () => {
  const correlation = "lae_0123456789abcdef0123456789abcdef";
  const { impl, calls } = fakeFetch([
    at("POST", /\/issue\/HT-1234\/comment$/, fixture("jira-comment-created"), 201),
    at("GET", /\/issue\/HT-1234\/comment\?orderBy=-created&maxResults=100&expand=properties$/, fixture("jira-comments-with-marker")),
  ]);
  const jira = createJiraProvider({ fetchImpl: impl, env: {} });
  const created = await jira.comment(jiraConnection(), "HT-1234", "PR #88 opened\n\nby Ada", correlation);
  assert.equal(created.externalId, "20055");
  const body = calls[0].body as { body: unknown; properties: Array<{ key: string; value: unknown }> };
  assert.deepEqual(body.properties, [{ key: JIRA_EFFECT_PROPERTY_KEY, value: { correlation_key: correlation } }]);
  assert.deepEqual(body.body, toAdf("PR #88 opened\n\nby Ada"));
  assert.ok(!JSON.stringify(body.body).includes(correlation), "the marker is not in the visible text");
  assert.equal((await jira.findComment(jiraConnection(), "HT-1234", correlation))?.externalId, "20055");
  assert.equal(await jira.findComment(jiraConnection(), "HT-1234", "lae_ffffffffffffffffffffffffffffffff"), null);
});

test("Jira reconciles a transition from the changelog after the effect started", async () => {
  const { impl } = fakeFetch([at("GET", /\/issue\/HT-1234\/changelog\?maxResults=100$/, fixture("jira-changelog-ht-1234"))]);
  const jira = createJiraProvider({ fetchImpl: impl, env: {} });
  const found = await jira.findTransition(jiraConnection(), "HT-1234", "In Review", "2026-10-21T10:00:00.000Z");
  assert.equal(found?.externalId, "HT-1234:changelog:30002");
  assert.equal(await jira.findTransition(jiraConnection(), "HT-1234", "Done", "2026-10-21T10:00:00.000Z"), null);
  assert.equal(await jira.findTransition(jiraConnection(), "HT-1234", "In Progress", "2026-10-21T10:00:00.000Z"), null);
});

test("Jira rejects keys that are not issue keys before any request", async () => {
  const { impl, calls } = fakeFetch([]);
  const jira = createJiraProvider({ fetchImpl: impl, env: {} });
  await assert.rejects(jira.getItem(jiraConnection(), "../../myself"), TrackerProviderError);
  assert.equal(calls.length, 0);
});

test("Linear lists assigned issues and maps by state name, then state type", async () => {
  const { impl, calls } = fakeFetch([at("POST", /api\.linear\.app\/graphql$/, fixture("linear-issues-assigned"))]);
  const linear = createLinearProvider({ fetchImpl: impl });
  const items = await linear.listItems(linearConnection(), "team:bil", { assigneeMe: true, limit: 5 });
  assert.deepEqual(items.map((item) => [item.key, item.ticket_state, item.unmapped]), [
    ["BIL-12", "in_progress", false],
    ["BIL-15", "in_review", false],
    ["BIL-17", "in_progress", true],
  ]);
  const variables = (calls[0].body as { variables: { filter: unknown; first: number } }).variables;
  assert.deepEqual(variables.filter, { team: { key: { eq: "BIL" } }, assignee: { isMe: { eq: true } } });
  assert.equal(variables.first, 5);
  assert.equal(calls[0].headers.Authorization, "lin_api_abcdefghijklmnopqrstuvwxyz");
  assert.throws(() => parseLinearFilter("team:BIL state:\"x\""), TrackerProviderError);
});

test("Linear whoAmI reports the workspace as the connection's site", async () => {
  const { impl, calls } = fakeFetch([at("POST", /graphql$/, fixture("linear-viewer"))]);
  const linear = createLinearProvider({ fetchImpl: impl });
  const user = await linear.whoAmI(linearConnection({ kind: "oauth", access_token: "lin_oauth_tok", refresh_token: null, expires_at: null }));
  assert.deepEqual(user, {
    id: "9a3c1d2e-4f5a-4b6c-8d7e-0f1a2b3c4d5e",
    label: "emmy",
    site: { key: "org-7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910", url: "https://linear.app/herotel", name: "Herotel" },
  });
  assert.equal(calls[0].headers.Authorization, "Bearer lin_oauth_tok");
});

test("Linear transition moves to the named team state; an authentication error is auth", async () => {
  const { impl, calls } = fakeFetch([
    (call) => /issueUpdate/.test(JSON.stringify(call.body)) ? { json: fixture("linear-update-success") } : undefined,
    at("POST", /graphql$/, fixture("linear-issue-with-states")),
  ]);
  const linear = createLinearProvider({ fetchImpl: impl });
  const result = await linear.transition(linearConnection(), "BIL-12", "In Review", "lae_x");
  assert.equal(result.externalId, "BIL-12:state:st-review");
  const update = calls.find((call) => /issueUpdate/.test(JSON.stringify(call.body)));
  assert.deepEqual((update?.body as { variables: unknown }).variables, { id: "1d2c3b4a-0000-4000-8000-000000000001", stateId: "st-review" });
  await assert.rejects(linear.transition(linearConnection(), "BIL-12", "Shipped", "lae_x"), /no status/);

  const denied = fakeFetch([at("POST", /graphql$/, fixture("linear-auth-error"))]);
  await assert.rejects(createLinearProvider({ fetchImpl: denied.impl }).getItem(linearConnection(), "BIL-12"), (error: unknown) =>
    error instanceof TrackerProviderError && error.outcome === "auth");
});

test("Linear comments use an id derived from the correlation key and are found by it", async () => {
  const correlation = "lae_0123456789abcdef0123456789abcdef";
  const commentId = linearCommentId(correlation);
  assert.match(commentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(linearCommentId(correlation), commentId);
  const swap = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll("COMMENT_ID", commentId));
  const { impl, calls } = fakeFetch([
    (call) => /commentCreate/.test(JSON.stringify(call.body)) ? { json: swap(fixture("linear-comment-created")) } : undefined,
    (call) => /comment\(id/.test(JSON.stringify(call.body))
      ? { json: (call.body as { variables: { id: string } }).variables.id === commentId ? swap(fixture("linear-comment-found")) : fixture("linear-not-found") }
      : undefined,
    at("POST", /graphql$/, fixture("linear-issue-with-states")),
  ]);
  const linear = createLinearProvider({ fetchImpl: impl });
  const created = await linear.comment(linearConnection(), "BIL-12", "PR #88 opened", correlation);
  assert.equal(created.externalId, commentId);
  const create = calls.find((call) => /commentCreate/.test(JSON.stringify(call.body)));
  assert.deepEqual((create?.body as { variables: unknown }).variables, {
    input: { id: commentId, issueId: "1d2c3b4a-0000-4000-8000-000000000001", body: "PR #88 opened" },
  });
  assert.equal((await linear.findComment(linearConnection(), "BIL-12", correlation))?.externalId, commentId);
  assert.equal(await linear.findComment(linearConnection(), "BIL-12", "lae_ffffffffffffffffffffffffffffffff"), null);
  assert.equal(await linear.findComment(linearConnection(), "BIL-99", correlation), null);
});

test("Linear reconciles a transition from issue history", async () => {
  const { impl } = fakeFetch([at("POST", /graphql$/, fixture("linear-issue-history"))]);
  const linear = createLinearProvider({ fetchImpl: impl });
  assert.equal((await linear.findTransition(linearConnection(), "BIL-12", "in review", "2026-10-21T10:00:00.000Z"))?.externalId, "BIL-12:history:h-2");
  assert.equal(await linear.findTransition(linearConnection(), "BIL-12", "In Progress", "2026-10-21T10:00:00.000Z"), null);
});
