import type { DesktopAgentProviderId } from "../../../../../../electron/ipc-types";
import antigravityIcon from "../../../../assets/harness-icons/antigravity.png";
import claudeCodeIcon from "../../../../assets/harness-icons/claude-code.png";
import codexIcon from "../../../../assets/harness-icons/codex.png";
import cursorIcon from "../../../../assets/harness-icons/cursor.png";
import openCodeIcon from "../../../../assets/harness-icons/opencode.svg";

// Open Model agents run on OpenCode, so they show the OpenCode mark.
const icons: Record<string, string> = {
  "claude-code": claudeCodeIcon,
  antigravity: antigravityIcon,
  cursor: cursorIcon,
  codex: codexIcon,
  "open-model": openCodeIcon,
};

/** The provider's own logo, or null when there is none and the row keeps its generic mark. */
export function providerIconSrc(providerId: DesktopAgentProviderId): string | null {
  return icons[providerId] ?? null;
}

/** A provider as a message or receipt names it: by its label, or by a desktop agent key. */
export type ProviderLabelKey = "codex" | "claude" | "antigravity" | "cursor" | "open-model" | "other";

export function providerFromLabel(value: string): ProviderLabelKey {
  // Match a compact form: labels arrive as "Claude Code" or "claude-code",
  // and OpenCode connected over MCP reports itself as "OpenCode".
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact === "codex") return "codex";
  if (compact === "claude" || compact === "claudecode") return "claude";
  if (compact === "antigravity") return "antigravity";
  if (compact === "cursor") return "cursor";
  if (compact === "openmodel" || compact === "opencode") return "open-model";
  return "other";
}

export function providerFromAgentKey(agentKey: string | null | undefined): ProviderLabelKey | null {
  const name = (agentKey?.split("/").at(-1) || "").toLowerCase();
  if (name.startsWith("desktop-codex-")) return "codex";
  if (name.startsWith("desktop-claude-code-") || name.startsWith("desktop-claude-")) return "claude";
  if (name.startsWith("desktop-antigravity-")) return "antigravity";
  if (name.startsWith("desktop-cursor-")) return "cursor";
  if (name.startsWith("desktop-open-model-") || name.startsWith("desktop-open_model-")) return "open-model";
  return null;
}

const labelIcons: Record<Exclude<ProviderLabelKey, "other">, string> = {
  codex: codexIcon,
  claude: claudeCodeIcon,
  antigravity: antigravityIcon,
  cursor: cursorIcon,
  "open-model": openCodeIcon,
};

/** The logo for a provider label, falling back to the agent key; null when neither names a known provider. */
export function providerIconForLabel(label: string | null | undefined, agentKey?: string | null): string | null {
  const fromLabel = label ? providerFromLabel(label) : "other";
  const key = fromLabel !== "other" ? fromLabel : providerFromAgentKey(agentKey) ?? "other";
  return key === "other" ? null : labelIcons[key];
}
