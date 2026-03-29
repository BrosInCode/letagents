import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitHubAppInstallationUrl,
  buildGitHubAppSetupRedirectPath,
  resolveGitHubAppRoomIntegrationStatus,
} from "../github-app-installation.js";

test("buildGitHubAppInstallationUrl uses the GitHub app slug and preserves state", () => {
  assert.equal(
    buildGitHubAppInstallationUrl({
      appSlug: "letagents",
      state: "abc123",
    }),
    "https://github.com/apps/letagents/installations/new?state=abc123"
  );
});

test("buildGitHubAppSetupRedirectPath preserves the redirect path and appends setup state", () => {
  assert.equal(
    buildGitHubAppSetupRedirectPath({
      redirectTo: "/in/github.com/brosincode/letagents?tab=board",
      setupAction: "install",
      stateValid: true,
    }),
    "/in/github.com/brosincode/letagents?tab=board&github_app_setup=install"
  );
});

test("buildGitHubAppSetupRedirectPath falls back safely for invalid state", () => {
  assert.equal(
    buildGitHubAppSetupRedirectPath({
      redirectTo: "https://evil.example/not-allowed",
      setupAction: null,
      stateValid: false,
    }),
    "/?github_app_setup=complete&github_app_state=invalid"
  );
});

test("resolveGitHubAppRoomIntegrationStatus reports a connected installation only when repo and installation are active", () => {
  const status = resolveGitHubAppRoomIntegrationStatus({
    configured: true,
    appSlug: "letagents",
    setupUrl: "https://letagents.chat/auth/github/app/callback",
    repository: {
      github_repo_id: "123",
      installation_id: "999",
      owner_login: "brosincode",
      repo_name: "letagents",
      full_name: "brosincode/letagents",
      room_id: "github.com/brosincode/letagents",
      removed_at: null,
      created_at: "2026-03-29T00:00:00.000Z",
      updated_at: "2026-03-29T00:00:00.000Z",
    },
    installation: {
      installation_id: "999",
      target_type: "Organization",
      target_login: "brosincode",
      target_github_id: "42",
      repository_selection: "selected",
      permissions_json: "{\"pull_requests\":\"write\"}",
      suspended_at: null,
      uninstalled_at: null,
      last_synced_at: "2026-03-29T00:00:00.000Z",
      created_at: "2026-03-29T00:00:00.000Z",
      updated_at: "2026-03-29T00:00:00.000Z",
    },
  });

  assert.equal(status.connected, true);
  assert.equal(status.install_url_available, true);
  assert.equal(status.repository?.full_name, "brosincode/letagents");
  assert.equal(status.installation?.installation_id, "999");
});
