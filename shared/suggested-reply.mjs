/** The longest suggested reply an agent may attach to a message. */
export const SUGGESTED_REPLY_MAX_CHARS = 500;

/**
 * What a desktop room agent passes to set_reply_suggestion: { text } with
 * 1 to 500 characters after trimming, or { text: null } to clear its choice.
 */
export function validReplySuggestionIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "text")) return false;
  if (value.text === null) return true;
  return typeof value.text === "string" && value.text.trim().length > 0 && value.text.trim().length <= SUGGESTED_REPLY_MAX_CHARS;
}

/** The suggestion an intent records, or null when it clears one or is not valid. */
export function replySuggestionText(value) {
  return validReplySuggestionIntent(value) && typeof value.text === "string" ? value.text.trim() : null;
}
