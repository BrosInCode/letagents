import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { join } from "node:path";

import { electronResourcesPath } from "../electron-resources-path.js";

type DesktopPackageMetadata = {
  letagentsRuntime?: {
    openCodeVersion?: unknown;
    openCodeMinimumMacOS?: unknown;
  };
};

const desktopPackage = createRequire(import.meta.url)(
  "../../package.json",
) as DesktopPackageMetadata;
const configuredVersion = desktopPackage.letagentsRuntime?.openCodeVersion;
if (typeof configuredVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(configuredVersion)) {
  throw new Error("apps/desktop/package.json must declare letagentsRuntime.openCodeVersion.");
}

/** Single runtime contract version shared by development, packaging, and tests. */
export const OPENCODE_RUNTIME_VERSION = configuredVersion;

const configuredMinimumMacOS = desktopPackage.letagentsRuntime?.openCodeMinimumMacOS;
if (typeof configuredMinimumMacOS !== "string" || !/^\d+\.\d+$/.test(configuredMinimumMacOS)) {
  throw new Error("apps/desktop/package.json must declare letagentsRuntime.openCodeMinimumMacOS.");
}

/**
 * The oldest macOS the pinned OpenCode binary starts on: its Mach-O minos,
 * which packaging checks against the bundled binary. The app itself declares
 * an older LSMinimumSystemVersion, so Open Model turns itself off below this.
 */
export const OPENCODE_MINIMUM_MACOS = configuredMinimumMacOS;

/**
 * The macOS version of a Darwin kernel release (`os.release()`). Darwin 20 to
 * 24 are macOS 11 to 15, and Darwin 25 is macOS 26. Only the major is known.
 */
export function macOSVersionFromDarwinRelease(darwinRelease: string): string | null {
  const major = Number(/^(\d+)\./.exec(darwinRelease)?.[1]);
  if (!Number.isSafeInteger(major) || major < 20) return null;
  return String(major >= 25 ? major + 1 : major - 9);
}

/**
 * This Mac's macOS version: exact in Electron (`process.getSystemVersion()`),
 * the major only in plain Node (the daemon). The kernel's answer wins when the
 * two majors differ, as with the "10.16" that a binary built against an old
 * SDK is told.
 */
export function currentMacOSVersion(
  darwinRelease: string = release(),
  systemVersion: string = systemVersionOfProcess(),
): string | null {
  const kernel = macOSVersionFromDarwinRelease(darwinRelease);
  if (!/^\d+(\.\d+)*$/.test(systemVersion)) return kernel;
  return !kernel || systemVersion.split(".")[0] === kernel ? systemVersion : kernel;
}

function systemVersionOfProcess(): string {
  const getSystemVersion = (process as { getSystemVersion?: () => string }).getSystemVersion;
  return typeof getSystemVersion === "function" ? getSystemVersion.call(process) : "";
}

function versionAtLeast(current: string, minimum: string): boolean {
  const have = current.split(".").map(Number);
  const need = minimum.split(".").map(Number);
  // A part that `current` does not give (Darwin gives only the major) is not held against it.
  for (let index = 0; index < Math.min(have.length, need.length); index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index];
  }
  return true;
}

/** "13" for "13.0", "13.3" for "13.3". */
function macOSLabel(version: string): string {
  return version.replace(/\.0$/, "");
}

/**
 * Null when OpenCode can run on this computer; otherwise why Open Model is
 * unavailable. Only macOS has a minimum, and an unknown version is not refused.
 */
export function openCodeUnsupportedSystem(
  platform: NodeJS.Platform = process.platform,
  macOSVersion: () => string | null = currentMacOSVersion,
  minimum: string = OPENCODE_MINIMUM_MACOS,
): { message: string; detail: string } | null {
  if (platform !== "darwin") return null;
  const current = macOSVersion();
  if (!current || versionAtLeast(current, minimum)) return null;
  return {
    message: `Open Model needs macOS ${macOSLabel(minimum)} or later.`,
    detail: `This Mac has macOS ${current}. The OpenCode engine that runs Open Model agents needs macOS ${macOSLabel(minimum)} or later. Other agents still work on this Mac.`,
  };
}

/** The packaged OpenCode binary's file name: Windows needs the `.exe`. */
export function bundledOpenCodeBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "opencode.exe" : "opencode";
}

export function resolveOpenCodeBinary(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath: string = electronResourcesPath(),
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.LETAGENTS_OPENCODE_BIN?.trim()) return env.LETAGENTS_OPENCODE_BIN.trim();
  if (resourcesPath) {
    const bundled = join(resourcesPath, "app", "runtime", bundledOpenCodeBinaryName(platform));
    if (exists(bundled)) return bundled;
  }
  return "opencode";
}

export function openCodeInstallCommand(): {
  command: string;
  args: string[];
  detail: string;
} {
  return {
    command: "npm",
    args: ["install", "--global", `opencode-ai@${OPENCODE_RUNTIME_VERSION}`],
    detail: `Installs the pinned OpenCode ${OPENCODE_RUNTIME_VERSION} execution engine. OpenCode does not require its own account; LetAgents supplies the configured model endpoint directly.`,
  };
}
