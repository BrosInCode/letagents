import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// letagents-daemon-pipe.node (apps/desktop/native/win-daemon-pipe): the only
// way a client opens the supervisor daemon's pipe on Windows. It opens the
// pipe with SECURITY_IDENTIFICATION, so the server end cannot act as this
// user, and hands Node the handle only when the server end runs as this
// user. libuv's own pipe connect has neither property, so without the addon
// a client refuses to connect (ERR_LETAGENTS_DAEMON_PIPE_ADDON) rather than
// fall back to it.
//
// The addon is loaded only when its bytes are the sealed build for this
// architecture (shared/letagents-daemon-pipe.seal.json).

export const DAEMON_PIPE_ADDON_NAME = "letagents-daemon-pipe.node";
/** An absolute path to the addon, for a process that runs outside the app (tests, a source checkout). */
export const DAEMON_PIPE_ADDON_ENV = "LETAGENTS_DAEMON_PIPE_ADDON";
export const DAEMON_PIPE_ADDON_ERROR = "ERR_LETAGENTS_DAEMON_PIPE_ADDON";
const SEAL_URL = new URL("./letagents-daemon-pipe.seal.json", import.meta.url);

let loadedSeal;
function daemonPipeSeal() {
  if (loadedSeal === undefined) {
    try { loadedSeal = JSON.parse(readFileSync(SEAL_URL, "utf8")); } catch { loadedSeal = null; }
  }
  return loadedSeal;
}

/** The sealed sha256 of the addon built for `arch`, or null when no build for it is sealed. */
export function sealedDaemonPipeAddonSha256(arch = process.arch, seal = daemonPipeSeal()) {
  const digest = seal?.builds?.[arch === "arm64" ? "arm64" : "x64"]?.sha256;
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function isFile(filePath) {
  try { return statSync(filePath).isFile(); } catch { return false; }
}

/**
 * Where the addon may be, in order: the LETAGENTS_DAEMON_PIPE_ADDON path
 * (alone: a configured addon that is missing is an error to see; a network
 * path is never used), then `<resources>/app/runtime/`, where the packaged
 * app ships it (Electron sets process.resourcesPath in the app and in its
 * ELECTRON_RUN_AS_NODE children), or, for a process that is not the app's
 * (`npx letagents` under Node), the same file in the folder the installer
 * recorded (InstallLocation), then in its default per-user folder, then the
 * local build beside its source.
 *
 * The bytes are hashed, then loaded by path. A process that could replace
 * the file in between could as well replace this module or the app beside
 * it, so the seal guards against stale or foreign builds, not against a
 * writer of the install folder.
 */
export function daemonPipeAddonCandidates(options = {}) {
  const env = options.env ?? process.env;
  const configured = env[DAEMON_PIPE_ADDON_ENV]?.trim();
  if (configured) return /^[A-Za-z]:[\\/]/.test(configured) ? [configured] : [];
  const resourcesPath = options.resourcesPath ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : "");
  const localAppData = env.LOCALAPPDATA?.trim();
  const arch = (options.arch ?? process.arch) === "arm64" ? "arm64" : "x64";
  const candidates = [];
  if (resourcesPath.trim()) candidates.push(path.win32.join(resourcesPath, "app", "runtime", DAEMON_PIPE_ADDON_NAME));
  else {
    const installed = options.installLocation === undefined ? recordedInstallLocation() : options.installLocation;
    const folders = [installed, localAppData ? path.win32.join(localAppData, "Programs", "LetAgents") : null];
    for (const folder of new Set(folders.filter((folder) => folder && /^[A-Za-z]:[\\/]/.test(folder)))) {
      candidates.push(path.win32.join(folder, "resources", "app", "runtime", DAEMON_PIPE_ADDON_NAME));
    }
  }
  if (options.includeLocalBuild !== false) {
    candidates.push(fileURLToPath(new URL(`../apps/desktop/native/win-daemon-pipe/build/${arch}/${DAEMON_PIPE_ADDON_NAME}`, import.meta.url)));
  }
  return candidates;
}

const INSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\chat.letagents.desktop";

