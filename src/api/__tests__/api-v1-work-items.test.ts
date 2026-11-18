import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError } from "../../../shared/api/core.mjs";
import {
  getWorkItem,
  searchWorkItems,
  WORK_ITEM_PROVIDERS,
  WORK_ITEM_STATES,
  WorkItem,
} from "../../../shared/api/work-items.mjs";
import { DEFAULT_STATUS_MAPS, TICKET_STATES, TRACKER_PROVIDERS } from "../../../shared/ticket-connectors.mjs";
import type { JiraCredentials, ProviderConnection } from "../connectors/providers/types.js";
import type { RoomTrackerSource } from "../connectors/room-filters.js";
import type { ApiCallContext } from "../v1/context.js";

// The work-item read model with the real Jira provider over a fake Jira: no database.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { createJiraProvider } = await import("../connectors/providers/jira.js");
const { createWorkItemsReader, WORK_ITEMS_CACHE_TTL_MS } = await import("../connectors/work-items.js");
const { createWorkItemRoutes } = await import("../v1/areas/work-items.js");
const { allowedWorkItemFields } = await import("../v1/work-item-fields.js");

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "connectors");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));

const ROOM = "room-tickets";

function issue(key: string, status: string, category: "new" | "indeterminate" | "done", extra: Record<string, unknown> = {}) {
  return {
    id: `id-${key}`,
    key,
    fields: {
      summary: `Ticket ${key}`,
      status: { name: status, statusCategory: { key: category } },
      assignee: { accountId: "acc-1", displayName: "Emmy May" },
      updated: "2026-11-17T10:00:00.000+0000",
      labels: ["billing"],
      ...extra,
    },
  };
}

/**
 * A Jira that answers /field, /search/jql and /changelog. Search reads the
 * project and the key from the JQL the way Jira would; any JQL it does not
 * expect is recorded so a test can assert on it.
 */
function fakeJira() {
  const tickets = new Map<string, ReturnType<typeof issue>>();
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  let refuseKeys = false;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.endsWith("/rest/api/3/field")) {
      return json([
        { id: "customfield_10016", name: "Story Points", schema: { type: "number" } },
        { id: "customfield_10020", name: "Sprint", schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
      ]);
    }
    if (url.endsWith("/rest/api/3/search/jql")) {
      const jql = String(body?.jql ?? "");
      const project = /project = (\w+)/.exec(jql)?.[1];
      const key = /key = "([^"]+)"/.exec(jql)?.[1];
      if (key && refuseKeys) return json({ errorMessages: [`An issue with key '${key}' does not exist for field 'key'.`] }, 400);
      const issues = [...tickets.values()]
        .filter((entry) => !project || entry.key.startsWith(`${project}-`))
        .filter((entry) => !key || entry.key === key)
        .slice(0, Number(body?.maxResults ?? 50));
      return json({ issues, isLast: true });
    }
    if (/\/issue\/HT-1234\/changelog/.test(url)) return json(fixture("jira-changelog-ht-1234"));
    throw new Error(`Unexpected request in a fake Jira test: ${url}`);
  }) as typeof fetch;
  return { impl, calls, tickets, refuse: (value: boolean) => { refuseKeys = value; } };
}

function connection(): ProviderConnection<JiraCredentials> {
  return {
    id: "tcon_jira",
    provider: "jira",
    auth_kind: "api_token",
    status_map: { ...DEFAULT_STATUS_MAPS.jira },
    tracker_user_id: "acc-1",
    credentials: { kind: "api_token", site_url: "https://acme.atlassian.net", email: "emmy@example.com", api_token: "ATATT3xFfGF0tokenvalue1234567890" },
    async saveCredentials() { return true; },
  };
}

