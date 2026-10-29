import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DAEMON_PIPE_ADDON_NAME, sealedDaemonPipeAddonSha256 } from "../../../../shared/daemon-pipe-native.mjs";

const execFileAsync = promisify(execFile);
const daemonPipeSource = fileURLToPath(new URL("../../native/win-daemon-pipe/", import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Sizes Windows picks from for the taskbar, Start menu, Explorer and Alt+Tab. */
export const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const WINDOWS_EXECUTABLE_NAME = "LetAgents.exe";
/** The installer's APP_ID and the app's WINDOWS_APP_USER_MODEL_ID (electron/main/windows-app-identity.ts). */
export const WINDOWS_APP_USER_MODEL_ID = "chat.letagents.desktop";
export const WINDOWS_UNINSTALLER_NAME = "Uninstall LetAgents.exe";

/** Width and height from a PNG's IHDR chunk. */
export function readPngDimensions(png) {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR") {
    throw new Error("Windows icon entries must be PNG images.");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * An .ico file whose entries are PNG images (supported since Windows Vista).
 * `images` are `{ size, png }` with square PNGs of at most 256 pixels.
 */
export function createIcoFile(images) {
  if (images.length === 0) throw new Error("A Windows icon needs at least one image.");
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const { width, height } = readPngDimensions(png);
    if (width !== size || height !== size || size < 1 || size > 256) {
      throw new Error(`Windows icon entry ${index} must be a ${size}x${size} PNG of at most 256 pixels; found ${width}x${height}.`);
    }
    const entry = index * 16;
    // 0 means 256 in the one-byte width and height fields.
    directory.writeUInt8(size === 256 ? 0 : size, entry);
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

/** The four-part version Windows resources and NSIS require: 0.1.130 -> 0.1.130.0. */
export function windowsFileVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Windows version metadata requires a numeric x.y.z version; received '${version ?? ""}'.`);
  }
  for (const part of version.split(".")) {
    if (Number(part) > 65535) throw new Error(`Windows version parts must be at most 65535; received '${version}'.`);
  }
  return `${version}.0`;
}

/**
 * Resize the square brand PNG to each Windows icon size with the .NET image
 * classes every Windows PowerShell has (the macOS packager uses sips the same
 * way). The paths travel as environment variables, so no quoting is needed.
 */
export async function renderWindowsIconPngs(source, { sizes = WINDOWS_ICON_SIZES, run = execFileAsync, env = process.env } = {}) {
  const directory = await mkdtemp(win32.join(tmpdir(), "letagents-icon-"));
  try {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Drawing",
      "$source = [System.Drawing.Image]::FromFile($env:LETAGENTS_ICON_SOURCE)",
      "try {",
      "  foreach ($size in ($env:LETAGENTS_ICON_SIZES -split ',')) {",
      "    $pixels = [int]$size",
      "    $bitmap = New-Object System.Drawing.Bitmap $pixels, $pixels, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)",
      "    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
      "    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality",
      "    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
      "    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality",
      "    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality",
      "    $graphics.DrawImage($source, 0, 0, $pixels, $pixels)",
      "    $graphics.Dispose()",
      "    $bitmap.Save((Join-Path $env:LETAGENTS_ICON_OUTPUT \"$pixels.png\"), [System.Drawing.Imaging.ImageFormat]::Png)",
      "    $bitmap.Dispose()",
      "  }",
      "} finally { $source.Dispose() }",
    ].join("\n");
    await run(windowsPowerShell(env), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      env: {
        ...env,
        LETAGENTS_ICON_SOURCE: source,
        LETAGENTS_ICON_OUTPUT: directory,
        LETAGENTS_ICON_SIZES: sizes.join(","),
      },
      maxBuffer: 8 * 1024 * 1024,
    });
    return await Promise.all(sizes.map(async (size) => ({ size, png: await readFile(win32.join(directory, `${size}.png`)) })));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function windowsPowerShell(env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Brand the copied electron.exe: the LetAgents icon and version metadata
 * (Explorer's Details tab, Task Manager and the SmartScreen prompt show
 * these). Electron's own Authenticode signature is dropped, because a changed
 * file would fail it anyway; LetAgents builds ship unsigned for now.
 */
export async function brandWindowsExecutable({ executable, icon, version, copyright }) {
  const ResEdit = await import("resedit");
  const fileVersion = windowsFileVersion(version);
  const image = ResEdit.NtExecutable.from(await readFile(executable), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(image);
  const iconFile = ResEdit.Data.IconFile.from(icon);
  const [iconGroup] = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    iconGroup?.id ?? 1,
    iconGroup?.lang ?? 1033,
    iconFile.icons.map((item) => item.data),
  );
  const [versionInfo = ResEdit.Resource.VersionInfo.createEmpty()] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  const languages = versionInfo.getAllLanguagesForStringValues();
  for (const language of languages.length > 0 ? languages : [{ lang: 1033, codepage: 1200 }]) {
    versionInfo.setStringValues(language, {
      CompanyName: "LetAgents",
      FileDescription: "LetAgents",
      FileVersion: fileVersion,
      InternalName: "LetAgents",
      LegalCopyright: copyright,
      OriginalFilename: WINDOWS_EXECUTABLE_NAME,
      ProductName: "LetAgents",
      ProductVersion: version,
    });
  }
  versionInfo.setFileVersion(fileVersion);
  versionInfo.setProductVersion(fileVersion);
  versionInfo.outputToResourceEntries(resources.entries);
  resources.outputResource(image);
  await writeFile(executable, Buffer.from(image.generate()));
}

/** The four-part file version a branded executable reports, for the packager's own check. */
export async function readWindowsExecutableVersion(executable) {
  const ResEdit = await import("resedit");
  const image = ResEdit.NtExecutable.from(await readFile(executable), { ignoreCert: true });
  const [versionInfo] = ResEdit.Resource.VersionInfo.fromEntries(ResEdit.NtExecutableResource.from(image).entries);
  if (!versionInfo) return null;
  const { fileVersionMS, fileVersionLS } = versionInfo.fixedInfo;
  return [fileVersionMS >>> 16, fileVersionMS & 0xffff, fileVersionLS >>> 16, fileVersionLS & 0xffff].join(".");
}

function isPathLike(value) {
  return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value);
}

/**
 * The real opencode.exe to bundle. npm's global install on Windows puts
 * `opencode.cmd` (a script shim) on PATH and the binary at
 * `node_modules/opencode-ai/bin/opencode.exe` beside it; `where` finds the shim,
 * which the packaged app could not run directly.
 */
export function resolveWindowsOpenCodeExecutable({ requested = "opencode", env = process.env, exists = existsSync } = {}) {
  if (isPathLike(requested)) {
    if (!/\.exe$/i.test(requested)) {
      throw new Error(`LETAGENTS_OPENCODE_BIN must name opencode.exe on Windows; received '${requested}'.`);
    }
    return requested;
  }
  const directories = (env.PATH ?? env.Path ?? "").split(win32.delimiter).filter(Boolean);
  for (const directory of directories) {
    const executable = win32.join(directory, `${requested}.exe`);
    if (exists(executable)) return executable;
    if (exists(win32.join(directory, `${requested}.cmd`))) {
      const installed = win32.join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe");
      if (exists(installed)) return installed;
    }
  }
  throw new Error(`OpenCode was not found on PATH; set LETAGENTS_OPENCODE_BIN to opencode.exe.`);
}

/** A Windows executable starts with the DOS header `MZ`; npm's placeholder and shims do not. */
export function assertWindowsExecutableBytes(bytes, label) {
  if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`${label} is not a Windows executable.`);
  }
}

/**
 * makensis from LETAGENTS_MAKENSIS, PATH, or NSIS's default install folders.
 * GitHub's windows-2022 image has NSIS 3.10 preinstalled at the first of these.
 */
export function findMakensis({ env = process.env, exists = existsSync } = {}) {
  const configured = env.LETAGENTS_MAKENSIS?.trim();
  if (configured) {
    if (!exists(configured)) throw new Error(`LETAGENTS_MAKENSIS does not exist: ${configured}`);
    return configured;
  }
  const candidates = [
    ...(env.PATH ?? env.Path ?? "").split(win32.delimiter).filter(Boolean).map((directory) => win32.join(directory, "makensis.exe")),
    ...[env["ProgramFiles(x86)"], env.ProgramFiles].filter(Boolean).map((directory) => win32.join(directory, "NSIS", "makensis.exe")),
  ];
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) {
    throw new Error("NSIS (makensis.exe) was not found. Install NSIS 3 or set LETAGENTS_MAKENSIS to makensis.exe.");
  }
  return found;
}

const SAFE_PAYLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]*$/;

/**
 * The NSIS include that removes the previous install's payload before the new
 * one is written, and on uninstall. It names each top-level entry the
 * packaged app has, so an install never deletes anything else in its folder.
 */
export function createNsisPayloadInclude(entries) {
  const lines = ["; Generated by electron/scripts/package-windows.mjs. Do not edit.", "!macro REMOVE_LETAGENTS_PAYLOAD"];
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (!sorted.some((entry) => entry.name === WINDOWS_EXECUTABLE_NAME && !entry.directory)) {
    throw new Error(`The packaged Windows app must contain ${WINDOWS_EXECUTABLE_NAME}.`);
  }
  for (const { name, directory } of sorted) {
    if (!SAFE_PAYLOAD_NAME.test(name) || name === WINDOWS_UNINSTALLER_NAME) {
      throw new Error(`Unexpected top-level entry in the packaged Windows app: '${name}'.`);
    }
    lines.push(directory ? `  RMDir /r "$INSTDIR\\${name}"` : `  Delete "$INSTDIR\\${name}"`);
  }
  lines.push("!macroend", "");
  return lines.join("\r\n");
}

export async function listPayloadEntries(directory) {
  return (await readdir(directory, { withFileTypes: true })).map((entry) => ({
    name: entry.name,
    directory: entry.isDirectory(),
  }));
}

/** Where shared/daemon-pipe-native.mjs looks for the daemon pipe addon in the packaged app, under resources/app. */
export const DAEMON_PIPE_ADDON_APP_PATH = `runtime/${DAEMON_PIPE_ADDON_NAME}`;

/**
 * The daemon pipe addon to ship: LETAGENTS_DAEMON_PIPE_ADDON_BUILD when set
 * (an addon another job built with build.mjs on the sealed compiler), else a
 * build here with `build.mjs --arch <arch> --check --strict`, which fails
 * unless this machine built the sealed bytes.
 */
export function buildDaemonPipeAddon({ arch, env = process.env, run = spawnSync } = {}) {
  const prebuilt = env.LETAGENTS_DAEMON_PIPE_ADDON_BUILD?.trim();
  if (prebuilt) return prebuilt;
  const built = run(process.execPath, [join(daemonPipeSource, "build.mjs"), "--arch", arch, "--check", "--strict"], { stdio: "inherit" });
  if (built.status !== 0) {
    throw new Error(`win-daemon-pipe/build.mjs --arch ${arch} --check --strict failed (exit ${built.status ?? built.signal ?? built.error?.message}).`);
  }
  return join(daemonPipeSource, "build", arch, DAEMON_PIPE_ADDON_NAME);
}

/**
 * Write the addon into the app only when its bytes are the sealed build for
 * `arch` (shared/letagents-daemon-pipe.seal.json, read by the same function
 * the app uses before it loads the addon). Any other bytes fail the build:
 * the app would refuse them, and no daemon client could connect. The
 * checked bytes are the ones written.
 */
export async function stageDaemonPipeAddon({ addon, destination, arch, seal }) {
  const bytes = await readFile(addon);
  assertWindowsExecutableBytes(bytes, addon);
  const expected = seal === undefined ? sealedDaemonPipeAddonSha256(arch) : sealedDaemonPipeAddonSha256(arch, seal);
  if (!expected) throw new Error(`No ${arch} build of ${DAEMON_PIPE_ADDON_NAME} is sealed in shared/letagents-daemon-pipe.seal.json.`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected) {
    throw new Error(
      `${addon} (sha256 ${sha256}) is not the sealed ${DAEMON_PIPE_ADDON_NAME} (${expected}), so the app would refuse it. `
        + "Build it with the MSVC and SDK the seal names, or reseal shared/letagents-daemon-pipe.seal.json.",
    );
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return { sha256, bytes: bytes.length };
}
