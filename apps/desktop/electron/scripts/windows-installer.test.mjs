// The NSIS installer on a real Windows: it installs, updates in place, keeps
// the installed version when an update meets a file in use, and recovers
// from an update that stopped part way, and leaves files the user keeps in
// the install folder through an update and an uninstall. The installer is built from a tiny
// fake payload with TEST_INSTANCE, so it has its own product name, Installed
// apps key, link scheme and updater cache, and installs only into a temporary
// /D= folder: it never touches a real LetAgents install.
//
// Windows only, and it needs NSIS (makensis.exe). The ci.yml job
// windows-installer runs it on windows-2022, which has NSIS, and sets
// LETAGENTS_REQUIRE_INSTALLER_TEST=1 so a missing NSIS fails there. Elsewhere
// (windows-latest has no NSIS) it skips without NSIS.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  WINDOWS_BACKUP_DIR,
  WINDOWS_INSTALL_MANIFEST_NAME,
  WINDOWS_STAGE_DIR,
  WINDOWS_UNINSTALLER_NAME,
  createIcoFile,
  createInstallManifest,
  createNsisPayloadInclude,
  findMakensis,
  listPayloadEntries,
  listPayloadPaths,
} from "./windows-packaging.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const installerScript = resolve(scriptsDirectory, "..", "installer", "windows", "installer.nsi");
const required = process.env.LETAGENTS_REQUIRE_INSTALLER_TEST === "1";

function nsisAvailable() {
  try {
    findMakensis();
    return true;
  } catch {
    return false;
  }
}

const skip = process.platform !== "win32"
  ? "the NSIS installer runs only on Windows"
  : !required && !nsisAvailable()
    ? "NSIS (makensis.exe) is not installed; the windows-installer CI job runs this test"
    : false;

const V1 = {
  "LetAgents.exe": "v1 exe",
  "ffmpeg.dll": "v1 dll",
  "locales/en-US.pak": "v1 locale",
  "resources/app/main.js": "v1 main",
  "resources/app/v1-only.txt": "v1 only",
};
const V2 = {
  "LetAgents.exe": "v2 exe",
  "d3dcompiler_47.dll": "v2 only, top level",
  "ffmpeg.dll": "v2 dll",
  "locales/en-US.pak": "v2 locale",
  "resources/app/main.js": "v2 main",
  "resources/app/v2-only.txt": "v2 only",
};

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

