import { execSync } from "child_process";

import {
  inferAgentIdeLabel,
  toTitleCaseCodename,
} from "../../../../shared/agent-identity.js";
import { normalizeAgentBaseName } from "../../../../shared/codenames.js";

export const AGENT_NAME = (
  process.env.LETAGENTS_AGENT_NAME ||
  process.env.AGENT_NAME ||
  ""
).trim();
export const AGENT_DISPLAY_NAME = (
  process.env.LETAGENTS_AGENT_DISPLAY_NAME || ""
).trim();
export const AGENT_IDE_LABEL = (
  process.env.LETAGENTS_AGENT_IDE ||
  process.env.AGENT_IDE ||
  ""
).trim();
export const AGENT_OWNER_LABEL = (
  process.env.LETAGENTS_AGENT_OWNER_LABEL || ""
).trim();
export const EXPLICIT_AGENT_IDENTITY_KEY = getExplicitAgentIdentityStorageKey();

export function readCommandOutput(command: string, cwd = process.cwd()): string | null {
  try {
    const output = execSync(command, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function isCodexRuntime(): boolean {
  return Boolean(
    process.env.CODEX_THREAD_ID ||
      process.env.CODEX_SHELL ||
      process.env.CODEX_CI ||
      process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
  );
}

function getExplicitAgentIdentityStorageKey(): string | null {
  const runtimeSignals = [
    process.env.LETAGENTS_AGENT_INSTANCE_ID,
    process.env.CODEX_THREAD_ID && `codex:${process.env.CODEX_THREAD_ID}`,
    process.env.ANTIGRAVITY_THREAD_ID && `antigravity:${process.env.ANTIGRAVITY_THREAD_ID}`,
    process.env.CLAUDECODE_SESSION_ID && `claude:${process.env.CLAUDECODE_SESSION_ID}`,
    process.env.MCP_SESSION_ID && `mcp:${process.env.MCP_SESSION_ID}`,
  ].filter((value): value is string => Boolean(value?.trim()));

  return runtimeSignals[0] ?? null;
}

export function detectAgentIdeLabel(): string {
  if (AGENT_IDE_LABEL) {
    return toTitleCaseCodename(AGENT_IDE_LABEL);
  }

  if (isCodexRuntime()) {
    return "Codex";
  }

  const explicitName = normalizeAgentBaseName(AGENT_NAME || AGENT_DISPLAY_NAME);
  const inferred = inferAgentIdeLabel(explicitName);
  return inferred || "Agent";
}

export function detectAgentRuntimeLabel(): string {
  if (isCodexRuntime()) {
    return "codex";
  }

  return detectAgentIdeLabel().trim().toLowerCase() || "unknown";
}
