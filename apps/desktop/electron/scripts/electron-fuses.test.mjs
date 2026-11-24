import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ELECTRON_FUSE_NAMES,
  ELECTRON_FUSE_SENTINEL,
  LETAGENTS_ELECTRON_FUSES,
  applyPackagedElectronFuses,
  assertPackagedElectronFuses,
  distFuseBinaryPath,
  electronFuseMismatches,
  packagedFuseBinaryPath,
  readElectronFuseWires,
  setElectronFuseWires,
} from "./electron-fuses.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsDirectory, "../..");

// Electron 42's default wire: every fuse at its fuses.json5 default.
const ELECTRON_DEFAULTS = "101100011";

function binary(...wires) {
  return Buffer.concat(wires.flatMap((wire) => [
    Buffer.from("some machine code "),
    Buffer.from(ELECTRON_FUSE_SENTINEL, "ascii"),
    Buffer.from([1, wire.length]),
    Buffer.from(wire, "ascii"),
  ]).concat(Buffer.from(" more machine code")));
}

function wireText(bytes) {
  const start = bytes.indexOf(ELECTRON_FUSE_SENTINEL) + ELECTRON_FUSE_SENTINEL.length + 2;
  return bytes.subarray(start, start + ELECTRON_FUSE_NAMES.length).toString("ascii");
}

test("packaged builds keep RunAsNode and turn the Node inspector off", () => {
  assert.deepEqual(Object.keys(LETAGENTS_ELECTRON_FUSES).sort(), [...ELECTRON_FUSE_NAMES].sort());
  // The daemon and the MCP servers run on the app binary with ELECTRON_RUN_AS_NODE=1.
  assert.equal(LETAGENTS_ELECTRON_FUSES.RunAsNode, true);
  // SIGUSR1 and --inspect opened a debugger in the signed app's main process.
  assert.equal(LETAGENTS_ELECTRON_FUSES.EnableNodeCliInspectArguments, false);
  // Off would remove NODE_EXTRA_CA_CERTS from the environment the agents inherit.
  assert.equal(LETAGENTS_ELECTRON_FUSES.EnableNodeOptionsEnvironmentVariable, true);
  // The renderer loads from file:// and the app is not an asar archive.
  assert.equal(LETAGENTS_ELECTRON_FUSES.GrantFileProtocolExtraPrivileges, true);
  assert.equal(LETAGENTS_ELECTRON_FUSES.OnlyLoadAppFromAsar, false);
  assert.equal(LETAGENTS_ELECTRON_FUSES.EnableEmbeddedAsarIntegrityValidation, false);
});

test("the policy flips the default wire and only the inspector fuse changes", () => {
  const bytes = binary(ELECTRON_DEFAULTS);
  const [before] = readElectronFuseWires(bytes);
  assert.equal(before.fuses.EnableNodeCliInspectArguments, true);
  assert.equal(setElectronFuseWires(bytes), 1);
  assert.equal(wireText(bytes), "101000011");
  assert.deepEqual(electronFuseMismatches(bytes), []);
  assert.deepEqual(electronFuseMismatches(binary(ELECTRON_DEFAULTS)), ["EnableNodeCliInspectArguments: found true, expected false"]);
});

test("every wire of a universal binary is flipped", () => {
  const bytes = binary(ELECTRON_DEFAULTS, ELECTRON_DEFAULTS);
  assert.equal(setElectronFuseWires(bytes), 2);
  assert.deepEqual(readElectronFuseWires(bytes).map((wire) => wire.fuses), [LETAGENTS_ELECTRON_FUSES, LETAGENTS_ELECTRON_FUSES]);
});

test("packaging stops on a fuse it has not decided, a new wire version, a removed fuse or a missing wire", () => {
  assert.throws(() => setElectronFuseWires(binary(`${ELECTRON_DEFAULTS}1`)), /10 fuses; packaging knows 9\. Decide each new fuse/);
  const futureVersion = binary(ELECTRON_DEFAULTS);
  futureVersion[futureVersion.indexOf(ELECTRON_FUSE_SENTINEL) + ELECTRON_FUSE_SENTINEL.length] = 2;
  assert.throws(() => setElectronFuseWires(futureVersion), /fuse wire version 2/);
  assert.throws(() => setElectronFuseWires(binary("1011000r1")), /removed fuse GrantFileProtocolExtraPrivileges/);
  assert.throws(() => setElectronFuseWires(binary("10110001x")), /unknown value for fuse WasmTrapHandlers/);
  assert.throws(() => setElectronFuseWires(Buffer.from("no wire here")), /No Electron fuse wire/);
  const { WasmTrapHandlers: _undecided, ...incomplete } = LETAGENTS_ELECTRON_FUSES;
  assert.throws(() => setElectronFuseWires(binary(ELECTRON_DEFAULTS), incomplete), /must set exactly these fuses/);
});

