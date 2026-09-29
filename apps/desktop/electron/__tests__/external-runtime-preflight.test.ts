import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopAgentProvider } from "../ipc-types.js";
import { missingExternalRuntimePreflight } from "../main/agents/external-runtime-preflight.js";

function provider(overrides: Partial<DesktopAgentProvider> = {}): DesktopAgentProvider {
  return {
    id: "codex",
    name: "Codex",
    description: "Codex",
    capabilities: ["desktop_managed_runtime"],
    runtimeCommand: "codex",
    runtimeInstallCommand: "install codex",
    runtimeInstallUrl: "https://example.com/codex",
    mcpTargetId: "codex",
    permissionProfiles: [],
    defaultPermissionProfileId: null,
    ...overrides,
  };
}

test("missing external runtime preflight derives consistent actionable copy from registry metadata", () => {
  const result = missingExternalRuntimePreflight(provider(), "not_installed");
  assert.equal(result.status, "missing_runtime");
  assert.equal(result.nextAction, "install_external_runtime");
  assert.match(result.detail || "", /LetAgents does not install or update external provider CLIs/);
});

test("missing external runtime preflight fails closed when the registry has no install route", () => {
  const result = missingExternalRuntimePreflight(provider({
    runtimeInstallCommand: null,
    runtimeInstallUrl: null,
  }), "installed");
  assert.equal(result.status, "error");
  assert.equal(result.nextAction, null);
  assert.match(result.detail || "", /missing both an install command and an installation guide/i);
});

test("supervised Codex supplies its own connection and setup refresh explicitly reconciles the daemon environment", async (t) => {
  const { supervisorDaemonClient } = await import("../main/supervisor-daemon.js");
  let environmentCurrent = true;
  const compare = t.mock.method(supervisorDaemonClient, "isRuntimeEnvironmentCurrent", async () => environmentCurrent);
  const refresh = t.mock.method(supervisorDaemonClient, "restartForEnvironmentRefresh", async () => { environmentCurrent = true; return {} as never; });
  const { createElectronTestEnv } = await import("./harness.js");
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const env = createElectronTestEnv({ prefix: "codex-supervised-preflight-", paths: [],
    extraCleanupEnvKeys: ["LETAGENTS_CODEX_BIN", "LETAGENTS_DESKTOP_MCP_CONFIG_HOME", "LETAGENTS_DESKTOP_USER_DATA_DIR"] });
  const bin = join(env.tempDir, "codex");
  process.env.LETAGENTS_CODEX_BIN = bin;
  process.env.LETAGENTS_DESKTOP_MCP_CONFIG_HOME = join(env.tempDir, "mcp-config");
  process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = join(env.tempDir, "user-data");
  await writeFile(bin, "#!/usr/bin/env node\nconsole.log(process.argv[2] === '--version' ? 'codex-cli 0.153.4' : 'signed in');\n", { mode: 0o755 });
  const { runDesktopAgentProviderPreflight } = await import("../main/agents/providers.js");
  const supervised = await runDesktopAgentProviderPreflight("codex", { roomOnly: true, launchMode: "supervised" });
  assert.equal(supervised.mcpStatus, "not_installed");
  assert.equal(supervised.status, "ready");
  assert.equal(supervised.canStart, true);
  assert.equal(compare.mock.callCount(), 1);
  assert.equal(refresh.mock.callCount(), 0, "ordinary setup is read-only");
  environmentCurrent = false;
  const stale = await runDesktopAgentProviderPreflight("codex", { roomOnly: true, launchMode: "supervised" });
  assert.equal(stale.status, "config_required");
  assert.equal(stale.canStart, false);
  assert.equal(stale.message, "Agent setup needs refreshing.");
  assert.equal(refresh.mock.callCount(), 0, "environment drift must not silently replace live runtimes");
  const { refreshDesktopShellEnvironment } = await import("../main/desktop-shell-environment.js");
  assert.equal((await refreshDesktopShellEnvironment()).changed, false);
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  t.after(() => { if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous; });
  const refreshed = await runDesktopAgentProviderPreflight("codex", { roomOnly: true, launchMode: "supervised", refreshEnvironment: true });
  assert.equal(refreshed.canStart, true);
  assert.equal(refresh.mock.callCount(), 1, "explicit refresh compares the daemon even when Electron PATH is unchanged");
  const legacy = await runDesktopAgentProviderPreflight("codex", { roomOnly: true, launchMode: "legacy" });
  assert.equal(legacy.status, "bridge_required");
  assert.equal(legacy.nextAction, "install_mcp_bridge");
  assert.equal(legacy.canStart, false);
});
