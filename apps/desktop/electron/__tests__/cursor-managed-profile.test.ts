import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdirTemp("letagents-cursor-managed-profile-");
process.env.LETAGENTS_STATE_PATH = join(tempDir, "mcp-state.json");

const {
  filterLetAgentsCursorMcpConfig,
  normalizeCursorMcpPolicy,
  prepareCursorManagedProfile,
} = await import("../main/agents/cursor-managed-profile.js");

test.after(() => {
  delete process.env.LETAGENTS_STATE_PATH;
  delete process.env.LETAGENTS_CURSOR_MANAGED_HOME;
  delete process.env.LETAGENTS_CURSOR_SOURCE_HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

test("Cursor managed profile defaults to filtering LetAgents while preserving other MCP servers", () => {
  const sourceHome = join(tempDir, "source-home-filter");
  const sourceCursor = join(sourceHome, ".cursor");
  mkdirSync(sourceCursor, { recursive: true });
  writeFileSync(join(sourceCursor, "cli-config.json"), '{"authInfo":{"email":"user@example.com"}}\n');
  writeFileSync(join(sourceCursor, "agent-cli-state.json"), '{"version":1}\n');
  writeFileSync(join(sourceCursor, "mcp.json"), `${JSON.stringify({
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
      letagents: {
        command: "npx",
        args: ["-y", "letagents"],
      },
      renamedRoomBridge: {
        command: "npx",
        args: ["-y", "letagents"],
      },
      envBridge: {
        command: "node",
        args: ["server.js"],
        env: {
          LETAGENTS_API_URL: "https://letagents.chat",
        },
      },
    },
    extraKey: true,
  })}\n`);

  const managedHome = join(tempDir, "managed-home-filter");
  const profile = prepareCursorManagedProfile({
    sourceHomeDir: sourceHome,
    homeDir: managedHome,
    workspaceRoot: tempDir,
  });

  assert.equal(profile.homeDir, managedHome);
  assert.equal(profile.env.HOME, managedHome);
  assert.equal(profile.env.CURSOR_CONFIG_DIR, join(profile.configDir, "cursor"));
  assert.equal(profile.env.CURSOR_DATA_DIR, join(profile.dataDir, "cursor"));
  assert.equal(readFileSync(join(managedHome, ".cursor", "cli-config.json"), "utf-8"), '{"authInfo":{"email":"user@example.com"}}\n');
  assert.equal(readFileSync(join(managedHome, ".cursor", "agent-cli-state.json"), "utf-8"), '{"version":1}\n');
  assert.deepEqual(
    JSON.parse(readFileSync(join(managedHome, ".cursor", "mcp.json"), "utf-8")),
    {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
      extraKey: true,
    },
  );
});

test("Cursor managed profile writes an empty MCP config for none policy", () => {
  const sourceHome = join(tempDir, "source-home-none");
  const sourceCursor = join(sourceHome, ".cursor");
  mkdirSync(sourceCursor, { recursive: true });
  writeFileSync(join(sourceCursor, "mcp.json"), '{"mcpServers":{"filesystem":{"command":"npx"}}}\n');

  const managedHome = join(tempDir, "managed-home-none");
  prepareCursorManagedProfile({
    sourceHomeDir: sourceHome,
    homeDir: managedHome,
    workspaceRoot: tempDir,
    mcpPolicy: "none",
  });

  assert.equal(readFileSync(join(managedHome, ".cursor", "mcp.json"), "utf-8"), '{"mcpServers":{}}\n');
});

test("Cursor managed profile uses normal Cursor config without creating a managed profile", () => {
  const sourceHome = join(tempDir, "source-home-normal");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  writeFileSync(join(sourceHome, ".cursor", "mcp.json"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');
  const workspace = join(tempDir, "workspace-normal-with-letagents");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "mcp.json"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');
  const managedHome = join(tempDir, "managed-home-normal");

  const profile = prepareCursorManagedProfile({
    sourceHomeDir: sourceHome,
    homeDir: managedHome,
    workspaceRoot: workspace,
    mcpPolicy: "normal",
  });

  assert.equal(profile.homeDir, sourceHome);
  assert.deepEqual(profile.env, {});
  assert.equal(existsSync(managedHome), false);
  assert.equal(readFileSync(join(sourceHome, ".cursor", "mcp.json"), "utf-8"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');
});

test("Cursor managed profile rejects workspace-level LetAgents MCP config for managed policies", () => {
  const sourceHome = join(tempDir, "source-home-no-mcp");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-with-mcp");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "mcp.json"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');

  assert.throws(
    () => prepareCursorManagedProfile({
      sourceHomeDir: sourceHome,
      homeDir: join(tempDir, "managed-home-reject"),
      workspaceRoot: workspace,
    }),
    /workspace MCP config exposes LetAgents/,
  );
  assert.equal(existsSync(join(tempDir, "managed-home-reject")), false);
});

test("Cursor MCP config filtering handles invalid shapes and renamed LetAgents servers", () => {
  assert.deepEqual(filterLetAgentsCursorMcpConfig(null), { mcpServers: {} });
  assert.deepEqual(
    filterLetAgentsCursorMcpConfig({
      mcpServers: {
        postgres: { command: "postgres-mcp" },
        renamed: {
          command: "node",
          args: ["./letagents-mcp.js"],
        },
      },
    }),
    {
      mcpServers: {
        postgres: { command: "postgres-mcp" },
      },
    },
  );
});

test("Cursor MCP policy normalization defaults to filter_letagents", () => {
  assert.equal(normalizeCursorMcpPolicy(undefined), "filter_letagents");
  assert.equal(normalizeCursorMcpPolicy(""), "filter_letagents");
  assert.equal(normalizeCursorMcpPolicy("normal"), "normal");
  assert.equal(normalizeCursorMcpPolicy("none"), "none");
});

function mkdirTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
