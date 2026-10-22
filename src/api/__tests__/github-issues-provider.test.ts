import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_STATUS_MAPS } from "../../../shared/ticket-connectors.mjs";
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { applyGitHubIssuesEvent } = await import("../connectors/github-issues-events.js");
import {
  ACCESS_REFUSED,
  createGitHubIssuesProvider,
  GitHubAccessRefusedError,
  githubFilterAllows,
  type GitHubAppDirectory,
  parseGitHubFilter,
  parseGitHubIssuesWebhook,
} from "../connectors/providers/github.js";
import {
  type ExternalItem,
  type GitHubAppCredentials,
  type ProviderConnection,
  TrackerProviderError,
} from "../connectors/providers/types.js";
import type { TrackerConnectionRow } from "../connectors/store.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "connectors");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_KEY = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const INSTALLATION = "55500001";

interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Route = (call: RecordedCall) => { status?: number; json?: unknown } | undefined;

/** A fetch that answers from fixtures and fails any request it does not know: no live network. */
function fakeFetch(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null,
    };
    assert.equal(init?.redirect, "manual", "GitHub requests must not follow redirects");
    calls.push(call);
    for (const route of routes) {
      const answer = route(call);
      if (answer) return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), { status: answer.status ?? 200 });
    }
    throw new Error(`Unexpected live request in a fixture test: ${call.method} ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

const mint: Route = (call) => call.method === "POST" && call.url.pathname === `/app/installations/${INSTALLATION}/access_tokens`
  ? { status: 201, json: fixture("github-installation-token") }
  : undefined;
const permission = (name: "github-permission-read" | "github-permission-none"): Route => (call) =>
  /\/collaborators\/EmmyMay\/permission$/.test(call.url.pathname) ? { json: fixture(name) } : undefined;

/** The server's App records: one installation holding BrosInCode/letagents and BrosInCode/secret-roadmap. */
function directory(overrides: Partial<GitHubAppDirectory> = {}): GitHubAppDirectory {
  return {
    async appCredentials() { return { appId: "123456", privateKey: APP_KEY }; },
    async repositoryInstallation(repo) {
      return repo === "brosincode/letagents" || repo === "brosincode/secret-roadmap" ? { installation_id: INSTALLATION } : null;
    },
    async installation(id) { return id === INSTALLATION ? { installation_id: INSTALLATION, target_login: "BrosInCode" } : null; },
    ...overrides,
  };
}

function connection(credentials: Partial<GitHubAppCredentials> = {}): ProviderConnection<GitHubAppCredentials> {
  return {
    id: "tcon_github",
    provider: "github",
    auth_kind: "github_app",
    status_map: { ...DEFAULT_STATUS_MAPS.github },
    tracker_user_id: "31524469",
    credentials: { kind: "github_app", installation_id: INSTALLATION, login: "EmmyMay", ...credentials },
    async saveCredentials() { return true; },
  };
}

const now = () => new Date("2026-10-22T12:00:00Z");

test("a repository filter reads open issues with a token GitHub limits to that repository, read only", async () => {
  const fetch = fakeFetch([
    mint,
    permission("github-permission-read"),
    (call) => call.url.pathname === "/repos/brosincode/letagents/issues" ? { json: fixture("github-repo-issues") } : undefined,
  ]);
  const provider = createGitHubIssuesProvider({ fetchImpl: fetch.impl, directory: directory(), now });

  const items = await provider.listItems(connection(), "BrosInCode/letagents", { limit: 50 });

  assert.deepEqual(items.map((item) => [item.key, item.raw_status, item.ticket_state, item.unmapped]), [
    ["brosincode/letagents#43", "Open", "todo", false],
    ["brosincode/letagents#42", "Open (assigned)", "in_progress", false],
    ["brosincode/letagents#40", "Closed", "done", false],
  ], "the pull request in the list is not an issue, and labels never decide the state");
  const issue = items[1]!;
  assert.equal(issue.provider, "github");
  assert.equal(issue.assignee_id, "31524469");
  assert.equal(issue.assignee_label, "EmmyMay");
  assert.equal(issue.url, "https://github.com/BrosInCode/letagents/issues/42");
  assert.deepEqual(issue.payload, { repo: "brosincode/letagents", number: 42, state: "open", state_reason: null });

  const minted = fetch.calls.filter((call) => call.url.pathname.endsWith("/access_tokens"));
  assert.equal(minted.length, 1, "the scoped token is reused");
  assert.deepEqual(minted[0]!.body, { repositories: ["letagents"], permissions: { issues: "read", metadata: "read" } });
  const list = fetch.calls.find((call) => call.url.pathname.endsWith("/issues"))!;
  assert.equal(list.headers.Authorization, "Bearer fixture-installation-token");
  assert.equal(list.url.searchParams.get("state"), "open", "the first read imports open issues only");
  assert.equal(list.url.searchParams.get("since"), null);
});

test("a later poll reads every change since the cursor, closed issues included", async () => {
  const fetch = fakeFetch([
    mint,
    permission("github-permission-read"),
    (call) => call.url.pathname === "/repos/brosincode/letagents/issues" ? { json: fixture("github-repo-issues") } : undefined,
  ]);
  const provider = createGitHubIssuesProvider({ fetchImpl: fetch.impl, directory: directory(), now });
  const items = await provider.listItems(connection(), "brosincode/letagents", {
    updatedSince: "2026-10-21T00:00:00.000Z",
    updatedBefore: "2026-10-22T09:30:00.000Z",
    limit: 50,
  });
  const list = fetch.calls.find((call) => call.url.pathname.endsWith("/issues"))!;
  assert.equal(list.url.searchParams.get("state"), "all");
  assert.equal(list.url.searchParams.get("since"), "2026-10-21T00:00:00.000Z");
  assert.deepEqual(items.map((item) => item.key), ["brosincode/letagents#42", "brosincode/letagents#40"], "issues updated after updatedBefore are left for the next page");
});

test("a repository outside the connection's installation is refused before any GitHub request", async () => {
  const fetch = fakeFetch([]);
  const provider = createGitHubIssuesProvider({
    fetchImpl: fetch.impl,
    directory: directory({ async repositoryInstallation(repo) { return repo === "other-org/app" ? { installation_id: "99999" } : null; } }),
    now,
  });
  for (const filter of ["other-org/app", "someone/unknown"]) {
    await assert.rejects(provider.listItems(connection(), filter, {}), (error: unknown) =>
      error instanceof TrackerProviderError && error.outcome === "definite" && error.status === ACCESS_REFUSED
      && /cannot read .* through its GitHub App/.test(error.message));
  }
  await assert.rejects(provider.getItem(connection(), "other-org/app#1"), /cannot read other-org\/app/);
  assert.equal(fetch.calls.length, 0, "no token is minted for a repository of another installation");
});

test("a login that cannot read the repository on GitHub gets nothing, even though the App can read it", async () => {
  const fetch = fakeFetch([mint, permission("github-permission-none")]);
  const provider = createGitHubIssuesProvider({ fetchImpl: fetch.impl, directory: directory(), now });
  await assert.rejects(provider.listItems(connection(), "brosincode/secret-roadmap", {}), (error: unknown) =>
    error instanceof GitHubAccessRefusedError && error.status === ACCESS_REFUSED && /cannot read brosincode\/secret-roadmap/.test(error.message));
  await assert.rejects(provider.getItem(connection(), "brosincode/secret-roadmap#7"), /cannot read/);
  assert.ok(!fetch.calls.some((call) => call.url.pathname.includes("/issues")), "no issue is read");
  assert.equal(fetch.calls.filter((call) => call.url.pathname.endsWith("/permission")).length, 1, "the refusal is cached briefly");
});

test("getItem reads one issue; a pull request number or a missing issue is no item", async () => {
  const fetch = fakeFetch([
    mint,
    permission("github-permission-read"),
    (call) => call.url.pathname === "/repos/brosincode/letagents/issues/42" ? { json: fixture("github-issue-42") } : undefined,
    (call) => call.url.pathname === "/repos/brosincode/letagents/issues/39" ? { json: fixture("github-issue-39-pull-request") } : undefined,
    (call) => call.url.pathname === "/repos/brosincode/letagents/issues/404" ? { status: 404, json: fixture("github-not-found") } : undefined,
  ]);
  const provider = createGitHubIssuesProvider({ fetchImpl: fetch.impl, directory: directory(), now });
  const item = await provider.getItem(connection(), "BrosInCode/letagents#42");
  assert.equal(item?.key, "brosincode/letagents#42");
  assert.equal(item?.ticket_state, "in_progress");
  assert.equal(await provider.getItem(connection(), "brosincode/letagents#39"), null);
  assert.equal(await provider.getItem(connection(), "brosincode/letagents#404"), null);
  await assert.rejects(provider.getItem(connection(), "HT-12"), /not a GitHub issue key/);
});

test("whoAmI names the installation as the site and the person by GitHub id", async () => {
  const fetch = fakeFetch([mint, (call) => call.url.pathname === "/users/EmmyMay" ? { json: fixture("github-user") } : undefined]);
  const provider = createGitHubIssuesProvider({ fetchImpl: fetch.impl, directory: directory(), now });
  assert.deepEqual(await provider.whoAmI(connection()), {
    id: "31524469",
    label: "EmmyMay",
    site: { key: `installation:${INSTALLATION}`, url: "https://github.com/BrosInCode", name: "BrosInCode" },
  });
  const minted = fetch.calls.find((call) => call.url.pathname.endsWith("/access_tokens"))!;
  assert.deepEqual(minted.body, { permissions: { issues: "read", metadata: "read" } });
});

test("a removed installation or app asks the person to connect again", async () => {
  const gone = createGitHubIssuesProvider({
    fetchImpl: fakeFetch([]).impl,
    directory: directory({ async installation() { return null; } }),
    now,
  });
  await assert.rejects(gone.whoAmI(connection()), (error: unknown) => error instanceof TrackerProviderError && error.outcome === "auth");

  const uninstalled = createGitHubIssuesProvider({
    fetchImpl: fakeFetch([(call) => call.url.pathname.endsWith("/access_tokens") ? { status: 404, json: fixture("github-installation-gone") } : undefined]).impl,
    directory: directory(),
    now,
  });
  await assert.rejects(uninstalled.listItems(connection(), "brosincode/letagents", {}), (error: unknown) =>
    error instanceof TrackerProviderError && error.outcome === "auth" && /no longer installed/.test(error.message));

  const incomplete = createGitHubIssuesProvider({ fetchImpl: fakeFetch([]).impl, directory: directory(), now });
  await assert.rejects(incomplete.listItems(connection({ installation_id: "" }), "brosincode/letagents", {}), (error: unknown) =>
    error instanceof TrackerProviderError && error.outcome === "auth");
});

test("Test connection lists assigned issues only in repositories the login can read", async () => {
  const fetch = fakeFetch([
    mint,
    (call) => call.url.pathname === "/search/issues" ? { json: fixture("github-search-assigned") } : undefined,
    (call) => call.url.pathname === "/repos/brosincode/letagents/collaborators/EmmyMay/permission" ? { json: fixture("github-permission-read") } : undefined,
    (call) => call.url.pathname === "/repos/brosincode/secret-roadmap/collaborators/EmmyMay/permission" ? { json: fixture("github-permission-none") } : undefined,
  ]);
  const provider = createGitHubIssuesProvider({ fetchImpl: fetch.impl, directory: directory(), now });
  const items = await provider.listItems(connection(), null, { assigneeMe: true, limit: 5 });
  assert.deepEqual(items.map((item) => item.key), ["brosincode/letagents#42"]);
  const search = fetch.calls.find((call) => call.url.pathname === "/search/issues")!;
  assert.equal(search.url.searchParams.get("q"), "is:issue is:open assignee:EmmyMay");
  await assert.rejects(provider.listItems(connection(), null, {}), /Name at least one repository/);
});

test("rules do not write to GitHub Issues", async () => {
  const provider = createGitHubIssuesProvider({ fetchImpl: fakeFetch([]).impl, directory: directory(), now });
  await assert.rejects(provider.transition(connection(), "brosincode/letagents#42", "Closed", "corr"), /Rules do not write/);
  await assert.rejects(provider.comment(connection(), "brosincode/letagents#42", "hi", "corr"), /Rules do not write/);
  assert.deepEqual(await provider.listTransitions(connection(), "brosincode/letagents#42"), []);
});

test("filters name owner/repo terms; webhooks name the issue and never a pull request", () => {
  assert.deepEqual(parseGitHubFilter(" BrosInCode/letagents, brosincode/letagents  acme/api "), ["brosincode/letagents", "acme/api"]);
  assert.throws(() => parseGitHubFilter(""), /at least one repository/);
  assert.throws(() => parseGitHubFilter("label:bug"), /not owner\/repo/);
  assert.throws(() => parseGitHubFilter(Array.from({ length: 11 }, (_, index) => `acme/r${index}`).join(" ")), /at most 10/);

  const item = { key: "brosincode/letagents#42" } as ExternalItem;
  assert.equal(githubFilterAllows("acme/api BrosInCode/letagents", item), true);
  assert.equal(githubFilterAllows("acme/api", item), false);
  assert.equal(githubFilterAllows("not a filter!", item), false);

  assert.deepEqual(parseGitHubIssuesWebhook(fixture("github-issues-webhook-closed")), [
    { key: "brosincode/letagents#42", item: null, deleted: false },
  ]);
  const pullRequest = { ...(fixture("github-issues-webhook-closed") as Record<string, unknown>), issue: fixture("github-issue-39-pull-request") };
  assert.deepEqual(parseGitHubIssuesWebhook(pullRequest), []);
  assert.deepEqual(parseGitHubIssuesWebhook({ ...(fixture("github-issues-webhook-closed") as object), action: "deleted" })[0]?.deleted, true);
});

test("a GitHub App issues event goes to the same webhook path for each connection on that installation", async () => {
  const handled: Array<{ id: string; keys: string[] }> = [];
  const rows = [{ id: "tcon_a" }, { id: "tcon_b" }] as TrackerConnectionRow[];
  const applied = await applyGitHubIssuesEvent(fixture("github-issues-webhook-closed"), INSTALLATION, {
    sync: {
      async handleWebhook(row, changes) {
        handled.push({ id: row.id, keys: changes.map((change) => change.key) });
        return { applied: 1 };
      },
    },
    async connectionsForInstallation(id) { return id === INSTALLATION ? rows : []; },
  });
  assert.equal(applied, 2);
  assert.deepEqual(handled, [
    { id: "tcon_a", keys: ["brosincode/letagents#42"] },
    { id: "tcon_b", keys: ["brosincode/letagents#42"] },
  ]);
  assert.equal(await applyGitHubIssuesEvent(fixture("github-issues-webhook-closed"), null, {
    sync: { async handleWebhook() { throw new Error("not called"); } },
    async connectionsForInstallation() { return rows; },
  }), 0);
});

test("the token scope uses GitHub's spelling of the repository; a moved issue is no item", async () => {
  const fetch = fakeFetch([
    mint,
    permission("github-permission-read"),
    (call) => call.url.pathname === "/repos/acme/myrepo/issues/5" ? { status: 301, json: { message: "Moved Permanently" } } : undefined,
  ]);
  const provider = createGitHubIssuesProvider({
    fetchImpl: fetch.impl,
    directory: directory({ async repositoryInstallation(repo) { return repo === "acme/myrepo" ? { installation_id: INSTALLATION, full_name: "Acme/MyRepo" } : null; } }),
    now,
  });
  assert.equal(await provider.getItem(connection(), "acme/myrepo#5"), null);
  const minted = fetch.calls.find((call) => call.url.pathname.endsWith("/access_tokens"))!;
  assert.deepEqual(minted.body?.repositories, ["MyRepo"]);
});

test("a permission answer about another GitHub user (a renamed login taken by someone else) is a refusal", async () => {
  const other = { ...(fixture("github-permission-read") as Record<string, unknown>), user: { login: "EmmyMay", id: 777 } };
  const fetch = fakeFetch([mint, (call) => call.url.pathname.endsWith("/permission") ? { json: other } : undefined]);
  const provider = createGitHubIssuesProvider({ fetchImpl: fetch.impl, directory: directory(), now });
  await assert.rejects(provider.listItems(connection(), "brosincode/letagents", {}), GitHubAccessRefusedError);
});

test("connecting needs the person's own access to the repository, not only public read", async () => {
  const collaborator = (status: number): Route => (call) =>
    call.url.pathname === "/repos/brosincode/letagents/collaborators/EmmyMay" ? { status, json: status === 204 ? undefined : fixture("github-not-found") } : undefined;
  const member = createGitHubIssuesProvider({ fetchImpl: fakeFetch([mint, permission("github-permission-read"), collaborator(204)]).impl, directory: directory(), now });
  await member.assertMember(connection(), "brosincode/letagents");
  const outsider = createGitHubIssuesProvider({ fetchImpl: fakeFetch([mint, permission("github-permission-read"), collaborator(404)]).impl, directory: directory(), now });
  await assert.rejects(outsider.assertMember(connection(), "brosincode/letagents"), GitHubAccessRefusedError,
    "public read is enough to read a filtered repository, not to attach to the installation");
});
