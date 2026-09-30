#!/usr/bin/env node
// Recompute the packaged MCP runtime tree digest from the committed lock and
// compare it with the value sealed into the desktop code. The packager makes
// the same check when it builds a release; a lock that changed without the
// seal being moved would otherwise fail the release build and nothing before
// it, as it did for desktop 0.1.99.
//
// Runs under `node --import tsx` so that it reads the digest routine and the
// sealed constant from the TypeScript source the packager compiles.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyLockedMcpRuntimeDigest } from "./mcp-runtime-install.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
const workspacePackage = JSON.parse(await readFile(join(desktopRoot, "..", "..", "package.json"), "utf8"));
const mcpVersion = desktopPackage.letagentsRuntime?.mcpVersion;
if (typeof mcpVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(mcpVersion)) {
  throw new Error("apps/desktop/package.json must declare letagentsRuntime.mcpVersion.");
}
const integrity = await import(pathToFileURL(join(desktopRoot, "electron", "main", "agents", "letagents-mcp-runtime.ts")).href);

const destination = await mkdtemp(join(tmpdir(), "letagents-mcp-runtime-"));
try {
  const result = await verifyLockedMcpRuntimeDigest({
    runtimeSource: join(desktopRoot, "electron", "runtime", "letagents"),
    workspacePackage,
    mcpVersion,
    destination,
    sealedDigest: integrity.LETAGENTS_MCP_RUNTIME_TREE_SHA256,
    computeTreeSha256: integrity.computeLetAgentsMcpRuntimeTreeSha256,
  });
  if (!result.ok) {
    console.error(
      `The locked LetAgents MCP runtime tree digest changed: sealed ${result.expected}, found ${result.found}.\n`
      + "The runtime lock at apps/desktop/electron/runtime/letagents and the seal in "
      + "apps/desktop/electron/main/agents/letagents-mcp-runtime.ts (LETAGENTS_MCP_RUNTIME_TREE_SHA256) "
      + "must change together: reseal it to the value found, in the same commit as the lock change.",
    );
    // Not process.exit: that would end the process before the install below
    // is removed.
    process.exitCode = 1;
  } else {
    console.log(`The packaged LetAgents MCP runtime (letagents@${mcpVersion}) matches its sealed digest ${result.found}.`);
  }
} finally {
  await rm(destination, { recursive: true, force: true });
}
