export const MESSAGE_PIN_LIMIT = 50;
export const MESSAGE_PIN_SNIPPET_LENGTH = 240;
export const MESSAGE_PIN_LIMIT_NOTICE = "This room already has 50 pinned messages. Unpin a message first.";

export function isPinMessageId(value) {
  return typeof value === "string" && /^msg_[1-9]\d*$/.test(value)
    && Number(value.slice(4)) <= 2147483647;
}

/** Match the clients' displayed-text fallback; return text, never HTML. */
export function messagePinSnippet(text, displayText) {
  const chars = Array.from((displayText || text || "").replace(/\s+/gu, " ").trim());
  return chars.length > MESSAGE_PIN_SNIPPET_LENGTH
    ? chars.slice(0, MESSAGE_PIN_SNIPPET_LENGTH - 1).join("") + "…"
    : chars.join("");
}
