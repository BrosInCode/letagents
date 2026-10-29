import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { desktopAssetNames } from "./release-metadata.mjs";
import { sealedDaemonPipeAddonSha256 } from "../../../../shared/daemon-pipe-native.mjs";
import { sealedProcessTreeHelperSha256 } from "../../../../shared/process-tree.mjs";
import {
  DAEMON_PIPE_ADDON_APP_PATH,
  PROCESS_TREE_HELPER_APP_PATH,
  WINDOWS_APP_USER_MODEL_ID,
  WINDOWS_EXECUTABLE_NAME,
  WINDOWS_UNINSTALLER_NAME,
} from "./windows-packaging.mjs";

// Installs the built Windows installer silently for the current user, runs
// the installed app's smoke check (LETAGENTS_DESKTOP_SMOKE_CHECK=1 loads the
// real window against seeded local state and exits 0 when it renders), then
// checks that the installed app finds and uses the sealed process-tree
// helper, and loads its sealed daemon pipe addon to reach a daemon through
// it, updates the running app the way electron-updater does, and uninstalls it
// and checks that the install folder and registration are gone.
// For CI runners: it installs into the runner user's own profile.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installer = join(root, "release", "artifacts", desktopAssetNames({ version, arch: process.arch, platform: "win32" }).installer);
const installDirectory = join(process.env.LOCALAPPDATA ?? "", "Programs", "LetAgents");
const executable = join(installDirectory, WINDOWS_EXECUTABLE_NAME);
const uninstallKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\chat.letagents.desktop";
const urlKey = "HKCU\\Software\\Classes\\letagents\\shell\\open\\command";
const desktopShortcut = join(homedir(), "Desktop", "LetAgents.lnk");
const startMenuShortcut = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "LetAgents.lnk");

if (process.platform !== "win32") throw new Error("The Windows install smoke check must run on Windows.");
if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is not set.");
if (!existsSync(installer)) throw new Error(`The installer does not exist at ${installer}. Run npm run package:win first.`);
if (existsSync(installDirectory)) throw new Error(`${installDirectory} already exists; the smoke check needs a clean profile.`);

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.stdout?.trim()) console.log(result.stdout.trim());
  if (result.stderr?.trim()) console.error(result.stderr.trim());
  return result;
}

function registryValue(key, name) {
  const result = run("reg", ["query", key, ...(name ? ["/v", name] : ["/ve"])]);
  return result.status === 0 ? result.stdout : null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * What the Windows shell reads from a shortcut as System.AppUserModel.ID,
 * and the AppID Get-StartApps lists for LetAgents (the ID when the Start
 * menu shortcut has one, the executable path otherwise).
 */
function shellAppIds(shortcuts) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject Shell.Application",
    "$ids = foreach ($path in ($env:LETAGENTS_SHORTCUTS -split ';')) {",
    "  $item = $shell.Namespace([IO.Path]::GetDirectoryName($path)).ParseName([IO.Path]::GetFileName($path))",
    "  [string]$item.ExtendedProperty('System.AppUserModel.ID')",
    "}",
    "$start = @(Get-StartApps | Where-Object { $_.Name -eq 'LetAgents' } | ForEach-Object { $_.AppID })",
    "[pscustomobject]@{ shortcuts = @($ids); startApps = $start } | ConvertTo-Json -Compress",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, LETAGENTS_SHORTCUTS: shortcuts.join(";") },
  });
  if (result.status !== 0) throw new Error(`Reading the shortcut AppUserModelIDs failed: ${result.stderr}`);
  console.log(`shell AppUserModelIDs: ${result.stdout.trim()}`);
  const parsed = JSON.parse(result.stdout);
  return { shortcuts: [parsed.shortcuts].flat(), startApps: [parsed.startApps ?? []].flat() };
}