function setup(sources: RoomTrackerSource[] = [{ filter_id: "rtf_1", connection_id: "tcon_jira", provider: "jira", filter: "project = HT ORDER BY rank" }]) {
  const jira = fakeJira();
  const provider = createJiraProvider({ fetchImpl: jira.impl, env: {} });
  const state = { now: 1_000_000, generation: 0, sources, active: true, links: new Map<string, string>() };
  const reader = createWorkItemsReader({
    providers: { jira: provider, linear: provider, github: provider },
    sources: async () => state.sources,
    openConnection: async () => (state.active ? connection() : null),
    linkedTasks: async (_roomId, refs) => new Map(refs.flatMap((ref) => state.links.has(ref) ? [[ref, state.links.get(ref)!] as const] : [])),
    generation: () => state.generation,
    now: () => state.now,
  });
  const searches = () => jira.calls.filter((call) => call.url.endsWith("/search/jql"));
  return { reader, jira, state, searches };
}

async function rejectsWith(promise: Promise<unknown>, code: string, match?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError, String(error));
    assert.equal(error.code, code, error.message);
    if (match) assert.match(error.message, match);
    return true;
  });
}

test("a search runs (room filter) AND (query) and returns normalised tickets", async () => {
  const ctx = setup();
  ctx.jira.tickets.set("HT-1", issue("HT-1", "Code Review", "indeterminate", {
    parent: { key: "HT-100", fields: { summary: "Billing epic" } },
    fixVersions: [{ id: "10200", name: "2.4", released: false, releaseDate: "2026-12-01" }],
    statuscategorychangedate: "2026-11-16T08:30:00.000+0000",
    customfield_10016: 5,
    customfield_10020: [{ id: 42, name: "Sprint 42", state: "active", startDate: "2026-11-10T00:00:00.000Z", endDate: "2026-11-24T00:00:00.000Z" }],
    customfield_10050: { value: "Team Rocket" },
    customfield_10060: [{ accountId: "acc-2", displayName: "Bo", emailAddress: "bo@example.com", avatarUrls: { "48x48": "https://x" }, self: "https://acme.atlassian.net/rest/api/3/user?accountId=acc-2" }],
    customfield_10070: { key: "HR-5", fields: { summary: "Secret parent" }, self: "https://acme.atlassian.net/rest/api/3/issue/HR-5" },
  }));
  ctx.state.links.set("jira:HT-1", "task_7");

  const result = await ctx.reader.search(ROOM, { query: 'status = "Code Review"', limit: 20, fields: ["customfield_10050", "customfield_10060", "customfield_10070", "customfield_99999"] });

  const [call] = ctx.searches();
  assert.equal(call!.body!.jql, '(project = HT) AND (status = "Code Review") ORDER BY updated DESC');
  for (const field of ["fixVersions", "parent", "statuscategorychangedate", "customfield_10050", "customfield_10016", "customfield_10020"]) {
    assert.ok((call!.body!.fields as string[]).includes(field), field);
  }
  assert.equal(result.provider, "jira");
  assert.deepEqual(result.items, [{
    provider: "jira",
    key: "HT-1",
    title: "Ticket HT-1",
    url: "https://acme.atlassian.net/browse/HT-1",
    status: "Code Review",
    statusCategory: "in_progress",
    state: "in_review",
    assignee: { id: "acc-1", name: "Emmy May" },
    storyPoints: 5,
    sprints: [{ id: "42", name: "Sprint 42", state: "active", startDate: "2026-11-10", endDate: "2026-11-24" }],
    // The key only: the parent may be outside the room filter.
    parent: { key: "HT-100" },
    fixVersions: [{ id: "10200", name: "2.4", released: false, releaseDate: "2026-12-01" }],
    labels: ["billing"],
    statusChangedAt: "2026-11-16T08:30:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    linkedTask: { taskId: "task_7" },
    // Only fields the caller named; one the ticket lacks is absent. Objects
    // keep id, key, name, value and displayName: no e-mail, links or nested fields.
    fields: {
      customfield_10050: { value: "Team Rocket" },
      customfield_10060: [{ displayName: "Bo" }],
      customfield_10070: { key: "HR-5" },
    },
  }]);
  assert.ok(WorkItem.safeParse(result.items[0]).success);
});