function solidPng(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function writePayload(directory, payload) {
  for (const [path, text] of Object.entries(payload)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
}

async function buildInstaller({ root, id, version, payload }) {
  const source = join(root, `payload-${version}`);
  await writePayload(source, payload);
  const include = join(root, `payload-${version}.nsh`);
  await writeFile(include, createNsisPayloadInclude(await listPayloadEntries(source)));
  const manifest = join(root, `payload-${version}.manifest`);
  await writeFile(manifest, createInstallManifest(await listPayloadPaths(source)));
  const icon = join(root, "test.ico");
  await writeFile(icon, createIcoFile([{ size: 16, png: solidPng(16) }]));
  const output = join(root, `letagents-test-${version}.exe`);
  execFileSync(findMakensis(), [
    "/V2",
    "/INPUTCHARSET", "UTF8",
    `/DVERSION=${version}`,
    `/DFILE_VERSION=${version}.0`,
    `/DSOURCE_DIR=${source}`,
    `/DPAYLOAD_NSH=${include}`,
    `/DMANIFEST_FILE=${manifest}`,
    `/DICON_FILE=${icon}`,
    `/DOUTPUT_FILE=${output}`,
    "/DHELPER_NAME=letagents-test-helper.exe",
    "/DINSTALLED_KB=1",
    `/DTEST_INSTANCE=${id}`,
    installerScript,
  ], { stdio: "pipe" });
  return output;
}

/** Every file below `directory`, by its path with forward slashes, with its text. */
async function readTree(directory) {
  const tree = {};
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    tree[path.slice(directory.length + 1).replaceAll("\\", "/")] = await readFile(path, "utf8");
  }
  return tree;
}

/**
 * The folder holds exactly `payload`, the uninstaller and the install
 * manifest (plus `kept`, files the user put there), and no staging or backup
 * folder.
 */
async function assertInstalled(directory, payload, message, kept = {}) {
  const tree = await readTree(directory);
  for (const name of [WINDOWS_UNINSTALLER_NAME, WINDOWS_INSTALL_MANIFEST_NAME]) {
    assert.ok(name in tree, `${message}: ${name} is missing`);
    delete tree[name];
  }
  assert.deepEqual(tree, { ...payload, ...kept }, message);
  assertNoUpdateFolders(directory, message);
}

function assertNoUpdateFolders(directory, message) {
  for (const folder of [WINDOWS_STAGE_DIR, WINDOWS_BACKUP_DIR]) {
    assert.ok(!existsSync(join(directory, folder)), `${message}: ${folder} was left`);
  }
}

function run(file, args) {
  const result = spawnSync(file, args, { timeout: 180_000, windowsHide: true });
  if (result.error) throw result.error;
  return result.status;
}

function registryValue(key, name) {
  const result = spawnSync("reg.exe", ["query", key, "/v", name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return /REG_\w+\s+(.*)$/m.exec(result.stdout)?.[1]?.trim() ?? null;
}

function shellFolder(name) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetFolderPath('${name}')`], { encoding: "utf8" }).trim();
}

/** Opens `path` with no sharing at all until the returned release() runs. */
async function holdExclusively(path) {
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$f = [IO.File]::Open($env:LETAGENTS_HOLD, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()",
  ], { env: { ...process.env, LETAGENTS_HOLD: path }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  await new Promise((resolvePromise, reject) => {
    child.stdout.on("data", (data) => { if (String(data).includes("held")) resolvePromise(); });
    child.once("exit", (code) => reject(new Error(`The file holder exited with ${code} before it held ${path}.`)));
  });
  return async () => {
    if (child.exitCode !== null) return;
    child.stdin.end("\n");
    await once(child, "exit");
  };
}

test("the Windows installer installs, updates, keeps the old version on a failed update and recovers a stopped one", { skip, timeout: 900_000 }, async (t) => {
  const id = randomBytes(4).toString("hex");
  const product = `LetAgentsTest-${id}`;
  const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\chat.letagents.desktop.test-${id}`;
  const urlKey = `HKCU\\Software\\Classes\\letagents-test-${id}`;
  const updaterCache = join(process.env.LOCALAPPDATA, `letagents-test-${id}-updater`);
  const shortcuts = [join(shellFolder("Programs"), `${product}.lnk`), join(shellFolder("Desktop"), `${product}.lnk`)];
  const root = await mkdtemp(join(tmpdir(), "la-installer-"));
  // NSIS takes /D= unquoted, so the folder must not contain a space.
  assert.doesNotMatch(root, / /, "the temporary folder must not contain a space");
  const v1 = await buildInstaller({ root, id, version: "1.0.0", payload: V1 });
  const v2 = await buildInstaller({ root, id, version: "2.0.0", payload: V2 });
  let caseNumber = 0;

  /** A fresh, registered v1 install in its own folder; everything it made is removed afterwards. */
  async function withInstall(name, body) {
    caseNumber += 1;
    const directory = join(root, `install-${caseNumber}`);
    await t.test(name, async () => {
      const releases = [];
      try {
        assert.equal(run(v1, ["/S", `/D=${directory}`]), 0, "the v1 install exited with an error");
        assert.equal(registryValue(uninstallKey, "InstallLocation"), directory, "the v1 install is not registered");
        await assertInstalled(directory, V1, "after the v1 install");
        await body(directory, releases);
      } finally {
        for (const release of releases) await release();
        const uninstaller = join(directory, WINDOWS_UNINSTALLER_NAME);
        if (existsSync(uninstaller)) run(uninstaller, ["/S", `_?=${directory}`]);
        for (const key of [uninstallKey, urlKey]) spawnSync("reg.exe", ["delete", key, "/f"], { windowsHide: true });
        for (const shortcut of shortcuts) await rm(shortcut, { force: true });
        await rm(updaterCache, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  try {
    await withInstall("an update replaces the files and leaves no staging folder", async (directory) => {
      assert.equal(run(v2, ["--updated", "/S", `/D=${directory}`]), 0);
      await assertInstalled(directory, V2, "after the update");
      assert.equal(registryValue(uninstallKey, "DisplayVersion"), "2.0.0");
    });

    await withInstall("an update that meets a file in use exits 2 and keeps the installed version", async (directory, releases) => {
      releases.push(await holdExclusively(join(directory, "resources", "app", "main.js")));
      assert.equal(run(v2, ["--updated", "/S", `/D=${directory}`]), 2);
      await releases.pop()();
      await assertInstalled(directory, V1, "after the failed update");
      assert.equal(registryValue(uninstallKey, "DisplayVersion"), "1.0.0");
    });

    // An update stopped during the move-in (step 4): some new entries are in
    // the folder, the rest are still staged, the old ones are all aside.
    async function stopDuringMoveIn(directory) {
      const backup = join(directory, WINDOWS_BACKUP_DIR);
      const stage = join(directory, WINDOWS_STAGE_DIR);
      await mkdir(backup);
      for (const name of ["LetAgents.exe", "ffmpeg.dll", "locales", "resources", WINDOWS_INSTALL_MANIFEST_NAME]) await rename(join(directory, name), join(backup, name));
      const newEntries = [
        ...(await listPayloadEntries(join(root, "payload-2.0.0"))).map((entry) => entry.name).sort((left, right) => left.localeCompare(right, "en")),
        WINDOWS_INSTALL_MANIFEST_NAME,
      ];
      await writeFile(join(backup, ".moved-in"), newEntries.map((name) => `${name}\n`).join(""));
      await writePayload(stage, V2);
      await writeFile(join(stage, WINDOWS_INSTALL_MANIFEST_NAME), createInstallManifest(await listPayloadPaths(join(root, "payload-2.0.0"))));
      for (const name of ["LetAgents.exe", "d3dcompiler_47.dll"]) await rename(join(stage, name), join(directory, name));
    }

    await withInstall("after an update stopped before its commit, the old version wins in full", async (directory) => {
      await stopDuringMoveIn(directory);
      // The v1 installer does not know d3dcompiler_47.dll: only the recovery removes it.
      assert.equal(run(v1, ["--updated", "/S", `/D=${directory}`]), 0);
      await assertInstalled(directory, V1, "after the recovery");
    });

    await withInstall("after an update stopped after its commit, the new version stays and the old files go", async (directory) => {
      const backup = join(directory, WINDOWS_BACKUP_DIR);
      await mkdir(backup);
      for (const name of ["LetAgents.exe", "ffmpeg.dll", "locales", WINDOWS_INSTALL_MANIFEST_NAME]) await rename(join(directory, name), join(backup, name));
      await rm(join(directory, "resources"), { recursive: true });
      await writePayload(directory, V2);
      await writeFile(join(directory, WINDOWS_INSTALL_MANIFEST_NAME), createInstallManifest(await listPayloadPaths(join(root, "payload-2.0.0"))));
      assert.equal(run(v2, ["--updated", "/S", `/D=${directory}`]), 0);
      await assertInstalled(directory, V2, "after the recovery");
    });

    // Files the user put in the install folder, also in folders the payload has.
    const KEPT = {
      "user-notes.txt": "the user's",
      "locales/user-notes.txt": "the user's",
      "resources/app/user-notes.txt": "the user's",
    };

    await withInstall("an update and the uninstaller delete only the files the install wrote", async (directory) => {
      await writePayload(directory, KEPT);
      assert.equal(run(v2, ["--updated", "/S", `/D=${directory}`]), 0);
      await assertInstalled(directory, V2, "after the update", KEPT);
      assert.equal(run(join(directory, WINDOWS_UNINSTALLER_NAME), ["/S", `_?=${directory}`]), 0);
      const left = await readTree(directory);
      delete left[WINDOWS_UNINSTALLER_NAME];
      assert.deepEqual(left, KEPT, "the uninstaller deleted a file the install did not write, or left one it did");
      assertNoUpdateFolders(directory, "after the uninstall");
    });

    await withInstall("an update over an install without a manifest (0.1.143) in a custom folder deletes nothing else", async (directory) => {
      await rm(join(directory, WINDOWS_INSTALL_MANIFEST_NAME));
      await writePayload(directory, KEPT);
      assert.equal(run(v2, ["--updated", "/S", `/D=${directory}`]), 0);
      // Not the default folder, so the old files the new version dropped stay
      // too: without a manifest they cannot be told from the user's.
      await assertInstalled(directory, V2, "after the update", { ...KEPT, "resources/app/v1-only.txt": V1["resources/app/v1-only.txt"] });
    });

    await withInstall("the uninstaller recovers a stopped update first and then removes the whole install", async (directory) => {
      await stopDuringMoveIn(directory);
      assert.equal(run(join(directory, WINDOWS_UNINSTALLER_NAME), ["/S", `_?=${directory}`]), 0);
      const left = Object.keys(await readTree(directory)).filter((path) => path !== WINDOWS_UNINSTALLER_NAME);
      assert.deepEqual(left, [], "the uninstaller left files of the stopped update");
      assertNoUpdateFolders(directory, "after the uninstall");
      assert.equal(registryValue(uninstallKey, "InstallLocation"), null, "the Installed apps entry is still there");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
