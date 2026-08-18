import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "letagents-mcp-setup-install-",
  paths: [],
  extraCleanupEnvKeys: [
    "LETAGENTS_API_URL",
    "LETAGENTS_DESKTOP_MCP_CONFIG_HOME",
    "LETAGENTS_DESKTOP_USER_DATA_DIR",
  ],
});
const configHome = join(env.tempDir, "home");
const userDataDirectory = join(env.tempDir, "user-data");
process.env.LETAGENTS_API_URL = "https://example.invalid";
process.env.LETAGENTS_DESKTOP_MCP_CONFIG_HOME = configHome;
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = userDataDirectory;

// A directory at the destination makes the final atomic rename fail while
// leaving the other selected target fully writable.
await mkdir(join(configHome, ".cursor", "mcp.json"), { recursive: true });

const { installLetAgentsMcpServers } = await import("../main/mcp-setup.js");

test("keeps successful MCP installs and reports each failed target", async () => {
  const result = await installLetAgentsMcpServers(["claude-code", "cursor"]);

  assert.equal(result.success, false);
  assert.equal(result.targets.find((target) => target.id === "claude-code")?.status, "installed");
  assert.equal(result.targets.find((target) => target.id === "cursor")?.status, "needs_attention");
  assert.deepEqual(
    result.failures.map((failure) => failure.targetId),
    ["cursor"],
  );
  assert.match(result.message, /Claude Code installed/);
  assert.match(result.message, /Couldn't install Cursor/);

  const claudeConfig = JSON.parse(
    await readFile(join(configHome, ".claude", "settings.json"), "utf8"),
  ) as { mcpServers?: { letagents?: { command?: string } } };
  assert.equal(claudeConfig.mcpServers?.letagents?.command, "npx");

  const storedSetup = JSON.parse(
    await readFile(join(userDataDirectory, "letagents-desktop-setup.json"), "utf8"),
  ) as { installs?: Record<string, unknown> };
  assert.ok(storedSetup.installs?.["claude-code"]);
  assert.equal(storedSetup.installs?.cursor, undefined);

  const cursorDirectoryEntries = await readdir(join(configHome, ".cursor"));
  assert.deepEqual(cursorDirectoryEntries, ["mcp.json"]);
});
