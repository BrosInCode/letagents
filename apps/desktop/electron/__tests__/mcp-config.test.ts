import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexTomlLetAgentsMcpConfig,
  createLetAgentsMcpServerConfig,
  getCodexTomlLetAgentsMcpServerFromRaw,
  getCodexTomlLetAgentsMcpInstallStatusFromRaw,
  getJsonLetAgentsMcpInstallStatusFromRaw,
  getLetAgentsMcpServerIssue,
  isLocalDevLetAgentsApiUrl,
} from "../main/mcp-config.js";

const baseExpected = createLetAgentsMcpServerConfig({
  apiUrl: "https://letagents.chat",
});

const expectedWithToken = createLetAgentsMcpServerConfig({
  apiUrl: "https://letagents.chat",
  authToken: "letagents-token",
});

test("createLetAgentsMcpServerConfig includes auth token only when present and omits cwd", () => {
  assert.deepEqual(baseExpected.env, {
    LETAGENTS_API_URL: "https://letagents.chat",
  });
  assert.equal(baseExpected.cwd, undefined);
  assert.deepEqual(expectedWithToken.env, {
    LETAGENTS_API_URL: "https://letagents.chat",
    LETAGENTS_TOKEN: "letagents-token",
  });
  assert.equal(expectedWithToken.cwd, undefined);
});

test("json install status requires token state and rejects legacy cwd", () => {
  const missingTokenConfig = JSON.stringify({
    mcpServers: {
      letagents: baseExpected,
    },
  });
  const matchingTokenConfig = JSON.stringify({
    mcpServers: {
      letagents: expectedWithToken,
    },
  });
  const wrongTokenConfig = JSON.stringify({
    mcpServers: {
      letagents: {
        ...expectedWithToken,
        env: {
          ...expectedWithToken.env,
          LETAGENTS_TOKEN: "old-token",
        },
      },
    },
  });
  const unexpectedTokenConfig = JSON.stringify({
    mcpServers: {
      letagents: expectedWithToken,
    },
  });
  const wrongCwdConfig = JSON.stringify({
    mcpServers: {
      letagents: {
        ...baseExpected,
        cwd: "/other/repo",
      },
    },
  });

  assert.equal(
    getJsonLetAgentsMcpInstallStatusFromRaw(missingTokenConfig, baseExpected),
    "installed",
  );
  assert.equal(
    getJsonLetAgentsMcpInstallStatusFromRaw(wrongTokenConfig, baseExpected),
    "needs_attention",
  );
  assert.equal(
    getJsonLetAgentsMcpInstallStatusFromRaw(
      missingTokenConfig,
      expectedWithToken,
    ),
    "needs_attention",
  );
  assert.equal(
    getJsonLetAgentsMcpInstallStatusFromRaw(
      matchingTokenConfig,
      expectedWithToken,
    ),
    "installed",
  );
  assert.equal(
    getJsonLetAgentsMcpInstallStatusFromRaw(wrongTokenConfig, expectedWithToken),
    "needs_attention",
  );
  assert.equal(
    getJsonLetAgentsMcpInstallStatusFromRaw(unexpectedTokenConfig, baseExpected),
    "needs_attention",
  );
  assert.equal(
    getJsonLetAgentsMcpInstallStatusFromRaw(wrongCwdConfig, baseExpected),
    "needs_attention",
  );
});

test("json install status rejects missing API URL because runtime would fall back to local dev", () => {
  const missingApiUrlConfig = JSON.stringify({
    mcpServers: {
      letagents: {
        command: "npx",
        args: ["-y", "letagents"],
        env: {},
      },
    },
  });

  assert.equal(
    getJsonLetAgentsMcpInstallStatusFromRaw(
      missingApiUrlConfig,
      baseExpected,
    ),
    "needs_attention",
  );
  const issue = getLetAgentsMcpServerIssue(
    {
      command: "npx",
      args: ["-y", "letagents"],
      env: {},
    },
    baseExpected,
  );
  assert.ok(issue);
  assert.match(issue, /LETAGENTS_API_URL is missing/);
});

