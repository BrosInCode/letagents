import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { DesktopAgentProvider, DesktopAgentProviderPreflightInput } from "../ipc-types.js";
import { createElectronTestEnv } from "./harness.js";

const { tempDir } = createElectronTestEnv({
  prefix: "letagents-cursor-provider-preflight-",
  paths: ["state"],
  extraCleanupEnvKeys: [
    "LETAGENTS_CURSOR_SOURCE_HOME",
    "LETAGENTS_CURSOR_MANAGED_HOME",
    "LETAGENTS_CURSOR_AGENT_BIN",
  ],
});
const cursorSourceHome = join(tempDir, "cursor-source-home");
const cursorManagedHome = join(tempDir, "cursor-managed-home");
const fakeCursorBin = join(tempDir, "cursor-agent-fake.js");
process.env.LETAGENTS_CURSOR_SOURCE_HOME = cursorSourceHome;
process.env.LETAGENTS_CURSOR_MANAGED_HOME = cursorManagedHome;
process.env.LETAGENTS_CURSOR_AGENT_BIN = fakeCursorBin;

mkdirSync(join(cursorSourceHome, ".cursor"), { recursive: true });
writeFileSync(join(cursorSourceHome, ".cursor", "mcp.json"), `${JSON.stringify({
  mcpServers: {
    filesystem: { command: "npx" },
    letagents: { command: "npx", args: ["-y", "letagents"] },
  },
})}\n`);
writeFileSync(fakeCursorBin, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("cursor-agent fake 1.0.0");
  process.exit(0);
}
if (args[0] === "--help") {
  console.log("Usage: cursor-agent --force --sandbox <mode>");
  process.exit(0);
}
if (args[0] === "status") {
  console.log("Logged in");
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "list") {
  const fixture = path.join(process.cwd(), ".fake-cursor-mcp-list");
  console.log(fs.existsSync(fixture) ? fs.readFileSync(fixture, "utf-8") : "filesystem");
  process.exit(0);
}
console.error("Unexpected cursor-agent args: " + args.join(" "));
process.exit(2);
`);
chmodSync(fakeCursorBin, 0o755);

const { runDesktopCursorProviderPreflight } = await import("../main/agents/cursor-provider-preflight.js");
const cursorProvider: DesktopAgentProvider = {
  id: "cursor",
  name: "Cursor",
  description: "Start Cursor.",
  capabilities: ["external_mcp", "desktop_managed_runtime"],
  runtimeCommand: "cursor-agent",
  mcpTargetId: "cursor",
  permissionProfiles: [],
  defaultPermissionProfileId: null,
};

// The electron suite runs test files as parallel node processes, so spawning the
// fake cursor-agent child can take arbitrarily long under load. Disable the
// per-command wall-clock timeout: the fake binary always exits on its own, and
// the timeout itself is not the behavior under test.
function runPreflight(input: DesktopAgentProviderPreflightInput) {
  return runDesktopCursorProviderPreflight(cursorProvider, input, "installed", {
    commandTimeoutMs: 0,
  });
}

test("Cursor preflight defaults to filter_letagents MCP policy", async () => {
  const workspace = workspaceFixture("default-filter");

  const result = await runPreflight({ repoRootPath: workspace });

  assert.equal(result.status, "ready");
  assert.equal(result.canStart, true);
  assert.equal(result.message, "Cursor Agent is ready to start with Read-only.");
  assert.match(result.detail ?? "", /keep user MCPs except LetAgents/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(cursorManagedHome, ".cursor", "mcp.json"), "utf-8")),
    {
      mcpServers: {
        filesystem: { command: "npx" },
      },
    },
  );
});

test("Cursor preflight validates write-capable permission profile flags", async () => {
  const workspace = workspaceFixture("full-access");

  const result = await runPreflight({
    repoRootPath: workspace,
    permissionProfileId: "full_access",
    cursorMcpPolicy: "filter_letagents",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.canStart, true);
  assert.equal(result.message, "Cursor Agent is ready to start with Full access.");
  assert.match(result.detail ?? "", /--force and Cursor sandbox disabled/);
});

test("Cursor preflight blocks gated permission profiles", async () => {
  const workspace = workspaceFixture("gated-permission-profile");

  const result = await runPreflight({
    repoRootPath: workspace,
    permissionProfileId: "ask_before_write",
  });

  assert.equal(result.status, "error");
  assert.equal(result.canStart, false);
  assert.equal(result.message, "Ask before writes is not available for Cursor.");
});

test("Cursor preflight blocks unknown permission profiles", async () => {
  const workspace = workspaceFixture("unknown-permission-profile");

  const result = await runPreflight({
    repoRootPath: workspace,
    permissionProfileId: "unknown_profile" as never,
  });

  assert.equal(result.status, "error");
  assert.equal(result.canStart, false);
  assert.equal(result.message, "Cursor permission profile is unknown.");
  assert.match(result.detail ?? "", /unknown_profile/);
});

test("Cursor preflight blocks visible LetAgents MCP for managed MCP policies", async () => {
  for (const policy of ["filter_letagents", "none"] as const) {
    const workspace = workspaceFixture(`blocked-${policy}`);
    writeFileSync(join(workspace, ".fake-cursor-mcp-list"), "letagents\n");

    const result = await runPreflight({
      repoRootPath: workspace,
      cursorMcpPolicy: policy,
    });

    assert.equal(result.status, "error");
    assert.equal(result.canStart, false);
    assert.equal(result.message, "Cursor can still see LetAgents MCP.");
  }
});

test("Cursor preflight blocks any visible MCP server for none policy", async () => {
  const workspace = workspaceFixture("none-visible-non-letagents");
  writeFileSync(join(workspace, ".fake-cursor-mcp-list"), "filesystem\n");

  const result = await runPreflight({
    repoRootPath: workspace,
    cursorMcpPolicy: "none",
  });

  assert.equal(result.status, "error");
  assert.equal(result.canStart, false);
  assert.equal(result.message, "Cursor can still see MCP servers.");
});

test("Cursor preflight allows normal MCP policy even when LetAgents is configured", async () => {
  const workspace = workspaceFixture("normal-with-letagents");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "mcp.json"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');
  writeFileSync(join(workspace, ".fake-cursor-mcp-list"), "letagents\n");

  const result = await runPreflight({
    repoRootPath: workspace,
    cursorMcpPolicy: "normal",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.canStart, true);
  assert.match(result.detail ?? "", /normal Cursor MCP settings/);
});

function workspaceFixture(name: string): string {
  const workspace = join(tempDir, name);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}
