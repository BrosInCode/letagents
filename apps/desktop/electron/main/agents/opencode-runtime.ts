import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

type DesktopPackageMetadata = {
  letagentsRuntime?: {
    openCodeVersion?: unknown;
  };
};

const desktopPackage = createRequire(import.meta.url)(
  "../../../package.json",
) as DesktopPackageMetadata;
const configuredVersion = desktopPackage.letagentsRuntime?.openCodeVersion;
if (typeof configuredVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(configuredVersion)) {
  throw new Error("apps/desktop/package.json must declare letagentsRuntime.openCodeVersion.");
}

/** Single runtime contract version shared by development, packaging, and tests. */
export const OPENCODE_RUNTIME_VERSION = configuredVersion;

export function resolveOpenCodeBinary(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath: string = typeof process.resourcesPath === "string"
    ? process.resourcesPath
    : "",
): string {
  if (env.LETAGENTS_OPENCODE_BIN?.trim()) return env.LETAGENTS_OPENCODE_BIN.trim();
  if (resourcesPath) {
    const bundled = join(resourcesPath, "app", "runtime", "opencode");
    if (existsSync(bundled)) return bundled;
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
