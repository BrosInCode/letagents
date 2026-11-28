import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertBundleMinimumMacOS,
  bufferReader,
  bundleFilesAboveMacOS,
  compareMacOSVersions,
  fileMinimumMacOS,
  machOMinimumMacOS,
} from "./macho-minimum-macos.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsDirectory, "../..");

const packed = (version) => {
  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
  return ((major << 16) | (minor << 8) | patch) >>> 0;
};

const MH_OBJECT = 0x1;
const MH_EXECUTE = 0x2;
const MH_DYLIB = 0x6;
const MH_BUNDLE = 0x8;

/** A thin 64-bit little-endian Mach-O header with the given load commands. */
function thinMachO(commands, fileType = MH_EXECUTE) {
  const body = Buffer.concat(commands);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4); // arm64
  header.writeUInt32LE(fileType, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body, Buffer.alloc(64)]);
}

function buildVersion(minos, platform = 1) {
  const command = Buffer.alloc(24);
  command.writeUInt32LE(0x32, 0);
  command.writeUInt32LE(24, 4);
  command.writeUInt32LE(platform, 8);
  command.writeUInt32LE(packed(minos), 12);
  command.writeUInt32LE(packed("15.2"), 16);
  return command;
}

function versionMinMacOS(version) {
  const command = Buffer.alloc(16);
  command.writeUInt32LE(0x24, 0);
  command.writeUInt32LE(16, 4);
  command.writeUInt32LE(packed(version), 8);
  command.writeUInt32LE(packed(version), 12);
  return command;
}

function otherCommand() {
  const command = Buffer.alloc(16);
  command.writeUInt32LE(0x19, 0); // LC_SEGMENT_64, cut short: only its size matters here
  command.writeUInt32LE(16, 4);
  return command;
}

/** A universal binary of the given thin slices. */
function fatMachO(slices) {
  const table = Buffer.alloc(8 + slices.length * 20);
  table.writeUInt32BE(0xcafebabe, 0);
  table.writeUInt32BE(slices.length, 4);
  let offset = 4096;
  const parts = [];
  slices.forEach((slice, index) => {
    table.writeUInt32BE(offset, 8 + index * 20 + 8);
    table.writeUInt32BE(slice.length, 8 + index * 20 + 12);
    parts.push({ offset, slice });
    offset += 4096 * Math.ceil(slice.length / 4096);
  });
  const file = Buffer.alloc(offset);
  table.copy(file, 0);
  for (const part of parts) part.slice.copy(file, part.offset);
  return file;
}

test("macOS versions compare by number, and 13.0 equals 13", () => {
  assert.ok(compareMacOSVersions("13.0", "12.0") > 0);
  assert.ok(compareMacOSVersions("12.7.4", "13.0") < 0);
  assert.ok(compareMacOSVersions("10.15", "10.9") > 0);
  assert.equal(compareMacOSVersions("13.0", "13"), 0);
  assert.throws(() => compareMacOSVersions("thirteen", "13"), /not a macOS version/);
});

test("the reader takes the macOS minos from LC_BUILD_VERSION and LC_VERSION_MIN_MACOSX", async () => {
  assert.equal(await machOMinimumMacOS(bufferReader(thinMachO([otherCommand(), buildVersion("13.0")]))), "13.0");
  assert.equal(await machOMinimumMacOS(bufferReader(thinMachO([versionMinMacOS("10.13")]))), "10.13");
  assert.equal(await machOMinimumMacOS(bufferReader(thinMachO([buildVersion("12.3.1")]))), "12.3.1");
  // An object file need not name a macOS minimum, and an iOS build version is not one.
  assert.equal(await machOMinimumMacOS(bufferReader(thinMachO([buildVersion("17.0", 2)], MH_OBJECT))), null);
  assert.equal(await machOMinimumMacOS(bufferReader(thinMachO([otherCommand()], MH_OBJECT))), null);
});

test("an executable, dynamic library or bundle that names no macOS minimum fails", async () => {
  for (const [fileType, kind] of [[MH_EXECUTE, "executable"], [MH_DYLIB, "dynamic library"], [MH_BUNDLE, "bundle"]]) {
    await assert.rejects(
      machOMinimumMacOS(bufferReader(thinMachO([otherCommand()], fileType))),
      new RegExp(`The Mach-O ${kind} names no macOS minimum`),
    );
    await assert.rejects(
      machOMinimumMacOS(bufferReader(thinMachO([buildVersion("17.0", 2)], fileType))),
      /names no macOS minimum/,
    );
  }
});

test("a universal binary needs the newest minos of its slices", async () => {
  const universal = fatMachO([thinMachO([buildVersion("11.0")]), thinMachO([buildVersion("13.0")])]);
  assert.equal(await machOMinimumMacOS(bufferReader(universal)), "13.0");
});

test("a cut-off Mach-O file fails instead of passing as no minimum", async () => {
  // Load commands shorter than the header's sizeofcmds.
  const thin = thinMachO([otherCommand(), buildVersion("13.0")]);
  await assert.rejects(machOMinimumMacOS(bufferReader(thin.subarray(0, 32 + 20))), /load commands are truncated: 20 of 40 bytes/);
  // A universal slice offset past the end of the file.
  const universal = fatMachO([thinMachO([buildVersion("11.0")]), thinMachO([buildVersion("13.0")])]);
  await assert.rejects(machOMinimumMacOS(bufferReader(universal.subarray(0, 4096 + 200))), /No Mach-O image at offset 8192/);
  // A universal slice table shorter than its slice count.
  await assert.rejects(machOMinimumMacOS(bufferReader(universal.subarray(0, 8 + 30))), /slice table is truncated: 30 of 40 bytes/);
});

