import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexTomlLetAgentsMcpConfig,
  createLetAgentsMcpServerConfig,
  getCodexTomlLetAgentsMcpServerFromRaw,
  getCodexTomlLetAgentsMcpInstallStatusFromRaw,
  getJsonLetAgentsMcpInstallStatusFromRaw,
} from "../main/mcp-config.js";

const baseExpected = createLetAgentsMcpServerConfig({
  apiUrl: "https://letagents.chat",
  workspaceRoot: "/work/repo",
});

const expectedWithToken = createLetAgentsMcpServerConfig({
  apiUrl: "https://letagents.chat",
  workspaceRoot: "/work/repo",
  authToken: "letagents-token",
});

test("createLetAgentsMcpServerConfig includes auth token only when present", () => {
  assert.deepEqual(baseExpected.env, {
    LETAGENTS_API_URL: "https://letagents.chat",
  });
  assert.equal(baseExpected.cwd, "/work/repo");
  assert.deepEqual(expectedWithToken.env, {
    LETAGENTS_API_URL: "https://letagents.chat",
    LETAGENTS_TOKEN: "letagents-token",
  });
  assert.equal(
    createLetAgentsMcpServerConfig({
      apiUrl: "https://letagents.chat",
      workspaceRoot: "/work/repo",
      cwd: "/chosen/repo",
    }).cwd,
    "/chosen/repo",
  );
});

test("json install status requires the current cwd and token state", () => {
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
  assert.match(withToken, /cwd = "\/work\/repo"/);
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

test("codex toml parser preserves custom command and env for auth refresh", () => {
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
    ...parsed,
    env: {
      ...parsed.env,
      LETAGENTS_API_URL: "https://letagents.chat",
      LETAGENTS_TOKEN: "new-token",
    },
  });

  assert.match(refreshed, /command = "\/opt\/homebrew\/bin\/npx"/);
  assert.match(refreshed, /cwd = "\/custom\/repo"/);
  assert.match(refreshed, /PATH = "\/opt\/homebrew\/bin:\/usr\/bin"/);
  assert.match(refreshed, /LETAGENTS_API_URL = "https:\/\/letagents\.chat"/);
  assert.match(refreshed, /LETAGENTS_TOKEN = "new-token"/);
  assert.equal(getCodexTomlLetAgentsMcpServerFromRaw(""), null);
});
