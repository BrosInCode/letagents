/** Room expression choices, shared by desktop providers and MCP. */
export const ROOM_EXPRESSION_GUIDANCE = [
  "When the room enables GIFs and agent reactions and the tools are available, use them naturally without waiting to be asked. Use expressions regularly where they fit, while keeping text more common overall. Text remains the main way to explain ideas and do the work.",
  "For thanks, a helpful contribution, or a small win that deserves acknowledgment, prefer a fitting reaction over another courtesy sentence. You can join an existing reaction when it expresses your own response; you do not need to invent a different emoji.",
  "When a human thanks the group and pauses the discussion to read or decide, a fitting reaction is the natural acknowledgment: react, then finish without another written reply or GIF. Pausing discussion does not by itself forbid acknowledgment. For that acknowledgment, if the human explicitly requests no reactions, no acknowledgment, or complete silence, send nothing.",
  "For a distinct celebration, shared joke, or playful moment, take the opportunity to use a fitting GIF. GIFs should be less frequent than reactions. Read the recent conversation: if a GIF already expresses this moment, a reaction or words usually add more than another GIF. Do not add expressions to every reply or try to meet a quota.",
  "A reaction or GIF can accompany a useful written reply; neither replaces requested work, reasoning, disagreement, a concern, or an explanation. Match the human's tone, keep your own voice, and respect requests for quiet. Stay silent when no acknowledgment or contribution is useful.",
  "Reactions and GIFs do not establish approval, completed work, or team consensus. If an expression fails or is disabled, do not repeatedly retry: use ordinary text if an answer is needed, otherwise finish with the normal no-reply outcome. Never claim an expression was sent unless the tool confirmed it.",
].join(" ");

/** Persist only the provider and stable ID, never a media URL. */
export function normalizeRoomGif(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.provider !== "giphy") return null;
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9]{1,128}$/.test(value.id)) return null;
  return { provider: "giphy", id: value.id,
    ...(value.text_fallback_only === true ? { text_fallback_only: true } : {}),
    title: typeof value.title === "string" ? value.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "GIF" };
}

/** A scoped reply intent may be cleared; never accepts rooms, URLs or credentials. */
export function validReplyGifIntent(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => key === "gif") && Object.hasOwn(value, "gif")
    && (value.gif === null || (normalizeRoomGif(value.gif)
      && Object.keys(value.gif).every(key => ["provider", "id", "title", "text_fallback_only"].includes(key))
      && typeof value.gif.title === "string" && value.gif.title.length <= 200
      && (!Object.hasOwn(value.gif, "text_fallback_only") || value.gif.text_fallback_only === true))));
}

export function roomGifPageUrl(gif) {
  const valid = normalizeRoomGif(gif);
  return valid ? `https://giphy.com/gifs/${valid.id}` : null;
}
