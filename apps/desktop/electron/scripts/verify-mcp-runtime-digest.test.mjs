import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertInstalledMcpPackage,
  assertLockedMcpRuntimeContract,
  verifyLockedMcpRuntimeDigest,
} from "./mcp-runtime-install.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

// A stand-in for the real install: writes a small tree instead of running
// npm, so the check's own logic is tested without the registry.
function fakeInstall(files) {
  return async ({ destination }) => {
    const nodeModules = join(destination, "node_modules");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(nodeModules, path)), { recursive: true });
      await writeFile(join(nodeModules, path), content);
    }
    return nodeModules;
  };
}

async function runtimeSourceWith(directory, runtimePackage) {
  const source = join(directory, "runtime");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify(runtimePackage));
  await writeFile(join(source, "package-lock.json"), "{}");
  return source;
}

test("a lock whose tree no longer matches the seal is reported with both values", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mcp-runtime-digest-"));
  try {
    const source = await runtimeSourceWith(temp, { dependencies: { letagents: "1.2.3" }, overrides: { a: "1" } });
    const tree = { "letagents/package.json": JSON.stringify({ name: "letagents", version: "1.2.3" }) };
    const seen = [];
    const computeTreeSha256 = (nodeModules) => { seen.push(nodeModules); return "found-digest"; };
    const mismatch = await verifyLockedMcpRuntimeDigest({
      runtimeSource: source, workspacePackage: { overrides: { a: "1" } }, mcpVersion: "1.2.3",
      destination: join(temp, "install"), sealedDigest: "sealed-digest", computeTreeSha256, install: fakeInstall(tree),
    });
    assert.deepEqual(mismatch, { ok: false, expected: "sealed-digest", found: "found-digest" });
    assert.deepEqual(seen, [join(temp, "install", "node_modules")], "the installed tree is what is digested");
    const match = await verifyLockedMcpRuntimeDigest({
      runtimeSource: source, workspacePackage: { overrides: { a: "1" } }, mcpVersion: "1.2.3",
      destination: join(temp, "install-2"), sealedDigest: "found-digest", computeTreeSha256, install: fakeInstall(tree),
    });
    assert.equal(match.ok, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("the check refuses a lock that breaks the packager's contract before installing anything", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mcp-runtime-digest-"));
  try {
    let installed = 0;
    const install = async ({ destination }) => { installed += 1; return join(destination, "node_modules"); };
    await assert.rejects(async () => assertLockedMcpRuntimeContract({
      runtimePackage: { dependencies: { letagents: "1.2.2" }, overrides: {} }, workspacePackage: { overrides: {} }, mcpVersion: "1.2.3",
    }), /must depend on letagents@1\.2\.3/);
    await assert.rejects(async () => assertLockedMcpRuntimeContract({
      runtimePackage: { dependencies: { letagents: "1.2.3" }, overrides: { a: "1" } }, workspacePackage: { overrides: { a: "2" } }, mcpVersion: "1.2.3",
    }), /inherit the workspace dependency overrides exactly/);
    const source = await runtimeSourceWith(temp, { dependencies: { letagents: "1.2.2" }, overrides: {} });
    const message = await verifyLockedMcpRuntimeDigest({
      runtimeSource: source, workspacePackage: { overrides: {} }, mcpVersion: "1.2.3", destination: join(temp, "y"),
      sealedDigest: "s", computeTreeSha256: () => "unused", install,
    }).catch((error) => error.message);
    assert.match(message, /must depend on letagents@1\.2\.3/);
    assert.equal(installed, 0, "nothing is installed for a lock that could not be packaged");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("an installed tree holding the wrong package version is refused", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mcp-runtime-digest-"));
  try {
    const nodeModules = await fakeInstall({
      "letagents/package.json": JSON.stringify({ name: "letagents", version: "1.2.2" }),
    })({ destination: temp });
    await assert.rejects(assertInstalledMcpPackage(nodeModules, "1.2.3"), /requires letagents@1\.2\.3; found 'letagents@1\.2\.2'/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("the packager installs and checks the runtime through the same helper CI uses", async () => {
  const [packager, verifier, ci] = await Promise.all([
    readFile(join(scriptsDirectory, "package-artifact.mjs"), "utf8"),
    readFile(join(scriptsDirectory, "verify-mcp-runtime-digest.mjs"), "utf8"),
    readFile(join(scriptsDirectory, "../../../../.github/workflows/ci.yml"), "utf8"),
  ]);
  assert.match(packager, /from "\.\/mcp-runtime-install\.mjs"/);
  assert.match(packager, /await installLockedMcpRuntime\(\{/);
  assert.match(packager, /assertLockedMcpRuntimeContract\(\{/);
  assert.match(packager, /await assertInstalledMcpPackage\(runtimeNodeModules, mcpVersion\)/);
  assert.doesNotMatch(packager, /execFileAsync\("npm", \[\s*"ci",\s*"--omit=dev",\s*"--ignore-scripts",\s*"--no-audit"/,
    "the packager no longer installs the runtime on its own");
  assert.match(packager, /runtimeTreeSha256 !== runtimeIntegrity\.LETAGENTS_MCP_RUNTIME_TREE_SHA256/);
  assert.match(verifier, /verifyLockedMcpRuntimeDigest\(\{/);
  assert.match(verifier, /letagents-mcp-runtime\.ts/);
  assert.match(verifier, /LETAGENTS_MCP_RUNTIME_TREE_SHA256/);
  // A live step, not one commented out.
  assert.match(ci, /^\s*run: npm --prefix apps\/desktop run verify:mcp-runtime-digest\s*$/m);
});
