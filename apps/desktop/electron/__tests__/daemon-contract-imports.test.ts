import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DAEMON_IMPLEMENTATION_VERSION,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_STATE_ACTIVITY_SUMMARY_LIMIT,
} from "#daemon-contract/index.js";
import {
  SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
  SUPERVISOR_DAEMON_PROTOCOL_VERSION,
  SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT,
} from "../main/supervisor-daemon/constants.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith("dist-") || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (/\.(ts|mts|cts|mjs|cjs|js|vue)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("code outside daemon-contract imports it only by the #daemon-contract name", () => {
  const relativeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](?:\.\.?\/)+(?:[^"']*\/)?(?:dist-)?daemon-contract\//;
  const offenders: string[] = [];
  for (const file of sourceFiles(desktopRoot)) {
    const path = relative(desktopRoot, file).split(sep).join("/");
    if (path.startsWith("daemon-contract/")) continue;
    if (relativeImport.test(readFileSync(file, "utf8"))) offenders.push(path);
  }
  assert.deepEqual(offenders, [], 'import the daemon contract as "#daemon-contract/<file>.js"');
});

test("daemon-contract is a pure leaf package with no imports from daemon, electron, renderer, or provider-runtime", () => {
  const forbiddenImport = /(?:from\s+|import\s*\(\s*|import\s+)["'](?:(?:\.\.\/)+(?:electron|daemon|renderer|provider-runtime)\/|#provider-runtime\/)/;
  const offenders = sourceFiles(join(desktopRoot, "daemon-contract"))
    .filter((file) => forbiddenImport.test(readFileSync(file, "utf8")))
    .map((file) => relative(desktopRoot, file).split(sep).join("/"));
  assert.deepEqual(offenders, []);
});

test("daemon and Electron share one protocol version, implementation version, and activity limit", () => {
  assert.equal(SUPERVISOR_DAEMON_PROTOCOL_VERSION, DAEMON_PROTOCOL_VERSION);
  assert.equal(SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION, DAEMON_IMPLEMENTATION_VERSION);
  assert.equal(SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT, DAEMON_STATE_ACTIVITY_SUMMARY_LIMIT);

  // Only daemon-contract/version.ts may hold the literal implementation version in TypeScript code.
  const versionLiteral = new RegExp(`["']${DAEMON_IMPLEMENTATION_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
  const offenders = sourceFiles(desktopRoot)
    .map((file) => ({ path: relative(desktopRoot, file).split(sep).join("/"), content: readFileSync(file, "utf8") }))
    .filter(({ path, content }) => path !== "daemon-contract/version.ts" && versionLiteral.test(content))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    `only daemon-contract/version.ts may define the literal ${DAEMON_IMPLEMENTATION_VERSION}`,
  );
});

test("control-request-router and Electron supervisor-daemon derive from the shared contract", () => {
  const router = readFileSync(join(desktopRoot, "daemon/control-request-router.ts"), "utf8");
  assert.match(router, /from "#daemon-contract\/index\.js"/);
  assert.doesNotMatch(router, /function requiredStringParam\b/);
  assert.doesNotMatch(router, /function positiveIntegerParam\b/);
  assert.doesNotMatch(router, /function desiredStateParam\b/);

  const constants = readFileSync(join(desktopRoot, "electron/main/supervisor-daemon/constants.ts"), "utf8");
  assert.match(constants, /from "#daemon-contract\/index\.js"/);
  assert.doesNotMatch(constants, /SUPERVISOR_DAEMON_PROTOCOL_VERSION\s*=\s*\d+/);
  assert.doesNotMatch(constants, /SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION\s*=\s*["']/);

  const clientTypes = readFileSync(join(desktopRoot, "electron/main/supervisor-daemon/types.ts"), "utf8");
  assert.match(clientTypes, /export type WireEntry = DaemonManifestEntryView;/);
  assert.match(clientTypes, /export type WireActivityEvent = DaemonActivityEvent;/);
  assert.match(clientTypes, /export type WireResponse = DaemonResponse;/);
});
