import { redactCredentialText } from "./provider-evidence.js";
import { MAX_CURSOR_TERMINAL_ERROR_DETAIL_LENGTH } from "./cursor-provider-constants.js";

export function safeCursorTerminalErrorDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = redactCredentialText(value).value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_CURSOR_TERMINAL_ERROR_DETAIL_LENGTH);
}