/**
 * The desktop installer's InstallLocation (HKCU, per-user install), or null.
 * `reg export` writes UTF-16, so a folder name outside the console's code
 * page reads back whole (reg query's output would not). Asked once per
 * process; a missing key is null.
 */
let installLocation;
function recordedInstallLocation() {
  if (installLocation !== undefined) return installLocation;
  installLocation = null;
  if (process.platform !== "win32") return installLocation;
  let folder = null;
  try {
    folder = mkdtempSync(path.win32.join(tmpdir(), "letagents-install-"));
    const exported = path.win32.join(folder, "install.reg");
    execFileSync(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"), ["export", INSTALL_KEY, exported, "/y"],
      { windowsHide: true, timeout: 5_000, stdio: "ignore" });
    installLocation = parseInstallLocation(readFileSync(exported));
  } catch { /* not installed */ }
  // Best effort: a scanner holding the export must not undo what was read.
  try { if (folder) rmSync(folder, { recursive: true, force: true }); } catch { /* left in the user's temp folder */ }
  return installLocation;
}

/** InstallLocation from a `reg export` file (UTF-16LE with a byte-order mark), or null. */
export function parseInstallLocation(bytes) {
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
  const match = /^"InstallLocation"="((?:[^"\\]|\\.)*)"\s*$/m.exec(text);
  return match ? match[1].replace(/\\(.)/g, "$1") : null;
}

function addonError(message) {
  return Object.assign(new Error(message), { code: DAEMON_PIPE_ADDON_ERROR });
}

/**
 * The first candidate whose bytes are the sealed build, as
 * `{ path, sha256 }`; a found file with other bytes is an error, not a
 * reason to use another candidate.
 */
export function findDaemonPipeAddon(options = {}) {
  const arch = options.arch ?? process.arch;
  const expected = sealedDaemonPipeAddonSha256(arch, options.seal === undefined ? daemonPipeSeal() : options.seal);
  const exists = options.exists ?? isFile;
  const read = options.readFile ?? readFileSync;
  const candidates = daemonPipeAddonCandidates(options);
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) {
    throw addonError(`${DAEMON_PIPE_ADDON_NAME} was not found (looked in ${candidates.join(", ") || "no folder"}); `
      + "reinstall LetAgents, or build it with apps/desktop/native/win-daemon-pipe/build.mjs.");
  }
  if (!expected) throw addonError(`No ${arch} build of ${DAEMON_PIPE_ADDON_NAME} is sealed in shared/letagents-daemon-pipe.seal.json.`);
  let sha256;
  try { sha256 = createHash("sha256").update(read(found)).digest("hex"); } catch (error) {
    throw addonError(`${found} could not be read: ${error?.message ?? error}`);
  }
  if (sha256 !== expected) {
    throw addonError(`${found} (sha256 ${sha256}) is not the sealed ${DAEMON_PIPE_ADDON_NAME} (${expected}); refusing to load it.`);
  }
  return { path: found, sha256 };
}

let loaded = null;

/**
 * The loaded addon, `{ path, sha256, open(name) }`. Loaded once per process,
 * after its bytes were checked against the seal; a failure is not cached, so
 * a later call looks again. Throws ERR_LETAGENTS_DAEMON_PIPE_ADDON.
 */
export function loadDaemonPipeAddon(options = {}) {
  if (loaded) return loaded;
  if ((options.platform ?? process.platform) !== "win32") throw addonError(`${DAEMON_PIPE_ADDON_NAME} exists only on Windows.`);
  const found = findDaemonPipeAddon(options);
  const module = { exports: {} };
  try {
    process.dlopen(module, found.path);
  } catch (error) {
    throw addonError(`${found.path} could not be loaded: ${error?.message ?? error}`);
  }
  // An addon whose host lacks N-API or uv_open_osfhandle exports nothing.
  if (typeof module.exports.open !== "function") {
    throw addonError(`${found.path} found no N-API or uv_open_osfhandle in this executable (${process.execPath}).`);
  }
  loaded = { path: found.path, sha256: found.sha256, open: module.exports.open };
  return loaded;
}
