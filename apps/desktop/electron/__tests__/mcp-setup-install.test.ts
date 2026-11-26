import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

// LetAgents entries only in the files Claude Code and the Antigravity CLI do
// not read MCP servers from: they must not count as installed.
const staleEntry = JSON.stringify({ mcpServers: { letagents: { command: "npx", args: ["-y", "letagents"] } } });
await mkdir(join(configHome, ".claude"), { recursive: true });
await writeFile(join(configHome, ".claude", "settings.json"), staleEntry);
await mkdir(join(configHome, ".gemini"), { recursive: true });
await writeFile(join(configHome, ".gemini", "settings.json"), staleEntry);

const { buildMcpInstallState, installLetAgentsMcpServers } = await import("../main/mcp-setup.js");

test("an entry Claude Code and Antigravity do not read is not reported as installed", async () => {
  const state = await buildMcpInstallState();
  for (const id of ["claude-code", "antigravity"] as const) {
    assert.equal(state.targets.find((target) => target.id === id)?.status, "not_installed", id);
  }
  const claude = state.targets.find((target) => target.id === "claude-code");
  assert.deepEqual(claude?.configPaths.map((location) => location.path), [join(configHome, ".claude.json")]);
  const antigravity = state.targets.find((target) => target.id === "antigravity");
  assert.deepEqual(antigravity?.configPaths.map((location) => location.path), [join(configHome, ".gemini", "config", "mcp_config.json")]);
});

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

  // ~/.claude.json did not exist: setup creates it, as `claude mcp add --scope user` does.
  const claudeConfig = JSON.parse(
    await readFile(join(configHome, ".claude.json"), "utf8"),
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

test("Antigravity setup writes the CLI's MCP config and keeps its other servers", async () => {
  const path = join(configHome, ".gemini", "config", "mcp_config.json");
  await mkdir(join(configHome, ".gemini", "config"), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: { other: { command: "other-mcp" } } }));

  const result = await installLetAgentsMcpServers(["antigravity"]);

  assert.equal(result.success, true, result.message);
  assert.equal(result.targets[0]?.status, "installed");
  const config = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, { command?: string }> };
  assert.equal(config.mcpServers?.other?.command, "other-mcp");
  assert.equal(config.mcpServers?.letagents?.command, "npx");
  // The old Gemini settings file is not where the CLI looks, and setup leaves it as it was.
  assert.equal(await readFile(join(configHome, ".gemini", "settings.json"), "utf8"), staleEntry);
});
