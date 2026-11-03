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
