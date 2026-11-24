import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

// Electron fuses are bytes in the Electron binary that turn features on or
// off at package time (https://www.electronjs.org/docs/latest/tutorial/fuses).
// The wire is the sentinel, one version byte, one length byte, then one byte
// per fuse: "0" off, "1" on, "r" removed by Electron.
export const ELECTRON_FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
export const ELECTRON_FUSE_WIRE_VERSION = 1;

/** The version 1 wire in order (Electron build/fuses/fuses.json5). */
export const ELECTRON_FUSE_NAMES = Object.freeze([
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
  "WasmTrapHandlers",
]);

/**
 * The fuses of every packaged LetAgents build. Each fuse has a decision, so a
 * new Electron fuse stops packaging until someone decides it.
 */
export const LETAGENTS_ELECTRON_FUSES = Object.freeze({
  // The supervisor daemon and every MCP server child run on the app's own
  // binary with ELECTRON_RUN_AS_NODE=1.
  RunAsNode: true,
  // Electron default. Turning it on is one-way for the cookie store.
  EnableCookieEncryption: false,
  // Off would also drop NODE_EXTRA_CA_CERTS from the app's environment, and
  // the app passes that to agents for company certificate authorities.
  EnableNodeOptionsEnvironmentVariable: true,
  // Off: SIGUSR1, --inspect and --inspect-brk open no debugger in the app
  // process or its helpers (SIGUSR1 then ends the app, its default action).
  // Nothing in a packaged build uses them. ELECTRON_RUN_AS_NODE processes
  // ignore this fuse; they need Node's --disable-sigusr1 flag.
  EnableNodeCliInspectArguments: false,
  // The app is a folder (Resources/app), not an asar archive.
  EnableEmbeddedAsarIntegrityValidation: false,
  OnlyLoadAppFromAsar: false,
  LoadBrowserProcessSpecificV8Snapshot: false,
  // The renderer loads from file://.
  GrantFileProtocolExtraPrivileges: true,
  WasmTrapHandlers: true,
});

const WIRE_VALUES = new Map([[0x30, false], [0x31, true], [0x72, "removed"]]);

function sentinelOffsets(bytes) {
  const sentinel = Buffer.from(ELECTRON_FUSE_SENTINEL, "ascii");
  const offsets = [];
  for (let offset = bytes.indexOf(sentinel); offset !== -1; offset = bytes.indexOf(sentinel, offset + sentinel.length)) {
    offsets.push(offset);
  }
  return offsets;
}

/** Every fuse wire in a binary (a universal macOS binary has one per architecture). */
export function readElectronFuseWires(bytes, label = "the Electron binary") {
  const offsets = sentinelOffsets(bytes);
  if (offsets.length === 0) throw new Error(`No Electron fuse wire found in ${label}.`);
  return offsets.map((offset) => {
    const versionOffset = offset + ELECTRON_FUSE_SENTINEL.length;
    const version = bytes[versionOffset];
    const length = bytes[versionOffset + 1];
    if (version !== ELECTRON_FUSE_WIRE_VERSION) {
      throw new Error(`${label} has fuse wire version ${version}; packaging knows version ${ELECTRON_FUSE_WIRE_VERSION}.`);
    }
    if (length !== ELECTRON_FUSE_NAMES.length) {
      throw new Error(`${label} has ${length} fuses; packaging knows ${ELECTRON_FUSE_NAMES.length}. Decide each new fuse in LETAGENTS_ELECTRON_FUSES.`);
    }
    const wireOffset = versionOffset + 2;
    const fuses = {};
    ELECTRON_FUSE_NAMES.forEach((name, index) => {
      const value = WIRE_VALUES.get(bytes[wireOffset + index]);
      if (value === undefined) throw new Error(`${label} has an unknown value for fuse ${name}.`);
      fuses[name] = value;
    });
    return { offset: wireOffset, fuses };
  });
}

function assertCompletePolicy(policy) {
  const names = Object.keys(policy).sort();
  const known = [...ELECTRON_FUSE_NAMES].sort();
  if (JSON.stringify(names) !== JSON.stringify(known) || names.some((name) => typeof policy[name] !== "boolean")) {
    throw new Error(`The fuse policy must set exactly these fuses to true or false: ${ELECTRON_FUSE_NAMES.join(", ")}.`);
  }
}

/** Write the policy into every fuse wire of `bytes` in place. */
export function setElectronFuseWires(bytes, policy = LETAGENTS_ELECTRON_FUSES, label = "the Electron binary") {
  assertCompletePolicy(policy);
  const wires = readElectronFuseWires(bytes, label);
  for (const wire of wires) {
    ELECTRON_FUSE_NAMES.forEach((name, index) => {
      if (wire.fuses[name] === "removed") {
        throw new Error(`Electron removed fuse ${name} in ${label}; update LETAGENTS_ELECTRON_FUSES.`);
      }
      bytes[wire.offset + index] = policy[name] ? 0x31 : 0x30;
    });
  }
  return wires.length;
}

/** The fuses that differ from the policy, as "Name: found X, expected Y" lines. */
export function electronFuseMismatches(bytes, policy = LETAGENTS_ELECTRON_FUSES, label = "the Electron binary") {
  assertCompletePolicy(policy);
  return readElectronFuseWires(bytes, label).flatMap((wire) => ELECTRON_FUSE_NAMES
    .filter((name) => wire.fuses[name] !== policy[name])
    .map((name) => `${name}: found ${wire.fuses[name]}, expected ${policy[name]}`));
}

/** The file that holds the fuse wire in a packaged app folder. */
export function packagedFuseBinaryPath({ bundle, platform, executableName }) {
  if (platform === "darwin") {
    return join(bundle, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
  }
  if (platform === "win32") return join(bundle, executableName);
  throw new Error(`No packaged Electron layout for ${platform}.`);
}

/** The file that holds the fuse wire in the electron npm package's dist folder. */
export function distFuseBinaryPath({ dist, platform }) {
  if (platform === "darwin") {
    return join(dist, "Electron.app", "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
  }
  return join(dist, platform === "win32" ? "electron.exe" : "electron");
}

/**
 * Flip the fuses of a packaged app folder before it is signed, then read them
 * back. On macOS the changed framework gets a new ad-hoc signature so an
 * unsigned local build still loads it; release signing replaces that
 * signature with the Developer ID one.
 */
export async function applyPackagedElectronFuses({
  bundle,
  platform,
  executableName,
  policy = LETAGENTS_ELECTRON_FUSES,
  run = promisify(execFile),
}) {
  const binary = packagedFuseBinaryPath({ bundle, platform, executableName });
  const bytes = await readFile(binary);
  const wires = setElectronFuseWires(bytes, policy, binary);
  await writeFile(binary, bytes);
  if (platform === "darwin") {
    const framework = await realpath(join(bundle, "Contents", "Frameworks", "Electron Framework.framework"));
    await run("codesign", ["--force", "--sign", "-", framework]);
  }
  await assertPackagedElectronFuses({ bundle, platform, executableName, policy });
  return { binary, wires, fuses: { ...policy } };
}

/** Fail unless every fuse wire of a packaged app folder matches the policy. */
export async function assertPackagedElectronFuses({
  bundle,
  platform,
  executableName,
  policy = LETAGENTS_ELECTRON_FUSES,
}) {
  const binary = packagedFuseBinaryPath({ bundle, platform, executableName });
  const mismatches = electronFuseMismatches(await readFile(binary), policy, binary);
  if (mismatches.length > 0) {
    throw new Error(`The packaged Electron fuses do not match the LetAgents policy:\n${mismatches.join("\n")}`);
  }
}
