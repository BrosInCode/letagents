import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { win32 } from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  DAEMON_PIPE_ADDON_APP_PATH,
  PROCESS_TREE_HELPER_APP_PATH,
  WINDOWS_EXECUTABLE_NAME,
  assertWindowsExecutableBytes,
  buildDaemonPipeAddon,
  buildProcessTreeHelper,
  createIcoFile,
  createNsisPayloadInclude,
  findMakensis,
  readPngDimensions,
  resolveWindowsOpenCodeExecutable,
  stageDaemonPipeAddon,
  stageProcessTreeHelper,
  windowsFileVersion,
} from "./windows-packaging.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsDirectory, "../..");

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable RGBA PNG of one colour. */
function solidPng(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      rows.writeUInt32BE(0x3366ccff, row * (size * 4 + 1) + 1 + column * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("the Windows icon is a PNG-entry .ico that resedit reads back size for size", async () => {
  const images = [16, 32, 256].map((size) => ({ size, png: solidPng(size) }));
  const ico = createIcoFile(images);
  assert.equal(ico.readUInt16LE(2), 1, "type 1 is an icon");
  assert.equal(ico.readUInt16LE(4), 3);
  assert.equal(ico.readUInt8(6 + 32), 0, "256 is stored as 0");
  assert.deepEqual(readPngDimensions(ico.subarray(ico.readUInt32LE(6 + 32 + 12))), { width: 256, height: 256 });

  const ResEdit = await import("resedit");
  const parsed = ResEdit.Data.IconFile.from(ico);
  // The directory's one-byte width keeps 0 for 256, as Windows reads it.
  assert.deepEqual(parsed.icons.map((icon) => icon.width), [16, 32, 0]);
  assert.deepEqual(parsed.icons.map((icon) => icon.data.isRaw() && Buffer.from(icon.data.bin).equals(images.find(({ size }) => size === (icon.width || 256)).png)), [true, true, true]);
});

test("the Windows icon refuses entries that are not the size they claim", () => {
  assert.throws(() => createIcoFile([]), /at least one image/);
  assert.throws(() => createIcoFile([{ size: 32, png: solidPng(16) }]), /32x32 PNG/);
  assert.throws(() => createIcoFile([{ size: 512, png: solidPng(512) }]), /at most 256/);
  assert.throws(() => createIcoFile([{ size: 16, png: Buffer.from("not a png") }]), /must be PNG images/);
});

test("Windows version metadata uses the four-part form of the desktop version", () => {
  assert.equal(windowsFileVersion("0.1.130"), "0.1.130.0");
  assert.throws(() => windowsFileVersion("0.1.130-beta.1"), /numeric x\.y\.z/);
  assert.throws(() => windowsFileVersion("0.70000.0"), /at most 65535/);
});

test("the bundled OpenCode is the real opencode.exe behind npm's Windows shim", () => {
  const prefix = "C:\\Users\\runner\\opencode";
  const installed = win32.join(prefix, "node_modules", "opencode-ai", "bin", "opencode.exe");
  const files = new Set([win32.join(prefix, "opencode.cmd"), installed]);
  const exists = (path) => files.has(path);
  assert.equal(resolveWindowsOpenCodeExecutable({ env: { PATH: `C:\\Windows;${prefix}` }, exists }), installed);
  assert.equal(
    resolveWindowsOpenCodeExecutable({ env: { Path: "C:\\tools" }, exists: (path) => path === "C:\\tools\\opencode.exe" }),
    "C:\\tools\\opencode.exe",
  );
  assert.equal(resolveWindowsOpenCodeExecutable({ requested: installed, exists }), installed);
  assert.throws(() => resolveWindowsOpenCodeExecutable({ requested: win32.join(prefix, "opencode.cmd") }), /must name opencode\.exe/);
  assert.throws(() => resolveWindowsOpenCodeExecutable({ env: { PATH: "C:\\Windows" }, exists }), /not found on PATH/);
  // npm's placeholder (a shell script) is what is left when postinstall did not run.
  assert.throws(() => assertWindowsExecutableBytes(Buffer.from("echo \"Error: opencode-ai's postinstall"), "opencode.exe"), /not a Windows executable/);
  assert.doesNotThrow(() => assertWindowsExecutableBytes(Buffer.from([0x4d, 0x5a, 0x90, 0]), "opencode.exe"));
});

test("makensis comes from LETAGENTS_MAKENSIS, PATH, or the NSIS install folder", () => {
  const default32 = "C:\\Program Files (x86)\\NSIS\\makensis.exe";
  assert.equal(findMakensis({ env: { "ProgramFiles(x86)": "C:\\Program Files (x86)", PATH: "" }, exists: (path) => path === default32 }), default32);
  assert.equal(findMakensis({ env: { PATH: "D:\\nsis" }, exists: (path) => path === "D:\\nsis\\makensis.exe" }), "D:\\nsis\\makensis.exe");
  assert.equal(findMakensis({ env: { LETAGENTS_MAKENSIS: "E:\\makensis.exe" }, exists: () => true }), "E:\\makensis.exe");
  assert.throws(() => findMakensis({ env: { LETAGENTS_MAKENSIS: "E:\\missing.exe" }, exists: () => false }), /does not exist/);
  assert.throws(() => findMakensis({ env: { PATH: "" }, exists: () => false }), /NSIS \(makensis\.exe\) was not found/);
});

test("the installer removes exactly the packaged top-level entries", () => {
  const include = createNsisPayloadInclude([
    { name: "resources", directory: true },
    { name: WINDOWS_EXECUTABLE_NAME, directory: false },
    { name: "ffmpeg.dll", directory: false },
    { name: "locales", directory: true },
    { name: "shared", directory: true },
  ]);
  assert.equal(include, [
    "; Generated by electron/scripts/package-windows.mjs. Do not edit.",
    "!macro REMOVE_LETAGENTS_PAYLOAD",
    '  Delete "$INSTDIR\\ffmpeg.dll"',
    '  Delete "$INSTDIR\\LetAgents.exe"',
    '  RMDir /r "$INSTDIR\\locales"',
    '  RMDir /r "$INSTDIR\\resources"',
    '  RMDir /r "$INSTDIR\\shared"',
    "!macroend",
    "",
  ].join("\r\n"));
  assert.throws(() => createNsisPayloadInclude([{ name: "resources", directory: true }]), /must contain LetAgents\.exe/);
  for (const name of ['bad"name', "$PLUGINSDIR", "..", "Uninstall LetAgents.exe"]) {
    assert.throws(
      () => createNsisPayloadInclude([{ name: WINDOWS_EXECUTABLE_NAME, directory: false }, { name, directory: false }]),
      /Unexpected top-level entry/,
    );
  }
});

test("the NSIS script honours electron-updater's installer flags and stays per-user", async () => {
  const script = await readFile(join(desktopRoot, "electron", "installer", "windows", "installer.nsi"), "utf8");
  assert.match(script, /^RequestExecutionLevel user$/m);
  assert.match(script, /^InstallDir "\$LOCALAPPDATA\\Programs\\\$\{PRODUCT_NAME\}"$/m);
  assert.match(script, /\$\{GetOptions\} \$R0 "--updated" \$R1/);
  assert.match(script, /\$\{GetOptions\} \$R0 "--force-run" \$R1/);
  // Not solid, so unchanged files keep their compressed bytes for the blockmap.
  assert.match(script, /^SetCompressor lzma$/m);
  // The cache name and file electron-updater's differential download reads.
  assert.match(script, /!define UPDATER_CACHE "letagents-desktop-updater"/);
  assert.match(script, /"\$LOCALAPPDATA\\\$\{UPDATER_CACHE\}\\installer\.exe"/);
  assert.match(script, /WriteRegStr HKCU "\$\{URL_KEY\}\\shell\\open\\command" "" '"\$INSTDIR\\\$\{EXE_NAME\}" "%1"'/);
  // The previous payload is removed only from the folder the install is registered in.
  const guarded = /Call (?:un\.)?IsRegisteredInstall\s+(?:;[^\n]*\s+)*\$\{If\} \$InstalledHere == "1"\s+!insertmacro REMOVE_LETAGENTS_PAYLOAD/g;
  assert.equal(script.match(guarded)?.length, 2);
  assert.match(script, /ReadRegStr \$R0 HKCU "\$\{UNINSTALL_KEY\}" "InstallLocation"/);
  assert.match(script, /^InstallDirRegKey HKCU "\$\{UNINSTALL_KEY\}" "InstallLocation"$/m);
  assert.doesNotMatch(script, /RMDir \/r "\$INSTDIR"/);
  // electron-updater starts the installer as a child of LetAgents.exe, so no tree kill.
  assert.match(script, /taskkill\.exe" \/F \/IM "\$\{EXE_NAME\}"/);
  assert.doesNotMatch(script, /taskkill[^\n]*\/T/);
  assert.match(script, /Delete "\$LOCALAPPDATA\\\$\{UPDATER_CACHE\}\\current\.blockmap"/);
  // An unregistered copy's uninstaller leaves the registered install's registration alone.
  const uninstall = script.slice(script.indexOf('Section "Uninstall"'));
  const registeredOnly = uninstall.slice(uninstall.indexOf('${If} $InstalledHere == "1"'), uninstall.indexOf("${EndIf}"));
  for (const removal of ['DeleteRegKey HKCU "${UNINSTALL_KEY}"', 'DeleteRegKey HKCU "${URL_KEY}"', 'RMDir /r "$LOCALAPPDATA\\${UPDATER_CACHE}"', 'Delete "$SMPROGRAMS\\${PRODUCT_NAME}.lnk"']) {
    assert.ok(registeredOnly.includes(removal), removal);
  }
});

test("the process-tree helper ships at the path the app looks for it, built strictly unless one is given", () => {
  assert.equal(PROCESS_TREE_HELPER_APP_PATH, "runtime/letagents-process-tree.exe");
  const runs = [];
  const run = (file, args) => { runs.push([file, args]); return { status: 0 }; };
  const built = buildProcessTreeHelper({ arch: "x64", env: {}, run });
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], process.execPath);
  assert.match(runs[0][1][0], /native[\\/]win-process-tree[\\/]build\.mjs$/);
  assert.deepEqual(runs[0][1].slice(1), ["--arch", "x64", "--check", "--strict"]);
  assert.match(built, /native[\\/]win-process-tree[\\/]build[\\/]x64[\\/]letagents-process-tree\.exe$/);
  // A helper another job built on the sealed compiler is used as given (and still checked when staged).
  assert.equal(buildProcessTreeHelper({ arch: "x64", env: { LETAGENTS_PROCESS_TREE_HELPER_BUILD: " C:\\built\\helper.exe " }, run }), "C:\\built\\helper.exe");
  assert.equal(runs.length, 1);
  // A failed or not-sealed build is a build error.
  assert.throws(() => buildProcessTreeHelper({ arch: "x64", env: {}, run: () => ({ status: 1 }) }), /--strict failed \(exit 1\)/);
});

test("only the sealed helper bytes are staged; any other bytes fail the build", async () => {
  const folder = await mkdtemp(join(tmpdir(), "letagents-helper-stage-"));
  try {
    const helper = join(folder, "letagents-process-tree.exe");
    const bytes = Buffer.from("MZ a helper build");
    await writeFile(helper, bytes);
    const seal = { builds: { x64: { sha256: createHash("sha256").update(bytes).digest("hex") } } };
    const destination = join(folder, "app", "runtime", "letagents-process-tree.exe");
    assert.deepEqual(await stageProcessTreeHelper({ helper, destination, arch: "x64", seal }), { sha256: seal.builds.x64.sha256, bytes: bytes.length });
    assert.deepEqual(await readFile(destination), bytes);

    const elsewhere = join(folder, "refused", "letagents-process-tree.exe");
    await assert.rejects(
      stageProcessTreeHelper({ helper, destination: elsewhere, arch: "x64", seal: { builds: { x64: { sha256: "0".repeat(64) } } } }),
      /is not the sealed letagents-process-tree\.exe .*so the app would refuse it/,
    );
    await assert.rejects(stageProcessTreeHelper({ helper, destination: elsewhere, arch: "arm64", seal }), /No arm64 build/);
    await writeFile(helper, "not an executable");
    await assert.rejects(stageProcessTreeHelper({ helper, destination: elsewhere, arch: "x64", seal }), /is not a Windows executable/);
    await assert.rejects(readFile(elsewhere), { code: "ENOENT" });
    // Without a seal given, the committed one decides: these bytes are not its build.
    await writeFile(helper, bytes);
    await assert.rejects(stageProcessTreeHelper({ helper, destination: elsewhere, arch: "x64" }), /is not the sealed/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("the packaged app gets the helper and the daemon pipe addon, and their runtime sides and seals are required files", async () => {
  const packager = await readFile(join(scriptsDirectory, "package-artifact.mjs"), "utf8");
  assert.match(packager, /stageProcessTreeHelper\(\{\s*helper: buildProcessTreeHelper\(\{ arch: desktopArch \}\),\s*destination: join\(app, PROCESS_TREE_HELPER_APP_PATH\)/);
  assert.match(packager, /stageDaemonPipeAddon\(\{\s*addon: buildDaemonPipeAddon\(\{ arch: desktopArch \}\),\s*destination: join\(app, DAEMON_PIPE_ADDON_APP_PATH\)/);
  assert.match(packager, /windows \? \[PROCESS_TREE_HELPER_APP_PATH, DAEMON_PIPE_ADDON_APP_PATH\] : \[\]/);
  assert.match(packager, /"shared\/letagents-process-tree\.seal\.json"/);
  assert.match(packager, /"shared\/daemon-endpoint\.mjs", "shared\/daemon-pipe-native\.mjs", "shared\/letagents-daemon-pipe\.seal\.json"/);
});

test("the installer ships only the sealed daemon pipe addon, where the app looks for it", async () => {
  assert.equal(DAEMON_PIPE_ADDON_APP_PATH, "runtime/letagents-daemon-pipe.node");
  const folder = await mkdtemp(join(tmpdir(), "letagents-daemon-pipe-stage-"));
  try {
    const addon = join(folder, "built.node");
    const bytes = Buffer.from([0x4d, 0x5a, 0x90, 0, 1, 2, 3]);
    await writeFile(addon, bytes);
    const seal = { builds: { x64: { sha256: createHash("sha256").update(bytes).digest("hex") } } };
    const destination = join(folder, "app", ...DAEMON_PIPE_ADDON_APP_PATH.split("/"));
    assert.deepEqual(await stageDaemonPipeAddon({ addon, destination, arch: "x64", seal }), { sha256: seal.builds.x64.sha256, bytes: bytes.length });
    assert.deepEqual(await readFile(destination), bytes);
    await rm(destination);
    await assert.rejects(() => stageDaemonPipeAddon({ addon, destination, arch: "x64", seal: { builds: { x64: { sha256: "0".repeat(64) } } } }), /not the sealed/);
    await assert.rejects(() => stageDaemonPipeAddon({ addon, destination, arch: "x64", seal: { builds: {} } }), /No x64 build/);
    await writeFile(addon, "not a DLL");
    await assert.rejects(() => stageDaemonPipeAddon({ addon, destination, arch: "x64", seal }), /not a Windows executable/);
    await assert.rejects(() => readFile(destination), { code: "ENOENT" }, "nothing is written for refused bytes");
  } finally { await rm(folder, { recursive: true, force: true }); }
  // A prebuilt addon from the release job is used as given; otherwise build.mjs runs strict.
  assert.equal(buildDaemonPipeAddon({ arch: "x64", env: { LETAGENTS_DAEMON_PIPE_ADDON_BUILD: "D:\\a\\addon.node" } }), "D:\\a\\addon.node");
  const calls = [];
  const built = buildDaemonPipeAddon({ arch: "x64", env: {}, run: (command, args) => { calls.push(args.slice(1)); return { status: 0 }; } });
  assert.deepEqual(calls, [["--arch", "x64", "--check", "--strict"]]);
  assert.match(built, /win-daemon-pipe[\\/]build[\\/]x64[\\/]letagents-daemon-pipe\.node$/);
  assert.throws(() => buildDaemonPipeAddon({ arch: "x64", env: {}, run: () => ({ status: 1 }) }), /--strict failed/);
});
