import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";
import {
  LETAGENTS_MCP_RUNTIME_VERSION,
  computeLetAgentsMcpRuntimeTreeSha256,
  resolveLetAgentsMcpRuntime,
} from "../main/agents/letagents-mcp-runtime.js";

const { tempDir } = createElectronTestEnv({
  prefix: "letagents-packaged-mcp-runtime-",
  paths: ["state"],
});

test("packaged MCP runtime resolves one exact absolute entry and dependency tree", () => {
  const resources = join(tempDir, "resources");
  const packageRoot = join(
    resources,
    "app",
    "runtime",
    "letagents",
    "node_modules",
    "letagents",
  );
  const entry = writeRuntimePackage(packageRoot, LETAGENTS_MCP_RUNTIME_VERSION);
  mkdirSync(join(dirnamePackageRoot(packageRoot), "dependency"), { recursive: true });
  const expectedBundledTreeSha256 = computeLetAgentsMcpRuntimeTreeSha256(dirnamePackageRoot(packageRoot));

  const runtime = resolveLetAgentsMcpRuntime({
    resourcesPath: resources,
    env: {},
    expectedBundledTreeSha256,
  });

  assert.equal(runtime.entryPath, realpathSync(entry));
  assert.deepEqual(runtime.readRoots, [
    realpathSync(packageRoot),
    realpathSync(dirnamePackageRoot(packageRoot)),
  ]);
});

test("bundled MCP runtime rejects redirected ancestors and complete-tree tampering", () => {
  const redirectedResources = join(tempDir, "redirected-resources");
  const redirectedRuntime = join(redirectedResources, "app", "runtime", "letagents");
  const outsidePackage = join(tempDir, "outside-letagents-package");
  writeRuntimePackage(outsidePackage, LETAGENTS_MCP_RUNTIME_VERSION);
  mkdirSync(join(outsidePackage, "node_modules"), { recursive: true });
  mkdirSync(join(redirectedRuntime, "node_modules"), { recursive: true });
  symlinkSync(outsidePackage, join(redirectedRuntime, "node_modules", "letagents"), "dir");
  assert.throws(
    () => resolveLetAgentsMcpRuntime({
      resourcesPath: redirectedResources,
      env: {},
      expectedBundledTreeSha256: "0".repeat(64),
    }),
    /path is redirected|redirected entry/,
  );

  const tamperedResources = join(tempDir, "tampered-resources");
  const packageRoot = join(
    tamperedResources,
    "app",
    "runtime",
    "letagents",
    "node_modules",
    "letagents",
  );
  const entry = writeRuntimePackage(packageRoot, LETAGENTS_MCP_RUNTIME_VERSION);
  mkdirSync(join(dirnamePackageRoot(packageRoot), "dependency"), { recursive: true });
  const expected = computeLetAgentsMcpRuntimeTreeSha256(dirnamePackageRoot(packageRoot));
  writeFileSync(entry, "// modified after sealing\n");
  assert.throws(
    () => resolveLetAgentsMcpRuntime({
      resourcesPath: tamperedResources,
      env: {},
      expectedBundledTreeSha256: expected,
    }),
    /complete tree integrity check/,
  );

  unlinkSync(entry);
  symlinkSync(join(tempDir, "missing-entry"), entry);
  assert.throws(
    () => computeLetAgentsMcpRuntimeTreeSha256(dirnamePackageRoot(packageRoot)),
    /redirected entry/,
  );
});

test("development MCP runtime accepts a canonical dependency target behind the worktree node_modules symlink", () => {
  const packageRoot = join(tempDir, "dev-repo");
  const dependencies = join(tempDir, "shared-node-modules");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(dependencies, { recursive: true });
  symlinkSync(dependencies, join(packageRoot, "node_modules"), "dir");
  const entry = writeRuntimePackage(packageRoot, LETAGENTS_MCP_RUNTIME_VERSION);

  const runtime = resolveLetAgentsMcpRuntime({
    devEntryPath: entry,
    env: { LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://127.0.0.1:5174" },
    resourcesPath: "",
  });

  assert.deepEqual(runtime.readRoots, [realpathSync(packageRoot), realpathSync(dependencies)]);
});

test("MCP runtime resolution fails closed for missing artifacts, wrong versions, and ungated development", () => {
  assert.throws(
    () => resolveLetAgentsMcpRuntime({ resourcesPath: join(tempDir, "missing"), env: {} }),
    /packaged LetAgents MCP runtime is unavailable/,
  );
  const wrongRoot = join(tempDir, "wrong-version");
  const wrongEntry = writeRuntimePackage(wrongRoot, "0.0.0");
  mkdirSync(join(wrongRoot, "node_modules"), { recursive: true });
  assert.throws(
    () => resolveLetAgentsMcpRuntime({
      devEntryPath: wrongEntry,
      env: { LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://127.0.0.1:5174" },
    }),
    new RegExp(`must be letagents@${LETAGENTS_MCP_RUNTIME_VERSION.replaceAll(".", "\\.")}`),
  );
  assert.throws(
    () => resolveLetAgentsMcpRuntime({ devEntryPath: wrongEntry, env: {} }),
    /explicit desktop development mode/,
  );
});

function writeRuntimePackage(packageRoot: string, version: string): string {
  const entry = join(packageRoot, "dist", "mcp", "server.js");
  mkdirSync(join(packageRoot, "dist", "mcp"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: "letagents", version })}\n`);
  writeFileSync(entry, "// runtime fixture\n");
  return entry;
}

function dirnamePackageRoot(packageRoot: string): string {
  return join(packageRoot, "..");
}
