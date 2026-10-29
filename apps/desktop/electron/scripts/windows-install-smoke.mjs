import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { desktopAssetNames } from "./release-metadata.mjs";
import { WINDOWS_EXECUTABLE_NAME, WINDOWS_UNINSTALLER_NAME } from "./windows-packaging.mjs";

// Installs the built Windows installer silently for the current user, runs
// the installed app's smoke check (LETAGENTS_DESKTOP_SMOKE_CHECK=1 loads the
// real window against seeded local state and exits 0 when it renders), then
// uninstalls it and checks that the install folder and registration are gone.
// For CI runners: it installs into the runner user's own profile.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installer = join(root, "release", "artifacts", desktopAssetNames({ version, arch: process.arch, platform: "win32" }).installer);
const installDirectory = join(process.env.LOCALAPPDATA ?? "", "Programs", "LetAgents");
const executable = join(installDirectory, WINDOWS_EXECUTABLE_NAME);
const uninstallKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\chat.letagents.desktop";
const urlKey = "HKCU\\Software\\Classes\\letagents\\shell\\open\\command";

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

const install = run(installer, ["/S"], { timeout: 10 * 60_000 });
assert(install.status === 0, `The installer exited with ${install.status}.`);
assert(existsSync(executable), `The installer did not write ${executable}.`);
assert(existsSync(join(installDirectory, WINDOWS_UNINSTALLER_NAME)), "The installer did not write its uninstaller.");
assert(existsSync(join(installDirectory, "resources", "app", "runtime", "opencode.exe")), "The install has no bundled opencode.exe.");
assert(existsSync(join(installDirectory, "shared", "message-contracts.mjs")), "The install has no shared contracts.");
const updaterConfig = JSON.parse(readFileSync(join(installDirectory, "resources", "app-update.yml"), "utf8"));
assert(updaterConfig.url === "https://downloads.letagents.chat/desktop/feeds/win32-x64/", `Unexpected update feed ${updaterConfig.url}.`);
assert(!("publisherName" in updaterConfig), "Unsigned builds must not ask the updater for a publisher signature.");
assert(registryValue(uninstallKey, "DisplayVersion")?.includes(version), "Installed apps does not list this version.");
assert(registryValue(urlKey)?.includes(executable), "letagents:// links are not registered to the installed app.");
assert(
  existsSync(join(process.env.LOCALAPPDATA, "letagents-desktop-updater", "installer.exe")),
  "The installer did not keep itself for the next differential update.",
);

const smoke = run(executable, [], {
  env: { ...process.env, LETAGENTS_DESKTOP_SMOKE_CHECK: "1", ELECTRON_ENABLE_LOGGING: "1" },
  timeout: 5 * 60_000,
  windowsHide: false,
});
assert(smoke.status === 0, `The installed app's smoke check exited with ${smoke.status ?? smoke.signal}.`);

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

console.log(`LetAgents ${version} installed, passed its smoke check and uninstalled.`);
