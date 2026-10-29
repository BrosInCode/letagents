import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import test from "node:test";

import { checkDaemonPipeSeal, sourceDigest } from "./seal.mjs";
import {
  DAEMON_PIPE_ADDON_ENV,
  daemonPipeAddonCandidates,
  findDaemonPipeAddon,
  sealedDaemonPipeAddonSha256,
} from "../../../../shared/daemon-pipe-native.mjs";

const seal = JSON.parse(readFileSync(new URL("../../../../shared/letagents-daemon-pipe.seal.json", import.meta.url), "utf8"));

test("the seal names the committed source", () => {
  assert.equal(sourceDigest(readFileSync(new URL("./letagents-daemon-pipe.c", import.meta.url))), seal.sourceSha256);
});

test("the source digest does not depend on the checkout's line endings", () => {
  assert.equal(sourceDigest(Buffer.from("a\r\nb\r\n")), sourceDigest(Buffer.from("a\nb\n")));
});

test("a build is checked against the seal of its compiler", () => {
  const sealed = { sourceSha256: "s", builds: { x64: { sha256: "d", vcToolsVersion: "14.44.1", windowsSdkVersion: "10.0.1" } } };
  const build = { arch: "x64", sourceSha256: "s", sha256: "d", vcToolsVersion: "14.44.1", windowsSdkVersion: "10.0.1" };
  assert.equal(checkDaemonPipeSeal(sealed, build).level, "ok");
  // Same compiler, other bytes: not reproducible, or the seal is wrong.
  assert.equal(checkDaemonPipeSeal(sealed, { ...build, sha256: "e" }).level, "error");
  // The source changed without the seal.
  assert.equal(checkDaemonPipeSeal(sealed, { ...build, sourceSha256: "t" }).level, "error");
  // A newer compiler on the runner: reported with the values to reseal.
  const newer = checkDaemonPipeSeal(sealed, { ...build, sha256: "e", vcToolsVersion: "14.45.0" });
  assert.equal(newer.level, "warning");
  assert.match(newer.message, /"sha256":"e"/);
  assert.equal(checkDaemonPipeSeal(sealed, { ...build, arch: "arm64" }).level, "warning");
});

test("the app looks for the addon where it ships it, or only where it is told", () => {
  const resourcesPath = "C:\\Program Files\\LetAgents\\resources";
  const [shipped, local] = daemonPipeAddonCandidates({ env: {}, resourcesPath, arch: "x64" });
  assert.equal(shipped, win32.join(resourcesPath, "app", "runtime", "letagents-daemon-pipe.node"));
  assert.match(local, /win-daemon-pipe[\\/]build[\\/]x64[\\/]letagents-daemon-pipe\.node$/);
  assert.deepEqual(daemonPipeAddonCandidates({ env: {}, resourcesPath, includeLocalBuild: false }), [shipped]);
  const configured = "D:\\build\\letagents-daemon-pipe.node";
  assert.deepEqual(daemonPipeAddonCandidates({ env: { [DAEMON_PIPE_ADDON_ENV]: configured }, resourcesPath }), [configured],
    "a configured addon is the only candidate");
  assert.deepEqual(daemonPipeAddonCandidates({ env: { [DAEMON_PIPE_ADDON_ENV]: "relative.node" }, resourcesPath }), []);
  assert.deepEqual(daemonPipeAddonCandidates({ env: { [DAEMON_PIPE_ADDON_ENV]: "\\\\server\\share\\letagents-daemon-pipe.node" }, resourcesPath }), [],
    "never a network path");
  // A process that is not the app's (npx letagents under Node) finds the per-user install.
  const [installed] = daemonPipeAddonCandidates({ env: { LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local" }, resourcesPath: "", arch: "x64", installLocation: null });
  assert.equal(installed, "C:\\Users\\Owner\\AppData\\Local\\Programs\\LetAgents\\resources\\app\\runtime\\letagents-daemon-pipe.node");
  // ... or the folder the installer recorded, when it was installed elsewhere.
  const [chosen] = daemonPipeAddonCandidates({ env: { LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local" }, resourcesPath: "", installLocation: "D:\\Apps\\LetAgents" });
  assert.equal(chosen, "D:\\Apps\\LetAgents\\resources\\app\\runtime\\letagents-daemon-pipe.node");
});

test("only the sealed bytes are accepted; other bytes are an error, not a reason to look further", () => {
  const bytes = Buffer.from("sealed addon bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fakeSeal = { builds: { x64: { sha256: digest } } };
  const files = new Map([["C:\\app\\resources\\app\\runtime\\letagents-daemon-pipe.node", bytes]]);
  const options = {
    env: {}, resourcesPath: "C:\\app\\resources", arch: "x64", seal: fakeSeal, includeLocalBuild: false,
    exists: (path) => files.has(path), readFile: (path) => files.get(path),
  };
  assert.deepEqual(findDaemonPipeAddon(options), { path: "C:\\app\\resources\\app\\runtime\\letagents-daemon-pipe.node", sha256: digest });
  files.set("C:\\app\\resources\\app\\runtime\\letagents-daemon-pipe.node", Buffer.from("other bytes"));
  assert.throws(() => findDaemonPipeAddon(options), (error) => error.code === "ERR_LETAGENTS_DAEMON_PIPE_ADDON" && /not the sealed/.test(error.message));
  assert.throws(() => findDaemonPipeAddon({ ...options, seal: { builds: {} } }), /No x64 build/);
  files.clear();
  assert.throws(() => findDaemonPipeAddon(options), /was not found/);
  assert.equal(sealedDaemonPipeAddonSha256("x64", { builds: { x64: { sha256: "not-hex" } } }), null);
});