test("a query cannot break out of the room filter", async () => {
  const ctx = setup();
  for (const query of [
    ") OR (project = HR",
    "project = HR) OR (project = HT",
    'summary ~ "open',
    "x) OR (y",
    // Jira reads \' and \" in an unquoted word as a literal quote, so these
    // close the group early in Jira while a quote-only scanner sees a string.
    "summary ~ \\'a ) OR key is not EMPTY OR ( summary ~ 'b\\'c'",
    'summary ~ \\"a ) OR key is not EMPTY OR ( summary ~ "b\\"c"',
    // An escaped backslash ends the quoted string; the ) after it is outside.
    "summary ~ 'a\\\\' ) OR (key is not EMPTY",
  ]) {
    await rejectsWith(ctx.reader.search(ROOM, { query, limit: 10 }), "invalid_input", /unbalanced/);
  }
  // Any backslash outside a quoted string is refused in a caller's query.
  for (const query of ["project = HT\\", "summary ~ \\\\'a ) OR (b'", "labels = a\\ b"]) {
    await rejectsWith(ctx.reader.search(ROOM, { query, limit: 10 }), "invalid_input", /backslash/);
  }
  assert.equal(ctx.jira.calls.length, 0, "no tracker request for a rejected query");
  // Escapes inside quoted strings and mixed quotes stay usable.
  await ctx.reader.search(ROOM, { query: `summary ~ "it's \\"quoted\\"" AND labels = 'say "hi"'`, limit: 10 });
  assert.equal(ctx.searches()[0]!.body!.jql, `(project = HT) AND (summary ~ "it's \\"quoted\\"" AND labels = 'say "hi"') ORDER BY updated DESC`);
});

test("a query Jira refuses is invalid_input without Jira's own text", async () => {
  const ctx = setup();
  const provider = createJiraProvider({
    fetchImpl: (async () => new Response(JSON.stringify({ errorMessages: ["The value 'SECRET' does not exist for the field 'project'."] }), { status: 400 })) as typeof fetch,
    env: {},
  });
  const reader = createWorkItemsReader({
    providers: { jira: provider, linear: provider, github: provider },
    sources: async () => [{ filter_id: "rtf_1", connection_id: "tcon_jira", provider: "jira", filter: "project = HT" }],
    openConnection: async () => connection(),
    linkedTasks: async () => new Map(),
    generation: () => ctx.state.generation,
  });
  await assert.rejects(reader.search(ROOM, { query: "project = SECRET", limit: 10 }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.deepEqual(error.toBody(), { code: "invalid_input", message: "query: Jira refused the query." });
    return true;
  });
});

test("a page reads only the custom fields its allowance names", async () => {
  const calls: Array<string[] | undefined> = [];
  const stub = {
    async search(_room: string, input: { fields?: string | string[] }) { calls.push(input.fields as string[] | undefined); return { provider: "jira" as const, items: [], fetchedAt: "2026-11-18T00:00:00.000Z" }; },
    async get() { throw new Error("unused"); },
    async history() { throw new Error("unused"); },
  };
  const person = { principal: { kind: "person" as const, id: "acct-1" }, roomId: ROOM };
  const page = { ...person, via: { kind: "page" as const, id: "page-1" } };
  const call = (actor: typeof person) => ({ room: { id: ROOM }, actor }) as unknown as ApiCallContext;
  const input = { query: "", limit: 10, fields: ["customfield_1", "customfield_2"] };

  const [search] = createWorkItemRoutes({ getReader: () => stub, allowedFields: (actor) => (actor.via ? ["customfield_1"] : null) });
  await search!.handler(input, call(person));
  await search!.handler({ ...input, fields: "customfield_1" }, call(page));
  await rejectsWith(Promise.resolve().then(() => search!.handler(input, call(page))), "not_granted", /customfield_2/);
  assert.deepEqual(calls, [["customfield_1", "customfield_2"], ["customfield_1"]]);

  // Until the pages registry answers, a page or a job reads no custom field; a person reads any.
  assert.equal(allowedWorkItemFields(person), null);
  assert.deepEqual(allowedWorkItemFields(page), []);
  assert.equal(allowedWorkItemFields({ ...person, via: { kind: "integration", id: "remote-mcp" } }), null);
});