/** Process ids of this user's running LetAgents.exe processes. */
function runningAppIds() {
  const result = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${WINDOWS_EXECUTABLE_NAME}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return new Set([...result.stdout.matchAll(/^"[^"]+","(\d+)"/gm)].map((match) => match[1]));
}

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}.`);
    await delay(500);
  }
}

const install = run(installer, ["/S"], { timeout: 10 * 60_000 });
assert(install.status === 0, `The installer exited with ${install.status}.`);
assert(existsSync(executable), `The installer did not write ${executable}.`);
assert(existsSync(join(installDirectory, WINDOWS_UNINSTALLER_NAME)), "The installer did not write its uninstaller.");
assert(existsSync(join(installDirectory, "resources", "app", "runtime", "opencode.exe")), "The install has no bundled opencode.exe.");
assert(existsSync(join(installDirectory, "shared", "message-contracts.mjs")), "The install has no shared contracts.");

// The process-tree helper: the sealed bytes, at the path the app looks in,
// accepted by the installed shared/process-tree.mjs, and able to end a tree
// (the installed app as node, then a child of it) through its job.
const installedHelper = join(installDirectory, "resources", "app", ...PROCESS_TREE_HELPER_APP_PATH.split("/"));
assert(existsSync(installedHelper), `The install has no ${PROCESS_TREE_HELPER_APP_PATH}.`);
const installedHelperSha256 = createHash("sha256").update(readFileSync(installedHelper)).digest("hex");
assert(
  installedHelperSha256 === sealedProcessTreeHelperSha256("x64"),
  `The installed helper is ${installedHelperSha256}; the seal names ${sealedProcessTreeHelperSha256("x64")}.`,
);
const helperProbe = run(executable, ["-e", [
  "(async () => {",
  "  const path = require('node:path');",
  "  const install = process.argv[process.argv.length - 1];",
  "  const tree = await import(require('node:url').pathToFileURL(path.join(install, 'shared', 'process-tree.mjs')).href);",
  "  const helperPath = tree.processTreeHelperPath({ env: {}, resourcesPath: path.join(install, 'resources'), includeLocalBuild: false });",
  "  const program = \"require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000);\";",
  "  const child = tree.spawnTree(process.execPath, ['-e', program], { stdio: 'ignore' }, { helperPath });",
  "  await new Promise((resolve) => setTimeout(resolve, 3000));",
  "  const birth = tree.processBirth(child.pid, { helperPath });",
  "  const before = tree.windowsTreeSize(child.pid, birth, { helperPath });",
  "  const outcome = await tree.terminateTreeOutcome(child, { helperPath });",
  "  const after = tree.windowsTreeSize(child.pid, birth, { helperPath });",
  "  console.log('LETAGENTS_PROCESS_TREE_PROBE ' + JSON.stringify({ helperPath, refusal: tree.processTreeHelperRefusal(), before, outcome, after }));",
  "})().catch((error) => { console.error(error); process.exit(1); });",
].join("\n"), installDirectory], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 2 * 60_000 });
assert(helperProbe.status === 0, `The installed process-tree probe exited with ${helperProbe.status}.`);
const probe = JSON.parse(/LETAGENTS_PROCESS_TREE_PROBE (.+)/.exec(helperProbe.stdout)?.[1] ?? "null");
assert(probe?.helperPath === installedHelper, `The installed app did not accept its helper: ${JSON.stringify(probe)}.`);
// The job held the app as node and its child (the helper is outside its own job), and ended both.
assert(probe.before >= 2 && probe.outcome === "exited" && probe.after === 0, `The installed helper did not end its tree: ${JSON.stringify(probe)}.`);

// The daemon pipe addon: the sealed bytes, at the path the app looks in, and
// loaded by the installed app (as node) to reach a daemon over a real pipe.
const installedAddon = join(installDirectory, "resources", "app", ...DAEMON_PIPE_ADDON_APP_PATH.split("/"));
assert(existsSync(installedAddon), `The install has no ${DAEMON_PIPE_ADDON_APP_PATH}.`);
const installedAddonSha256 = createHash("sha256").update(readFileSync(installedAddon)).digest("hex");
assert(
  installedAddonSha256 === sealedDaemonPipeAddonSha256("x64"),
  `The installed daemon pipe addon is ${installedAddonSha256}; the seal names ${sealedDaemonPipeAddonSha256("x64")}.`,
);
const pipeProbe = run(executable, ["-e", [
  "(async () => {",
  "  const { mkdtempSync, rmSync } = require('node:fs');",
  "  const net = require('node:net');",
  "  const os = require('node:os');",
  "  const path = require('node:path');",
  "  const install = process.argv[process.argv.length - 1];",
  "  const load = (name) => import(require('node:url').pathToFileURL(path.join(install, 'shared', name)).href);",
  "  const endpoint = await load('daemon-endpoint.mjs');",
  "  const native = await load('daemon-pipe-native.mjs');",
  "  const root = mkdtempSync(path.join(os.tmpdir(), 'letagents-pipe-smoke-'));",
  "  const { connectPath, listenPath, proofPath } = endpoint.daemonEndpoint(root);",
  "  const proof = await endpoint.ensureDaemonProof(proofPath);",
  "  const server = net.createServer((socket) => endpoint.acceptDaemonPeer(socket, proof, (admitted) => {",
  "    admitted.setEncoding('utf8'); admitted.on('data', (chunk) => admitted.end('pong:' + chunk));",
  "  }));",
  "  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPath, resolve); });",
  "  const reply = await new Promise((resolve, reject) => {",
  "    const socket = endpoint.connectDaemon(connectPath, { proofPath });",
  "    let data = ''; socket.setEncoding('utf8');",
  "    socket.once('connect', () => socket.write('smoke\\n'));",
  "    socket.on('data', (chunk) => { data += chunk; });",
  "    socket.once('error', reject);",
  "    socket.once('close', () => resolve(data));",
  "  });",
  "  await new Promise((resolve) => server.close(resolve));",
  "  rmSync(root, { recursive: true, force: true });",
  "  console.log('LETAGENTS_DAEMON_PIPE_PROBE ' + JSON.stringify({ addon: native.loadDaemonPipeAddon().path, reply }));",
  "})().catch((error) => { console.error(error); process.exit(1); });",
].join("\n"), installDirectory], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 2 * 60_000 });
assert(pipeProbe.status === 0, `The installed daemon pipe probe exited with ${pipeProbe.status}.`);
const pipe = JSON.parse(/LETAGENTS_DAEMON_PIPE_PROBE (.+)/.exec(pipeProbe.stdout)?.[1] ?? "null");
assert(pipe?.addon === installedAddon && pipe.reply === "pong:smoke\n", `The installed app did not reach a daemon through its addon: ${JSON.stringify(pipe)}.`);
const updaterConfig = JSON.parse(readFileSync(join(installDirectory, "resources", "app-update.yml"), "utf8"));
assert(updaterConfig.url === "https://downloads.letagents.chat/desktop/feeds/win32-x64/", `Unexpected update feed ${updaterConfig.url}.`);
assert(!("publisherName" in updaterConfig), "Unsigned builds must not ask the updater for a publisher signature.");
assert(registryValue(uninstallKey, "DisplayVersion")?.includes(version), "Installed apps does not list this version.");
assert(registryValue(urlKey)?.includes(executable), "letagents:// links are not registered to the installed app.");
assert(
  existsSync(join(process.env.LOCALAPPDATA, "letagents-desktop-updater", "installer.exe")),
  "The installer did not keep itself for the next differential update.",
);
// Windows shows the app's toasts only when the process's AppUserModelID
// (set by the app at startup) matches its Start menu shortcut's. These shell
// reads are the proof that it will display them; the smoke toast below shows
// only that Windows accepted one.
const appIds = shellAppIds([startMenuShortcut, desktopShortcut]);
assert(
  appIds.shortcuts.length === 2 && appIds.shortcuts.every((id) => id === WINDOWS_APP_USER_MODEL_ID),
  `The shortcuts carry AppUserModelIDs ${JSON.stringify(appIds.shortcuts)}; expected ${WINDOWS_APP_USER_MODEL_ID}.`,
);
assert(
  appIds.startApps.includes(WINDOWS_APP_USER_MODEL_ID),
  `The Start menu lists LetAgents as ${JSON.stringify(appIds.startApps)}; expected ${WINDOWS_APP_USER_MODEL_ID}.`,
);

// The app's own output streams straight to this log as it comes, so a hang
// still shows how far it got, and is kept to read the notification result.
console.log(`> ${executable} (LETAGENTS_DESKTOP_SMOKE_CHECK=1)`);
const smoke = await new Promise((resolvePromise, reject) => {
  const child = spawn(executable, [], {
    env: { ...process.env, LETAGENTS_DESKTOP_SMOKE_CHECK: "1", LETAGENTS_DESKTOP_SMOKE_DEBUG: "1", ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const keep = (stream) => (chunk) => { output += chunk; stream.write(chunk); };
  child.stdout.on("data", keep(process.stdout));
  child.stderr.on("data", keep(process.stderr));
  const timer = setTimeout(() => {
    // Leave nothing running that would hold the install folder.
    spawnSync("taskkill", ["/F", "/T", "/IM", WINDOWS_EXECUTABLE_NAME], { stdio: "inherit" });
    reject(new Error("The installed app's smoke check did not finish within 5 minutes."));
  }, 5 * 60_000);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", (status, signal) => { clearTimeout(timer); resolvePromise({ status, signal, output }); });
});
assert(smoke.status === 0, `The installed app's smoke check exited with ${smoke.status ?? smoke.signal}.`);
const notification = /LETAGENTS_DESKTOP_SMOKE_NOTIFICATION (\S+)/.exec(smoke.output)?.[1] ?? "not reported";
console.log(`Smoke notification from the installed app: ${notification}`);
assert(notification === "shown", `Windows did not show the installed app's notification (${notification}).`);

// Update the running app as electron-updater does: the installer gets
// --updated --force-run, must close the app (here it does not quit by
// itself, so the forced close runs), replace the files and start it again.
// A desktop shortcut the user deleted stays deleted.
assert(existsSync(desktopShortcut), "The first install did not create the desktop shortcut.");
rmSync(desktopShortcut);
spawn(executable, [], { detached: true, stdio: "ignore" }).unref();
await waitFor("the installed app to start", () => runningAppIds().size > 0);
const before = runningAppIds();
const update = run(installer, ["--updated", "--force-run", "/S"], { timeout: 10 * 60_000 });
assert(update.status === 0, `The update installer exited with ${update.status}.`);
// A process id that was not running before the update is the restarted app;
// the installer itself refuses to continue while the old app still runs.
await waitFor("the updated app to start again", () => [...runningAppIds()].some((id) => !before.has(id)));
assert(!existsSync(desktopShortcut), "The update created the deleted desktop shortcut again.");
assert(registryValue(uninstallKey, "InstallLocation")?.includes(installDirectory), "The update moved the install.");
// The update created the Start menu shortcut again; it must carry the ID too.
const updatedAppIds = shellAppIds([startMenuShortcut]);
assert(
  updatedAppIds.shortcuts.length === 1 && updatedAppIds.shortcuts[0] === WINDOWS_APP_USER_MODEL_ID,
  `After the update the Start menu shortcut carries ${JSON.stringify(updatedAppIds.shortcuts)}; expected ${WINDOWS_APP_USER_MODEL_ID}.`,
);
spawnSync("taskkill", ["/F", "/IM", WINDOWS_EXECUTABLE_NAME], { stdio: "inherit" });
await waitFor("the updated app to stop", () => runningAppIds().size === 0);

// `_?=` runs the uninstaller in place and waits for it (by default it copies
// itself to %TEMP% and returns at once). In place it cannot delete its own
// file, so the folder itself is left; the checks below are for the payload.
const uninstaller = join(installDirectory, WINDOWS_UNINSTALLER_NAME);
const uninstall = run(uninstaller, ["/S", `_?=${installDirectory}`], { timeout: 5 * 60_000 });
assert(uninstall.status === 0, `The uninstaller exited with ${uninstall.status}.`);
assert(!existsSync(executable), "The uninstaller left LetAgents.exe.");
assert(!existsSync(join(installDirectory, "resources")), "The uninstaller left the resources folder.");
assert(registryValue(uninstallKey, "DisplayVersion") === null, "The uninstaller left the Installed apps entry.");
assert(registryValue(urlKey) === null, "The uninstaller left the letagents:// registration.");

console.log(`LetAgents ${version} installed, passed its smoke check, updated in place and uninstalled.`);
