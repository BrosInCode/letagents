#!/usr/bin/env node
// Checks the finished macOS DMG the way a user gets it, before the release
// workflow publishes it: it attaches the DMG read-only, checks the DMG's
// signature and notarization ticket, copies LetAgents.app out of it into a
// new temporary Applications folder, marks the copy as a browser download
// (com.apple.quarantine), checks the copy's signature, Gatekeeper decision
// and ticket, and then starts the copy once with an empty HOME and TMPDIR in
// the app's smoke-check mode (LETAGENTS_DESKTOP_SMOKE_CHECK=1: the real
// window loads against seeded local state and the app exits 0 when it
// renders). It never uses the build folder.
//
//   node electron/scripts/macos-dmg-first-launch.mjs [--dmg <path>] [--arch arm64|x64]
//     [--timeout-ms <n>] [--work-root <folder>] [--unsigned-dmg] [--unsigned] [--keep]
//
// --dmg defaults to release/artifacts/LetAgents-<version>-darwin-<arch>.dmg.
// --arch must be the architecture of this Mac (Rosetta would hide a broken
// native build). --unsigned-dmg skips the DMG's own signature and ticket
// checks; --unsigned also skips the app's checks and the quarantine mark.
// Both are for local unsigned builds (package:mac:local) only; the release
// workflow uses neither. --keep keeps the temporary folder. The temporary
// folder is made below --work-root (default /tmp), not below TMPDIR: the
// app's daemon socket is <HOME>/.letagents/daemon.sock, a macOS socket path
// has at most 103 bytes, and a HOME below /var/folders/... is too long.
//
// When it ends, also on a failure, it stops every process that runs from
// its temporary folder (the app starts a detached supervisor daemon),
// detaches the DMG and removes the folder.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { daemonEndpoint } from "../../../../shared/daemon-endpoint.mjs";
import { validateStapledTicket } from "./notarization-staple-recovery.mjs";
import { assertDesktopArchitecture, desktopAssetNames } from "./release-metadata.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const APP_NAME = "LetAgents.app";
export const SMOKE_RESULT_MARKER = "LETAGENTS_DESKTOP_SMOKE";
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";
/** A browser's download flag (0x0001) without "user approved" (0x0040): Gatekeeper must assess the app. */
export const QUARANTINE_FLAGS = "0081";
export const QUARANTINE_AGENT = "LetAgents release check";
/** sun_path is 104 bytes on macOS, with the closing NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;
const COMMAND_LIMITS = { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 };

export function parseArguments(argv, { version, arch = process.arch } = {}) {
  const options = { dmg: null, arch, timeoutMs: DEFAULT_TIMEOUT_MS, workRoot: "/tmp", unsignedDmg: false, unsigned: false, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    if (argument === "--dmg") options.dmg = resolve(value());
    else if (argument === "--arch") options.arch = value();
    else if (argument === "--timeout-ms") {
      const timeoutMs = Number(value());
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive whole number");
      options.timeoutMs = timeoutMs;
    } else if (argument === "--work-root") options.workRoot = resolve(value());
    else if (argument === "--unsigned-dmg") options.unsignedDmg = true;
    else if (argument === "--unsigned") { options.unsigned = true; options.unsignedDmg = true; }
    else if (argument === "--keep") options.keep = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  assertDesktopArchitecture(options.arch);
  options.dmg ??= join(root, "release", "artifacts", desktopAssetNames({ version, arch: options.arch }).dmg);
  return options;
}

/** The version and architecture in a release DMG's file name. */
export function parseDmgName(path) {
  const match = /^LetAgents-(\d+\.\d+\.\d+)-darwin-(arm64|x64)\.dmg$/.exec(basename(path));
  if (!match) throw new Error(`${basename(path)} is not a LetAgents-<version>-darwin-<arch>.dmg file name.`);
  return { version: match[1], arch: match[2] };
}

/** The app's daemon must be able to listen below `home`; a longer socket path fails with EINVAL. */
export function assertDaemonSocketFits(home) {
  const socketPath = daemonEndpoint(join(home, ".letagents"), { platform: "darwin" }).listenPath;
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`The daemon socket ${socketPath} has ${bytes} bytes; macOS allows ${MAX_SOCKET_PATH_BYTES}. Use a shorter --work-root.`);
  }
  return socketPath;
}

/** The com.apple.quarantine value a browser writes on a download: flags;hex seconds;agent;event id. */
export function quarantineValue({ now = Date.now(), agent = QUARANTINE_AGENT, id = randomUUID() } = {}) {
  const seconds = Math.floor(now / 1000).toString(16).padStart(8, "0");
  return `${QUARANTINE_FLAGS};${seconds};${agent};${id.toUpperCase()}`;
}

