import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopAgentProvider } from "../ipc-types.js";
import { missingExternalRuntimePreflight } from "../main/agents/external-runtime-preflight.js";
import { cachedProbe, clearProbeCache, probeKey } from "../main/agents/provider-probe-cache.js";

// Each case below writes its own fake CLI; no case may inherit a probe answer
// that an earlier case memoised.
test.beforeEach(() => clearProbeCache());

function provider(overrides: Partial<DesktopAgentProvider> = {}): DesktopAgentProvider {
  return {
    id: "codex",
    name: "Codex",
    description: "Codex",
    capabilities: ["supervised_runtime"],
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

test("Codex supplies its own connection and setup refresh explicitly reconciles the daemon environment", async (t) => {
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
  const supervised = await runDesktopAgentProviderPreflight("codex", { roomOnly: true });
  assert.equal(supervised.mcpStatus, "not_installed");
  assert.equal(supervised.status, "ready");
  assert.equal(supervised.canStart, true);
  assert.equal(compare.mock.callCount(), 1);
  assert.equal(refresh.mock.callCount(), 0, "ordinary setup is read-only");
  environmentCurrent = false;
  const stale = await runDesktopAgentProviderPreflight("codex", { roomOnly: true });
  assert.equal(stale.status, "config_required");
  assert.equal(stale.canStart, false);
  assert.equal(stale.message, "Agent setup needs refreshing.");
  assert.equal(refresh.mock.callCount(), 0, "environment drift must not silently replace live runtimes");
  const { refreshDesktopShellEnvironment } = await import("../main/desktop-shell-environment.js");
  assert.equal((await refreshDesktopShellEnvironment()).changed, false);
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  t.after(() => { if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous; });
  const refreshed = await runDesktopAgentProviderPreflight("codex", { roomOnly: true, refreshEnvironment: true });
  assert.equal(refreshed.canStart, true);
  assert.equal(refresh.mock.callCount(), 1, "explicit refresh compares the daemon even when Electron PATH is unchanged");
});

test("Codex preflight reuses its CLI probes inside the window; Check again and a setup action re-run them", async (t) => {
  const { supervisorDaemonClient } = await import("../main/supervisor-daemon.js");
  t.mock.method(supervisorDaemonClient, "isRuntimeEnvironmentCurrent", async () => true);
  let duringEnvironmentRefresh: (() => Promise<unknown>) | null = null;
  t.mock.method(supervisorDaemonClient, "restartForEnvironmentRefresh", async () => {
    await duringEnvironmentRefresh?.();
    return {} as never;
  });
  const { createElectronTestEnv } = await import("./harness.js");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const env = createElectronTestEnv({ prefix: "codex-probe-cache-", paths: [],
    extraCleanupEnvKeys: ["LETAGENTS_CODEX_BIN", "LETAGENTS_DESKTOP_MCP_CONFIG_HOME", "LETAGENTS_DESKTOP_USER_DATA_DIR"] });
  const bin = join(env.tempDir, "codex");
  const probeLog = `${bin}.probes`;
  process.env.LETAGENTS_CODEX_BIN = bin;
  process.env.LETAGENTS_DESKTOP_MCP_CONFIG_HOME = join(env.tempDir, "mcp-config");
  process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = join(env.tempDir, "user-data");
  const previousNonDarwin = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  t.after(() => {
    if (previousNonDarwin === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
    else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousNonDarwin;
  });
  await writeFile(bin, [
    "#!/usr/bin/env node",
    `require("node:fs").appendFileSync(${JSON.stringify(probeLog)}, process.argv.slice(2).join(" ") + "\\n");`,
    "console.log(process.argv[2] === '--version' ? 'codex-cli 0.153.4' : 'signed in');",
    "",
  ].join("\n"), { mode: 0o755 });
  const probes = async () => (await readFile(probeLog, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line === "--version" || line === "login status");
  const { runDesktopAgentProviderPreflight, runDesktopAgentProviderSetup } = await import("../main/agents/providers.js");

  for (let run = 0; run < 3; run += 1) {
    const result = await runDesktopAgentProviderPreflight("codex", { roomOnly: true });
    assert.equal(result.status, "ready");
    assert.equal(result.canStart, true);
  }
  assert.deepEqual(await probes(), ["--version", "login status"], "three preflights spawn each probe once");

  const rechecked = await runDesktopAgentProviderPreflight("codex", { roomOnly: true, refreshEnvironment: true });
  assert.equal(rechecked.canStart, true);
  assert.deepEqual(await probes(), ["--version", "login status", "--version", "login status"],
    "Check again forgets the memoised probes");
  await runDesktopAgentProviderPreflight("codex", { roomOnly: true });
  assert.equal((await probes()).length, 4, "the probes run by Check again are memoised again");

  const setup = await runDesktopAgentProviderSetup("codex", { action: "install_mcp_bridge" });
  assert.equal(setup.success, false, "an unconfirmed setup action changes nothing");
  await runDesktopAgentProviderPreflight("codex", { roomOnly: true });
  assert.equal((await probes()).length, 6, "a setup action forgets the memoised probes");

  // A preflight that overlaps "Check again" can memoise answers from the old
  // environment while the refresh runs. The second clear forgets those too.
  duringEnvironmentRefresh = () => runDesktopAgentProviderPreflight("codex", { roomOnly: true });
  const overlapped = await runDesktopAgentProviderPreflight("codex", { roomOnly: true, refreshEnvironment: true });
  duringEnvironmentRefresh = null;
  assert.equal(overlapped.canStart, true);
  assert.equal((await probes()).length, 10,
    "the overlapping preflight ran its probes and Check again ran them again after the refresh");
});

test("a setup action forgets the probes that were memoised while it ran, even when it fails", async () => {
  const { runDesktopAgentProviderSetup } = await import("../main/agents/providers.js");
  const key = probeKey("setup-action-fake", ["--version"]);
  let reruns = 0;
  const rerun = async () => {
    reruns += 1;
    return "after the action";
  };

  // The call clears the memo at once and again when the action settles, so a
  // probe memoised in between must be gone once the action has returned.
  const finishing = runDesktopAgentProviderSetup("codex", { action: "install_mcp_bridge" });
  await cachedProbe(key, async () => "during the action");
  await finishing;
  assert.equal(await cachedProbe(key, rerun), "after the action");
  assert.equal(reruns, 1, "the probe memoised during a finished action is forgotten");

  assert.equal(await cachedProbe(key, rerun), "after the action");
  assert.equal(reruns, 1, "outside a setup action the memo still serves the probe");

  const failing = runDesktopAgentProviderSetup("codex", { action: "install_runtime" });
  const failed = assert.rejects(failing, /does not support install_runtime/);
  await cachedProbe(probeKey("setup-action-fake", ["login", "status"]), async () => "during the failing action");
  await failed;
  assert.equal(await cachedProbe(key, rerun), "after the action");
  assert.equal(reruns, 2, "a failed action clears the memo too");
});
