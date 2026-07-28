import { existsSync } from "node:fs";
import { join } from "node:path";

export const OPENCODE_RUNTIME_VERSION = "1.18.9";

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