test("server issue flags stale localhost backend unless local dev is expected and healthy", () => {
  const localServer = createLetAgentsMcpServerConfig({
    apiUrl: "http://localhost:3001",
  });
  const localExpected = createLetAgentsMcpServerConfig({
    apiUrl: "http://localhost:3001",
  });

  assert.equal(isLocalDevLetAgentsApiUrl("http://localhost:3001"), true);
  assert.equal(isLocalDevLetAgentsApiUrl("http://[::1]:3001"), true);
  const unhealthyIssue = getLetAgentsMcpServerIssue(localServer, baseExpected, {
    localDevApiHealthy: false,
  });
  const productionMismatchIssue = getLetAgentsMcpServerIssue(
    localServer,
    baseExpected,
    {
      localDevApiHealthy: true,
    },
  );
  assert.ok(unhealthyIssue);
  assert.ok(productionMismatchIssue);
  assert.match(unhealthyIssue, /no local API is reachable/);
  assert.match(productionMismatchIssue, /expected https:\/\/letagents\.chat/);
  assert.equal(
    getLetAgentsMcpServerIssue(localServer, localExpected, {
      localDevApiHealthy: true,
    }),
    null,
  );
});

test("codex toml writer includes and removes token based on expected auth", () => {
  const existing = [
    "[profiles.default]",
    'model = "gpt-5"',
    "",
    "[mcp_servers.letagents]",
    'command = "old"',
    'args = ["old"]',
    'cwd = "/old/repo"',
    "",
    "[mcp_servers.letagents.env]",
    'LETAGENTS_API_URL = "https://old.example.com"',
    'LETAGENTS_TOKEN = "old-token"',
  ].join("\n");

  const withToken = buildCodexTomlLetAgentsMcpConfig(
    existing,
    expectedWithToken,
  );
  assert.match(withToken, /\[profiles\.default\]/);
  assert.doesNotMatch(withToken, /cwd = /);
  assert.match(withToken, /LETAGENTS_API_URL = "https:\/\/letagents\.chat"/);
  assert.match(withToken, /LETAGENTS_TOKEN = "letagents-token"/);
  assert.equal(
    getCodexTomlLetAgentsMcpInstallStatusFromRaw(
      withToken,
      expectedWithToken,
    ),
    "installed",
  );

  const withoutToken = buildCodexTomlLetAgentsMcpConfig(
    withToken,
    baseExpected,
  );
  assert.doesNotMatch(withoutToken, /LETAGENTS_TOKEN/);
  assert.doesNotMatch(withoutToken, /cwd = /);
  assert.equal(
    getCodexTomlLetAgentsMcpInstallStatusFromRaw(
      withoutToken,
      baseExpected,
    ),
    "installed",
  );
  assert.equal(
    getCodexTomlLetAgentsMcpInstallStatusFromRaw(
      withoutToken,
      expectedWithToken,
    ),
    "needs_attention",
  );
});

test("codex toml install status rejects legacy cwd", () => {
  const legacyCwd = [
    "[mcp_servers.letagents]",
    'command = "npx"',
    'args = ["-y", "letagents"]',
    'cwd = "/one/sticky/repo"',
    "",
    "[mcp_servers.letagents.env]",
    'LETAGENTS_API_URL = "https://letagents.chat"',
  ].join("\n");

  assert.equal(
    getCodexTomlLetAgentsMcpInstallStatusFromRaw(legacyCwd, baseExpected),
    "needs_attention",
  );
});

test("codex toml writer preserves custom command and env while removing legacy cwd", () => {
  const current = [
    "[mcp_servers.letagents]",
    'command = "/opt/homebrew/bin/npx"',
    'args = ["-y", "letagents"]',
    'cwd = "/custom/repo"',
    "",
    "[mcp_servers.letagents.env]",
    'LETAGENTS_API_URL = "https://old.example.com"',
    'PATH = "/opt/homebrew/bin:/usr/bin"',
    'LETAGENTS_TOKEN = "old-token"',
  ].join("\n");

  const parsed = getCodexTomlLetAgentsMcpServerFromRaw(current);
  assert.ok(parsed);
  const refreshed = buildCodexTomlLetAgentsMcpConfig(current, {
    command: parsed.command,
    args: parsed.args,
    env: {
      ...parsed.env,
      LETAGENTS_API_URL: "https://letagents.chat",
      LETAGENTS_TOKEN: "new-token",
    },
  });

  assert.match(refreshed, /command = "\/opt\/homebrew\/bin\/npx"/);
  assert.doesNotMatch(refreshed, /cwd = /);
  assert.match(refreshed, /PATH = "\/opt\/homebrew\/bin:\/usr\/bin"/);
  assert.match(refreshed, /LETAGENTS_API_URL = "https:\/\/letagents\.chat"/);
  assert.match(refreshed, /LETAGENTS_TOKEN = "new-token"/);
  assert.equal(getCodexTomlLetAgentsMcpServerFromRaw(""), null);
});