test("no enabled, non-empty room filter on an active connection is no_source", async () => {
  const cases: Array<[string, RoomTrackerSource[]]> = [
    ["no filter (none, or disabled: the scope lists only enabled ones)", []],
    ["empty filter", [{ filter_id: "rtf_1", connection_id: "tcon_jira", provider: "jira", filter: "   " }]],
    ["only an ORDER BY", [{ filter_id: "rtf_1", connection_id: "tcon_jira", provider: "jira", filter: "ORDER BY rank" }]],
    ["broken filter", [{ filter_id: "rtf_1", connection_id: "tcon_jira", provider: "jira", filter: "project = HT)" }]],
    ["Linear only (not in v1)", [{ filter_id: "rtf_2", connection_id: "tcon_lin", provider: "linear", filter: "team:ENG" }]],
  ];
  for (const [label, sources] of cases) {
    const ctx = setup(sources);
    await rejectsWith(ctx.reader.search(ROOM, { query: "", limit: 10 }), "no_source");
    await rejectsWith(ctx.reader.get(ROOM, { key: "HT-1" }), "no_source");
    await rejectsWith(ctx.reader.history(ROOM, { key: "HT-1234" }), "no_source");
    assert.equal(ctx.jira.calls.length, 0, label);
  }

  const inactive = setup();
  inactive.state.active = false;
  await rejectsWith(inactive.reader.search(ROOM, { query: "", limit: 10 }), "no_source", /needs attention/);

  // Two providers: Jira by default; naming Linear names a source v1 cannot read.
  const both = setup([
    { filter_id: "rtf_2", connection_id: "tcon_lin", provider: "linear", filter: "team:ENG" },
    { filter_id: "rtf_1", connection_id: "tcon_jira", provider: "jira", filter: "project = HT" },
  ]);
  assert.equal((await both.reader.search(ROOM, { query: "", limit: 10 })).provider, "jira");
  await rejectsWith(both.reader.search(ROOM, { query: "", provider: "linear", limit: 10 }), "no_source", /Linear/);
  await rejectsWith(both.reader.search(ROOM, { query: "", provider: "github", limit: 10 }), "no_source");
});

test("get and history answer only for a ticket inside the room filter", async () => {
  const ctx = setup();
  ctx.jira.tickets.set("HT-1234", issue("HT-1234", "In Review", "indeterminate"));
  ctx.jira.tickets.set("HR-9", issue("HR-9", "Done", "done"));

  const ticket = await ctx.reader.get(ROOM, { key: "ht-1234" });
  assert.equal(ticket.key, "HT-1234");
  assert.equal(ctx.searches()[0]!.body!.jql, '(project = HT) AND (key = "HT-1234") ORDER BY updated DESC');

  await rejectsWith(ctx.reader.get(ROOM, { key: "HR-9" }), "not_found");
  await rejectsWith(ctx.reader.history(ROOM, { key: "HR-9" }), "not_found");
  assert.ok(!ctx.jira.calls.some((call) => call.url.includes("/HR-9/")), "no changelog read outside the filter");
  // Jira refuses JQL naming a key the credentials cannot see: also not_found.
  ctx.jira.refuse(true);
  await rejectsWith(ctx.reader.get(ROOM, { key: "HT-404" }), "not_found");
  ctx.jira.refuse(false);
  await rejectsWith(ctx.reader.get(ROOM, { key: "not a key" }), "invalid_input");

  const history = await ctx.reader.history(ROOM, { key: "HT-1234" });
  assert.deepEqual(history, {
    provider: "jira",
    key: "HT-1234",
    transitions: [
      { from: "To Do", to: "In Progress", at: "2026-10-19T10:00:00.000Z" },
      { from: "In Progress", to: "In Review", at: "2026-10-21T10:00:05.000Z" },
    ],
    complete: true,
  });
});

