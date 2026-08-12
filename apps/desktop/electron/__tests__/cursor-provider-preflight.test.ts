import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { DesktopAgentProvider, DesktopAgentProviderPreflightInput } from "../ipc-types.js";
import { createElectronTestEnv } from "./harness.js";
import { LETAGENTS_MCP_RUNTIME_VERSION } from "../main/agents/letagents-mcp-runtime.js";
import type { DesktopCursorPreflightOptions } from "../main/agents/cursor-provider-preflight.js";

const previousNonDarwinOverride = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
if (process.platform !== "darwin") process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
test.after(() => {
  if (previousNonDarwinOverride === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousNonDarwinOverride;
});

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
const fakeCursorMcpMode = join(tempDir, ".fake-cursor-mcp-mode");
const runtimePackageRoot = join(tempDir, "runtime", "node_modules", "letagents");
const runtimeEntry = join(runtimePackageRoot, "dist", "mcp", "server.js");
process.env.LETAGENTS_CURSOR_SOURCE_HOME = cursorSourceHome;
process.env.LETAGENTS_CURSOR_MANAGED_HOME = cursorManagedHome;
process.env.LETAGENTS_CURSOR_AGENT_BIN = fakeCursorBin;

mkdirSync(join(runtimePackageRoot, "dist", "mcp"), { recursive: true });
writeFileSync(join(runtimePackageRoot, "package.json"), JSON.stringify({
  name: "letagents",
  version: LETAGENTS_MCP_RUNTIME_VERSION,
}));
writeFileSync(runtimeEntry, "// preflight runtime fixture\n");
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
  const fixture = path.join(process.cwd(), ".fake-cursor-help");
  console.log(fs.existsSync(fixture) ? fs.readFileSync(fixture, "utf-8") : "Usage: cursor-agent --force --sandbox <mode> --trust");
  process.exit(0);
}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  const modePath = path.join(path.dirname(process.argv[1]), ".fake-cursor-mcp-mode");
  const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8").trim() : "ready";
  if (mode === "unsupported") {
    console.error("unknown option '--disable-project-configs'");
    process.exit(2);
  }
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".cursor", "mcp.json"), "utf8"));
  const serverName = Object.keys(mcpConfig.mcpServers || {})[0] || "";
  if (mode === "missing") console.log("filesystem");
  else if (mode === "extra") console.log(serverName + ": ready\\nfilesystem: ready");
  else if (mode === "false-substring") console.log("evil-letagents: ready");
  else if (mode === "not-ready") console.log(serverName + ": error");
  else console.log(serverName + ": ready");
  process.exit(0);
}
if (args.includes("status")) {
  const teamFixture = path.join(process.cwd(), ".fake-cursor-team-account");
  const teamManaged = fs.existsSync(teamFixture);
  if (teamManaged) {
    const configPath = path.join(process.env.HOME, ".cursor", "cli-config.json");
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
    config.authInfo = { ...(config.authInfo || {}), email: "team@example.test", teamId: 42 };
    fs.writeFileSync(configPath, JSON.stringify(config));
  }
  if (args.includes("--format") && args.includes("json")) {
    console.log(JSON.stringify({
      status: "authenticated",
      isAuthenticated: true,
      userInfo: {
        email: teamManaged ? "team@example.test" : "personal@example.test",
        userId: 12345,
        ...(teamManaged ? { teamId: 42 } : {}),
      },
    }));
    process.exit(0);
  }
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
const { CursorIdentityAuthRequiredError } = await import("../main/agents/cursor-provider-adapter.js");
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
function runPreflight(
  input: DesktopAgentProviderPreflightInput,
  workspaceGenerationSupportChecker: NonNullable<DesktopCursorPreflightOptions["workspaceGenerationSupportChecker"]> = async (realWorkspace) => ({
    sourceRoot: realWorkspace,
    realWorkspace,
    workspaceRelativePath: "",
    headOid: "a".repeat(40),
    headRef: "refs/heads/test",
    gitDirectory: join(realWorkspace, ".git"),
    gitCommonDirectory: join(realWorkspace, ".git"),
    gitIndexPath: join(realWorkspace, ".git", "index"),
    gitObjectDirectory: join(realWorkspace, ".git", "objects"),
  }),
) {
  return runDesktopCursorProviderPreflight(cursorProvider, input, "installed", {
    commandTimeoutMs: 0,
    mcpRuntime: {
      entryPath: runtimeEntry,
      readRoots: [runtimePackageRoot, join(tempDir, "runtime", "node_modules")],
    },
    personalIdentityAttestor: async () => {
      // Production identity inspection deliberately runs from a random
      // disposable profile, not the repository. These fixture markers model
      // provider responses selected by the preflight's requested workspace.
      if (existsSync(join(input.repoRootPath ?? "", ".fake-cursor-auth-required"))) {
        throw new CursorIdentityAuthRequiredError();
      }
      if (existsSync(join(input.repoRootPath ?? "", ".fake-cursor-team-account"))) {
        throw new Error("Team-managed Cursor accounts are not supported for supervised agents.");
      }
      return { userId: 12345, email: "personal@example.test" };
    },
    workspaceGenerationSupportChecker,
  });
}

function setFakeCursorMcpMode(mode: string | null): void {
  if (mode === null) rmSync(fakeCursorMcpMode, { force: true });
  else writeFileSync(fakeCursorMcpMode, `${mode}\n`);
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

test("Cursor supervised preflight requires and accepts its isolated LetAgents bridge", async () => {
  const workspace = workspaceFixture("supervised-letagents-only");
  setFakeCursorMcpMode("ready");

  const result = await runPreflight({
    repoRootPath: workspace,
    launchMode: "supervised",
    cursorMcpPolicy: "normal",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.canStart, true);
  assert.equal(result.message, "Cursor Agent is ready to start supervised with Workspace writes.");
  assert.match(result.detail ?? "", /private per-turn Git workspace/i);
  assert.match(result.detail ?? "", /per-agent Cursor profile exposes only the daemon-mediated LetAgents bridge/i);
  setFakeCursorMcpMode(null);
});

test("Cursor supervised preflight preserves explicit read-only and full-access choices", async () => {
  setFakeCursorMcpMode("ready");
  for (const [name, permissionProfileId, label] of [
    ["supervised-explicit-read-only", "read_only", "Read-only"],
    ["supervised-explicit-full-access", "full_access", "Workspace writes (compatibility)"],
  ] as const) {
    const workspace = workspaceFixture(name);
    const result = await runPreflight({
      repoRootPath: workspace,
      launchMode: "supervised",
      permissionProfileId,
    });
    assert.equal(result.status, "ready");
    assert.equal(result.canStart, true);
    assert.equal(result.message, `Cursor Agent is ready to start supervised with ${label}.`);
  }
  setFakeCursorMcpMode(null);
});

test("Cursor supervised preflight gates writable generations without gating read-only", async () => {
  const workspace = workspaceFixture("supervised-generation-gate");
  let checks = 0;
  const unsupported: NonNullable<DesktopCursorPreflightOptions["workspaceGenerationSupportChecker"]> = async () => {
    checks += 1;
    throw new Error("Writable generations require a canonical Git worktree.");
  };
  setFakeCursorMcpMode("ready");
  try {
    const writable = await runPreflight({
      repoRootPath: workspace,
      launchMode: "supervised",
      permissionProfileId: "sandboxed_write",
    }, unsupported);
    assert.equal(writable.status, "error");
    assert.equal(writable.canStart, false);
    assert.equal(writable.message, "Cursor writable workspace cannot be supervised exactly.");
    assert.match(writable.detail ?? "", /canonical Git worktree/i);

    const readOnly = await runPreflight({
      repoRootPath: workspace,
      launchMode: "supervised",
      permissionProfileId: "read_only",
    }, unsupported);
    assert.equal(readOnly.status, "ready");
    assert.equal(readOnly.canStart, true);
    assert.equal(checks, 1, "read-only never needs a writable generation");
  } finally {
    setFakeCursorMcpMode(null);
  }
});

test("Cursor supervised preflight does not traverse project files before launch", async () => {
  const workspace = workspaceFixture("supervised-no-project-file-walk");
  const outside = join(tempDir, "preflight-outside-hardlink.txt");
  const opaqueProjectDirectory = join(workspace, "opaque-project-subtree");
  writeFileSync(outside, "outside\n");
  linkSync(outside, join(workspace, "outside-alias.txt"));
  mkdirSync(opaqueProjectDirectory);
  writeFileSync(join(opaqueProjectDirectory, "ordinary-project-file.txt"), "project data\n");
  if (process.platform !== "win32") chmodSync(opaqueProjectDirectory, 0o000);
  setFakeCursorMcpMode("ready");

  const result = await (async () => {
    try {
      return await runPreflight({
        repoRootPath: workspace,
        launchMode: "supervised",
        permissionProfileId: "full_access",
      });
    } finally {
      if (process.platform !== "win32") chmodSync(opaqueProjectDirectory, 0o700);
      setFakeCursorMcpMode(null);
    }
  })();

  assert.equal(result.status, "ready");
  assert.equal(result.canStart, true);
  assert.equal(result.message, "Cursor Agent is ready to start supervised with Workspace writes (compatibility).");
});

test("Cursor supervised preflight fails closed when the bridge is not visible", async () => {
  const workspace = workspaceFixture("supervised-no-letagents");
  setFakeCursorMcpMode("missing");

  const result = await runPreflight({
    repoRootPath: workspace,
    launchMode: "supervised",
  });

  assert.equal(result.status, "error");
  assert.equal(result.canStart, false);
  assert.equal(result.message, "Cursor supervised MCP authority is not exact.");
  setFakeCursorMcpMode(null);
});

test("Cursor supervised preflight rejects extra and false-substring MCP entries", async () => {
  for (const [name, mode] of [
    ["supervised-extra-server", "extra"],
    ["supervised-false-substring", "false-substring"],
    ["supervised-not-ready", "not-ready"],
  ] as const) {
    const workspace = workspaceFixture(name);
    setFakeCursorMcpMode(mode);

    const result = await runPreflight({ repoRootPath: workspace, launchMode: "supervised" });

    assert.equal(result.status, "error");
    assert.equal(result.canStart, false);
    assert.equal(result.message, "Cursor supervised MCP authority is not exact.");
    assert.match(result.detail ?? "", /exactly one effective MCP entry/);
  }
  setFakeCursorMcpMode(null);
});

test("Cursor supervised preflight rejects a CLI without headless workspace trust", async () => {
  const workspace = workspaceFixture("supervised-old-cli");
  setFakeCursorMcpMode("ready");
  writeFileSync(join(workspace, ".fake-cursor-help"), "Usage: cursor-agent --force --sandbox <mode>\n");
  const result = await runPreflight({
    repoRootPath: workspace,
    launchMode: "supervised",
  });

  assert.equal(result.status, "error");
  assert.equal(result.canStart, false);
  assert.equal(result.message, "Cursor Agent does not support the selected permission profile.");
  assert.match(result.detail ?? "", /--trust/);
  setFakeCursorMcpMode(null);
});

test("Cursor supervised preflight rejects a CLI without native project-config isolation", async () => {
  const workspace = workspaceFixture("supervised-no-project-isolation");
  setFakeCursorMcpMode("unsupported");

  const result = await runPreflight({ repoRootPath: workspace, launchMode: "supervised" });

  assert.equal(result.status, "error");
  assert.equal(result.canStart, false);
  assert.equal(result.message, "Cursor supervised MCP authority is not exact.");
  setFakeCursorMcpMode(null);
});

test("Cursor supervised preflight fails closed for authenticated team accounts", async () => {
  const workspace = workspaceFixture("supervised-team-account");
  writeFileSync(join(workspace, ".fake-cursor-team-account"), "team\n");
  setFakeCursorMcpMode("ready");

  const result = await runPreflight({ repoRootPath: workspace, launchMode: "supervised" });

  assert.equal(result.status, "error");
  assert.equal(result.canStart, false);
  assert.match(result.detail ?? "", /Team-managed Cursor accounts are not supported/);
  setFakeCursorMcpMode(null);
});

test("Cursor supervised preflight preserves the sign-in recovery action", async () => {
  const workspace = workspaceFixture("supervised-auth-required");
  writeFileSync(join(workspace, ".fake-cursor-auth-required"), "signed out\n");

  const result = await runPreflight({ repoRootPath: workspace, launchMode: "supervised" });

  assert.equal(result.status, "auth_required");
  assert.equal(result.canStart, false);
  assert.equal(result.nextAction, "authenticate");
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
