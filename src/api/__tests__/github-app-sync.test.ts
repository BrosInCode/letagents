import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubWebhookPayload } from "../github-app.js";
import {
  createGitHubAppSync,
  toGitHubWebhookId,
  type GitHubAppInstallationSyncInput,
  type GitHubAppRepositorySyncInput,
  type GitHubRepositoryLinkSyncInput,
} from "../github-app-sync.js";

function createHarness(input?: {
  fallbackInstallations?: Record<string, string | null | undefined>;
}) {
  const installations: GitHubAppInstallationSyncInput[] = [];
  const repositories: GitHubAppRepositorySyncInput[] = [];
  const repositoryLinks: GitHubRepositoryLinkSyncInput[] = [];
  const lookupFullNames: string[] = [];

  const sync = createGitHubAppSync({
    getGitHubAppRepositoryByFullName: async (fullName) => {
      lookupFullNames.push(fullName);
      const installationId = input?.fallbackInstallations?.[fullName];
      return installationId ? { installation_id: installationId } : null;
    },
    upsertGitHubAppInstallation: async (payload) => {
      installations.push(payload);
    },
    upsertGitHubAppRepository: async (payload) => {
      repositories.push(payload);
    },
    upsertGitHubRepositoryLink: async (payload) => {
      repositoryLinks.push(payload);
    },
  });

  return {
    installations,
    lookupFullNames,
    repositories,
    repositoryLinks,
    sync,
  };
}

test("toGitHubWebhookId normalizes nullable and string-like ids", () => {
  assert.equal(toGitHubWebhookId(undefined), null);
  assert.equal(toGitHubWebhookId(null), null);
  assert.equal(toGitHubWebhookId(""), null);
  assert.equal(toGitHubWebhookId("  "), null);
  assert.equal(toGitHubWebhookId(" 123 "), "123");
  assert.equal(toGitHubWebhookId(456), "456");
});

test("syncGitHubAppInstallationFromPayload upserts installation target details", async () => {
  const { installations, sync } = createHarness();
  const payload: GitHubWebhookPayload = {
    installation: {
      id: 123,
      account: {
        id: 456,
        login: "BrosInCode",
        type: "Organization",
      },
      target_type: "Organization",
      repository_selection: "selected",
      permissions: { contents: "read" },
    },
  };

  const installationId = await sync.syncGitHubAppInstallationFromPayload(payload, {
    suspended_at: "2026-04-20T17:00:00.000Z",
    uninstalled_at: null,
  });

  assert.equal(installationId, "123");
  assert.deepEqual(installations, [
    {
      installation_id: "123",
      target_type: "Organization",
      target_login: "BrosInCode",
      target_github_id: "456",
      repository_selection: "selected",
      permissions: { contents: "read" },
      suspended_at: "2026-04-20T17:00:00.000Z",
      uninstalled_at: null,
    },
  ]);
});

test("syncGitHubAppInstallationFromPayload returns installation id without target upsert", async () => {
  const { installations, sync } = createHarness();

  const installationId = await sync.syncGitHubAppInstallationFromPayload({
    installation: { id: " 789 " },
  });

  assert.equal(installationId, "789");
  assert.deepEqual(installations, []);
});

test("syncGitHubAppRepositoryFromPayload falls back to existing installation and upserts repo links", async () => {
  const { lookupFullNames, repositories, repositoryLinks, sync } = createHarness({
    fallbackInstallations: {
      "BrosInCode/letagents": "installation_1",
    },
  });

  const result = await sync.syncGitHubAppRepositoryFromPayload(
    {
      id: " 987 ",
      full_name: "BrosInCode/letagents",
      name: "letagents",
    },
    null
  );

  assert.deepEqual(result, {
    installationId: "installation_1",
    githubRepoId: "987",
    roomId: "github.com/brosincode/letagents",
  });
  assert.deepEqual(lookupFullNames, ["BrosInCode/letagents"]);
  assert.deepEqual(repositories, [
    {
      github_repo_id: "987",
      installation_id: "installation_1",
      owner_login: "BrosInCode",
      repo_name: "letagents",
    },
  ]);
  assert.deepEqual(repositoryLinks, [
    {
      github_repo_id: "987",
      room_id: "github.com/brosincode/letagents",
      owner_login: "BrosInCode",
      repo_name: "letagents",
    },
  ]);
});

test("syncGitHubAppRepositoryFromPayload skips upserts when required repo fields are missing", async () => {
  const { lookupFullNames, repositories, repositoryLinks, sync } = createHarness();

  const result = await sync.syncGitHubAppRepositoryFromPayload(
    {
      id: "",
      full_name: "BrosInCode/letagents",
      name: "",
    },
    "installation_1"
  );

  assert.deepEqual(result, {
    installationId: "installation_1",
    githubRepoId: null,
    roomId: "github.com/brosincode/letagents",
  });
  assert.deepEqual(lookupFullNames, []);
  assert.deepEqual(repositories, []);
  assert.deepEqual(repositoryLinks, []);
});