/** The mount point that `hdiutil attach -plist` reports. */
export function mountPointFromAttachPlist(plist) {
  const points = [...plist.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map((match) => match[1]);
  if (points.length !== 1) throw new Error(`hdiutil attach reported ${points.length} mount points; expected 1.`);
  return points[0];
}

/** The PATH launchd gives an app that the user opens from Finder. */
export const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const KEPT_VARIABLES = new Set(["USER", "LOGNAME", "SHELL", "LANG", "__CF_USER_TEXT_ENCODING"]);

/**
 * The environment of a first launch from Finder: only the user's identity,
 * shell and locale from the caller (no LetAgents, Electron, Node or tool
 * setting of the runner or the developer), Finder's PATH, a new HOME and
 * TMPDIR, and the smoke-check mode on.
 */
export function firstLaunchEnvironment(base, { home, temporary }) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (KEPT_VARIABLES.has(name) || name.startsWith("LC_")) env[name] = value;
  }
  return {
    ...env,
    PATH: FINDER_PATH,
    HOME: home,
    TMPDIR: `${temporary}/`,
    LETAGENTS_DESKTOP_SMOKE_CHECK: "1",
    LETAGENTS_DESKTOP_SMOKE_DEBUG: "1",
    ELECTRON_ENABLE_LOGGING: "1",
  };
}

/** Gatekeeper's (spctl's) report must say the item is accepted as notarized Developer ID software. */
export function assertGatekeeperAccepted(report, label) {
  if (!/:\s*accepted\b/.test(report) || !/^source=Notarized Developer ID$/m.test(report)) {
    throw new Error(`Gatekeeper did not accept ${label} as notarized Developer ID software:\n${report.trim()}`);
  }
}

/** The result of the smoke launch: a pass needs exit 0 and a smoke result where every check is true. */
export function smokeVerdict({ status, signal, output, timedOut, timeoutMs }) {
  if (timedOut) return { passed: false, reason: `the app did not finish its smoke check within ${timeoutMs} ms` };
  const line = output.split(/\r?\n/).reverse().find((candidate) => candidate.startsWith(`${SMOKE_RESULT_MARKER} {`));
  let result = null;
  if (line) {
    try { result = JSON.parse(line.slice(SMOKE_RESULT_MARKER.length + 1)); } catch { result = null; }
  }
  if (signal) {
    return { passed: false, result, reason: `the app was ended by ${signal}${signal === "SIGKILL" ? " (Gatekeeper ends an app it refuses this way)" : ""}` };
  }
  if (status !== 0) return { passed: false, result, reason: `the app exited with ${status}` };
  if (!result) return { passed: false, result, reason: "the app exited 0 without a smoke result line" };
  const failed = Object.entries(result).filter(([, value]) => value !== true).map(([name]) => name);
  if (failed.length > 0) return { passed: false, result, reason: `smoke checks failed: ${failed.join(", ")}` };
  return { passed: true, result, reason: "every smoke check passed" };
}

/** Process ids in `ps -axww -o pid=,command=` output whose command runs from below `folder`. */
export function processIdsUnder(psOutput, folder, { exclude = [process.pid] } = {}) {
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  const ids = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (exclude.includes(pid) || !match[2].includes(prefix)) continue;
    ids.push(pid);
  }
  return ids;
}

/**
 * Start the app and wait until it exits by itself or the time limit ends.
 * The app's output streams to this process's output as it comes, so a hang
 * still shows how far it got. At the time limit, onTimeout runs (it stops
 * the app) and the result says timedOut.
 */
export function launchUntilExit({ executable, args = [], env, cwd, timeoutMs, onTimeout = async () => {}, echo = true, closeGraceMs = 2_000 }) {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(executable, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const keep = (stream) => (chunk) => {
      output += chunk;
      if (echo) stream.write(chunk);
    };
    child.stdout.on("data", keep(process.stdout));
    child.stderr.on("data", keep(process.stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve().then(() => onTimeout(child)).catch(() => undefined).finally(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    // "close" waits for the output pipes; a process the app left running could
    // hold them open, so the result comes at most closeGraceMs after the exit.
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      const finish = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolveLaunch({ status, signal, output, timedOut });
      };
      const grace = setTimeout(finish, closeGraceMs);
      child.once("close", () => { clearTimeout(grace); finish(); });
    });
  });
}

