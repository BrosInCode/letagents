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
  prepareCursorManagedProfile,
} = await import("../main/agents/cursor-managed-profile.js");

test.after(() => {
  delete process.env.LETAGENTS_STATE_PATH;
  delete process.env.LETAGENTS_CURSOR_MANAGED_HOME;
  delete process.env.LETAGENTS_CURSOR_SOURCE_HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

test("Cursor managed profile copies auth metadata but writes an empty MCP config", () => {
  const sourceHome = join(tempDir, "source-home");
  const sourceCursor = join(sourceHome, ".cursor");
  mkdirSync(sourceCursor, { recursive: true });
  writeFileSync(join(sourceCursor, "cli-config.json"), '{"authInfo":{"email":"user@example.com"}}\n');
  writeFileSync(join(sourceCursor, "agent-cli-state.json"), '{"version":1}\n');
  writeFileSync(join(sourceCursor, "mcp.json"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');

  const managedHome = join(tempDir, "managed-home");
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
  assert.equal(readFileSync(join(managedHome, ".cursor", "mcp.json"), "utf-8"), '{"mcpServers":{}}\n');
});

test("Cursor managed profile rejects workspace-level LetAgents MCP config", () => {
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

function mkdirTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
