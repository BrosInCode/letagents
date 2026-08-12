import assert from "node:assert/strict";
import test from "node:test";

import { claudeCliEnv } from "../main/agents/claude-code-provider-adapter.js";
import {
  rentalCredentialIsolationMarker,
  rentalIsolatedChildEnvironment,
} from "../main/agents/rental-child-environment.js";

test("rental child environment keeps process plumbing but strips raw owner/cloud credentials", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/Users/provider",
    LANG: "en_US.UTF-8",
    CODEX_HOME: "/Users/provider/.codex",
    CLAUDE_CONFIG_DIR: "/Users/provider/.claude",
    LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_rental_1",
    LETAGENTS_TOKEN: "owner-bearer",
    LETAGENTS_AGENT_SESSION_BEARER: "stale-worker-bearer",
    GITHUB_TOKEN: "github-secret",
    GH_TOKEN: "github-secret-2",
    OPENAI_API_KEY: "raw-inference-key",
    ANTHROPIC_API_KEY: "raw-inference-key-2",
    AWS_SECRET_ACCESS_KEY: "cloud-secret",
    DATABASE_URL: "postgres://secret",
    NPM_TOKEN: "npm-secret",
    [rentalCredentialIsolationMarker]: "1",
  };
  const isolated = rentalIsolatedChildEnvironment(source);
  assert.equal(isolated.CODEX_HOME, undefined);
  assert.equal(isolated.CLAUDE_CONFIG_DIR, undefined);
  assert.deepEqual(isolated, {
    PATH: "/usr/bin",
    HOME: "/Users/provider",
    LANG: "en_US.UTF-8",
    LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_rental_1",
  });
  assert.equal(Object.values(isolated).some((value) => String(value).includes("secret")), false);
});

test("Claude activates the same strict rental boundary only for rental launches", () => {
  const rental = claudeCliEnv({
    PATH: "/usr/bin",
    HOME: "/Users/provider",
    GITHUB_TOKEN: "owner-github-secret",
  }, { [rentalCredentialIsolationMarker]: "1" });
  assert.equal(rental.GITHUB_TOKEN, undefined);
  assert.equal(rental.HOME, "/Users/provider");

  const ordinary = claudeCliEnv({ PATH: "/usr/bin", GITHUB_TOKEN: "ordinary-agent-token" });
  assert.equal(ordinary.GITHUB_TOKEN, "ordinary-agent-token");
});