test("a cached search is answered until the room's sync generation moves", async () => {
  const ctx = setup();
  ctx.jira.tickets.set("HT-1", issue("HT-1", "To Do", "new"));
  const first = await ctx.reader.search(ROOM, { query: "", limit: 10 });
  assert.equal(first.items[0]!.status, "To Do");

  ctx.jira.tickets.set("HT-1", issue("HT-1", "Done", "done"));
  ctx.state.now += 1_000;
  assert.equal((await ctx.reader.search(ROOM, { query: "  ", limit: 10 })).items[0]!.status, "To Do", "same normalised query: cached");
  assert.equal(ctx.searches().length, 1);

  // applyItem bumps the generation after a change: the next search is live.
  ctx.state.generation += 1;
  const after = await ctx.reader.search(ROOM, { query: "", limit: 10 });
  assert.equal(after.items[0]!.status, "Done");
  assert.equal(after.items[0]!.statusCategory, "done");
  assert.equal(ctx.searches().length, 2);

  // And the cache expires on its own after 60 s.
  ctx.jira.tickets.set("HT-1", issue("HT-1", "In Progress", "indeterminate"));
  ctx.state.now += WORK_ITEMS_CACHE_TTL_MS;
  assert.equal((await ctx.reader.search(ROOM, { query: "", limit: 10 })).items[0]!.status, "In Progress");
});

test("at most 2 live searches per room per 10 s; callers of a cached search are not counted", async () => {
  const ctx = setup();
  ctx.jira.tickets.set("HT-1", issue("HT-1", "To Do", "new"));
  await ctx.reader.search(ROOM, { query: "labels = a", limit: 10 });
  await ctx.reader.search(ROOM, { query: "labels = b", limit: 10 });
  // Concurrent callers of one query share the read in flight.
  await Promise.all([ctx.reader.search(ROOM, { query: "labels = a", limit: 10 }), ctx.reader.search(ROOM, { query: "labels = a", limit: 10 })]);
  ctx.state.now += 4_000;
  await assert.rejects(ctx.reader.search(ROOM, { query: "labels = c", limit: 10 }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryAfterMs, 6_000);
    return true;
  });
  assert.equal(ctx.searches().length, 2);
  // Another room has its own budget.
  await ctx.reader.search("another-room", { query: "labels = c", limit: 10 });
  ctx.state.now += 6_000;
  await ctx.reader.search(ROOM, { query: "labels = c", limit: 10 });
  assert.equal(ctx.searches().length, 4);
});

test("the contract caps query length, limit and fields", () => {
  const ok = searchWorkItems.input.safeParse({ query: "x".repeat(2_000), limit: "200", fields: "customfield_1" });
  assert.ok(ok.success);
  assert.deepEqual(searchWorkItems.input.parse({}), { query: "", limit: 50 });
  assert.equal(searchWorkItems.input.safeParse({ query: "x".repeat(2_001) }).success, false);
  assert.equal(searchWorkItems.input.safeParse({ limit: "201" }).success, false);
  assert.equal(searchWorkItems.input.safeParse({ limit: "0" }).success, false);
  const fields = Array.from({ length: 21 }, (_, index) => `customfield_${index}`);
  assert.equal(searchWorkItems.input.safeParse({ fields }).success, false);
  assert.ok(searchWorkItems.input.safeParse({ fields: fields.slice(0, 20) }).success);
  assert.equal(searchWorkItems.input.safeParse({ fields: ["summary"] }).success, false, "only custom field ids");
  assert.equal(getWorkItem.input.safeParse({ key: "HT-1", fields: ["customfield_1"], extra: 1 }).success, false);
  // The contract's enums follow the connector lists.
  assert.deepEqual([...WORK_ITEM_PROVIDERS], [...TRACKER_PROVIDERS]);
  assert.deepEqual([...WORK_ITEM_STATES], [...TICKET_STATES]);
});
