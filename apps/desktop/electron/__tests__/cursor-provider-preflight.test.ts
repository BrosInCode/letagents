import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DesktopAgentProvider } from "../ipc-types.js";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-cursor-provider-preflight-"));
const statePath = join(tempDir, "mcp-state.json");
const cursorSourceHome = join(tempDir, "cursor-source-home");
const cursorManagedHome = join(tempDir, "cursor-managed-home");
const fakeCursorBin = join(tempDir, "cursor-agent-fake.js");
process.env.LETAGENTS_STATE_PATH = statePath;
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

test.after(() => {
  delete process.env.LETAGENTS_STATE_PATH;
  delete process.env.LETAGENTS_CURSOR_SOURCE_HOME;
  delete process.env.LETAGENTS_CURSOR_MANAGED_HOME;
  delete process.env.LETAGENTS_CURSOR_AGENT_BIN;
  rmSync(tempDir, { recursive: true, force: true });
});

test("Cursor preflight defaults to filter_letagents MCP policy", async () => {
  const workspace = workspaceFixture("default-filter");

  const result = await runDesktopCursorProviderPreflight(cursorProvider, { repoRootPath: workspace }, "installed");

  assert.equal(result.status, "ready");
  assert.equal(result.canStart, true);
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

test("Cursor preflight blocks visible LetAgents MCP for managed MCP policies", async () => {
  for (const policy of ["filter_letagents", "none"] as const) {
    const workspace = workspaceFixture(`blocked-${policy}`);
    writeFileSync(join(workspace, ".fake-cursor-mcp-list"), "letagents\n");

    const result = await runDesktopCursorProviderPreflight(
      cursorProvider,
      {
        repoRootPath: workspace,
        cursorMcpPolicy: policy,
      },
      "installed",
    );

    assert.equal(result.status, "error");
    assert.equal(result.canStart, false);
    assert.equal(result.message, "Cursor can still see LetAgents MCP.");
  }
});

test("Cursor preflight blocks any visible MCP server for none policy", async () => {
  const workspace = workspaceFixture("none-visible-non-letagents");
  writeFileSync(join(workspace, ".fake-cursor-mcp-list"), "filesystem\n");

  const result = await runDesktopCursorProviderPreflight(
    cursorProvider,
    {
      repoRootPath: workspace,
      cursorMcpPolicy: "none",
    },
    "installed",
  );

  assert.equal(result.status, "error");
  assert.equal(result.canStart, false);
  assert.equal(result.message, "Cursor can still see MCP servers.");
});

test("Cursor preflight allows normal MCP policy even when LetAgents is configured", async () => {
  const workspace = workspaceFixture("normal-with-letagents");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "mcp.json"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');
  writeFileSync(join(workspace, ".fake-cursor-mcp-list"), "letagents\n");

  const result = await runDesktopCursorProviderPreflight(
    cursorProvider,
    {
      repoRootPath: workspace,
      cursorMcpPolicy: "normal",
    },
    "installed",
  );

  assert.equal(result.status, "ready");
  assert.equal(result.canStart, true);
  assert.match(result.detail ?? "", /normal Cursor MCP settings/);
});

function workspaceFixture(name: string): string {
  const workspace = join(tempDir, name);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}