async function run(command, args, { quiet = false } = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  try {
    const { stdout, stderr } = await execFileAsync(command, args, COMMAND_LIMITS);
    const text = `${stdout}${stderr}`;
    if (text.trim() && !quiet) console.log(text.trim());
    return text;
  } catch (error) {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed (${error.code ?? error.signal ?? error.message})${text ? `:\n${text}` : ""}`);
  }
}

/** `xcrun stapler validate`, with the release build's retry of Apple's transient network errors. */
async function validateTicket(path) {
  console.log(`> xcrun stapler validate ${path}`);
  await validateStapledTicket(path, { execFile: execFileAsync });
  console.log(`The stapled notarization ticket of ${basename(path)} is valid.`);
}

async function stopProcessesUnder(folder) {
  const list = async () => processIdsUnder((await execFileAsync("ps", ["-axww", "-o", "pid=,command="], COMMAND_LIMITS)).stdout, folder);
  let ids = await list();
  if (ids.length === 0) return;
  console.log(`Stopping ${ids.length} process(es) that run from ${folder}: ${ids.join(" ")}`);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const pid of ids) {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
    for (let attempt = 0; attempt < 20 && ids.length > 0; attempt += 1) {
      await delay(250);
      ids = await list();
    }
    if (ids.length === 0) return;
  }
  throw new Error(`Processes ${ids.join(" ")} still run from ${folder}.`);
}

async function detach(mountPoint) {
  try {
    await run("hdiutil", ["detach", mountPoint]);
  } catch (error) {
    console.warn(`${error.message}\nRetrying with -force.`);
    await run("hdiutil", ["detach", "-force", mountPoint]);
  }
}

async function main() {
  if (process.platform !== "darwin") throw new Error("The DMG first-launch check must run on macOS.");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const options = parseArguments(process.argv.slice(2), { version });
  if (options.arch !== process.arch) {
    throw new Error(`This Mac runs ${process.arch}; the ${options.arch} DMG must be checked on an ${options.arch} Mac.`);
  }
  if (!existsSync(options.dmg)) throw new Error(`The DMG does not exist at ${options.dmg}. Run npm run package:mac first, or pass --dmg.`);
  const dmgName = parseDmgName(options.dmg);
  if (dmgName.arch !== options.arch) throw new Error(`${basename(options.dmg)} is not a ${options.arch} DMG.`);

  const folder = await mkdtemp(join(realpathSync(options.workRoot), "letagents-dmg-"));
  const applications = join(folder, "Applications");
  const home = join(folder, "home");
  const temporary = join(folder, "tmp");
  const app = join(applications, APP_NAME);
  let mountPoint = null;
  let failure = null;
  try {
    await Promise.all([applications, home, temporary].map((path) => mkdir(path)));
    assertDaemonSocketFits(home);

    if (options.unsignedDmg) console.log("Skipping the DMG's signature and ticket checks (--unsigned-dmg).");
    else {
      assertGatekeeperAccepted(await run("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", options.dmg]), "the DMG");
      await validateTicket(options.dmg);
    }

    mountPoint = mountPointFromAttachPlist(await run("hdiutil", [
      "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountrandom", folder, "-plist", options.dmg,
    ], { quiet: true }));
    console.log(`Attached read-only at ${mountPoint}.`);
    const mountedApp = join(mountPoint, APP_NAME);
    if (!existsSync(mountedApp)) throw new Error(`The DMG has no ${APP_NAME} at its top level.`);
    const applicationsLink = join(mountPoint, "Applications");
    if (!existsSync(applicationsLink) || readlinkSync(applicationsLink) !== "/Applications") {
      throw new Error("The DMG has no Applications link to /Applications for the drag-to-install layout.");
    }
    await run("ditto", [mountedApp, app]);
    await detach(mountPoint);
    mountPoint = null;

    const bundleVersion = (await run("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(app, "Contents", "Info.plist")])).trim();
    if (bundleVersion !== dmgName.version) throw new Error(`The DMG is named for ${dmgName.version}, but its app is ${bundleVersion}.`);
    const executable = join(app, "Contents", "MacOS", "LetAgents");
    const archs = (await run("lipo", ["-archs", executable])).trim().split(/\s+/);
    if (!archs.includes(options.arch)) throw new Error(`The app's executable is ${archs.join(", ")}, not ${options.arch}.`);

    if (options.unsigned) console.log("Skipping the quarantine mark and the app's signature checks (--unsigned).");
    else {
      const quarantine = quarantineValue();
      await run("xattr", ["-w", "-r", QUARANTINE_ATTRIBUTE, quarantine, app]);
      const marked = (await run("xattr", ["-p", QUARANTINE_ATTRIBUTE, app])).trim();
      if (marked !== quarantine) throw new Error(`The copy carries quarantine '${marked}', not '${quarantine}'.`);
      await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
      assertGatekeeperAccepted(await run("spctl", ["--assess", "--type", "execute", "-vv", app]), "the app");
      await validateTicket(app);
    }

    console.log(`> ${executable} (LETAGENTS_DESKTOP_SMOKE_CHECK=1, HOME=${home}, limit ${options.timeoutMs} ms)`);
    const launch = await launchUntilExit({
      executable,
      env: firstLaunchEnvironment(process.env, { home, temporary }),
      cwd: home,
      timeoutMs: options.timeoutMs,
      onTimeout: () => stopProcessesUnder(folder),
    });
    const verdict = smokeVerdict({ ...launch, timeoutMs: options.timeoutMs });
    if (!verdict.passed) throw new Error(`The first launch of the app from ${basename(options.dmg)} failed: ${verdict.reason}.`);
    console.log(`LetAgents ${bundleVersion} (${options.arch}) from ${basename(options.dmg)} passed its first-launch smoke check: ${verdict.reason}.`);
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = [];
    for (const step of [
      () => stopProcessesUnder(folder),
      () => (mountPoint ? detach(mountPoint) : undefined),
      () => (options.keep ? console.log(`Kept ${folder}.`) : rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
    ]) {
      try { await step(); } catch (error) { cleanup.push(error); }
    }
    if (!failure && cleanup.length > 0) failure = cleanup[0];
    else for (const error of cleanup) console.error(`Cleanup: ${error.message}`);
  }
  if (failure) throw failure;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
