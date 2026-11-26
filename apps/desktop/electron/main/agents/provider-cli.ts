import type { DesktopAgentProviderId } from "../../ipc-types.js";
import { resolveClaudeCodeExecutable } from "#provider-runtime/agents/claude-code-version.js";
import { resolveCodexExecutable } from "#provider-runtime/agents/codex-executable.js";
import {
  antigravityChildEnvironment,
  resolveAntigravityExecutable,
} from "#provider-runtime/agents/antigravity/launch.js";
import { desktopRuntimeEnvironment } from "#provider-runtime/desktop-shell-environment.js";

export interface ProviderCli {
  command: string;
  env: NodeJS.ProcessEnv;
}

/**
 * The provider program and environment that a setup check runs. Preflight
 * and in-app sign-in both use this, so a sign-in writes to the same provider
 * home that the next preflight reads (an isolated Preview home included).
 */
export function providerCli(
  providerId: DesktopAgentProviderId,
  runtimeCommand: string | null | undefined,
  base: NodeJS.ProcessEnv = desktopRuntimeEnvironment(),
): ProviderCli {
  if (providerId === "codex") return { command: resolveCodexExecutable({ env: base }), env: base };
  if (providerId === "claude-code") {
    return { command: resolveClaudeCodeExecutable(base, runtimeCommand || "claude"), env: base };
  }
  if (providerId === "antigravity") {
    const env = antigravityChildEnvironment(base);
    return { command: resolveAntigravityExecutable(env), env };
  }
  if (providerId === "cursor") {
    return { command: base.LETAGENTS_CURSOR_AGENT_BIN || runtimeCommand || "cursor-agent", env: base };
  }
  throw new Error(`${providerId} has no provider command line.`);
}