test("a macOS bundle gets its fuses flipped and its framework signed ad hoc before release signing", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-fuses-"));
  try {
    const bundle = join(root, "LetAgents.app");
    const binaryPath = packagedFuseBinaryPath({ bundle, platform: "darwin" });
    await mkdir(dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, binary(ELECTRON_DEFAULTS));
    const calls = [];
    const result = await applyPackagedElectronFuses({
      bundle,
      platform: "darwin",
      run: async (command, args) => { calls.push([command, ...args]); return { stdout: "", stderr: "" }; },
    });
    assert.equal(result.wires, 1);
    assert.deepEqual(result.fuses, LETAGENTS_ELECTRON_FUSES);
    assert.equal(wireText(await readFile(binaryPath)), "101000011");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 4), ["codesign", "--force", "--sign", "-"]);
    assert.match(calls[0][4], /Electron Framework\.framework$/);
    await writeFile(binaryPath, binary(ELECTRON_DEFAULTS));
    await assert.rejects(assertPackagedElectronFuses({ bundle, platform: "darwin" }), /EnableNodeCliInspectArguments: found true, expected false/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Windows folder gets the fuses in its branded executable and needs no signing step", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-fuses-"));
  try {
    await writeFile(join(root, "LetAgents.exe"), binary(ELECTRON_DEFAULTS));
    const result = await applyPackagedElectronFuses({
      bundle: root,
      platform: "win32",
      executableName: "LetAgents.exe",
      run: async () => assert.fail("Windows builds are unsigned"),
    });
    assert.equal(result.binary, join(root, "LetAgents.exe"));
    await assertPackagedElectronFuses({ bundle: root, platform: "win32", executableName: "LetAgents.exe" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the installed Electron has exactly the fuses this policy decides, in the known order", { skip: !existsSync(join(desktopRoot, "node_modules", "electron", "dist")) && "electron is not installed" }, async () => {
  const path = distFuseBinaryPath({ dist: join(desktopRoot, "node_modules", "electron", "dist"), platform: process.platform });
  const wires = readElectronFuseWires(await readFile(path), path);
  assert.ok(wires.length >= 1);
  const text = { true: "1", false: "0", removed: "r" };
  for (const wire of wires) {
    assert.deepEqual(Object.keys(wire.fuses), [...ELECTRON_FUSE_NAMES]);
    // A changed default or a reordered wire in a new Electron fails here:
    // check build/fuses/fuses.json5 of that Electron, then LETAGENTS_ELECTRON_FUSES.
    assert.equal(ELECTRON_FUSE_NAMES.map((name) => text[String(wire.fuses[name])]).join(""), ELECTRON_DEFAULTS);
  }
});

test("the fuses are flipped before signing and checked again in the files that ship", async () => {
  const artifact = await readFile(join(scriptsDirectory, "package-artifact.mjs"), "utf8");
  // Every position is found first: indexOf returns -1 for missing text, and
  // -1 is "before" anything.
  const position = (source, text) => {
    const index = source.indexOf(text);
    assert.notEqual(index, -1, `missing: ${text}`);
    return index;
  };
  const flip = position(artifact, "await applyPackagedElectronFuses(");
  assert.ok(flip > position(artifact, "else await assembleMacBundle();"), "the flip runs on the assembled bundle");
  assert.ok(flip < position(artifact, "await writeFile(join(app, \"package.json\")"), "the flip runs before the app files are added");
  assert.match(artifact, /electronFuses: electronFuses\.fuses/);
  const mac = await readFile(join(scriptsDirectory, "package-macos.mjs"), "utf8");
  const check = position(mac, "await assertPackagedElectronFuses(");
  assert.ok(check > position(mac, "await sign("), "the check reads the signed app");
  assert.ok(check < position(mac, "notarizeWithStapleRecovery({ appPath: packagedApp"), "the check runs before notarization");
  assert.ok(check < position(mac, "\"ditto\""), "the check runs before the update zip");
  const windows = await readFile(join(scriptsDirectory, "package-windows.mjs"), "utf8");
  const windowsCheck = position(windows, "await assertPackagedElectronFuses(");
  assert.ok(windowsCheck > position(windows, "const artifactManifest = JSON.parse("), "the check reads the packaged folder the manifest names");
  assert.ok(windowsCheck < position(windows, "execFileAsync(makensis, ["), "the check runs before the installer");
});