test("the file reader names the file that fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-macho-cut-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "cut");
  await writeFile(path, thinMachO([buildVersion("13.0")]).subarray(0, 40));
  await assert.rejects(fileMinimumMacOS(path), (error) => error.message.startsWith(`${path}: The Mach-O load commands are truncated`));
});

test("files that are not Mach-O have no minimum", async () => {
  // A Java class file shares the universal magic; its class version is no slice count.
  const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34, 0, 0, 0, 0]);
  assert.equal(await machOMinimumMacOS(bufferReader(javaClass)), null);
  assert.equal(await machOMinimumMacOS(bufferReader(Buffer.from("#!/bin/sh\nexit 0\n"))), null);
  assert.equal(await machOMinimumMacOS(bufferReader(Buffer.alloc(3))), null);
});

test("the file reader agrees with vtool on this Mac's node", { skip: process.platform !== "darwin" }, async () => {
  const shown = execFileSync("vtool", ["-show-build", process.execPath], { encoding: "utf8" });
  const minos = /^\s*minos (\S+)$/m.exec(shown)?.[1];
  assert.ok(minos, "vtool shows node's minos");
  assert.equal(await fileMinimumMacOS(process.execPath), minos);
});

async function fixtureBundle(t) {
  const bundle = await mkdtemp(join(tmpdir(), "letagents-macos-minimum-"));
  t.after(() => rm(bundle, { recursive: true, force: true }));
  const write = async (path, bytes) => {
    await mkdir(dirname(join(bundle, path)), { recursive: true });
    await writeFile(join(bundle, path), bytes);
  };
  await write("Contents/MacOS/LetAgents", thinMachO([buildVersion("12.0")]));
  await write("Contents/Frameworks/Lib.framework/Versions/A/Lib", thinMachO([buildVersion("11.0")]));
  await symlink("A", join(bundle, "Contents/Frameworks/Lib.framework/Versions/Current"));
  await write("Contents/Resources/app/runtime/opencode", thinMachO([buildVersion("13.0")]));
  await write("Contents/Resources/app/package.json", "{}\n");
  return { bundle, write };
}

const openCodeException = (minimum = "13.0") => ({
  path: "Contents/Resources/app/runtime/opencode",
  feature: "Open Model",
  minimum,
});

test("the bundle check passes when only listed files need a newer macOS, at their recorded minimum", async (t) => {
  const { bundle } = await fixtureBundle(t);
  assert.deepEqual(await bundleFilesAboveMacOS(bundle, "12.0"), [
    { path: "Contents/Resources/app/runtime/opencode", minimum: "13.0" },
  ]);
  await assertBundleMinimumMacOS({ bundle, declared: "12.0", exceptions: [openCodeException()] });
});

test("the bundle check fails for an unlisted file that needs a newer macOS than the app declares", async (t) => {
  const { bundle, write } = await fixtureBundle(t);
  await assert.rejects(
    assertBundleMinimumMacOS({ bundle, declared: "12.0", exceptions: [] }),
    /Contents\/Resources\/app\/runtime\/opencode needs macOS 13\.0, but the app declares LSMinimumSystemVersion 12\.0/,
  );
  await write("Contents/Resources/app/node_modules/addon/build/addon.node", thinMachO([buildVersion("14.0")]));
  await assert.rejects(
    assertBundleMinimumMacOS({ bundle, declared: "12.0", exceptions: [openCodeException()] }),
    /addon\.node needs macOS 14\.0/,
  );
});

test("the bundle check fails when OpenCode needs another macOS than recorded, or is missing", async (t) => {
  const { bundle, write } = await fixtureBundle(t);
  await write("Contents/Resources/app/runtime/opencode", thinMachO([buildVersion("14.0")]));
  await assert.rejects(
    assertBundleMinimumMacOS({ bundle, declared: "12.0", exceptions: [openCodeException()] }),
    /opencode \(Open Model\) needs macOS 14\.0, but its recorded minimum is 13\.0/,
  );
  await write("Contents/Resources/app/runtime/opencode", thinMachO([buildVersion("12.0")]));
  await assert.rejects(
    assertBundleMinimumMacOS({ bundle, declared: "12.0", exceptions: [openCodeException()] }),
    /needs macOS 12\.0, but its recorded minimum is 13\.0/,
  );
  await rm(join(bundle, "Contents/Resources/app/runtime/opencode"));
  await assert.rejects(
    assertBundleMinimumMacOS({ bundle, declared: "12.0", exceptions: [openCodeException()] }),
    /is on the macOS exceptions list, but the bundle has no Mach-O file there/,
  );
});

test("macOS packaging checks every Mach-O file against the app's declared minimum, with OpenCode's recorded one", async () => {
  const packager = await readFile(join(scriptsDirectory, "package-artifact.mjs"), "utf8");
  const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
  assert.match(desktopPackage.letagentsRuntime.openCodeMinimumMacOS, /^\d+\.\d+$/);
  assert.match(packager, /"-extract", "LSMinimumSystemVersion", "raw", join\(contents, "Info\.plist"\)/);
  assert.match(packager, /await assertBundleMinimumMacOS\(\{/);
  assert.match(packager, /path: bundlePath\(join\(app, "runtime", bundledOpenCode\)\), feature: "Open Model", minimum: openCodeMinimumMacOS/);
  assert.doesNotMatch(packager, /LSMinimumSystemVersion", "-string"|"LSMinimumSystemVersion",\s*"1[3-9]/,
    "the app keeps Electron's LSMinimumSystemVersion");
});
