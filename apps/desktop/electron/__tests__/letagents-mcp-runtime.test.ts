import assert from "node:assert/strict";
import { mkdirSync, realpathSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";
import {
  LETAGENTS_MCP_RUNTIME_VERSION,
  clearLetAgentsMcpRuntimeVerificationCacheForTest,
  clearLetAgentsMcpRuntimeWarmupsForTest,
  computeLetAgentsMcpRuntimeTreeSha256,
  letAgentsMcpRuntimeTreeWalkCountsForTest,
  resolveLetAgentsMcpRuntime,
  warmLetAgentsMcpRuntime,
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

test("a sealed runtime tree is hashed once while every entry's metadata is unchanged", async () => {
  const resources = join(tempDir, "memo-resources");
  const nodeModules = join(resources, "app", "runtime", "letagents", "node_modules");
  const packageRoot = join(nodeModules, "letagents");
  writeRuntimePackage(packageRoot, LETAGENTS_MCP_RUNTIME_VERSION);
  const dependencyFile = join(nodeModules, "dependency", "index.js");
  mkdirSync(join(nodeModules, "dependency"), { recursive: true });
  writeFileSync(dependencyFile, "module.exports = 1;\n");
  // A whole-second mtime can be put back exactly (utimes rounds sub-ms values).
  const WHOLE_SECOND = 1_700_000_000;
  utimesSync(dependencyFile, WHOLE_SECOND, WHOLE_SECOND);
  const expectedBundledTreeSha256 = computeLetAgentsMcpRuntimeTreeSha256(nodeModules);
  const resolveOnce = () => resolveLetAgentsMcpRuntime({ resourcesPath: resources, env: {}, expectedBundledTreeSha256 });
  const counts = letAgentsMcpRuntimeTreeWalkCountsForTest;
  clearLetAgentsMcpRuntimeVerificationCacheForTest();

  // A tree written within the racy window is hashed on every resolution.
  const racy = { ...counts };
  resolveOnce();
  resolveOnce();
  assert.equal(counts.hashes - racy.hashes, 2, "a just-written tree is never remembered");

  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const before = { ...counts };
  // Before this memo: every resolution read and hashed the whole tree.
  for (let index = 0; index < 5; index += 1) resolveOnce();
  assert.equal(counts.hashes - before.hashes, 1, "five resolutions cost one complete hash");
  assert.equal(counts.metadataWalks - before.metadataWalks, 4, "later resolutions still walk the complete tree");

  // Same size and the old mtime put back: only ctime reveals this write.
  const original = statSync(dependencyFile, { bigint: true });
  writeFileSync(dependencyFile, "module.exports = 3;\n");
  utimesSync(dependencyFile, WHOLE_SECOND, WHOLE_SECOND);
  assert.equal(statSync(dependencyFile, { bigint: true }).mtimeNs, original.mtimeNs);
  assert.throws(resolveOnce, /complete tree integrity check/, "a write that keeps mtime still forces a re-hash");

  // Same size, deep in a dependency: only the metadata reveals it.
  writeFileSync(dependencyFile, "module.exports = 2;\n");
  const tampered = { ...counts };
  assert.throws(resolveOnce, /complete tree integrity check/);
  assert.equal(counts.hashes - tampered.hashes, 1, "changed metadata forces a complete re-hash");
  assert.throws(resolveOnce, /complete tree integrity check/, "a failed tree is never remembered");

  writeFileSync(dependencyFile, "module.exports = 1;\n");
  symlinkSync(dependencyFile, join(nodeModules, "dependency", "link.js"));
  assert.throws(resolveOnce, /redirected entry/, "structural rules run on every resolution");
});

test("the daemon's background verification seeds the memo, so the first resolution reads no file contents", async () => {
  const resources = join(tempDir, "warm-resources");
  const nodeModules = join(resources, "app", "runtime", "letagents", "node_modules");
  writeRuntimePackage(join(nodeModules, "letagents"), LETAGENTS_MCP_RUNTIME_VERSION);
  mkdirSync(join(nodeModules, "dependency", "nested", "deeper"), { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(join(nodeModules, "dependency", `file-${index}.js`), `module.exports = ${index};\n`.repeat(index * 40 + 1));
  }
  writeFileSync(join(nodeModules, "dependency", "nested", "deeper", "leaf.js"), "module.exports = 'leaf';\n");
  writeFileSync(join(nodeModules, "dependency", "nested", "empty.js"), "");
  const expectedBundledTreeSha256 = computeLetAgentsMcpRuntimeTreeSha256(nodeModules);
  const counts = letAgentsMcpRuntimeTreeWalkCountsForTest;
  clearLetAgentsMcpRuntimeVerificationCacheForTest();
  clearLetAgentsMcpRuntimeWarmupsForTest();
  const input = { resourcesPath: resources, env: {}, expectedBundledTreeSha256, racyRetryDelayMs: 1_100 };

  // The tree was written moments ago: the first hash matches but is not remembered, so it is hashed again after the delay.
  const before = { ...counts };
  const first = warmLetAgentsMcpRuntime(input);
  assert.equal(warmLetAgentsMcpRuntime(input), first, "concurrent requests share one verification");
  await first;
  const backgroundHashes = counts.backgroundHashes - before.backgroundHashes;
  assert.ok(backgroundHashes >= 2 && backgroundHashes <= 3, `a racy tree is hashed again (${backgroundHashes} hashes)`);
  assert.equal(counts.hashes - before.hashes, 0, "nothing was hashed on the calling thread");

  const warmed = { ...counts };
  resolveLetAgentsMcpRuntime({ resourcesPath: resources, env: {}, expectedBundledTreeSha256 });
  assert.equal(counts.hashes - warmed.hashes, 0, "the first resolution reads no file contents");
  assert.equal(counts.metadataWalks - warmed.metadataWalks, 1, "it still walks the complete tree's metadata");
  await warmLetAgentsMcpRuntime(input);
  assert.equal(counts.backgroundHashes, warmed.backgroundHashes, "a remembered tree is not verified again");

  // Same size, deep in a dependency: the metadata walk catches it, and resolution re-hashes and fails closed.
  writeFileSync(join(nodeModules, "dependency", "nested", "deeper", "leaf.js"), "module.exports = 'LEAF';\n");
  assert.throws(() => resolveLetAgentsMcpRuntime({ resourcesPath: resources, env: {}, expectedBundledTreeSha256 }), /complete tree integrity check/);
});

test("a tampered tree fails the background verification closed, remembers nothing, and is verified again on the next request", async () => {
  const resources = join(tempDir, "warm-tampered");
  const nodeModules = join(resources, "app", "runtime", "letagents", "node_modules");
  const entry = writeRuntimePackage(join(nodeModules, "letagents"), LETAGENTS_MCP_RUNTIME_VERSION);
  mkdirSync(join(nodeModules, "dependency"), { recursive: true });
  writeFileSync(join(nodeModules, "dependency", "index.js"), "module.exports = 1;\n");
  const expectedBundledTreeSha256 = computeLetAgentsMcpRuntimeTreeSha256(nodeModules);
  writeFileSync(join(nodeModules, "dependency", "index.js"), "module.exports = 2;\n");
  const counts = letAgentsMcpRuntimeTreeWalkCountsForTest;
  clearLetAgentsMcpRuntimeVerificationCacheForTest();
  clearLetAgentsMcpRuntimeWarmupsForTest();
  const input = { resourcesPath: resources, env: {}, expectedBundledTreeSha256, racyRetryDelayMs: 10 };

  await assert.rejects(warmLetAgentsMcpRuntime(input), /complete tree integrity check/);
  const again = { ...counts };
  await assert.rejects(warmLetAgentsMcpRuntime(input), /complete tree integrity check/);
  assert.equal(counts.backgroundHashes - again.backgroundHashes, 1, "a failed verification is not cached");
  assert.throws(() => resolveLetAgentsMcpRuntime({ resourcesPath: resources, env: {}, expectedBundledTreeSha256 }),
    /complete tree integrity check/, "resolution fails closed on its own check");

  const outsideEntry = join(tempDir, "outside-entry.js");
  writeFileSync(outsideEntry, "// outside the sealed root\n");
  unlinkSync(entry);
  symlinkSync(outsideEntry, entry);
  const redirected = { ...counts };
  await assert.rejects(warmLetAgentsMcpRuntime(input), /redirected/, "structural rules fail before any file is read");
  assert.equal(counts.backgroundHashes, redirected.backgroundHashes);
});

test("background verification has nothing to do for a development entry or a missing bundled runtime", async () => {
  const counts = letAgentsMcpRuntimeTreeWalkCountsForTest;
  const before = { ...counts };
  await warmLetAgentsMcpRuntime({ devEntryPath: join(tempDir, "dev-entry.js"), env: {} });
  await warmLetAgentsMcpRuntime({ resourcesPath: join(tempDir, "missing"), env: {} });
  await warmLetAgentsMcpRuntime({ resourcesPath: "", env: {} });
  assert.deepEqual({ ...counts }, before);
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
